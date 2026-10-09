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
import { BackendError, type EntryKind, type ListResult } from "../src/core/backend";
import { conflictCopyPath } from "../src/core/conflict-name";
import { readNotices } from "../src/core/notices";
import type { PullAnswer, PullConfirmRequest, PullDeps, PullResult } from "../src/core/pull";
import { runPull } from "../src/core/pull";
import {
	LARGE_FILE_BYTES,
	type PushAnswer,
	type PushConfirmRequest,
	type PushDeps,
	type PushProgress,
	type PushRunResult,
	runPush,
} from "../src/core/push";
import {
	APPROVED_LARGE_FILES_KEY,
	FIRST_PUSH_CONFIRMED_KEY,
	PENDING_PUSH_KEY,
	readPendingPush,
} from "../src/core/push-pending";
import { PUSH_FAILURE_KEY, readPushFailure } from "../src/core/push-failure";
import { makeMarker, readBaseRevision, type StateStore } from "../src/core/state";
import { pathsToHold, pushFollows, runSync, type SyncResult } from "../src/core/sync";
import { blobHash, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault, type VaultOp } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** A remote a test can bend: symlinks and submodules, and a count of what it was asked. */
class TestBackend extends MemoryBackend {
	readonly kinds = new Map<string, EntryKind>();
	/** How many times the whole remote was listed, and not just found unchanged. */
	listings = 0;
	pushes = 0;
	/** Paths whose content the remote will not take because of its size. */
	readonly refusesForSize = new Set<string>();
	/** How many times it was asked whether one revision is built on another. */
	checks = 0;
	/** Whether that question fails, as on a connection that drops. */
	checkFault = false;
	/** Whether the remote reads as one without commits. */
	emptied = false;

	override checkBase(base: string, head: string): ReturnType<MemoryBackend["checkBase"]> {
		this.checks += 1;
		if (this.checkFault) return Promise.reject(new BackendError("unreachable", "timed out"));
		return super.checkBase(base, head);
	}

	override async list(known: string | null): Promise<ListResult> {
		if (this.emptied) return { changed: true, listing: { revision: null, entries: [] } };
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		this.listings += 1;
		const entries = listed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { changed: true, listing: { revision: listed.listing.revision, entries } };
	}

	override async push(request: Parameters<MemoryBackend["push"]>[0]): ReturnType<MemoryBackend["push"]> {
		this.pushes += 1;
		// A refused file was read, and then not taken: the same as the
		// GitHub backend does with a blob that is too large for GitHub.
		const writes = request.writes.map((file) =>
			this.refusesForSize.has(file.path)
				? {
						...file,
						read: async () => {
							if ((await file.read()) !== null) file.refused?.("too-large");
							return null;
						},
					}
				: file,
		);
		const pushed = await super.push({ ...request, writes });
		if (pushed.status !== "pushed" || pushed.listing === undefined) return pushed;
		const entries = pushed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { ...pushed, listing: { revision: pushed.listing.revision, entries } };
	}
}

/**
 * Stands in for the app being killed: from the `after`th change to the sync
 * state on, every call to the state and the vault fails, as if nothing ran
 * any more. The remote goes on.
 */
class Crash {
	dead = false;
	private left: number | null = null;

	after(changes: number): void {
		this.left = changes;
	}

	revive(): void {
		this.dead = false;
		this.left = null;
	}

	gate(changes: boolean): void {
		if (this.dead) throw new Error("the app is gone");
		if (!changes || this.left === null) return;
		if (this.left === 0) {
			this.dead = true;
			throw new Error("the app is gone");
		}
		this.left -= 1;
	}
}

const STORE_CHANGES = new Set([
	"commitWrite",
	"updateStats",
	"deleteRecord",
	"putMarker",
	"deleteMarker",
	"putListing",
	"clearListing",
	"setMeta",
	"deleteMeta",
]);

function guarded(store: MemoryStateStore, crash: Crash): StateStore {
	return new Proxy(store, {
		get(target, name) {
			const value: unknown = Reflect.get(target, name, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]): unknown => {
				crash.gate(STORE_CHANGES.has(String(name)));
				return (value as (...rest: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

interface Harness {
	readonly backend: TestBackend;
	readonly store: MemoryStateStore;
	readonly vault: MemoryPullVault;
	readonly crash: Crash;
	/** Every question a push asked. */
	readonly asked: PushConfirmRequest[];
	/** Every question a pull asked. */
	readonly pullAsked: PullConfirmRequest[];
	readonly progress: PushProgress[];
	answer: PushAnswer | (() => PushAnswer);
	pullAnswer: PullAnswer;
	now(): number;
	/** Each runs one minute later, so that files written before are no longer recent. */
	pull(overrides?: Partial<PullDeps>): Promise<PullResult>;
	push(overrides?: Partial<PushDeps>): Promise<PushRunResult>;
	sync(overrides?: { pull?: Partial<PullDeps>; push?: Partial<PushDeps> }): Promise<SyncResult>;
	/** Path → hash of every record. */
	records(): Promise<Record<string, string>>;
	base(): Promise<string | null>;
	/** Path → content of every file of the remote, as text. */
	remote(): Promise<Record<string, string>>;
}

function harness(options: { caseSensitive?: boolean } = {}): Harness {
	let time = Date.UTC(2026, 9, 3, 12, 0, 0);
	const now = (): number => time;
	const backend = new TestBackend();
	const store = new MemoryStateStore();
	const crash = new Crash();
	const vault = new MemoryPullVault({ caseSensitive: options.caseSensitive ?? false, now });
	const asked: PushConfirmRequest[] = [];
	const pullAsked: PullConfirmRequest[] = [];
	const progress: PushProgress[] = [];

	const pullDeps = (): PullDeps => ({
		store: guarded(store, crash),
		backend,
		vault,
		paths,
		pluginId: "sync-evo",
		deviceName: "iPhone",
		now,
		confirm: async (request) => {
			pullAsked.push(request);
			return h.pullAnswer;
		},
	});
	const pushDeps = (): PushDeps => ({
		store: guarded(store, crash),
		backend,
		vault,
		paths,
		deviceName: "iPhone",
		now,
		confirm: async (request) => {
			asked.push(request);
			return typeof h.answer === "function" ? h.answer() : h.answer;
		},
		onProgress: (event) => progress.push(event),
	});

	const h: Harness = {
		backend,
		store,
		vault,
		crash,
		asked,
		pullAsked,
		progress,
		answer: "proceed",
		pullAnswer: "proceed",
		now,
		pull(overrides = {}) {
			time += 60_000;
			return runPull({ ...pullDeps(), ...overrides });
		},
		push(overrides = {}) {
			time += 60_000;
			return runPush({ ...pushDeps(), ...overrides });
		},
		sync(overrides = {}) {
			time += 60_000;
			return runSync({ pull: { ...pullDeps(), ...overrides.pull }, push: { ...pushDeps(), ...overrides.push } });
		},
		async records() {
			const out: Record<string, string> = {};
			for (const record of await store.readRecords()) out[record.path] = record.hash;
			return out;
		},
		base: () => readBaseRevision(store),
		async remote() {
			const listed = await new MemoryBackend().list.call(backend, null);
			if (!listed.changed) throw new Error("expected a listing");
			const out: Record<string, string> = {};
			for (const entry of listed.listing.entries) {
				out[entry.path] = new TextDecoder().decode(backend.read(entry.path) ?? new Uint8Array());
			}
			return out;
		},
	};
	return h;
}

function hashes(files: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, blobHash(content)]));
}

/**
 * A harness whose vault and remote are in sync on `files`, after one pull.
 * A push has gone through before, unless `firstPush` says it has not: most
 * tests are not about the question before the first one.
 */
async function synced(
	files: Record<string, FileContent>,
	options: { caseSensitive?: boolean; firstPush?: boolean; kinds?: Record<string, EntryKind> } = {},
): Promise<Harness> {
	const h = harness(options);
	h.backend.commit(files);
	for (const [path, kind] of Object.entries(options.kinds ?? {})) h.backend.kinds.set(path, kind);
	const result = await h.pull();
	expect(result.outcome).toBe("completed");
	if (options.firstPush !== true) await h.store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
	h.vault.log.length = 0;
	h.backend.listings = 0;
	return h;
}

/** What the next pull finds to do: nothing, when the push left everything as it should be. */
async function expectNothingToPull(h: Harness): Promise<void> {
	const before = h.vault.snapshot();
	const listings = h.backend.listings;
	h.vault.log.length = 0;
	const result = await h.pull();
	expect(result).toMatchObject({
		outcome: "completed",
		counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
		conflicts: [],
		deferred: [],
	});
	expect(h.vault.snapshot()).toEqual(before);
	expect(h.vault.log).toEqual([]);
	// The push stored the listing of its own commit.
	expect(h.backend.listings).toBe(listings);
	expect(await h.base()).toBe(h.backend.revision);
	expect(await h.records()).toEqual(hashes(await h.remote()));
}

describe("a push", () => {
	test("sends what was added, edited and deleted as one revision, and records it", async () => {
		const h = await synced({ "keep.md": "K", "edit.md": "E", "old.md": "O", "notes/a.md": "A" });
		const before = h.backend.revision;
		h.vault.put("edit.md", "E2");
		h.vault.put("notes/new.md", "N");
		h.vault.remove("old.md");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 1, modified: 1, deleted: 1 },
			recovered: null,
			refused: [],
			held: [],
			leftOut: [],
		});
		expect(result.revision).toBe(h.backend.revision);
		expect(result.revision).not.toBe(before);
		expect(await h.remote()).toEqual({ "keep.md": "K", "edit.md": "E2", "notes/a.md": "A", "notes/new.md": "N" });
		expect(await h.records()).toEqual(hashes(await h.remote()));
		expect(await h.base()).toBe(h.backend.revision);
		expect(h.backend.lastDeviceName).toBe("iPhone");
		expect(h.backend.pushes).toBe(1);
		expect(h.asked).toEqual([]);
		// The vault is only read.
		expect(h.vault.log).toEqual([]);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
	});

	test("a pull right after it has nothing to do, and does not list the remote again", async () => {
		const h = await synced({ "keep.md": "K", "edit.md": "E", "old.md": "O" });
		h.vault.put("edit.md", "E2");
		h.vault.put("new.md", "N");
		h.vault.remove("old.md");
		await h.push();
		await expectNothingToPull(h);
		// And a second push finds nothing to send.
		expect((await h.push()).outcome).toBe("nothing-to-push");
	});

	test("with nothing changed, no revision is made and nothing is asked", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		const before = h.backend.revision;

		const result = await h.push();

		expect(result.outcome).toBe("nothing-to-push");
		expect(h.backend.revision).toBe(before);
		expect(h.backend.pushes).toBe(0);
		expect(h.asked).toEqual([]);
	});

	test("reports the phases it goes through", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		await h.push();
		const phases = h.progress.map((event) => event.phase).filter((phase, i, all) => phase !== all[i - 1]);
		expect(phases).toEqual(["listing", "scanning", "hashing", "sending", "finishing"]);
		expect(h.progress.filter((event) => event.phase === "sending").pop()).toEqual({ phase: "sending", done: 1, total: 1 });
	});
});

describe("when a pull has to come first", () => {
	test("a device that has never pulled sends nothing", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("mine.md", "M");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pull-first", reason: "no-base" });
		expect(h.backend.pushes).toBe(0);
		expect(h.asked).toEqual([]);
	});

	test("nor does one whose first fetch was stopped halfway", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "A", "b.md": "B", "c.md": "C" });
		h.vault.put("mine.md", "M");
		const controller = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") controller.abort();
		};
		expect((await h.pull({ signal: controller.signal })).outcome).toBe("cancelled");
		h.vault.before = undefined;

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pull-first", reason: "no-base" });
		expect(h.backend.revision).toBe(head);
	});

	test("a remote whose commits are gone, with which this device has synced before, is a pull's to look at", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("mine.md", "M");
		h.backend.emptied = true;
		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "remote-empty" });
		expect(h.backend.pushes).toBe(0);
	});

	test("another device pushing while the files are read: nothing is forced, and nothing is recorded", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("mine.md", "M");
		let reads = 0;
		let theirs = "";
		h.vault.before = (op, path) => {
			// The second read of the file is the one that sends it.
			if (op === "read" && path === "mine.md" && ++reads === 2) theirs = h.backend.commit({ "theirs.md": "T" });
		};

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pull-first", reason: "remote-moved", revision: null });
		expect(h.backend.revision).toBe(theirs);
		expect(await h.remote()).toEqual({ "a.md": "A", "theirs.md": "T" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();

		// A pull, and the push goes through.
		h.vault.before = undefined;
		expect((await h.sync()).push?.outcome).toBe("pushed");
		expect(await h.remote()).toEqual({ "a.md": "A", "theirs.md": "T", "mine.md": "M" });
	});
});

describe("a push without a pull before it", () => {
	test("is built on the head as it is now, sends what this device changed, and touches nothing the remote changed", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B", "c.md": "C", "d.md": "D" });
		const base = await h.base();
		// A Mac: edits one file, deletes one, adds one.
		const head = h.backend.commit({ "a.md": "A from the Mac", "c.md": null, "theirs.md": "T" });
		// This device: edits another file, and one the Mac edited too.
		h.vault.put("b.md", "B from here");
		h.vault.put("mine.md", "M");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({
			"a.md": "A from the Mac",
			"b.md": "B from here",
			"d.md": "D",
			"theirs.md": "T",
			"mine.md": "M",
		});
		expect(h.backend.revision).not.toBe(head);
		// What the pull has yet to do is as it was: nothing written, nothing
		// recorded, and the base revision where the last pull left it.
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B from here", "c.md": "C", "d.md": "D", "mine.md": "M" });
		expect(await h.base()).toBe(base);
		expect((await h.records())["a.md"]).toBe(blobHash("A"));
		expect((await h.records())["c.md"]).toBe(blobHash("C"));

		// The pull then does its half, and the history reads as continuous.
		const pulled = await h.pull();
		expect(pulled).toMatchObject({ outcome: "completed", rewritten: false, counts: { fetched: 2, deleted: 1 } });
		expect(h.pullAsked).toEqual([]);
		expect(h.vault.snapshot()).toEqual(await h.remote());
		expect(await h.base()).toBe(h.backend.revision);
	});

	test("a file changed on both sides is not sent: it is a conflict for the pull", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A from the Mac" });
		h.vault.put("a.md", "A from here");

		expect((await h.push()).outcome).toBe("nothing-to-push");
		expect(await h.remote()).toEqual({ "a.md": "A from the Mac" });
	});

	test("a file the remote has and this device never had is not deleted", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "theirs.md": "T" });
		h.vault.put("a.md", "A2");

		await h.push();

		expect(await h.remote()).toEqual({ "a.md": "A2", "theirs.md": "T" });
	});

	test("after the history was rewritten, the base revision stays, so that the next pull still asks", async () => {
		const h = await synced({ "a.md": "A", "sent.md": "S" });
		const base = await h.base();
		// A force push that drops a file this device had sent.
		h.backend.rewriteHistory({ "a.md": "A" });
		h.vault.put("new.md", "N");

		expect((await h.push()).outcome).toBe("pushed");

		expect(await h.base()).toBe(base);
		h.pullAnswer = "cancel";
		const pulled = await h.pull();
		expect(pulled).toMatchObject({ outcome: "declined", rewritten: true });
		expect(h.pullAsked[0]?.losses).toMatchObject({ rewritten: true, deletions: [{ path: "sent.md" }] });
		expect(h.vault.text("sent.md")).toBe("S");
	});
});

describe("the question before the first push", () => {
	test("lists what is added, modified and deleted, and is asked once", async () => {
		const h = await synced({ "edit.md": "E", "old.md": "O", "keep.md": "K" }, { firstPush: true });
		h.vault.put("edit.md", "E2");
		h.vault.put(".obsidian/graph.json", "{}");
		h.vault.put("notes/new.md", "N");
		h.vault.remove("old.md");

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.asked).toEqual([
			{
				firstPush: { added: [".obsidian/graph.json", "notes/new.md"], modified: ["edit.md"], deleted: ["old.md"] },
				deletions: null,
				largeFiles: null,
				remoteEmpty: false, recordCount: 3,
			},
		]);

		h.vault.put("more.md", "M");
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(1);
	});

	test("a no sends nothing, and the question comes again", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		const before = h.backend.revision;
		h.vault.put("new.md", "N");
		h.answer = "cancel";

		const result = await h.push();

		expect(result.outcome).toBe("declined");
		expect(h.backend.revision).toBe(before);
		expect(h.backend.pushes).toBe(0);
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));

		h.answer = "proceed";
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(2);
	});

	test("a yes to a push that then fails does not count: the next push asks again", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.put("new.md", "N");
		h.backend.publishFault = "lost-request";
		await expect(h.push()).rejects.toThrow("timed out");
		h.backend.publishFault = null;

		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(2);
		h.vault.put("more.md", "M");
		await h.push();
		expect(h.asked.length).toBe(2);
	});

	test("with too many deletions as well, it is one question about both", async () => {
		const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(files, { firstPush: true });
		for (let i = 0; i < 6; i++) h.vault.remove(`n${i}.md`);
		h.vault.put("new.md", "N");

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.asked.length).toBe(1);
		const gone = ["n0.md", "n1.md", "n2.md", "n3.md", "n4.md", "n5.md"];
		expect(h.asked[0]).toEqual({
			firstPush: { added: ["new.md"], modified: [], deleted: gone },
			deletions: gone,
			largeFiles: null,
			remoteEmpty: false, recordCount: 10,
		});
	});
});

describe("the deletion guard", () => {
	const thirty = (): Record<string, string> =>
		Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n/${String(i).padStart(2, "0")}.md`, `note ${i}`]));

	test("six deletions of thirty stop the push; a no sends nothing at all", async () => {
		const h = await synced(thirty());
		const before = h.backend.revision;
		for (let i = 0; i < 6; i++) h.vault.remove(`n/0${i}.md`);
		h.vault.put("added.md", "also not sent");
		h.answer = "cancel";

		const result = await h.push();

		expect(result.outcome).toBe("declined");
		expect(h.asked).toEqual([
			{
				firstPush: null,
				deletions: ["n/00.md", "n/01.md", "n/02.md", "n/03.md", "n/04.md", "n/05.md"],
				largeFiles: null,
				remoteEmpty: false, recordCount: 30,
			},
		]);
		expect(h.backend.revision).toBe(before);
		expect(Object.keys(await h.remote()).length).toBe(30);
		expect(Object.keys(await h.records()).length).toBe(30);
	});

	test("it is counted again by every push: a yes is not remembered", async () => {
		const h = await synced(thirty());
		for (let i = 0; i < 6; i++) h.vault.remove(`n/0${i}.md`);
		h.backend.publishFault = "lost-request";
		await expect(h.push()).rejects.toThrow("timed out");
		h.backend.publishFault = null;

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.asked.length).toBe(2);
		expect(Object.keys(await h.remote()).length).toBe(24);
		await expectNothingToPull(h);
	});

	test("five deletions of thirty are sent without a question", async () => {
		const h = await synced(thirty());
		for (let i = 0; i < 5; i++) h.vault.remove(`n/0${i}.md`);
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 5 } });
		expect(h.asked).toEqual([]);
	});

	test("a folder that was renamed is no deletion", async () => {
		const h = await synced(thirty());
		for (const [path, content] of Object.entries(thirty())) {
			h.vault.remove(path);
			h.vault.put(path.replace("n/", "renamed/"), content);
		}
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 30, deleted: 30 } });
		expect(h.asked).toEqual([]);
		await expectNothingToPull(h);
	});

	test("a hundred empty files deleted and one added still stop it", async () => {
		const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`e${i}.md`, ""]));
		const h = await synced(files);
		for (const path of Object.keys(files)) h.vault.remove(path);
		h.vault.put("one.md", "");
		h.answer = "cancel";

		expect((await h.push()).outcome).toBe("declined");
		expect(h.asked[0]?.deletions?.length).toBe(99);
	});
});

describe("content that changes while the push runs", () => {
	test("what an editor has not saved yet is saved first, and sent", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.open("a.md", "A, typed and not saved");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });

		expect(await h.remote()).toEqual({ "a.md": "A, typed and not saved" });
		await expectNothingToPull(h);
	});

	test("a file the remote refuses for its size is left out and told, the rest is sent, and the next push meets it again", async () => {
		const h = await synced({ "a.md": "A", "old.bin": "OLD" });
		h.vault.put("a.md", "A2");
		h.vault.put("big.bin", "BIG");
		h.vault.put("old.bin", "OLD, and now too large");
		h.backend.refusesForSize.add("big.bin").add("old.bin");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 0 },
			leftOut: [
				{ path: "big.bin", reason: "refused-size" },
				{ path: "old.bin", reason: "refused-size" },
			],
		});
		expect(await h.remote()).toEqual({ "a.md": "A2", "old.bin": "OLD" });
		const records = await h.records();
		expect(records["big.bin"]).toBeUndefined();
		expect(records["old.bin"]).toBe(blobHash("OLD"));
		// The push went through, so it is not one that did not finish.
		expect(await readPushFailure(h.store)).toBeNull();

		// Nothing was lost on this device, and nothing is deleted or pulled over it.
		expect((await h.pull()).counts).toMatchObject({ fetched: 0, deleted: 0, conflicts: 0 });
		expect(h.vault.text("big.bin")).toBe("BIG");
		expect(h.vault.text("old.bin")).toBe("OLD, and now too large");

		const again = await h.push();
		expect(again).toMatchObject({ outcome: "nothing-to-push", leftOut: [{ path: "big.bin" }, { path: "old.bin" }] });

		// Small enough again, and it is sent.
		h.backend.refusesForSize.clear();
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1 }, leftOut: [] });
		await expectNothingToPull(h);
	});

	test("a file typed in after it was compared is sent as it is by then, and recorded as it was sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B2");
		// Saved once before the hashing, and once more when the file is sent.
		h.vault.open("a.md", "A2", "A3, typed during the push");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { modified: 2 }, leftOut: [] });
		expect(await h.remote()).toEqual({ "a.md": "A3, typed during the push", "b.md": "B2" });
		expect((await h.records())["a.md"]).toBe(blobHash("A3, typed during the push"));
		await expectNothingToPull(h);
	});

	test("an edit between the look at the file and the read of it is found by the next sync", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		let reads = 0;
		h.vault.before = (op, path) => {
			// After the time and the size were taken, and before the read.
			if (op === "read" && path === "a.md" && ++reads === 2) h.vault.put("a.md", "A3", h.now() - 30_000);
		};

		expect((await h.push()).outcome).toBe("pushed");
		h.vault.before = undefined;

		// The later content was read and sent, and is what the record says.
		expect(await h.remote()).toEqual({ "a.md": "A3" });
		expect((await h.records())["a.md"]).toBe(blobHash("A3"));
		// A further edit of the same size, at the time the record would
		// have had if it had been taken after the read, is still seen.
		h.vault.put("a.md", "A4", h.now() - 30_000);
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });
		expect(await h.remote()).toEqual({ "a.md": "A4" });
	});

	test("a file whose editor cannot save is left alone, and the rest is sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2 on disk");
		h.vault.put("b.md", "B2");
		h.vault.openFailing("a.md");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, held: ["a.md"] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2" });
		expect((await h.records())["a.md"]).toBe(blobHash("A"));

		h.vault.close("a.md");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, held: [] });
		expect(await h.remote()).toEqual({ "a.md": "A2 on disk", "b.md": "B2" });
	});

	test("a file that is gone when its turn comes is left out, and the rest is sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B2");
		let stats = 0;
		h.vault.before = (op, path) => {
			if (op === "stat" && path === "a.md" && ++stats === 2) h.vault.remove("a.md");
		};

		const result = await h.push();
		h.vault.before = undefined;

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { modified: 1, deleted: 0 },
			leftOut: [{ path: "a.md", reason: "gone" }],
		});
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2" });
		// The record is the one from before, so the next push sees the deletion.
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });
		expect(await h.remote()).toEqual({ "b.md": "B2" });
	});

	test("a file that cannot be read when its turn comes is left out", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B");
		let reads = 0;
		h.vault.before = (op, path) => {
			if (op === "read" && path === "a.md" && ++reads === 2) throw new Error("EIO");
		};

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1 }, leftOut: [{ path: "a.md", reason: "unreadable" }] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B" });
	});

	test("an edit that is taken back before it is sent makes no revision", async () => {
		const h = await synced({ "a.md": "A" });
		const before = h.backend.revision;
		h.vault.put("a.md", "A2");
		h.vault.open("a.md", "A2", "A");

		expect((await h.push()).outcome).toBe("nothing-to-push");
		expect(h.backend.revision).toBe(before);
	});
});

describe("a push that ends without knowing whether it went through", () => {
	async function changed(): Promise<Harness> {
		const h = await synced({ "keep.md": "K", "edit.md": "E", "old.md": "O" });
		h.vault.put("edit.md", "E2");
		h.vault.put("new.md", "N");
		h.vault.remove("old.md");
		return h;
	}
	const after = { "keep.md": "K", "edit.md": "E2", "new.md": "N" };

	test("the request never arrived: the next push sends it, once", async () => {
		const h = await changed();
		const before = h.backend.revision;
		h.backend.publishFault = "lost-request";

		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });

		expect(h.backend.revision).toBe(before);
		expect((await readPendingPush(h.store))?.parent).toBe(before);
		expect(await h.records()).toEqual(hashes({ "keep.md": "K", "edit.md": "E", "old.md": "O" }));

		h.backend.publishFault = null;
		const result = await h.push();
		expect(result).toMatchObject({ outcome: "pushed", recovered: null, counts: { added: 1, modified: 1, deleted: 1 } });
		expect(await h.remote()).toEqual(after);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		await expectNothingToPull(h);
	});

	test("the answer was lost: the next push finds its commit as the head, records it, and tells it", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";

		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });

		expect(await h.remote()).toEqual(after);
		expect(await h.records()).toEqual(hashes({ "keep.md": "K", "edit.md": "E", "old.md": "O" }));
		const head = h.backend.revision;

		h.backend.publishFault = null;
		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "nothing-to-push",
			recovered: { added: 1, modified: 1, deleted: 1 },
		});
		// No second commit of the same changes.
		expect(h.backend.revision).toBe(head);
		expect(await h.records()).toEqual(hashes(after));
		expect(await h.base()).toBe(head);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBe(true);
		await expectNothingToPull(h);
	});

	test("the answer was lost: a pull finds it too, with no conflict and no copy", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		const local = h.vault.snapshot();

		const pulled = await h.pull();

		expect(pulled).toMatchObject({
			outcome: "completed",
			recoveredPush: { added: 1, modified: 1, deleted: 1 },
			counts: { fetched: 0, deleted: 0, conflicts: 0 },
		});
		expect(h.vault.snapshot()).toEqual(local);
		expect(await h.records()).toEqual(hashes(after));
		expect(await h.base()).toBe(h.backend.revision);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// Told once.
		expect((await h.pull()).recoveredPush).toBeUndefined();
	});

	test("the answer was lost, and the file was edited again before the next sync: the edit is sent", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		h.vault.put("edit.md", "E3");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", recovered: { added: 1 }, counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ ...after, "edit.md": "E3" });
	});

	test("the answer was lost, and another device edited a file it sent: recorded and told once, and an ordinary fetch with no copy", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		const sent = h.backend.revision;
		h.backend.commit({ "edit.md": "E3 from the Mac", "theirs.md": "T" });
		const now = { ...after, "edit.md": "E3 from the Mac", "theirs.md": "T" };

		const pulled = await h.pull();

		expect(pulled).toMatchObject({
			outcome: "completed",
			recoveredPush: { added: 1, modified: 1, deleted: 1 },
			counts: { fetched: 2, deleted: 0, conflicts: 0 },
			conflicts: [],
		});
		// No copy of a conflict that never was.
		expect(h.vault.snapshot()).toEqual(now);
		expect(await h.records()).toEqual(hashes(now));
		expect(await h.base()).toBe(h.backend.revision);
		expect(h.backend.revision).not.toBe(sent);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBe(true);
		// Told once, and nothing is left to send.
		expect((await h.pull()).recoveredPush).toBeUndefined();
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push", recovered: null });
	});

	test("the same, found by a push: what the other device changed is left for the pull", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		h.backend.commit({ "edit.md": "E3 from the Mac" });
		const head = h.backend.revision;

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "nothing-to-push", recovered: { added: 1, modified: 1, deleted: 1 } });
		expect(h.backend.revision).toBe(head);
		expect(await h.records()).toEqual(hashes(after));
		// The listing it goes by is the one of the head, as the remote gave it.
		expect((await h.store.getListing())?.revision).toBe(head);
		const pulled = await h.pull();
		expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 1, conflicts: 0 } });
		expect(pulled.recoveredPush).toBeUndefined();
		expect(h.vault.text("edit.md")).toBe("E3 from the Mac");
	});

	test("the request never arrived, and another device pushed: the push is forgotten, and planned as usual", async () => {
		const h = await changed();
		const local = h.vault.snapshot();
		h.backend.publishFault = "lost-request";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		h.backend.commit({ "theirs.md": "T" });

		const pulled = await h.pull();

		expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 1, deleted: 0, conflicts: 0 } });
		expect(pulled.recoveredPush).toBeUndefined();
		expect(h.backend.checks).toBeGreaterThan(0);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// Nothing of the push is recorded: it is all still to send.
		expect(h.vault.snapshot()).toEqual({ ...local, "theirs.md": "T" });
		expect(await h.records()).toEqual(hashes({ "keep.md": "K", "edit.md": "E", "old.md": "O", "theirs.md": "T" }));
		const result = await h.push();
		expect(result).toMatchObject({ outcome: "pushed", recovered: null, counts: { added: 1, modified: 1, deleted: 1 } });
		expect(await h.remote()).toEqual({ ...after, "theirs.md": "T" });
	});

	test("the answer was lost, and another device deleted files it sent: deleted here as any file the remote deleted", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		// One the push added, and one it edited.
		h.backend.commit({ "new.md": null, "edit.md": null });
		h.vault.log.length = 0;

		const pulled = await h.pull();

		// The push is recorded first, so the two files read as unchanged
		// here and deleted there: no conflict, no copy, and nothing kept
		// as if it were only this device's.
		expect(pulled).toMatchObject({
			outcome: "completed",
			recoveredPush: { added: 1, modified: 1, deleted: 1 },
			counts: { fetched: 0, deleted: 2, renamed: 0, conflicts: 0 },
			conflicts: [],
			deferred: [],
			// Listed only when the history was rewritten.
			trashed: [],
		});
		expect(h.pullAsked).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "keep.md": "K" });
		// Taken away as the setting for deleted files says, and nothing else is touched.
		expect([...h.vault.log].sort()).toEqual(["trash edit.md (user-setting)", "trash new.md (user-setting)"]);
		expect(await h.records()).toEqual(hashes({ "keep.md": "K" }));
		expect(await h.base()).toBe(h.backend.revision);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// Told once, and nothing is sent back.
		expect((await h.pull()).recoveredPush).toBeUndefined();
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push", recovered: null });
		expect(await h.remote()).toEqual({ "keep.md": "K" });
	});

	for (const next of ["pull", "push"] as const) {
		test(`the remote was emptied since: the ${next} forgets the push, without asking the remote about it`, async () => {
			const h = await changed();
			h.backend.publishFault = "lost-answer";
			await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
			h.backend.publishFault = null;
			expect(await readPendingPush(h.store)).not.toBeNull();
			const local = h.vault.snapshot();
			h.backend.emptied = true;
			h.backend.checks = 0;
			h.pullAnswer = "cancel";

			if (next === "pull") {
				// A remote that lost its content is a rewritten history, which is asked about.
				const pulled = await h.pull();
				expect(pulled).toMatchObject({ outcome: "declined", remoteEmpty: true, rewritten: true });
				expect(pulled.recoveredPush).toBeUndefined();
			} else {
				expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "remote-empty", recovered: null });
			}

			expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
			// There is no head to ask about.
			expect(h.backend.checks).toBe(0);
			// What it sent is not recorded as sent, and the vault is as it was.
			expect(await h.records()).toEqual(hashes({ "keep.md": "K", "edit.md": "E", "old.md": "O" }));
			expect(h.vault.snapshot()).toEqual(local);
		});
	}

	test("the history was rewritten since: the push is forgotten", async () => {
		const h = await changed();
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		h.backend.rewriteHistory({ "keep.md": "K" });

		const pulled = await h.pull();

		expect(pulled.rewritten).toBe(true);
		expect(pulled.recoveredPush).toBeUndefined();
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// What it sent is not recorded as sent: the edit is still this device's to send.
		expect((await h.records())["edit.md"]).not.toBe(blobHash("E2"));
		expect(h.vault.text("edit.md")).toBe("E2");
	});

	for (const next of ["pull", "push"] as const) {
		test(`when the remote cannot say whether the push is below the head, the ${next} ends there and the push stays remembered`, async () => {
			const h = await changed();
			h.backend.publishFault = "lost-answer";
			await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
			h.backend.publishFault = null;
			h.backend.commit({ "edit.md": "E3 from the Mac" });
			const local = h.vault.snapshot();
			h.backend.checkFault = true;

			await expect(next === "pull" ? h.pull() : h.push()).rejects.toMatchObject({ kind: "unreachable" });

			// Nothing was decided from the old records: no copy, nothing sent.
			expect((await readPendingPush(h.store))?.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
			expect(h.vault.snapshot()).toEqual(local);
			expect(await h.records()).toEqual(hashes({ "keep.md": "K", "edit.md": "E", "old.md": "O" }));

			h.backend.checkFault = false;
			const pulled = await h.pull();
			expect(pulled).toMatchObject({ outcome: "completed", recoveredPush: { added: 1 }, counts: { conflicts: 0 } });
			expect(h.vault.text("edit.md")).toBe("E3 from the Mac");
		});
	}

	test("with no push left behind, the remote is not asked about one", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		await h.push();
		h.backend.commit({ "c.md": "C" });
		h.backend.checks = 0;
		h.vault.put("d.md", "D");
		// A push alone asks nothing of the history.
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.backend.checks).toBe(0);
	});

	test("stopped, or failing, after the commit was made and before the branch is moved: nothing is left to find out", async () => {
		for (const how of ["stopped", "failed"] as const) {
			const h = await synced({ "a.md": "A" });
			h.vault.put("b.md", "B");
			const before = h.backend.revision;
			const controller = new AbortController();
			let remembered = false;
			const store = new Proxy(h.store, {
				get(target, name) {
					const value: unknown = Reflect.get(target, name, target);
					if (typeof value !== "function") return value;
					return (...args: unknown[]): unknown => {
						if (name === "setMeta" && args[0] === PENDING_PUSH_KEY) remembered = true;
						return (value as (...rest: unknown[]) => unknown).apply(target, args);
					};
				},
			});
			h.backend.beforeMove = () => {
				if (how === "stopped") {
					controller.abort();
					throw new BackendError("cancelled", "push: cancelled");
				}
				throw new BackendError("other", "boom");
			};

			if (how === "stopped") expect((await h.push({ signal: controller.signal, store })).outcome).toBe("cancelled");
			else await expect(h.push({ store })).rejects.toMatchObject({ kind: "other" });

			// It was remembered, and is forgotten again.
			expect(remembered).toBe(true);
			expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
			expect(h.backend.revision).toBe(before);
			h.backend.beforeMove = undefined;
			h.backend.checks = 0;
			expect((await h.push()).outcome).toBe("pushed");
			expect(h.backend.checks).toBe(0);
		}
	});

	// Killed after any number of changes to the sync state: whatever the
	// push had got to, the next sync ends with the remote and the records
	// agreeing, one commit made, and no file of the vault touched.
	for (const next of ["pull", "push"] as const) {
		test(`killed at any point, and a ${next} comes next`, async () => {
			let completed = false;
			for (let kill = 0; !completed; kill++) {
				expect(kill).toBeLessThan(40);
				const h = await changed();
				const local = h.vault.snapshot();
				const before = h.backend.revision;
				const revisions = h.backend.revisionCount;
				h.vault.before = (op: VaultOp) => h.crash.gate(op === "write" || op === "trash" || op === "rename");
				h.crash.after(kill);
				try {
					await h.push();
					completed = true;
				} catch (error) {
					expect((error as Error).message).toBe("the app is gone");
				}
				h.crash.revive();
				const reached = h.backend.revision !== before;

				if (next === "pull") {
					const pulled = await h.pull();
					expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
					// Killed after the remote had the commit: found, and told.
					expect(pulled.recoveredPush !== undefined).toBe(reached && !completed);
				}
				// A push that had not reached the remote sends now.
				const again = await h.push();
				expect(["pushed", "nothing-to-push"]).toContain(again.outcome);
				expect(again.outcome === "pushed").toBe(!reached);
				if (next === "push") expect(again.recovered !== null).toBe(reached && !completed);

				expect(h.vault.snapshot()).toEqual(local);
				expect(await h.remote()).toEqual(after);
				expect(await h.records()).toEqual(hashes(after));
				expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
				// One commit, whichever run made it.
				expect(h.backend.revisionCount).toBe(revisions + 1);
				await expectNothingToPull(h);
			}
		});
	}
});

describe("paths that differ only in case, on a device that tells them apart", () => {
	test("a new file beside one of the remote is not sent and is told once; the rest is sent; renamed, it is sent", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true });
		h.vault.put("case.md", "c");
		h.vault.put("other.md", "O");

		const first = await h.push();

		expect(first).toMatchObject({
			outcome: "pushed",
			counts: { added: 1 },
			refused: [{ path: "case.md", reason: "case-collision" }],
			notices: [{ kind: "local-path-collision", path: "case.md" }],
		});
		expect(await h.remote()).toEqual({ "Case.md": "C", "other.md": "O" });

		// Still refused, and not told a second time; a pull in between
		// does not make it forget.
		await h.pull();
		const second = await h.push();
		expect(second).toMatchObject({ outcome: "nothing-to-push", refused: [{ path: "case.md" }], notices: [] });

		h.vault.remove("case.md");
		h.vault.put("lower.md", "c");
		expect(await h.push()).toMatchObject({ outcome: "pushed", refused: [], notices: [] });
		expect(await h.remote()).toEqual({ "Case.md": "C", "other.md": "O", "lower.md": "c" });
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a new file in a folder that differs in case from one of the remote is not sent", async () => {
		const h = await synced({ "notes/a.md": "A" }, { caseSensitive: true });
		h.vault.put("Notes/b.md", "B");

		expect(await h.push()).toMatchObject({
			outcome: "nothing-to-push",
			refused: [{ path: "Notes/b.md", reason: "case-collision" }],
		});
		expect(await h.remote()).toEqual({ "notes/a.md": "A" });
	});

	test("a rename that only changes the case is sent, and no collision is told", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true });
		h.vault.remove("Case.md");
		h.vault.put("case.md", "C");

		expect(await h.push()).toMatchObject({
			outcome: "pushed",
			counts: { added: 1, modified: 0, deleted: 1 },
			refused: [],
			notices: [],
		});
		expect(await h.remote()).toEqual({ "case.md": "C" });
		await expectNothingToPull(h);
	});
});

describe("a rename in case alone whose new spelling a rule excludes", () => {
	test("sends neither the deletion nor the file, and tells it", async () => {
		// As on a Mac: one file, spelled otherwise than the remote and the record.
		const h = await synced({ "drafts/a.md": "A", ".gitignore": "/drafts/\n", "keep.md": "K" });
		await h.vault.rename("drafts", "Drafts");
		h.vault.log.length = 0;
		h.vault.put("keep.md", "K2");
		expect(h.vault.paths()).toContain("Drafts/a.md");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 0 },
			heldRenames: [{ from: "drafts/a.md", to: "Drafts/a.md" }],
			notices: [{ kind: "rename-not-sent", path: "Drafts/a.md" }],
		});
		expect(await h.remote()).toEqual({ "drafts/a.md": "A", ".gitignore": "/drafts/\n", "keep.md": "K2" });
		expect((await h.records())["drafts/a.md"]).toBe(blobHash("A"));
	});
});

describe("what a push never sends", () => {
	test("a file a rule of this device's .gitignore excludes, the plugin's own folder, and a .git", async () => {
		const h = await synced({ "a.md": "A", ".gitignore": "private/\n*.tmp\n" });
		h.vault.put("private/diary.md", "D");
		h.vault.put("x.tmp", "T");
		h.vault.put(".obsidian/plugins/sync-evo/main.js", "js");
		h.vault.put(".obsidian/plugins/sync-evo/data.json", "{}");
		h.vault.put(".git/config", "c");
		h.vault.put(".github/workflows/ci.yml", "on: push");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		expect(await h.remote()).toEqual({
			"a.md": "A",
			".gitignore": "private/\n*.tmp\n",
			".github/workflows/ci.yml": "on: push",
		});
	});

	test("a file at, or below, a symlink or a submodule of the remote; and neither is deleted", async () => {
		const h = await synced(
			{ "a.md": "A", ".claude/skills": "../skills", knowledge: "c".repeat(40) },
			{ kinds: { ".claude/skills": "symlink", knowledge: "submodule" } },
		);
		expect(h.vault.paths()).toEqual(["a.md"]);
		h.vault.put(".claude/skills/x/SKILL.md", "S");
		h.vault.put("knowledge/note.md", "N");
		h.vault.put("a.md", "A2");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", ".claude/skills": "../skills", knowledge: "c".repeat(40) });
	});

	test("a file over the size limit: skipped and told once, on this device or on the remote", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "theirs.bin": "0123456789ABCDEF" });
		expect((await h.pull({ sizeLimit: 12 })).outcome).toBe("completed");
		h.vault.put("mine.bin", "0123456789ABCDEF");
		h.vault.put("theirs.bin", "small");
		h.vault.put("b.md", "B");

		const result = await h.push({ sizeLimit: 12 });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
		// The remote's was told by the pull already.
		expect(result.notices).toEqual([{ kind: "too-large", path: "mine.bin" }]);
		expect(await h.remote()).toEqual({ "a.md": "A", "theirs.bin": "0123456789ABCDEF", "b.md": "B" });
		expect((await h.push({ sizeLimit: 12 })).notices).toEqual([]);
	});

	test("a file that grows over the limit before it is sent is left out", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		h.vault.open("a.md", "A2", "A2 and much, much more");

		const result = await h.push({ sizeLimit: 12 });

		expect(result).toMatchObject({ outcome: "nothing-to-push", leftOut: [{ path: "a.md", reason: "too-large" }] });
		expect(await h.remote()).toEqual({ "a.md": "A" });
	});

	test("the copy of a conflict in the configuration folder, while the copy of a note is sent", async () => {
		const h = await synced({ "notes/a.md": "A", ".obsidian/app.json": "{}" });
		const at = new Date(2026, 9, 3, 22, 15, 0);
		const noteCopy = conflictCopyPath("notes/a.md", "iPhone", at);
		const settingsCopy = conflictCopyPath(".obsidian/app.json", "iPhone", at);
		h.vault.put(noteCopy, "mine");
		h.vault.put(settingsCopy, "{mine}");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		expect(Object.keys(await h.remote()).sort()).toEqual([".obsidian/app.json", "notes/a.md", noteCopy].sort());
	});

	test("a file a pull that stopped left half written: not sent, not deleted, and the rest is sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B", "c.md": "C" });
		// The pull was writing "A from the Mac" to `a.md` and got half of it
		// down; and it was about to write `c.md`, which the user deleted since.
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A from the Mac"), false));
		h.vault.put("a.md", "A from");
		await h.store.putMarker(makeMarker("c.md", blobHash("C"), blobHash("C2"), false));
		h.vault.remove("c.md");
		h.vault.put("b.md", "B2");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 }, held: ["a.md"] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2", "c.md": "C" });
		// The markers are the pull's to settle.
		expect((await h.store.readMarkers()).map((marker) => marker.path).sort()).toEqual(["a.md", "c.md"]);
	});

	test("the half-written copy of a conflict, and the file it is a copy of", async () => {
		const h = await synced({ "a.md": "A" });
		const copy = conflictCopyPath("a.md", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
		await h.store.putMarker(makeMarker(copy, null, blobHash("mine, in full"), true));
		h.vault.put(copy, "mine, in");
		h.vault.put("a.md", "mine, in full");
		h.vault.put("b.md", "B");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B" });
	});

	test("anything, while the .gitignore itself may be half written", async () => {
		const h = await synced({ "a.md": "A", ".gitignore": "private/\n" });
		await h.store.putMarker(makeMarker(".gitignore", blobHash("private/\n"), blobHash("private/\nsecret/\n"), false));
		h.vault.put(".gitignore", "priv");
		h.vault.put("private/diary.md", "D");

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
		expect(h.backend.pushes).toBe(0);
	});

	test("nor while an editor cannot save the .gitignore", async () => {
		const h = await synced({ "a.md": "A", ".gitignore": "private/\n" });
		h.vault.openFailing(".gitignore");
		h.vault.put("b.md", "B");
		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
		expect(h.backend.pushes).toBe(0);
	});

	test("the paths it is told to hold: neither an edit nor a deletion of them is sent", async () => {
		const h = await synced({ "edit.md": "E", "gone.md": "G", "b.md": "B" });
		h.vault.put("edit.md", "E2");
		h.vault.remove("gone.md");
		h.vault.put("new.md", "N");
		h.vault.put("b.md", "B2");

		const result = await h.push({ hold: ["edit.md", "gone.md", "new.md"] });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(result.held.slice().sort()).toEqual(["edit.md", "new.md"]);
		expect(await h.remote()).toEqual({ "edit.md": "E", "gone.md": "G", "b.md": "B2" });
	});

	test("a file where the remote has a folder this device has not pulled", async () => {
		const h = await synced({ "x.md": "X" });
		h.backend.commit({ "a/theirs.md": "T" });
		h.vault.put("a", "a file here");
		h.vault.put("x.md", "X2");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1 },
			refused: [{ path: "a", reason: "remote-in-the-way" }],
		});
		expect(await h.remote()).toEqual({ "x.md": "X2", "a/theirs.md": "T" });
	});
});

describe("how a path is spelled when it is sent", () => {
	const nfc = "café";
	const nfd = "café";

	test("an edited file of an NFD path stays that path, and a new file goes into the folder as the remote spells it", async () => {
		const h = await synced({ [`${nfd}/${nfd}.md`]: "A" });
		h.vault.put(`${nfc}/${nfc}.md`, "A2");
		h.vault.put(`${nfc}/${nfd}-new.md`, "N");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });

		expect(await h.remote()).toEqual({ [`${nfd}/${nfd}.md`]: "A2", [`${nfd}/${nfc}-new.md`]: "N" });
		await expectNothingToPull(h);
	});
});

describe("stopping a push", () => {
	test("before it starts", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		controller.abort();

		expect((await h.push({ signal: controller.signal })).outcome).toBe("cancelled");
		expect(h.backend.pushes).toBe(0);
	});

	test("while the vault is compared", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		h.vault.before = (op) => {
			if (op === "read") controller.abort();
		};

		expect((await h.push({ signal: controller.signal })).outcome).toBe("cancelled");
		expect(h.backend.pushes).toBe(0);
	});

	test("while the question is open: a yes sends nothing any more", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		h.answer = () => {
			controller.abort();
			return "proceed";
		};

		expect((await h.push({ signal: controller.signal })).outcome).toBe("cancelled");
		expect(h.backend.pushes).toBe(0);
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
	});

	test("while the question is open: the question closing as a no is a stop, not a no", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		h.answer = () => {
			controller.abort();
			return "cancel";
		};

		expect((await h.push({ signal: controller.signal })).outcome).toBe("cancelled");
		expect(h.asked).toHaveLength(1);
		expect(h.backend.pushes).toBe(0);
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
	});

	test("a remote that refuses to go on is a stop, not a failure", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		const backend = Object.create(h.backend) as TestBackend;
		backend.push = async () => {
			controller.abort();
			throw new BackendError("cancelled", "push: cancelled");
		};

		expect((await h.push({ signal: controller.signal, backend })).outcome).toBe("cancelled");
		expect(await h.remote()).toEqual({ "a.md": "A" });
	});

	test("once the remote has the commit, the push records it whatever the signal says", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		const controller = new AbortController();
		let reads = 0;
		h.vault.before = (op, path) => {
			// While the file is sent: the fake remote goes on to the end.
			if (op === "read" && path === "b.md" && ++reads === 2) controller.abort();
		};

		const result = await h.push({ signal: controller.signal });
		h.vault.before = undefined;

		expect(result.outcome).toBe("pushed");
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B" }));
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		await expectNothingToPull(h);
	});
});

describe("a sync: a pull, and then a push", () => {
	test("both halves in one run", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": "A from the Mac", "theirs.md": "T" });
		h.vault.put("b.md", "B from here");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 2 } });
		expect(push).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });
		expect(await h.remote()).toEqual({ "a.md": "A from the Mac", "b.md": "B from here", "theirs.md": "T" });
		expect(h.vault.snapshot()).toEqual(await h.remote());
		await expectNothingToPull(h);
	});

	test("no push after a pull the user declined", async () => {
		const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(files);
		// The Mac deletes six files, which the pull asks about.
		const head = h.backend.commit(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}.md`, null])));
		h.vault.put("mine.md", "M");
		h.pullAnswer = "cancel";

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("declined");
		expect(push).toBeNull();
		expect(h.backend.revision).toBe(head);
		expect(h.backend.pushes).toBe(0);
		expect(pushFollows(pull)).toBe(false);
	});

	test("no push after a pull that was stopped", async () => {
		const h = await synced({ "a.md": "A" });
		const head = h.backend.commit({ "b.md": "B", "c.md": "C" });
		h.vault.put("mine.md", "M");
		const controller = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") controller.abort();
		};

		const { pull, push } = await h.sync({ pull: { signal: controller.signal }, push: { signal: controller.signal } });

		expect(pull.outcome).toBe("cancelled");
		expect(push).toBeNull();
		expect(h.backend.revision).toBe(head);
	});

	test("no push after a pull that could not be carried out", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("mine.md", "M");
		const backend = Object.create(h.backend) as TestBackend;
		backend.list = async () => {
			throw new BackendError("unreachable", "offline");
		};

		await expect(h.sync({ pull: { backend } })).rejects.toMatchObject({ kind: "unreachable" });
		expect(h.backend.pushes).toBe(0);
	});

	test("after a pull that found a remote without commits, the push gives it its first", async () => {
		const h = harness();
		h.vault.put("mine.md", "M");

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("remote-empty");
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({ ".gitignore": "", "mine.md": "M" });
	});

	test("after a pull that put a file off, the push sends the rest and keeps away from that file", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const base = await h.base();
		h.backend.commit({ "a.md": "A from the Mac" });
		// The pull cannot write `a.md`: its editor does not save.
		h.vault.openFailing("a.md");
		h.vault.put("b.md", "B from here");

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("incomplete");
		expect(pathsToHold(pull)).toEqual(["a.md"]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 }, held: ["a.md"] });
		expect(await h.remote()).toEqual({ "a.md": "A from the Mac", "b.md": "B from here" });
		expect(h.vault.text("a.md")).toBe("A");
		// The pull is not done, so the base revision has not moved.
		expect(await h.base()).toBe(base);

		h.vault.close("a.md");
		expect((await h.sync()).pull).toMatchObject({ outcome: "completed", counts: { fetched: 1 } });
		expect(h.vault.snapshot()).toEqual(await h.remote());
		expect(await h.base()).toBe(h.backend.revision);
	});

	test("a file the pull put off is not sent, also when it is one a push would send", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A edited here");
		h.vault.put("b.md", "B2");
		const real = (await h.pull()) as PullResult;
		// As if the pull had put `a.md` off.
		const pull: PullResult = { ...real, outcome: "incomplete", deferred: [{ path: "a.md", reason: "changed-during-pull" }] };
		expect(pushFollows(pull)).toBe(true);

		const push = await h.push({ hold: pathsToHold(pull) });

		expect(push).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, held: ["a.md"] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2" });
	});
});

describe("what a pull leaves for the push that follows", () => {
	test("a note edited on both sides: the copy is sent as a new file, beside the note as the remote has it", async () => {
		const h = await synced({ "notes/k.md": "K", "b.md": "B" });
		h.backend.commit({ "notes/k.md": "K from the Mac" });
		h.vault.put("notes/k.md", "K from here");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { conflicts: 1 } });
		const copy = pull.conflicts[0]?.copyPath ?? "";
		expect(copy).toBe(conflictCopyPath("notes/k.md", "iPhone", new Date(h.now())));
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({ "notes/k.md": "K from the Mac", [copy]: "K from here", "b.md": "B" });
		await expectNothingToPull(h);
		// The copy is a file like any other from here on: no conflict comes of it.
		expect((await h.sync()).push).toMatchObject({ outcome: "nothing-to-push" });
	});

	test("the copy of a file a rule matches is sent while the file is on the remote; a new file beside it is not", async () => {
		const rules = "/drafts/\n*.png\n";
		const h = await synced({ "drafts/a.md": "A", "img.png": "P", ".gitignore": rules });
		h.backend.commit({ "drafts/a.md": "A from the Mac", "img.png": "P from the Mac" });
		h.vault.put("drafts/a.md", "A from here");
		h.vault.put("img.png", "P from here");
		h.vault.put("drafts/new.md", "N");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { conflicts: 2 } });
		const copies = Object.fromEntries(pull.conflicts.map((conflict) => [conflict.path, conflict.copyPath]));
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({
			"drafts/a.md": "A from the Mac",
			[copies["drafts/a.md"] ?? ""]: "A from here",
			"img.png": "P from the Mac",
			[copies["img.png"] ?? ""]: "P from here",
			".gitignore": rules,
		});
		expect(h.vault.text("drafts/new.md")).toBe("N");
	});

	test("the copies that gathered before this device ever pushed are listed by the first question, and sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" }, { firstPush: true });
		h.backend.commit({ "a.md": "A from the Mac" });
		h.vault.put("a.md", "A from here");
		const first = await h.pull();
		h.backend.commit({ "b.md": "B from the Mac" });
		h.vault.put("b.md", "B from here");
		const second = await h.pull();
		const copies = [first.conflicts[0]?.copyPath ?? "", second.conflicts[0]?.copyPath ?? ""];
		expect(h.backend.pushes).toBe(0);

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 0, deleted: 0 } });

		expect(h.asked).toMatchObject([{ firstPush: { added: [...copies].sort(), modified: [], deleted: [] } }]);
		expect(await h.remote()).toEqual({
			"a.md": "A from the Mac",
			"b.md": "B from the Mac",
			[copies[0] ?? ""]: "A from here",
			[copies[1] ?? ""]: "B from here",
		});
		await expectNothingToPull(h);
	});

	test("a file the remote deleted and this device edited stays, and is sent back", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });
		h.vault.put("a.md", "A edited here");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { deleted: 0, conflicts: 0 } });
		expect(h.vault.text("a.md")).toBe("A edited here");
		expect(h.vault.trashed).toEqual([]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A edited here", "b.md": "B" });
		await expectNothingToPull(h);
	});

	test("a push alone sends such a file back too, and the pull after it has nothing to do", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });
		h.vault.put("a.md", "A edited here");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });

		expect(await h.remote()).toEqual({ "a.md": "A edited here", "b.md": "B" });
		await expectNothingToPull(h);
	});

	test("the copy of a file a rule matches is not sent once the remote has deleted the file, and stays in the vault", async () => {
		const rules = "*.png\n";
		const h = await synced({ "img.png": "P", ".gitignore": rules });
		h.backend.commit({ "img.png": "P from the Mac" });
		h.vault.put("img.png", "P from here");
		const pull = await h.pull();
		const copy = pull.conflicts[0]?.copyPath ?? "";
		// The Mac deletes the image between the pull and the push.
		const head = h.backend.commit({ "img.png": null });

		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });

		expect(h.backend.revision).toBe(head);
		expect(await h.remote()).toEqual({ ".gitignore": rules });
		expect(h.vault.text(copy)).toBe("P from here");
	});

	test("a file the remote stopped tracking and this device edited stays, and is not sent back", async () => {
		const h = await synced({ "drafts/a.md": "A", "b.md": "B" });
		// On the Mac: `git rm --cached drafts/a.md`, and a rule for the folder.
		const head = h.backend.commit({ "drafts/a.md": null, ".gitignore": "/drafts/\n" });
		h.vault.put("drafts/a.md", "A edited here");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { deleted: 0, conflicts: 0 } });
		expect(push).toMatchObject({ outcome: "nothing-to-push" });
		expect(h.backend.revision).toBe(head);
		expect(h.vault.text("drafts/a.md")).toBe("A edited here");
		expect(h.vault.trashed).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "b.md": "B", ".gitignore": "/drafts/\n" }));

		// And it stays that way: the file is excluded like any other in the folder.
		h.vault.put("drafts/a.md", "A edited again");
		expect((await h.sync()).push).toMatchObject({ outcome: "nothing-to-push" });
		expect(h.backend.revision).toBe(head);
	});

	test("after a rewritten history, the files the user kept are sent back by the push", async () => {
		const h = await synced({ "a.md": "A1", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "c.md": "C" });
		await h.pull();
		// A force push that takes back the edit of `a.md` and drops `c.md`.
		h.backend.rewriteHistory({ "a.md": "A1", "b.md": "B", "d.md": "D" });
		h.pullAnswer = "keep-local";

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", rewritten: true, keptLocal: ["c.md", "a.md"] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C", "d.md": "D" });
		expect(h.vault.snapshot()).toEqual(await h.remote());
		expect(h.vault.trashed).toEqual([]);
		await expectNothingToPull(h);
	});
});

describe("a .gitignore that is not on the device", () => {
	test("a push to a remote that has commits sends nothing either: its rules are not known", async () => {
		const h = await synced({ ".gitignore": "private/\n", "a.md": "A" });
		h.vault.remove(".gitignore");
		h.vault.put("..gitignore.icloud", "");
		h.vault.put("private/x.md", "X");
		const head = h.backend.revision;

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "gitignore-unreadable" });

		expect(h.backend.revision).toBe(head);
	});
});

describe("the first push to a remote without commits", () => {
	/** A vault with notes, connected to a repository that was just created. */
	function fresh(files: Record<string, string>): Harness {
		const h = harness();
		for (const [path, content] of Object.entries(files)) h.vault.put(path, content);
		return h;
	}

	test("makes two revisions: the .gitignore alone, and the rest on top of it", async () => {
		const files = { ".gitignore": "private/\n", "a.md": "A", "notes/b.md": "B", "private/x.md": "X" };
		const h = fresh(files);
		const before = h.backend.revisionCount;

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 3, modified: 0, deleted: 0 } });
		expect(h.backend.revisionCount).toBe(before + 2);
		expect(await h.remote()).toEqual({ ".gitignore": "private/\n", "a.md": "A", "notes/b.md": "B" });
		expect(result.revision).toBe(h.backend.revision);
		expect(h.backend.lastDeviceName).toBe("iPhone");
		expect(h.vault.snapshot()).toEqual(files);
		await expectNothingToPull(h);
		expect((await h.push()).outcome).toBe("nothing-to-push");
	});

	test("asks first, naming everything that is sent and that the remote is empty; and only once", async () => {
		const h = fresh({ ".gitignore": "", "a.md": "A" });

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.asked).toEqual([
			{
				firstPush: { added: [".gitignore", "a.md"], modified: [], deleted: [] },
				remoteEmpty: true,
				deletions: null,
				largeFiles: null,
				recordCount: 0,
			},
		]);
		h.vault.put("b.md", "B");
		expect((await h.sync()).push).toMatchObject({ outcome: "pushed" });
		expect(h.asked).toHaveLength(1);
		expect(h.pullAsked).toEqual([]);
	});

	test("a no sends nothing, and makes no revision and no .gitignore", async () => {
		const h = fresh({ "a.md": "A" });
		h.answer = "cancel";

		expect((await h.push()).outcome).toBe("declined");

		expect(h.backend.revision).toBeNull();
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });
		expect(await h.base()).toBeNull();
		// Asked again by the next push.
		expect((await h.push()).outcome).toBe("declined");
		expect(h.asked).toHaveLength(2);
	});

	test("a vault without a .gitignore gets an empty one, which is the first revision", async () => {
		const h = fresh({ "a.md": "A" });

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 2 } });

		expect(h.vault.text(".gitignore")).toBe("");
		expect(await h.remote()).toEqual({ ".gitignore": "", "a.md": "A" });
		await expectNothingToPull(h);
	});

	test("a vault that holds the .gitignore alone is done with the first revision", async () => {
		const h = fresh({ ".gitignore": "x\n" });
		const before = h.backend.revisionCount;

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(result.revision).toBe(h.backend.revision);
		expect(h.backend.revisionCount).toBe(before + 1);
		expect(await h.remote()).toEqual({ ".gitignore": "x\n" });
		await expectNothingToPull(h);
		h.vault.put("a.md", "A");
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked).toHaveLength(1);
	});

	test("a vault with nothing to send makes no revision", async () => {
		const h = harness();
		expect((await h.push()).outcome).toBe("nothing-to-push");
		expect(h.backend.revision).toBeNull();
		expect(h.vault.snapshot()).toEqual({});
	});

	test("the first revision can only be made on the default branch: nothing is made on another", async () => {
		const h = fresh({ "a.md": "A" });
		h.backend.defaultBranch = "trunk";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pull-first", reason: "not-default-branch", defaultBranch: "trunk" });
		expect(h.backend.revision).toBeNull();
		expect(await h.base()).toBeNull();
	});

	test("another device made the first revision meanwhile: nothing is sent, and a pull comes first", async () => {
		const h = fresh({ "a.md": "A" });
		h.answer = () => {
			h.backend.commit({ "theirs.md": "T" });
			return "proceed";
		};

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "remote-moved" });

		expect(await h.remote()).toEqual({ "theirs.md": "T" });
		expect(await h.base()).toBeNull();
	});

	test("the rest fails after the first revision was made: the next push sends it, without asking again", async () => {
		const h = fresh({ ".gitignore": "", "a.md": "A" });
		h.backend.publishFault = "lost-request";

		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });

		expect(await h.remote()).toEqual({ ".gitignore": "" });
		expect(await h.base()).toBe(h.backend.revision);
		h.backend.publishFault = null;
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		expect(await h.remote()).toEqual({ ".gitignore": "", "a.md": "A" });
		await expectNothingToPull(h);
	});

	test("the answer to the first revision is lost: the next push asks for a pull, which finds the .gitignore the same", async () => {
		const h = fresh({ ".gitignore": "x\n", "a.md": "A" });
		h.backend.startFault = true;

		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });

		h.backend.startFault = false;
		expect(await h.remote()).toEqual({ ".gitignore": "x\n" });
		expect(await h.base()).toBeNull();
		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "no-base" });
		const { pull, push } = await h.sync();
		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		expect(await h.remote()).toEqual({ ".gitignore": "x\n", "a.md": "A" });
		expect(h.vault.trashed).toEqual([]);
	});

	test("no empty .gitignore is left in the vault when the remote did not take it", async () => {
		const h = fresh({ "a.md": "A" });
		h.answer = () => {
			h.backend.commit({ ".gitignore": "private/\n", "theirs.md": "T" });
			return "proceed";
		};
		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "remote-moved" });
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });

		const other = fresh({ "a.md": "A" });
		other.backend.defaultBranch = "trunk";
		expect(await other.push()).toMatchObject({ outcome: "pull-first", reason: "not-default-branch" });
		expect(other.vault.snapshot()).toEqual({ "a.md": "A" });
	});

	test("a .gitignore a cloud drive has taken off the device: nothing is sent, and no empty one is made beside it", async () => {
		const files = { "..gitignore.icloud": "", "a.md": "A", "private/x.md": "X" };
		const h = fresh(files);

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "gitignore-unreadable" });

		expect(h.asked).toEqual([]);
		expect(h.backend.revision).toBeNull();
		expect(h.vault.snapshot()).toEqual(files);
	});

	test("a .gitignore spelled in another case, where the cases are told apart: nothing is sent", async () => {
		const h = harness({ caseSensitive: true });
		h.vault.put(".GITIGNORE", "private/\n");
		h.vault.put("a.md", "A");

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "gitignore-unreadable" });

		expect(h.asked).toEqual([]);
		expect(h.backend.revision).toBeNull();
		expect(h.vault.snapshot()).toEqual({ ".GITIGNORE": "private/\n", "a.md": "A" });
	});

	test("a sync asks once about a vault that has files: the pull has nothing to ask of an empty remote", async () => {
		const h = fresh({ "a.md": "A" });

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("remote-empty");
		expect(push).toMatchObject({ outcome: "pushed" });
		expect(h.pullAsked).toEqual([]);
		expect(h.asked).toMatchObject([{ firstPush: { added: ["a.md"] }, remoteEmpty: true }]);
	});

	test("the question a first fetch would have asked is asked here, though a push has gone through before", async () => {
		const h = fresh({ "a.md": "A" });
		// A push is remembered, and no first fetch: not what a sync leaves
		// behind, and still nothing goes to an empty repository unasked.
		await h.store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
		h.answer = "cancel";

		expect((await h.push()).outcome).toBe("declined");

		expect(h.asked).toMatchObject([{ firstPush: { added: ["a.md"] }, remoteEmpty: true }]);
		expect(h.backend.revision).toBeNull();
	});
});

describe("a push that did not get to its end is remembered", () => {
	/** A remote that cannot be reached. */
	function offline(h: Harness): TestBackend {
		const backend = Object.create(h.backend) as TestBackend;
		backend.list = async () => {
			throw new BackendError("unreachable", "offline");
		};
		return backend;
	}

	test("a push that fails leaves the time it began, and the next one that goes through takes it away", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		expect(await readPushFailure(h.store)).toBeNull();

		await expect(h.push({ backend: offline(h) })).rejects.toMatchObject({ kind: "unreachable" });

		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
		// Nothing is asked of the remote, and nothing is sent, until the user syncs.
		expect(h.backend.pushes).toBe(0);

		expect((await h.push()).outcome).toBe("pushed");
		expect(await h.store.getMeta(PUSH_FAILURE_KEY)).toBeUndefined();
	});

	test("it goes away too when there is nothing left to send", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		await expect(h.push({ backend: offline(h) })).rejects.toMatchObject({ kind: "unreachable" });
		h.vault.put("a.md", "A");

		expect((await h.push()).outcome).toBe("nothing-to-push");

		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a push that fails after it found the one before to have gone through is still remembered", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.vault.put("a.md", "A3");
		h.backend.publishFault = "lost-request";

		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });

		expect(await h.remote()).toEqual({ "a.md": "A2" });
		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
	});

	test("a remote without commits that nothing can be sent to is none: no later push would take it away", async () => {
		const h = harness();
		h.vault.put("mine.md", "M");
		h.backend.defaultBranch = "trunk";

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "not-default-branch" });
		expect(await readPushFailure(h.store)).toBeNull();
		expect((await h.sync()).push).toMatchObject({ outcome: "pull-first", reason: "not-default-branch" });
		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a push that has to wait for a pull is one too: nothing was sent", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("mine.md", "M");

		expect(await h.push()).toMatchObject({ outcome: "pull-first", reason: "no-base" });

		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
	});

	test("a no and a stop are the user's: neither leaves it, and neither takes away what a failure left", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.put("a.md", "A2");
		h.answer = "cancel";
		expect((await h.push()).outcome).toBe("declined");
		expect(await readPushFailure(h.store)).toBeNull();
		const stopped = new AbortController();
		stopped.abort();
		expect((await h.push({ signal: stopped.signal })).outcome).toBe("cancelled");
		expect(await readPushFailure(h.store)).toBeNull();

		await expect(h.push({ backend: offline(h) })).rejects.toMatchObject({ kind: "unreachable" });
		const failure = { at: h.now() };
		expect((await h.push()).outcome).toBe("declined");
		expect(await readPushFailure(h.store)).toEqual(failure);
		expect((await h.push({ signal: stopped.signal })).outcome).toBe("cancelled");
		expect(await readPushFailure(h.store)).toEqual(failure);
	});

	test("the app is closed under the push: it is found when the app starts again", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		const before = h.backend.revision;
		// Killed after the push has noted that it began.
		h.crash.after(1);

		await expect(h.push()).rejects.toThrow("the app is gone");
		h.crash.revive();
		expect(h.backend.revision).toBe(before);

		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
	});

	test("the answer was lost and the push had gone through: the pull that finds that out takes it away", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		expect(await readPushFailure(h.store)).not.toBeNull();

		expect(await h.pull()).toMatchObject({ outcome: "completed", recoveredPush: { modified: 1 } });

		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a sync whose pull fails made no push, and is remembered as one; not when it was stopped", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "A2");

		await expect(h.sync({ pull: { backend: offline(h) } })).rejects.toMatchObject({ kind: "unreachable" });
		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
		expect((await h.sync()).push).toMatchObject({ outcome: "pushed" });
		expect(await readPushFailure(h.store)).toBeNull();

		const stopped = new AbortController();
		stopped.abort();
		expect((await h.sync({ pull: { signal: stopped.signal }, push: { signal: stopped.signal } })).push).toBeNull();
		expect(await readPushFailure(h.store)).toBeNull();

		// A pull alone is no push that failed.
		await expect(h.pull({ backend: offline(h) })).rejects.toMatchObject({ kind: "unreachable" });
		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a value that cannot be read is no failure", async () => {
		const h = await synced({ "a.md": "A" });
		await h.store.setMeta(PUSH_FAILURE_KEY, { at: "yesterday" });
		expect(await readPushFailure(h.store)).toBeNull();
	});
});

describe("a copy that is itself in conflict", () => {
	test("its content goes to the same name with a number, and is sent though the first file is gone from the remote", async () => {
		const rules = "*.png\n";
		const h = await synced({ "img.png": "P", ".gitignore": rules });
		h.backend.commit({ "img.png": "P from the Mac" });
		h.vault.put("img.png", "P from here");
		const first = (await h.sync()).pull.conflicts[0]?.copyPath ?? "";
		expect(await h.remote()).toMatchObject({ [first]: "P from here" });

		// The Mac deletes the image and edits the copy; so does this device.
		h.backend.commit({ "img.png": null, [first]: "copy edited on the Mac" });
		h.vault.put(first, "copy edited here");

		const { pull, push } = await h.sync();

		const second = first.replace(/\.png$/, "-2.png");
		expect(pull).toMatchObject({ outcome: "completed", conflicts: [{ path: first, copyPath: second }] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({
			[first]: "copy edited on the Mac",
			[second]: "copy edited here",
			".gitignore": rules,
		});
		await expectNothingToPull(h);
	});
});

describe("a kept file that a rule excludes", () => {
	test("dropped by a rewritten history: it stays here, the pull says that it is not sent back, and no push sends it", async () => {
		const rules = "/drafts/\n";
		const h = await synced({ "a.md": "A1", ".gitignore": rules });
		// Tracked though the rule matches it, as after a `git add -f`.
		h.backend.commit({ "a.md": "A2", "drafts/c.md": "C", "c.md": "C" });
		await h.pull();
		const head = h.backend.rewriteHistory({ "a.md": "A1", ".gitignore": rules });
		h.pullAnswer = "keep-local";

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", rewritten: true, keptUnsent: ["drafts/c.md"] });
		expect([...pull.keptLocal].sort()).toEqual(["a.md", "c.md", "drafts/c.md"]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", "c.md": "C", ".gitignore": rules });
		expect(h.vault.text("drafts/c.md")).toBe("C");
		expect(h.vault.trashed).toEqual([]);

		expect((await h.sync()).push).toMatchObject({ outcome: "nothing-to-push" });
		expect(h.backend.revision).not.toBe(head);
		expect(h.vault.text("drafts/c.md")).toBe("C");
	});

	test("written back by a rewritten history: the remote still holds the path, so it is sent as any edit", async () => {
		const rules = "/drafts/\n";
		const h = await synced({ "drafts/c.md": "C1", ".gitignore": rules });
		h.backend.commit({ "drafts/c.md": "C2" });
		await h.pull();
		h.backend.rewriteHistory({ "drafts/c.md": "C1", ".gitignore": rules });
		h.pullAnswer = "keep-local";

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", keptLocal: ["drafts/c.md"], keptUnsent: [] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "drafts/c.md": "C2", ".gitignore": rules });
	});
});

describe("a file a cloud drive has taken off the device", () => {
	const files = { "notes/big.md": "BIG", "a.md": "A" };
	/** `notes/big.md` is evicted: its placeholder is all the folder lists. */
	async function evicted(): Promise<Harness> {
		const h = await synced(files);
		h.vault.remove("notes/big.md");
		h.vault.put("notes/.big.md.icloud", "a placeholder");
		return h;
	}
	const local = { "a.md": "A", "notes/.big.md.icloud": "a placeholder" };

	test("is not deleted on the remote by a push, and a pull changes nothing", async () => {
		const h = await evicted();

		const pushed = await h.push();

		expect(pushed).toMatchObject({ outcome: "nothing-to-push", held: [], leftOut: [] });
		expect(h.asked).toEqual([]);
		expect(await h.remote()).toEqual(files);
		expect(await h.records()).toEqual(hashes(files));

		h.vault.log.length = 0;
		const pulled = await h.pull();
		expect(pulled).toMatchObject({
			outcome: "completed",
			counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
			deferred: [],
		});
		expect(h.vault.snapshot()).toEqual(local);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes(files));

		// What else changed is sent as usual.
		h.vault.put("a.md", "A2");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ ...files, "a.md": "A2" });
	});

	test("what the remote changed is not written over the placeholder: the pull stays incomplete until the file is back", async () => {
		const h = await evicted();
		const base = await h.base();
		h.backend.commit({ "notes/big.md": "BIG from the Mac", "a.md": "A from the Mac" });

		const pulled = await h.pull();

		expect(pulled).toMatchObject({
			outcome: "incomplete",
			counts: { fetched: 1, conflicts: 0 },
			deferred: [{ path: "notes/big.md", reason: "not-downloaded" }],
		});
		expect(h.vault.snapshot()).toEqual({ ...local, "a.md": "A from the Mac" });
		expect(await h.base()).toBe(base);
		// And the push after it keeps away from the file too.
		expect((await h.push()).outcome).toBe("nothing-to-push");
		expect(h.backend.read("notes/big.md")).toEqual(new TextEncoder().encode("BIG from the Mac"));

		// The cloud drive brings the file back, as it was.
		h.vault.remove("notes/.big.md.icloud");
		h.vault.put("notes/big.md", "BIG");
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 1, conflicts: 0 } });
		expect(h.vault.text("notes/big.md")).toBe("BIG from the Mac");
		expect(await h.base()).toBe(h.backend.revision);
	});

	test("what the remote deleted is not deleted either while only the placeholder is there", async () => {
		const h = await evicted();
		h.backend.commit({ "notes/big.md": null });

		const pulled = await h.pull();

		expect(pulled.outcome).toBe("incomplete");
		expect(h.vault.snapshot()).toEqual(local);
		expect(await h.records()).toEqual(hashes(files));
	});

	test("in a sync, the push after a pull that put the file off says nothing of it, every time", async () => {
		const h = await evicted();
		h.backend.commit({ "notes/big.md": "BIG from the Mac" });
		h.vault.put("new.md", "N");

		const first = await h.sync();

		expect(first.pull).toMatchObject({
			outcome: "incomplete",
			deferred: [{ path: "notes/big.md", reason: "not-downloaded" }],
		});
		// Handed to the push to leave alone, and not told as held for that.
		expect(pathsToHold(first.pull)).toEqual(["notes/big.md"]);
		expect(first.push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 }, held: [], leftOut: [] });

		const second = await h.sync();
		expect(second.pull.deferred).toEqual([{ path: "notes/big.md", reason: "not-downloaded" }]);
		expect(second.push).toMatchObject({ outcome: "nothing-to-push", held: [], leftOut: [] });
		expect(await h.remote()).toEqual({ "notes/big.md": "BIG from the Mac", "a.md": "A", "new.md": "N" });
		expect(h.vault.snapshot()).toEqual({ ...local, "new.md": "N" });
	});

	test("a path a push is handed to leave alone is told as held, unless it is a placeholder", async () => {
		const h = await evicted();
		h.vault.put("a.md", "A2");

		const push = await h.push({ hold: ["notes/big.md", "a.md"] });

		expect(push).toMatchObject({ outcome: "nothing-to-push", held: ["a.md"], leftOut: [] });
		expect(await h.remote()).toEqual(files);
	});

	test("a pull that is declined has not put the file off", async () => {
		const h = await evicted();
		const base = await h.base();
		// A rewritten history that takes a file away is asked about.
		h.backend.rewriteHistory({ "notes/big.md": "BIG from the Mac" });
		h.pullAnswer = "cancel";
		h.vault.log.length = 0;

		const declined = await h.pull();

		expect(h.pullAsked).toHaveLength(1);
		expect(declined).toMatchObject({ outcome: "declined", deferred: [] });
		expect(h.vault.snapshot()).toEqual(local);
		expect(h.vault.log).toEqual([]);
		expect(await h.base()).toBe(base);

		// Let go on, it is put off as before.
		h.pullAnswer = "proceed";
		expect(await h.pull()).toMatchObject({
			outcome: "incomplete",
			deferred: [{ path: "notes/big.md", reason: "not-downloaded" }],
		});
		expect(h.vault.snapshot()).toEqual({ "notes/.big.md.icloud": "a placeholder" });
	});

	test("on a first fetch, with no record of it: put off, the rest is fetched, and no base is written", async () => {
		const h = harness();
		h.backend.commit({ ...files, "notes/b.md": "B" });
		h.vault.put("notes/.big.md.icloud", "a placeholder");

		const pulled = await h.pull();

		expect(pulled).toMatchObject({
			outcome: "incomplete",
			counts: { fetched: 2, deleted: 0, renamed: 0, conflicts: 0 },
			conflicts: [],
			deferred: [{ path: "notes/big.md", reason: "not-downloaded" }],
		});
		// Nothing was written at its path, and its placeholder is as it was.
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "notes/b.md": "B", "notes/.big.md.icloud": "a placeholder" });
		expect(h.vault.log.filter((line) => line.includes("big.md"))).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "notes/b.md": "B" }));
		expect(await h.base()).toBeNull();

		// Downloaded, with the content of the remote: the first fetch gets to its end.
		h.vault.remove("notes/.big.md.icloud");
		h.vault.put("notes/big.md", "BIG");
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { conflicts: 0 }, deferred: [] });
		expect(await h.base()).toBe(h.backend.revision);
	});

	test("a new file that was never synced is told with its path, by every push until it is back", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("notes/.new.md.icloud", "a placeholder");

		const first = await h.push();

		// Not "up to date": a file of this device has not reached the remote.
		expect(first).toMatchObject({
			outcome: "nothing-to-push",
			held: [],
			leftOut: [{ path: "notes/new.md", reason: "not-downloaded" }],
		});
		expect(await h.remote()).toEqual({ "a.md": "A" });
		// With other files to send, too.
		h.vault.put("b.md", "B");
		expect(await h.push()).toMatchObject({
			outcome: "pushed",
			counts: { added: 1, modified: 0, deleted: 0 },
			leftOut: [{ path: "notes/new.md", reason: "not-downloaded" }],
		});

		// The cloud drive brings the file back: it is sent.
		h.vault.remove("notes/.new.md.icloud");
		h.vault.put("notes/new.md", "N");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1 }, leftOut: [] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B", "notes/new.md": "N" });
	});

	test("one with a record stays quiet beside a new one, and so does one the remote has a file for", async () => {
		const h = await evicted();
		h.vault.put("notes/.new.md.icloud", "a placeholder");
		// Not pulled yet: nothing is recorded for it, but it is no file to add.
		h.backend.commit({ "notes/theirs.md": "T" });
		h.vault.put("notes/.theirs.md.icloud", "a placeholder");

		const pushed = await h.push();

		expect(pushed).toMatchObject({
			outcome: "nothing-to-push",
			held: [],
			leftOut: [{ path: "notes/new.md", reason: "not-downloaded" }],
		});
	});

	test("a file whose name only ends in .icloud, or only starts with a dot, is a file like any other", async () => {
		const others = { "notes/x.icloud": "I", ".hidden": "H", "notes/.dot.md": "D", "keep.md": "K" };
		const h = await synced(others);
		expect(h.vault.snapshot()).toEqual(others);
		h.vault.put("notes/x.icloud", "I2");
		h.vault.remove(".hidden");
		h.vault.remove("notes/.dot.md");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 2 }, held: [] });
		expect(await h.remote()).toEqual({ "notes/x.icloud": "I2", "keep.md": "K" });
	});
});

describe("a file that cannot be read while the vault is compared", () => {
	function unreadable(h: Harness, bad: string): void {
		h.vault.before = (op, path) => {
			if (op === "read" && path === bad) throw new Error("EIO");
		};
	}

	test("a push leaves it out and says so, sends the rest, and deletes nothing for it", async () => {
		const h = await synced({ "bad.md": "B", "ok.md": "O", "old.md": "X" });
		h.vault.put("bad.md", "B2");
		h.vault.put("ok.md", "O2");
		h.vault.remove("old.md");
		unreadable(h, "bad.md");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 1 },
			leftOut: [{ path: "bad.md", reason: "unreadable" }],
			held: [],
		});
		expect(await h.remote()).toEqual({ "bad.md": "B", "ok.md": "O2" });
		expect((await h.records())["bad.md"]).toBe(blobHash("B"));

		// Readable again, it is sent.
		h.vault.before = undefined;
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, leftOut: [] });
	});

	test("a pull does not fail: it leaves the file as it is, pulls the rest, and ends incomplete", async () => {
		const h = await synced({ "bad.md": "B", "ok.md": "O" });
		const base = await h.base();
		h.vault.put("bad.md", "B2");
		h.backend.commit({ "bad.md": "B from the Mac", "ok.md": "O from the Mac" });
		unreadable(h, "bad.md");
		h.vault.log.length = 0;

		const result = await h.pull();

		expect(result).toMatchObject({
			outcome: "incomplete",
			counts: { fetched: 1, deleted: 0, conflicts: 0 },
			deferred: [{ path: "bad.md", reason: "unreadable" }],
		});
		expect(h.vault.snapshot()).toEqual({ "bad.md": "B2", "ok.md": "O from the Mac" });
		expect(h.vault.log.filter((line) => line.includes("bad.md"))).toEqual([]);
		expect((await h.records())["bad.md"]).toBe(blobHash("B"));
		expect(await h.base()).toBe(base);

		// Readable again: the conflict it always was.
		h.vault.before = undefined;
		const again = await h.pull();
		expect(again).toMatchObject({ outcome: "completed", counts: { conflicts: 1 } });
		expect(h.vault.text("bad.md")).toBe("B from the Mac");
		expect(await h.base()).toBe(h.backend.revision);
	});

	test("in a sync, the push after such a pull keeps away from the file", async () => {
		const h = await synced({ "bad.md": "B", "ok.md": "O" });
		h.vault.put("bad.md", "B2");
		h.vault.put("new.md", "N");
		unreadable(h, "bad.md");

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("incomplete");
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({ "bad.md": "B", "ok.md": "O", "new.md": "N" });
	});
});

describe("the listing a push leaves behind", () => {
	test("is the one the remote gives for the new revision", async () => {
		const h = await synced({ "a.md": "A", "old.md": "O" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B");
		h.vault.remove("old.md");

		const result = await h.push();

		expect(result.storedOtherwise).toEqual([]);
		const stored = await h.store.getListing();
		const fresh = await h.backend.list(null);
		if (!fresh.changed) throw new Error("expected a listing");
		expect(stored).toEqual(fresh.listing);
	});

	test("when the remote cannot give it, none is kept: the next sync lists again, and finds nothing to do", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("b.md", "B");
		h.backend.listingFault = true;
		const logged: string[] = [];

		const result = await h.push({ log: (line) => logged.push(line) });

		expect(result).toMatchObject({ outcome: "pushed", storedOtherwise: [] });
		expect(await h.store.getListing()).toBeNull();
		expect(logged.length).toBe(1);
		h.backend.listings = 0;
		const pulled = await h.pull();
		expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
		expect(h.backend.listings).toBe(1);
		expect(await h.records()).toEqual(hashes(await h.remote()));
	});

	test("a remote that is not as it was listed refuses the push; the listing is dropped, and the next push is planned from a new one", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		// The remote holds other content than the listing of its head says.
		h.backend.amend({ "a.md": "A as the remote stored it" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B2");

		await expect(h.push()).rejects.toMatchObject({ kind: "not-as-listed" });

		expect(await h.store.getListing()).toBeNull();
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(h.backend.read("b.md")).toEqual(new TextEncoder().encode("B"));

		// Listed again: the file is a conflict for a pull now, and the rest goes.
		h.backend.listings = 0;
		const result = await h.push();
		expect(h.backend.listings).toBe(1);
		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A as the remote stored it", "b.md": "B2" });
	});
});

describe("the question before a large file is sent", () => {
	const large = (fill: number): Uint8Array => new Uint8Array(LARGE_FILE_BYTES + 1).fill(fill);

	test("names the file and its size; a no sends nothing, and a yes is asked once", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("video.mov", large(1));
		h.vault.put("small.md", "S");
		h.answer = "cancel";

		const declined = await h.push();

		expect(declined.outcome).toBe("declined");
		expect(h.asked).toEqual([
			{
				firstPush: null,
				deletions: null,
				largeFiles: [{ path: "video.mov", size: LARGE_FILE_BYTES + 1, conflictCopy: false }],
				remoteEmpty: false, recordCount: 1,
			},
		]);
		expect(h.backend.pushes).toBe(0);
		expect(await h.store.getMeta(APPROVED_LARGE_FILES_KEY)).toBeUndefined();

		// Asked again, and sent on a yes.
		h.answer = "proceed";
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 2 } });
		expect(h.asked.length).toBe(2);
		expect(await h.store.getMeta(APPROVED_LARGE_FILES_KEY)).toEqual([blobHash(large(1))]);
	});

	test("a file of exactly the size is not asked about", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("video.mov", new Uint8Array(LARGE_FILE_BYTES).fill(1));
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked).toEqual([]);
	});

	test("the same content is not asked about again, also when the push it was said to failed; changed content is", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("video.mov", large(1));
		h.backend.publishFault = "lost-request";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		expect(h.asked.length).toBe(1);
		h.backend.publishFault = null;

		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(1);

		// Another content, also at the same path.
		h.vault.put("video.mov", large(2));
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(2);
		expect(h.asked[1]?.largeFiles).toEqual([{ path: "video.mov", size: LARGE_FILE_BYTES + 1, conflictCopy: false }]);

		// And back to the first: that was said yes to.
		h.vault.put("video.mov", large(1));
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked.length).toBe(2);
	});

	test("content the remote already holds is not asked about: a large file that was moved", async () => {
		const h = await synced({ "media/video.mov": large(3), "a.md": "A" });
		h.vault.remove("media/video.mov");
		h.vault.put("archive/video.mov", large(3));

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, deleted: 1 } });
		expect(h.asked).toEqual([]);
	});

	test("with the first push, and with too many deletions, it is one question about all", async () => {
		const notes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(notes, { firstPush: true });
		const gone = ["n0.md", "n1.md", "n2.md", "n3.md", "n4.md", "n5.md"];
		for (const path of gone) h.vault.remove(path);
		h.vault.put("video.mov", large(4));

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.asked).toEqual([
			{
				firstPush: { added: ["video.mov"], modified: [], deleted: gone },
				deletions: gone,
				largeFiles: [{ path: "video.mov", size: LARGE_FILE_BYTES + 1, conflictCopy: false }],
				remoteEmpty: false, recordCount: 10,
			},
		]);
	});

	test("a copy kept from a conflict is marked: no rule keeps it from being sent", async () => {
		const h = await synced({ "video.mov": "V" });
		const copy = conflictCopyPath("video.mov", "iPhone", new Date(h.now()));
		h.vault.put(copy, large(5));
		h.answer = "cancel";

		await h.push();

		expect(h.asked[0]?.largeFiles).toEqual([{ path: copy, size: LARGE_FILE_BYTES + 1, conflictCopy: true }]);
	});

	test("a file over the size limit is skipped as before, and not asked about", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("huge.mov", large(6));
		h.vault.put("b.md", "B");

		const result = await h.push({ sizeLimit: LARGE_FILE_BYTES });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1 }, notices: [{ kind: "too-large", path: "huge.mov" }] });
		expect(h.asked).toEqual([]);
	});
});

describe("what a push that was declined has not told", () => {
	test("a notice is not used up by a push the user said no to: the push that goes on tells it, once", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true, firstPush: true });
		h.vault.put("case.md", "c");
		h.vault.put("new.md", "N");
		h.answer = "cancel";

		const declined = await h.push();

		expect(declined).toMatchObject({ outcome: "declined", notices: [], refused: [{ path: "case.md", reason: "case-collision" }] });
		expect(await readNotices(h.store)).toEqual([]);

		h.answer = "proceed";
		const pushed = await h.push();
		expect(pushed.outcome).toBe("pushed");
		expect(pushed.notices).toEqual([{ kind: "local-path-collision", path: "case.md" }]);
		h.vault.put("more.md", "M");
		expect((await h.push()).notices).toEqual([]);
	});

	test("nor by one that is stopped while the question is open", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true, firstPush: true });
		h.vault.put("case.md", "c");
		h.vault.put("new.md", "N");
		const controller = new AbortController();
		h.answer = () => {
			controller.abort();
			return "proceed";
		};

		expect(await h.push({ signal: controller.signal })).toMatchObject({ outcome: "cancelled", notices: [] });
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("nor by one that fails while it sends: the next push tells it", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true });
		h.vault.put("case.md", "c");
		h.vault.put("new.md", "N");
		const backend = Object.create(h.backend) as TestBackend;
		backend.push = async () => {
			throw new BackendError("unreachable", "offline");
		};

		await expect(h.push({ backend })).rejects.toMatchObject({ kind: "unreachable" });
		expect(await readNotices(h.store)).toEqual([]);

		const pushed = await h.push();
		expect(pushed.outcome).toBe("pushed");
		expect(pushed.notices).toEqual([{ kind: "local-path-collision", path: "case.md" }]);
		h.vault.put("more.md", "M");
		expect((await h.push()).notices).toEqual([]);
	});

	test("one the remote turned away, because it had moved, has told it", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true });
		h.vault.put("case.md", "c");
		h.vault.put("new.md", "N");
		const backend = Object.create(h.backend) as TestBackend;
		backend.push = async () => ({ status: "stale" });

		const stale = await h.push({ backend });

		expect(stale).toMatchObject({
			outcome: "pull-first",
			reason: "remote-moved",
			notices: [{ kind: "local-path-collision", path: "case.md" }],
		});
		expect((await h.push()).notices).toEqual([]);
	});

	test("a push with nothing to send tells it all the same", async () => {
		const h = await synced({ "Case.md": "C" }, { caseSensitive: true });
		h.vault.put("case.md", "c");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "nothing-to-push", notices: [{ kind: "local-path-collision", path: "case.md" }] });
	});
});

describe("what a push never turns into a deletion or an upload", () => {
	test("after a pull the user declined, a push alone neither deletes on the remote what the pull was to delete here, nor sends it back", async () => {
		const notes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(notes);
		const gone = ["n0.md", "n1.md", "n2.md", "n3.md", "n4.md", "n5.md"];
		h.backend.commit(Object.fromEntries(gone.map((path) => [path, null])));
		h.pullAnswer = "cancel";
		expect((await h.pull()).outcome).toBe("declined");
		const head = h.backend.revision;
		const left = await h.remote();
		expect(Object.keys(left).sort()).toEqual(["n6.md", "n7.md", "n8.md", "n9.md"]);

		const result = await h.push();

		expect(result.outcome).toBe("nothing-to-push");
		expect(h.asked).toEqual([]);
		expect(h.backend.revision).toBe(head);
		expect(h.vault.snapshot()).toEqual(notes);
		expect(await h.records()).toEqual(hashes(notes));

		// An edit of a file the remote kept is sent, and still nothing else.
		h.vault.put("n9.md", "edited");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ ...left, "n9.md": "edited" });
	});

	test("a path to hold that is spelled in another case, or another normalization, than the vault spells it", async () => {
		const h = await synced({ "notes/caf\u00e9.md": "C", "gone/a.md": "G", "b.md": "B" });
		h.vault.put("notes/caf\u00e9.md", "C2");
		h.vault.remove("gone/a.md");
		h.vault.put("b.md", "B2");

		const result = await h.push({ hold: ["NOTES/Cafe\u0301.md", "Gone/A.md"] });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(result.held).toEqual(["notes/caf\u00e9.md"]);
		expect(await h.remote()).toEqual({ "notes/caf\u00e9.md": "C", "gone/a.md": "G", "b.md": "B2" });
	});

	test("a path the pull would not write, because the remote holds it in two cases, is never deleted on the remote", async () => {
		// With a record from before the second spelling came.
		const h = await synced({ "a.md": "A", "keep.md": "K" });
		h.backend.commit({ "A.md": "another" });
		expect((await h.pull()).counts).toMatchObject({ fetched: 0, deleted: 0 });
		h.vault.remove("a.md");
		const remote = await h.remote();

		expect((await h.push()).outcome).toBe("nothing-to-push");
		expect(await h.remote()).toEqual(remote);
		expect((await h.records())["a.md"]).toBe(blobHash("A"));

		// And without one: neither was ever written.
		const fresh = harness();
		fresh.backend.commit({ "Case.md": "C", "case.md": "c", "ok.md": "O" });
		await fresh.pull();
		expect(fresh.vault.snapshot()).toEqual({ "ok.md": "O" });
		await fresh.store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
		expect((await fresh.push()).outcome).toBe("nothing-to-push");
		expect(await fresh.remote()).toEqual({ "Case.md": "C", "case.md": "c", "ok.md": "O" });
	});

	test("a file in .trash/ is not sent, while one the remote holds there stays synced", async () => {
		const h = await synced({ ".trash/kept.md": "K", "a.md": "A" });
		expect(h.vault.text(".trash/kept.md")).toBe("K");
		h.vault.put(".trash/kept.md", "K2");
		h.vault.put(".trash/x.md", "X");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ ".trash/kept.md": "K2", "a.md": "A" });
		// And deleted here, it is deleted there.
		h.vault.remove(".trash/kept.md");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });
		expect(await h.remote()).toEqual({ "a.md": "A" });
	});
});
