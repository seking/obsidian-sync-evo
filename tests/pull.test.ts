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
import { ARCHIVE_ATTEMPT_KEY, ARCHIVE_DISABLED_KEY } from "../src/core/archive-fetch";
import {
	type ArchiveContents,
	BackendError,
	type BaseRelation,
	type FetchedFile,
	type ListResult,
} from "../src/core/backend";
import { conflictCopyPath, originalPathOfConflictCopy } from "../src/core/conflict-name";
import { FIRST_FETCH_CONFIRMED_KEY, isFirstFetchConfirmed } from "../src/core/first-fetch";
import { translatorFor } from "../src/core/i18n";
import { readNotices } from "../src/core/notices";
import { applyPlan, type Seen, Tally } from "../src/core/pull-apply";
import { planPull } from "../src/core/pull-plan";
import { pullAutoReport } from "../src/core/auto-report";
import { pullReport } from "../src/core/pull-report";
import { createExclusion } from "../src/core/exclusion";
import {
	AWAITED_CONFLICTS_KEY,
	HALF_WRITTEN_KEY,
	PULL_CONFIRMATION_KEY,
	type PullAnswer,
	type PullConfirmRequest,
	type PullDeps,
	type PullProgress,
	type PullResult,
	readSymlinkTargets,
	runPull,
} from "../src/core/pull";
import { DEFAULT_AUTO_SYNC } from "../src/core/settings";
import { makeMarker, readBaseRevision, type StateStore } from "../src/core/state";
import { blobHash, bytes, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryIndex } from "./support/memory-index";
import { MemoryPullVault, type VaultOp } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** For wording a result the way the app does. */
const reportOptions = {
	settings: {
		backend: "github",
		repository: "octo/notes",
		branch: "main",
		tokenSecret: "t",
		deviceName: "iPhone",
		autoSync: DEFAULT_AUTO_SYNC,
	},
	sizeLimit: 50 * 1024 * 1024,
} as const;

/** A remote a test can bend: symlinks, submodules, no content at all, a history that cannot be checked. */
class TestBackend extends MemoryBackend {
	readonly symlinks = new Set<string>();
	readonly submodules = new Set<string>();
	emptied = false;
	checkBaseFails = false;
	checkedBase = 0;

	override async list(known: string | null): Promise<ListResult> {
		if (this.emptied) return { changed: true, listing: { revision: null, entries: [] } };
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		const entries = listed.listing.entries.map((entry) => {
			if (this.symlinks.has(entry.path)) return { ...entry, kind: "symlink" } as const;
			return this.submodules.has(entry.path) ? ({ ...entry, kind: "submodule" } as const) : entry;
		});
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
	/** Replaced by a test that discards the sync state; every pull uses the one that is here then. */
	store: MemoryStateStore;
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
				store: guarded(h.store, crash),
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
			for (const record of await h.store.readRecords()) out[record.path] = record.hash;
			return out;
		},
		base: () => readBaseRevision(h.store),
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

describe("a conflict inside the configuration folder", () => {
	// What Obsidian writes into a vault it has just created.
	const defaults = {
		".obsidian/app.json": "{}",
		".obsidian/appearance.json": "{}",
		".obsidian/core-plugins.json": "[]",
	};
	const theirs = {
		".obsidian/app.json": '{"theirs":1}',
		".obsidian/appearance.json": '{"theirs":2}',
		".obsidian/core-plugins.json": '["theirs"]',
		"a.md": "A",
	};
	const inTrash = (h: Harness): Record<string, string> =>
		Object.fromEntries(h.vault.trashed.map((file) => [file.path, file.content]));

	test("a first fetch into a vault that Obsidian just created: no copy, no question, the vault's files in .trash/", async () => {
		const h = harness();
		const head = h.backend.commit(theirs);
		h.vault.putAll(defaults);

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(h.vault.snapshot()).toEqual(theirs);
		expect(h.copies()).toEqual([]);
		expect(await h.records()).toEqual(hashes(theirs));
		expect(await h.base()).toBe(head);
		expect(inTrash(h)).toEqual(defaults);
		expect(h.vault.trashed.map((file) => file.mode)).toEqual(["vault-trash", "vault-trash", "vault-trash"]);
		expect([...result.replacedSettings].sort()).toEqual(Object.keys(defaults));
		expect(result.conflicts).toEqual([]);
		expect(result.trashed).toEqual([]);
		expect(result.counts).toEqual({ fetched: 4, deleted: 0, renamed: 0, conflicts: 0 });

		// Told apart from the conflicts, and not counted among them.
		const report = pullReport(translatorFor("en"), result, reportOptions);
		expect(report.summary).toBe("Pull finished: 4 files fetched.");
		expect(report.details).toHaveLength(1);
		expect(report.details[0]).toContain("3 files in the configuration folder now have the content of the remote.");
		expect(pullReport(translatorFor("ja"), result, reportOptions).summary).toBe("取り込みが終わりました：取得 4 件");

		// Nothing is left for a second pull, and nothing for a push.
		h.vault.log.length = 0;
		const again = await h.pull();
		expect(again.replacedSettings).toEqual([]);
		expect(h.vault.log).toEqual([]);
	});

	test("the same, stopped at any point and run again: nothing lost, nothing in .trash/ twice", async () => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = harness();
			const head = h.backend.commit(theirs);
			h.vault.putAll(defaults);

			h.crash.after(after);
			await h.pull().catch(() => undefined);
			const stopped = h.crash.dead;
			h.crash.revive();
			// What the vault had of each file is at its path or in the trash.
			for (const [path, content] of Object.entries(defaults)) {
				expect([h.vault.text(path), inTrash(h)[path]]).toContain(content);
			}

			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(h.asked).toEqual([]);
			expect(h.vault.snapshot()).toEqual(theirs);
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(hashes(theirs));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
			expect(h.vault.trashed).toHaveLength(3);
			expect(inTrash(h)).toEqual(defaults);
			expect(result.conflicts).toEqual([]);
			if (!stopped) break;
			stops += 1;
		}
		// Per file: trash, marker, file, record; and the listing, the base.
		expect(stops).toBeGreaterThan(12);
	});

	test("stopped in the middle of the write: half the file goes to .trash/ too, and the vault's content is there once", async () => {
		const h = harness();
		h.backend.commit(theirs);
		h.vault.putAll(defaults);
		const file = ".obsidian/app.json";
		h.vault.before = (op, path) => {
			h.crash.gate(VAULT_CHANGES.has(op));
			if (op !== "write" || path !== file) return;
			h.vault.put(file, '{"the');
			h.crash.dead = true;
			throw new Error("the app is gone");
		};
		await h.pull().catch(() => undefined);
		expect(h.crash.dead).toBe(true);
		h.crash.revive();
		h.vault.before = undefined;

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.halfWritten).toEqual([file]);
		expect(h.vault.snapshot()).toEqual(theirs);
		expect(h.copies()).toEqual([]);
		expect(h.vault.trashed.filter((trashed) => trashed.path === file).map((trashed) => trashed.content)).toEqual([
			"{}",
			'{"the',
		]);
		expect(h.vault.trashed).toHaveLength(4);
	});

	test("with a record: the remote's content wins, and a note in the same pull still gets its copy", async () => {
		const h = await synced({ ".obsidian/app.json": "{}", "a.md": "A" });
		const head = h.backend.commit({ ".obsidian/app.json": '{"theirs":1}', "a.md": "theirs" });
		h.vault.putAll({ ".obsidian/app.json": '{"mine":1}', "a.md": "mine" });

		const result = await h.pull();

		const copy = h.copyName("a.md");
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": '{"theirs":1}', "a.md": "theirs", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([{ path: ".obsidian/app.json", mode: "vault-trash", content: '{"mine":1}' }]);
		expect(result.replacedSettings).toEqual([".obsidian/app.json"]);
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(result.counts).toEqual({ fetched: 2, deleted: 0, renamed: 0, conflicts: 1 });
		expect(await h.records()).toEqual(hashes({ ".obsidian/app.json": '{"theirs":1}', "a.md": "theirs" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
		expect(pullReport(translatorFor("en"), result, reportOptions).summary).toBe(
			"Pull finished: 2 files fetched, 1 conflict.",
		);
	});

	test("with a record, stopped at any point and run again: the same end", async () => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = await synced({ ".obsidian/app.json": "{}", "b.md": "B" });
			const head = h.backend.commit({ ".obsidian/app.json": '{"theirs":1}', "b.md": "B2" });
			h.vault.put(".obsidian/app.json", '{"mine":1}');

			h.crash.after(after);
			await h.pull().catch(() => undefined);
			const stopped = h.crash.dead;
			h.crash.revive();

			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": '{"theirs":1}', "b.md": "B2" });
			expect(await h.records()).toEqual(hashes({ ".obsidian/app.json": '{"theirs":1}', "b.md": "B2" }));
			expect(await h.base()).toBe(head);
			expect(h.vault.trashed).toEqual([{ path: ".obsidian/app.json", mode: "vault-trash", content: '{"mine":1}' }]);
			if (!stopped) break;
			stops += 1;
		}
		expect(stops).toBeGreaterThan(5);
	});

	test("a file that changed, or appeared, between the decision and the write goes to .trash/ as well", async () => {
		const changed = await synced({ ".obsidian/app.json": "{}" });
		changed.backend.commit({ ".obsidian/app.json": '{"theirs":1}' });
		const first = await changed.pull({
			// Obsidian wrote its settings while the pull was fetching.
			fetchContents: (revision, entries) => {
				changed.vault.put(".obsidian/app.json", '{"toggled":true}');
				return changed.backend.fetch(revision, entries);
			},
		});
		expect(first.outcome).toBe("completed");
		expect(first.replacedSettings).toEqual([".obsidian/app.json"]);
		expect(first.conflicts).toEqual([]);
		expect(changed.vault.snapshot()).toEqual({ ".obsidian/app.json": '{"theirs":1}' });
		expect(changed.vault.trashed).toEqual([
			{ path: ".obsidian/app.json", mode: "vault-trash", content: '{"toggled":true}' },
		]);

		const appeared = harness();
		appeared.backend.commit({ ".obsidian/app.json": '{"theirs":1}' });
		const second = await appeared.pull({
			fetchContents: (revision, entries) => {
				appeared.vault.put(".obsidian/app.json", "{}");
				return appeared.backend.fetch(revision, entries);
			},
		});
		expect(second.outcome).toBe("completed");
		expect(second.replacedSettings).toEqual([".obsidian/app.json"]);
		expect(appeared.vault.snapshot()).toEqual({ ".obsidian/app.json": '{"theirs":1}' });
		expect(appeared.vault.trashed.map((file) => file.content)).toEqual(["{}"]);
		expect(appeared.copies()).toEqual([]);
	});

	test("every depth and every kind of file; a folder that only begins like it is not it", async () => {
		const h = harness();
		const remote = {
			".obsidian/themes/x/theme.css": "theirs",
			".obsidian/snippets/a.css": "theirs",
			".obsidian-old/app.json": "theirs",
		};
		h.backend.commit(remote);
		h.vault.putAll({
			".obsidian/themes/x/theme.css": "mine",
			".obsidian/snippets/a.css": "mine",
			".obsidian-old/app.json": "mine",
		});

		const result = await h.pull();

		// Asked because of the file outside the configuration folder.
		expect(h.asked.map((request) => request.firstFetch?.files)).toEqual([
			{
				localOnly: [],
				different: [".obsidian-old/app.json"],
				differentSettings: [".obsidian/snippets/a.css", ".obsidian/themes/x/theme.css"],
				atSymlinks: [],
			},
		]);
		const copy = h.copyName(".obsidian-old/app.json");
		expect(h.vault.snapshot()).toEqual({ ...remote, [copy]: "mine" });
		expect(result.conflicts).toEqual([{ path: ".obsidian-old/app.json", copyPath: copy, cause: "conflict" }]);
		expect([...result.replacedSettings].sort()).toEqual([".obsidian/snippets/a.css", ".obsidian/themes/x/theme.css"]);
		expect(h.vault.trashed.map((file) => file.path).sort()).toEqual([
			".obsidian/snippets/a.css",
			".obsidian/themes/x/theme.css",
		]);
	});

	test("a configuration folder of another name is the one that counts", async () => {
		const h = harness();
		const remote = { ".config/app.json": "theirs", ".obsidian/app.json": "theirs" };
		h.backend.commit(remote);
		h.vault.putAll({ ".config/app.json": "mine", ".obsidian/app.json": "mine" });

		const result = await h.pull({ paths: { configDir: ".config", pluginDir: ".config/plugins/sync-evo" } });

		const copy = h.copyName(".obsidian/app.json");
		expect(h.vault.snapshot()).toEqual({ ...remote, [copy]: "mine" });
		expect(result.replacedSettings).toEqual([".config/app.json"]);
		expect(result.conflicts).toEqual([{ path: ".obsidian/app.json", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.trashed.map((file) => file.path)).toEqual([".config/app.json"]);
	});

	test("a deletion on one side and an edit on the other are decided as anywhere else", async () => {
		// Deleted on the remote, edited here: the file stays, with its record.
		const edited = await synced({ ".obsidian/app.json": "{}", "b.md": "B" });
		edited.backend.commit({ ".obsidian/app.json": null });
		edited.vault.put(".obsidian/app.json", '{"mine":1}');
		const first = await edited.pull();
		expect(first.outcome).toBe("completed");
		expect(edited.vault.text(".obsidian/app.json")).toBe('{"mine":1}');
		expect(await edited.records()).toEqual(hashes({ ".obsidian/app.json": "{}", "b.md": "B" }));
		expect(edited.vault.trashed).toEqual([]);
		expect(first.replacedSettings).toEqual([]);

		// Deleted here, changed on the remote: fetched like a new file.
		const deleted = await synced({ ".obsidian/app.json": "{}", "b.md": "B" });
		deleted.backend.commit({ ".obsidian/app.json": '{"theirs":1}' });
		deleted.vault.remove(".obsidian/app.json");
		const second = await deleted.pull();
		expect(second.outcome).toBe("completed");
		expect(deleted.vault.text(".obsidian/app.json")).toBe('{"theirs":1}');
		expect(deleted.vault.trashed).toEqual([]);
		expect(second.replacedSettings).toEqual([]);
	});

	test("a copy an earlier version made stays on the device, and is not counted as a file that is only here", async () => {
		const h = harness();
		const settingsCopy = ".obsidian/app.conflict-from-Mac-20260101-090000.json";
		const noteCopy = "a.conflict-from-Mac-20260101-090000.md";
		// A note that differs, for the question to be asked at all.
		h.backend.commit({ ".obsidian/app.json": "{}", "a.md": "A", "b.md": "theirs" });
		h.vault.putAll({ ".obsidian/app.json": "{}", "a.md": "A", "b.md": "mine", [settingsCopy]: "old", [noteCopy]: "old" });

		const result = await h.pull();

		// The copy of a note is a file that is only here, as before.
		expect(h.asked.map((request) => request.firstFetch?.files.localOnly)).toEqual([[noteCopy]]);
		expect(result.outcome).toBe("completed");
		expect(h.vault.text(settingsCopy)).toBe("old");
		expect(h.vault.text(noteCopy)).toBe("old");
		expect(h.vault.trashed).toEqual([]);
		expect(await h.records()).toEqual(hashes({ ".obsidian/app.json": "{}", "a.md": "A", "b.md": "theirs" }));
	});

	test("a copy an earlier version made is not used for a conflict either", async () => {
		const h = await synced({ ".obsidian/app.json": "{}" });
		const earlier = ".obsidian/app.conflict-from-iPhone-20260101-090000.json";
		h.vault.putAll({ ".obsidian/app.json": "mine", [earlier]: "mine" });
		h.backend.commit({ ".obsidian/app.json": "theirs" });

		const result = await h.pull();

		expect(result.conflicts).toEqual([]);
		expect(result.replacedSettings).toEqual([".obsidian/app.json"]);
		expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": "theirs", [earlier]: "mine" });
		expect(h.vault.trashed.map((file) => file.content)).toEqual(["mine"]);
	});

	test("a no to the question trashes nothing", async () => {
		const h = harness();
		h.backend.commit(theirs);
		// A note that differs: the files of the configuration folder alone are not asked about.
		h.vault.putAll({ ...defaults, "a.md": "mine", "note.md": "N" });
		h.answer = "cancel";

		const result = await h.pull();

		expect(result.outcome).toBe("declined");
		expect(h.asked[0]?.firstFetch?.files).toEqual({
			localOnly: ["note.md"],
			different: ["a.md"],
			differentSettings: Object.keys(defaults),
			atSymlinks: [],
		});
		expect(h.vault.snapshot()).toEqual({ ...defaults, "a.md": "mine", "note.md": "N" });
		expect(h.vault.trashed).toEqual([]);
		expect(result.replacedSettings).toEqual([]);
	});

	test("the vault refuses to move the file away: it stays as it is, and is reported", async () => {
		const h = await synced({ ".obsidian/app.json": "{}", "b.md": "B" });
		const head = h.backend.commit({ ".obsidian/app.json": "theirs", "b.md": "B2" });
		h.vault.put(".obsidian/app.json", "mine");
		h.vault.before = (op) => {
			if (op === "trash") throw new Error("busy");
		};

		const result = await h.pull();

		expect(result.unwritable).toMatchObject([{ path: ".obsidian/app.json", reason: "trash-failed", isNew: true }]);
		expect(result.replacedSettings).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": "mine", "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ ".obsidian/app.json": "{}", "b.md": "B2" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(result.outcome).toBe("completed");
		expect(await h.base()).toBe(head);
	});

	test("the vault refuses the write after the file was moved away: told as moved to .trash/, and fetched by the next pull", async () => {
		const h = await synced({ ".obsidian/app.json": "{}" });
		h.backend.commit({ ".obsidian/app.json": "theirs" });
		h.vault.put(".obsidian/app.json", "mine");
		h.vault.before = (op) => {
			if (op === "write") throw new Error("busy");
		};

		const first = await h.pull();

		expect(first.unwritable).toMatchObject([{ path: ".obsidian/app.json", reason: "write-failed" }]);
		expect(first.replacedSettings).toEqual([]);
		expect(first.trashed).toEqual([".obsidian/app.json"]);
		expect(h.vault.trashed.map((file) => file.content)).toEqual(["mine"]);
		expect(await h.store.readMarkers()).toEqual([]);

		h.vault.before = undefined;
		const second = await h.pull();
		expect(second.counts.fetched).toBe(1);
		expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": "theirs" });
		expect(h.vault.trashed).toHaveLength(1);
	});

	test("a file where the remote has a folder goes to .trash/ instead of the name of a copy", async () => {
		const h = harness();
		h.backend.commit({ ".obsidian/snippets/a.css": "theirs" });
		h.vault.put(".obsidian/snippets", "a file named snippets");

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ".obsidian/snippets/a.css": "theirs" });
		expect(result.conflicts).toEqual([]);
		expect(result.replacedSettings).toEqual([]);
		expect(result.trashed).toEqual([".obsidian/snippets"]);
		expect(h.vault.trashed).toEqual([
			{ path: ".obsidian/snippets", mode: "vault-trash", content: "a file named snippets" },
		]);
	});

	test("a file in the way of a rename that only changes the case goes to .trash/ as well", async () => {
		// Another file at the new spelling.
		const taken = await synced({ ".obsidian/snippets/a.css": "remote" }, { caseSensitive: true });
		taken.vault.put(".obsidian/snippets/A.css", "made here");
		taken.backend.commit({ ".obsidian/snippets/a.css": null, ".obsidian/snippets/A.css": "remote" });
		const first = await taken.pull();
		expect(first.outcome).toBe("completed");
		expect(taken.vault.snapshot()).toEqual({ ".obsidian/snippets/A.css": "remote" });
		expect(first.conflicts).toEqual([]);
		expect(first.trashed).toEqual([".obsidian/snippets/A.css"]);
		expect(taken.vault.trashed.map((file) => file.content)).toEqual(["made here"]);

		// The file under the old spelling, edited, beside the remote's content
		// under the new one.
		const old = await synced({ ".obsidian/snippets/a.css": "old" }, { caseSensitive: true });
		old.vault.putAll({ ".obsidian/snippets/a.css": "edited", ".obsidian/snippets/A.css": "theirs" });
		old.backend.commit({ ".obsidian/snippets/a.css": null, ".obsidian/snippets/A.css": "theirs" });
		const second = await old.pull();
		expect(second.outcome).toBe("completed");
		expect(old.vault.snapshot()).toEqual({ ".obsidian/snippets/A.css": "theirs" });
		expect(second.conflicts).toEqual([]);
		expect(second.trashed).toEqual([".obsidian/snippets/a.css"]);
		expect(old.vault.trashed.map((file) => file.content)).toEqual(["edited"]);
	});

	test("a file written again between the move to .trash/ and the write goes there too, and nothing is lost", async () => {
		const file = ".obsidian/app.json";
		const h = await synced({ [file]: "{}" });
		const head = h.backend.commit({ [file]: "theirs" });
		h.vault.put(file, "mine");
		// Obsidian writes its settings once more, right after the pull moved
		// the file away.
		let toggled = false;
		h.vault.before = (op, path) => {
			if (op !== "stat" || path !== file || toggled || h.vault.trashed.length === 0) return;
			toggled = true;
			h.vault.put(file, "toggled");
		};

		const result = await h.pull();

		expect(toggled).toBe(true);
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ [file]: "theirs" });
		expect(h.vault.trashed).toEqual([
			{ path: file, mode: "vault-trash", content: "mine" },
			{ path: file, mode: "vault-trash", content: "toggled" },
		]);
		// One path, told once: both are what it held on this device before.
		expect(result.replacedSettings).toEqual([file]);
		expect(result.trashed).toEqual([]);
		expect(result.deferred).toEqual([]);
		expect(result.counts).toEqual({ fetched: 1, deleted: 0, renamed: 0, conflicts: 0 });
		expect(await h.records()).toEqual(hashes({ [file]: "theirs" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
	});

	test("a file that is written again and again is left to the next pull, with every content it had still somewhere", async () => {
		const file = ".obsidian/app.json";
		const h = await synced({ [file]: "{}" });
		const base = await h.base();
		const head = h.backend.commit({ [file]: "theirs" });
		h.vault.put(file, "mine");
		let writes = 0;
		h.vault.before = (op, path) => {
			if (op !== "stat" || path !== file || h.vault.trashed.length === 0) return;
			if (h.vault.text(file) === undefined) h.vault.put(file, `toggled ${++writes}`);
		};

		const first = await h.pull();

		// Moved away twice and no more; the third content stays at the path.
		expect(h.vault.trashed.map((trashed) => trashed.content)).toEqual(["mine", "toggled 1"]);
		expect(h.vault.snapshot()).toEqual({ [file]: "toggled 2" });
		expect(first.deferred).toEqual([{ path: file, reason: "changed-during-pull" }]);
		expect(first.unwritable).toEqual([]);
		expect(first.replacedSettings).toEqual([]);
		expect(first.trashed).toEqual([file]);
		expect(first.counts.fetched).toBe(0);
		// No record of a content the path does not hold, and no marker of a
		// write that was never begun.
		expect(await h.records()).toEqual(hashes({ [file]: "{}" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(first.outcome).toBe("incomplete");
		expect(await h.base()).toBe(base);

		h.vault.before = undefined;
		const second = await h.pull();

		expect(second.outcome).toBe("completed");
		expect(second.replacedSettings).toEqual([file]);
		expect(h.vault.snapshot()).toEqual({ [file]: "theirs" });
		expect(h.vault.trashed.map((trashed) => trashed.content)).toEqual(["mine", "toggled 1", "toggled 2"]);
		expect(await h.records()).toEqual(hashes({ [file]: "theirs" }));
		expect(await h.base()).toBe(head);
	});

	test("the vault refuses the second move to .trash/: the newer file stays, and the first is told as moved", async () => {
		const file = ".obsidian/app.json";
		const h = await synced({ [file]: "{}" });
		h.backend.commit({ [file]: "theirs" });
		h.vault.put(file, "mine");
		h.vault.before = (op, path) => {
			if (path !== file || h.vault.trashed.length === 0) return;
			if (op === "stat" && h.vault.text(file) === undefined) h.vault.put(file, "toggled");
			if (op === "trash") throw new Error("busy");
		};

		const result = await h.pull();

		expect(h.vault.snapshot()).toEqual({ [file]: "toggled" });
		expect(h.vault.trashed.map((trashed) => trashed.content)).toEqual(["mine"]);
		expect(result.unwritable).toMatchObject([{ path: file, reason: "trash-failed", isNew: true }]);
		expect(result.trashed).toEqual([file]);
		expect(result.replacedSettings).toEqual([]);
		expect(await h.records()).toEqual(hashes({ [file]: "{}" }));
		expect(await h.store.readMarkers()).toEqual([]);
	});

	describe("a file in the way that the vault refuses to move to .trash/ stays, is told once, and keeps its record", () => {
		const refuseTrash = (h: Harness): void => {
			h.vault.before = (op) => {
				if (op === "trash") throw new Error("busy");
			};
		};

		test("where the remote has a folder now", async () => {
			const h = await synced({ ".obsidian/snippets": "S", "b.md": "B" });
			h.backend.commit({ ".obsidian/snippets": null, ".obsidian/snippets/a.css": "theirs" });
			h.vault.put(".obsidian/snippets", "edited");
			const before = await h.records();
			refuseTrash(h);

			const first = await h.pull();

			expect(first.unwritable).toMatchObject([
				{ path: ".obsidian/snippets", reason: "trash-failed", isNew: true },
				{ path: ".obsidian/snippets/a.css", reason: "write-failed", isNew: true },
			]);
			expect(first.notices).toEqual([
				{ kind: "unwritable-path", path: ".obsidian/snippets" },
				{ kind: "unwritable-path", path: ".obsidian/snippets/a.css" },
			]);
			expect(first.conflicts).toEqual([]);
			expect(first.trashed).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ ".obsidian/snippets": "edited", "b.md": "B" });
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(before);

			const second = await h.pull();
			expect(second.unwritable).toMatchObject([
				{ path: ".obsidian/snippets", reason: "trash-failed", isNew: false },
				{ path: ".obsidian/snippets/a.css", reason: "write-failed", isNew: false },
			]);
			expect(second.notices).toEqual([]);
			expect(await h.records()).toEqual(before);

			h.vault.before = undefined;
			const third = await h.pull();
			expect(third.outcome).toBe("completed");
			expect(third.trashed).toEqual([".obsidian/snippets"]);
			expect(h.vault.snapshot()).toEqual({ ".obsidian/snippets/a.css": "theirs", "b.md": "B" });
		});

		test("at the name of a rename that only changes the case", async () => {
			const h = await synced({ ".obsidian/snippets/a.css": "remote" }, { caseSensitive: true });
			h.backend.commit({ ".obsidian/snippets/a.css": null, ".obsidian/snippets/A.css": "remote 2" });
			h.vault.put(".obsidian/snippets/A.css", "made here");
			const before = await h.records();
			refuseTrash(h);

			const first = await h.pull();

			expect(first.unwritable).toMatchObject([
				{ path: ".obsidian/snippets/A.css", reason: "trash-failed", isNew: true },
				{ path: ".obsidian/snippets/A.css", reason: "depends-on-unwritable", isNew: false },
			]);
			expect(first.notices).toEqual([{ kind: "unwritable-path", path: ".obsidian/snippets/A.css" }]);
			expect(first.trashed).toEqual([]);
			expect(h.vault.snapshot()).toEqual({
				".obsidian/snippets/A.css": "made here",
				".obsidian/snippets/a.css": "remote",
			});
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(before);

			const second = await h.pull();
			expect(second.notices).toEqual([]);
			expect(await h.records()).toEqual(before);
		});

		test("under the old spelling, edited, beside the remote's content under the new one", async () => {
			const h = await synced({ ".obsidian/snippets/a.css": "old" }, { caseSensitive: true });
			h.vault.putAll({ ".obsidian/snippets/a.css": "edited", ".obsidian/snippets/A.css": "theirs" });
			h.backend.commit({ ".obsidian/snippets/a.css": null, ".obsidian/snippets/A.css": "theirs" });
			const before = await h.records();
			refuseTrash(h);

			const first = await h.pull();

			// Told under the new spelling, which is what the file holds up.
			expect(first.unwritable).toMatchObject([
				{ path: ".obsidian/snippets/a.css", reason: "trash-failed", isNew: true },
			]);
			expect(first.notices).toEqual([{ kind: "unwritable-path", path: ".obsidian/snippets/A.css" }]);
			expect(first.trashed).toEqual([]);
			expect(h.vault.snapshot()).toEqual({
				".obsidian/snippets/A.css": "theirs",
				".obsidian/snippets/a.css": "edited",
			});
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(before);

			const second = await h.pull();
			expect(second.notices).toEqual([]);
			expect(await h.records()).toEqual(before);
		});
	});

	test("a file at the root that is named like the configuration folder is not inside it: it gets a copy", async () => {
		const h = harness();
		h.backend.commit({ ".obsidian/app.json": "theirs" });
		h.vault.put(".obsidian", "a file named like the folder");

		const result = await h.pull();

		// And is asked about, like any file the first fetch moves to a copy.
		expect(h.asked.map((request) => request.firstFetch?.files)).toEqual([
			{ localOnly: [], different: [".obsidian"], differentSettings: [], atSymlinks: [] },
		]);
		const copy = h.copyName(".obsidian");
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: ".obsidian", copyPath: copy, cause: "became-folder" }]);
		expect(result.replacedSettings).toEqual([]);
		expect(result.trashed).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ".obsidian/app.json": "theirs", [copy]: "a file named like the folder" });
	});

	describe("with a history that was rewritten", () => {
		const file = ".obsidian/app.json";
		/** A conflict in the configuration folder, beside a note the remote takes back. */
		async function rewritten(): Promise<{ h: Harness; head: string }> {
			const h = await synced({ [file]: "{}", "a.md": "A1" });
			h.backend.commit({ "a.md": "A2" });
			await h.pull();
			const head = h.backend.rewriteHistory({ [file]: "theirs", "a.md": "A1" });
			h.vault.put(file, "mine");
			return { h, head };
		}

		test("proceed: moved to .trash/ and replaced, and told once", async () => {
			const { h, head } = await rewritten();

			const result = await h.pull();

			expect(result).toMatchObject({ outcome: "completed", rewritten: true });
			expect(h.asked).toHaveLength(1);
			expect(h.vault.snapshot()).toEqual({ [file]: "theirs", "a.md": "A1" });
			expect(h.vault.trashed).toEqual([
				{ path: file, mode: "vault-trash", content: "mine" },
				{ path: "a.md", mode: "vault-trash", content: "A2" },
			]);
			// Not among the files moved away because the history was rewritten.
			expect(result.replacedSettings).toEqual([file]);
			expect(result.trashed).toEqual(["a.md"]);
			expect(result.keptLocal).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(await h.records()).toEqual(hashes({ [file]: "theirs", "a.md": "A1" }));
			expect(await h.base()).toBe(head);
		});

		test("keep mine: the note stays, and the conflict is still moved to .trash/ and replaced", async () => {
			const { h, head } = await rewritten();
			h.answer = "keep-local";

			const result = await h.pull();

			expect(result).toMatchObject({ outcome: "completed", rewritten: true });
			expect(h.vault.snapshot()).toEqual({ [file]: "theirs", "a.md": "A2" });
			expect(h.vault.trashed).toEqual([{ path: file, mode: "vault-trash", content: "mine" }]);
			expect(result.replacedSettings).toEqual([file]);
			expect(result.trashed).toEqual([]);
			// A conflict is not a file the answer is about.
			expect(result.keptLocal).toEqual(["a.md"]);
			expect(result.conflicts).toEqual([]);
			expect(await h.records()).toEqual(hashes({ [file]: "theirs", "a.md": "A1" }));
			expect(await h.base()).toBe(head);
		});
	});

	test("the marker of a copy that an earlier version was killed over is settled, and its conflict told once", async () => {
		const file = ".obsidian/app.json";
		const copy = ".obsidian/app.conflict-from-iPhone-20260101-090000.json";
		const h = await synced({ [file]: "theirs" });
		// As that version left it: the copy and the file written, the record
		// stored, and the marker of the copy still there.
		h.vault.put(copy, "mine");
		await h.store.putMarker(makeMarker(copy, null, blobHash("mine"), true));

		const first = await h.pull();

		expect(first.outcome).toBe("completed");
		expect(first.conflicts).toEqual([{ path: file, copyPath: copy, cause: "conflict" }]);
		expect(first.replacedSettings).toEqual([]);
		expect(first.halfCopies).toEqual([]);
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();

		// From here on the copy is a file the sync leaves out.
		h.vault.log.length = 0;
		const second = await h.pull();
		expect(second.outcome).toBe("completed");
		expect(second.conflicts).toEqual([]);
		expect(h.asked).toEqual([]);
		expect(h.vault.log).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ [file]: "theirs", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([]);
		expect(await h.records()).toEqual(hashes({ [file]: "theirs" }));
	});

	test("a copy an earlier version sent, edited here and deleted on the remote: it stays, and only its record goes", async () => {
		const file = ".obsidian/app.json";
		const copy = ".obsidian/app.conflict-from-Mac-20260101-090000.json";
		const h = await synced({ [file]: "theirs", [copy]: "old" });
		expect(await h.records()).toEqual(hashes({ [file]: "theirs", [copy]: "old" }));
		const head = h.backend.commit({ [copy]: null });
		h.vault.put(copy, "edited");

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ [file]: "theirs", [copy]: "edited" });
		expect(h.vault.trashed).toEqual([]);
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(await h.records()).toEqual(hashes({ [file]: "theirs" }));
		expect(await h.base()).toBe(head);

		// Left out from then on, like a copy that never had a record.
		h.vault.log.length = 0;
		const again = await h.pull();
		expect(again.outcome).toBe("completed");
		expect(h.vault.log).toEqual([]);
		expect(h.vault.text(copy)).toBe("edited");
		expect(await h.records()).toEqual(hashes({ [file]: "theirs" }));
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
		h.vault.put("drafts/hidden-by-a-rule.icloud", "kept");

		const result = await h.pull();

		expect(result.unwritable).toMatchObject([{ path: "drafts", reason: "folder-in-the-way" }]);
		expect(h.vault.snapshot()).toEqual({ notes: "a file", "drafts/hidden-by-a-rule.icloud": "kept" });
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
		expect(h.asked[0]?.losses?.rewritten).toBe(false);
		expect(h.asked[0]?.losses?.deletions).toHaveLength(10);
		expect(h.asked[0]?.recordCount).toBe(12);
		expect(h.vault.snapshot()).toEqual(many);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes(many));
		expect(await h.base()).toBe(base);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
	});

	test("stopped while the question is open: a stop and not a no, and what was confirmed before stays", async () => {
		const { h, base } = await withTenDeleted();
		const before = { rewritten: false, deletions: ["f00.md"], overwrites: [] };
		await h.store.setMeta(PULL_CONFIRMATION_KEY, before);
		const stop = new AbortController();
		// The dialog closes as "cancel" when the pull is stopped.
		h.answer = () => {
			stop.abort();
			return "cancel";
		};

		const result = await h.pull({ signal: stop.signal });

		expect(result.outcome).toBe("cancelled");
		expect(h.asked).toHaveLength(1);
		expect(h.vault.snapshot()).toEqual(many);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes(many));
		expect(await h.base()).toBe(base);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toEqual(before);
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
				firstFetch: null,
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
		// The file is only on this device. It is the push that sends it which asks.
		expect(h.asked).toEqual([]);
	});

	test("with nothing pulled before and an empty vault: nothing is asked", async () => {
		const h = harness();
		expect((await h.pull()).outcome).toBe("remote-empty");
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

		expect(h.asked[0]?.losses?.overwrites).toEqual([{ key: ".gitignore", path: ".gitignore" }]);
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

	test("a submodule on the remote is told once, for as long as the remote has it, and its folder is not made", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", knowledge: "the commit it points to" });
		h.backend.submodules.add("knowledge");

		const first = await h.pull();

		expect(first.notices).toEqual([{ kind: "submodule", path: "knowledge" }]);
		expect(h.vault.paths()).toEqual(["a.md"]);

		h.backend.commit({ "a.md": "A2" });
		expect((await h.pull()).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "submodule", path: "knowledge" }]);

		h.backend.commit({ knowledge: null });
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
		from = "notes/x.md",
		to = "Notes/x.md",
	): Promise<{ vault: MemoryPullVault; tally: Tally; seen: Map<string, Seen> }> {
		const time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const vault = new MemoryPullVault({ caseSensitive: false, now: () => time });
		vault.put(from, "X");
		if (refuseRenames) {
			vault.before = (op) => {
				if (op === "rename" || op === "trash") throw new Error("busy");
			};
		}
		const local = { path: from, hash: blobHash("X"), size: 1 };
		const empty = planPull({
			remote: [],
			local: [],
			records: [],
			exclusion: createExclusion({ ...paths, gitignore: null }),
		});
		const tally = new Tally();
		const seen = new Map<string, Seen>([[from, { hash: local.hash, stat: { mtime: time, size: 1 } }]]);
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
				localPaths: [from],
				tally,
				beforeWrite: async () => {},
				configDir: paths.configDir,
				communityPluginsKey: ".obsidian/community-plugins.json",
				pluginId: "sync-evo",
			},
			{ ...empty, strays: [{ local, to, aside }] },
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

	test("inside the configuration folder it goes to .trash/ instead of a copy", async () => {
		const from = ".obsidian/snippets/x.css";
		const { vault, tally, seen } = await moveStray(true, false, from, ".obsidian/Snippets/x.css");
		expect(vault.paths()).toEqual([]);
		expect(vault.trashed).toEqual([{ path: from, mode: "vault-trash", content: "X" }]);
		expect(tally.conflicts).toEqual([]);
		expect(tally.trashed).toEqual([from]);
		expect([...seen.keys()]).toEqual([]);
	});

	test("inside the configuration folder, a move to .trash/ the vault refuses is told, and the file stays", async () => {
		const from = ".obsidian/snippets/x.css";
		const { vault, tally, seen } = await moveStray(true, true, from, ".obsidian/Snippets/x.css");
		expect(vault.paths()).toEqual([from]);
		expect(vault.trashed).toEqual([]);
		expect(tally.unwritable).toMatchObject([{ path: from, reason: "trash-failed" }]);
		expect(tally.refused).toEqual([{ remotePath: from, reportedAs: from }]);
		expect(tally.conflicts).toEqual([]);
		expect(tally.trashed).toEqual([]);
		expect([...seen.keys()]).toEqual([from]);
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
		// Neither write was begun: both markers are gone, and nothing was moved away.
		expect(await h.store.readMarkers()).toEqual([]);
		expect(result.halfWritten).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
	});
});

describe("the question before a first fetch", () => {
	const remote = { "same.md": "S", "different.md": "theirs", "new.md": "N", ".gitignore": "/drafts/\n" };
	const mine = { "same.md": "S", "different.md": "mine", "only-here.md": "O" };

	test("a vault with files of its own is asked about them, by path", async () => {
		const h = harness();
		h.backend.commit(remote);
		h.vault.putAll(mine);
		h.answer = "cancel";

		await h.pull();

		expect(h.asked).toEqual([
			{
				losses: null,
				recordCount: 0,
				firstFetch: {
					files: { localOnly: ["only-here.md"], different: ["different.md"], differentSettings: [], atSymlinks: [] },
					discardsState: false,
				},
			},
		]);
	});

	test("a no changes nothing: no file, no record, no .gitignore, nothing remembered", async () => {
		const h = harness();
		h.backend.commit(remote);
		h.vault.putAll(mine);
		h.answer = "cancel";

		const result = await h.pull();

		expect(result.outcome).toBe("declined");
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(h.vault.snapshot()).toEqual(mine);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual({});
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBeNull();
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toBeUndefined();
		expect(h.views).toEqual([]);

		// Asked again by the next pull, and by every one until it is answered.
		await h.pull();
		expect(h.asked).toHaveLength(2);
	});

	test("a yes pulls: what differs is kept as a copy, nothing is lost, and the answer is remembered", async () => {
		const h = harness();
		const head = h.backend.commit(remote);
		h.vault.putAll(mine);

		const result = await h.pull();

		const copy = h.copyName("different.md");
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: "different.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ ...remote, [copy]: "mine", "only-here.md": "O" });
		expect(h.vault.trashed).toEqual([]);
		expect(await h.base()).toBe(head);
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
		expect(h.asked).toHaveLength(1);
	});

	test("an empty vault is not asked, and neither is one that only holds what the remote holds", async () => {
		const empty = harness();
		empty.backend.commit(remote);
		expect((await empty.pull()).outcome).toBe("completed");
		expect(empty.asked).toEqual([]);

		const same = harness();
		same.backend.commit(remote);
		same.vault.putAll({ "same.md": "S", "new.md": "N" });
		expect((await same.pull()).outcome).toBe("completed");
		expect(same.asked).toEqual([]);
		// Nothing was asked. Done, it is no first fetch any more all the same.
		expect(await isFirstFetchConfirmed(empty.store)).toBe(true);
		expect(await isFirstFetchConfirmed(same.store)).toBe(true);
	});

	test("files that are only here are no reason to ask: they stay as they are, for the push that sends them to ask about", async () => {
		const h = harness();
		const head = h.backend.commit(remote);
		const own = { "same.md": "S", "only-here.md": "O", "notes/too.md": "T" };
		h.vault.putAll(own);

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(result.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ ...remote, ...own });
		expect(await h.records()).toEqual(hashes(remote));
		expect(await h.base()).toBe(head);
		// Done, it is no first fetch any more: files that come later are not asked about either.
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
	});

	test("a first fetch that stopped halfway goes on without asking again", async () => {
		const h = harness();
		h.backend.commit(remote);
		h.vault.putAll(mine);
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};

		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(await h.base()).toBeNull();
		expect(h.asked).toHaveLength(1);

		h.vault.before = undefined;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(h.vault.snapshot()).toMatchObject({ "different.md": "theirs", "only-here.md": "O", "new.md": "N" });
	});

	test("an empty remote: nothing is asked, the vault is not looked through, and nothing is remembered", async () => {
		const h = harness();
		h.backend.emptied = true;
		h.vault.putAll({ "a.md": "A", "notes/b.md": "B" });
		const read: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "read") read.push(path);
		};

		expect((await h.pull()).outcome).toBe("remote-empty");
		expect((await h.pull()).outcome).toBe("remote-empty");

		// Nothing comes from an empty remote. What goes there is asked
		// about by the push that sends it, which still finds it unasked.
		expect(h.asked).toEqual([]);
		expect(read).toEqual([]);
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);
		expect(await h.base()).toBeNull();
	});

	test("the answer goes with the sync state: after a discard it is asked again", async () => {
		const h = harness();
		h.backend.commit(remote);
		h.vault.putAll(mine);
		await h.pull();
		expect(h.asked).toHaveLength(1);
		const copy = h.copyName("different.md");

		// As a change of the repository or the branch does.
		h.store.clear();
		h.vault.put("later.md", "L");
		h.vault.put("same.md", "edited");
		h.answer = "cancel";
		await h.pull();

		expect(h.asked).toHaveLength(2);
		// Not compared by the records of before: nothing is a deletion, the
		// edit is a file that differs and not a change to send, and what the
		// vault holds beyond the remote is only on this device.
		expect(h.asked[1]?.firstFetch?.files).toEqual({
			localOnly: [copy, "later.md", "only-here.md"],
			different: ["same.md"],
			differentSettings: [],
			atSymlinks: [],
		});
		expect(h.asked[1]?.losses).toBeNull();
	});

	test("the answer stays when the remote became empty and took the base with it", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("a.md", "mine");
		await h.pull();
		expect(h.asked).toHaveLength(1);

		h.backend.emptied = true;
		expect((await h.pull()).outcome).toBe("completed");
		expect(await h.base()).toBeNull();
		// That was the question about a rewritten history, not this one.
		expect(h.asked).toHaveLength(2);
		expect(h.asked[1]?.firstFetch).toBeNull();
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);

		expect((await h.pull()).outcome).toBe("remote-empty");
		h.backend.emptied = false;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(2);
	});

	test("a first fetch that had nothing to ask is done all the same: a remote emptied later does not bring the question back", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B" });
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);

		h.vault.put("mine.md", "M");
		h.backend.emptied = true;
		// The question about a rewritten history, which is answered with yes.
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.losses?.rewritten).toBe(true);
		expect(h.asked[0]?.firstFetch).toBeNull();
		expect(await h.base()).toBeNull();
		expect(h.vault.snapshot()).toEqual({ "mine.md": "M" });

		// No head and no base, as before the first fetch. But that one was
		// done: the vault is not looked through, and nothing is asked.
		const looked: string[] = [];
		h.vault.before = (op, path) => {
			looked.push(`${op} ${path}`);
		};
		expect((await h.pull()).outcome).toBe("remote-empty");
		expect(h.asked).toHaveLength(1);
		expect(looked).toEqual([]);
	});

	test("a first fetch with nothing to ask that did not get to the end still asks about files that came since", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(h.asked).toEqual([]);
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);

		h.vault.before = undefined;
		h.vault.put("b.md", "mine");
		h.vault.put("mine.md", "M");
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.firstFetch?.files).toMatchObject({ localOnly: ["mine.md"], different: ["b.md"] });
	});

	test("a file at the path of a symlink is counted, and is no reason to ask by itself", async () => {
		const h = harness();
		h.backend.symlinks.add("link");
		h.backend.commit({ link: "../target", "a.md": "A" });
		h.vault.put("link", "a file here");

		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(h.vault.text("link")).toBe("a file here");
		expect(h.copies()).toEqual([]);

		const other = harness();
		other.backend.symlinks.add("link");
		other.backend.commit({ link: "../target", "a.md": "A" });
		other.vault.putAll({ link: "a file here", "a.md": "mine", "only-here.md": "O" });
		await other.pull();
		expect(other.asked[0]?.firstFetch?.files).toEqual({
			localOnly: ["only-here.md"],
			different: ["a.md"],
			differentSettings: [],
			atSymlinks: ["link"],
		});
	});

	test("excluded paths are not counted: the plugin's own folder, .git, and what .gitignore of the remote names", async () => {
		const h = harness();
		h.backend.commit(remote);
		h.vault.putAll({
			".obsidian/plugins/sync-evo/main.js": "M",
			".obsidian/plugins/sync-evo/data.json": "{}",
			".git/config": "G",
			"drafts/secret.md": "D",
		});

		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toEqual([]);

		const other = harness();
		other.backend.commit(remote);
		other.vault.putAll({
			".obsidian/plugins/sync-evo/main.js": "M",
			"drafts/secret.md": "D",
			"different.md": "mine",
			"mine.md": "X",
		});
		await other.pull();
		expect(other.asked[0]?.firstFetch?.files).toMatchObject({ localOnly: ["mine.md"], different: ["different.md"] });
	});

	test("with deletions to confirm in the same pull, both are one question", async () => {
		const h = harness();
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) files[`f${i}.md`] = `F${i}`;
		h.backend.commit({ ...files, "z.md": "Z" });
		// Stopped before the last file: ten records, no base, nothing asked.
		const stop = new AbortController();
		let writes = 0;
		h.vault.before = (op) => {
			if (op === "write" && ++writes === 10) stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(Object.keys(await h.records())).toHaveLength(10);
		expect(h.asked).toEqual([]);
		h.vault.before = undefined;

		const gone: Record<string, null> = {};
		for (let i = 0; i < 8; i++) gone[`f${i}.md`] = null;
		const head = h.backend.commit(gone);
		h.vault.put("only-here.md", "O");
		// The file that was not written yet, with other content: the reason to ask.
		h.vault.put("z.md", "mine");

		const result = await h.pull();

		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.losses?.deletions).toHaveLength(8);
		expect(h.asked[0]?.firstFetch).toEqual({
			files: { localOnly: ["only-here.md"], different: ["z.md"], differentSettings: [], atSymlinks: [] },
			discardsState: false,
		});
		expect(result.outcome).toBe("completed");
		expect(result.counts.deleted).toBe(8);
		expect(await h.base()).toBe(head);
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
		expect(h.vault.paths()).toEqual(["f8.md", "f9.md", "only-here.md", h.copyName("z.md"), "z.md"].sort());
	});
});

describe("starting over: the first fetch command", () => {
	/**
	 * A pull that starts over. `discards` counts how often the sync state was
	 * discarded. As on a device, the store that was open is closed by the
	 * discard and another one, empty, takes its place: whatever the pull
	 * still asks of the old one throws.
	 */
	function startingOver(h: Harness): { discards: number; pull(overrides?: Partial<PullDeps>): Promise<PullResult> } {
		const run = {
			discards: 0,
			pull: (overrides: Partial<PullDeps> = {}) =>
				h.pull({
					discardState: async (seed) => {
						run.discards += 1;
						await h.store.close();
						h.store = new MemoryStateStore();
						await h.store.startOver(seed);
						return h.store;
					},
					...overrides,
				}),
		};
		return run;
	}

	/** In sync on three files, then: one edited here, one only here, and something remembered. */
	async function used(): Promise<Harness> {
		const h = await synced({ "a.md": "A", "b.md": "B", "c.md": "C" });
		h.vault.put("b.md", "edited here");
		h.vault.put("only-here.md", "O");
		await h.store.setMeta(ARCHIVE_DISABLED_KEY, true);
		return h;
	}

	test("asks once, with the files counted as if nothing had been synced", async () => {
		const h = await used();
		h.answer = "cancel";

		await startingOver(h).pull();

		// With its record, the edited file is a change to send. Without, it
		// differs from the remote.
		expect(h.asked).toEqual([
			{
				losses: null,
				recordCount: 0,
				firstFetch: {
					files: { localOnly: ["only-here.md"], different: ["b.md"], differentSettings: [], atSymlinks: [] },
					discardsState: true,
				},
			},
		]);
	});

	test("a no discards nothing: the sync state is not even looked at", async () => {
		const h = await used();
		const base = await h.base();
		const records = await h.records();
		const calls: string[] = [];
		const watched = new Proxy(h.store, {
			get(target, name) {
				const value: unknown = Reflect.get(target, name, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					calls.push(String(name));
					return (value as (...rest: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		h.answer = "cancel";
		const run = startingOver(h);

		const result = await run.pull({ store: watched });

		expect(result.outcome).toBe("declined");
		expect(run.discards).toBe(0);
		expect(calls).toEqual([]);
		expect(await h.base()).toBe(base);
		expect(await h.records()).toEqual(records);
		expect(await h.store.getMeta(ARCHIVE_DISABLED_KEY)).toBe(true);
		expect(h.vault.log).toEqual([]);
		expect(h.vault.text("b.md")).toBe("edited here");
	});

	test("a yes discards the state, rebuilds it, and is the answer to the question before a first fetch", async () => {
		const h = await used();
		const head = (await h.store.getListing())?.revision;
		const run = startingOver(h);

		const result = await run.pull();

		const copy = h.copyName("b.md");
		expect(run.discards).toBe(1);
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: "b.md", copyPath: copy, cause: "conflict" }]);
		// Only the file that differs is fetched: the others get their record back.
		expect(result.counts.fetched).toBe(1);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B", [copy]: "edited here", "c.md": "C", "only-here.md": "O" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B", "c.md": "C" }));
		expect(await h.base()).toBe(head);
		expect(await h.store.getMeta(FIRST_FETCH_CONFIRMED_KEY)).toBe(true);
		// What the device remembered of the zip went with the state.
		expect(await h.store.getMeta(ARCHIVE_DISABLED_KEY)).toBeUndefined();
		expect(h.asked).toHaveLength(1);
		// The listing is kept for the next pull, which asks nothing.
		expect((await h.store.getListing())?.revision).toBe(head);
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
	});

	test("stopped halfway after a yes: the pull that resumes does not ask", async () => {
		const h = await used();
		h.backend.commit({ "d.md": "D", "e.md": "E" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};

		expect((await startingOver(h).pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(await h.base()).toBeNull();
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);

		h.vault.before = undefined;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
	});

	test("asks also when no file is counted", async () => {
		const h = await synced({ "a.md": "A" });
		const run = startingOver(h);

		const result = await run.pull();

		expect(h.asked).toEqual([
			{
				losses: null,
				recordCount: 0,
				firstFetch: { files: { localOnly: [], different: [], differentSettings: [], atSymlinks: [] }, discardsState: true },
			},
		]);
		expect(run.discards).toBe(1);
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(0);
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
	});

	test("with an empty remote: asked, discarded, and the answer is remembered", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.emptied = true;
		const run = startingOver(h);

		const result = await run.pull();

		expect(result.outcome).toBe("remote-empty");
		expect(h.asked[0]?.firstFetch).toEqual({
			files: { localOnly: ["a.md"], different: [], differentSettings: [], atSymlinks: [] },
			discardsState: true,
		});
		expect(run.discards).toBe(1);
		expect(await h.records()).toEqual({});
		expect(h.vault.snapshot()).toEqual({ "a.md": "A" });
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
		// Not the question about a rewritten history: there is no base any more.
		expect((await h.pull()).outcome).toBe("remote-empty");
		expect(h.asked).toHaveLength(1);
	});

	test("a discard that fails fails the pull: no file is touched and nothing is remembered", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "theirs", "new.md": "N" });
		const mine = { "a.md": "mine", "only-here.md": "O" };
		h.vault.putAll(mine);
		const store = h.store;

		await expect(
			h.pull({
				discardState: async (): Promise<StateStore> => {
					throw new Error("the sync state could not be removed");
				},
			}),
		).rejects.toThrow("the sync state could not be removed");

		expect(h.asked).toHaveLength(1);
		expect(h.vault.snapshot()).toEqual(mine);
		expect(h.vault.log).toEqual([]);
		expect(h.views).toEqual([]);
		// The yes is not remembered anywhere: the state that was to be
		// discarded is as it was, and no other was made.
		expect(h.store).toBe(store);
		expect(await isFirstFetchConfirmed(store)).toBe(false);
		expect(await store.getListing()).toBeNull();
		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();
	});

	test("stopped right after the discard: the empty state has the listing and the answer, and no file is touched", async () => {
		const h = await used();
		const head = (await h.store.getListing())?.revision;
		const before = h.vault.snapshot();
		const old = h.store;
		const stop = new AbortController();

		const result = await h.pull({
			signal: stop.signal,
			discardState: async (seed) => {
				await h.store.close();
				h.store = new MemoryStateStore();
				await h.store.startOver(seed);
				// As a change of the connection that came while the state was removed.
				stop.abort();
				return h.store;
			},
		});

		expect(result.outcome).toBe("cancelled");
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(h.vault.snapshot()).toEqual(before);
		expect(h.vault.log).toEqual([]);
		expect(h.views).toEqual([]);
		expect(h.store).not.toBe(old);
		expect((await h.store.getListing())?.revision).toBe(head);
		expect(await isFirstFetchConfirmed(h.store)).toBe(true);
		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();

		// The pull that follows is the first fetch that was said yes to.
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B", "c.md": "C" }));
	});

	test("stopped while the question is open: nothing is discarded", async () => {
		const h = await used();
		const base = await h.base();
		const stop = new AbortController();
		h.answer = () => {
			stop.abort();
			return "proceed";
		};
		const run = startingOver(h);

		const result = await run.pull({ signal: stop.signal });

		expect(result.outcome).toBe("cancelled");
		expect(run.discards).toBe(0);
		expect(await h.base()).toBe(base);
		expect(h.vault.log).toEqual([]);
	});
});

describe("going on after a pull that stopped while writing", () => {
	const isCopy = (path: string): boolean => originalPathOfConflictCopy(path) !== null;

	/**
	 * The app is killed right before the vault writes the first path that
	 * matches. `leave` stands in for what a write that was cut short left.
	 */
	function killBeforeWrite(h: Harness, matches: (path: string) => boolean, leave?: (path: string) => void): void {
		h.vault.before = (op, path) => {
			h.crash.gate(false);
			if (op !== "write" || !matches(path)) return;
			leave?.(path);
			h.crash.dead = true;
			throw new Error("the app is gone");
		};
	}

	/** A store that kills the app right before `method` is called for `path`. */
	function killingStore(h: Harness, method: keyof StateStore, path: string): StateStore {
		return new Proxy(h.store, {
			get(target, name) {
				const value: unknown = Reflect.get(target, name, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					h.crash.gate(false);
					const subject = args[0] as { path?: string } | string | undefined;
					if (name === method && (typeof subject === "string" ? subject : subject?.path) === path) {
						h.crash.dead = true;
						throw new Error("the app is gone");
					}
					return (value as (...rest: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}

	/** The app is started again. */
	function restart(h: Harness): void {
		h.crash.revive();
		h.vault.before = (op) => h.crash.gate(VAULT_CHANGES.has(op));
		h.vault.log.length = 0;
	}

	const markerPaths = async (h: Harness): Promise<string[]> =>
		(await h.store.readMarkers()).map((marker) => marker.path);

	test("stopped after many files, with the remote changed since: no conflict, and only the rest is fetched", async () => {
		const h = harness();
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) files[`n${String(i).padStart(2, "0")}.md`] = `v1 ${i}`;
		h.backend.commit(files);
		const stop = new AbortController();
		let writes = 0;
		h.vault.before = (op) => {
			if (op === "write" && ++writes === 10) stop.abort();
		};
		const first = await h.pull({ signal: stop.signal });
		expect(first.outcome).toBe("cancelled");
		expect(first.counts.fetched).toBe(10);
		expect(Object.keys(await h.records()).length).toBe(10);
		expect(await h.base()).toBeNull();
		expect(await h.store.readMarkers()).toEqual([]);

		// The Mac pushes: a file this device has, one it has not, and a new one.
		const head = h.backend.commit({ "n03.md": "v2 3", "n20.md": "v2 20", "new.md": "N" });
		h.vault.before = undefined;
		const asked: string[] = [];
		const second = await h.pull({
			fetchContents: (revision, entries) => {
				asked.push(...entries.map((entry) => entry.path));
				return h.backend.fetch(revision, entries);
			},
		});

		expect(second.outcome).toBe("completed");
		expect(second.conflicts).toEqual([]);
		expect(second.halfWritten).toEqual([]);
		expect(h.copies()).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		// The 20 that were left, the one that changed, and the new one.
		expect(second.counts.fetched).toBe(22);
		expect(asked).toContain("n03.md");
		expect(asked).not.toContain("n04.md");
		expect(h.vault.snapshot()).toEqual({ ...files, "n03.md": "v2 3", "n20.md": "v2 20", "new.md": "N" });
		expect(await h.base()).toBe(head);
	});

	test("killed right after a file was written, and the remote changed it again: an ordinary fetch", async () => {
		for (const existed of [false, true]) {
			const h = existed ? await synced({ "a.md": "A", "b.md": "B" }) : harness();
			h.backend.commit({ "a.md": "A2", "b.md": "B" });
			await expect(h.pull({ store: killingStore(h, "commitWrite", "a.md") })).rejects.toThrow("the app is gone");
			expect(h.vault.text("a.md")).toBe("A2");
			expect(await markerPaths(h)).toEqual(["a.md"]);
			expect((await h.records())["a.md"]).toBe(existed ? blobHash("A") : undefined);

			restart(h);
			const head = h.backend.commit({ "a.md": "A3" });
			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(result.conflicts).toEqual([]);
			expect(result.halfWritten).toEqual([]);
			expect(h.vault.trashed).toEqual([]);
			expect(h.copies()).toEqual([]);
			expect(h.vault.text("a.md")).toBe("A3");
			expect(h.vault.log).toContain("write a.md");
			expect(await h.records()).toEqual(hashes({ "a.md": "A3", "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		}
	});

	test("killed right after a file was written, and the remote did not change: only its record is made", async () => {
		const h = await synced({ "a.md": "A" });
		const head = h.backend.commit({ "a.md": "A2" });
		await expect(h.pull({ store: killingStore(h, "commitWrite", "a.md") })).rejects.toThrow("the app is gone");
		restart(h);

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A2" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
	});

	test("killed in the middle of a write: the half file is replaced by the remote's content, with no conflict and no copy", async () => {
		for (const existed of [false, true]) {
			const h = existed ? await synced({ "a.md": "A", "b.md": "B" }) : harness();
			const head = h.backend.commit({ "a.md": "A2 in full", "b.md": "B" });
			killBeforeWrite(
				h,
				(path) => path === "a.md",
				() => h.vault.put("a.md", "A2 in"),
			);
			await expect(h.pull()).rejects.toThrow("the app is gone");
			expect(h.vault.text("a.md")).toBe("A2 in");
			expect(await markerPaths(h)).toEqual(["a.md"]);

			restart(h);
			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(result.conflicts).toEqual([]);
			expect(h.copies()).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B" });
			// Whatever the app's setting for deleted files.
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 in" }]);
			expect(result.halfWritten).toEqual(["a.md"]);
			// Not among the files moved away because the history was rewritten.
			expect(result.trashed).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "a.md": "A2 in full", "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
			// Told once.
			expect((await h.pull()).halfWritten).toEqual([]);
		}
	});

	test("killed in the middle of a write, then the note was edited: the edit is in the trash and told, the name has the remote's content", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2 in full" });
		killBeforeWrite(
			h,
			(path) => path === "a.md",
			() => h.vault.put("a.md", "A2 in"),
		);
		await expect(h.pull()).rejects.toThrow("the app is gone");
		restart(h);
		h.vault.put("a.md", "A2 in, and what I typed");

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full" });
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 in, and what I typed" }]);
		expect(result.halfWritten).toEqual(["a.md"]);
		expect(result.conflicts).toEqual([]);
		expect(h.copies()).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A2 in full" }));
	});

	test("an edit that an editor has not saved yet goes to the trash with the file", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2 in full" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2 in full"), false));
		h.vault.put("a.md", "A2 in");
		h.vault.open("a.md", "A2 in, typed");

		const result = await h.pull();
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 in, typed" }]);
		expect(result.halfWritten).toEqual(["a.md"]);
		expect(h.vault.text("a.md")).toBe("A2 in full");
	});

	test("killed after the marker and before the write: nothing goes to the trash", async () => {
		for (const existed of [false, true]) {
			const h = existed ? await synced({ "a.md": "A" }) : harness();
			const head = h.backend.commit({ "a.md": "A2" });
			killBeforeWrite(h, (path) => path === "a.md");
			await expect(h.pull()).rejects.toThrow("the app is gone");
			expect(h.vault.text("a.md")).toBe(existed ? "A" : undefined);
			expect(await markerPaths(h)).toEqual(["a.md"]);

			restart(h);
			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(h.vault.trashed).toEqual([]);
			expect(result.halfWritten).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2" });
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		}
	});

	test("killed after the copy of a conflict and before the file: the copy is neither lost nor made twice", async () => {
		// With the marker of the file stored already, and without.
		for (const atMarker of [false, true]) {
			const h = await synced({ "a.md": "A" });
			const head = h.backend.commit({ "a.md": "theirs" });
			h.vault.put("a.md", "mine");
			if (atMarker) {
				await expect(h.pull({ store: killingStore(h, "putMarker", "a.md") })).rejects.toThrow("the app is gone");
			} else {
				killBeforeWrite(h, (path) => path === "a.md");
				await expect(h.pull()).rejects.toThrow("the app is gone");
			}
			const copy = h.copyName("a.md");
			expect(h.vault.snapshot()).toEqual({ "a.md": "mine", [copy]: "mine" });
			expect(await markerPaths(h)).toEqual(atMarker ? [copy] : [copy, "a.md"]);

			restart(h);
			const result = await h.pull();

			expect(result.outcome).toBe("completed");
			expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
			expect(h.vault.log).toEqual(["write a.md"]);
			expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
			expect(h.vault.trashed).toEqual([]);
			expect(result.halfWritten).toEqual([]);
			// The copy has no record.
			expect(await h.records()).toEqual(hashes({ "a.md": "theirs" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		}
	});

	test("killed after the copy, and the remote changed the file again: the newer content is written, beside the one copy", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(h, (path) => path === "a.md");
		await expect(h.pull()).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");

		restart(h);
		h.backend.commit({ "a.md": "theirs, again" });
		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs, again", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([]);
	});

	test("killed in the middle of the file of a conflict: the half file goes to the trash, and the copy keeps the content", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(
			h,
			(path) => path === "a.md",
			() => h.vault.put("a.md", "the"),
		);
		await expect(h.pull()).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");

		restart(h);
		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "the" }]);
		expect(result.halfWritten).toEqual(["a.md"]);
		expect(await h.store.readMarkers()).toEqual([]);
		// What the user had is in the copy, which the line about the file
		// that was moved away does not name: told as the conflict it is.
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(pullReport(translatorFor("en"), result, reportOptions).details).toEqual([
			`The content of 1 file on this device was kept under another name:\n${copy} (a conflict: a.md now has the content of the remote)`,
			"An earlier pull stopped while it was writing 1 file. What was left of it was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited the file since, you can get your edit back from there:\na.md",
		]);
		expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();
		// Told once.
		const next = await h.pull();
		expect(next.conflicts).toEqual([]);
		expect(next.halfWritten).toEqual([]);
	});

	test("killed in the middle of the file of a conflict, and the next pull does not get to the file: the conflict is told by the pull that writes it", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(
			h,
			(path) => path === "a.md",
			() => h.vault.put("a.md", "the"),
		);
		await expect(h.pull()).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");
		restart(h);

		const stop = new AbortController();
		const stopped = await h.pull({
			signal: stop.signal,
			onProgress: (event) => event.phase === "scanning" && stop.abort(),
		});
		expect(stopped.outcome).toBe("cancelled");
		expect(stopped.halfWritten).toEqual(["a.md"]);
		// `a.md` does not have the content of the remote: it is not there.
		expect(stopped.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ [copy]: "mine" });
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toEqual([
			{ path: "a.md", copyPath: copy, hash: blobHash("mine") },
		]);

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.halfWritten).toEqual([]);
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("killed in the middle of the copy of a conflict: the half copy goes to the trash, and one whole copy is made", async () => {
		const h = await synced({ "a.md": "A" });
		const head = h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(h, isCopy, (path) => h.vault.put(path, "mi"));
		await expect(h.pull()).rejects.toThrow("the app is gone");
		const half = h.copyName("a.md");
		expect(h.vault.snapshot()).toEqual({ "a.md": "mine", [half]: "mi" });
		expect(await markerPaths(h)).toEqual([half]);

		restart(h);
		const result = await h.pull();

		const copy = h.copyName("a.md");
		expect(copy).not.toBe(half);
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([{ path: half, mode: "vault-trash", content: "mi" }]);
		// Told as a copy, and not as a file that is fetched again.
		expect(result.halfCopies).toEqual([half]);
		expect(result.halfWritten).toEqual([]);
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(await h.records()).toEqual(hashes({ "a.md": "theirs" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.base()).toBe(head);
	});

	test("killed before the copy of a conflict was begun: the conflict is handled from the start", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(h, isCopy);
		await expect(h.pull()).rejects.toThrow("the app is gone");
		expect(h.copies()).toEqual([]);
		expect((await h.store.readMarkers()).map((marker) => marker.conflictCopy)).toEqual([true]);

		restart(h);
		const result = await h.pull();
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [h.copyName("a.md")]: "mine" });
		expect(h.vault.trashed).toEqual([]);
		expect(result.halfWritten).toEqual([]);
		expect(await h.store.readMarkers()).toEqual([]);
	});

	test("killed after the record of a conflict and before the marker of its copy went: only the marker goes, and the conflict is told", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		let copy = "";
		const store = new Proxy(h.store, {
			get(target, name) {
				const value: unknown = Reflect.get(target, name, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					h.crash.gate(false);
					if (name === "deleteMarker" && isCopy(String(args[0]))) {
						copy = String(args[0]);
						h.crash.dead = true;
						throw new Error("the app is gone");
					}
					return (value as (...rest: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		await expect(h.pull({ store })).rejects.toThrow("the app is gone");
		expect(await markerPaths(h)).toEqual([copy]);

		restart(h);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.log).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.vault.trashed).toEqual([]);
		expect(await h.store.readMarkers()).toEqual([]);
		// The pull that made the copy was killed before it told.
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("killed between the file of a conflict and its record: one copy, the record of the remote, and the conflict is told", async () => {
		const h = await synced({ "a.md": "A" });
		const head = h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		await expect(h.pull({ store: killingStore(h, "commitWrite", "a.md") })).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect((await markerPaths(h)).sort()).toEqual([copy, "a.md"].sort());
		expect((await h.records())["a.md"]).toBe(blobHash("A"));

		restart(h);
		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		// Nothing was left to do but the record, so no step of the plan
		// would have told it.
		expect(h.vault.log).toEqual([]);
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 1 });
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(pullReport(translatorFor("en"), result, reportOptions).details).toEqual([
			`The content of 1 file on this device was kept under another name:\n${copy} (a conflict: a.md now has the content of the remote)`,
		]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.copies()).toEqual([copy]);
		expect(h.vault.trashed).toEqual([]);
		expect(result.halfWritten).toEqual([]);
		expect(result.halfCopies).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "theirs" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
		expect(await h.base()).toBe(head);
		// Told once.
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("a conflict found finished is told also when the pull that found it was killed", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		await expect(h.pull({ store: killingStore(h, "commitWrite", "a.md") })).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");
		restart(h);

		// Settled, and then the scan fails.
		h.vault.before = (op) => {
			if (op === "list") throw new Error("the disk is gone");
		};
		await expect(h.pull()).rejects.toThrow("the disk is gone");
		expect(await h.store.readMarkers()).toEqual([]);

		h.vault.before = undefined;
		const result = await h.pull();
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("killed after the marker of the file of a conflict, and the file was changed since: it is moved away like half a file, and the conflict is told", async () => {
		// The user put the file back to what was synced. With its marker
		// stored, a content that is neither the one before the write nor the
		// one written cannot be told from half a file.
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		killBeforeWrite(h, (path) => path === "a.md");
		await expect(h.pull()).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");
		expect((await markerPaths(h)).sort()).toEqual([copy, "a.md"].sort());
		restart(h);
		h.vault.put("a.md", "A");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.halfWritten).toEqual(["a.md"]);
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A" }]);
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.copies()).toEqual([copy]);
		expect(await h.records()).toEqual(hashes({ "a.md": "theirs" }));
		expect(await h.store.readMarkers()).toEqual([]);
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("killed after the copy and before the marker of the file, and the file was put back since: no conflict is told while the file does not have the remote's content", async () => {
		// No marker of the file, a record that is not the copy's content,
		// and a file that is as its record says: all of that is also true
		// of a conflict that was finished, but this file was never written.
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		await expect(h.pull({ store: killingStore(h, "putMarker", "a.md") })).rejects.toThrow("the app is gone");
		const copy = h.copyName("a.md");
		expect(await markerPaths(h)).toEqual([copy]);
		restart(h);
		h.vault.put("a.md", "A");

		// A pull that settles the markers and does not get to the file.
		const stop = new AbortController();
		const stopped = await h.pull({
			signal: stop.signal,
			onProgress: (event) => event.phase === "scanning" && stop.abort(),
		});
		expect(stopped.outcome).toBe("cancelled");
		expect(stopped.conflicts).toEqual([]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", [copy]: "mine" });
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();

		// An ordinary fetch: the file is as its record says. Only now does
		// it have the content of the remote, beside a copy nobody was told of.
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 1, deleted: 0, renamed: 0, conflicts: 1 });
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(result.halfWritten).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		expect(h.vault.log).toEqual(["write a.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine" });
		expect(h.copies()).toEqual([copy]);
		expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("a conflict that was finished but for telling it, and the remote changed the file again: told once the newer content is written", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "theirs" });
		h.vault.put("a.md", "mine");
		expect((await h.pull()).conflicts).toHaveLength(1);
		const copy = h.copyName("a.md");
		// As if killed before the marker of the copy went.
		await h.store.putMarker(makeMarker(copy, null, blobHash("mine"), true));
		h.backend.commit({ "a.md": "theirs, again" });
		h.vault.log.length = 0;

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.log).toEqual(["write a.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "theirs, again", [copy]: "mine" });
		expect(await h.store.readMarkers()).toEqual([]);
		expect((await h.pull()).conflicts).toEqual([]);
	});

	test("a conflict that waits is forgotten when its copy is gone, or the remote has no file at the path any more", async () => {
		for (const gone of ["copy", "remote"] as const) {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			const copy = "a.conflict-from-iPhone-20261003-110000.md";
			h.vault.put(copy, "mine");
			await h.store.setMeta(AWAITED_CONFLICTS_KEY, [{ path: "a.md", copyPath: copy, hash: blobHash("mine") }]);
			h.vault.put("a.md", "typed since");
			if (gone === "copy") h.vault.remove(copy);
			else h.backend.commit({ "a.md": null });

			const result = await h.pull();
			expect(result.conflicts.filter((conflict) => conflict.copyPath === copy)).toEqual([]);
			expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();
			expect(h.vault.text("a.md")).toBe("typed since");
		}
	});

	describe("a marker of a path the remote has deleted since", () => {
		async function left(device: string | null): Promise<Harness> {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
			if (device === null) h.vault.remove("a.md");
			else h.vault.put("a.md", device);
			h.backend.commit({ "a.md": null });
			return h;
		}

		test("the file is as it was before the write: an ordinary deletion", async () => {
			const h = await left("A");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.counts.deleted).toBe(1);
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "user-setting", content: "A" }]);
			expect(result.halfWritten).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("the file is neither: it goes to the trash of the vault, and its record and marker go", async () => {
			const h = await left("A2 in ha");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.counts.deleted).toBe(0);
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 in ha" }]);
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(h.vault.snapshot()).toEqual({ "b.md": "B" });
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("the file was written in full: it is the remote's own content, and is deleted like any other", async () => {
			const h = await left("A2");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.counts.deleted).toBe(1);
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "user-setting", content: "A2" }]);
			expect(result.halfWritten).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("no file: the marker and the record go", async () => {
			const h = await left(null);
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(h.vault.trashed).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});
	});

	test("no file at the path of a marker, whether there was one before the write or not: fetched like any other", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2", "x.md": "X" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
		await h.store.putMarker(makeMarker("x.md", null, blobHash("X"), false));
		// The user deleted it after the pull stopped.
		h.vault.remove("a.md");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "x.md": "X" });
		expect(h.vault.trashed).toEqual([]);
		expect(result.halfWritten).toEqual([]);
		expect(await h.store.readMarkers()).toEqual([]);
	});

	test("a folder at the path of a marker counts as no file", async () => {
		const h = await synced({ "b.md": "B" });
		await h.store.putMarker(makeMarker("a", null, blobHash("X"), false));
		h.vault.put("a/inside.md", "mine");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.trashed).toEqual([]);
		expect(h.vault.text("a/inside.md")).toBe("mine");
		expect(await h.store.readMarkers()).toEqual([]);
	});

	test("killed at any point while a half file is settled, and run again: moved away once, told, and fetched", async () => {
		let stops = 0;
		for (let after = 0; ; after++) {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			const head = h.backend.commit({ "a.md": "A2 in full" });
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2 in full"), false));
			h.vault.put("a.md", "A2 in");

			h.crash.after(after);
			const told: string[] = [];
			await h.pull().then(
				(result) => told.push(...result.halfWritten),
				() => undefined,
			);
			const stopped = h.crash.dead;
			h.crash.revive();
			if (stopped) {
				const result = await h.pull();
				expect(result.outcome).toBe("completed");
				told.push(...result.halfWritten);
			}

			expect(told).toEqual(["a.md"]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B" });
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 in" }]);
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "a.md": "A2 in full", "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
			expect((await h.pull()).halfWritten).toEqual([]);
			if (!stopped) break;
			stops += 1;
		}
		// The listing, the list of what is told, the record, the file, the marker, and more.
		expect(stops).toBeGreaterThan(5);
	});

	test("settling the markers twice changes nothing the second time", async () => {
		const h = await synced({ "a.md": "A", "w.md": "W", "u.md": "U" });
		h.backend.commit({ "a.md": "A2", "w.md": "W2", "u.md": "U2" });
		const marks = async (): Promise<void> => {
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
			await h.store.putMarker(makeMarker("w.md", blobHash("W"), blobHash("W2"), false));
			await h.store.putMarker(makeMarker("u.md", blobHash("U"), blobHash("U2"), false));
		};
		await marks();
		h.vault.put("a.md", "A2 ha");
		h.vault.put("w.md", "W2");
		// Stopped right after the markers were settled.
		const stop = new AbortController();
		const first = await h.pull({ signal: stop.signal, onProgress: (event) => event.phase === "scanning" && stop.abort() });
		expect(first.outcome).toBe("cancelled");
		expect(first.halfWritten).toEqual(["a.md"]);
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "w.md": "W2", "u.md": "U" }));
		expect(h.vault.snapshot()).toEqual({ "w.md": "W2", "u.md": "U" });

		const second = await h.pull();
		expect(second.outcome).toBe("completed");
		expect(second.halfWritten).toEqual([]);
		expect(h.vault.trashed.length).toBe(1);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "w.md": "W2", "u.md": "U2" });
	});

	test("a pull that is stopped while the markers are settled leaves the rest for the next", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "b.md": "B2" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
		await h.store.putMarker(makeMarker("b.md", blobHash("B"), blobHash("B2"), false));
		h.vault.put("a.md", "A2 h");
		h.vault.put("b.md", "B2 h");
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		const first = await h.pull({ signal: stop.signal });
		expect(first.outcome).toBe("cancelled");
		expect(first.halfWritten).toEqual(["a.md"]);
		expect(await markerPaths(h)).toEqual(["b.md"]);

		h.vault.before = undefined;
		const second = await h.pull();
		expect(second.outcome).toBe("completed");
		expect(second.halfWritten).toEqual(["b.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B2" });
	});

	describe("a marker the vault does not let the pull settle", () => {
		/** Three files in sync, a pull that stopped in the middle of `a.md`, and the remote changed two. */
		async function halfA(): Promise<{ h: Harness; base: string | null; head: string }> {
			const h = await synced({ "a.md": "A", "b.md": "B", "c.md": "C" });
			const base = await h.base();
			const head = h.backend.commit({ "a.md": "A2", "b.md": "B2" });
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("a.md", "A2 h");
			return { h, base, head };
		}

		test("a file that cannot be read: put off and left alone, the rest is pulled, and the next pull settles it", async () => {
			const { h, base, head } = await halfA();
			const touched: string[] = [];
			h.vault.before = (op, path) => {
				if (path !== "a.md") return;
				if (op === "read") throw new Error("the disk does not answer");
				if (VAULT_CHANGES.has(op)) touched.push(op);
			};

			// Every pull, for as long as it lasts.
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await h.pull();
				expect(result.outcome).toBe("incomplete");
				expect(result.deferred).toEqual([{ path: "a.md", reason: "unreadable" }]);
				expect(result.halfWritten).toEqual([]);
				expect(result.conflicts).toEqual([]);
				expect(result.counts.fetched).toBe(attempt === 0 ? 1 : 0);
				expect(h.vault.snapshot()).toEqual({ "a.md": "A2 h", "b.md": "B2", "c.md": "C" });
				expect(touched).toEqual([]);
				expect(h.vault.trashed).toEqual([]);
				expect(h.copies()).toEqual([]);
				expect(await markerPaths(h)).toEqual(["a.md"]);
				expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2", "c.md": "C" }));
				expect(await h.base()).toBe(base);
				expect(pullReport(translatorFor("en"), result, reportOptions).details).toEqual([
					"1 file on this device could not be read and was left as it is. Check it, then sync again:\na.md",
				]);
			}

			h.vault.before = undefined;
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 h" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B2", "c.md": "C" });
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		});

		test("a file that cannot be moved away: put off and left alone, the rest is pulled, and the next pull settles it", async () => {
			const { h, base, head } = await halfA();
			const written: string[] = [];
			h.vault.before = (op, path) => {
				if (op === "trash" && path === "a.md") throw new Error("the trash is full");
				if (op === "write" || op === "rename") written.push(path);
			};

			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await h.pull();
				expect(result.outcome).toBe("incomplete");
				expect(result.deferred).toEqual([{ path: "a.md", reason: "trash-failed" }]);
				// Not told as moved away: it was not.
				expect(result.halfWritten).toEqual([]);
				expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
				expect(h.vault.snapshot()).toEqual({ "a.md": "A2 h", "b.md": "B2", "c.md": "C" });
				expect(written).toEqual(["b.md"]);
				expect(h.vault.trashed).toEqual([]);
				expect(h.copies()).toEqual([]);
				expect(await markerPaths(h)).toEqual(["a.md"]);
				// The record went before the move was tried; the marker
				// stands for the path until the move is made.
				expect(await h.records()).toEqual(hashes({ "b.md": "B2", "c.md": "C" }));
				expect(await h.base()).toBe(base);
				expect(pullReport(translatorFor("en"), result, reportOptions).details).toEqual([
					"1 file could not be pulled and is left for the next sync. A file on this device could not be moved to .trash/ in this vault.",
				]);
			}

			h.vault.before = undefined;
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 h" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B2", "c.md": "C" });
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		});

		test("an editor that cannot save: put off, and nothing is done to the file it has open", async () => {
			const { h, base } = await halfA();
			h.vault.openFailing("a.md");

			const result = await h.pull();
			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "a.md", reason: "save-failed" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 h", "b.md": "B2", "c.md": "C" });
			expect(h.vault.trashed).toEqual([]);
			expect(h.copies()).toEqual([]);
			expect(await markerPaths(h)).toEqual(["a.md"]);
			expect(await h.base()).toBe(base);

			h.vault.close("a.md");
			expect((await h.pull()).halfWritten).toEqual(["a.md"]);
			expect(h.vault.text("a.md")).toBe("A2");
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("a failure of the sync state still fails the pull", async () => {
			const { h } = await halfA();
			const store = new Proxy(h.store, {
				get(target, name) {
					const value: unknown = Reflect.get(target, name, target);
					if (typeof value !== "function") return value;
					return (...args: unknown[]): unknown => {
						if (name === "deleteRecord") throw new Error("the sync state is gone");
						return (value as (...rest: unknown[]) => unknown).apply(target, args);
					};
				},
			});
			await expect(h.pull({ store })).rejects.toThrow("the sync state is gone");
			expect(h.vault.text("a.md")).toBe("A2 h");
			expect(await markerPaths(h)).toEqual(["a.md"]);
		});

		test("the path is held whatever its case, where the remote spells it otherwise by now", async () => {
			const h = await synced({ "Notes/A.md": "A", "b.md": "B" }, { caseSensitive: false });
			await h.store.putMarker(makeMarker("Notes/A.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("Notes/A.md", "A2 h");
			h.backend.commit({ "Notes/A.md": null, "notes/a.md": "A3", "b.md": "B2" });
			h.vault.before = (op, path) => {
				if (op === "read" && path.toLowerCase() === "notes/a.md") throw new Error("the disk does not answer");
			};

			const result = await h.pull();
			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "Notes/A.md", reason: "unreadable" }]);
			// Neither renamed, nor written under the other spelling, nor kept as a copy.
			expect(h.vault.snapshot()).toEqual({ "Notes/A.md": "A2 h", "b.md": "B2" });
			expect(h.vault.log).toEqual(["write b.md"]);
			expect(result.unwritable).toEqual([]);
			expect(await markerPaths(h)).toEqual(["Notes/A.md"]);

			h.vault.before = undefined;
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(next.halfWritten).toEqual(["Notes/A.md"]);
			expect(h.vault.trashed).toEqual([{ path: "Notes/A.md", mode: "vault-trash", content: "A2 h" }]);
			expect(h.vault.text("notes/a.md")).toBe("A3");
			expect(h.copies()).toEqual([]);
		});

		test("half a copy that cannot be moved away: the copy and the file it is a copy of are both left alone", async () => {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			h.backend.commit({ "a.md": "theirs", "b.md": "B2" });
			h.vault.put("a.md", "mine");
			const half = "a.conflict-from-iPhone-20261003-110000.md";
			await h.store.putMarker(makeMarker(half, null, blobHash("mine"), true));
			h.vault.put(half, "mi");
			h.vault.before = (op) => {
				if (op === "trash") throw new Error("the trash is full");
			};

			const result = await h.pull();
			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: half, reason: "trash-failed" }]);
			expect(result.halfCopies).toEqual([]);
			expect(result.conflicts).toEqual([]);
			// No second copy beside the half one, and the file is not written.
			expect(h.vault.snapshot()).toEqual({ "a.md": "mine", [half]: "mi", "b.md": "B2" });
			expect(await markerPaths(h)).toEqual([half]);
			expect((await h.records())["a.md"]).toBe(blobHash("A"));

			h.vault.before = undefined;
			const next = await h.pull();
			const copy = h.copyName("a.md");
			expect(next.outcome).toBe("completed");
			expect(next.halfCopies).toEqual([half]);
			expect(next.halfWritten).toEqual([]);
			expect(next.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine", "b.md": "B2" });
			expect(h.vault.trashed).toEqual([{ path: half, mode: "vault-trash", content: "mi" }]);
		});

		/**
		 * Killed in the middle of the file of a conflict, below `folder`:
		 * half a file, and a whole copy of what the user had there.
		 */
		async function halfOfConflict(folder = "", options: { caseSensitive?: boolean } = {}) {
			const path = `${folder}a.md`;
			const h = await synced({ [path]: "A", [`${folder}b.md`]: "B" }, options);
			const copy = `${folder}a.conflict-from-iPhone-20261003-110000.md`;
			await h.store.putMarker(makeMarker(copy, null, blobHash("mine"), true));
			h.vault.put(copy, "mine");
			await h.store.putMarker(makeMarker(path, blobHash("mine"), blobHash("theirs"), false));
			h.vault.put(path, "the");
			return { h, path, copy };
		}

		test("half the file of a conflict that cannot be moved away: its whole copy waits with it, marker and all, and is told once the file is fetched", async () => {
			const { h, path, copy } = await halfOfConflict();
			h.backend.commit({ "a.md": "theirs", "b.md": "B2" });
			h.vault.before = (op, at) => {
				if (op === "trash" && at === path) throw new Error("the trash is full");
			};

			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await h.pull();
				expect(result.outcome).toBe("incomplete");
				// Put off once: the copy waits for the file, and has no failure of its own.
				expect(result.deferred).toEqual([{ path, reason: "trash-failed" }]);
				expect(result.conflicts).toEqual([]);
				expect(result.halfCopies).toEqual([]);
				expect(h.vault.snapshot()).toEqual({ "a.md": "the", [copy]: "mine", "b.md": "B2" });
				expect((await markerPaths(h)).sort()).toEqual([copy, path].sort());
				expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toBeUndefined();
			}

			h.vault.before = undefined;
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.halfWritten).toEqual([path]);
			expect(result.conflicts).toEqual([{ path, copyPath: copy, cause: "conflict" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine", "b.md": "B2" });
			expect(h.vault.trashed).toEqual([{ path, mode: "vault-trash", content: "the" }]);
			expect(await h.store.readMarkers()).toEqual([]);
			expect((await h.pull()).conflicts).toEqual([]);
		});

		test("a whole copy that waits with its file is no file of the plan: it does not follow the other files of a folder the remote spells otherwise now", async () => {
			const { h, path, copy } = await halfOfConflict("notes/", { caseSensitive: true });
			h.backend.commit({ "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "theirs", "Notes/b.md": "B" });
			h.vault.put("notes/unsent.md", "U");
			h.vault.before = (op, at) => {
				if (op === "trash" && at === path) throw new Error("the trash is full");
			};

			const result = await h.pull();

			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path, reason: "trash-failed" }]);
			// A file the plan knew nothing of would have gone along, as
			// `unsent.md` does, and its marker would name a path with no file.
			expect(h.vault.log).toEqual([
				"rename notes/b.md -> Notes/b.md",
				"rename notes/unsent.md -> Notes/unsent.md",
			]);
			expect(h.vault.snapshot()).toEqual({
				"notes/a.md": "the",
				[copy]: "mine",
				"Notes/b.md": "B",
				"Notes/unsent.md": "U",
			});
			expect((await markerPaths(h)).sort()).toEqual([copy, path].sort());
			expect(result.conflicts).toEqual([]);
			expect(h.vault.trashed).toEqual([]);
		});

		test("a folder the remote spells otherwise now is not renamed as a whole over a file that is held: the file stays at the path of its marker", async () => {
			const h = await synced({ "notes/x.md": "X", "notes/y.md": "Y" }, { caseSensitive: true });
			const head = h.backend.commit({
				"notes/x.md": null,
				"notes/y.md": null,
				"Notes/x.md": "X2",
				"Notes/y.md": "Y",
			});
			await h.store.putMarker(makeMarker("notes/x.md", blobHash("X"), blobHash("X2"), false));
			h.vault.put("notes/x.md", "X2 h");
			h.vault.before = (op, at) => {
				if (op === "trash" && at === "notes/x.md") throw new Error("the trash is full");
			};

			const result = await h.pull();

			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "notes/x.md", reason: "trash-failed" }]);
			expect(h.vault.log).toEqual(["rename notes/y.md -> Notes/y.md"]);
			expect(h.vault.snapshot()).toEqual({ "notes/x.md": "X2 h", "Notes/y.md": "Y" });
			expect(await markerPaths(h)).toEqual(["notes/x.md"]);
			expect(h.copies()).toEqual([]);

			// The marker still finds the file, so it is not taken for the user's.
			h.vault.before = undefined;
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(next.halfWritten).toEqual(["notes/x.md"]);
			expect(next.conflicts).toEqual([]);
			expect(h.vault.trashed).toEqual([{ path: "notes/x.md", mode: "vault-trash", content: "X2 h" }]);
			expect(h.vault.snapshot()).toEqual({ "Notes/x.md": "X2", "Notes/y.md": "Y" });
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "Notes/x.md": "X2", "Notes/y.md": "Y" }));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(await h.base()).toBe(head);
		});

		test("a `.gitignore` that cannot be read holds only itself", async () => {
			const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
			h.backend.commit({ ".gitignore": "*.tmp\n", "a.md": "A2" });
			await h.store.putMarker(makeMarker(".gitignore", blobHash("*.log\n"), blobHash("*.tmp\n"), false));
			h.vault.put(".gitignore", "*.t");
			h.vault.before = (op, path) => {
				if (op === "read" && path === ".gitignore") throw new Error("the disk does not answer");
			};
			const result = await h.pull();
			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: ".gitignore", reason: "unreadable" }]);
			expect(h.vault.snapshot()).toEqual({ ".gitignore": "*.t", "a.md": "A2" });
		});
	});

	describe("what was moved away before a pull that then did nothing else", () => {
		const many = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, `F${i}`]),
		);

		/** Ten files deleted on the remote, which is asked about, and one left half written. */
		async function halfAndAsked(): Promise<Harness> {
			const h = await synced(many);
			const gone = Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null]));
			h.backend.commit({ ...gone, "f11.md": "F11 in full" });
			await h.store.putMarker(makeMarker("f11.md", blobHash("F11"), blobHash("F11 in full"), false));
			h.vault.put("f11.md", "F11 in");
			return h;
		}

		test("declined: the file is in the trash, its record is gone, the texts say so, and a later pull fetches it", async () => {
			const h = await halfAndAsked();
			h.answer = "cancel";

			const result = await h.pull();

			expect(result.outcome).toBe("declined");
			expect(h.asked).toHaveLength(1);
			expect(result.halfWritten).toEqual(["f11.md"]);
			expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
			expect(h.vault.trashed).toEqual([{ path: "f11.md", mode: "vault-trash", content: "F11 in" }]);
			const { "f11.md": _moved, ...rest } = many;
			expect(h.vault.snapshot()).toEqual(rest);
			expect(await h.records()).toEqual(hashes(rest));
			expect(await h.store.readMarkers()).toEqual([]);
			expect(pullReport(translatorFor("ja"), result, reportOptions).summary).toBe(
				"取り込みをやめました。下に示すファイルだけを、この保管庫の .trash/ へ移しました。ほかは何も変更していません。",
			);
			expect(pullReport(translatorFor("en"), result, reportOptions)).toEqual({
				summary:
					"The pull was cancelled. Only the files listed below were moved to .trash/ in this vault. Nothing else was changed.",
				details: [
					"An earlier pull stopped while it was writing 1 file. What was left of it was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited the file since, you can get your edit back from there:\nf11.md",
				],
			});

			h.answer = "proceed";
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			// Told once.
			expect(next.halfWritten).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "f10.md": "F10", "f11.md": "F11 in full" });
		});

		test("stopped before the plan: the file is in the trash and told, and a later pull fetches it", async () => {
			const h = await halfAndAsked();
			const stop = new AbortController();
			const result = await h.pull({
				signal: stop.signal,
				onProgress: (event) => event.phase === "scanning" && stop.abort(),
			});
			expect(result.outcome).toBe("cancelled");
			expect(result.halfWritten).toEqual(["f11.md"]);
			expect(h.vault.text("f11.md")).toBeUndefined();
			expect((await h.pull()).outcome).toBe("completed");
			expect(h.vault.text("f11.md")).toBe("F11 in full");
		});

		test("a path the plan does not fetch: moved away and told all the same", async () => {
			// Over the size limit on the remote by now.
			const h = await synced({ "a.md": "A" });
			h.backend.commit({ "a.md": "x".repeat(40) });
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("a.md", "A2 h");
			const result = await h.pull({ sizeLimit: 20 });
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(result.counts.fetched).toBe(0);
			expect(h.vault.text("a.md")).toBeUndefined();
			expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2 h" }]);
		});

		test("what is to be told is kept when the pull fails, and told by the next", async () => {
			const h = await synced({ "a.md": "A" });
			h.backend.commit({ "a.md": "A2" });
			await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("a.md", "A2 h");
			const half = "b.conflict-from-iPhone-20261003-110000.md";
			await h.store.putMarker(makeMarker(half, null, blobHash("mine"), true));
			h.vault.put(half, "mi");
			h.vault.before = (op) => {
				if (op === "list") throw new Error("the disk is gone");
			};

			await expect(h.pull()).rejects.toThrow("the disk is gone");
			expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toEqual({ files: ["a.md"], copies: [half], conflicts: [] });
			expect(h.vault.trashed.map((file) => file.path)).toEqual(["a.md", half]);

			h.vault.before = undefined;
			const result = await h.pull();
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(result.halfCopies).toEqual([half]);
			expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
			expect((await h.pull()).halfWritten).toEqual([]);
		});
	});

	test("the remote deleted the path, the file was written in full, and the history was rewritten: deleted through the trash of the vault", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
		h.vault.put("a.md", "A2");
		h.backend.rewriteHistory({ "b.md": "B" });

		const result = await h.pull();

		// The record is made from the marker, so the deletion is one of a
		// file that was not changed here: asked about, as every deletion is
		// after a rewrite, and protected like every other.
		expect(h.asked.map((request) => request.losses?.deletions)).toEqual([[{ key: "a.md", path: "a.md" }]]);
		expect(result).toMatchObject({ outcome: "completed", rewritten: true });
		expect(result.counts.deleted).toBe(1);
		expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: "A2" }]);
		expect(result.trashed).toEqual(["a.md"]);
		expect(result.halfWritten).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
		expect(await h.store.readMarkers()).toEqual([]);
	});

	test("killed in the middle of a write whose content came out of the archive: the next pull settles the marker and the mark of the attempt", async () => {
		const h = harness();
		const files: Record<string, string> = {};
		for (let i = 0; i < 1001; i++) files[`n${String(i).padStart(4, "0")}.md`] = `content ${i}`;
		const head = h.backend.commit(files);
		let downloads = 0;
		Object.assign(h.backend, {
			fetchArchive: async (): Promise<ArchiveContents> => {
				downloads += 1;
				return {
					byteLength: 1,
					sizeOf: (path) => (files[path] === undefined ? null : bytes(files[path]).length),
					read: (path) => bytes(files[path] ?? ""),
				};
			},
		});
		killBeforeWrite(
			h,
			(path) => path === "n0000.md",
			() => h.vault.put("n0000.md", "cont"),
		);
		await expect(h.pull()).rejects.toThrow("the app is gone");
		expect(downloads).toBe(1);
		expect(await markerPaths(h)).toEqual(["n0000.md"]);
		expect(await h.store.getMeta(ARCHIVE_ATTEMPT_KEY)).toMatchObject({ retries: 0 });

		restart(h);
		h.progress.length = 0;
		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.halfWritten).toEqual(["n0000.md"]);
		expect(h.vault.trashed).toEqual([{ path: "n0000.md", mode: "vault-trash", content: "cont" }]);
		expect(result.counts.fetched).toBe(1001);
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.copies()).toEqual([]);
		// The archive again, as a second attempt, and this one ended.
		expect(downloads).toBe(2);
		expect(h.progress.some((event) => event.archive === "retrying")).toBe(true);
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.store.getMeta(ARCHIVE_ATTEMPT_KEY)).toBeUndefined();
		expect(await h.store.getMeta(ARCHIVE_DISABLED_KEY)).toBeUndefined();
		expect(await h.base()).toBe(head);
	});

	test("a file over the size limit at the path of a marker is moved away without being read", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("A2"), false));
		h.vault.put("a.md", "x".repeat(40));
		const read: string[] = [];
		h.vault.before = (op, path) => {
			if (op === "read") read.push(path);
		};
		const result = await h.pull({ sizeLimit: 20 });
		expect(result.halfWritten).toEqual(["a.md"]);
		expect(h.vault.trashed.map((file) => file.mode)).toEqual(["vault-trash"]);
		expect(h.vault.text("a.md")).toBe("A2");
		expect(read).toEqual([]);
	});

	describe("where the cases are not told apart, and the remote spells the path otherwise by now", () => {
		async function left(device: string): Promise<Harness> {
			const h = await synced({ "Notes/A.md": "A", "b.md": "B" }, { caseSensitive: false });
			await h.store.putMarker(makeMarker("Notes/A.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("Notes/A.md", device);
			h.backend.commit({ "Notes/A.md": null, "notes/a.md": "A3" });
			return h;
		}

		test("a file that was written in full follows the new spelling, with no conflict", async () => {
			const h = await left("A2");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.conflicts).toEqual([]);
			expect(result.halfWritten).toEqual([]);
			expect(h.vault.trashed).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "notes/a.md": "A3", "b.md": "B" });
			expect(await h.records()).toEqual(hashes({ "notes/a.md": "A3", "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("a half file is moved away and fetched under the new spelling", async () => {
			const h = await left("A2 h");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(result.conflicts).toEqual([]);
			expect(result.halfWritten).toEqual(["Notes/A.md"]);
			expect(h.vault.trashed).toEqual([{ path: "Notes/A.md", mode: "vault-trash", content: "A2 h" }]);
			expect(h.vault.text("notes/a.md")).toBe("A3");
			expect(h.copies()).toEqual([]);
			expect(await h.records()).toEqual(hashes({ "notes/a.md": "A3", "b.md": "B" }));
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("a marker stored under another case than the file has finds the file", async () => {
			const h = await synced({ "Notes/A.md": "A" }, { caseSensitive: false });
			h.backend.commit({ "Notes/A.md": null, "notes/a.md": "A2" });
			// The pull that stopped was writing under the new spelling.
			await h.store.putMarker(makeMarker("notes/a.md", blobHash("A"), blobHash("A2"), false));
			h.vault.put("Notes/A.md", "A2 h");
			const result = await h.pull();
			expect(result.outcome).toBe("completed");
			expect(h.vault.trashed.map((file) => file.content)).toEqual(["A2 h"]);
			expect(h.vault.text("notes/a.md")).toBe("A2");
			expect(h.copies()).toEqual([]);
			expect(await h.store.readMarkers()).toEqual([]);
		});
	});

	describe("the first fetch command", () => {
		/** As on a device: the store that was open is closed, and another one, empty, takes its place. */
		function startingOver(h: Harness): Partial<PullDeps> {
			return {
				discardState: async (seed) => {
					await h.store.close();
					h.store = new MemoryStateStore();
					await h.store.startOver(seed);
					return h.store;
				},
			};
		}

		/** Killed in the middle of writing `a.md`. */
		async function killedMidWrite(): Promise<Harness> {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			h.backend.commit({ "a.md": "A2 in full" });
			killBeforeWrite(
				h,
				(path) => path === "a.md",
				() => h.vault.put("a.md", "A2 in"),
			);
			await expect(h.pull()).rejects.toThrow("the app is gone");
			restart(h);
			return h;
		}

		test("a no leaves the markers, the vault and the sync state alone", async () => {
			const h = await killedMidWrite();
			const old = h.store;
			await old.setMeta(HALF_WRITTEN_KEY, { files: ["x.md"], copies: [], conflicts: [] });
			h.answer = "cancel";

			const result = await h.pull(startingOver(h));

			expect(result.outcome).toBe("declined");
			expect(result.halfWritten).toEqual([]);
			expect(h.vault.trashed).toEqual([]);
			expect(h.vault.log).toEqual([]);
			expect(h.vault.text("a.md")).toBe("A2 in");
			expect(h.store).toBe(old);
			expect(await markerPaths(h)).toEqual(["a.md"]);
			expect(await old.getMeta(HALF_WRITTEN_KEY)).toEqual({ files: ["x.md"], copies: [], conflicts: [] });
			expect(pullReport(translatorFor("en"), result, reportOptions).summary).toBe(
				"The pull was cancelled. Nothing was changed.",
			);
		});

		test("a yes: the half file is no conflict copy; it is in the trash and told, and the name gets the remote's content", async () => {
			for (const edited of [false, true]) {
				const h = await killedMidWrite();
				if (edited) h.vault.put("a.md", "A2 in, and what I typed");
				const left = edited ? "A2 in, and what I typed" : "A2 in";

				const result = await h.pull(startingOver(h));

				// Asked once, from the vault as it was: the file differs.
				expect(h.asked).toHaveLength(1);
				expect(h.asked[0]?.firstFetch?.files.different).toEqual(["a.md"]);
				expect(result.outcome).toBe("completed");
				expect(result.conflicts).toEqual([]);
				expect(h.copies()).toEqual([]);
				expect(h.vault.trashed).toEqual([{ path: "a.md", mode: "vault-trash", content: left }]);
				expect(result.halfWritten).toEqual(["a.md"]);
				expect(result.counts.fetched).toBe(1);
				expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B" });
				expect(await h.records()).toEqual(hashes({ "a.md": "A2 in full", "b.md": "B" }));
				expect(await h.store.readMarkers()).toEqual([]);
				expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
				// Told once, and nothing is left to send as a change of this device.
				const next = await h.pull();
				expect(next.outcome).toBe("completed");
				expect(next.halfWritten).toEqual([]);
				expect(h.asked).toHaveLength(1);
			}
		});

		test("a yes: what an earlier pull moved away and did not tell is told, and does not outlive the state", async () => {
			const h = await synced({ "a.md": "A" });
			await h.store.setMeta(HALF_WRITTEN_KEY, { files: ["x.md"], copies: ["y.md"], conflicts: [] });

			const result = await h.pull(startingOver(h));

			expect(result.outcome).toBe("completed");
			expect(result.halfWritten).toEqual(["x.md"]);
			expect(result.halfCopies).toEqual(["y.md"]);
			expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
			expect((await h.pull()).halfWritten).toEqual([]);
		});

		test("a yes, and killed right after the state was discarded: what was moved away is told by the next pull", async () => {
			const h = await killedMidWrite();
			const stop = new AbortController();
			const result = await h.pull({
				signal: stop.signal,
				discardState: async (seed) => {
					await h.store.close();
					h.store = new MemoryStateStore();
					await h.store.startOver(seed);
					stop.abort();
					return h.store;
				},
			});
			expect(result.outcome).toBe("cancelled");
			expect(result.halfWritten).toEqual(["a.md"]);
			expect(h.vault.text("a.md")).toBeUndefined();

			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B" });
			expect(h.copies()).toEqual([]);
		});

		test("a yes, with a file that cannot be moved away: its marker goes on to the new state, and the file is left alone", async () => {
			const h = await killedMidWrite();
			h.vault.before = (op, path) => {
				if (op === "trash" && path === "a.md") throw new Error("the trash is full");
			};

			const result = await h.pull(startingOver(h));

			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "a.md", reason: "trash-failed" }]);
			expect(result.halfWritten).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in", "b.md": "B" });
			expect(h.copies()).toEqual([]);
			expect(await markerPaths(h)).toEqual(["a.md"]);
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));
			expect(await h.base()).toBeNull();

			h.vault.before = undefined;
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(next.halfWritten).toEqual(["a.md"]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B" });
			expect(h.copies()).toEqual([]);
			expect(h.asked).toHaveLength(1);
		});

		test("a yes, with half the file of a conflict that cannot be moved away: the marker of its whole copy goes on to the new state too", async () => {
			const h = await synced({ "a.md": "A", "b.md": "B" });
			h.backend.commit({ "a.md": "theirs" });
			h.vault.put("a.md", "mine");
			killBeforeWrite(
				h,
				(path) => path === "a.md",
				() => h.vault.put("a.md", "the"),
			);
			await expect(h.pull()).rejects.toThrow("the app is gone");
			const copy = h.copyName("a.md");
			restart(h);
			h.vault.before = (op, path) => {
				if (op === "trash" && path === "a.md") throw new Error("the trash is full");
			};
			const old = h.store;

			const result = await h.pull(startingOver(h));

			expect(h.store).not.toBe(old);
			expect(result.outcome).toBe("incomplete");
			expect(result.deferred).toEqual([{ path: "a.md", reason: "trash-failed" }]);
			// The copy is left as it is: not counted, not moved, not told yet.
			expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
			expect(result.conflicts).toEqual([]);
			expect(h.vault.log).toEqual([]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "the", [copy]: "mine", "b.md": "B" });
			expect((await markerPaths(h)).sort()).toEqual([copy, "a.md"].sort());
			expect(await h.records()).toEqual(hashes({ "b.md": "B" }));

			h.vault.before = undefined;
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(next.halfWritten).toEqual(["a.md"]);
			expect(next.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "theirs", [copy]: "mine", "b.md": "B" });
			expect(h.copies()).toEqual([copy]);
			expect(await h.store.readMarkers()).toEqual([]);
			expect((await h.pull()).conflicts).toEqual([]);
		});

		test("a yes, and killed right after the state was discarded: the new state already has the markers and what is to be told", async () => {
			// `a.md` is moved away; `b.md` is half written too and cannot be,
			// and a conflict of `b.md` waits for it.
			const h = await killedMidWrite();
			await h.store.putMarker(makeMarker("b.md", blobHash("B"), blobHash("B2"), false));
			h.vault.put("b.md", "B h");
			const copy = "b.conflict-from-iPhone-20261003-110000.md";
			h.vault.put(copy, "mine");
			const awaited = [{ path: "b.md", copyPath: copy, hash: blobHash("mine") }];
			await h.store.setMeta(AWAITED_CONFLICTS_KEY, awaited);
			h.vault.before = (op, path) => {
				h.crash.gate(VAULT_CHANGES.has(op));
				if (op === "trash" && path === "b.md") throw new Error("the trash is full");
			};
			const head = (await h.store.getListing())?.revision;

			await expect(
				h.pull({
					discardState: async (seed) => {
						await h.store.close();
						h.store = new MemoryStateStore();
						await h.store.startOver(seed);
						// Nothing runs after the step that discards.
						h.crash.dead = true;
						return h.store;
					},
				}),
			).rejects.toThrow("the app is gone");

			expect(await markerPaths(h)).toEqual(["b.md"]);
			expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toEqual({ files: ["a.md"], copies: [], conflicts: [] });
			expect(await h.store.getMeta(AWAITED_CONFLICTS_KEY)).toEqual(awaited);
			expect((await h.store.getListing())?.revision).toBe(head);
			expect(await h.records()).toEqual({});
			expect(h.vault.snapshot()).toEqual({ "b.md": "B h", [copy]: "mine" });

			// The half file is still known for one: moved away, and not kept
			// as a copy of a conflict or sent.
			restart(h);
			const next = await h.pull();
			expect(next.outcome).toBe("completed");
			expect(next.halfWritten).toEqual(["a.md", "b.md"]);
			expect(next.conflicts).toEqual([{ path: "b.md", copyPath: copy, cause: "conflict" }]);
			expect(h.vault.trashed.map((file) => file.content)).toEqual(["A2 in", "B h"]);
			expect(h.vault.snapshot()).toEqual({ "a.md": "A2 in full", "b.md": "B", [copy]: "mine" });
			expect(h.copies()).toEqual([copy]);
			expect(await h.store.readMarkers()).toEqual([]);
		});

		test("a yes, and stopped while the markers are settled: nothing is discarded", async () => {
			const h = await killedMidWrite();
			const old = h.store;
			const stop = new AbortController();
			h.answer = () => {
				stop.abort();
				return "proceed";
			};
			const result = await h.pull({ signal: stop.signal, ...startingOver(h) });
			expect(result.outcome).toBe("cancelled");
			expect(h.store).toBe(old);
			expect(await markerPaths(h)).toEqual(["a.md"]);
			expect(h.vault.text("a.md")).toBe("A2 in");
		});
	});
});

describe("stopping a pull while the remote is asked", () => {
	test("the listing is not waited for: the pull ends at once, and nothing is changed", async () => {
		const h = await synced({ "a.md": "A" });
		const base = await h.base();
		h.backend.commit({ "a.md": "A2" });
		const stop = new AbortController();
		const real = h.backend.list.bind(h.backend);
		let answered = false;
		h.backend.list = (known) => {
			queueMicrotask(() => stop.abort());
			// The request cannot be taken back, and never answers here.
			return new Promise<ListResult>(() => {}).finally(() => {
				answered = true;
			});
		};
		await expect(h.pull({ signal: stop.signal })).rejects.toMatchObject({ kind: "cancelled" });
		expect(answered).toBe(false);
		expect(h.vault.text("a.md")).toBe("A");
		expect(await h.base()).toBe(base);

		h.backend.list = real;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("A2");
	});

	test("the check of the history is not waited for either", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2" });
		const stop = new AbortController();
		h.backend.checkBase = () => {
			queueMicrotask(() => stop.abort());
			return new Promise<BaseRelation>(() => {});
		};
		await expect(h.pull({ signal: stop.signal })).rejects.toMatchObject({ kind: "cancelled" });
		expect(h.vault.text("a.md")).toBe("A");
	});

	test("the `.gitignore` of the remote is not waited for: the pull ends as stopped", async () => {
		const h = await synced({ ".gitignore": "*.log\n", "a.md": "A" });
		const base = await h.base();
		h.backend.commit({ ".gitignore": "*.tmp\n", "a.md": "A2" });
		const stop = new AbortController();
		const real = h.backend.fetch.bind(h.backend);
		let returned = false;
		h.backend.fetch = () => ({
			[Symbol.asyncIterator]: () => ({
				next: () => {
					queueMicrotask(() => stop.abort());
					// The request cannot be taken back, and never answers here.
					return new Promise<IteratorResult<FetchedFile>>(() => {});
				},
				return: async () => {
					returned = true;
					return { done: true, value: undefined };
				},
			}),
		});

		const result = await h.pull({ signal: stop.signal });

		expect(result.outcome).toBe("cancelled");
		expect(returned).toBe(true);
		expect(h.vault.snapshot()).toEqual({ ".gitignore": "*.log\n", "a.md": "A" });
		expect(await h.base()).toBe(base);

		h.backend.fetch = real;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ ".gitignore": "*.tmp\n", "a.md": "A2" });
	});
});

describe("a question that is left for later", () => {
	const many = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, `F${i}`]),
	);

	test("too many deletions: nothing is changed, and what was confirmed and told before stays remembered", async () => {
		const h = await synced(many);
		const base = await h.base();
		h.backend.commit({ ...Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])), "new.md": "N" });
		const confirmed = { rewritten: false, deletions: ["f00.md"], overwrites: [] };
		await h.store.setMeta(PULL_CONFIRMATION_KEY, confirmed);
		// A notice that no longer applies: a "no" would forget it.
		await h.store.setMeta("notices", [{ kind: "git-at-root", path: ".git" }]);
		h.answer = "later";

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "deletions", notices: [], unwritable: [] });
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(h.asked).toHaveLength(1);
		expect(h.vault.snapshot()).toEqual(many);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual(hashes(many));
		expect(await h.base()).toBe(base);
		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toEqual(confirmed);
		expect(await readNotices(h.store)).toEqual([{ kind: "git-at-root", path: ".git" }]);
	});

	test("it is asked again by every pull, and carried out once it is answered", async () => {
		const h = await synced(many);
		const head = h.backend.commit(Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])));
		h.answer = "later";
		expect((await h.pull()).outcome).toBe("waiting");
		expect((await h.pull()).outcome).toBe("waiting");
		expect(h.asked).toHaveLength(2);

		h.answer = "proceed";
		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.counts.deleted).toBe(10);
		expect(h.asked).toHaveLength(3);
		expect(await h.base()).toBe(head);
	});

	test("a rewritten history: nothing is moved away or written over", async () => {
		const h = await synced({ "a.md": "A1", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "c.md": "C" });
		await h.pull();
		const base = await h.base();
		h.vault.log.length = 0;
		h.backend.rewriteHistory({ "a.md": "A1", "b.md": "B", "d.md": "D" });
		h.answer = "later";

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "rewritten", rewritten: true, trashed: [] });
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B", "c.md": "C" });
		expect(h.vault.log).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A2", "b.md": "B", "c.md": "C" }));
		expect(await h.base()).toBe(base);
		// The pull the user starts asks, and can still keep the files.
		h.answer = "keep-local";
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(2);
		expect(h.asked[1]?.losses?.rewritten).toBe(true);
	});

	test("a confirmation of a rewritten history that a pull was stopped after is not taken back", async () => {
		const h = await synced({ "a.md": "A1", "b.md": "B", "c.md": "C" });
		h.backend.rewriteHistory({ "a.md": "A0" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		const confirmed = await h.store.getMeta(PULL_CONFIRMATION_KEY);
		expect(confirmed).toBeDefined();
		h.vault.before = undefined;
		// One file more is to go, which is a new question.
		h.backend.rewriteHistory({});
		h.answer = "later";

		expect((await h.pull()).outcome).toBe("waiting");

		expect(await h.store.getMeta(PULL_CONFIRMATION_KEY)).toEqual(confirmed);
	});

	test("before a first fetch: nothing is fetched, and the question is not counted as answered", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "theirs", "b.md": "B" });
		h.vault.putAll({ "a.md": "mine", "note.md": "N" });
		h.answer = "later";

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "first-fetch" });
		expect(h.vault.snapshot()).toEqual({ "a.md": "mine", "note.md": "N" });
		expect(h.vault.log).toEqual([]);
		expect(h.views).toEqual([]);
		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);

		h.answer = "proceed";
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toHaveLength(2);
		expect(h.asked[1]?.firstFetch?.files.different).toEqual(["a.md"]);
	});

	test("with both reasons to ask, the one about what is taken away is named", async () => {
		const h = harness();
		h.backend.commit(many);
		// A first fetch that stopped after its question: records of files the
		// remote has deleted since, and no base revision.
		const stop = new AbortController();
		let written = 0;
		h.vault.before = (op) => {
			if (op === "write" && ++written === 12) stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		h.vault.before = undefined;
		await h.store.deleteMeta(FIRST_FETCH_CONFIRMED_KEY);
		h.backend.commit({ ...Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])), "x.md": "theirs" });
		h.vault.put("x.md", "mine");
		h.answer = "later";

		const result = await h.pull();

		expect(h.asked[0]?.losses).not.toBeNull();
		expect(h.asked[0]?.firstFetch).not.toBeNull();
		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "deletions" });
	});

	test("what a pull that stopped left half written is still moved away first, and told", async () => {
		const h = await synced(many);
		h.backend.commit({ ...Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])), "f11.md": "new" });
		await h.store.putMarker(makeMarker("f11.md", blobHash("F11"), blobHash("new"), false));
		h.vault.put("f11.md", "ne");
		h.answer = "later";

		const result = await h.pull();

		expect(result).toMatchObject({ outcome: "waiting", halfWritten: ["f11.md"] });
		expect(h.vault.trashed.map((file) => file.path)).toEqual(["f11.md"]);
		expect(await h.store.getMeta(HALF_WRITTEN_KEY)).toBeUndefined();
	});

	test("it is worded as a wait, with nothing else to tell", async () => {
		const h = await synced(many);
		h.backend.commit(Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])));
		h.answer = "later";

		const report = pullReport(translatorFor("en"), await h.pull(), reportOptions);

		expect(report.summary).toBe(
			"Pulling would delete many files on this device, which needs your confirmation. Nothing was changed. Sync manually to be asked.",
		);
		expect(report.details).toEqual([]);
	});
});

describe("a pull with the light check", () => {
	/** A harness in sync on `files`, its index, and every call to the disk from here on. */
	async function lightly(files: Record<string, FileContent>): Promise<{ h: Harness; index: MemoryIndex; ops: string[] }> {
		const h = await synced(files);
		// The files were written by the pull that fetched them, too close
		// to it for their times to be recorded. This one records them.
		await h.pull();
		const ops: string[] = [];
		h.vault.before = (op, path) => {
			ops.push(`${op} ${path}`);
		};
		return { h, index: new MemoryIndex(h.vault), ops };
	}
	const files = { "a.md": "A", "notes/b.md": "B", "notes/deep/c.md": "C", ".github/ci.yml": "ci" };

	test("with nothing changed, no folder is listed and no file is read", async () => {
		const { h, index, ops } = await lightly(files);
		const lines: string[] = [];

		const result = await h.pull({ index, log: (line) => lines.push(line) });

		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		// The one path the index does not hold, the rules, and the root `.git`.
		expect(ops.sort()).toEqual(["stat .git", "stat .github/ci.yml", "stat .github/ci.yml", "stat .gitignore"]);
		expect(lines).toEqual(["pull: light check: 4 files, 1 not in the index, 1 asked of the disk, 0 hashed, 0 ms"]);
	});

	test("with a .gitignore on the remote, the root is the one folder that is listed, for the rules", async () => {
		const { h, index, ops } = await lightly({ ...files, ".gitignore": "*.tmp\n" });

		expect((await h.pull({ index })).outcome).toBe("completed");

		expect(ops.filter((op) => op.startsWith("list"))).toEqual(["list /"]);
		expect(ops.filter((op) => op.startsWith("read"))).toEqual(["read .gitignore", "read .gitignore"]);
		expect(ops.filter((op) => !op.includes(".git"))).toEqual(["list /"]);
	});

	test("what the remote changed is fetched, deleted and added as after a scan", async () => {
		const { h, index } = await lightly(files);
		const head = h.backend.commit({ "a.md": "A2", "notes/b.md": null, "new/n.md": "N", ".github/ci.yml": "ci2" });

		const result = await h.pull({ index });

		expect(result.outcome).toBe("completed");
		expect(result.counts).toMatchObject({ fetched: 3, deleted: 1, conflicts: 0 });
		expect(h.vault.snapshot()).toEqual({ ".github/ci.yml": "ci2", "a.md": "A2", "new/n.md": "N", "notes/deep/c.md": "C" });
		expect(await h.base()).toBe(head);
	});

	test("a file of the vault at a . path the remote has newly got is compared, and not written over", async () => {
		const { h, index } = await lightly(files);
		h.vault.put(".github/new.yml", "mine");
		h.backend.commit({ ".github/new.yml": "theirs" });

		const result = await h.pull({ index });

		const copy = h.copyName(".github/new.yml");
		expect(result.conflicts).toEqual([{ path: ".github/new.yml", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.text(".github/new.yml")).toBe("theirs");
		expect(h.vault.text(copy)).toBe("mine");
	});

	test("a file that changed on disk behind the index is not written over blind", async () => {
		const { h, index } = await lightly(files);
		const stale = h.vault.stats().find((file) => file.path === "a.md");
		// Another app wrote the file, and the index still says what the record says.
		h.vault.put("a.md", "edited elsewhere");
		index.set("a.md", stale?.mtime ?? 0, stale?.size ?? 0);
		h.backend.commit({ "a.md": "A2" });

		const result = await h.pull({ index });

		const copy = h.copyName("a.md");
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.text("a.md")).toBe("A2");
		expect(h.vault.text(copy)).toBe("edited elsewhere");
		expect(h.vault.trashed).toEqual([]);
	});

	test("a file that was deleted on disk behind the index is fetched again when the remote changed it", async () => {
		const { h, index } = await lightly(files);
		index.follow = false;
		h.vault.remove("a.md");
		h.backend.commit({ "a.md": "A2" });

		expect((await h.pull({ index })).outcome).toBe("completed");

		expect(h.vault.text("a.md")).toBe("A2");
	});

	test("a recorded file the index has lost is found on the disk, and not taken for deleted", async () => {
		const { h, index } = await lightly(files);
		index.drop("notes/b.md");
		h.backend.commit({ "notes/b.md": "B2" });

		const result = await h.pull({ index });

		expect(result).toMatchObject({ outcome: "completed", conflicts: [] });
		expect(h.vault.text("notes/b.md")).toBe("B2");
	});

	test("a notice it cannot find a reason for is not forgotten, so that the next scan does not tell it again", async () => {
		const { h, index } = await lightly(files);
		// A `.gitignore` in a subfolder that neither the remote nor a record knows.
		h.vault.put("notes/.gitignore", "*.tmp\n");
		const nested = { kind: "nested-gitignore", path: "notes/.gitignore" } as const;
		expect((await h.pull()).notices).toEqual([nested]);

		expect((await h.pull({ index })).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([nested]);

		expect((await h.pull()).notices).toEqual([]);
		expect((await h.pull({ index })).notices).toEqual([]);
		expect((await h.pull()).notices).toEqual([]);
	});

	test("a notice that no longer applies stays until a pull that scans", async () => {
		const { h, index } = await lightly(files);
		await h.store.setMeta("notices", [{ kind: "git-at-root", path: ".git" }]);

		expect((await h.pull({ index })).notices).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "git-at-root", path: ".git" }]);

		await h.pull();
		expect(await readNotices(h.store)).toEqual([]);
	});

	test("what it does find is told, once", async () => {
		const { h, index } = await lightly(files);
		h.vault.put(".git/HEAD", "ref");

		expect((await h.pull({ index })).notices).toEqual([{ kind: "git-at-root", path: ".git" }]);
		expect((await h.pull({ index })).notices).toEqual([]);
		expect((await h.pull()).notices).toEqual([]);
	});

	test("a question it comes to can be left for later like any other", async () => {
		const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, `F${i}`]));
		const { h, index } = await lightly(many);
		h.backend.commit(Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])));
		h.answer = "later";

		expect(await h.pull({ index })).toMatchObject({ outcome: "waiting", waitingFor: "deletions" });
		expect(h.vault.snapshot()).toEqual(many);
	});
});

describe("a pull that started by itself", () => {
	const AUTO = { automatic: true } as const;

	test("starts no first fetch into an empty vault, though there is nothing to ask", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "notes/b.md": "B" });

		const result = await h.pull(AUTO);

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "first-fetch" });
		expect(h.asked).toEqual([]);
		expect(h.progress.map((event) => event.phase)).toEqual(["listing"]);
		expect(h.vault.snapshot()).toEqual({});
		expect(h.vault.log).toEqual([]);
		expect(h.views).toEqual([]);
		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);
	});

	test("the wait costs nothing: the vault is neither listed nor read, however large, and nothing is remembered", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "theirs", ".gitignore": "*.tmp\n" });
		const mine = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`notes/n${i}.md`, `note ${i}`]));
		h.vault.putAll({ ...mine, "a.md": "mine", ".gitignore": "*.log\n" });
		const ops: string[] = [];
		h.vault.before = (op, path) => {
			ops.push(`${op} ${path}`);
		};
		await h.store.setMeta("notices", [{ kind: "git-at-root", path: ".git" }]);

		expect(await h.pull(AUTO)).toMatchObject({ outcome: "waiting", waitingFor: "first-fetch", notices: [] });

		expect(ops).toEqual([]);
		expect(await readNotices(h.store)).toEqual([{ kind: "git-at-root", path: ".git" }]);
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);

		// The pull the user starts looks, and asks.
		h.answer = "cancel";
		expect((await h.pull()).outcome).toBe("declined");
		expect(h.asked[0]?.firstFetch?.files.different).toEqual([".gitignore", "a.md"]);
	});

	test("nor into a vault that holds what the remote holds: no record is made", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A" });
		h.vault.put("a.md", "A");

		expect(await h.pull(AUTO)).toMatchObject({ outcome: "waiting", waitingFor: "first-fetch" });

		expect(await h.records()).toEqual({});
		expect(await h.base()).toBeNull();
	});

	test("it waits every time, until a pull the user starts has fetched", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "A" });
		expect((await h.pull(AUTO)).outcome).toBe("waiting");
		expect((await h.pull(AUTO)).outcome).toBe("waiting");

		expect((await h.pull()).outcome).toBe("completed");
		expect(h.asked).toEqual([]);
		expect(await h.base()).toBe(head);

		h.backend.commit({ "a.md": "A2" });
		expect((await h.pull(AUTO)).outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("A2");
	});

	test("goes on with a first fetch the user said yes to and that stopped halfway", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "theirs", "b.md": "B", "c.md": "C" });
		h.vault.put("a.md", "mine");
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(h.asked).toHaveLength(1);
		expect(await h.base()).toBeNull();
		h.vault.before = undefined;

		const result = await h.pull(AUTO);

		expect(result.outcome).toBe("completed");
		expect(h.asked).toHaveLength(1);
		expect(await h.base()).toBe(head);
	});

	test("goes on with one that had nothing to ask and stopped halfway", async () => {
		const h = harness();
		const head = h.backend.commit({ "a.md": "A", "b.md": "B", "c.md": "C" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		expect(Object.keys(await h.records())).toHaveLength(1);
		expect(await isFirstFetchConfirmed(h.store)).toBe(false);
		h.vault.before = undefined;

		expect((await h.pull(AUTO)).outcome).toBe("completed");

		expect(await h.base()).toBe(head);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B", "c.md": "C" });
	});

	test("but not when the vault has got a file since that differs: that is still asked", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B", "c.md": "theirs" });
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};
		expect((await h.pull({ signal: stop.signal })).outcome).toBe("cancelled");
		h.vault.before = undefined;
		const before = h.vault.snapshot();
		const unwritten = ["a.md", "b.md", "c.md"].find((path) => before[path] === undefined) ?? "";
		h.vault.put(unwritten, "mine");

		const result = await h.pull(AUTO);

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "first-fetch" });
		expect(h.vault.text(unwritten)).toBe("mine");
	});

	test("a remote without commits is still that, and nothing waits", async () => {
		const h = harness();
		h.backend.emptied = true;
		h.vault.put("mine.md", "M");
		expect((await h.pull(AUTO)).outcome).toBe("remote-empty");
	});

	test("asks nothing: where a pull would ask, it waits without the question being put", async () => {
		const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, `F${i}`]));
		const h = await synced(many);
		h.backend.commit(Object.fromEntries(Object.keys(many).slice(0, 10).map((path) => [path, null])));
		// Whatever the one who would be asked says.
		h.answer = "proceed";

		const result = await h.pull(AUTO);

		expect(result).toMatchObject({ outcome: "waiting", waitingFor: "deletions" });
		expect(h.asked).toEqual([]);
		expect(h.vault.snapshot()).toEqual(many);
	});

	test("pulls like any other where there is nothing to ask", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "A2", "b.md": "B" });

		const result = await h.pull(AUTO);

		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual({ "a.md": "A2", "b.md": "B" });
	});
});

describe("a file that is being typed in, in a pull that started by itself", () => {
	/** Asked like the app is: per path, right before the file is touched. */
	const typingIn = (...paths: string[]) => ({ automatic: true, beingEdited: (path: string) => paths.includes(path) }) as const;

	test("is put off before anything is done to it: no save, no copy, nothing in the trash", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		const base = await h.base();
		// Typed, and not saved; half a sentence of it.
		h.vault.put("a.md", "A and what I");
		h.vault.open("a.md", "A and what I am typ");
		h.backend.commit({ "a.md": "A2", "b.md": "B2" });

		const result = await h.pull(typingIn("a.md"));

		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([{ path: "a.md", reason: "being-edited" }]);
		expect(result.conflicts).toEqual([]);
		expect(result.trashed).toEqual([]);
		expect(h.copies()).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		// The other file was pulled; this one was not even asked to save.
		expect(h.vault.log).toEqual(["write b.md"]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A and what I", "b.md": "B2" });
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		expect(await h.base()).toBe(base);
	});

	test("however long the typing goes on, no copy is made: one per sync would fill the trash", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typing");
		h.backend.commit({ "a.md": "A2" });

		for (let sync = 0; sync < 10; sync++) {
			expect((await h.pull(typingIn("a.md"))).outcome).toBe("incomplete");
		}

		expect(h.copies()).toEqual([]);
		expect(h.vault.trashed).toEqual([]);
		expect(h.vault.log).toEqual([]);
	});

	test("once the typing has stopped, the next sync makes the conflict, once", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typed");
		h.vault.open("a.md", "typed to the end");
		const head = h.backend.commit({ "a.md": "A2" });
		await h.pull(typingIn("a.md"));

		const result = await h.pull(typingIn());

		const copy = h.copyName("a.md");
		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toEqual([{ path: "a.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.text("a.md")).toBe("A2");
		expect(h.vault.text(copy)).toBe("typed to the end");
		expect(h.copies()).toEqual([copy]);
		expect(await h.base()).toBe(head);
	});

	test("a note that is open and not typed in is updated in place, as before", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.vault.open("a.md");
		h.backend.commit({ "a.md": "A2" });

		// The typing is in another note.
		const result = await h.pull(typingIn("b.md"));

		expect(result).toMatchObject({ outcome: "completed", deferred: [], conflicts: [] });
		expect(h.vault.text("a.md")).toBe("A2");
	});

	test("it is not deleted, though the remote deleted it", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": null });

		const result = await h.pull(typingIn("a.md"));

		expect(result.deferred).toEqual([{ path: "a.md", reason: "being-edited" }]);
		expect(h.vault.text("a.md")).toBe("A");
		expect(h.vault.log).toEqual([]);
		expect((await h.pull(typingIn())).counts.deleted).toBe(1);
	});

	test("it is not renamed, though the remote changed the case of its name", async () => {
		const h = await synced({ "notes/a.md": "A" });
		h.backend.commit({ "notes/a.md": null, "notes/A.md": "A" });

		const result = await h.pull(typingIn("notes/a.md"));

		expect(result.outcome).toBe("incomplete");
		expect(result.deferred.map((file) => file.reason)).toContain("being-edited");
		expect(h.vault.paths()).toEqual(["notes/a.md"]);
		expect(h.vault.log).toEqual([]);
	});

	test("a settings file with a conflict is not replaced, and nothing goes to the trash", async () => {
		const h = await synced({ ".obsidian/snippets/x.css": "a{}" });
		h.vault.put(".obsidian/snippets/x.css", "a{color:red}");
		h.backend.commit({ ".obsidian/snippets/x.css": "b{}" });

		const result = await h.pull(typingIn(".obsidian/snippets/x.css"));

		expect(result).toMatchObject({ outcome: "incomplete", replacedSettings: [], trashed: [] });
		expect(h.vault.text(".obsidian/snippets/x.css")).toBe("a{color:red}");
		expect(h.vault.trashed).toEqual([]);
	});

	test("a file a pull that stopped left half written is not moved away under the typing", async () => {
		const h = await synced({ "a.md": "A" });
		h.backend.commit({ "a.md": "new" });
		await h.store.putMarker(makeMarker("a.md", blobHash("A"), blobHash("new"), false));
		h.vault.put("a.md", "ne and typed since");

		const result = await h.pull(typingIn("a.md"));

		expect(result).toMatchObject({ outcome: "incomplete", halfWritten: [] });
		expect(result.deferred).toEqual([{ path: "a.md", reason: "being-edited" }]);
		expect(h.vault.trashed).toEqual([]);
		expect(await h.store.readMarkers()).toHaveLength(1);
	});

	test.each([
		["a vault that tells the cases apart", true],
		["a vault that does not tell the cases apart", false],
	])("a folder is not renamed under it, as a whole or file by file: all of it waits (%s)", async (_name, caseSensitive) => {
		const before = { "notes/x.md": "X", "notes/y.md": "Y", "notes/z.md": "Z", "c.md": "C" };
		const h = await synced(before, { caseSensitive });
		const head = h.backend.commit({
			"notes/x.md": null,
			"notes/y.md": null,
			"notes/z.md": null,
			"Notes/x.md": "X2",
			"Notes/y.md": "Y",
			"Notes/z.md": "Z2",
			"c.md": "C2",
		});
		h.vault.put("notes/x.md", "X and typing");

		const result = await h.pull(typingIn("notes/x.md"));

		expect(result.outcome).toBe("incomplete");
		expect(result.deferred.filter((file) => file.reason === "being-edited")).toEqual([
			{ path: "notes/x.md", reason: "being-edited" },
		]);
		expect(new Set(result.deferred.map((file) => file.reason))).toEqual(new Set(["being-edited", "depends-on-deferred"]));
		// Nothing of it is told, and nothing was refused.
		expect(result.unwritable).toEqual([]);
		expect(result.notices).toEqual([]);
		expect(pullAutoReport(translatorFor("en"), result, reportOptions)).toEqual({
			happened: [],
			standing: [],
			cause: null,
			end: "neither",
		});
		// Neither the name of the folder above the file nor its content, and
		// the rest of the pull went on.
		expect(h.vault.log).toEqual(["write c.md"]);
		expect(h.vault.snapshot()).toEqual({ "notes/x.md": "X and typing", "notes/y.md": "Y", "notes/z.md": "Z", "c.md": "C2" });
		expect(h.vault.folderPaths()).toEqual(["notes"]);
		// Every record is still of the file that is at its path.
		expect(await h.records()).toEqual(hashes({ "notes/x.md": "X", "notes/y.md": "Y", "notes/z.md": "Z", "c.md": "C2" }));
		expect(h.copies()).toEqual([]);
		expect(h.vault.trashed).toEqual([]);

		// The typing has stopped: the folder is renamed in one call, and the
		// file gets its conflict.
		const next = await h.pull(typingIn());
		const copy = h.copyName("Notes/x.md");
		expect(next.outcome).toBe("completed");
		expect(next.conflicts).toEqual([{ path: "Notes/x.md", copyPath: copy, cause: "conflict" }]);
		expect(h.vault.log).toContain("rename notes -> Notes");
		expect(h.vault.snapshot()).toEqual({
			"Notes/x.md": "X2",
			[copy]: "X and typing",
			"Notes/y.md": "Y",
			"Notes/z.md": "Z2",
			"c.md": "C2",
		});
		expect(await h.records()).toEqual(hashes({ "Notes/x.md": "X2", "Notes/y.md": "Y", "Notes/z.md": "Z2", "c.md": "C2" }));
		expect(await h.base()).toBe(head);
	});

	test("a folder with no file that is being typed in is renamed as a whole, as before", async () => {
		const h = await synced({ "notes/x.md": "X", "other/a.md": "A" }, { caseSensitive: true });
		h.backend.commit({ "notes/x.md": null, "Notes/x.md": "X" });

		const result = await h.pull(typingIn("other/a.md"));

		expect(result.outcome).toBe("completed");
		expect(h.vault.log).toEqual(["rename notes -> Notes"]);
	});

	test("typing that begins after the file was looked at, right before the write: nothing is written, and no marker is left", async () => {
		const h = await synced({ "a.md": "A", "b.md": "B" });
		h.backend.commit({ "a.md": "A2", "b.md": "B2" });
		let applying = false;
		let typing = false;
		h.vault.before = (op, path) => {
			// The look at the file, in the step that writes it.
			if (applying && op === "stat" && path === "a.md") typing = true;
		};

		const result = await h.pull({
			automatic: true,
			beingEdited: (path) => typing && path === "a.md",
			onProgress: (event) => {
				if (event.phase === "applying") applying = true;
			},
		});

		expect(typing).toBe(true);
		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([{ path: "a.md", reason: "being-edited" }]);
		expect(h.vault.snapshot()).toEqual({ "a.md": "A", "b.md": "B2" });
		expect(await h.store.readMarkers()).toEqual([]);
		expect(await h.records()).toEqual(hashes({ "a.md": "A", "b.md": "B2" }));
		typing = false;
		expect((await h.pull({ automatic: true, beingEdited: () => false })).outcome).toBe("completed");
		expect(h.vault.text("a.md")).toBe("A2");
	});

	test("typing that begins while the copy is written: the copy is taken away again, and the file is left", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "mine");
		h.backend.commit({ "a.md": "A2" });
		let typing = false;
		h.vault.before = (op) => {
			if (op === "write") typing = true;
		};

		const result = await h.pull({ automatic: true, beingEdited: () => typing });

		expect(result.deferred).toEqual([{ path: "a.md", reason: "being-edited" }]);
		expect(result.conflicts).toEqual([]);
		expect(h.vault.text("a.md")).toBe("mine");
		expect(h.copies()).toEqual([]);
	});

	test("it is neither told nor a failure, and what was told before stays told", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typing");
		h.backend.commit({ "a.md": "A2" });

		const result = await h.pull(typingIn("a.md"));

		const t = translatorFor("en");
		expect(pullAutoReport(t, result, reportOptions)).toEqual({ happened: [], standing: [], cause: null, end: "neither" });
		expect(pullReport(t, result, reportOptions).details).toEqual([]);
	});

	test("a pull the user starts is not held back: it saves the editor and makes the conflict", async () => {
		const h = await synced({ "a.md": "A" });
		h.vault.put("a.md", "typed");
		h.vault.open("a.md", "typed and saved by the pull");
		h.backend.commit({ "a.md": "A2" });

		const result = await h.pull();

		expect(result.outcome).toBe("completed");
		expect(result.conflicts).toHaveLength(1);
		expect(h.vault.text(h.copyName("a.md"))).toBe("typed and saved by the pull");
	});
});
