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
import { BackendError, type BaseRelation, type FetchedFile, type ListResult } from "../src/core/backend";
import { conflictCopyPath, originalPathOfConflictCopy } from "../src/core/conflict-name";
import { readNotices } from "../src/core/notices";
import { applyPlan, type Seen, Tally } from "../src/core/pull-apply";
import { planPull } from "../src/core/pull-plan";
import { createExclusion } from "../src/core/exclusion";
import {
	PULL_CONFIRMATION_KEY,
	type PullAnswer,
	type PullConfirmRequest,
	type PullDeps,
	type PullProgress,
	type PullResult,
	readSymlinkTargets,
	runPull,
} from "../src/core/pull";
import { makeMarker, readBaseRevision, type StateStore } from "../src/core/state";
import { blobHash, bytes, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault, type VaultOp } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** A remote a test can bend: symlinks, no content at all, a history that cannot be checked. */
class TestBackend extends MemoryBackend {
	readonly symlinks = new Set<string>();
	emptied = false;
	checkBaseFails = false;
	checkedBase = 0;

	override async list(known: string | null): Promise<ListResult> {
		if (this.emptied) return { changed: true, listing: { revision: null, entries: [] } };
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		const entries = listed.listing.entries.map((entry) =>
			this.symlinks.has(entry.path) ? ({ ...entry, kind: "symlink" } as const) : entry,
		);
		return { changed: true, listing: { revision: listed.listing.revision, entries } };
	}

	override async checkBase(base: string, head: string): Promise<BaseRelation> {
		this.checkedBase += 1;
		if (this.checkBaseFails) throw new BackendError("unreachable", "timed out");
		return super.checkBase(base, head);
	}
}

/**
 * Stands in for the app being killed: from the `after`th change to the vault
 * or the sync state on, every call fails, as if nothing ran any more.
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
const VAULT_CHANGES = new Set<VaultOp>(["write", "rename", "trash", "remove-folder"]);

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
	/** Every request the user was shown. */
	readonly asked: PullConfirmRequest[];
	readonly progress: PullProgress[];
	answer: PullAnswer | (() => PullAnswer);
	/** What the bulk-write hook did, in order. */
	readonly views: string[];
	now(): number;
	/** Runs a pull one minute later, so that files written before are no longer recent. */
	pull(overrides?: Partial<PullDeps>): Promise<PullResult>;
	/** Path → hash of every record. */
	records(): Promise<Record<string, string>>;
	base(): Promise<string | null>;
	/** The name a conflict copy made by the last pull has. */
	copyName(path: string, attempt?: number): string;
	/** The files that are named like a conflict copy. */
	copies(): string[];
}

function harness(options: { caseSensitive?: boolean } = {}): Harness {
	let time = Date.UTC(2026, 9, 3, 12, 0, 0);
	const now = (): number => time;
	const backend = new TestBackend();
	const store = new MemoryStateStore();
	const crash = new Crash();
	const vault = new MemoryPullVault({ caseSensitive: options.caseSensitive ?? false, now });
	vault.before = (op) => crash.gate(VAULT_CHANGES.has(op));
	const guardedStore = guarded(store, crash);
	const asked: PullConfirmRequest[] = [];
	const progress: PullProgress[] = [];
	const views: string[] = [];

	const h: Harness = {
		backend,
		store,
		vault,
		crash,
		asked,
		progress,
		answer: "proceed",
		views,
		now,
		pull(overrides = {}) {
			time += 60_000;
			return runPull({
				store: guardedStore,
				backend,
				vault,
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now,
				confirm: async (request) => {
					asked.push(request);
					return typeof h.answer === "function" ? h.answer() : h.answer;
				},
				beginBulkWrite: async () => {
					views.push("close");
					return {
						closedViews: true,
						restore: async () => {
							views.push("reopen");
						},
					};
				},
				onProgress: (event) => progress.push(event),
				...overrides,
			});
		},
		async records() {
			const out: Record<string, string> = {};
			for (const record of await store.readRecords()) out[record.path] = record.hash;
			return out;
		},
		base: () => readBaseRevision(store),
		copyName: (path, attempt = 1) => conflictCopyPath(path, "iPhone", new Date(time), attempt),
		copies: () => vault.paths().filter((path) => originalPathOfConflictCopy(path) !== null),
	};
	return h;
}

function hashes(files: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, blobHash(content)]));
}

/** A harness whose vault and remote are in sync on `files`, after one pull. */
async function synced(
	files: Record<string, FileContent>,
	options: { caseSensitive?: boolean } = {},
): Promise<Harness> {
	const h = harness(options);
	h.backend.commit(files);
	const result = await h.pull();
	expect(result.outcome).toBe("completed");
	h.vault.log.length = 0;
	h.views.length = 0;
	h.progress.length = 0;
	return h;
}

/** Fetches like the backend, with some contents replaced. */
function tampered(backend: MemoryBackend, wrong: Record<string, string>): PullDeps["fetchContents"] {
	return async function* (revision, entries): AsyncIterable<FetchedFile> {
		for await (const file of backend.fetch(revision, entries)) {
			const other = wrong[file.entry.path];
			yield other === undefined ? file : { entry: file.entry, content: bytes(other) };
		}
	};
}

describe("a first fetch", () => {
	test("into an empty vault: every file is written and recorded, and the head becomes the base", async () => {
		const h = harness();
		const files = { "a.md": "A", "notes/b.md": "B", ".github/c.yml": "C" };
		const head = h.backend.commit(files);

		const result = await h.pull();

		expect(result).toMatchObject({
			outcome: "completed",
			revision: head,
			remoteEmpty: false,
			counts: { fetched: 3, deleted: 0, renamed: 0, conflicts: 0 },
			closedViews: true,
		});
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.records()).toEqual(hashes(files));
		expect(await h.base()).toBe(head);
		expect(await h.store.readMarkers()).toEqual([]);
		expect(h.asked).toEqual([]);
	});

	test("views are closed once, before the first write, and reopened at the end", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B" });
		h.vault.before = (op) => {
			if (op === "write") h.views.push("write");
		};
		await h.pull();
		expect(h.views).toEqual(["close", "write", "write", "reopen"]);
		const last = h.progress[h.progress.length - 1];
		expect(last).toMatchObject({ phase: "applying", done: 2, total: 2, closedViews: true });
	});

	test("that writes nothing closes nothing", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("a.md", "A");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.closedViews).toBe(false);
		expect(h.views).toEqual([]);
	});

	test("a later pull never closes views", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "b.md": "B" });
		expect((await h.pull()).closedViews).toBe(false);
		expect(h.views).toEqual([]);
	});

	test("views are reopened when the pull fails", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B" });
		// The sync state gives out after the first file is written.
		let writes = 0;
		h.vault.before = (op) => {
			if (op === "write" && ++writes === 2) h.crash.dead = true;
			h.crash.gate(false);
		};
		await expect(h.pull()).rejects.toThrow();
		expect(h.views).toEqual(["close", "reopen"]);
	});

	test("the same file is only recorded, a different one is a conflict, an extra one is left alone", async () => {
		const h = harness();
		const head = h.backend.commit({ "same.md": "S", "different.md": "theirs", "new.md": "N" });
		h.vault.putAll({ "same.md": "S", "different.md": "mine", "only-here.md": "O" });

		const result = await h.pull();

		const copy = h.copyName("different.md");
		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 2, deleted: 0, renamed: 0, conflicts: 1 });
		expect(result.conflicts).toEqual([{ path: "different.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({
			"same.md": "S",
			"different.md": "theirs",
			[copy]: "mine",
			"new.md": "N",
			"only-here.md": "O",
		});
		// The copy and the file that is only here have no record.
		expect(await h.records()).toEqual(hashes({ "same.md": "S", "different.md": "theirs", "new.md": "N" }));
		expect(h.vault.log.filter((line) => line.startsWith("write"))).toEqual([
			`write ${copy}`,
			"write different.md",
			"write new.md",
		]);
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
	});

	test("the copy is written before the file, and the file before its record", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		const order: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "write") order.push(`write ${path}`);
		};
		const store = new Proxy(h.store, {
			get(target, name) {
				const value: unknown = Reflect.get(target, name, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					const subject = args[0] as { path?: string } | string | undefined;
					if (["putMarker", "commitWrite", "deleteMarker"].includes(String(name))) {
						order.push(`${String(name)} ${typeof subject === "string" ? subject : subject?.path}`);
					}
					return (value as (...rest: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		await h.pull({ store });
		const copy = h.copyName("a.md");
		expect(order).toEqual([
			`putMarker ${copy}`,
			`write ${copy}`,
			"putMarker a.md",
			"write a.md",
			"commitWrite a.md",
			`deleteMarker ${copy}`,
		]);
	});
});

describe("records that were lost", () => {
	test("files that are the same get their record back without being fetched", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		for (const record of await h.store.readRecords()) await h.store.deleteRecord(record.key);
		h.backend.commit({ "c.md": "C" });

		const result = await h.pull({
			fetchContents: (_revision, entries) => {
				expect(entries.map((entry) => entry.path)).toEqual(["c.md"]);
				return h.backend.fetch(_revision, entries);
			},
		});

		expect(result.counts.fetched).toBe(1);
		expect(result.conflicts).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B", "c.md": "C" }));
	});

	test("a file that was not touched since its record is not read again", async () => {
		const h = await synced({ "a.md": "A" });
		// The first pull after the write hashes the file once more and keeps
		// its time and size; from then on it is not read.
		await h.pull();
		const read: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "read") read.push(path);
		};
		await h.pull();
		expect(read).toEqual([]);
	});
});

describe("a conflict", () => {
	test("a copy with the same content that is already there is used, not made again", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		const earlier = "a.conflict-from-iPhone-20260101-090000.md";
		h.vault.put(earlier, "mine");

		const result = await h.pull();

		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: earlier, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [earlier]: "mine" });
		expect(h.vault.log).toEqual(["write a.md"]);
	});

	test("a copy on the remote with the same content is used as well", async () => {
		const h = await synced({ "a.md": "A" });
		const onRemote = "a.conflict-from-Mac-20260101-090000.md";
		h.backend.commit({ "a.md": "theirs", [onRemote]: "mine" });
		h.vault.put("a.md", "mine");

		const result = await h.pull();

		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: onRemote, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [onRemote]: "mine" });
	});

	test("a copy the disk spells otherwise than the remote spells the file is used, not made again", async () => {
		const h = harness({ caseSensitive: false });
		h.backend.commit({ "Notes/b.md": "theirs" });
		h.vault.put("notes/b.md", "mine");
		const earlier = "notes/b.conflict-from-iPhone-20260101-090000.md";
		h.vault.put(earlier, "mine");

		const result = await h.pull();

		// The folder was renamed on the way, and the copy with it.
		const copy = "Notes/b.conflict-from-iPhone-20260101-090000.md";
		expect(result.conflicts).toEqual([{ path: "Notes/b.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "Notes/b.md": "theirs", [copy]: "mine" });
	});

	test("a copy of that name with other content gets a number", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		const result = await h.pull({
			// Another device of the same name made its copy in the same second.
			fetchContents: (revision, entries) => {
				h.vault.put(h.copyName("a.md"), "someone else's");
				return h.backend.fetch(revision, entries);
			},
		});
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: h.copyName("a.md", 2), cause: "conflict" }]);
		expect(h.vault.text(h.copyName("a.md", 2))).toBe("mine");
		expect(h.vault.text(h.copyName("a.md"))).toBe("someone else's");
	});

	test("a second pull finds nothing left to do", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		await h.pull();
		const after = h.vault.snapshot();
		h.vault.log.length = 0;

		const again = await h.pull();

		expect(again.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual(after);
		expect(h.vault.log).toEqual([]);
		expect(h.copies()).toHaveLength(1);
	});

	test("a copy that is itself in conflict gets the next number, never a copy of a copy", async () => {
		const copy = "a.conflict-from-Mac-20261003-221500.md";
		const h = await synced({ "a.md": "A", [copy]: "c1" });
		h.backend.commit({ [copy]: "c2" });
		h.vault.put(copy, "c-mine");

		const result = await h.pull();

		const second = "a.conflict-from-Mac-20261003-221500-2.md";
		expect(result.conflicts).toEqual([{ path: copy, copyPath: second, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", [copy]: "c2", [second]: "c-mine" });
		expect(h.copies().every((path) => originalPathOfConflictCopy(path) === "a.md")).toBe(true);
	});

	test("the remote deleted a file the vault edited: the file stays, with its record", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const head = h.backend.commit({ "a.md": null });
		h.vault.put("a.md", "edited");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("edited");
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B" }));
		expect(await h.base()).toBe(head);
	});

	test("the copy cannot be written: the file is not written either, and the path is reported", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const head = h.backend.commit({ "a.md": "theirs", "b.md": "B2" });
		h.vault.put("a.md", "mine");
		h.vault.before = (op, path) => {
			if (op === "write" && path.includes(".conflict-from-")) throw new Error("name too long");
		};

		const result = await h.pull();

		expect(result.unwritable).toMatchObject([{ path: "a.md", reason: "copy-unwritable" }]);
		expect(result.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "mine", "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		expect(await h.store.readMarkers()).toEqual([]);
		// A path the vault does not take does not hold the base back.
		expect(result.outcome).toBe("completed");
		expect(await h.base()).toBe(head);
	});

	test("stopped at any point and run again: one copy, the remote's content, one record", async () => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			const head = h.backend.commit({ "a.md": "theirs", "b.md": "B2" });
			h.vault.put("a.md", "mine");

			h.crash.after(after);
			await h.pull().catch(() => undefined);
			const stopped = h.crash.dead;
			h.crash.revive();
			// Whatever was written, the vault's content is still somewhere.
			expect(Object.values(h.vault.snapshot())).toContain("mine");

			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(h.vault.text("a.md")).toBe("theirs");
			expect(h.vault.text("b.md")).toBe("B2");
			expect(h.copies().map((path) => h.vault.text(path))).toEqual(["mine"]);
			expect(await h.records()).toEqual(hashes({ "a.md": "theirs", "b.md": "B2" }));
			expect(await h.base()).toBe(head);
			expect(h.vault.trashed).toEqual([]);
			if (!stopped) break;
			stops += 1;
		}
		// Listing, marker, copy, marker, file, record, marker, and more.
		expect(stops).toBeGreaterThan(8);
	});
});

describe("typing while the pull runs", () => {
	test("what was typed and not saved shows before a file is written over, and is kept", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2" });
		h.vault.open("a.md", "A typed");

		const result = await h.pull();

		const copy = h.copyName("a.md");
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", [copy]: "A typed" });
		expect(result.outcome).toBe("completed");
	});

	test("what was typed shows before a file is deleted: the file and its record stay, and nothing waits", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const head = h.backend.commit({ "a.md": null, "b.md": "B2" });
		h.vault.open("a.md", "A typed");

		const result = await h.pull();

		// Deleted there, changed here: the same as if the plan had seen it.
		expect(result.outcome).toBe("completed");
		expect(result.deferred).toEqual([]);
		expect(result.counts).toEqual({ fetched: 1, deleted: 0, renamed: 0, conflicts: 0 });
		expect(h.vault.snapshot()).toEqual({ "a.md": "A typed", "b.md": "B2" });
		expect(h.vault.trashed).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		expect(await h.base()).toBe(head);
	});

	test("an edit between the decision and the write makes it a conflict", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2" });
		const result = await h.pull({
			fetchContents: (revision, entries) => {
				h.vault.put("a.md", "edited late");
				return h.backend.fetch(revision, entries);
			},
		});
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: h.copyName("a.md"), cause: "conflict" }]);
		expect(h.vault.text("a.md")).toBe("A2");
		expect(h.vault.text(h.copyName("a.md"))).toBe("edited late");
	});

	test("a file that appears where there was none is a conflict, not written over", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "theirs" });
		const result = await h.pull({
			fetchContents: (revision, entries) => {
				h.vault.put("a.md", "made just now");
				return h.backend.fetch(revision, entries);
			},
		});
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: h.copyName("a.md"), cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [h.copyName("a.md")]: "made just now" });
	});

	test("typed once more while the copy was made: the copy is written again with the newer text", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		// One text per save: before the look, before the read, before the write.
		h.vault.open("a.md", "t1", "t2", "t3");
		const markers: string[] = [];
		const putMarker = h.store.putMarker.bind(h.store);
		h.store.putMarker = (marker) => {
			if (marker.conflictCopy) markers.push(`${marker.before} -> ${marker.writing}`);
			return putMarker(marker);
		};

		const result = await h.pull();

		const copy = h.copyName("a.md");
		// The second marker says what the copy held when it was written again.
		expect(markers).toEqual([`null -> ${blobHash("t2")}`, `${blobHash("t2")} -> ${blobHash("t3")}`]);
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "t3" });
		expect(h.vault.log.filter((line) => line.startsWith("write"))).toEqual([
			`write ${copy}`,
			`write ${copy}`,
			"write a.md",
		]);
		expect(await h.store.readMarkers()).toEqual([]);
	});

	test("typed on and on: the file is left alone, the copy goes to the trash, and the base stays", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const base = await h.base();
		h.backend.commit({ "a.md": "theirs", "b.md": "B2" });
		h.vault.put("a.md", "mine");
		h.vault.open("a.md", "t1", "t2", "t3", "t4", "t5", "t6");

		const result = await h.pull();

		const copy = h.copyName("a.md");
		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([{ path: "a.md", reason: "changed-during-pull" }]);
		expect(result.conflicts).toEqual([]);
		expect(result.trashed).toEqual([copy]);
		expect(h.vault.trashed).toEqual([{ path: copy, mode: "vault-trash", content: "t4" }]);
		// Everything that was typed up to the last save is in the file.
		expect(h.vault.snapshot()).toEqual({ "a.md": "t5", "b.md": "B2" });
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		expect(await h.base()).toBe(base);

		// Once the typing stops, the next sync brings it to an end.
		h.vault.close("a.md");
		const next = await h.pull();
		expect(next.outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("theirs");
		expect(h.copies().map((path) => h.vault.text(path))).toEqual(["t5"]);
	});

	test.each(["write", "delete"] as const)(
		"an editor that cannot save: nothing is done to the file (%s)",
		async (kind) => {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			const base = await h.base();
			h.backend.commit({ "a.md": kind === "write" ? "A2" : null, "b.md": "B2" });
			h.vault.openFailing("a.md");

			const result = await h.pull();

			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "a.md", reason: "save-failed" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B2" });
			expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(base);
		},
	);

	test("an editor that cannot save in the middle of a conflict: the copy is taken back", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		let saves = 0;
		h.vault.before = (op, path) => {
			// The look, the read, and then the save before the write.
			if (op === "save" && path === "a.md" && ++saves === 3) h.vault.openFailing("a.md");
		};

		const result = await h.pull();

		expect(result.deferred).toEqual([{ path: "a.md", reason: "save-failed" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "mine" });
		expect(h.vault.trashed).toMatchObject([{ path: h.copyName("a.md"), mode: "vault-trash" }]);
		expect(await h.store.readMarkers()).toEqual([]);
	});
});

describe("content that cannot be trusted or fetched", () => {
	test("content that does not match its hash is not written, and the file waits", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const base = await h.base();
		h.backend.commit({ "a.md": "A2", "b.md": "B2", "c.md": "C" });

		const result = await h.pull({ fetchContents: tampered(h.backend, { "a.md": "garbage", "c.md": "garbage" }) });

		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([
			{ path: "a.md", reason: "hash-mismatch" },
			{ path: "c.md", reason: "hash-mismatch" },
		]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(base);

		const next = await h.pull();
		expect(next.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B2", "c.md": "C" });
	});

	test("fetching that fails halfway keeps what was written and puts off the rest", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B", "c.md": "C" });
		const failure = new BackendError("unreachable", "offline");

		const result = await h.pull({
			fetchContents: async function* (revision, entries) {
				let count = 0;
				for await (const file of h.backend.fetch(revision, entries)) {
					if (count++ === 1) throw failure;
					yield file;
				}
			},
		});

		expect(result.outcome).toBe("incomplete");
		expect(result.fetchError).toBe(failure);
		expect(result.deferred).toEqual([
			{ path: "b.md", reason: "fetch-failed" },
			{ path: "c.md", reason: "fetch-failed" },
		]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));
		expect(await h.base()).toBeNull();
		expect(h.views).toEqual(["close", "reopen"]);
	});

	test("contents that come in another order than the listing give the same pull", async () => {
		// A remote that fetches several at a time yields them as they arrive.
		const reversed = (backend: MemoryBackend): PullDeps["fetchContents"] =>
			async function* (revision, entries): AsyncIterable<FetchedFile> {
				const files: FetchedFile[] = [];
				for await (const file of backend.fetch(revision, entries)) files.push(file);
				yield* files.reverse();
			};
		const run = async (source?: (backend: MemoryBackend) => PullDeps["fetchContents"]) => {
			const h = await synced({ "a.md": "A", "b.md": "B", "gone.md": "G", "notes/c.md": "C" });
			const head = h.backend.commit({
				"a.md": "A2",
				"gone.md": null,
				"notes/c.md": "C2",
				"notes/d.md": "D",
				"e.md": "E",
				"z/f.md": "F",
			});
			const order: string[] = [];
			const fetchContents = source?.(h.backend) ?? ((revision, entries) => h.backend.fetch(revision, entries));
			const result = await h.pull({
				fetchContents: async function* (revision, entries) {
					for await (const file of fetchContents(revision, entries)) {
						order.push(file.entry.path);
						yield file;
					}
				},
			});
			return {
				result,
				order,
				files: h.vault.snapshot(),
				records: await h.records(),
				atHead: (await h.base()) === head,
				last: h.progress[h.progress.length - 1],
			};
		};

		const inOrder = await run();
		const shuffled = await run(reversed);

		expect(inOrder.order.length).toBeGreaterThan(2);
		expect(shuffled.order).toEqual([...inOrder.order].reverse());
		expect(shuffled.result.outcome).toBe("completed");
		expect(shuffled.result.counts).toEqual({ fetched: 5, deleted: 1, renamed: 0, conflicts: 0 });
		expect(shuffled.result).toEqual(inOrder.result);
		expect(shuffled.files).toEqual(inOrder.files);
		expect(shuffled.files).toEqual({
			"a.md": "A2",
			"b.md": "B",
			"notes/c.md": "C2",
			"notes/d.md": "D",
			"e.md": "E",
			"z/f.md": "F",
		});
		expect(shuffled.records).toEqual(inOrder.records);
		expect(shuffled.atHead).toBe(true);
		expect(shuffled.last).toEqual(inOrder.last);
	});

	test("the sizes of the listing are passed on to whatever fetches", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "12345" });
		let sizes: (number | undefined)[] = [];
		await h.pull({
			fetchContents: (revision, entries) => {
				sizes = entries.map((entry) => entry.size);
				return h.backend.fetch(revision, entries);
			},
		});
		expect(sizes).toEqual([5]);
	});

	test("a path the vault refuses is reported, the others are written, and the base moves", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "A", "bad:name.md": "X" });
		h.vault.before = (op, path) => {
			if (op === "write" && path.includes(":")) throw new Error("not a name");
		};
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.unwritable).toMatchObject([{ path: "bad:name.md", reason: "write-failed", isNew: true }]);
		expect(result.notices).toEqual([{ kind: "unwritable-path", path: "bad:name.md" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
	});

	test("a path the vault keeps refusing is listed every time and told once, until it is written or gone", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "bad:name.md": "X", "worse:name.md": "Y" });
		h.vault.before = (op, path) => {
			if (op === "write" && path.includes(":")) throw new Error("not a name");
		};
		const first = await h.pull();
		expect(first.notices.map((notice) => notice.path)).toEqual(["bad:name.md", "worse:name.md"]);

		const second = await h.pull();
		expect(second.unwritable).toMatchObject([
			{ path: "bad:name.md", reason: "write-failed", isNew: false },
			{ path: "worse:name.md", reason: "write-failed", isNew: false },
		]);
		expect(second.notices).toEqual([]);

		// A pull that does not get to the writes forgets nothing.
		const stop = new AbortController();
		stop.abort();
		await h.pull({ signal: stop.signal });
		expect((await readNotices(h.store)).map((notice) => notice.path)).toEqual(["bad:name.md", "worse:name.md"]);

		// One is written at last, the other is renamed on the remote.
		h.vault.before = undefined;
		h.backend.commit({ "worse:name.md": null, "better.md": "Y" });
		const third = await h.pull();
		expect(third.unwritable).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "bad:name.md": "X", "better.md": "Y" });

		// Refused again later: told again.
		h.backend.commit({ "bad:name.md": "X2" });
		h.vault.before = (op, path) => {
			if (op === "write" && path.includes(":")) throw new Error("not a name");
		};
		expect((await h.pull()).notices).toEqual([{ kind: "unwritable-path", path: "bad:name.md" }]);
	});
});

describe("a rename that only changes the case", () => {
	const before = { "notes/a.md": "A", "notes/b.md": "B", "c.md": "C" };

	function renameOnRemote(h: Harness): string {
		return h.backend.commit({ "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "A", "Notes/b.md": "B2" });
	}

	test.each([
		["a vault that does not tell the cases apart", false],
		["a vault that tells the cases apart", true],
	])("the folder is renamed in one call, and no file is deleted (%s)", async (_name, caseSensitive) => {
		const h = await synced(before, { caseSensitive });
		const head = renameOnRemote(h);
		h.vault.put("notes/unsent.md", "U");

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 1, deleted: 0, renamed: 2, conflicts: 0 });
		expect(h.vault.log).toEqual(["rename notes -> Notes", "write Notes/b.md"]);
		expect(h.vault.snapshot()).toEqual({ "Notes/a.md": "A", "Notes/b.md": "B2", "Notes/unsent.md": "U", "c.md": "C" });
		expect(h.vault.folderPaths()).toEqual(["Notes"]);
		expect(await h.records()).toEqual(hashes({ "Notes/a.md": "A", "Notes/b.md": "B2", "c.md": "C" }));
		expect(h.vault.trashed).toEqual([]);
		expect(await h.base()).toBe(head);
		expect(h.asked).toEqual([]);
	});

	test.each([
		["a vault that does not tell the cases apart", false],
		["a vault that tells the cases apart", true],
	])("stopped at any point and run again: nothing is lost and no copy is made (%s)", async (_name, caseSensitive) => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = await synced(before, { caseSensitive });
			const head = renameOnRemote(h);

			h.crash.after(after);
			await h.pull().catch(() => undefined);
			const stopped = h.crash.dead;
			h.crash.revive();

			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(result.conflicts).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "Notes/a.md": "A", "Notes/b.md": "B2", "c.md": "C" });
			expect(await h.records()).toEqual(hashes({ "Notes/a.md": "A", "Notes/b.md": "B2", "c.md": "C" }));
			expect(h.vault.trashed).toEqual([]);
			expect(await h.base()).toBe(head);
			if (!stopped) break;
			stops += 1;
		}
		expect(stops).toBeGreaterThan(5);
	});

	test("a folder of the new name is already there: the files move one by one, and what is in it stays", async () => {
		const h = await synced(before, { caseSensitive: true });
		renameOnRemote(h);
		h.vault.putAll({ "Notes/x.md": "X", "notes/unsent.md": "U" });

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({
			"Notes/a.md": "A",
			"Notes/b.md": "B2",
			"Notes/unsent.md": "U",
			"Notes/x.md": "X",
			"c.md": "C",
		});
		expect(h.vault.folderPaths()).toEqual(["Notes"]);
		expect(h.vault.log.filter((line) => line.startsWith("rename"))).toEqual([
			"rename notes/a.md -> Notes/a.md",
			"rename notes/b.md -> Notes/b.md",
			"rename notes/unsent.md -> Notes/unsent.md",
		]);
		expect(await h.records()).toEqual(hashes({ "Notes/a.md": "A", "Notes/b.md": "B2", "c.md": "C" }));
	});

	test("a file of the new name is already there: it moves to a copy named after the new spelling", async () => {
		const h = await synced({ "notes.md": "N" }, { caseSensitive: true });
		h.backend.commit({ "notes.md": null, "Notes.md": "N" });
		h.vault.put("Notes.md", "made here");

		const result = await h.pull();

		const copy = h.copyName("Notes.md");
		expect(result.conflicts).toEqual([{ path: "Notes.md", copyPath: copy, cause: "name-taken" }]);
		expect(h.vault.snapshot()).toEqual({ "Notes.md": "N", [copy]: "made here" });
		expect(h.vault.log).toEqual([`rename Notes.md -> ${copy}`, "rename notes.md -> Notes.md"]);
		expect(await h.records()).toEqual(hashes({ "Notes.md": "N" }));
	});

	test("the old file was edited as well: two copies, both named after the new spelling", async () => {
		const h = await synced({ "notes.md": "N" }, { caseSensitive: true });
		h.backend.commit({ "notes.md": null, "Notes.md": "N2" });
		h.vault.putAll({ "Notes.md": "made here", "notes.md": "edited here" });

		const result = await h.pull();

		const [first, second] = [h.copyName("Notes.md"), h.copyName("Notes.md", 2)];
		expect(result.conflicts).toEqual([
			{ path: "Notes.md", copyPath: first, cause: "name-taken" },
			{ path: "Notes.md", copyPath: second, cause: "conflict" },
		]);
		expect(h.vault.snapshot()).toEqual({ "Notes.md": "N2", [first]: "made here", [second]: "edited here" });
	});

	test("the new name already holds the remote's content: the old file goes, or is kept as a copy", async () => {
		const unchanged = await synced({ "notes.md": "N" }, { caseSensitive: true });
		unchanged.backend.commit({ "notes.md": null, "Notes.md": "N2" });
		unchanged.vault.put("Notes.md", "N2");
		const first = await unchanged.pull();
		expect(first.conflicts).toEqual([]);
		expect(unchanged.vault.snapshot()).toEqual({ "Notes.md": "N2" });
		expect(unchanged.vault.log).toEqual(["trash notes.md (user-setting)"]);
		expect(await unchanged.records()).toEqual(hashes({ "Notes.md": "N2" }));

		const edited = await synced({ "notes.md": "N" }, { caseSensitive: true });
		edited.backend.commit({ "notes.md": null, "Notes.md": "N2" });
		edited.vault.putAll({ "Notes.md": "N2", "notes.md": "edited here" });
		const second = await edited.pull();
		const copy = edited.copyName("Notes.md");
		expect(second.conflicts).toEqual([{ path: "Notes.md", copyPath: copy, cause: "name-taken" }]);
		expect(edited.vault.snapshot()).toEqual({ "Notes.md": "N2", [copy]: "edited here" });
		expect(edited.vault.trashed).toEqual([]);
		expect(await edited.records()).toEqual(hashes({ "Notes.md": "N2" }));
	});

	test("an unsent file of the old folder whose name is taken in the new one moves to a copy there", async () => {
		const h = await synced({ "notes/a.md": "A" }, { caseSensitive: true });
		h.backend.commit({ "notes/a.md": null, "Notes/a.md": "A" });
		h.vault.putAll({ "Notes/x.md": "X in the new folder", "notes/x.md": "X in the old folder" });
		const result = await h.pull();
		const copy = h.copyName("Notes/x.md");
		expect(result.conflicts).toEqual([{ path: "Notes/x.md", copyPath: copy, cause: "name-taken" }]);
		expect(h.vault.snapshot()).toEqual({
			"Notes/a.md": "A",
			"Notes/x.md": "X in the new folder",
			[copy]: "X in the old folder",
		});
		expect(h.vault.folderPaths()).toEqual(["Notes"]);
	});

	test("a file of the new name that cannot be moved to a copy is told once, with the rename it holds up", async () => {
		const h = await synced({ "notes.md": "N" }, { caseSensitive: true });
		h.backend.commit({ "notes.md": null, "Notes.md": "N2" });
		h.vault.put("Notes.md", "made here");
		h.vault.before = (op, path) => {
			if (op === "rename" && path === "Notes.md") throw new Error("busy");
		};

		const first = await h.pull();

		expect(first.unwritable).toMatchObject([
			{ path: "Notes.md", reason: "rename-failed", isNew: true },
			{ path: "Notes.md", reason: "depends-on-unwritable", isNew: false },
		]);
		expect(first.notices).toEqual([{ kind: "unwritable-path", path: "Notes.md" }]);
		expect(h.vault.snapshot()).toEqual({ "Notes.md": "made here", "notes.md": "N" });

		const second = await h.pull();
		expect(second.unwritable).toMatchObject([
			{ path: "Notes.md", reason: "rename-failed", isNew: false },
			{ path: "Notes.md", reason: "depends-on-unwritable", isNew: false },
		]);
		expect(second.notices).toEqual([]);

		h.vault.before = undefined;
		const third = await h.pull();
		expect(third.unwritable).toEqual([]);
		expect(h.vault.text("Notes.md")).toBe("N2");
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("an unsent file of the old folder that cannot be moved to a copy is told, under where it is", async () => {
		const h = await synced({ "notes/a.md": "A" }, { caseSensitive: true });
		h.backend.commit({ "notes/a.md": null, "Notes/a.md": "A" });
		h.vault.putAll({ "Notes/x.md": "X in the new folder", "notes/x.md": "X in the old folder" });
		h.vault.before = (op, path) => {
			if (op === "rename" && path === "notes/x.md") throw new Error("busy");
		};

		const first = await h.pull();

		expect(first.unwritable).toMatchObject([{ path: "notes/x.md", reason: "rename-failed", isNew: true }]);
		expect(first.notices).toEqual([{ kind: "unwritable-path", path: "notes/x.md" }]);
		expect(first.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({
			"Notes/a.md": "A",
			"Notes/x.md": "X in the new folder",
			"notes/x.md": "X in the old folder",
		});

		// The other files of the folder are renamed by now, so nothing moves
		// this one any more: it is left where it is, and forgotten.
		const second = await h.pull();
		expect(second.unwritable).toEqual([]);
		expect(second.notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a folder that cannot be listed while the plan is carried out: the file waits, no record is respelled", async () => {
		const h = await synced({ "notes/a.md": "A" });
		const base = await h.base();
		h.backend.commit({ "notes/a.md": null, "Notes/a.md": "A2" });
		let applying = false;
		let failed = false;
		h.vault.before = (op) => {
			if (op !== "list" || !applying || failed) return;
			failed = true;
			throw new Error("busy");
		};

		const result = await h.pull({
			onProgress: (event) => {
				applying = event.phase === "applying";
			},
		});

		expect(failed).toBe(true);
		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([
			{ path: "notes/a.md", reason: "unreadable" },
			{ path: "Notes/a.md", reason: "depends-on-deferred" },
		]);
		expect(h.vault.snapshot()).toEqual({ "notes/a.md": "A" });
		expect(await h.records()).toEqual(hashes({ "notes/a.md": "A" }));
		expect(await h.base()).toBe(base);

		h.vault.before = undefined;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "Notes/a.md": "A2" });
		expect(await h.records()).toEqual(hashes({ "Notes/a.md": "A2" }));
	});

	test("a rename that is accepted and not made: nothing is recorded under the new spelling", async () => {
		const h = await synced({ "notes/a.md": "A" });
		h.backend.commit({ "notes/a.md": null, "Notes/a.md": "A2" });
		h.vault.ignoreRenames = true;

		const result = await h.pull();

		expect(result.unwritable).toMatchObject([
			{ path: "notes/a.md", reason: "rename-failed", isNew: true },
			{ path: "Notes/a.md", reason: "depends-on-unwritable", isNew: false },
		]);
		expect(result.notices).toEqual([{ kind: "unwritable-path", path: "Notes/a.md" }]);
		expect(h.vault.snapshot()).toEqual({ "notes/a.md": "A" });
		expect(await h.records()).toEqual(hashes({ "notes/a.md": "A" }));

		h.vault.ignoreRenames = false;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "Notes/a.md": "A2" });
		expect(await h.records()).toEqual(hashes({ "Notes/a.md": "A2" }));
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a file that is under neither spelling any more is reported, and its record stays", async () => {
		const h = await synced({ "notes.md": "N", "b.md": "B" });
		h.backend.commit({ "notes.md": null, "Notes.md": "N2", "b.md": "B2" });
		const result = await h.pull({
			onProgress: (event) => {
				if (event.phase === "applying") h.vault.remove("notes.md");
			},
		});
		expect(result.unwritable).toMatchObject([
			{ path: "notes.md", reason: "rename-failed" },
			{ path: "Notes.md", reason: "depends-on-unwritable" },
		]);
		expect(h.vault.snapshot()).toEqual({ "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ "notes.md": "N", "b.md": "B2" }));
		// The next plan sees a file that is gone here and new there.
		await h.pull();
		expect(h.vault.snapshot()).toEqual({ "Notes.md": "N2", "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ "Notes.md": "N2", "b.md": "B2" }));
	});

	test("a nested folder whose new name the parent's rename brings along: the files move one by one", async () => {
		const h = await synced({ "notes/sub/a.md": "A" }, { caseSensitive: true });
		h.backend.commit({ "notes/sub/a.md": null, "Notes/Sub/a.md": "A" });
		h.vault.putAll({ "notes/Sub/x.md": "X", "notes/sub/unsent.md": "U" });

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({
			"Notes/Sub/a.md": "A",
			"Notes/Sub/unsent.md": "U",
			"Notes/Sub/x.md": "X",
		});
		expect(h.vault.folderPaths()).toEqual(["Notes", "Notes/Sub"]);
		expect(h.vault.log).toEqual([
			"rename notes -> Notes",
			"rename Notes/sub/a.md -> Notes/Sub/a.md",
			"rename Notes/sub/unsent.md -> Notes/Sub/unsent.md",
			"remove-folder Notes/sub",
		]);
		expect(await h.records()).toEqual(hashes({ "Notes/Sub/a.md": "A" }));
	});

	test("a rename the vault refuses is reported, and the write that would follow is not made", async () => {
		const h = await synced({ "notes.md": "N" });
		h.backend.commit({ "notes.md": null, "Notes.md": "N2" });
		h.vault.before = (op) => {
			if (op === "rename") throw new Error("busy");
		};
		const result = await h.pull();
		expect(result.unwritable).toMatchObject([
			{ path: "notes.md", reason: "rename-failed" },
			{ path: "Notes.md", reason: "depends-on-unwritable" },
		]);
		expect(h.vault.snapshot()).toEqual({ "notes.md": "N" });
		expect(await h.records()).toEqual(hashes({ "notes.md": "N" }));
	});
});

describe("files and folders that trade places", () => {
	test("a folder becomes a file: its files go, the folder is removed, the file is written", async () => {
		const h = await synced({ "a/x.md": "X", "a/y.md": "Y" });
		h.backend.commit({ "a/x.md": null, "a/y.md": null, a: "now a file" });
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ a: "now a file" });
		expect(h.asked).toEqual([]);
	});

	test("a folder becomes a file, stopped at any point and run again: the file is written in the end", async () => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = await synced({ "a/x.md": "X", "a/y.md": "Y", "b.md": "B" });
			const head = h.backend.commit({ "a/x.md": null, "a/y.md": null, a: "now a file" });

			h.crash.after(after);
			await h.pull().catch(() => undefined);
			const stopped = h.crash.dead;
			h.crash.revive();

			const result = await h.pull();

			expect(result.unwritable).toEqual([]);
			expect(result.outcome).toBe("completed");
			expect(h.vault.snapshot()).toEqual({ a: "now a file", "b.md": "B" });
			expect(await h.records()).toEqual(hashes({ a: "now a file", "b.md": "B" }));
			expect(await h.base()).toBe(head);
			if (!stopped) break;
			stops += 1;
		}
		expect(stops).toBeGreaterThan(5);
	});

	test("an empty folder where the remote adds a file makes way; one with a file in it does not", async () => {
		const h = harness();
		h.backend.commit({ notes: "a file", drafts: "another" });
		h.vault.makeFolder("notes");
		h.vault.put("drafts/.hidden-by-a-rule.icloud", "kept");

		const result = await h.pull();

		expect(result.unwritable).toMatchObject([{ path: "drafts", reason: "folder-in-the-way" }]);
		expect(h.vault.snapshot()).toEqual({ notes: "a file", "drafts/.hidden-by-a-rule.icloud": "kept" });
		expect(await h.records()).toEqual(hashes({ notes: "a file" }));
	});

	test("an unsent file where the remote now has a folder moves to a copy", async () => {
		const h = harness();
		h.backend.commit({ "a/x.md": "X" });
		h.vault.put("a", "mine");
		const result = await h.pull();
		const copy = h.copyName("a");
		expect(result.conflicts).toEqual([{ path: "a", copyPath: copy, cause: "became-folder" }]);
		expect(h.vault.snapshot()).toEqual({ "a/x.md": "X", [copy]: "mine" });
	});

	test("an unsent file that cannot be moved out of the way of a folder is told once, until it is moved", async () => {
		const h = harness();
		h.backend.commit({ "a/x.md": "X" });
		h.vault.put("a", "mine");
		h.vault.before = (op) => {
			if (op === "rename") throw new Error("busy");
		};

		const first = await h.pull();

		// The file that stayed, and the file of the remote it is in the way of.
		expect(first.unwritable).toMatchObject([
			{ path: "a", reason: "rename-failed", isNew: true },
			{ path: "a/x.md", reason: "write-failed", isNew: true },
		]);
		expect(first.notices).toEqual([
			{ kind: "unwritable-path", path: "a" },
			{ kind: "unwritable-path", path: "a/x.md" },
		]);
		expect(first.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ a: "mine" });

		const second = await h.pull();
		expect(second.unwritable).toMatchObject([
			{ path: "a", reason: "rename-failed", isNew: false },
			{ path: "a/x.md", reason: "write-failed", isNew: false },
		]);
		expect(second.notices).toEqual([]);

		h.vault.before = undefined;
		const third = await h.pull();
		const copy = h.copyName("a");
		expect(third.unwritable).toEqual([]);
		expect(third.conflicts).toEqual([{ path: "a", copyPath: copy, cause: "became-folder" }]);
		expect(h.vault.snapshot()).toEqual({ "a/x.md": "X", [copy]: "mine" });
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("folders the pull emptied are removed; a folder that was empty before is not", async () => {
		const h = await synced({ "gone/deep/a.md": "A", "kept/b.md": "B" });
		h.vault.makeFolder("mine-and-empty");
		h.backend.commit({ "gone/deep/a.md": null });
		await h.pull();
		expect(h.vault.folderPaths()).toEqual(["kept", "mine-and-empty"]);
	});
});

describe("deleting many files", () => {
	const many = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, `F${i}`]),
	);

	async function withTenDeleted(): Promise<{ h: Harness; head: string; base: string | null }> {
		const h = await synced(many);
		const base = await h.base();
		const gone = Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null]));
		const head = h.backend.commit({ ...gone, "new.md": "N" });
		return { h, head, base };
	}

	test("declined: nothing is changed, not even what is no deletion", async () => {
		const { h, base } = await withTenDeleted();
		await h.store.setMeta(PULL_CONFIRMATION_KEY, { rewritten: false, deletions: ["f00.md"], overwrites: [] });
		h.answer = "cancel";

		const result = await h.pull();

		expect(result.outcome).toBe("declined");
		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.losses.rewritten).toBe(false);
		expect(h.asked[0]?.losses.deletions).toHaveLength(10);
		expect(h.asked[0]?.recordCount).toBe(12);
		expect(h.vault.snapshot()).toEqual(many);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes(many));
		expect(await h.base()).toBe(base);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
	});

	test("an answer that is only offered for a rewritten history counts as no", async () => {
		const { h } = await withTenDeleted();
		h.answer = "keep-local";
		expect((await h.pull()).outcome).toBe("declined");
		expect(h.vault.snapshot()).toEqual(many);
	});

	test("confirmed: the files go where the app's setting sends them", async () => {
		const { h, head } = await withTenDeleted();

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.counts).toMatchObject({ deleted: 10, fetched: 1 });
		expect(h.vault.paths()).toEqual(["f10.md", "f11.md", "new.md"]);
		expect(h.vault.trashed.map((file) => file.mode)).toEqual(Array.from({ length: 10 }, () => "user-setting"));
		expect(result.trashed).toEqual([]);
		expect(await h.base()).toBe(head);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
	});

	test("stopped halfway and resumed: what is left was confirmed, and is not asked about again", async () => {
		const { h, head, base } = await withTenDeleted();
		const stop = new AbortController();
		let trashed = 0;
		h.vault.before = (op) => {
			if (op === "trash" && ++trashed === 2) stop.abort();
		};

		const first = await h.pull({ signal: stop.signal });

		expect(first.outcome).toBe("cancelled");
		expect(first.counts.deleted).toBe(2);
		expect(h.vault.paths()).toHaveLength(10);
		expect(Object.keys(await h.records())).toHaveLength(10);
		expect(await h.base()).toBe(base);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toMatchObject({ rewritten: false });

		h.vault.before = undefined;
		const second = await h.pull();

		expect(h.asked).toHaveLength(1);
		expect(second.outcome).toBe("completed");
		expect(h.vault.paths()).toEqual(["f10.md", "f11.md", "new.md"]);
		expect(await h.base()).toBe(head);
	});

	test("one deleted path more than was confirmed is asked about again", async () => {
		const { h } = await withTenDeleted();
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		await h.pull({ signal: stop.signal });
		h.vault.before = undefined;
		h.backend.commit({ "f10.md": null });
		await h.pull();
		expect(h.asked).toHaveLength(2);
	});

	test("a few deletions are carried out without asking", async () => {
		const h = await synced(many);
		h.backend.commit({ "f00.md": null, "f01.md": null });
		const result = await h.pull();
		expect(result.counts.deleted).toBe(2);
		expect(h.asked).toEqual([]);
	});
});

describe("a history that was rewritten", () => {
	/** This device's last pull was of a commit the remote no longer has. */
	async function rewritten(): Promise<{ h: Harness; head: string; base: string | null }> {
		const h = await synced({ "a.md": "A1", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "c.md": "C" });
		await h.pull();
		const base = await h.base();
		h.vault.log.length = 0;
		const head = h.backend.rewriteHistory({ "a.md": "A1", "b.md": "B", "d.md": "D" });
		return { h, head, base };
	}

	test("one deletion and one overwrite are enough to ask, and say so", async () => {
		const { h } = await rewritten();
		h.answer = "cancel";
		await h.pull();
		expect(h.asked).toEqual([
			{
				losses: {
					rewritten: true,
					deletions: [{ key: "c.md", path: "c.md" }],
					overwrites: [{ key: "a.md", path: "a.md" }],
				},
				recordCount: 3,
			},
		]);
	});

	test("proceed: each file goes to the trash of the vault before it is deleted or written over", async () => {
		const { h, head } = await rewritten();

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "completed", rewritten: true });
		expect(h.vault.log).toEqual([
			"trash c.md (vault-trash)",
			"trash a.md (vault-trash)",
			"write a.md",
			"write d.md",
		]);
		expect(h.vault.trashed).toEqual([
			{ path: "c.md", mode: "vault-trash", content: "C" },
			{ path: "a.md", mode: "vault-trash", content: "A2" },
		]);
		expect(result.trashed).toEqual(["c.md", "a.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A1", "b.md": "B", "d.md": "D" });
		expect(await h.base()).toBe(head);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
	});

	test("resumed after a stop: not asked again, and still through the trash", async () => {
		const { h, head } = await rewritten();
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		const first = await h.pull({ signal: stop.signal });
		expect(first.outcome).toBe("cancelled");
		expect(h.vault.trashed.map((file) => file.path)).toEqual(["c.md"]);

		h.vault.before = undefined;
		const second = await h.pull();

		expect(h.asked).toHaveLength(1);
		expect(second.outcome).toBe("completed");
		expect(h.vault.trashed).toMatchObject([
			{ path: "c.md", mode: "vault-trash" },
			{ path: "a.md", mode: "vault-trash", content: "A2" },
		]);
		expect(await h.base()).toBe(head);
	});

	test("keep mine: the files stay, the rest is pulled, and the records are what W-3 says", async () => {
		const { h, head } = await rewritten();
		h.answer = "keep-local";

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.keptLocal).toEqual(["c.md", "a.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C", "d.md": "D" });
		expect(h.vault.trashed).toEqual([]);
		// The file that was to be deleted has no record; the one that was to
		// be written over has the record of what the remote holds.
		expect(await h.records()).toEqual(hashes({ "a.md": "A1", "b.md": "B", "d.md": "D" }));
		expect(await h.base()).toBe(head);

		const next = await h.pull();
		expect(next.outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C", "d.md": "D" });
	});

	test("keep mine forgets a yes from before, so that it cannot stand for a pull that stops halfway", async () => {
		const { h } = await rewritten();
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toMatchObject({ rewritten: true });

		// The same question is not asked twice.
		const again = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") again.abort();
		};
		expect((await h.pull({ signal: again.signal })).outcome).toBe("cancelled");
		expect(h.asked).toHaveLength(1);

		// One file more is to go: a new question, answered with "keep mine".
		h.backend.rewriteHistory({ "a.md": "A1", "d.md": "D" });
		h.answer = "keep-local";
		const last = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") last.abort();
		};
		expect((await h.pull({ signal: last.signal })).outcome).toBe("cancelled");
		expect(h.asked).toHaveLength(2);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
	});

	test("cancel: nothing is changed, and the next pull asks again", async () => {
		const { h, base } = await rewritten();
		h.answer = "cancel";

		const result = await h.pull();

		expect(result.outcome).toBe("declined");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C" });
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A2", "b.md": "B", "c.md": "C" }));
		expect(await h.base()).toBe(base);
		await h.pull();
		expect(h.asked).toHaveLength(2);
	});

	test("a history that goes on is not asked about, and nothing goes to the trash of the vault", async () => {
		const h = await synced({ "a.md": "A1", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "b.md": null });
		const result = await h.pull();
		expect(result.rewritten).toBe(false);
		expect(h.asked).toEqual([]);
		expect(h.vault.log).toEqual(["trash b.md (user-setting)", "write a.md"]);
		expect(h.backend.checkedBase).toBe(1);
	});

	test("the history cannot be checked: the pull fails and nothing is changed", async () => {
		const { h, base } = await rewritten();
		h.backend.checkBaseFails = true;

		await expect(h.pull()).rejects.toMatchObject({ kind: "unreachable" });

		expect(h.asked).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C" });
		expect(h.vault.log).toEqual([]);
		expect(await h.base()).toBe(base);
	});

	test("the head is the base: the history is not asked about", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.checkBaseFails = true;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.backend.checkedBase).toBe(0);
	});
});

describe("a remote without content", () => {
	test("with nothing pulled before: nothing is done, and there is still no base", async () => {
		const h = harness();
		h.vault.put("a.md", "mine");

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "remote-empty", remoteEmpty: true, revision: null });
		expect(h.vault.snapshot()).toEqual({ "a.md": "mine" });
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();
		expect(h.asked).toEqual([]);
	});

	test("after a pull: it is a rewritten history, and every file it would take is asked about", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const base = await h.base();
		h.backend.emptied = true;
		h.vault.put("b.md", "edited");
		h.answer = "cancel";

		const declined = await h.pull();

		expect(declined).toMatchObject({ outcome: "declined", remoteEmpty: true, rewritten: true });
		expect(h.asked[0]?.losses).toEqual({
			rewritten: true,
			deletions: [{ key: "a.md", path: "a.md" }],
			overwrites: [],
		});
		expect(h.backend.checkedBase).toBe(0);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "edited" });
		expect(await h.base()).toBe(base);

		h.answer = "proceed";
		const done = await h.pull();

		expect(done.outcome).toBe("completed");
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A" }]);
		expect(h.vault.snapshot()).toEqual({ "b.md": "edited" });
		// There is no head to build on any more.
		expect(await h.base()).toBeNull();
	});
});

describe(".gitignore", () => {
	test("rules the remote added take effect in the same pull, before anything is written", async () => {
		const h = await synced({ ".gitignore": "# nothing\n", "a.md": "A" });
		h.vault.putAll({ "drafts/secret.md": "S", "other/unsent.md": "U" });
		h.backend.commit({ ".gitignore": "/drafts/\n" });
		const seen: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "list") seen.push(path);
			if (op === "write") seen.push(`write ${path}`);
		};

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([]);
		expect(h.vault.text(".gitignore")).toBe("/drafts/\n");
		// The folder the new rule matches is never listed: its files are
		// not among the vault's, as far as this pull goes. And the file
		// itself is written with the rest, after the scan.
		expect(seen).toContain("other");
		expect(seen).not.toContain("drafts");
		expect(seen.indexOf("write .gitignore")).toBeGreaterThan(seen.indexOf("other"));
		expect(result.counts.fetched).toBe(1);
	});

	test("a pull that is declined has not touched it, its record, or anything else", async () => {
		const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, `F${i}`]));
		const h = await synced({ ".gitignore": "v1\n", ...many });
		const base = await h.base();
		const gone = Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null]));
		h.backend.commit({ ...gone, ".gitignore": "v2\n" });
		h.answer = "cancel";

		const result = await h.pull();

		expect(result).toMatchObject({
			outcome: "declined",
			counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
			conflicts: [],
			trashed: [],
			deferred: [],
			unwritable: [],
		});
		expect(h.vault.log).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ".gitignore": "v1\n", ...many });
		expect(await h.records()).toEqual(hashes({ ".gitignore": "v1\n", ...many }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(base);
	});

	test("a pull that is stopped before the plan is carried out has not touched it either", async () => {
		const h = await synced({ ".gitignore": "v1\n", "a.md": "A" });
		h.backend.commit({ ".gitignore": "v2\n", "a.md": "A2" });
		const stop = new AbortController();
		const result = await h.pull({
			signal: stop.signal,
			onProgress: (event) => {
				if (event.phase === "hashing") stop.abort();
			},
		});
		expect(result).toMatchObject({ outcome: "cancelled", counts: { fetched: 0, conflicts: 0 }, conflicts: [] });
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes({ ".gitignore": "v1\n", "a.md": "A" }));
	});

	test("the remote's one cannot be fetched: the pull fails before anything is changed", async () => {
		const h = await synced({ ".gitignore": "v1\n", "a.md": "A" });
		h.backend.commit({ ".gitignore": "v2\n", "a.md": "A2" });
		h.backend.fetch = () => {
			throw new BackendError("unreachable", "offline");
		};
		await expect(h.pull()).rejects.toMatchObject({ kind: "unreachable" });
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes({ ".gitignore": "v1\n", "a.md": "A" }));
	});

	test("it is fetched from the backend itself, so that an archive of the contents is asked for once", async () => {
		const h = harness();
		h.backend.commit({ ".gitignore": "*.log\n", "a.md": "A" });
		const asked: string[][] = [];
		await h.pull({
			fetchContents: (revision, entries) => {
				asked.push(entries.map((entry) => entry.path));
				return h.backend.fetch(revision, entries);
			},
		});
		expect(asked).toEqual([[".gitignore", "a.md"]]);
	});

	test("one that is the same here and there is not fetched at all", async () => {
		const h = harness();
		h.backend.commit({ ".gitignore": "*.log\n" });
		h.vault.put(".gitignore", "*.log\n");
		h.backend.fetch = () => {
			throw new Error("not needed");
		};
		expect((await h.pull()).outcome).toBe("completed");
	});

	test("on a first fetch it is written first, and the files it leaves out are no conflict", async () => {
		const h = harness();
		h.backend.commit({ ".gitignore": "*.log\n", "a.md": "A" });
		h.vault.put("debug.log", "L");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ ".gitignore": "*.log\n", "a.md": "A", "debug.log": "L" });
		expect(h.vault.log).toEqual(["write .gitignore", "write a.md"]);
	});

	test("after a rewritten history it is not written over before the user was asked", async () => {
		const h = await synced({ ".gitignore": "v1\n", "a.md": "A" });
		h.backend.commit({ ".gitignore": "v2\n" });
		await h.pull();
		h.vault.log.length = 0;
		h.backend.rewriteHistory({ ".gitignore": "v1\n", "a.md": "A" });
		h.answer = "cancel";

		await h.pull();

		expect(h.asked[0]?.losses.overwrites).toEqual([{ key: ".gitignore", path: ".gitignore" }]);
		expect(h.vault.text(".gitignore")).toBe("v2\n");
		expect(h.vault.log).toEqual([]);

		h.answer = "proceed";
		await h.pull();
		expect(h.vault.log).toEqual(["trash .gitignore (vault-trash)", "write .gitignore"]);
	});

	test("without one on the remote, the vault's own rules apply and the file is left alone", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.putAll({ ".gitignore": "/drafts/\n", "drafts/x.md": "X" });
		const listed: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "list") listed.push(path);
		};
		await h.pull();
		expect(h.vault.text(".gitignore")).toBe("/drafts/\n");
		expect(listed).not.toContain("drafts");
	});
});

describe("what is skipped, and what the user is told once", () => {
	test("a file over the size limit is not fetched, has no record, and is told once", async () => {
		const h = harness();
		const head = h.backend.commit({ "small.md": "12345", "big.bin": "123456" });
		let fetched: string[] = [];
		const fetchContents: PullDeps["fetchContents"] = (revision, entries) => {
			fetched = entries.map((entry) => entry.path);
			return h.backend.fetch(revision, entries);
		};

		const first = await h.pull({ sizeLimit: 5, fetchContents });

		expect(first.outcome).toBe("completed");
		expect(fetched).toEqual(["small.md"]);
		expect(h.vault.paths()).toEqual(["small.md"]);
		expect(await h.records()).toEqual(hashes({ "small.md": "12345" }));
		expect(first.notices).toEqual([{ kind: "too-large", path: "big.bin" }]);
		expect(await h.base()).toBe(head);

		const second = await h.pull({ sizeLimit: 5, fetchContents });
		expect(second.notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "too-large", path: "big.bin" }]);
	});

	test("a vault file over the size limit is not read", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("huge.bin", "1234567890");
		const read: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "read") read.push(path);
		};
		const result = await h.pull({ sizeLimit: 5 });
		expect(read).not.toContain("huge.bin");
		expect(result.notices).toEqual([{ kind: "too-large", path: "huge.bin" }]);
	});

	test("an LFS pointer is written as it is and told once, for as long as the remote has it", async () => {
		const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n";
		const h = harness();
		h.backend.commit({ "img.png": pointer, "a.md": "A" });

		const first = await h.pull();

		expect(h.vault.text("img.png")).toBe(pointer);
		expect(first.notices).toEqual([{ kind: "lfs-pointer", path: "img.png" }]);

		h.backend.commit({ "a.md": "A2" });
		const second = await h.pull();
		expect(second.notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "lfs-pointer", path: "img.png" }]);

		h.backend.commit({ "img.png": "a real image" });
		await h.pull();
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("an LFS pointer that is already in the vault is told as well", async () => {
		const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n";
		const h = harness();
		h.backend.commit({ "img.png": pointer });
		h.vault.put("img.png", pointer);
		expect((await h.pull()).notices).toEqual([{ kind: "lfs-pointer", path: "img.png" }]);
	});

	test("a symlink is not written, gets a record, and is reported the first time only", async () => {
		const h = harness();
		h.backend.symlinks.add("link");
		const head = h.backend.commit({ link: "../target/dir", "a.md": "A" });

		const first = await h.pull();

		expect(first.outcome).toBe("completed");
		expect(first.newSymlinks).toEqual(["link"]);
		expect(h.vault.paths()).toEqual(["a.md"]);
		expect(await h.store.readRecords()).toContainEqual({
			key: "link",
			path: "link",
			kind: "symlink",
			hash: blobHash("../target/dir"),
		});
		expect(await readSymlinkTargets(h.store)).toEqual([{ path: "link", target: "../target/dir" }]);
		expect(await h.base()).toBe(head);

		h.backend.commit({ "a.md": "A2" });
		const second = await h.pull({
			fetchContents: (revision, entries) => {
				expect(entries.map((entry) => entry.path)).toEqual(["a.md"]);
				return h.backend.fetch(revision, entries);
			},
		});
		expect(second.newSymlinks).toEqual([]);
		expect(await readSymlinkTargets(h.store)).toEqual([{ path: "link", target: "../target/dir" }]);
	});

	test("a symlink that points elsewhere or is gone is followed in the list of targets", async () => {
		const h = harness();
		h.backend.symlinks.add("link");
		h.backend.commit({ link: "one" });
		await h.pull();
		h.backend.commit({ link: "two" });
		const moved = await h.pull();
		expect(moved.newSymlinks).toEqual([]);
		expect(await readSymlinkTargets(h.store)).toEqual([{ path: "link", target: "two" }]);

		h.backend.commit({ link: null });
		await h.pull();
		expect(await readSymlinkTargets(h.store)).toEqual([]);
		expect(await h.records()).toEqual({});
	});

	test("a target that cannot be fetched does not fail the pull", async () => {
		const h = harness();
		h.backend.symlinks.add("link");
		h.backend.commit({ link: "one", "a.md": "A" });
		const real = h.backend.fetch.bind(h.backend);
		h.backend.fetch = (revision, entries) => {
			if (entries.some((entry) => entry.kind === "symlink")) throw new BackendError("unreachable", "offline");
			return real(revision, entries);
		};
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(await readSymlinkTargets(h.store)).toEqual([]);
	});

	test("a community-plugins.json that does not list this plugin is told, and not changed", async () => {
		const h = harness();
		const file = ".obsidian/community-plugins.json";
		h.backend.commit({ [file]: '["dataview"]' });

		const first = await h.pull();

		expect(first.notices).toEqual([{ kind: "plugin-not-listed", path: file }]);
		expect(h.vault.text(file)).toBe('["dataview"]');

		// Not about the next pull, which writes nothing.
		expect((await h.pull()).notices).toEqual([]);

		h.backend.commit({ [file]: '["dataview", "sync-evo"]' });
		expect((await h.pull()).notices).toEqual([]);

		h.backend.commit({ [file]: "not json" });
		expect((await h.pull()).notices).toEqual([{ kind: "plugin-not-listed", path: file }]);
	});

	test("it is told every time such a file is written, also by the pull right after", async () => {
		const h = harness();
		const file = ".obsidian/community-plugins.json";
		h.backend.commit({ [file]: '["dataview"]' });
		expect((await h.pull()).notices).toEqual([{ kind: "plugin-not-listed", path: file }]);

		h.backend.commit({ [file]: '["dataview", "templater"]' });
		expect((await h.pull()).notices).toEqual([{ kind: "plugin-not-listed", path: file }]);
		// Told, and not remembered.
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a remote file with files of this device in its place is told once, with what is in the way", async () => {
		const h = await synced({ "notes/a.md": "A", "b.md": "B" });
		h.vault.put("notes/draft.md", "D");
		h.vault.put("notes/sub/idea.md", "I");
		const head = h.backend.commit({ "notes/a.md": null, notes: "now a file" });

		const first = await h.pull();

		expect(first.outcome).toBe("completed");
		expect(first.notices).toEqual([{ kind: "blocked-path", path: "notes" }]);
		expect(first.unwritable).toEqual([
			{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md", "notes/sub/idea.md"], isNew: true },
		]);
		expect(h.vault.text("notes/draft.md")).toBe("D");
		expect(await h.base()).toBe(head);

		// Still so, and not told again.
		const second = await h.pull();
		expect(second.notices).toEqual([]);
		expect(second.unwritable).toMatchObject([{ path: "notes", reason: "blocked", isNew: false }]);

		// Out of the way: written, and forgotten.
		h.vault.remove("notes/draft.md");
		h.vault.remove("notes/sub/idea.md");
		await h.vault.removeFolderIfEmpty("notes/sub");
		await h.vault.removeFolderIfEmpty("notes");
		const third = await h.pull();
		expect(third.unwritable).toEqual([]);
		expect(h.vault.text("notes")).toBe("now a file");
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a pull that is declined tells a blocked file with what is in the way, and the next pull not again", async () => {
		const many = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, `F${i}`]),
		);
		const h = await synced({ ...many, "notes/a.md": "A" });
		h.vault.put("notes/draft.md", "D");
		const gone = Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null]));
		h.backend.commit({ ...gone, "notes/a.md": null, notes: "now a file" });
		h.answer = "cancel";

		const declined = await h.pull();

		expect(declined.outcome).toBe("declined");
		expect(h.asked).toHaveLength(1);
		expect(declined.notices).toEqual([{ kind: "blocked-path", path: "notes" }]);
		expect(declined.unwritable).toEqual([
			{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md"], isNew: true },
		]);
		expect(h.vault.log).toEqual([]);

		// Told by the pull that was declined, so not by the one that goes on.
		h.answer = "proceed";
		const next = await h.pull();
		expect(next.outcome).toBe("completed");
		expect(next.notices).toEqual([]);
		expect(next.unwritable).toEqual([
			{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md"], isNew: false },
		]);
	});

	test("a blocked file that is gone from the remote is forgotten, and told again if it comes back", async () => {
		const h = await synced({ "notes/a.md": "A" });
		h.vault.put("notes/draft.md", "D");
		h.backend.commit({ "notes/a.md": null, notes: "now a file" });
		expect((await h.pull()).notices).toEqual([{ kind: "blocked-path", path: "notes" }]);

		h.backend.commit({ notes: null });
		expect((await h.pull()).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);

		h.backend.commit({ notes: "a file again" });
		expect((await h.pull()).notices).toEqual([{ kind: "blocked-path", path: "notes" }]);
	});

	test("a deletion the vault refuses is told once, and the file keeps its record", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });
		h.vault.before = (op) => {
			if (op === "trash") throw new Error("the trash is full");
		};

		const first = await h.pull();

		expect(first.outcome).toBe("completed");
		expect(first.counts.deleted).toBe(0);
		expect(first.notices).toEqual([{ kind: "unwritable-path", path: "a.md" }]);
		expect(first.unwritable).toMatchObject([{ path: "a.md", reason: "trash-failed", isNew: true }]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B" }));

		const second = await h.pull();
		expect(second.notices).toEqual([]);
		expect(second.unwritable).toMatchObject([{ path: "a.md", reason: "trash-failed", isNew: false }]);

		h.vault.before = undefined;
		const third = await h.pull();
		expect(third.counts.deleted).toBe(1);
		expect(third.unwritable).toEqual([]);
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("a refused deletion stays remembered through a pull that did not get to it", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });
		h.vault.before = (op) => {
			if (op === "trash") throw new Error("the trash is full");
		};
		await h.pull();

		const stop = new AbortController();
		stop.abort();
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(await readNotices(h.store)).toEqual([{ kind: "unwritable-path", path: "a.md" }]);
		expect((await h.pull()).notices).toEqual([]);
	});

	test("a refused deletion stays remembered through a pull that put the file off", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });
		h.vault.before = (op) => {
			if (op === "trash") throw new Error("the trash is full");
		};
		expect((await h.pull()).notices).toEqual([{ kind: "unwritable-path", path: "a.md" }]);

		// An editor that cannot save: the deletion is not tried at all.
		h.vault.openFailing("a.md");
		const second = await h.pull();
		expect(second.outcome).toBe("incomplete");
		expect(second.deferred).toEqual([{ path: "a.md", reason: "save-failed" }]);
		expect(second.notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "unwritable-path", path: "a.md" }]);

		h.vault.close("a.md");
		const third = await h.pull();
		expect(third.unwritable).toMatchObject([{ path: "a.md", reason: "trash-failed", isNew: false }]);
		expect(third.notices).toEqual([]);
	});

	test("paths that differ only in case are not written, have no record, and are told", async () => {
		const h = harness();
		const head = h.backend.commit({
			"Case.md": "1",
			"case.md": "2",
			"notes/a.md": "A",
			"Notes/b.md": "B",
			"ok.md": "OK",
		});

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.paths()).toEqual(["ok.md"]);
		expect(await h.records()).toEqual(hashes({ "ok.md": "OK" }));
		expect(result.notices).toEqual([
			{ kind: "remote-path-collision", path: "Case.md" },
			{ kind: "remote-path-collision", path: "case.md" },
			{ kind: "remote-path-collision", path: "Notes" },
			{ kind: "remote-path-collision", path: "notes" },
		]);
		expect(await h.base()).toBe(head);
	});

	test("the plugin's own folder on the remote is one notice, and nothing in it is written", async () => {
		const h = harness();
		h.backend.commit({
			".obsidian/plugins/sync-evo/main.js": "M",
			".obsidian/plugins/sync-evo/manifest.json": "{}",
			"a.md": "A",
		});
		h.vault.put(".git/HEAD", "ref");
		const read: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "read" || op === "list") read.push(path);
		};

		const result = await h.pull();

		expect(result.notices).toEqual([
			{ kind: "git-at-root", path: ".git" },
			{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" },
		]);
		expect(h.vault.paths()).toEqual([".git/HEAD", "a.md"]);
		expect(read.filter((path) => path.startsWith(".git") || path.includes("sync-evo"))).toEqual([]);
		expect((await h.pull()).notices).toEqual([]);
	});

	test("a spelling that changed only in normalization goes into the record; the file keeps its name", async () => {
		const nfd = "café.md";
		const nfc = "café.md";
		const h = await synced({ [nfd]: "C" });
		h.backend.commit({ [nfd]: null, [nfc]: "C" });
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.log).toEqual([]);
		expect(h.vault.paths()).toEqual([nfd]);
		expect((await h.store.readRecords()).map((record) => record.path)).toEqual([nfc]);
	});
});

// Where the cases are not told apart, a rename leaves the folders on the way
// as the disk spells them (`PullVault.rename`). These steps are only planned
// for a disk that tells the cases apart, so they are carried out here by
// hand, as they would be if such a plan met the other kind of disk.
describe("a file moved to a folder the disk spells otherwise", () => {
	async function moveStray(
		aside: boolean,
		refuseRenames = false,
	): Promise<{ vault: MemoryPullVault; tally: Tally; seen: Map<string, Seen> }> {
		const time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const vault = new MemoryPullVault({ caseSensitive: false, now: () => time });
		vault.put("notes/x.md", "X");
		if (refuseRenames) {
			vault.before = (op) => {
				if (op === "rename") throw new Error("busy");
			};
		}
		const local = { path: "notes/x.md", hash: blobHash("X"), size: 1 };
		const empty = planPull({
			remote: [],
			local: [],
			records: [],
			exclusion: createExclusion({ ...paths, gitignore: null }),
		});
		const tally = new Tally();
		const seen = new Map<string, Seen>([["notes/x.md", { hash: local.hash, stat: { mtime: time, size: 1 } }]]);
		const backend = new MemoryBackend();
		const done = await applyPlan(
			{
				store: new MemoryStateStore(),
				backend,
				vault,
				fetchContents: (revision, entries) => backend.fetch(revision, entries),
				deviceName: "Mac",
				now: () => time,
				startedAt: time,
				listing: { revision: null, entries: [] },
				protect: false,
				seen,
				localPaths: ["notes/x.md"],
				tally,
				beforeWrite: async () => {},
				communityPluginsKey: ".obsidian/community-plugins.json",
				pluginId: "sync-evo",
			},
			{ ...empty, strays: [{ local, to: "Notes/x.md", aside }] },
		);
		expect(done).toBe(true);
		return { vault, tally, seen };
	}

	test("a copy is reported under the folder as the disk spells it", async () => {
		const { vault, tally, seen } = await moveStray(true);
		const copy = conflictCopyPath("notes/x.md", "Mac", new Date(Date.UTC(2026, 9, 3, 12, 0, 0)));
		expect(vault.paths()).toEqual([copy]);
		expect(tally.conflicts).toEqual([{ path: "Notes/x.md", copyPath: copy, cause: "name-taken" }]);
		expect([...seen.keys()]).toEqual([copy]);
	});

	test("a file the rename left where it was is known under the path it has", async () => {
		const { vault, tally, seen } = await moveStray(false);
		expect(vault.paths()).toEqual(["notes/x.md"]);
		expect(tally.unwritable).toEqual([]);
		expect([...seen.keys()]).toEqual(["notes/x.md"]);
	});

	test("a move the vault refuses is told, whether to the folder or to a copy", async () => {
		for (const aside of [false, true]) {
			const { vault, tally, seen } = await moveStray(aside, true);
			expect(vault.paths()).toEqual(["notes/x.md"]);
			expect(tally.unwritable).toMatchObject([{ path: "notes/x.md", reason: "rename-failed" }]);
			expect(tally.refused).toEqual([{ remotePath: "notes/x.md", reportedAs: "notes/x.md" }]);
			expect(tally.conflicts).toEqual([]);
			expect([...seen.keys()]).toEqual(["notes/x.md"]);
		}
	});
});

describe("stopping and failing", () => {
	test("the signal stops between two files, and what was written is recorded", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B", "c.md": "C" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};

		const first = await h.pull({ signal: stop.signal });

		expect(first.outcome).toBe("cancelled");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBeNull();
		expect(h.views).toEqual(["close", "reopen"]);

		h.vault.before = undefined;
		const second = await h.pull({
			fetchContents: (revision, entries) => {
				expect(entries.map((entry) => entry.path)).toEqual(["b.md", "c.md"]);
				return h.backend.fetch(revision, entries);
			},
		});
		expect(second.outcome).toBe("completed");
		expect(second.counts.fetched).toBe(2);
	});

	test("a signal that is already set changes nothing", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		const stop = new AbortController();
		stop.abort();
		const result = await h.pull({ signal: stop.signal });
		expect(result.outcome).toBe("cancelled");
		expect(h.vault.paths()).toEqual([]);
		expect(await h.base()).toBeNull();
	});

	test("a folder that cannot be listed fails the pull before anything is changed", async () => {
		const h = await synced({ "notes/a.md": "A", "b.md": "B" });
		const base = await h.base();
		h.backend.commit({ "b.md": null, "c.md": "C" });
		h.vault.before = (op, path) => {
			if (op === "list" && path === "notes") throw new Error("permission denied");
		};
		await expect(h.pull()).rejects.toThrow("permission denied");
		expect(h.vault.snapshot()).toEqual({ "notes/a.md": "A", "b.md": "B" });
		expect(await h.base()).toBe(base);
	});

	test("a listing that cannot be taken fails the pull", async () => {
		const h = harness();
		h.backend.list = async () => {
			throw new BackendError("unauthorized", "bad token");
		};
		await expect(h.pull()).rejects.toMatchObject({ kind: "unauthorized" });
	});

	test("the stored listing is used while the remote has not moved, and replaced when it has", async () => {
		const h = await synced({ "a.md": "A" });
		const known: (string | null)[] = [];
		const real = h.backend.list.bind(h.backend);
		h.backend.list = (revision) => {
			known.push(revision);
			return real(revision);
		};
		const first = await h.base();
		h.vault.remove("a.md");
		// Deleted here, unchanged there: nothing for a pull to do, and the
		// listing it decides that from is the stored one.
		expect((await h.pull()).outcome).toBe("completed");
		const second = h.backend.commit({ "b.md": "B" });
		await h.pull();
		await h.pull();
		expect(known).toEqual([first, first, second]);
		expect((await h.store.getListing())?.revision).toBe(second);
	});

	test("a write marker left by a pull that stopped does not get in the way", async () => {
		const h = await synced({ "a.md": "A" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
		await h.store.putMarker(makeMarker("x.md", null, blobHash("X"), false));
		h.backend.commit({ "a.md": "A2" });
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("A2");
		// The marker of the path that was written is gone with its record.
		expect((await h.store.readMarkers()).map((marker) => marker.key)).toEqual(["x.md"]);
	});
});
