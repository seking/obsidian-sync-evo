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

import { describe, expect, test } from "vitest";
import type { PushFile, RemoteEntry, SentBlobs } from "../src/core/backend";
import { GitHubBackend, INLINE_FILE_BYTES, TREE_CHUNK_BYTES } from "../src/core/github/backend";
import { GitHubClient } from "../src/core/github/client";
import { timerSleepOn } from "../src/core/github/timer-sleep";
import { runPull } from "../src/core/pull";
import { type PushDeps, type PushProgress, type PushRunResult, runPush } from "../src/core/push";
import { SAVE_EVERY_BLOBS, SAVE_EVERY_MS, SENT_BLOB_MS, SENT_BLOBS_KEY, SentBlobMemory } from "../src/core/sent-blobs";
import { FakeGitHub, respond, type SentRequest } from "./support/fake-github";
import { blobHash, bytes, type FileContent } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

// The blobs a push has sent, remembered for the push that goes on from
// where one stopped: the memory itself, the push of the GitHub backend that
// goes by it, and a push of a vault from end to end.

const DAY = 24 * 60 * 60 * 1000;

/** A content that goes as a blob of its own: not text. */
const binary = (...tail: number[]): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...tail]);

const stored = (store: MemoryStateStore): Promise<unknown> => store.getMeta(SENT_BLOBS_KEY);

describe("the memory of the blobs that were sent", () => {
	function memory(at = 1_000_000) {
		const clock = { now: at };
		const store = new MemoryStateStore();
		const logged: string[] = [];
		const open = (): SentBlobMemory => new SentBlobMemory(store, () => clock.now, (line) => logged.push(line));
		return { clock, store, logged, open };
	}

	test("what one memory saved is what the next one reads", async () => {
		const { store, open } = memory();
		const first = open();
		await first.load();
		first.add("a");
		first.add("b");
		expect(await stored(store)).toBeUndefined();
		await first.save();
		expect(await stored(store)).toEqual({ a: 1_000_000, b: 1_000_000 });

		const second = open();
		expect(second.has("a")).toBe(false);
		await second.load();
		expect([second.has("a"), second.has("b"), second.has("c")]).toEqual([true, true, false]);
	});

	test("nothing is added, and nothing saved, before the store was read", async () => {
		const { store, open } = memory();
		await store.setMeta(SENT_BLOBS_KEY, { kept: 1_000_000 });
		const early = open();
		early.add("a");
		await early.save();
		expect(early.has("a")).toBe(false);
		expect(await stored(store)).toEqual({ kept: 1_000_000 });
	});

	test("it saves by itself after a number of blobs, and after a while", async () => {
		const { clock, store, open } = memory();
		const blobs = open();
		await blobs.load();
		// Looked at without `save`, which would write: the store as it is.
		const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
		for (let i = 0; i < SAVE_EVERY_BLOBS - 1; i++) blobs.add(`n${i}`);
		await settle();
		expect(await stored(store)).toBeUndefined();
		blobs.add("last");
		await settle();
		expect(Object.keys((await stored(store)) as object).length).toBe(SAVE_EVERY_BLOBS);

		clock.now += SAVE_EVERY_MS - 1;
		blobs.add("soon");
		await settle();
		expect(Object.keys((await stored(store)) as object)).not.toContain("soon");
		clock.now += 1;
		blobs.add("late");
		await settle();
		expect(Object.keys((await stored(store)) as object)).toEqual(expect.arrayContaining(["soon", "late"]));
	});

	test("a blob sent more than seven days ago is not counted on, nor one from a clock that was set back", async () => {
		const { clock, store, open } = memory(100 * DAY);
		await store.setMeta(SENT_BLOBS_KEY, {
			fresh: clock.now - SENT_BLOB_MS,
			old: clock.now - SENT_BLOB_MS - 1,
			ahead: clock.now + DAY,
			farAhead: clock.now + DAY + 1,
			broken: "yesterday",
		});
		const blobs = open();
		await blobs.load();
		expect(["fresh", "old", "ahead", "farAhead", "broken"].filter((hash) => blobs.has(hash))).toEqual(["fresh", "ahead"]);
	});

	test.each([[null], ["text"], [[["a", 1]]], [7]])("a stored value that is no such memory reads as none: %j", async (value) => {
		const { store, open } = memory();
		await store.setMeta(SENT_BLOBS_KEY, value);
		const blobs = open();
		await blobs.load();
		blobs.add("a");
		await blobs.save();
		expect(await stored(store)).toEqual({ a: 1_000_000 });
	});

	test("forgotten, none is counted on, and the next save says so in the store", async () => {
		const { store, open } = memory();
		const blobs = open();
		await blobs.load();
		blobs.add("a");
		await blobs.save();
		blobs.forget();
		expect(blobs.has("a")).toBe(false);
		blobs.add("b");
		await blobs.save();
		expect(await stored(store)).toEqual({ b: 1_000_000 });
	});

	test("once the push is settled, a later save writes nothing back", async () => {
		const { store, open } = memory();
		const blobs = open();
		await blobs.load();
		blobs.add("a");
		await blobs.save();
		await store.deleteMeta(SENT_BLOBS_KEY);
		blobs.settled();
		await blobs.save();
		expect(blobs.has("a")).toBe(false);
		expect(await stored(store)).toBeUndefined();
	});

	test("a save that fails is logged and no failure, and the next one writes all of it", async () => {
		const { store, logged, open } = memory();
		const blobs = open();
		await blobs.load();
		blobs.add("a");
		const setMeta = store.setMeta.bind(store);
		store.setMeta = async () => {
			throw new Error("disk full");
		};
		await expect(blobs.save()).resolves.toBeUndefined();
		expect(logged).toEqual(["push: the sent blobs could not be remembered: disk full"]);
		store.setMeta = setMeta;
		blobs.add("b");
		await blobs.save();
		expect(await stored(store)).toEqual({ a: 1_000_000, b: 1_000_000 });
	});
});

const timerSleep = timerSleepOn({ setTimeout, clearTimeout });

function setup() {
	const github = new FakeGitHub();
	const client = new GitHubClient({
		owner: "octo",
		repo: "notes",
		branch: "main",
		token: "github_pat_SECRET",
		http: github.http,
		now: Date.now,
		sleep: timerSleep,
	});
	return { github, backend: new GitHubBackend(client, {}) };
}

function file(path: string, content: FileContent): PushFile {
	const data = bytes(content);
	return { path, hash: blobHash(data), size: data.length, read: async () => data };
}

async function entriesOf(backend: GitHubBackend): Promise<Map<string, RemoteEntry>> {
	const listing = await backend.list(null);
	if (!listing.changed) throw new Error("expected a listing");
	return new Map(listing.listing.entries.map((entry) => [entry.path, entry]));
}

function listed(entries: Map<string, RemoteEntry>, path: string): RemoteEntry {
	const entry = entries.get(path);
	if (entry === undefined) throw new Error(`not listed: ${path}`);
	return entry;
}

/** A memory that only lives as long as the test, and tells what was asked of it. */
function remembering(...hashes: string[]) {
	const blobs = new Set(hashes);
	const calls: string[] = [];
	const memory: SentBlobs = {
		has: (hash) => blobs.has(hash),
		add: (hash) => {
			blobs.add(hash);
			calls.push(`add ${hash}`);
		},
		forget: () => {
			blobs.clear();
			calls.push("forget");
		},
		save: async () => {
			calls.push("save");
		},
	};
	return { memory, blobs, calls };
}

const count = (github: FakeGitHub, line: string): number => github.writes().filter((sent) => sent === line).length;

const isTree = (request: SentRequest): boolean => request.method === "POST" && request.path === "/git/trees";

describe("a push to GitHub that goes by the blobs sent before", () => {
	test("a push that fails after its blobs leaves them remembered, and the next sends none of them again", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const { memory, blobs, calls } = remembering();
		const writes = [file("one.png", binary(1)), file("two.png", binary(2)), file("b.md", "B")];

		github.before = (request) =>
			request.method === "POST" && request.path === "/git/commits" ? respond(422, { message: "no commit today" }) : undefined;
		await expect(backend.push({ baseRevision: base, writes, deletes: [], sentBlobs: memory })).rejects.toThrow("no commit today");
		expect(count(github, "POST /git/blobs")).toBe(2);
		expect([...blobs].sort()).toEqual([blobHash(binary(1)), blobHash(binary(2))].sort());
		// Saved once every blob was sent, before the tree and the commit.
		expect(calls[calls.length - 1]).toBe("save");

		github.before = undefined;
		github.requests.length = 0;
		const result = await backend.push({ baseRevision: base, writes, deletes: [], sentBlobs: memory });

		expect(result.status).toBe("pushed");
		expect(count(github, "POST /git/blobs")).toBe(0);
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md", "one.png", "two.png"]);
		expect(github.files().get("one.png")?.sha).toBe(blobHash(binary(1)));
	});

	test("without a memory, every blob is sent as before", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.blobs.set(blobHash(binary(1)), binary(1));

		const result = await backend.push({ baseRevision: base, writes: [file("one.png", binary(1))], deletes: [] });

		expect(result.status).toBe("pushed");
		expect(count(github, "POST /git/blobs")).toBe(1);
	});

	test("a remembered blob the repository no longer holds: all are forgotten, the files of the tree are sent again, and the push goes through", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		// Remembered, and never made in this repository.
		const { memory, blobs, calls } = remembering(blobHash(binary(1)), blobHash(binary(2)), "of another push");
		const reads: string[] = [];
		const counted = (path: string, content: Uint8Array): PushFile => ({
			...file(path, content),
			read: async () => {
				reads.push(path);
				return content;
			},
		});

		const result = await backend.push({
			baseRevision: base,
			// Two files of one content: one blob.
			writes: [counted("one.png", binary(1)), counted("copy.png", binary(1)), counted("two.png", binary(2)), file("b.md", "B")],
			deletes: [],
			sentBlobs: memory,
		});

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect(count(github, "POST /git/trees")).toBe(2);
		expect(count(github, "POST /git/blobs")).toBe(2);
		expect(reads).toEqual(["one.png", "copy.png", "two.png", "one.png", "copy.png", "two.png"]);
		expect(calls.filter((call) => call === "forget").length).toBe(1);
		// What was sent now is remembered; what was only remembered is not.
		expect([...blobs].sort()).toEqual([blobHash(binary(1)), blobHash(binary(2))].sort());
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md", "copy.png", "one.png", "two.png"]);
		expect(result.written.map((entry) => entry.path).sort()).toEqual(["b.md", "copy.png", "one.png", "two.png"]);
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: unnamed device (4 added)");
	});

	test("a file that changed, or is gone, by the time it is read again", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A", "same.png": binary(9) });
		const entries = await entriesOf(backend);
		const { memory } = remembering(blobHash(binary(1)), blobHash(binary(2)), blobHash(binary(3)));
		/** `first` when read the first time, `then` after. */
		const turning = (path: string, first: Uint8Array, then: Uint8Array | null): PushFile => {
			let read = 0;
			return { ...file(path, first), read: async () => (read++ === 0 ? first : then) };
		};

		const result = await backend.push({
			baseRevision: base,
			writes: [
				turning("edited.png", binary(1), binary(7)),
				turning("gone.png", binary(2), null),
				// Back to what the remote holds.
				{ ...turning("same.png", binary(3), binary(9)), replaces: listed(entries, "same.png") },
				file("b.md", "B"),
			],
			deletes: [],
			sentBlobs: memory,
		});

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md", "edited.png", "same.png"]);
		expect(github.files().get("edited.png")?.sha).toBe(blobHash(binary(7)));
		expect(github.files().get("same.png")?.sha).toBe(blobHash(binary(9)));
		const written = new Map(result.written.map((entry) => [entry.path, entry.hash]));
		expect([...written.keys()].sort()).toEqual(["b.md", "edited.png", "same.png"]);
		expect(written.get("edited.png")).toBe(blobHash(binary(7)));
		expect(written.get("same.png")).toBe(blobHash(binary(9)));
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: unnamed device (2 added)");
	});

	test("the files are sent again once: a tree that is refused a second time fails the push", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const { memory } = remembering(blobHash(binary(1)));
		github.before = (request) => (isTree(request) ? respond(422, { message: "tree.sha deadbeef is not a valid blob" }) : undefined);

		await expect(
			backend.push({ baseRevision: base, writes: [file("one.png", binary(1))], deletes: [], sentBlobs: memory }),
		).rejects.toThrow("not a valid blob");
		expect(count(github, "POST /git/trees")).toBe(2);
		expect(count(github, "POST /git/blobs")).toBe(1);
		expect(github.head).toBe(base);
	});

	test.each([["Sorry, your request timed out."], ["Sorry, your input was too large to process."]])(
		"a refusal known to be of something else sends no blob again: %s",
		async (message) => {
			const { github, backend } = setup();
			const base = github.commit({ "a.md": "A" });
			github.blobs.set(blobHash(binary(1)), binary(1));
			const { memory, calls } = remembering(blobHash(binary(1)));
			github.before = (request) => (isTree(request) ? respond(422, { message }) : undefined);

			await expect(
				backend.push({ baseRevision: base, writes: [file("one.png", binary(1))], deletes: [], sentBlobs: memory }),
			).rejects.toThrow();
			expect(count(github, "POST /git/trees")).toBe(1);
			expect(count(github, "POST /git/blobs")).toBe(0);
			expect(calls).not.toContain("forget");
		},
	);

	test("a tree refused with no remembered blob in it fails the push as before", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const { memory, calls } = remembering("of another push");
		github.before = (request) => (isTree(request) ? respond(422, { message: "Invalid tree info" }) : undefined);

		await expect(
			backend.push({ baseRevision: base, writes: [file("one.png", binary(1))], deletes: [], sentBlobs: memory }),
		).rejects.toThrow("Invalid tree info");
		expect(count(github, "POST /git/trees")).toBe(1);
		expect(calls).not.toContain("forget");
	});

	test("workflow files the token may not write and a blob that is gone, in one tree: each is met once", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const { memory } = remembering(blobHash(binary(1)));
		github.before = (request) => {
			if (!isTree(request)) return undefined;
			const tree = (request.body as { tree: { path: string; sha?: string | null }[] }).tree;
			return tree.some((entry) => entry.path.startsWith(".github/workflows/") && entry.sha !== null)
				? respond(403, { message: "Resource not accessible by personal access token" })
				: undefined;
		};
		const refused: string[] = [];

		const result = await backend.push({
			baseRevision: base,
			writes: [
				{ ...file(".github/workflows/ci.yml", "on: push\n"), refused: (reason) => void refused.push(reason) },
				file("one.png", binary(1)),
				file("b.md", "B"),
			],
			deletes: [],
			sentBlobs: memory,
		});

		expect(result.status).toBe("pushed");
		expect(refused).toEqual(["workflows"]);
		// With the workflow file, without it, and with the blob sent again.
		expect(count(github, "POST /git/trees")).toBe(3);
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md", "one.png"]);
	});

	test("the blobs of a tree that was taken are not in doubt when a later tree is refused", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		// The first is in the repository, the second is not.
		github.blobs.set(blobHash(binary(1)), binary(1));
		const { memory } = remembering(blobHash(binary(1)), blobHash(binary(2)));
		const reads: string[] = [];
		const counted = (path: string, content: FileContent): PushFile => ({
			...file(path, content),
			read: async () => {
				reads.push(path);
				return bytes(content);
			},
		});
		// Three of these do not fit in one tree, so the first blob is in a tree of its own with two of them.
		const big = (letter: string): string => letter.repeat(INLINE_FILE_BYTES);

		const result = await backend.push({
			baseRevision: base,
			writes: [counted("early.png", binary(1)), file("1.md", big("x")), file("2.md", big("y")), file("3.md", big("z")), counted("late.png", binary(2))],
			deletes: [],
			sentBlobs: memory,
		});

		expect(result.status).toBe("pushed");
		// The first tree, the second refused, and the second again.
		expect(count(github, "POST /git/trees")).toBe(3);
		expect(count(github, "POST /git/blobs")).toBe(1);
		expect(reads).toEqual(["early.png", "late.png", "late.png"]);
		expect([...github.files().keys()].sort()).toEqual(["1.md", "2.md", "3.md", "a.md", "early.png", "late.png"]);
	});

	test("the file that fills a tree is itself in doubt when that tree is refused", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		// Long paths, so that a few hundred entries fill a tree; every blob
		// is remembered, and the repository holds none of them.
		const count_ = Math.ceil(TREE_CHUNK_BYTES / (3000 * 3)) + 5;
		const contents = Array.from({ length: count_ }, (_, i) => binary(i >> 8, i & 0xff));
		const { memory } = remembering(...contents.map((content) => blobHash(content)));
		const writes = contents.map((content, i) => file(`${"p".repeat(3000)}${i}.png`, content));

		const result = await backend.push({ baseRevision: base, writes, deletes: [], sentBlobs: memory });

		expect(result.status).toBe("pushed");
		expect(github.files().size).toBe(count_ + 1);
		expect(count(github, "POST /git/blobs")).toBe(count_);
		for (const [i, content] of contents.entries()) {
			expect(github.files().get(`${"p".repeat(3000)}${i}.png`)?.sha).toBe(blobHash(content));
		}
	});
});

describe("a push of a vault that goes on from where one stopped", () => {
	async function synced(files: Parameters<FakeGitHub["commit"]>[0]) {
		const { github, backend } = setup();
		const base = github.commit(files);
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const now = (): number => time;
		const store = new MemoryStateStore();
		const vault = new MemoryPullVault({ caseSensitive: true, now });
		const common = {
			store,
			backend,
			vault,
			paths: { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" },
			deviceName: "iPhone",
			now,
		};
		const pull = (): ReturnType<typeof runPull> => {
			time += 60_000;
			return runPull({ ...common, pluginId: "sync-evo", confirm: async () => "proceed" });
		};
		// Each push is a sync of its own, with a memory of its own.
		const push = (overrides: Partial<PushDeps> = {}): Promise<PushRunResult> => {
			time += 60_000;
			return runPush({
				...common,
				addSection: false,
				confirm: async () => "proceed",
				askEmptyVault: async () => "delete",
				sentBlobs: new SentBlobMemory(store, now),
				...overrides,
			});
		};
		expect((await pull()).outcome).toBe("completed");
		return { github, backend, store, vault, base, pull, push, pass: (ms: number) => void (time += ms) };
	}

	const failsCommit = (request: SentRequest) =>
		request.method === "POST" && request.path === "/git/commits" ? respond(422, { message: "no commit today" }) : undefined;

	test("a push that failed is gone on from, and the push that goes through forgets the blobs", async () => {
		const { github, store, vault, push } = await synced({ "a.md": "A" });
		vault.put("one.png", binary(1));
		vault.put("two.png", binary(2));
		vault.put("b.md", "B");

		github.before = failsCommit;
		await expect(push()).rejects.toThrow("no commit today");
		expect(Object.keys((await stored(store)) as object).sort()).toEqual([blobHash(binary(1)), blobHash(binary(2))].sort());

		github.before = undefined;
		github.requests.length = 0;
		const progress: PushProgress[] = [];
		const pushed = await push({ onProgress: (step) => progress.push(step) });

		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 3 } });
		expect(count(github, "POST /git/blobs")).toBe(0);
		expect(await stored(store)).toBeUndefined();
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md", "one.png", "two.png"]);
		expect(progress.length).toBeGreaterThan(0);
	});

	test("the blobs stay remembered when the remote has moved, and serve the push after the pull", async () => {
		const { github, store, vault, pull, push } = await synced({ "a.md": "A" });
		vault.put("one.png", binary(1));
		github.before = failsCommit;
		await expect(push()).rejects.toThrow("no commit today");
		github.before = undefined;

		// Another device pushes while this one sends: the branch cannot be moved.
		let moved = false;
		github.before = (request) => {
			if (moved || !isTree(request)) return undefined;
			moved = true;
			github.commit({ "mac.md": "from a Mac" });
			return undefined;
		};
		expect(await push()).toMatchObject({ outcome: "pull-first" });
		github.before = undefined;
		expect(Object.keys((await stored(store)) as object)).toEqual([blobHash(binary(1))]);

		expect((await pull()).outcome).toBe("completed");
		github.requests.length = 0;
		expect(await push()).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		expect(count(github, "POST /git/blobs")).toBe(0);
		expect(await stored(store)).toBeUndefined();
	});

	test("a remembered blob that is gone from the repository is sent again, and each file is counted once", async () => {
		const { github, store, vault, push } = await synced({ "a.md": "A" });
		vault.put("one.png", binary(1));
		vault.put("two.png", binary(2));
		github.before = failsCommit;
		await expect(push()).rejects.toThrow("no commit today");
		github.before = undefined;
		// GitHub tidied them away: no commit led to them.
		github.blobs.delete(blobHash(binary(1)));
		github.blobs.delete(blobHash(binary(2)));
		github.requests.length = 0;
		const sending: number[] = [];

		const pushed = await push({
			onProgress: (step) => {
				if (step.phase === "sending") sending.push(step.done);
			},
		});

		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 2 } });
		expect(count(github, "POST /git/blobs")).toBe(2);
		expect(Math.max(...sending)).toBe(2);
		expect(github.files().get("one.png")?.sha).toBe(blobHash(binary(1)));
		expect(await stored(store)).toBeUndefined();
	});

	test("after seven days the blobs are sent again", async () => {
		const { github, vault, push, pass } = await synced({ "a.md": "A" });
		vault.put("one.png", binary(1));
		github.before = failsCommit;
		await expect(push()).rejects.toThrow("no commit today");
		github.before = undefined;
		pass(SENT_BLOB_MS);
		github.requests.length = 0;

		expect(await push()).toMatchObject({ outcome: "pushed" });
		expect(count(github, "POST /git/blobs")).toBe(1);
	});

	test("a memory that cannot be read: the push sends every blob, and goes through", async () => {
		const { github, store, vault, push } = await synced({ "a.md": "A" });
		vault.put("one.png", binary(1));
		const logged: string[] = [];
		const getMeta = store.getMeta.bind(store);
		store.getMeta = async (key) => {
			if (key === SENT_BLOBS_KEY) throw new Error("unreadable");
			return getMeta(key);
		};

		expect(await push({ log: (line) => logged.push(line) })).toMatchObject({ outcome: "pushed" });
		expect(count(github, "POST /git/blobs")).toBe(1);
		expect(logged).toContain("push: the sent blobs could not be read");
	});
});
