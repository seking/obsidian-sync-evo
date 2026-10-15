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
import { BackendError, type EntryKind, type ListResult, type PushRefusal, type RemoteListing } from "../src/core/backend";
import { conflictCopyPath, mergedCopyPath } from "../src/core/conflict-name";
import { readTidiedCopies, TIDIED_COPIES_KEY } from "../src/core/conflict-tidy";
import { createExclusion, defaultSectionLines } from "../src/core/exclusion";
import { GITIGNORE_WRITE_KEY } from "../src/core/gitignore-file";
import { SECTION_END, SECTION_START, withSection } from "../src/core/gitignore-section";
import { readNotices } from "../src/core/notices";
import type { PullAnswer, PullConfirmRequest, PullDeps, PullResult } from "../src/core/pull";
import { runPull } from "../src/core/pull";
import {
	type EmptyVaultAnswer,
	type EmptyVaultRequest,
	type PushAnswer,
	type PushConfirmRequest,
	type PushDeps,
	type PushProgress,
	type PushRunResult,
	runPush,
} from "../src/core/push";
import {
	FIRST_PUSH_CONFIRMED_KEY,
	PENDING_PUSH_KEY,
	readPendingPush,
} from "../src/core/push-pending";
import { translatorFor } from "../src/core/i18n";
import { PUSH_FAILURE_KEY, readPushFailure } from "../src/core/push-failure";
import { pushReport } from "../src/core/push-report";
import type { ListedStats } from "../src/core/listed-stats";
import { type FileStat, makeMarker, readBaseRevision, type StateStore } from "../src/core/state";
import { pathsToHold, pathsToHoldQuietly, pushFollows, runSync, type SyncResult } from "../src/core/sync";
import { blobHash, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryIndex } from "./support/memory-index";
import { MemoryPullVault, type VaultOp } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";
import { listSubmodules, type TestSubmodule } from "./support/submodule-listing";
import { earlierCopyPath } from "./support/earlier-copy-name";
import { isTimingLine } from "./support/timing-lines";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** A remote a test can bend: symlinks and submodules, and a count of what it was asked. */
class TestBackend extends MemoryBackend {
	readonly kinds = new Map<string, EntryKind>();
	/** The submodules of a remote that lists what is inside them (`listSubmodules`). */
	readonly listed = new Map<string, TestSubmodule>();
	/** How many times the whole remote was listed, and not just found unchanged. */
	listings = 0;
	pushes = 0;
	/** Paths whose content the remote will not take because of its size. */
	readonly refusesForSize = new Set<string>();
	/** Whether the credentials lack the permission for workflow files. */
	refusesWorkflows = false;
	/**
	 * Paths another device changed first, with what it wrote, on a remote
	 * that writes file by file: a write is refused as "changed", and a
	 * delete is not made. What the other device wrote shows once the push
	 * has answered.
	 */
	readonly changedFirst = new Map<string, string>();
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

	override async list(known: RemoteListing | null): Promise<ListResult> {
		if (this.emptied) return { changed: true, listing: { revision: null, entries: [] } };
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		this.listings += 1;
		const entries = listed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { changed: true, listing: { revision: listed.listing.revision, entries: listSubmodules(entries, this.listed) } };
	}

	override async push(request: Parameters<MemoryBackend["push"]>[0]): ReturnType<MemoryBackend["push"]> {
		this.pushes += 1;
		// A refused file was read, and then not taken: the same as the
		// GitHub backend does with a blob that is too large for GitHub.
		const refusal = (path: string): PushRefusal | undefined =>
			this.refusesForSize.has(path)
				? "too-large"
				: this.refusesWorkflows && path.startsWith(".github/workflows/")
					? "workflows"
					: this.changedFirst.has(path)
						? "changed"
						: undefined;
		const writes = request.writes.map((file) => {
			const reason = refusal(file.path);
			return reason === undefined
				? file
				: {
						...file,
						read: async () => {
							if ((await file.read()) !== null) file.refused?.(reason);
							return null;
						},
					};
		});
		const kept = request.deletes.filter((entry) => this.changedFirst.has(entry.path));
		const deletes = request.deletes.filter((entry) => !this.changedFirst.has(entry.path));
		const made = await super.push({ ...request, writes, deletes });
		if (made.status !== "stale" && this.changedFirst.size > 0) {
			this.commit(Object.fromEntries(this.changedFirst));
			this.changedFirst.clear();
		}
		const pushed = kept.length === 0 || made.status === "stale" ? made : { ...made, kept };
		if (pushed.status !== "pushed" || pushed.listing === undefined) return pushed;
		const entries = pushed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { ...pushed, listing: { revision: pushed.listing.revision, entries: listSubmodules(entries, this.listed) } };
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
	/** Every time a push asked about a vault without its files. */
	readonly emptyAsked: EmptyVaultRequest[];
	emptyAnswer: EmptyVaultAnswer;
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
	const emptyAsked: EmptyVaultRequest[] = [];
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
		// Off, unlike in the app: the tests below are about what a push
		// sends, and each would otherwise also send a `.gitignore` with the
		// section in it. The tests of the section turn it on (`ADDING`).
		addSection: false,
		confirm: async (request) => {
			asked.push(request);
			return typeof h.answer === "function" ? h.answer() : h.answer;
		},
		askEmptyVault: async (request) => {
			emptyAsked.push(request);
			return h.emptyAnswer;
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
		emptyAsked,
		emptyAnswer: "delete",
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
	for (const [path, kind] of Object.entries(options.kinds ?? {})) h.backend.kinds.set(path, kind);
	// What the rules leave out was synced before they were there: a first
	// fetch under them would not fetch it. Its record is kept, as the record
	// of an excluded path is.
	const rules = createExclusion({ ...paths, gitignore: typeof files[".gitignore"] === "string" ? files[".gitignore"] : null });
	if (Object.keys(files).some((path) => rules.excludes(path, "file", { has: () => true }))) {
		h.backend.commit({ ...files, ".gitignore": withSection(null, []) });
		expect((await h.pull()).outcome).toBe("completed");
		h.backend.commit({ ".gitignore": null, ...files });
	} else {
		h.backend.commit(files);
	}
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
		// With a note that stays: the vault is not one without its files (`askEmptyVault`).
		const h = await synced({ ...files, "kept.md": "K" });
		for (const path of Object.keys(files)) h.vault.remove(path);
		h.vault.put("one.md", "");
		h.answer = "cancel";

		expect((await h.push()).outcome).toBe("declined");
		expect(h.emptyAsked).toEqual([]);
		expect(h.asked[0]?.deletions?.length).toBe(99);
	});
});

describe("a vault with none of the files that have a record", () => {
	const files = { ".gitignore": "x/\n", ".obsidian/app.json": "{}", "a.md": "A", "notes/b.md": "B" };
	/** The folder of the vault was deleted and made again: the app and Sync Evo have written their own files. */
	async function recreated(all: Record<string, FileContent> = files): Promise<Harness> {
		const h = await synced(all);
		for (const path of Object.keys(all)) {
			if (path !== ".gitignore" && !path.startsWith(".obsidian/")) h.vault.remove(path);
		}
		if (".obsidian/app.json" in all) h.vault.put(".obsidian/app.json", "{ }");
		return h;
	}
	const untouched = async (h: Harness, before: string | null, all: Record<string, FileContent> = files): Promise<void> => {
		expect(h.backend.revision).toBe(before);
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual(all);
		expect(await h.records()).toEqual(hashes(all as Record<string, string>));
	};

	test("two files gone, far below the threshold: the push stops and asks, with nothing else asked before", async () => {
		const h = await recreated();
		const before = h.backend.revision;
		h.emptyAnswer = "cancel";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "declined", revision: null });
		expect(result.refetch).toBeUndefined();
		expect(h.emptyAsked).toEqual([{ missing: 2, deletions: 2 }]);
		expect(h.asked).toEqual([]);
		await untouched(h, before);
		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("past the threshold too, this question comes first", async () => {
		const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n/${String(i).padStart(2, "0")}.md`, `note ${i}`]));
		const h = await recreated(many);
		const before = h.backend.revision;
		const order: string[] = [];

		const result = await h.push({
			askEmptyVault: async (request) => {
				order.push(`empty vault ${request.missing}`);
				return "cancel";
			},
			confirm: async () => {
				order.push("deletions");
				return "proceed";
			},
		});

		expect(result.outcome).toBe("declined");
		expect(order).toEqual(["empty vault 30"]);
		await untouched(h, before, many);
	});

	test("fetch again: nothing is sent, and the result says that the first fetch is to follow", async () => {
		const h = await recreated();
		const before = h.backend.revision;
		h.emptyAnswer = "refetch";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "declined", refetch: true, revision: null });
		expect(h.asked).toEqual([]);
		await untouched(h, before);
		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("delete on the remote too: the deletions are asked about however few, with what else the push sends", async () => {
		const h = await recreated();
		h.vault.put("new.md", "N");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 2 } });
		expect(h.emptyAsked).toEqual([{ missing: 2, deletions: 2 }]);
		expect(h.asked).toEqual([
			{
				firstPush: null,
				remoteEmpty: false,
				deletions: ["a.md", "notes/b.md"],
				recordCount: 4,
				alsoSent: { added: ["new.md"], modified: [".obsidian/app.json"] },
			},
		]);
		expect(await h.remote()).toEqual({ ".gitignore": "x/\n", ".obsidian/app.json": "{ }", "new.md": "N" });
		await expectNothingToPull(h);
	});

	test("delete on the remote too, and then a no to the deletions: nothing is sent", async () => {
		const h = await recreated();
		const before = h.backend.revision;
		h.answer = "cancel";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "declined", revision: null });
		expect(result.refetch).toBeUndefined();
		expect(h.asked).toHaveLength(1);
		await untouched(h, before);
	});

	test("before the first push, the one question that lists everything follows", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.remove("a.md");
		h.vault.put("new.md", "N");

		expect((await h.push()).outcome).toBe("pushed");

		expect(h.emptyAsked).toEqual([{ missing: 1, deletions: 1 }]);
		expect(h.asked).toEqual([
			{
				firstPush: { added: ["new.md"], modified: [], deleted: ["a.md"] },
				remoteEmpty: false,
				deletions: ["a.md"],
				recordCount: 1,
			},
		]);
	});

	test("no answer, as in a sync that started by itself: nothing is sent, and it is asked again", async () => {
		const h = await recreated();
		const before = h.backend.revision;
		h.emptyAnswer = "later";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "empty-vault", revision: null });
		expect(h.asked).toEqual([]);
		await untouched(h, before);
		expect(await readPushFailure(h.store)).toBeNull();
		expect(pushReport(translatorFor("en"), result, { sizeLimit: 50 * 1024 * 1024 }).summary).toBe(
			"None of the files synced before is on this device, which needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
		);

		expect((await h.push()).outcome).toBe("waiting");
		expect(h.emptyAsked).toHaveLength(2);
	});

	test("the question that was closed because the push was stopped is a stop", async () => {
		const h = await recreated();
		const controller = new AbortController();

		const result = await h.push({
			signal: controller.signal,
			askEmptyVault: async () => {
				controller.abort();
				return "cancel";
			},
		});

		expect(result.outcome).toBe("cancelled");
		expect(result.refetch).toBeUndefined();
	});

	test("some of the files gone: as ever, the threshold decides", async () => {
		const h = await synced(files);
		h.vault.remove("a.md");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });

		expect(h.emptyAsked).toEqual([]);
		expect(h.asked).toEqual([]);
	});

	test("a file a cloud drive has taken off the device is not gone", async () => {
		const h = await synced(files);
		h.vault.remove("a.md");
		h.vault.remove("notes/b.md");
		h.vault.put("notes/.b.md.icloud", "a placeholder");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });

		expect(h.emptyAsked).toEqual([]);
		expect(Object.keys(await h.remote()).sort()).toEqual([".gitignore", ".obsidian/app.json", "notes/b.md"]);
	});

	test("a vault whose records are of the configuration folder and the .gitignore alone is not asked", async () => {
		const settings = { ".gitignore": "x/\n", ".obsidian/app.json": "{}", ".obsidian/hotkeys.json": "{}" };
		const h = await synced(settings);
		h.vault.remove(".obsidian/hotkeys.json");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });

		expect(h.emptyAsked).toEqual([]);
		expect(h.asked).toEqual([]);
	});

	test("the one note of a vault under a new name is no vault without files", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.remove("a.md");
		h.vault.put("renamed.md", "A");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, deleted: 1 } });

		expect(h.emptyAsked).toEqual([]);
	});

	test("a new empty note in a vault that was made again, with an empty note among the records: asked all the same", async () => {
		const all = { ...files, "c.md": "C", "empty.md": "" };
		const h = await recreated(all);
		h.vault.put("Untitled.md", "");
		const before = h.backend.revision;
		h.emptyAnswer = "cancel";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "declined", revision: null });
		// The empty note is taken for moved, and is not among the files that are gone.
		expect(h.emptyAsked).toEqual([{ missing: 3, deletions: 4 }]);
		expect(h.asked).toEqual([]);
		await untouched(h, before, all);
	});

	test("a pull is not stopped by it: it leaves the vault as it is", async () => {
		const h = await recreated();

		expect((await h.pull()).outcome).toBe("completed");

		expect(h.pullAsked).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ".gitignore": "x/\n", ".obsidian/app.json": "{ }" });
	});
});

describe("conflict copies that have had their time", () => {
	// The harness starts at noon UTC on 2026-10-03: these are two months old.
	const old = Array.from({ length: 8 }, (_, i) => `_conflicts/2026-08-01 n${i} (Mac).md`);
	const notes = Array.from({ length: 12 }, (_, i) => `n/${String(i).padStart(2, "0")}.md`);
	const files = (): Record<string, string> =>
		Object.fromEntries([...old, ...notes].map((path) => [path, `content of ${path}`]));

	test("a first fetch leaves them where they are; the sync after it moves them to the trash and deletes them on the remote, without asking", async () => {
		const h = await synced(files());
		// Fetched a moment ago, by the first fetch, and not taken away by it.
		expect(h.vault.paths().filter((path) => path.startsWith("_conflicts/"))).toEqual(old);
		expect(h.vault.trashed).toEqual([]);

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
		expect([...pull.tidiedCopies].sort()).toEqual(old);
		expect(h.vault.trashed.map(({ path, mode }) => `${mode} ${path}`).sort()).toEqual(old.map((path) => `vault-trash ${path}`));
		// Eight of twenty would have asked.
		expect(h.asked).toEqual([]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 0, deleted: 8 } });
		expect(Object.keys(await h.remote()).sort()).toEqual(notes);
		// Sent, and nothing left to remember them for.
		expect(await h.store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
		await expectNothingToPull(h);
	});

	test("other deletions of the same push are still asked about, and the question does not list the copies", async () => {
		const h = await synced(files());
		for (const path of notes.slice(0, 6)) h.vault.remove(path);
		h.answer = "cancel";

		const { push } = await h.sync();

		expect(push).toMatchObject({ outcome: "declined" });
		expect(h.asked).toMatchObject([{ deletions: notes.slice(0, 6), recordCount: 20 }]);
		// Not sent, and still remembered for the push that sends them.
		expect((await readTidiedCopies(h.store)).sort()).toEqual(old);
		expect(Object.keys(await h.remote())).toHaveLength(20);

		h.answer = "proceed";
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: 14 } });
		expect(await h.store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
	});

	test("with what was tidied no longer remembered, the push counts them and asks: nothing is deleted unasked", async () => {
		const h = await synced(files());
		await h.pull();
		expect((await readTidiedCopies(h.store)).sort()).toEqual(old);
		// Lost to an earlier version that opened the sync state.
		await h.store.deleteMeta(TIDIED_COPIES_KEY);
		h.answer = "cancel";

		expect(await h.push()).toMatchObject({ outcome: "declined" });
		expect(h.asked).toMatchObject([{ deletions: old }]);
		expect(Object.keys(await h.remote())).toHaveLength(20);
	});

	test("a copy the user put back, and one the remote no longer holds, are forgotten; the first is not deleted", async () => {
		const h = await synced(files());
		await h.pull();
		const [back = "", gone = "", ...rest] = old;
		h.backend.commit({ [gone]: null });
		await h.pull();
		// After the pull, which would move it away again.
		h.vault.put(back, `content of ${back}`);

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { deleted: rest.length } });

		expect(h.asked).toEqual([]);
		expect(Object.keys(await h.remote()).sort()).toEqual([back, ...notes].sort());
		expect(await h.store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
		expect(h.vault.text(back)).toBe(`content of ${back}`);
	});

	test("a copy of the earlier form, however old, is sent like any file and never moved to the trash", async () => {
		const h = await synced({ "notes/a.md": "A" });
		const earlier = earlierCopyPath("notes/a.md", "iPhone", new Date(2026, 0, 2, 3, 4, 5));
		h.vault.put(earlier, "mine, from January");

		for (let round = 0; round < 2; round++) {
			const { pull } = await h.sync();
			expect(pull.tidiedCopies).toEqual([]);
		}

		expect(h.vault.trashed).toEqual([]);
		expect(h.vault.text(earlier)).toBe("mine, from January");
		expect(await h.remote()).toEqual({ "notes/a.md": "A", [earlier]: "mine, from January" });
	});

	test("a push alone tidies nothing", async () => {
		const h = await synced(files());
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
		expect(h.vault.trashed).toEqual([]);
		expect(Object.keys(await h.remote())).toHaveLength(20);
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

	test("on a remote that writes file by file, what another device changed first is neither written over nor deleted, and the rest is sent", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B", "c.md": "C" });
		h.vault.put("a.md", "A2");
		h.vault.remove("b.md");
		h.vault.remove("c.md");
		h.vault.put("d.md", "D");
		h.backend.changedFirst.set("a.md", "A, from another device").set("b.md", "B, from another device");

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 1, modified: 0, deleted: 1 },
			leftOut: [
				{ path: "a.md", reason: "remote-changed" },
				{ path: "b.md", reason: "remote-changed" },
			],
		});
		const records = await h.records();
		expect(records["a.md"]).toBe(blobHash("A"));
		expect(records["b.md"]).toBe(blobHash("B"));
		expect(records["c.md"]).toBeUndefined();
		expect(await readPushFailure(h.store)).toBeNull();

		// The next pull takes them up as conflicts: the change of this
		// device is kept beside the other one, and a change wins over a delete.
		const pulled = await h.pull();
		expect(pulled.counts).toMatchObject({ conflicts: 1 });
		expect(h.vault.text("a.md")).toBe("A, from another device");
		expect(h.vault.text("b.md")).toBe("B, from another device");
		expect(Object.values(h.vault.snapshot()).filter((text) => text === "A2")).toHaveLength(1);
	});

	test("on a remote that writes file by file, a push the remote took none of is told as such", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2");
		h.vault.remove("b.md");
		h.backend.changedFirst.set("a.md", "A, from another device").set("b.md", "B, from another device");

		expect(await h.push()).toMatchObject({
			outcome: "nothing-to-push",
			leftOut: [
				{ path: "a.md", reason: "remote-changed" },
				{ path: "b.md", reason: "remote-changed" },
			],
		});
		expect((await h.records())["b.md"]).toBe(blobHash("B"));
		// Asked once, and not again for the next push.
		expect(await h.store.getMeta("first-push-confirmed")).toBe(true);
	});

	test("a workflow file the token may not write is left out and told, the rest is sent, and it is sent once the token may", async () => {
		const h = await synced({ "a.md": "A", ".github/workflows/ci.yml": "old" });
		h.vault.put("a.md", "A2");
		h.vault.put(".github/workflows/ci.yml", "changed on this device");
		h.backend.refusesWorkflows = true;

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 0 },
			leftOut: [{ path: ".github/workflows/ci.yml", reason: "refused-workflows" }],
		});
		expect(await h.remote()).toEqual({ "a.md": "A2", ".github/workflows/ci.yml": "old" });
		expect((await h.records())[".github/workflows/ci.yml"]).toBe(blobHash("old"));
		expect(await readPushFailure(h.store)).toBeNull();
		// The change stays on this device, and a pull does not take it back.
		expect((await h.pull()).counts).toMatchObject({ fetched: 0, deleted: 0, conflicts: 0 });
		expect(h.vault.text(".github/workflows/ci.yml")).toBe("changed on this device");

		h.backend.refusesWorkflows = false;
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, leftOut: [] });
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

describe("a rename in case alone of a file a rule excludes", () => {
	test("sends neither the deletion nor the file: the rule matches both spellings", async () => {
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
			heldRenames: [],
			notices: [],
		});
		expect(await h.remote()).toEqual({ "drafts/a.md": "A", ".gitignore": "/drafts/\n", "keep.md": "K2" });
		expect((await h.records())["drafts/a.md"]).toBe(blobHash("A"));
	});
});

describe("the marks of an exclusion, as a push stores them", () => {
	const said = async (h: Harness): Promise<string[]> =>
		(await h.store.readRecords()).map((record) => `${record.path} ${record.wasExcluded === true}`).sort();

	/** In sync on a draft and a note; then this device adds a rule for the drafts, and edits the note. */
	async function ruled(): Promise<Harness> {
		const h = await synced({ ".gitignore": "", "drafts/a.md": "A", "n.md": "N" }, { firstPush: true });
		h.vault.put(".gitignore", "/drafts/\n");
		h.vault.put("n.md", "N2");
		return h;
	}

	test("set by a push that went through, and nothing of the excluded file is sent", async () => {
		const h = await ruled();
		h.vault.remove("drafts/a.md");
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 2, deleted: 0 } });
		expect(await said(h)).toEqual([".gitignore false", "drafts/a.md true", "n.md false"]);
		expect(Object.keys(await h.remote())).toContain("drafts/a.md");
	});

	test("set by a push that found nothing to send", async () => {
		const h = await synced({ ".gitignore": "/drafts/\n", "drafts/a.md": "A" });
		await h.store.commitWrite({ key: "drafts/a.md", path: "drafts/a.md", kind: "file", hash: blobHash("A") });
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
		expect(await said(h)).toEqual([".gitignore false", "drafts/a.md true"]);
	});

	test("not by a push that is declined, that waits for an answer, or that fails", async () => {
		for (const ending of ["cancel", "later", "fails"] as const) {
			const h = await ruled();
			const before = await said(h);
			h.answer = ending === "fails" ? "proceed" : ending;
			if (ending === "fails") {
				const backend = Object.create(h.backend) as TestBackend;
				backend.push = async () => {
					throw new BackendError("unreachable", "offline");
				};
				await expect(h.push({ backend })).rejects.toMatchObject({ kind: "unreachable" });
			} else {
				expect((await h.push()).outcome).toBe(ending === "cancel" ? "declined" : "waiting");
			}
			expect(await said(h)).toEqual(before);
		}
	});

	test("taken back, a record of a file the vault lost meanwhile goes, and the remote keeps the file", async () => {
		const h = await synced({ ".gitignore": "/drafts/\n", "drafts/a.md": "A", "n.md": "N" });
		await h.store.commitWrite({ key: "drafts/a.md", path: "drafts/a.md", kind: "file", hash: blobHash("A"), wasExcluded: true });
		h.vault.remove("drafts/a.md");
		h.vault.put(".gitignore", "");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1, deleted: 0 } });

		expect(await h.remote()).toEqual({ ".gitignore": "", "drafts/a.md": "A", "n.md": "N" });
		expect(await said(h)).toEqual([".gitignore false", "n.md false"]);
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
		const noteCopy = earlierCopyPath("notes/a.md", "iPhone", at);
		const settingsCopy = earlierCopyPath(".obsidian/app.json", "iPhone", at);
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
		const h = await synced({ "notes/a.md": "A" });
		const copy = conflictCopyPath("notes/a.md", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
		// The marker says which file the copy is of: its name does not.
		await h.store.putMarker(makeMarker(copy, null, blobHash("mine, in full"), true, "notes/a.md"));
		h.vault.put(copy, "mine, in");
		h.vault.put("notes/a.md", "mine, in full");
		h.vault.put("b.md", "B");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
		expect(await h.remote()).toEqual({ "notes/a.md": "A", "b.md": "B" });
	});

	test("the half-written copy an earlier version was writing beside its file, whose marker does not say what it is of", async () => {
		const h = await synced({ "a.md": "A" });
		const copy = earlierCopyPath("a.md", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
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

	describe("with a conflict that the pull merged", () => {
		const BASE = "# Title\n\none\n\ntwo\n\nthree\n";
		const MINE = BASE.replace("one", "one, here");
		const THEIRS = BASE.replace("three", "three, there");
		const MERGED = "# Title\n\none, here\n\ntwo\n\nthree, there\n";
		// The clock of the sync ahead of the files: a time that is handed to
		// a record is stored then, and a merged file whose record had one
		// would not be read by the push.
		const ahead = (h: Harness) => ({ mergeConflicts: true, now: () => h.now() + 10_000 });
		const kept = (h: Harness): string => mergedCopyPath("a.md", new Date(h.now()));

		async function inConflict(): Promise<Harness> {
			const h = await synced({ "a.md": BASE, "b.md": "B" });
			h.backend.commit({ "a.md": THEIRS });
			h.vault.put("a.md", MINE);
			return h;
		}

		test("the push of the same sync sends the merged content, as a change on top of what the remote had", async () => {
			const h = await inConflict();
			const theirs = h.backend.revision;

			const { pull, push } = await h.sync({ pull: ahead(h), push: { now: () => h.now() + 10_000 } });

			expect(pull).toMatchObject({ outcome: "completed", merged: [{ path: "a.md", keptAt: kept(h) }] });
			expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
			expect(await h.remote()).toEqual({ "a.md": MERGED, "b.md": "B" });
			// One revision on top of the other device's, and nothing of the `.trash/`.
			expect(h.backend.revision).not.toBe(theirs);
			expect(h.vault.snapshot()).toEqual({ "a.md": MERGED, "b.md": "B", [kept(h)]: MINE });
			await expectNothingToPull(h);
		});

		test("merged by a pull alone: the next sync sends it, and until then it reads as unsent", async () => {
			const h = await inConflict();
			const pulled = await h.pull(ahead(h));
			expect(pulled.merged).toEqual([{ path: "a.md", keptAt: kept(h) }]);
			expect(await h.remote()).toEqual({ "a.md": THEIRS, "b.md": "B" });
			expect(await h.records()).toEqual(hashes({ "a.md": THEIRS, "b.md": "B" }));

			const { pull, push } = await h.sync({ pull: ahead(h), push: { now: () => h.now() + 10_000 } });

			expect(pull).toMatchObject({ outcome: "completed", merged: [], conflicts: [] });
			expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
			expect(await h.remote()).toEqual({ "a.md": MERGED, "b.md": "B" });
			await expectNothingToPull(h);
		});
	});

	test("a first sync of a vault with files that are only here: the pull does not ask, and the push asks once, with the list", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "theirs.md": "T" });
		h.vault.putAll({ "a.md": "A", "mine.md": "M", "notes/too.md": "N" });

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 1, conflicts: 0 } });
		expect(h.pullAsked).toEqual([]);
		expect(h.asked).toEqual([
			{
				firstPush: { added: ["mine.md", "notes/too.md"], modified: [], deleted: [] },
				remoteEmpty: false,
				deletions: null,
				recordCount: 2,
			},
		]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A", "theirs.md": "T", "mine.md": "M", "notes/too.md": "N" });
		expect(h.vault.snapshot()).toEqual(await h.remote());
		await expectNothingToPull(h);
	});

	test("a no to that push sends nothing and changes no file, and the next push asks again", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "A" });
		h.vault.putAll({ "mine.md": "M" });
		h.answer = "cancel";

		const { pull, push } = await h.sync();

		expect(pull.outcome).toBe("completed");
		expect(h.pullAsked).toEqual([]);
		expect(push?.outcome).toBe("declined");
		expect(h.backend.revision).toBe(head);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "mine.md": "M" });
		expect((await h.push()).outcome).toBe("declined");
		expect(h.asked).toHaveLength(2);
		expect(h.asked[1]?.firstPush).toEqual({ added: ["mine.md"], modified: [], deleted: [] });
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

	test("a file a rule matches, changed on both sides: neither is fetched or sent, and no copy is made", async () => {
		const rules = "/drafts/\n*.png\n";
		const h = await synced({ "drafts/a.md": "A", "img.png": "P", ".gitignore": rules });
		h.backend.commit({ "drafts/a.md": "A from the Mac", "img.png": "P from the Mac" });
		h.vault.put("drafts/a.md", "A from here");
		h.vault.put("img.png", "P from here");
		h.vault.put("drafts/new.md", "N");

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 0, conflicts: 0 } });
		expect(push).toMatchObject({ outcome: "nothing-to-push" });
		expect(await h.remote()).toEqual({ "drafts/a.md": "A from the Mac", "img.png": "P from the Mac", ".gitignore": rules });
		expect(h.vault.text("drafts/a.md")).toBe("A from here");
		expect(h.vault.text("img.png")).toBe("P from here");
		expect(h.vault.text("drafts/new.md")).toBe("N");
		// The records stay as they were, marked.
		const records = await h.store.readRecords();
		expect(records.filter((record) => record.wasExcluded === true).map((record) => `${record.path} ${record.hash}`).sort()).toEqual([
			`drafts/a.md ${blobHash("A")}`,
			`img.png ${blobHash("P")}`,
		]);
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

	test("the copy in the folder of the copies is sent though a rule matches the file it is a copy of, which the remote has deleted", async () => {
		const rules = "*.png\n";
		const h = await synced({ "img.png": "P", ".gitignore": "" });
		h.backend.commit({ "img.png": "P from the Mac" });
		h.vault.put("img.png", "P from here");
		const pull = await h.pull();
		const copy = pull.conflicts[0]?.copyPath ?? "";
		expect(copy).toBe(conflictCopyPath("img.png", "iPhone", new Date(h.now())));
		// The Mac deletes the image between the pull and the push, and the
		// rule comes to this device.
		h.backend.commit({ "img.png": null });
		h.vault.put(".gitignore", rules);

		// Nothing is asked about the file a copy in the folder is of.
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });

		expect(await h.remote()).toEqual({ ".gitignore": rules, [copy]: "P from here" });
		expect(h.vault.text(copy)).toBe("P from here");
	});

	test("a copy of the earlier form of a file a rule matches is not sent once the remote has deleted the file, and stays in the vault", async () => {
		const rules = "*.png\n";
		const h = await synced({ "img.png": "P", ".gitignore": rules });
		// As a version up to 0.2.0 left it, beside the file.
		const copy = earlierCopyPath("img.png", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
		h.vault.put(copy, "P from here");
		const head = h.backend.commit({ "img.png": null });
		await h.pull();

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
		// Its record stays as it was, marked, and nothing is made of it.
		expect(await h.records()).toEqual(hashes({ "b.md": "B", ".gitignore": "/drafts/\n", "drafts/a.md": "A" }));

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
	test("its content goes to a new copy in the folder, and both are sent though the first file is gone from the remote", async () => {
		const rules = "*.png\n";
		const h = await synced({ "img.png": "P", ".gitignore": "" });
		h.backend.commit({ "img.png": "P from the Mac" });
		h.vault.put("img.png", "P from here");
		const first = (await h.sync()).pull.conflicts[0]?.copyPath ?? "";
		expect(await h.remote()).toMatchObject({ [first]: "P from here" });

		// The Mac deletes the image, edits the copy, and adds a rule for
		// images; this device edits the copy too. A copy in the folder is
		// fetched and sent whatever the rules say.
		h.backend.commit({ "img.png": null, [first]: "copy edited on the Mac", ".gitignore": rules });
		h.vault.put(first, "copy edited here");

		const { pull, push } = await h.sync();

		// A copy like any other, named after the copy it is of: no number.
		const second = pull.conflicts[0]?.copyPath ?? "";
		expect(second).toMatch(/^_conflicts\/\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2} img \(iPhone\) \(iPhone\)\.png$/);
		expect(pull).toMatchObject({ outcome: "completed", conflicts: [{ path: first, copyPath: second }] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({
			[first]: "copy edited on the Mac",
			[second]: "copy edited here",
			".gitignore": rules,
		});
		// The image stays here, cut off by the rule: its record with it.
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
		expect(h.vault.text("img.png")).toBe("P from the Mac");
	});

	test("a copy of the earlier form: its content goes to the folder too, and no name with a number is made", async () => {
		const rules = "*.md\n";
		const earlier = earlierCopyPath("img.png", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
		const h = await synced({ "img.png": "P", [earlier]: "P from here", ".gitignore": rules });
		h.backend.commit({ "img.png": null, [earlier]: "copy edited on the Mac" });
		h.vault.put(earlier, "copy edited here");

		const { pull, push } = await h.sync();

		const copy = pull.conflicts[0]?.copyPath ?? "";
		expect(copy).toMatch(/^_conflicts\/\d{4}-\d{2}-\d{2} img\.conflict-from-iPhone-20261003-221500 \(iPhone\)\.png$/);
		expect(pull).toMatchObject({ outcome: "completed", conflicts: [{ path: earlier, copyPath: copy }] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
		expect(await h.remote()).toEqual({
			[earlier]: "copy edited on the Mac",
			[copy]: "copy edited here",
			".gitignore": rules,
		});
		expect(h.vault.paths().filter((path) => path.includes("-2."))).toEqual([]);
		await expectNothingToPull(h);
	});
});

describe("a file a rule excludes and a rewritten history", () => {
	test("one the remote got and lost again is never fetched, and so is not among what is kept", async () => {
		const rules = "/drafts/\n";
		const h = await synced({ "a.md": "A1", ".gitignore": rules });
		// Tracked though the rule matches it, as after a `git add -f`.
		h.backend.commit({ "a.md": "A2", "drafts/c.md": "C", "c.md": "C" });
		await h.pull();
		expect(h.vault.text("drafts/c.md")).toBeUndefined();
		h.backend.rewriteHistory({ "a.md": "A1", ".gitignore": rules });
		h.pullAnswer = "keep-local";

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "completed", rewritten: true });
		expect([...pull.keptLocal].sort()).toEqual(["a.md", "c.md"]);
		expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", "c.md": "C", ".gitignore": rules });
	});

	test("one this device has is left as it is, whatever the history writes there, and nothing is asked about it", async () => {
		const rules = "/drafts/\n";
		const h = await synced({ "drafts/c.md": "C1", ".gitignore": rules });
		h.backend.commit({ "drafts/c.md": "C2" });
		await h.pull();
		expect(h.vault.text("drafts/c.md")).toBe("C1");
		h.backend.rewriteHistory({ "drafts/c.md": "C1", ".gitignore": rules });
		h.pullAnswer = "keep-local";

		const { pull, push } = await h.sync();

		expect(h.pullAsked).toEqual([]);
		expect(pull).toMatchObject({ outcome: "completed", keptLocal: [] });
		expect(push).toMatchObject({ outcome: "nothing-to-push" });
		expect(await h.remote()).toEqual({ "drafts/c.md": "C1", ".gitignore": rules });
		expect(h.vault.text("drafts/c.md")).toBe("C1");
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
		// With a section that leaves nothing out: the default lines leave out `*.icloud`.
		const empty = withSection(null, []);
		const others = { ".gitignore": empty, "notes/x.icloud": "I", ".hidden": "H", "notes/.dot.md": "D", "keep.md": "K" };
		const h = await synced(others);
		expect(h.vault.snapshot()).toEqual(others);
		h.vault.put("notes/x.icloud", "I2");
		h.vault.remove(".hidden");
		h.vault.remove("notes/.dot.md");

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 2 }, held: [] });
		expect(await h.remote()).toEqual({ ".gitignore": empty, "notes/x.icloud": "I2", "keep.md": "K" });
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

	/** Every read of `bad` answers with its first bytes only, as a fetch from a cloud drive that broke off might. */
	function cutShort(h: Harness, bad: string, length: number, whole = 0): () => void {
		const read = h.vault.read;
		let reads = 0;
		h.vault.read = async (path) => {
			const content = await read.call(h.vault, path);
			// The first `whole` reads of it are the comparing of the vault, which is to get through.
			return path === bad && ++reads > whole ? content.slice(0, length) : content;
		};
		return () => {
			h.vault.read = read;
		};
	}

	test("a read that gives a part of the file is no edit: a push leaves the file out, and the remote keeps the whole", async () => {
		const h = await synced({ "bad.md": "the whole note", "ok.md": "O" });
		// Touched, so that it is read: the time is not the record's any more.
		h.vault.put("bad.md", "the whole note");
		h.vault.put("ok.md", "O2");
		const whole = cutShort(h, "bad.md", 3);

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 0 },
			leftOut: [{ path: "bad.md", reason: "unreadable" }],
		});
		expect(await h.remote()).toEqual({ "bad.md": "the whole note", "ok.md": "O2" });
		expect((await h.records())["bad.md"]).toBe(blobHash("the whole note"));

		// Read whole again, there is nothing to send: it never changed.
		whole();
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push", leftOut: [] });
		expect(await h.remote()).toEqual({ "bad.md": "the whole note", "ok.md": "O2" });
	});

	test("an empty read of a file that is not empty is not sent as an empty file", async () => {
		const h = await synced({ "bad.md": "the whole note" });
		h.vault.put("bad.md", "the whole note");
		cutShort(h, "bad.md", 0);

		const result = await h.push();

		expect(result).toMatchObject({ leftOut: [{ path: "bad.md", reason: "unreadable" }] });
		expect(await h.remote()).toEqual({ "bad.md": "the whole note" });
	});

	test("a pull does not take the part for an edit: no conflict, the file as it is, and incomplete", async () => {
		const h = await synced({ "bad.md": "the whole note", "ok.md": "O" });
		const base = await h.base();
		h.vault.put("bad.md", "the whole note");
		h.backend.commit({ "bad.md": "from the Mac", "ok.md": "O from the Mac" });
		const whole = cutShort(h, "bad.md", 3);

		const result = await h.pull();

		expect(result).toMatchObject({
			outcome: "incomplete",
			counts: { fetched: 1, conflicts: 0 },
			deferred: [{ path: "bad.md", reason: "unreadable" }],
		});
		expect(h.vault.snapshot()).toEqual({ "bad.md": "the whole note", "ok.md": "O from the Mac" });
		expect(await h.base()).toBe(base);

		// Read whole again: unchanged here, so the remote's content comes in, with no copy.
		whole();
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 1, conflicts: 0 } });
		expect(h.vault.snapshot()).toEqual({ "bad.md": "from the Mac", "ok.md": "O from the Mac" });
	});

	test("a part read only when the file is sent is not sent: the file is left out, and sent whole the next time", async () => {
		const h = await synced({ "bad.md": "B", "ok.md": "O" });
		h.vault.put("bad.md", "the edited note");
		h.vault.put("ok.md", "O2");
		const whole = cutShort(h, "bad.md", 3, 1);

		const result = await h.push();

		expect(result).toMatchObject({
			outcome: "pushed",
			counts: { modified: 1 },
			leftOut: [{ path: "bad.md", reason: "unreadable" }],
		});
		expect(await h.remote()).toEqual({ "bad.md": "B", "ok.md": "O2" });
		expect((await h.records())["bad.md"]).toBe(blobHash("B"));

		whole();
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, leftOut: [] });
		expect(await h.remote()).toEqual({ "bad.md": "the edited note", "ok.md": "O2" });
	});

	test("a part read when a conflict is kept makes no copy of the part: the file is put off", async () => {
		const h = await synced({ "bad.md": "B" });
		const base = await h.base();
		h.vault.put("bad.md", "edited on the phone");
		h.backend.commit({ "bad.md": "edited on the Mac" });
		const whole = cutShort(h, "bad.md", 3, 1);

		const result = await h.pull();

		expect(result).toMatchObject({
			outcome: "incomplete",
			counts: { conflicts: 0 },
			deferred: [{ path: "bad.md", reason: "unreadable" }],
		});
		expect(h.vault.snapshot()).toEqual({ "bad.md": "edited on the phone" });
		expect(await h.base()).toBe(base);

		whole();
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { conflicts: 1 } });
		expect(h.vault.text("bad.md")).toBe("edited on the Mac");
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
		expect(logged.filter((line) => !isTimingLine(line))).toHaveLength(1);
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

	test("a file in .trash/ is not sent, also one the remote holds there, and its deletion is not sent either", async () => {
		const h = await synced({ ".trash/kept.md": "K", "a.md": "A" });
		expect(h.vault.text(".trash/kept.md")).toBe("K");
		h.vault.put(".trash/kept.md", "K2");
		h.vault.put(".trash/x.md", "X");

		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
		expect(await h.remote()).toEqual({ ".trash/kept.md": "K", "a.md": "A" });
		h.vault.remove(".trash/kept.md");
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
		expect(await h.remote()).toEqual({ ".trash/kept.md": "K", "a.md": "A" });
		// Its record stays, marked.
		expect((await h.store.readRecords()).find((record) => record.path === ".trash/kept.md")?.wasExcluded).toBe(true);
	});
});

// The harness leaves the section out of every push above. These are the
// pushes of the app, which add it.
const ADDING = { addSection: true } as const;

describe("the section a push adds to a .gitignore that has none", () => {
	const lines = defaultSectionLines(paths);
	const shown = [SECTION_START, ...lines, SECTION_END];
	const top = `${shown.join("\n")}\n`;

	test("a push alone puts it at the top, changes nothing below it, and sends the file", async () => {
		const h = await synced({ ".gitignore": "# mine\n*.log\n", "a.md": "A" });

		const result = await h.push(ADDING);

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(h.vault.text(".gitignore")).toBe(`${top}# mine\n*.log\n`);
		expect(h.vault.text(".gitignore")).toBe(withSection("# mine\n*.log\n", lines));
		expect(await h.remote()).toEqual({ ".gitignore": `${top}# mine\n*.log\n`, "a.md": "A" });
		expect(result.sectionAdded).toEqual({ lines: shown, created: false, tracked: [], asked: false, sent: true });
		expect(await h.store.readMarkers()).toEqual([]);
		await expectNothingToPull(h);
		// Once: the file has the section now.
		const again = await h.push(ADDING);
		expect(again.outcome).toBe("nothing-to-push");
		expect(again.sectionAdded).toBeUndefined();
	});

	test("a sync adds it after the pull, on top of the .gitignore the pull wrote", async () => {
		const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
		h.backend.commit({ ".gitignore": "*.log\n*.tmp\n", "theirs.md": "T" });

		const { pull, push } = await h.sync({ push: ADDING });

		expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 2 } });
		expect(push).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });
		expect(h.vault.text(".gitignore")).toBe(`${top}*.log\n*.tmp\n`);
		expect((await h.remote())[".gitignore"]).toBe(`${top}*.log\n*.tmp\n`);
		await expectNothingToPull(h);
	});

	test("a vault and a remote without a .gitignore get one that holds the section alone", async () => {
		const h = await synced({ "a.md": "A" });

		const result = await h.push(ADDING);

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
		expect(result.sectionAdded).toEqual({ lines: shown, created: true, tracked: [], asked: false, sent: true });
		expect(h.vault.text(".gitignore")).toBe(top);
		expect(await h.remote()).toEqual({ ".gitignore": top, "a.md": "A" });
		await expectNothingToPull(h);
	});

	test("not one byte outside it changes: a byte order mark, line ends of Windows, a last line without an end", async () => {
		const text = "﻿# mine\r\n*.log\r\n!keep.log";
		const h = await synced({ ".gitignore": text });

		expect((await h.push(ADDING)).outcome).toBe("pushed");

		const expected = `﻿${shown.join("\r\n")}\r\n# mine\r\n*.log\r\n!keep.log`;
		const sent = h.backend.read(".gitignore") ?? new Uint8Array();
		expect([...sent]).toEqual([...new TextEncoder().encode(expected)]);
		expect([...(await h.vault.read(".gitignore"))]).toEqual([...sent]);
	});

	test("a pull alone never adds it", async () => {
		const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
		h.backend.commit({ "theirs.md": "T" });

		expect((await h.pull()).outcome).toBe("completed");

		expect(h.vault.text(".gitignore")).toBe("*.log\n");
		expect(h.vault.log).toEqual(["write theirs.md"]);
	});

	describe("is not added", () => {
		/** Nothing was written to the `.gitignore`, and nothing of it was sent. */
		async function expectLeft(h: Harness, text: string | undefined, remote: string | undefined): Promise<void> {
			expect(h.vault.text(".gitignore")).toBe(text);
			expect(h.vault.log.filter((line) => line.includes(".gitignore"))).toEqual([]);
			expect((await h.remote())[".gitignore"]).toBe(remote);
		}

		test.each([
			["an empty one", `${SECTION_START}\n${SECTION_END}\n*.log\n`],
			["one the user moved down", `*.log\n${SECTION_START}\n/.trash/\n${SECTION_END}\n`],
			["a broken one: a start without an end", `${SECTION_START}\n/.trash/\n*.log\n`],
			["a broken one: two starts", `${SECTION_START}\n${SECTION_START}\n${SECTION_END}\n`],
			["a broken one: an end alone", `*.log\n${SECTION_END}\n`],
		])("to a file that has a section: %s", async (_name, text) => {
			const h = await synced({ ".gitignore": text, "a.md": "A" });

			const result = await h.push(ADDING);

			expect(result.outcome).toBe("nothing-to-push");
			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, text, text);
		});

		test("to a file over the size limit", async () => {
			const text = `${"# a long comment\n".repeat(10)}*.log\n`;
			const h = await synced({ ".gitignore": text, "a.md": "A" });

			const result = await h.push({ ...ADDING, sizeLimit: 100 });

			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, text, text);
		});

		test("to a file that would be over the size limit with it", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });

			const result = await h.push({ ...ADDING, sizeLimit: 100 });

			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, "*.log\n", "*.log\n");
		});

		test("to a file that is not text", async () => {
			const bytes = new Uint8Array([0x2a, 0x2e, 0xff, 0xfe, 0x0a]);
			const h = await synced({ ".gitignore": bytes, "a.md": "A" });

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "nothing-to-push" });
			expect(result.sectionAdded).toBeUndefined();
			expect([...(await h.vault.read(".gitignore"))]).toEqual([...bytes]);
			expect(h.vault.log).toEqual([]);
		});

		test("where a folder has the name", async () => {
			const h = await synced({ "a.md": "A" });
			h.vault.makeFolder(".gitignore");

			const result = await h.push(ADDING);

			expect(result.sectionAdded).toBeUndefined();
			expect(h.vault.log).toEqual([]);
			expect((await h.vault.stat(".gitignore"))?.type).toBe("folder");
		});

		test("where the vault spells the file in another case", async () => {
			const h = await synced({ "a.md": "A" });
			h.vault.put(".GITIGNORE", "*.log\n");

			const result = await h.push(ADDING);

			expect(result.sectionAdded).toBeUndefined();
			expect(h.vault.log).toEqual([]);
			expect(h.vault.paths()).toEqual([".GITIGNORE", "a.md"]);
		});

		test("where a cloud drive has taken the file off the device", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.vault.remove(".gitignore");
			h.vault.put("..gitignore.icloud", "");

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "gitignore-unreadable" });
			expect(result.sectionAdded).toBeUndefined();
			expect(h.vault.log).toEqual([]);
			expect(h.vault.paths()).toEqual(["..gitignore.icloud", "a.md"]);
		});

		test("where the file cannot be read", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			let reads = 0;
			h.vault.before = (op, path) => {
				if (op === "read" && path === ".gitignore" && reads++ === 0) throw new Error("locked");
			};

			const result = await h.push(ADDING);

			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, "*.log\n", "*.log\n");
		});

		test("while a write of a pull that stopped is not settled: the push sends nothing", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			await h.store.putMarker(makeMarker(".gitignore", blobHash("*.log\n"), blobHash("new"), false));
			h.vault.put("b.md", "B");

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(result.sectionAdded).toBeUndefined();
			expect(h.backend.pushes).toBe(0);
			await expectLeft(h, "*.log\n", "*.log\n");
		});

		test("while an editor that has it open cannot save", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.vault.openFailing(".gitignore");

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(result.sectionAdded).toBeUndefined();
			expect(h.vault.text(".gitignore")).toBe("*.log\n");
			expect(h.vault.log).toEqual(["save .gitignore"]);
		});

		test("what an editor had not saved is saved first, and the section goes on top of that", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.vault.open(".gitignore", "*.log\n*.tmp\n");

			expect((await h.push(ADDING)).outcome).toBe("pushed");

			expect(h.vault.text(".gitignore")).toBe(`${top}*.log\n*.tmp\n`);
			expect((await h.remote())[".gitignore"]).toBe(`${top}*.log\n*.tmp\n`);
		});

		test("by a push alone when another device has changed the .gitignore since the last pull", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.backend.commit({ ".gitignore": "*.log\n*.tmp\n" });
			h.vault.put("b.md", "B");

			const result = await h.push(ADDING);

			// The push would not send the file, and the section would be a
			// change of this device alone: a conflict at the next pull.
			expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, "*.log\n", "*.log\n*.tmp\n");
			// The sync after it pulls the file, and then adds the section.
			const { pull, push } = await h.sync({ push: ADDING });
			expect(pull).toMatchObject({ outcome: "completed", conflicts: [] });
			expect(push?.sectionAdded).toMatchObject({ created: false });
			expect((await h.remote())[".gitignore"]).toBe(`${top}*.log\n*.tmp\n`);
		});

		test("by a push alone when another device has added a .gitignore", async () => {
			const h = await synced({ "a.md": "A" });
			h.backend.commit({ ".gitignore": "*.tmp\n" });

			const result = await h.push(ADDING);

			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, undefined, "*.tmp\n");
		});

		test("before this device has pulled to the end", async () => {
			const h = harness();
			h.backend.commit({ "a.md": "A" });
			h.vault.put("mine.md", "M");

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "no-base" });
			expect(result.sectionAdded).toBeUndefined();
			expect(h.vault.snapshot()).toEqual({ "mine.md": "M" });
		});

		test("once the push was stopped", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const controller = new AbortController();
			// Stopped after the push has begun, right before the section is due.
			h.vault.before = (op, path) => {
				if (op === "save" && path === ".gitignore") controller.abort();
			};

			const result = await h.push({ ...ADDING, signal: controller.signal });

			expect(result.outcome).toBe("cancelled");
			expect(result.sectionAdded).toBeUndefined();
			await expectLeft(h, "*.log\n", "*.log\n");
		});

		test("by a sync whose pull the user declined: no push follows", async () => {
			const h = harness();
			h.backend.commit({ "a.md": "A" });
			h.vault.put("a.md", "mine");
			h.pullAnswer = "cancel";

			const { pull, push } = await h.sync({ push: ADDING });

			expect(pull.outcome).toBe("declined");
			expect(push).toBeNull();
			expect(h.vault.snapshot()).toEqual({ "a.md": "mine" });
		});

		test("by a sync whose pull was stopped", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.backend.commit({ "theirs.md": "T" });
			const controller = new AbortController();
			h.vault.before = (op) => {
				if (op === "write") controller.abort();
			};

			const { pull, push } = await h.sync({ pull: { signal: controller.signal }, push: { ...ADDING, signal: controller.signal } });

			expect(pull.outcome).toBe("cancelled");
			expect(push).toBeNull();
			expect(h.vault.text(".gitignore")).toBe("*.log\n");
		});

		test("by a sync whose pull failed", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const backend = Object.create(h.backend) as TestBackend;
			backend.list = async () => {
				throw new BackendError("unreachable", "offline");
			};

			await expect(h.sync({ pull: { backend }, push: ADDING })).rejects.toMatchObject({ kind: "unreachable" });

			expect(h.vault.text(".gitignore")).toBe("*.log\n");
			expect(h.vault.log).toEqual([]);
		});

		test("by a sync whose pull put the .gitignore off: the push sends nothing", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.backend.commit({ ".gitignore": "*.log\n*.tmp\n" });
			h.vault.openFailing(".gitignore");

			const { pull, push } = await h.sync({ push: ADDING });

			expect(pull).toMatchObject({ outcome: "incomplete", deferred: [{ path: ".gitignore", reason: "save-failed" }] });
			expect(push).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(push?.sectionAdded).toBeUndefined();
			expect(h.vault.text(".gitignore")).toBe("*.log\n");
			expect(h.vault.log.filter((line) => line.startsWith("write"))).toEqual([]);
		});
	});

	test("a sync whose pull put another file off adds it: the .gitignore is the remote's, and the push sends it", async () => {
		const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
		h.backend.commit({ "a.md": "A from the Mac" });
		h.vault.openFailing("a.md");

		const { pull, push } = await h.sync({ push: ADDING });

		expect(pull).toMatchObject({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "save-failed" }] });
		expect(push).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });
		expect(push?.sectionAdded).toMatchObject({ created: false });
		expect(await h.remote()).toEqual({ ".gitignore": `${top}*.log\n`, "a.md": "A from the Mac" });
	});

	describe("to a remote without commits", () => {
		test("the first revision is the .gitignore with the section, made for a vault that had none", async () => {
			const h = harness();

			const result = await h.push(ADDING);

			// Nothing else to send: the one revision is the first.
			expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
			expect(h.backend.revisionCount).toBe(1);
			expect(await h.remote()).toEqual({ ".gitignore": top });
			expect(h.vault.snapshot()).toEqual({ ".gitignore": top });
			expect(result.sectionAdded).toEqual({ lines: shown, created: true, tracked: [], asked: true, sent: true });
			await expectNothingToPull(h);
		});

		test("the .gitignore of the vault gets the section before it becomes the first revision, and the rest follows", async () => {
			const h = harness();
			h.vault.putAll({ ".gitignore": "private/\n", "a.md": "A", "private/x.md": "X", ".trash/old.md": "O" });
			const revisions: Record<string, string>[] = [];
			const start = h.backend.start.bind(h.backend);
			const backend = Object.create(h.backend) as TestBackend;
			backend.start = async (request) => {
				const started = await start(request);
				revisions.push(await h.remote());
				return started;
			};

			const result = await h.push({ ...ADDING, backend });

			expect(result).toMatchObject({ outcome: "pushed", counts: { added: 2 } });
			expect(revisions).toEqual([{ ".gitignore": `${top}private/\n` }]);
			expect(h.backend.revisionCount).toBe(2);
			expect(await h.remote()).toEqual({ ".gitignore": `${top}private/\n`, "a.md": "A" });
			expect(h.asked).toEqual([
				{
					firstPush: { added: [".gitignore", "a.md"], modified: [], deleted: [] },
					remoteEmpty: true,
					deletions: null,
					recordCount: 0,
					sectionAdded: { lines: shown, created: false, tracked: [] },
				},
			]);
			await expectNothingToPull(h);
		});

		test("a no sends nothing; the section stays in the vault, the result says so, and the next push sends it", async () => {
			const h = harness();
			h.vault.put("a.md", "A");
			h.answer = "cancel";

			const declined = await h.push(ADDING);

			expect(declined.outcome).toBe("declined");
			expect(declined.sectionAdded).toEqual({ lines: shown, created: true, tracked: [], asked: true, sent: false });
			expect(h.backend.revision).toBeNull();
			expect(h.vault.snapshot()).toEqual({ ".gitignore": top, "a.md": "A" });

			h.answer = "proceed";
			const pushed = await h.push(ADDING);
			expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 2 } });
			// Written by the push before: this one added nothing.
			expect(pushed.sectionAdded).toBeUndefined();
			expect(h.asked[1]?.sectionAdded).toBeUndefined();
			expect(await h.remote()).toEqual({ ".gitignore": top, "a.md": "A" });
		});
	});

	describe("is shown", () => {
		test("in the question before the first push, with the files of the remote its lines match", async () => {
			const h = await synced(
				{ ".gitignore": "!.DS_Store\n", ".obsidian/workspace.json": "{}", ".trash/old.md": "O", ".DS_Store": "", "a.md": "A" },
				{ firstPush: true },
			);
			h.vault.put("new.md", "N");

			const result = await h.push(ADDING);

			// `.DS_Store` is not among them: the line of the user undoes the one added.
			const added = { lines: shown, created: false, tracked: [".obsidian/workspace.json", ".trash/old.md"] };
			expect(h.asked).toEqual([
				{
					firstPush: { added: ["new.md"], modified: [".gitignore"], deleted: [] },
					remoteEmpty: false,
					deletions: null,
					// Not the two the default lines left out before the section was there.
					recordCount: 3,
					sectionAdded: added,
				},
			]);
			expect(result.outcome).toBe("pushed");
			expect(result.sectionAdded).toEqual({ ...added, asked: true, sent: true });
			// They stay on the remote.
			expect(Object.keys(await h.remote()).sort()).toEqual(
				[".DS_Store", ".gitignore", ".obsidian/workspace.json", ".trash/old.md", "a.md", "new.md"].sort(),
			);
		});

		test("by the result alone when no question is due", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });

			const result = await h.push(ADDING);

			expect(h.asked).toEqual([]);
			expect(result.sectionAdded).toMatchObject({ asked: false });
		});

		test("by the result and not by a question that is about deletions alone", async () => {
			const files: Record<string, string> = { ".gitignore": "*.log\n" };
			for (let index = 0; index < 12; index++) files[`notes/${index}.md`] = String(index);
			const h = await synced(files);
			for (let index = 0; index < 12; index++) h.vault.remove(`notes/${index}.md`);

			const result = await h.push(ADDING);

			expect(h.asked).toHaveLength(1);
			expect(h.asked[0]).toMatchObject({ firstPush: null });
			expect(h.asked[0]?.deletions).toHaveLength(12);
			expect(h.asked[0]?.sectionAdded).toBeUndefined();
			expect(result.sectionAdded).toMatchObject({ asked: false });
		});

		test("to whoever started the push, also when the push then fails", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const backend = Object.create(h.backend) as TestBackend;
			backend.push = async () => {
				throw new BackendError("unreachable", "offline");
			};
			const told: unknown[] = [];

			await expect(h.push({ ...ADDING, backend, onSectionAdded: (added) => told.push(added) })).rejects.toMatchObject({
				kind: "unreachable",
			});

			expect(told).toEqual([{ lines: shown, created: false, tracked: [] }]);
			// The file on this device has it, and the next push sends it.
			expect(h.vault.text(".gitignore")).toBe(`${top}*.log\n`);
			const next = await h.push(ADDING);
			expect(next.outcome).toBe("pushed");
			expect(next.sectionAdded).toBeUndefined();
			expect((await h.remote())[".gitignore"]).toBe(`${top}*.log\n`);
		});

		test("by a push the remote turned down: the section is in the vault all the same", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const push = h.backend.push.bind(h.backend);
			const backend = Object.create(h.backend) as TestBackend;
			backend.push = async (request) => {
				h.backend.commit({ "theirs.md": "T" });
				return push(request);
			};

			const result = await h.push({ ...ADDING, backend });

			expect(result).toMatchObject({ outcome: "pull-first", reason: "remote-moved" });
			expect(result.sectionAdded).toEqual({ lines: shown, created: false, tracked: [], asked: false, sent: false });
			expect(h.vault.text(".gitignore")).toBe(`${top}*.log\n`);
		});

		test("by a push that was turned down after the first commit of the remote was made: that commit holds it, and it counts as sent", async () => {
			const h = harness();
			h.vault.put("a.md", "A");
			// Another device pushes between the first commit and the rest.
			const push = h.backend.push.bind(h.backend);
			h.backend.push = async (request) => {
				h.backend.commit({ "theirs.md": "T" });
				return push(request);
			};

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "remote-moved" });
			expect(h.backend.revisionCount).toBe(2);
			expect(result.sectionAdded).toMatchObject({ created: true, asked: true, sent: true });
			expect((await h.remote())[".gitignore"]).toBe(top);
		});
	});

	describe("when the write does not get to its end", () => {
		const remembered = (h: Harness): Promise<unknown> => h.store.getMeta(GITIGNORE_WRITE_KEY);

		test("no marker of a pull is put for it: what is remembered is the write itself, until it is done", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			let during: unknown;
			let markers: unknown;
			h.vault.before = async (op, path) => {
				if (op !== "write" || path !== ".gitignore") return;
				during = await remembered(h);
				markers = await h.store.readMarkers();
			};

			expect((await h.push(ADDING)).outcome).toBe("pushed");

			expect(during).toEqual({ before: "*.log\n", writing: `${top}*.log\n` });
			expect(markers).toEqual([]);
			expect(await remembered(h)).toBeUndefined();
		});

		test("the vault fails halfway through the write: this push sends nothing, and the next finishes the file and sends it", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.vault.put("b.md", "B");
			h.vault.before = (op, path) => {
				if (op !== "write" || path !== ".gitignore") return;
				h.vault.put(".gitignore", top.slice(0, 40));
				throw new Error("disk full");
			};

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(result.sectionAdded).toBeUndefined();
			expect(h.backend.pushes).toBe(0);
			expect(await remembered(h)).toEqual({ before: "*.log\n", writing: `${top}*.log\n` });
			expect(await h.remote()).toEqual({ ".gitignore": "*.log\n", "a.md": "A" });
			// Still failing: still nothing sent.
			expect(await h.push(ADDING)).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(h.backend.pushes).toBe(0);

			h.vault.before = undefined;
			expect((await h.push(ADDING)).outcome).toBe("pushed");
			expect(await h.remote()).toEqual({ ".gitignore": `${top}*.log\n`, "a.md": "A", "b.md": "B" });
			expect(await remembered(h)).toBeUndefined();
		});

		test("the vault refuses the write and the file is as it was: the push goes on without the section", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.vault.putAll({ "b.md": "B", ".trash/old.md": "O" });
			h.vault.before = (op, path) => {
				if (op === "write" && path === ".gitignore") throw new Error("read-only");
			};

			const result = await h.push(ADDING);

			// Its lines are applied all the same: the trash is not sent.
			expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
			expect(result.sectionAdded).toBeUndefined();
			expect(await remembered(h)).toBeUndefined();
			expect(await h.remote()).toEqual({ ".gitignore": "*.log\n", "a.md": "A", "b.md": "B" });
		});

		// The app is killed while the section is written. Two moments: right
		// after the write, before it is forgotten ("written"), and in the
		// middle of the write ("half"). Three vaults: one whose `.gitignore`
		// has an edit that was never sent, one whose `.gitignore` is only on
		// this device, and one before the first push to a remote without
		// commits. Nothing of the user's is lost in any of them, and the
		// next sync gets on.
		type Moment = "written" | "half";
		const moments: readonly Moment[] = ["written", "half"];

		/** The vault as the kill left it: the file, and the write still remembered. */
		async function killed(h: Harness, before: string | null, moment: Moment): Promise<string> {
			const writing = withSection(before, lines);
			h.vault.put(".gitignore", moment === "written" ? writing : writing.slice(0, 57));
			await h.store.setMeta(GITIGNORE_WRITE_KEY, { before, writing });
			return writing;
		}

		test.each(moments)("an edit of the .gitignore that was never sent is kept and sent (%s)", async (moment) => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const writing = await killed(h, "*.log\n# my edit\n", moment);

			const { pull, push } = await h.sync({ push: ADDING });

			expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 }, halfWritten: [] });
			expect(push).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1 } });
			expect(h.vault.text(".gitignore")).toBe(writing);
			expect(writing.endsWith("*.log\n# my edit\n")).toBe(true);
			expect((await h.remote())[".gitignore"]).toBe(writing);
			expect(h.vault.trashed).toEqual([]);
			expect(await remembered(h)).toBeUndefined();
			await expectNothingToPull(h);
		});

		test.each(moments)("so is it when the remote changed the file meanwhile: a conflict, with the edit in the copy (%s)", async (moment) => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const writing = await killed(h, "*.log\n# my edit\n", moment);
			h.backend.commit({ ".gitignore": "*.log\n*.tmp\n" });

			const { pull } = await h.sync({ push: ADDING });

			expect(pull).toMatchObject({ outcome: "completed", counts: { conflicts: 1 } });
			const copy = pull.conflicts[0]?.copyPath ?? "";
			expect(h.vault.text(copy)).toBe(writing);
			expect(h.vault.trashed).toEqual([]);
		});

		test.each(moments)("a .gitignore that is only on this device is kept and sent (%s)", async (moment) => {
			const h = await synced({ "a.md": "A" });
			const writing = await killed(h, "# my own, never sent\n", moment);

			const { pull, push } = await h.sync({ push: ADDING });

			expect(pull).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
			expect(push).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0 } });
			expect(h.vault.text(".gitignore")).toBe(writing);
			expect(writing.endsWith("# my own, never sent\n")).toBe(true);
			expect(await h.remote()).toEqual({ ".gitignore": writing, "a.md": "A" });
			expect(h.vault.trashed).toEqual([]);
			await expectNothingToPull(h);
		});

		test.each(moments)("the first push to a remote without commits goes through, by a sync or by a push alone (%s)", async (moment) => {
			for (const run of ["sync", "push"] as const) {
				const h = harness();
				h.vault.put("a.md", "A");
				const writing = await killed(h, null, moment);

				const push = run === "sync" ? (await h.sync({ push: ADDING })).push : await h.push(ADDING);

				expect(push).toMatchObject({ outcome: "pushed", counts: { added: 2 } });
				expect(await h.remote()).toEqual({ ".gitignore": writing, "a.md": "A" });
				expect(await remembered(h)).toBeUndefined();
				await expectNothingToPull(h);
			}
		});

		test.each(moments)("so does it for a vault that had a .gitignore of its own (%s)", async (moment) => {
			const h = harness();
			h.vault.put("a.md", "A");
			const writing = await killed(h, "private/\n", moment);

			expect(await h.push(ADDING)).toMatchObject({ outcome: "pushed", counts: { added: 2 } });

			expect(await h.remote()).toEqual({ ".gitignore": writing, "a.md": "A" });
			expect(writing.endsWith("private/\n")).toBe(true);
		});

		test("killed before anything was written: the file is as it was, and the next push adds the section", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			await h.store.setMeta(GITIGNORE_WRITE_KEY, { before: "*.log\n", writing: `${top}*.log\n` });

			const result = await h.push(ADDING);

			expect(result).toMatchObject({ outcome: "pushed", counts: { modified: 1 } });
			expect(result.sectionAdded).toMatchObject({ created: false });
			expect((await h.remote())[".gitignore"]).toBe(`${top}*.log\n`);
		});

		test("a pull alone settles it too, and stores no record of a text the remote does not have", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const writing = await killed(h, "*.log\n", "half");

			expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0 }, deferred: [] });

			expect(h.vault.text(".gitignore")).toBe(writing);
			expect(await remembered(h)).toBeUndefined();
			expect((await h.records())[".gitignore"]).toBe(blobHash("*.log\n"));
		});

		test("a file the user changed after the kill is theirs: it is not finished, and not written over", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			await killed(h, "*.log\n", "half");
			h.vault.put(".gitignore", "# rewritten by hand\n");

			const { push } = await h.sync({ push: ADDING });

			// It has no section, so the push adds one, to what the user wrote.
			expect(push).toMatchObject({ outcome: "pushed" });
			expect((await h.remote())[".gitignore"]).toBe(`${top}# rewritten by hand\n`);
		});

		test("while the file cannot be looked at, it stays remembered: the pull puts the file off, and the push sends nothing", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const writing = await killed(h, "*.log\n", "half");
			h.vault.put("b.md", "B");
			h.vault.before = (op, path) => {
				if (op === "read" && path === ".gitignore") throw new Error("locked");
			};

			const { pull, push } = await h.sync({ push: ADDING });

			expect(pull).toMatchObject({ outcome: "incomplete", deferred: [{ path: ".gitignore", reason: "unreadable" }] });
			expect(push).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });
			expect(h.backend.pushes).toBe(0);
			expect(await remembered(h)).toEqual({ before: "*.log\n", writing });
			// By a push alone as well.
			expect(await h.push(ADDING)).toMatchObject({ outcome: "pull-first", reason: "gitignore-unsettled" });

			h.vault.before = undefined;
			expect((await h.sync({ push: ADDING })).push).toMatchObject({ outcome: "pushed" });
			expect(await h.remote()).toEqual({ ".gitignore": writing, "a.md": "A", "b.md": "B" });
		});

		test("a first fetch that starts over settles it before the sync state goes, and what could not be settled goes along", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const writing = await killed(h, "*.log\n", "half");
			const discardState = async (seed: Parameters<MemoryStateStore["startOver"]>[0]): Promise<StateStore> => {
				await h.store.startOver(seed);
				return h.store;
			};

			expect((await h.pull({ discardState })).outcome).toBe("completed");

			expect(await remembered(h)).toBeUndefined();
			// Finished, and so not the remote's text: kept as the copy of a
			// conflict by the first fetch, like any file that differs.
			expect(Object.values(h.vault.snapshot())).toContain(writing);

			const stuck = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			const left = await killed(stuck, "*.log\n", "half");
			stuck.vault.before = (op, path) => {
				if (op === "write" && path === ".gitignore") throw new Error("disk full");
			};
			await stuck.pull({
				discardState: async (seed) => {
					await stuck.store.startOver(seed);
					return stuck.store;
				},
			});
			expect(await remembered(stuck)).toEqual({ before: "*.log\n", writing: left });
		});
	});
});

describe("the notices that follow from the rules", () => {
	const lines = defaultSectionLines(paths);
	const nested = (path: string) => ({ kind: "nested-gitignore", path }) as const;

	test("a .gitignore in a subfolder is told once, by the pull that finds it; the push after it does not tell it again", async () => {
		const h = harness();
		h.backend.commit({ ".gitignore": "/drafts/\n", "notes/.gitignore": "*.tmp\n", "notes/a.md": "A" });

		const { pull, push } = await h.sync({ push: ADDING });

		expect(pull.notices).toEqual([nested("notes/.gitignore")]);
		expect(push).toMatchObject({ outcome: "pushed", notices: [] });
		expect((await h.sync({ push: ADDING })).pull.notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([nested("notes/.gitignore")]);
	});

	test("a push alone tells one that is only in the vault, and forgets it once it is gone", async () => {
		const h = await synced({ ".gitignore": withSection("/drafts/\n", lines), "a.md": "A" });
		h.vault.putAll({ "notes/.gitignore": "*.tmp\n", "drafts/.gitignore": "x\n", ".trash/.gitignore": "y\n" });

		const pushed = await h.push(ADDING);

		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 1 } });
		// Not the ones below a folder a rule leaves out.
		expect(pushed.notices).toEqual([nested("notes/.gitignore")]);
		expect((await h.pull()).notices).toEqual([]);

		// Deleted here, it is on the remote until this push has deleted it
		// there: forgotten by the sync after it.
		h.vault.remove("notes/.gitignore");
		expect(await h.push(ADDING)).toMatchObject({ outcome: "pushed", counts: { deleted: 1 }, notices: [] });
		expect(await readNotices(h.store)).toEqual([nested("notes/.gitignore")]);
		expect((await h.push(ADDING)).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("not one the remote holds below a folder a rule matches, below the plugin's own folder, or below a submodule", async () => {
		const h = harness();
		h.backend.commit({
			".gitignore": "/knowledge/\n",
			"knowledge/.gitignore": "*.tmp\n",
			"knowledge/a.md": "A",
			".obsidian/plugins/sync-evo/.gitignore": "x\n",
			"sub/.gitignore": "y\n",
			sub: "0".repeat(40),
			"deep/er/.gitignore": "z\n",
		});
		h.backend.kinds.set("sub", "submodule");

		const { pull, push } = await h.sync({ push: ADDING });

		expect(pull.notices.filter((notice) => notice.kind === "nested-gitignore")).toEqual([nested("deep/er/.gitignore")]);
		expect(push?.notices).toEqual([]);
	});

	test("a fixed exclusion that is not in effect is told once, by its line, and forgotten once it is back", async () => {
		const off = (line: string) => ({ kind: "fixed-exclusion-off", path: line }) as const;
		const without = lines.filter((line) => line !== "/.trash/" && line !== ".DS_Store");
		const h = harness();
		h.backend.commit({ ".gitignore": withSection("!*.icloud\n", without), "a.md": "A" });

		const { pull, push } = await h.sync({ push: ADDING });

		expect(pull.notices).toEqual([off("/.trash/"), off(".DS_Store"), off("*.icloud")]);
		expect(push?.notices).toEqual([]);
		expect((await h.push(ADDING)).notices).toEqual([]);

		// Restored on this device: the push finds it so, and forgets them.
		h.vault.put(".gitignore", withSection("", lines));
		expect((await h.push(ADDING)).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);
		// Deleted again: told again.
		h.vault.put(".gitignore", withSection("", without));
		expect((await h.push(ADDING)).notices).toEqual([off("/.trash/"), off(".DS_Store")]);
	});

	test("none while the .gitignore has no section: its lines count as there", async () => {
		const h = harness();
		h.backend.commit({ ".gitignore": "*.log\n", "a.md": "A" });

		expect((await h.pull()).notices).toEqual([]);
		expect((await h.push(ADDING)).notices).toEqual([]);
	});

	test("a push leaves what only a pull finds as it is remembered, and a pull what only a push finds", async () => {
		const h = await synced({ ".gitignore": withSection("", lines), "Case.md": "C" }, { caseSensitive: true });
		await h.store.setMeta("notices", [{ kind: "git-at-root", path: ".git" }]);
		h.vault.putAll({ "case.md": "c", "notes/.gitignore": "x\n" });

		const pushed = await h.push(ADDING);

		expect(pushed.notices).toEqual([nested("notes/.gitignore"), { kind: "local-path-collision", path: "case.md" }]);
		expect(await readNotices(h.store)).toEqual([
			{ kind: "git-at-root", path: ".git" },
			nested("notes/.gitignore"),
			{ kind: "local-path-collision", path: "case.md" },
		]);
		// The pull finds no `.git`, and forgets that; the collision is the push's to forget.
		expect((await h.pull()).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([
			{ kind: "local-path-collision", path: "case.md" },
			nested("notes/.gitignore"),
		]);
	});
});

describe("a question that is left for later", () => {
	const thirty = (): Record<string, string> =>
		Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n/${String(i).padStart(2, "0")}.md`, `note ${i}`]));

	test("before the first push: nothing is sent, and it is asked again", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		const before = h.backend.revision;
		h.vault.put("new.md", "N");
		h.answer = "later";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "first-push", revision: null });
		expect(h.backend.revision).toBe(before);
		expect(h.backend.pushes).toBe(0);
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();

		h.answer = "proceed";
		expect((await h.push()).outcome).toBe("pushed");
		expect(h.asked).toHaveLength(2);
	});

	test("too many deletions: nothing is sent or deleted", async () => {
		const h = await synced(thirty());
		const before = h.backend.revision;
		for (let i = 0; i < 6; i++) h.vault.remove(`n/0${i}.md`);
		h.vault.put("added.md", "also not sent");
		h.answer = "later";

		const result = await h.push();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "deletions" });
		expect(h.backend.revision).toBe(before);
		expect(h.backend.pushes).toBe(0);
		expect(Object.keys(await h.remote())).toHaveLength(30);
	});

	test("it is no push that failed: nothing is told when the app starts", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.vault.put("new.md", "N");
		h.answer = "later";

		expect((await h.push()).outcome).toBe("waiting");

		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a push that had not got to its end before it is as unfinished as it was", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		await h.store.setMeta(PUSH_FAILURE_KEY, { at: 12345 });
		h.vault.put("new.md", "N");
		h.answer = "later";

		expect((await h.push()).outcome).toBe("waiting");

		expect(await readPushFailure(h.store)).toEqual({ at: 12345 });
	});

	test("the section that was added to .gitignore is told by the result, since no question showed it", async () => {
		const h = await synced({ "a.md": "A" }, { firstPush: true });
		h.answer = "later";

		const result = await h.push(ADDING);

		expect(result.outcome).toBe("waiting");
		expect(result.sectionAdded).toMatchObject({ created: true, asked: false, sent: false });
		expect(h.backend.pushes).toBe(0);
		const report = pushReport(translatorFor("en"), result, { sizeLimit: 50 * 1024 * 1024 });
		expect(report.summary).toBe(
			"The first upload from this device needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
		);
		expect(report.details).toHaveLength(1);
	});

	test("no push follows a pull that waits for its question", async () => {
		const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(files);
		const head = h.backend.commit(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}.md`, null])));
		h.vault.put("mine.md", "M");
		h.pullAnswer = "later";

		const { pull, push } = await h.sync();

		expect(pull).toMatchObject({ outcome: "waiting", waitingFor: "deletions" });
		expect(push).toBeNull();
		expect(pushFollows(pull)).toBe(false);
		expect(h.backend.revision).toBe(head);
		expect(h.backend.pushes).toBe(0);
		expect(await readPushFailure(h.store)).toBeNull();
	});
});

describe("a sync that started by itself", () => {
	function failing(h: Harness): TestBackend {
		const backend = Object.create(h.backend) as TestBackend;
		backend.list = () => Promise.reject(new BackendError("unreachable", "offline"));
		return backend;
	}
	const deps = (h: Harness, backend: TestBackend): Parameters<typeof runSync>[0] => ({
		pull: {
			store: h.store,
			backend,
			vault: h.vault,
			paths,
			pluginId: "sync-evo",
			deviceName: "iPhone",
			now: h.now,
			confirm: async () => "later",
		},
		push: { store: h.store, backend, vault: h.vault, paths, deviceName: "iPhone", now: h.now, confirm: async () => "later", askEmptyVault: async () => "later" },
	});

	test("whose pull fails leaves no push to tell of when the app starts", async () => {
		const h = await synced({ "a.md": "A" });

		await expect(runSync({ ...deps(h, failing(h)), automatic: true })).rejects.toMatchObject({ kind: "unreachable" });

		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("unlike one the user started, who asked for the push", async () => {
		const h = await synced({ "a.md": "A" });

		await expect(runSync(deps(h, failing(h)))).rejects.toMatchObject({ kind: "unreachable" });

		expect(await readPushFailure(h.store)).toEqual({ at: h.now() });
	});
});

describe("a push with the light check", () => {
	const files = { "a.md": "A", "notes/b.md": "B", "gone.md": "G", ".github/ci.yml": "ci", ".github/old.yml": "old" };

	test("sends what was edited and deletes what is gone, without listing a folder", async () => {
		const h = await synced(files);
		// Records the times of the files the first pull wrote.
		await h.pull();
		const index = new MemoryIndex(h.vault);
		h.vault.put("a.md", "A2");
		h.vault.put(".github/ci.yml", "ci2");
		h.vault.put("notes/new.md", "N");
		h.vault.remove("gone.md");
		h.vault.remove(".github/old.yml");
		const ops: string[] = [];
		h.vault.before = (op, path) => {
			ops.push(`${op} ${path}`);
		};
		const lines: string[] = [];

		const result = await h.push({ index, log: (line) => lines.push(line) });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 2, deleted: 2 } });
		expect(await h.remote()).toEqual({ ".github/ci.yml": "ci2", "a.md": "A2", "notes/b.md": "B", "notes/new.md": "N" });
		expect(ops.filter((op) => op.startsWith("list"))).toEqual([]);
		expect(lines.filter((line) => !isTimingLine(line))).toEqual([
			"push: light check: 4 files, 3 not in the index, 3 asked of the disk, 3 hashed, 0 ms (disk 0 ms, reading 0 ms)",
		]);
		await expectNothingToPull(h);
	});

	test("a new file with a . name is not found, and is sent by the next push that scans", async () => {
		const h = await synced(files);
		const index = new MemoryIndex(h.vault);
		h.vault.put(".github/new.yml", "new");

		expect((await h.push({ index })).outcome).toBe("nothing-to-push");
		expect((await h.remote())[".github/new.yml"]).toBeUndefined();

		expect((await h.push()).outcome).toBe("pushed");
		expect((await h.remote())[".github/new.yml"]).toBe("new");
	});

	test("a recorded file the index has lost is not deleted on the remote", async () => {
		const h = await synced(files);
		const index = new MemoryIndex(h.vault);
		index.drop("notes/b.md");

		expect((await h.push({ index })).outcome).toBe("nothing-to-push");

		expect((await h.remote())["notes/b.md"]).toBe("B");
	});

	test("a file a cloud drive took off the device is not deleted on the remote", async () => {
		const h = await synced(files);
		const index = new MemoryIndex(h.vault);
		h.vault.remove("notes/b.md");
		h.vault.put("notes/.b.md.icloud", "stub");

		const result = await h.push({ index });

		expect(result).toMatchObject({ outcome: "nothing-to-push", leftOut: [] });
		expect((await h.remote())["notes/b.md"]).toBe("B");
	});

	test("what an editor holds and has not saved is sent, though the index knows nothing of it", async () => {
		const h = await synced(files);
		const index = new MemoryIndex(h.vault);
		index.follow = false;
		h.vault.open("a.md", "typed");

		expect((await h.push({ index })).outcome).toBe("pushed");

		expect((await h.remote())["a.md"]).toBe("typed");
	});

	test("no notice is forgotten, so that the next scan does not tell it again", async () => {
		const h = await synced(files, { caseSensitive: true });
		h.vault.put("notes/.gitignore", "*.tmp\n");
		const nested = { kind: "nested-gitignore", path: "notes/.gitignore" } as const;
		expect((await h.push()).notices).toEqual([nested]);
		const index = new MemoryIndex(h.vault);
		// The file was sent: the light check knows it from here on. One
		// that is not known is the case that matters.
		h.vault.put("notes/deep/.gitignore", "*.tmp\n");
		const deep = { kind: "nested-gitignore", path: "notes/deep/.gitignore" } as const;
		await h.store.setMeta("notices", [nested, deep]);

		expect((await h.push({ index })).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual(expect.arrayContaining([nested, deep]));
	});

	test("a question it comes to can be left for later like any other", async () => {
		const h = await synced(files, { firstPush: true });
		const index = new MemoryIndex(h.vault);
		h.vault.put("a.md", "A2");
		h.answer = "later";

		expect(await h.push({ index })).toMatchObject({ outcome: "waiting", waitingFor: "first-push" });
		expect(h.backend.pushes).toBe(0);
	});
});

describe("a file that is being typed in, in a sync that started by itself", () => {
	const typingIn = (...paths: string[]) => ({ beingEdited: (path: string) => paths.includes(path) }) as const;

	test("is not saved and not sent by the push; the rest is", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A and half a");
		h.vault.open("a.md", "A and half a sentence");
		h.vault.put("b.md", "B2");

		const result = await h.push(typingIn("a.md"));

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2" });
		expect(h.vault.log.filter((line) => line.includes("a.md"))).toEqual([]);
		expect(h.vault.text("a.md")).toBe("A and half a");
		// Nothing is wrong with it, and nothing is told of it.
		expect(result.held).toEqual([]);
		expect(result.leftOut).toEqual([]);
		expect(pushReport(translatorFor("en"), result, { sizeLimit: 50 * 1024 * 1024 }).details).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
	});

	test("with nothing else to send, nothing is sent", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typing");

		const result = await h.push(typingIn("a.md"));

		expect(result).toMatchObject({ outcome: "nothing-to-push", held: [], leftOut: [] });
		expect(h.backend.pushes).toBe(0);
	});

	test("once the typing has stopped, the next push saves and sends it", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typed");
		h.vault.open("a.md", "typed to the end");
		await h.push(typingIn("a.md"));

		expect((await h.push(typingIn())).outcome).toBe("pushed");

		expect(await h.remote()).toEqual({ "a.md": "typed to the end" });
	});

	test("a new file that is being typed in is not sent yet either", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("new.md", "the first li");

		expect((await h.push(typingIn("new.md"))).outcome).toBe("nothing-to-push");

		expect(await h.remote()).toEqual({ "a.md": "A" });
	});

	test("typing that begins after the vault was looked at: what is on disk is sent, and the editor is not asked to save", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2");
		h.vault.open("a.md", "A2 and half a");
		h.vault.put("b.md", "B2");
		// The editors saved when the vault was looked at; what is typed from here on is not on disk.
		h.vault.before = (op, path) => {
			if (op === "save" && path === "a.md" && scanned) throw new Error("saved in the middle of typing");
		};
		let scanned = false;
		const beingEdited = (path: string): boolean => scanned && path === "a.md";

		const result = await h.push({
			beingEdited,
			onProgress: (event) => {
				if (event.phase === "sending") scanned = true;
			},
		});

		expect(result).toMatchObject({ outcome: "pushed", leftOut: [], held: [] });
		expect(await h.remote()).toEqual({ "a.md": "A2 and half a", "b.md": "B2" });
	});

	test("the push after a pull that put the file off holds it, and tells nothing of it", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "typing");
		h.vault.put("b.md", "B2");
		const head = h.backend.commit({ "a.md": "A2", "c.md": "C" });
		const editing = typingIn("a.md");

		const { pull, push } = await h.sync({ pull: { automatic: true, ...editing }, push: editing });

		expect(pull).toMatchObject({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "being-edited" }] });
		expect(pathsToHold(pull)).toEqual(["a.md"]);
		expect(push).toMatchObject({ outcome: "pushed", held: [], leftOut: [] });
		expect(await h.remote()).toEqual({ "a.md": "A2", "b.md": "B2", "c.md": "C" });
		expect(h.vault.text("a.md")).toBe("typing");
		expect(h.backend.revision).not.toBe(head);
	});

	test("the push holds a path the pull put off also when the typing has stopped by then", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typed");
		h.backend.commit({ "a.md": "A2" });

		const { pull, push } = await h.sync({ pull: { automatic: true, ...typingIn("a.md") }, push: typingIn() });

		expect(pull.outcome).toBe("incomplete");
		expect(pathsToHoldQuietly(pull)).toEqual(["a.md"]);
		// Held, and nothing is told of it: no editor failed to save it.
		expect(push).toMatchObject({ outcome: "nothing-to-push", held: [], leftOut: [] });
		expect(pushReport(translatorFor("en"), push as PushRunResult, { sizeLimit: 50 * 1024 * 1024 }).details).toEqual([]);
		expect((await h.remote())["a.md"]).toBe("A2");
		expect(h.vault.text("a.md")).toBe("typed");
	});

	test("a file the pull put off for another reason is still told by the push that holds it", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "mine");
		h.vault.openFailing("a.md");
		h.backend.commit({ "a.md": "A2" });

		const { pull, push } = await h.sync();

		expect(pull.deferred).toEqual([{ path: "a.md", reason: "save-failed" }]);
		expect(pathsToHoldQuietly(pull)).toEqual([]);
		expect(push?.held).toEqual(["a.md"]);
	});

	test("a note that was renamed and is typed in: the old name is not deleted on the remote alone", async () => {
		const h = await synced({ "old.md": "the note", "b.md": "B", "gone.md": "G" });
		const before = await h.store.readRecords();
		h.vault.remove("old.md");
		h.vault.put("new.md", "the note, and typing");
		h.vault.remove("gone.md");
		h.vault.put("b.md", "B2");

		const result = await h.push(typingIn("new.md"));

		// The rest of the push is sent as ever; the deletions wait, all of them.
		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 }, held: [], leftOut: [] });
		expect(await h.remote()).toEqual({ "old.md": "the note", "b.md": "B2", "gone.md": "G" });
		const records = await h.store.readRecords();
		expect(records.find((record) => record.path === "old.md")).toEqual(before.find((record) => record.path === "old.md"));
		expect(pushReport(translatorFor("en"), result, { sizeLimit: 50 * 1024 * 1024 }).details).toEqual([]);

		// The typing has stopped: one commit with the new name and without the old.
		const pushes = h.backend.pushes;
		const next = await h.push(typingIn());
		expect(next).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 2 } });
		expect(h.backend.pushes).toBe(pushes + 1);
		expect(await h.remote()).toEqual({ "new.md": "the note, and typing", "b.md": "B2" });
	});

	test("with nothing but the deletion to send, nothing is sent while the new name is typed in", async () => {
		const h = await synced({ "old.md": "the note" });
		h.vault.remove("old.md");
		h.vault.put("new.md", "the note");

		expect((await h.push(typingIn("new.md"))).outcome).toBe("nothing-to-push");

		expect(await h.remote()).toEqual({ "old.md": "the note" });
		expect(h.backend.pushes).toBe(0);
	});

	test("a deletion is sent as before while a file that is known is typed in", async () => {
		const h = await synced({ "a.md": "A", "gone.md": "G" });
		h.vault.put("a.md", "typing");
		h.vault.remove("gone.md");

		const result = await h.push(typingIn("a.md"));

		expect(result).toMatchObject({ outcome: "pushed", counts: { deleted: 1 } });
		expect(await h.remote()).toEqual({ "a.md": "A" });
	});

	test("a deletion that is past the threshold is not asked about while it waits", async () => {
		const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, `note ${i}`]));
		const h = await synced(files);
		for (let i = 0; i < 8; i++) h.vault.remove(`n${i}.md`);
		h.vault.put("new.md", "typing");

		expect((await h.push(typingIn("new.md"))).outcome).toBe("nothing-to-push");
		expect(h.asked).toEqual([]);

		h.answer = "later";
		expect((await h.push(typingIn())).outcome).toBe("waiting");
		expect(h.asked).toHaveLength(1);
	});

	test("a push the user starts sends a rename whole, as before", async () => {
		const h = await synced({ "old.md": "the note" });
		h.vault.remove("old.md");
		h.vault.put("new.md", "the note");
		h.vault.open("new.md", "the note, typed");

		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, deleted: 1 } });

		expect(await h.remote()).toEqual({ "new.md": "the note, typed" });
	});

	test("a push the user starts is not held back: the editor saves, and the text is sent", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.open("a.md", "typed and saved by the push");

		expect((await h.push()).outcome).toBe("pushed");

		expect(await h.remote()).toEqual({ "a.md": "typed and saved by the push" });
	});
});

describe("a submodule whose inside the remote lists", () => {
	test("what was changed inside it is not sent, is told once, and everything else is sent", async () => {
		const h = harness();
		h.backend.listed.set("knowledge", { repository: "octo/knowledge", revision: "c".repeat(40) });
		h.backend.commit({ "a.md": "A", "knowledge/n.md": "N", "knowledge/gone.md": "G" });
		expect((await h.pull()).outcome).toBe("completed");
		h.vault.put("a.md", "A2");
		h.vault.put("knowledge/n.md", "mine");
		h.vault.put("knowledge/added.md", "new here");
		h.vault.remove("knowledge/gone.md");

		const first = await h.push();

		expect(first).toMatchObject({
			outcome: "pushed",
			counts: { added: 0, modified: 1, deleted: 0 },
			notices: [
				{ kind: "submodule-not-sent", path: "knowledge/added.md" },
				{ kind: "submodule-not-sent", path: "knowledge/gone.md" },
				{ kind: "submodule-not-sent", path: "knowledge/n.md" },
			],
		});
		expect(await h.remote()).toEqual({ "a.md": "A2", "knowledge/n.md": "N", "knowledge/gone.md": "G" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A2", "knowledge/n.md": "N", "knowledge/gone.md": "G" }));

		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push", notices: [] });
		expect((await h.pull()).notices).toEqual([]);
		expect(h.vault.text("knowledge/n.md")).toBe("mine");
	});
});

describe("links of the vault", () => {
	test("what lies below a link is not sent, and what was synced through it is not deleted", async () => {
		const h = await synced({ "a.md": "A", "Projects/p.md": "P" });
		h.vault.links = new Set(["Projects", "Ext"]);
		h.vault.putAll({ "a.md": "A2", "Projects/p.md": "P2", "Projects/new.md": "N", "Ext/x.md": "X" });

		const result = await h.push();

		expect(result.outcome).toBe("pushed");
		expect(await h.remote()).toEqual({ "a.md": "A2", "Projects/p.md": "P" });
		expect(h.emptyAsked).toEqual([]);
		expect(await readNotices(h.store)).toEqual(
			expect.arrayContaining([
				{ kind: "local-link", path: "Projects" },
				{ kind: "local-link", path: "Ext" },
			]),
		);
	});

	test("a vault whose synced files are all below a link is not taken for an empty one", async () => {
		const h = await synced({ "Projects/p.md": "P", "Projects/q.md": "Q" });
		h.vault.links = new Set(["Projects"]);
		h.vault.put("b.md", "B");

		const result = await h.push();

		expect(result.outcome).toBe("pushed");
		expect(h.emptyAsked).toEqual([]);
		expect(await h.remote()).toEqual({ "Projects/p.md": "P", "Projects/q.md": "Q", "b.md": "B" });
	});

	test("a link that is taken away deletes nothing on the remote, and is not asked about; what the remote has is fetched", async () => {
		const below = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Projects/p${i}.md`, `P${i}`]));
		const h = await synced({ "a.md": "A", ...below });
		h.vault.links = new Set(["Projects"]);
		expect((await h.push()).outcome).toBe("nothing-to-push");
		// The link is gone, and with it the files it showed.
		h.vault.links = null;
		for (const path of Object.keys(below)) h.vault.remove(path);

		const result = await h.push();

		// Six of seven records gone would be asked about, were they deletions.
		expect(result.outcome).toBe("nothing-to-push");
		expect(h.asked).toEqual([]);
		expect(h.emptyAsked).toEqual([]);
		expect(await h.remote()).toEqual({ "a.md": "A", ...below });
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));

		expect((await h.pull()).counts).toMatchObject({ fetched: 6, deleted: 0 });
		expect(h.pullAsked).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", ...below });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", ...below }));
	});

	test("a link whose target is gone deletes nothing on the remote", async () => {
		const h = await synced({ "a.md": "A", "Gone/p.md": "P" });
		// The listing leaves out a link that points nowhere.
		h.vault.remove("Gone/p.md");
		expect(await h.vault.removeFolderIfEmpty("Gone")).toBe(true);
		h.vault.log.length = 0;
		h.vault.links = new Set(["Gone"]);

		const result = await h.push();

		expect(result.outcome).toBe("nothing-to-push");
		expect(h.emptyAsked).toEqual([]);
		expect(await h.remote()).toEqual({ "a.md": "A", "Gone/p.md": "P" });
		expect(await readNotices(h.store)).toContainEqual({ kind: "local-link", path: "Gone" });
	});

	test("with the light check, a recorded file that is now a link whose target is gone is not deleted on the remote", async () => {
		const h = await synced({ "a.md": "A", "note.md": "N" });
		// The disk has nothing to stat at a link that points nowhere, and the index does not list it.
		h.vault.remove("note.md");
		h.vault.links = new Set(["note.md"]);
		const index = new MemoryIndex(h.vault);

		const result = await h.push({ index });

		expect(result.outcome).toBe("nothing-to-push");
		expect(h.emptyAsked).toEqual([]);
		expect(await h.remote()).toEqual({ "a.md": "A", "note.md": "N" });
		expect(await readNotices(h.store)).toContainEqual({ kind: "local-link", path: "note.md" });
	});

	test("with the light check, a file the index still holds that is now a link whose target is gone is not deleted on the remote", async () => {
		const h = await synced({ "a.md": "A", "dang.md": "D" });
		const index = new MemoryIndex(h.vault);
		// Put in the file's place; the index has not heard of it, and what
		// it holds is not the record's, so the disk is asked.
		h.vault.remove("dang.md");
		h.vault.links = new Set(["dang.md"]);
		index.set("dang.md", 1, 1);

		const result = await h.push({ index });

		expect(result.outcome).toBe("nothing-to-push");
		expect(h.emptyAsked).toEqual([]);
		expect(await h.remote()).toEqual({ "a.md": "A", "dang.md": "D" });
		expect(await readNotices(h.store)).toContainEqual({ kind: "local-link", path: "dang.md" });
	});

	test("with the light check, what is below a link is not sent, and nothing is deleted", async () => {
		const h = await synced({ "a.md": "A", "Projects/p.md": "P", "Projects/gone.md": "G" });
		await h.pull();
		h.vault.links = new Set(["Projects"]);
		h.vault.putAll({ "a.md": "A2", "Projects/p.md": "P2", "Projects/new.md": "N" });
		h.vault.remove("Projects/gone.md");
		// The index holds what is below a link to a folder outside the vault.
		const index = new MemoryIndex(h.vault);

		const result = await h.push({ index });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 0, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", "Projects/p.md": "P", "Projects/gone.md": "G" });
		expect(await readNotices(h.store)).toContainEqual({ kind: "local-link", path: "Projects" });
	});
});

describe("a file whose stat keeps telling a size of 0", () => {
	// As Android was seen to do for a file a pull had written where a folder
	// had just been taken away, while the content on disk was whole.
	function sizeZero(h: Harness, wrong: string): void {
		const stat = h.vault.stat.bind(h.vault);
		h.vault.stat = async (path) => {
			const real = await stat(path);
			return real?.type === "file" && path === wrong ? { ...real, size: 0 } : real;
		};
	}

	test("with its record's content: a push takes it as unchanged, sends nothing, and logs it", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		sizeZero(h, "a.md");
		const lines: string[] = [];

		const result = await h.push({ log: (line) => lines.push(line) });

		expect(result).toMatchObject({ outcome: "nothing-to-push" });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B" }));
		expect(lines.some((line) => /^scan: a\.md is 0 bytes by its stat and 1 read, .*taken as unchanged$/.test(line))).toBe(true);
	});

	test("with other content: a push leaves it out as unreadable, and logs it", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.put("a.md", "A2");
		h.vault.put("b.md", "B2");
		sizeZero(h, "a.md");
		const lines: string[] = [];

		const result = await h.push({ log: (line) => lines.push(line) });

		expect(result).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, leftOut: [{ path: "a.md", reason: "unreadable" }] });
		expect(await h.remote()).toEqual({ "a.md": "A", "b.md": "B2" });
		expect((await h.records())["a.md"]).toBe(blobHash("A"));
		expect(lines.some((line) => /^scan: a\.md is 0 bytes .*not its record's content, left alone$/.test(line))).toBe(true);
	});
});

describe("a push that walks the vault with the stats of the listing", () => {
	test("sends what was edited and deletes what is gone, asking the disk only of what the listing tells as changed", async () => {
		const h = await synced({ "a.md": "A", "notes/b.md": "B", "gone.md": "G" });
		// Records the times of the files the first pull wrote.
		await h.pull();
		h.vault.put("a.md", "A2");
		h.vault.put("notes/new.md", "N");
		h.vault.remove("gone.md");
		// What the listing of each folder holds of its files: what the disk says.
		const listedStats: ListedStats = async (folder) => {
			const before = h.vault.before;
			h.vault.before = undefined;
			try {
				const held = new Map<string, FileStat>();
				for (const path of (await h.vault.list(folder)).files) {
					const stat = await h.vault.stat(path);
					if (stat !== null) held.set(path, { mtime: stat.mtime, size: stat.size });
				}
				return held;
			} finally {
				h.vault.before = before;
			}
		};
		const ops: string[] = [];
		h.vault.before = (op, path) => {
			ops.push(`${op} ${path}`);
		};

		const result = await h.push({ listedStats });

		expect(result).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 1 } });
		expect(await h.remote()).toEqual({ "a.md": "A2", "notes/b.md": "B", "notes/new.md": "N" });
		// The file the listing tells as its record has it is neither asked of the disk nor read.
		expect(ops.filter((op) => op === "stat notes/b.md" || op === "read notes/b.md")).toEqual([]);
		expect(ops).toContain("read a.md");
		await expectNothingToPull(h);
	});
});
