/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of Sync Evo, which is free software licensed under the
 * GNU Affero General Public License, version 3. It comes with ABSOLUTELY NO
 * WARRANTY. See the LICENSE file for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test } from "vitest";
import type { FetchedFile, RemoteEntry } from "../src/core/backend";
import { FetchLimitWatch, NO_FETCH_LIMIT, quotaNoteFor, sameFetchLimit } from "../src/core/fetch-quota";
import type { RateLimitQuota } from "../src/core/github/rate-limit";
import type { ContentSource } from "../src/core/pull-io";

const START = 1_700_000_000_000;
const RESET = START + 1_800_000;

describe("quotaNoteFor", () => {
	test("more files than requests left: what fits now, and when the rest continues", () => {
		expect(quotaNoteFor(6655, { remaining: 4990, resetAt: RESET, limit: 5000 }, START)).toEqual({
			fetchable: 4990,
			resumesAt: RESET,
		});
	});

	test("a fetch that fits is not told", () => {
		expect(quotaNoteFor(4990, { remaining: 4990, resetAt: RESET }, START)).toBeNull();
		expect(quotaNoteFor(0, { remaining: 0, resetAt: RESET }, START)).toBeNull();
	});

	test("nothing left of the quota is not told: the wait says it, with the first request refused", () => {
		expect(quotaNoteFor(6655, { remaining: 0, resetAt: RESET, limit: 5000 }, START)).toBeNull();
		expect(quotaNoteFor(1, { remaining: 0, resetAt: RESET }, START)).toBeNull();
		// The last request that is left is still told.
		expect(quotaNoteFor(2, { remaining: 1, resetAt: RESET }, START)).toEqual({ fetchable: 1, resumesAt: RESET });
	});

	test("one file too many is told", () => {
		expect(quotaNoteFor(4991, { remaining: 4990, resetAt: RESET }, START)?.fetchable).toBe(4990);
	});

	test("an unknown quota is not told", () => {
		expect(quotaNoteFor(100_000, null, START)).toBeNull();
	});

	test("a quota that has been reset since it was reported is not known", () => {
		expect(quotaNoteFor(6655, { remaining: 10, resetAt: START }, START)).toBeNull();
		expect(quotaNoteFor(6655, { remaining: 10, resetAt: START - 1 }, START)).toBeNull();
	});
});

test("sameFetchLimit compares what is shown", () => {
	const note = { fetchable: 5, resumesAt: RESET };
	expect(sameFetchLimit(NO_FETCH_LIMIT, { waitingUntil: null, quota: null })).toBe(true);
	expect(sameFetchLimit({ waitingUntil: 1, quota: note }, { waitingUntil: 1, quota: { ...note } })).toBe(true);
	expect(sameFetchLimit({ waitingUntil: 1, quota: null }, { waitingUntil: 2, quota: null })).toBe(false);
	expect(sameFetchLimit({ waitingUntil: null, quota: note }, NO_FETCH_LIMIT)).toBe(false);
	expect(sameFetchLimit({ waitingUntil: null, quota: note }, { waitingUntil: null, quota: { ...note, fetchable: 4 } })).toBe(
		false,
	);
});

describe("FetchLimitWatch", () => {
	const entries = (count: number): RemoteEntry[] =>
		Array.from({ length: count }, (_, index) => ({ path: `f${index}`, kind: "file", hash: String(index) }));

	const source: ContentSource = async function* (_revision, wanted) {
		for (const entry of wanted) yield { entry, content: new Uint8Array() };
	};

	function setup(quota: RateLimitQuota | null = null) {
		const world = { now: START, quota };
		const watch = new FetchLimitWatch(
			() => world.quota,
			() => world.now,
		);
		return { world, watch };
	}

	test("nothing to tell before anything is fetched", () => {
		const { watch } = setup({ remaining: 3, resetAt: RESET });
		expect(watch.state()).toEqual(NO_FETCH_LIMIT);
		// Wrapping a source asks for nothing yet.
		watch.watch(source);
		expect(watch.state()).toEqual(NO_FETCH_LIMIT);
	});

	test("an empty quota: no note, then the wait, then the note of the quota that came back", async () => {
		// What the runner does: `state()` when the fetch is asked for, on
		// `onRateLimit`, and with every file.
		const { world, watch } = setup({ remaining: 0, resetAt: RESET });
		const files = watch.watch(source)(null, entries(10))[Symbol.asyncIterator]();
		expect(watch.state()).toEqual(NO_FETCH_LIMIT);

		// The first request is refused, and the client asks.
		const until = RESET + 1000;
		watch.rateLimited(until);
		expect(watch.state()).toEqual({ waitingUntil: until, quota: null });
		world.now = until - 1;
		expect(watch.state()).toEqual({ waitingUntil: until, quota: null });

		// The wait is over, and no response has reported the new quota yet.
		world.now = until;
		expect(watch.state()).toEqual(NO_FETCH_LIMIT);

		// The first file is in, and its response says what the hour holds.
		await files.next();
		world.quota = { remaining: 4, resetAt: RESET + 3_600_000 };
		expect(watch.state()).toEqual({ waitingUntil: null, quota: { fetchable: 4, resumesAt: RESET + 3_600_000 } });
	});

	test("a fetch of more files than the quota has left is told as soon as it is asked for", () => {
		const { watch } = setup({ remaining: 3, resetAt: RESET });
		// Asked for, and not one file taken yet.
		watch.watch(source)(null, entries(5));
		expect(watch.state()).toEqual({ waitingUntil: null, quota: { fetchable: 3, resumesAt: RESET } });
	});

	test("a fetch that fits, or a quota that is not known, is not told", () => {
		const fits = setup({ remaining: 5, resetAt: RESET });
		fits.watch.watch(source)(null, entries(5));
		expect(fits.watch.state()).toEqual(NO_FETCH_LIMIT);

		const unknown = setup(null);
		unknown.watch.watch(source)(null, entries(5));
		expect(unknown.watch.state()).toEqual(NO_FETCH_LIMIT);
	});

	test("the files pass through as the source yields them", async () => {
		const { watch } = setup();
		const wanted = entries(3);
		const got: FetchedFile[] = [];
		for await (const file of watch.watch(source)("rev", wanted)) got.push(file);
		expect(got.map((file) => file.entry)).toEqual(wanted);
	});

	test("the note stands as it is while files are fetched, until the reset it names", async () => {
		const { world, watch } = setup({ remaining: 3, resetAt: RESET });
		const files = watch.watch(source)(null, entries(5))[Symbol.asyncIterator]();
		const note = watch.state().quota;
		await files.next();
		world.quota = { remaining: 2, resetAt: RESET };
		expect(watch.state().quota).toBe(note);

		// Past the reset, and no response has said what the new quota holds.
		world.now = RESET;
		expect(watch.state().quota).toBeNull();
	});

	test("after the reset it is worked out again from the files that are left", async () => {
		const { world, watch } = setup({ remaining: 3, resetAt: RESET });
		const files = watch.watch(source)(null, entries(10))[Symbol.asyncIterator]();
		for (let i = 0; i < 3; i++) await files.next();
		world.now = RESET + 1;
		world.quota = { remaining: 4, resetAt: RESET + 3_600_000 };
		// Seven are left, and four fit.
		expect(watch.state().quota).toEqual({ fetchable: 4, resumesAt: RESET + 3_600_000 });

		for (let i = 0; i < 3; i++) await files.next();
		world.now = RESET + 3_600_000;
		world.quota = { remaining: 4, resetAt: RESET + 7_200_000 };
		// Four are left, and they fit.
		expect(watch.state().quota).toBeNull();
	});

	test("a quota that turns out too small on the way is told then", async () => {
		const { world, watch } = setup({ remaining: 10, resetAt: RESET });
		const files = watch.watch(source)(null, entries(5))[Symbol.asyncIterator]();
		await files.next();
		expect(watch.state().quota).toBeNull();
		// Something else used the token.
		world.quota = { remaining: 1, resetAt: RESET };
		expect(watch.state().quota).toEqual({ fetchable: 1, resumesAt: RESET });
	});

	test("a wait is told until its time has come, in place of the note", () => {
		const { world, watch } = setup({ remaining: 3, resetAt: RESET });
		watch.watch(source)(null, entries(5));
		watch.rateLimited(RESET + 1000);
		expect(watch.state()).toEqual({ waitingUntil: RESET + 1000, quota: null });

		world.now = RESET + 999;
		expect(watch.state().waitingUntil).toBe(RESET + 1000);
		world.now = RESET + 1000;
		expect(watch.state()).toEqual(NO_FETCH_LIMIT);
	});

	test("of the limits hit together, the one that ends last is the wait", () => {
		const { watch } = setup();
		watch.rateLimited(START + 5000);
		watch.rateLimited(START + 4000);
		expect(watch.state().waitingUntil).toBe(START + 5000);
		watch.rateLimited(START + 6000);
		expect(watch.state().waitingUntil).toBe(START + 6000);
	});

	test("a consumer that stops early stops the source", async () => {
		const { watch } = setup();
		let closed = false;
		const closing: ContentSource = async function* (_revision, wanted) {
			try {
				for (const entry of wanted) yield { entry, content: new Uint8Array() };
			} finally {
				closed = true;
			}
		};
		const files = watch.watch(closing)(null, entries(3))[Symbol.asyncIterator]();
		await files.next();
		await files.return?.();
		expect(closed).toBe(true);
	});

	test("the next file is only asked of the source when the one before was taken", async () => {
		const { watch } = setup();
		let yielded = 0;
		const counting: ContentSource = async function* (_revision, wanted) {
			for (const entry of wanted) {
				yielded += 1;
				yield { entry, content: new Uint8Array() };
			}
		};
		const files = watch.watch(counting)(null, entries(3))[Symbol.asyncIterator]();
		await files.next();
		expect(yielded).toBe(1);
	});
});
