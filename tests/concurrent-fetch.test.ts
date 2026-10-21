/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BackendError, type FetchedFile, type RemoteEntry } from "../src/core/backend";
import {
	type ConcurrentFetchOptions,
	fetchConcurrently,
	MAX_CONCURRENT_FETCH_BYTES,
	MAX_CONCURRENT_FETCHES,
} from "../src/core/concurrent-fetch";

const MB = 1024 * 1024;

function entry(path: string, size?: number): RemoteEntry {
	return { path, kind: "file", hash: path, ...(size === undefined ? {} : { size }) };
}

function entries(count: number, size?: number): RemoteEntry[] {
	return Array.from({ length: count }, (_, index) => entry(`f${index}`, size));
}

/** Lets what is queued run: the answers of the requests, and the generator up to its next wait. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Requests that stay open until the test answers them. */
class Requests {
	/** The paths asked for, in order. */
	readonly started: string[] = [];
	private readonly open = new Map<string, { resolve(content: Uint8Array): void; reject(error: unknown): void }>();

	readonly fetchOne = (wanted: RemoteEntry): Promise<Uint8Array> => {
		this.started.push(wanted.path);
		return new Promise((resolve, reject) => {
			this.open.set(wanted.path, { resolve, reject });
		});
	};

	/** The paths asked for and not answered yet. */
	get pending(): string[] {
		return [...this.open.keys()];
	}

	async answer(...paths: string[]): Promise<void> {
		for (const path of paths) {
			this.take(path).resolve(new TextEncoder().encode(path));
		}
		await settle();
	}

	async fail(path: string, error: unknown): Promise<void> {
		this.take(path).reject(error);
		await settle();
	}

	private take(path: string) {
		const request = this.open.get(path);
		if (request === undefined) throw new Error(`not open: ${path}`);
		this.open.delete(path);
		return request;
	}
}

function run(list: readonly RemoteEntry[], options?: ConcurrentFetchOptions) {
	const requests = new Requests();
	const iterator = fetchConcurrently(list, requests.fetchOne, options);
	return { requests, iterator };
}

/** Asks for the next item without waiting for it. */
function ask(iterator: AsyncGenerator<FetchedFile, void, void>) {
	const asked = { path: undefined as string | undefined, done: false, error: undefined as unknown, settled: false };
	iterator.next().then(
		(result) => {
			asked.settled = true;
			if (result.done === true) asked.done = true;
			else asked.path = result.value.entry.path;
		},
		(error: unknown) => {
			asked.settled = true;
			asked.error = error;
		},
	);
	return asked;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

beforeEach(() => {
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
	// An unhandled rejection is reported after the microtasks have run.
	await new Promise((resolve) => setTimeout(resolve, 0));
	process.off("unhandledRejection", onUnhandled);
	expect(unhandled).toEqual([]);
});

test("the limits are the ones that were decided", () => {
	expect(MAX_CONCURRENT_FETCHES).toBe(16);
	expect(MAX_CONCURRENT_FETCH_BYTES).toBe(64 * MB);
});

describe("how many at once", () => {
	test("nothing is asked for before the consumer asks", async () => {
		const { requests } = run(entries(3));
		await settle();
		expect(requests.started).toEqual([]);
	});

	test("16 at once by default, started in the order given", async () => {
		const list = entries(40, 10);
		const { requests, iterator } = run(list);
		ask(iterator);
		await settle();
		expect(requests.started).toEqual(list.slice(0, 16).map((item) => item.path));
	});

	test("one more starts for each one the consumer has taken", async () => {
		const { requests, iterator } = run(entries(10), { maxCount: 3 });
		const first = ask(iterator);
		await settle();
		expect(requests.started).toEqual(["f0", "f1", "f2"]);

		await requests.answer("f1");
		expect(first.path).toBe("f1");
		// Fetched, and not taken yet: it still counts.
		expect(requests.started).toHaveLength(3);

		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["f0", "f1", "f2", "f3"]);
	});

	test("the content is yielded as it arrives, whatever the order", async () => {
		const { requests, iterator } = run(entries(3));
		const got: string[] = [];
		const all = (async () => {
			for await (const file of iterator) got.push(`${file.entry.path}=${new TextDecoder().decode(file.content)}`);
		})();
		await settle();
		await requests.answer("f2");
		await requests.answer("f0");
		await requests.answer("f1");
		await all;
		expect(got).toEqual(["f2=f2", "f0=f0", "f1=f1"]);
	});

	test("no entries, no requests", async () => {
		const { requests, iterator } = run([]);
		expect((await iterator.next()).done).toBe(true);
		expect(requests.started).toEqual([]);
	});
});

describe("how much at once", () => {
	test("an entry that would take the total past the limit waits", async () => {
		const list = [entry("a", 30 * MB), entry("b", 30 * MB), entry("c", 5 * MB), entry("d", 1)];
		const { requests, iterator } = run(list);
		const first = ask(iterator);
		await settle();
		// 60 MB are on their way. The third would make 65.
		expect(requests.started).toEqual(["a", "b"]);

		await requests.answer("a");
		expect(first.path).toBe("a");
		expect(requests.started).toEqual(["a", "b"]);

		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a", "b", "c", "d"]);
	});

	test("a total of exactly the limit is allowed", async () => {
		const { requests, iterator } = run([entry("a", 32 * MB), entry("b", 32 * MB), entry("c", 1)]);
		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a", "b"]);
	});

	test("a small entry does not overtake a large one that waits", async () => {
		const { requests, iterator } = run([entry("a", 40 * MB), entry("b", 40 * MB), entry("c", 1)]);
		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a"]);
	});

	test("an entry larger than the limit is fetched alone", async () => {
		const list = [entry("a", 1), entry("huge", 65 * MB), entry("b", 1), entry("c", 1)];
		const { requests, iterator } = run(list);
		const first = ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a"]);

		await requests.answer("a");
		expect(first.path).toBe("a");
		const second = ask(iterator);
		await settle();
		// Only now that nothing else is held, and nothing beside it.
		expect(requests.started).toEqual(["a", "huge"]);

		await requests.answer("huge");
		expect(second.path).toBe("huge");
		expect(requests.started).toEqual(["a", "huge"]);

		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a", "huge", "b", "c"]);
	});

	test("an entry without a size counts as empty", async () => {
		const { requests, iterator } = run([entry("a", 64 * MB), entry("b"), entry("c", 1)]);
		ask(iterator);
		await settle();
		expect(requests.started).toEqual(["a", "b"]);
	});
});

describe("a consumer that does not keep up", () => {
	test("what is fetched and not taken holds back the rest", async () => {
		const { requests, iterator } = run(entries(10), { maxCount: 2 });
		const first = ask(iterator);
		await settle();
		await requests.answer("f0", "f1");
		expect(first.path).toBe("f0");
		// Both are in memory: one with the consumer, one waiting for it.
		await settle();
		expect(requests.started).toEqual(["f0", "f1"]);

		const second = ask(iterator);
		await settle();
		expect(second.path).toBe("f1");
		// The consumer is done with the first, and only with the first.
		expect(requests.started).toEqual(["f0", "f1", "f2"]);
	});

	test("the sizes of what is not taken count too", async () => {
		const { requests, iterator } = run([entry("a", 40 * MB), entry("b", 20 * MB), entry("c", 20 * MB)]);
		const first = ask(iterator);
		await settle();
		await requests.answer("a", "b");
		expect(first.settled).toBe(true);
		expect(requests.started).toEqual(["a", "b"]);
	});
});

describe("a failure", () => {
	test("is thrown after what had already been fetched, and nothing more is started", async () => {
		const { requests, iterator } = run(entries(10), { maxCount: 3 });
		const first = ask(iterator);
		await settle();
		await requests.answer("f0", "f2");
		expect(first.path).toBe("f0");
		const failure = new BackendError("unreachable", "timeout");
		await requests.fail("f1", failure);

		expect((await iterator.next()).value?.entry.path).toBe("f2");
		const end = ask(iterator);
		await settle();
		expect(end.error).toBe(failure);
		expect(requests.started).toEqual(["f0", "f1", "f2"]);
		expect((await iterator.next()).done).toBe(true);
	});

	test("is thrown without waiting for the requests on their way, whose failures are dropped", async () => {
		const { requests, iterator } = run(entries(4));
		const first = ask(iterator);
		await settle();
		const failure = new Error("first");
		await requests.fail("f2", failure);
		expect(first.error).toBe(failure);
		expect(requests.pending).toEqual(["f0", "f1", "f3"]);

		await requests.fail("f0", new Error("second"));
		await requests.answer("f1");
		await requests.fail("f3", new Error("third"));
	});

	test("only the first failure is thrown", async () => {
		const { requests, iterator } = run(entries(2));
		const first = ask(iterator);
		await settle();
		const failure = new Error("first");
		requests.fail("f1", failure);
		await requests.fail("f0", new Error("second"));
		expect(first.error).toBe(failure);
	});

	test("a fetch that throws instead of rejecting is a failure like any other", async () => {
		const failure = new Error("thrown");
		const iterator = fetchConcurrently(entries(2), () => {
			throw failure;
		});
		await expect(iterator.next()).rejects.toBe(failure);
	});
});

describe("a consumer that stops early", () => {
	test("nothing more is started, and what arrives late is dropped", async () => {
		const { requests, iterator } = run(entries(10), { maxCount: 2 });
		const first = ask(iterator);
		await settle();
		await requests.answer("f0");
		expect(first.path).toBe("f0");

		expect((await iterator.return()).done).toBe(true);
		await requests.answer("f1");
		expect(requests.started).toEqual(["f0", "f1"]);
		expect((await iterator.next()).done).toBe(true);
	});

	test("a request that fails afterwards is not an unhandled rejection", async () => {
		const { requests, iterator } = run(entries(3));
		const first = ask(iterator);
		await settle();
		await requests.answer("f0");
		expect(first.path).toBe("f0");
		await iterator.return();
		await requests.fail("f1", new Error("late"));
	});

	test("breaking out of a loop stops it the same way", async () => {
		const requests = new Requests();
		const list = entries(10);
		const all = (async () => {
			for await (const file of fetchConcurrently(list, requests.fetchOne, { maxCount: 2 })) {
				if (file.entry.path === "f0") break;
			}
		})();
		await settle();
		await requests.answer("f0");
		await all;
		expect(requests.started).toEqual(["f0", "f1"]);
	});
});

describe("the signal", () => {
	async function kindOf(asked: { error: unknown }): Promise<string> {
		await settle();
		return asked.error instanceof BackendError ? asked.error.kind : `not a BackendError: ${String(asked.error)}`;
	}

	test("a fetch that is cancelled before it starts asks for nothing", async () => {
		const stop = new AbortController();
		stop.abort();
		const { requests, iterator } = run(entries(3), { signal: stop.signal });
		expect(await kindOf(ask(iterator))).toBe("cancelled");
		expect(requests.started).toEqual([]);
	});

	test("a fetch of nothing that is cancelled before it starts is cancelled too", async () => {
		const stop = new AbortController();
		stop.abort();
		const { requests, iterator } = run([], { signal: stop.signal });
		expect(await kindOf(ask(iterator))).toBe("cancelled");
		expect(requests.started).toEqual([]);
	});

	test("a fetch of nothing that is not cancelled just ends", async () => {
		const { iterator } = run([], { signal: new AbortController().signal });
		expect((await iterator.next()).done).toBe(true);
	});

	test("a request that fails after the cancellation is dropped, and the cancellation stands", async () => {
		const stop = new AbortController();
		const { requests, iterator } = run(entries(10), { maxCount: 2, signal: stop.signal });
		const first = ask(iterator);
		await settle();
		stop.abort();
		expect(await kindOf(first)).toBe("cancelled");
		// The consumer is gone. `afterEach` fails on a rejection left unhandled.
		await requests.fail("f0", new BackendError("unreachable", "offline"));
		await requests.fail("f1", new Error("late"));
		expect(requests.started).toEqual(["f0", "f1"]);
		expect((await iterator.next()).done).toBe(true);
	});

	test("cancelling ends the fetch without waiting for the requests on their way", async () => {
		const stop = new AbortController();
		const { requests, iterator } = run(entries(10), { maxCount: 2, signal: stop.signal });
		const first = ask(iterator);
		await settle();
		expect(first.settled).toBe(false);
		stop.abort();
		expect(await kindOf(first)).toBe("cancelled");
		expect(requests.started).toEqual(["f0", "f1"]);
		await requests.answer("f0", "f1");
		expect(requests.started).toEqual(["f0", "f1"]);
	});

	test("cancelling while the consumer works starts nothing more", async () => {
		const stop = new AbortController();
		const { requests, iterator } = run(entries(10), { maxCount: 2, signal: stop.signal });
		const first = ask(iterator);
		await settle();
		await requests.answer("f0");
		expect(first.path).toBe("f0");
		stop.abort();
		expect(await kindOf(ask(iterator))).toBe("cancelled");
		expect(requests.started).toEqual(["f0", "f1"]);
	});

	test("the listener is taken off the signal when the fetch ends", async () => {
		const stop = new AbortController();
		let listeners = 0;
		const add = stop.signal.addEventListener.bind(stop.signal);
		const remove = stop.signal.removeEventListener.bind(stop.signal);
		stop.signal.addEventListener = ((...args: Parameters<typeof add>) => {
			listeners += 1;
			add(...args);
		}) as typeof add;
		stop.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
			listeners -= 1;
			remove(...args);
		}) as typeof remove;

		const { requests, iterator } = run(entries(1), { signal: stop.signal });
		const first = ask(iterator);
		await settle();
		expect(listeners).toBe(1);
		await requests.answer("f0");
		expect(first.path).toBe("f0");
		expect((await iterator.next()).done).toBe(true);
		expect(listeners).toBe(0);
	});
});
