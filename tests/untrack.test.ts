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
import { defaultSectionLines } from "../src/core/exclusion";
import { SECTION_START, withSection } from "../src/core/gitignore-section";
import type { PullAnswer, PullConfirmRequest, PullDeps, PullResult } from "../src/core/pull";
import { runPull } from "../src/core/pull";
import { type PushAnswer, type PushConfirmRequest, type PushDeps, type PushRunResult, runPush } from "../src/core/push";
import { markPushFailure, readPushFailure } from "../src/core/push-failure";
import {
	FIRST_PUSH_CONFIRMED_KEY,
	finishPush,
	PENDING_PUSH_KEY,
	readPendingPush,
	rememberPendingPush,
	settlePendingPush,
} from "../src/core/push-pending";
import { makeMarker, readBaseRevision, type StateStore } from "../src/core/state";
import {
	runUntrack,
	runUntrackSync,
	type UntrackDeps,
	type UntrackRunResult,
	type UntrackStep,
	type UntrackSyncResult,
} from "../src/core/untrack";
import { blobHash, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };
const OWN = ".obsidian/plugins/sync-evo/main.js";

/** A `.gitignore` with the default section, these lines more in it, and `rest` after it. */
const gitignore = (lines: readonly string[] = [], rest = ""): string =>
	withSection(rest, [...defaultSectionLines(paths), ...lines]);
/** The one most tests go by: the folder `drafts` is left out. */
const RULES = gitignore(["/drafts/"]);

/** A remote a test can bend: symlinks and submodules, and a count of what it was asked. */
class TestBackend extends MemoryBackend {
	readonly kinds = new Map<string, EntryKind>();
	pushes = 0;
	/** Whether each push was one that untracks, in order. */
	readonly untracks: boolean[] = [];

	override async list(known: string | null): Promise<ListResult> {
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		const entries = listed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { changed: true, listing: { revision: listed.listing.revision, entries } };
	}

	override async push(request: Parameters<MemoryBackend["push"]>[0]): ReturnType<MemoryBackend["push"]> {
		this.pushes += 1;
		this.untracks.push(request.untrack === true);
		const pushed = await super.push(request);
		if (pushed.status !== "pushed" || pushed.listing === undefined) return pushed;
		const entries = pushed.listing.entries.map((entry) => ({ ...entry, kind: this.kinds.get(entry.path) ?? entry.kind }));
		return { ...pushed, listing: { revision: pushed.listing.revision, entries } };
	}
}

/** Stands in for the app being killed: from the `after`th change to the sync state on, every call to it fails. */
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
	readonly asked: PushConfirmRequest[];
	readonly pullAsked: PullConfirmRequest[];
	answer: PushAnswer;
	pullAnswer: PullAnswer;
	pull(overrides?: Partial<PullDeps>): Promise<PullResult>;
	push(overrides?: Partial<PushDeps>): Promise<PushRunResult>;
	untrack(shown: readonly string[], overrides?: Partial<UntrackDeps>): Promise<UntrackRunResult>;
	untrackSync(
		shown: readonly string[],
		overrides?: { pull?: Partial<PullDeps>; untrack?: Partial<UntrackDeps> },
	): Promise<UntrackSyncResult & { readonly steps: UntrackStep[]; readonly told: string[] }>;
	/** Path → hash of every record. */
	records(): Promise<Record<string, string>>;
	base(): Promise<string | null>;
	/** The paths the remote holds, sorted. */
	remote(): Promise<string[]>;
}

/** A device. Another device of the same remote is one with its `backend`. */
function harness(backend = new TestBackend()): Harness {
	let time = Date.UTC(2026, 9, 10, 12, 0, 0);
	const now = (): number => time;
	const store = new MemoryStateStore();
	const crash = new Crash();
	const vault = new MemoryPullVault({ caseSensitive: false, now });
	const asked: PushConfirmRequest[] = [];
	const pullAsked: PullConfirmRequest[] = [];

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
	// As the app runs it: a push adds the section to a `.gitignore` that has none.
	const pushDeps = (): PushDeps => ({
		store: guarded(store, crash),
		backend,
		vault,
		paths,
		deviceName: "iPhone",
		now,
		confirm: async (request) => {
			asked.push(request);
			return h.answer;
		},
		askEmptyVault: async () => "delete",
	});
	const untrackDeps = (): UntrackDeps => ({ store: guarded(store, crash), backend, vault, paths, deviceName: "iPhone" });

	const h: Harness = {
		backend,
		store,
		vault,
		crash,
		asked,
		pullAsked,
		answer: "proceed",
		pullAnswer: "proceed",
		pull(overrides = {}) {
			time += 60_000;
			return runPull({ ...pullDeps(), ...overrides });
		},
		push(overrides = {}) {
			time += 60_000;
			return runPush({ ...pushDeps(), ...overrides });
		},
		untrack(shown, overrides = {}) {
			time += 60_000;
			return runUntrack({ ...untrackDeps(), ...overrides }, shown);
		},
		async untrackSync(shown, overrides = {}) {
			time += 60_000;
			const steps: UntrackStep[] = [];
			const told: string[] = [];
			const result = await runUntrackSync({
				pull: { ...pullDeps(), ...overrides.pull },
				untrack: { ...untrackDeps(), ...overrides.untrack },
				shown,
				onStep: (step) => steps.push(step),
				onPulled: (pulled) => told.push(`pull:${pulled.outcome}`),
			});
			return { ...result, steps, told };
		},
		async records() {
			const out: Record<string, string> = {};
			for (const record of await store.readRecords()) out[record.path] = record.hash;
			return out;
		},
		base: () => readBaseRevision(store),
		async remote() {
			// Through the plain remote, whatever the test has bent.
			const listed = await new MemoryBackend().list.call(backend, null);
			if (!listed.changed) throw new Error("expected a listing");
			return listed.listing.entries.map((entry) => entry.path).sort();
		},
	};
	return h;
}

/**
 * A harness whose vault and remote are in sync on `files`, after one pull.
 * A push has gone through before, unless `firstPush` says it has not.
 *
 * What the rules of the `.gitignore` of `files` leave out was synced before
 * they were added, by a pull of the same files under an empty section: a
 * rule cuts a path off from the remote, and the first fetch would not have
 * fetched it. Its file is in the vault, and its record is kept, as the
 * record of an excluded path is.
 */
async function synced(
	files: Record<string, FileContent>,
	options: { firstPush?: boolean; kinds?: Record<string, EntryKind> } = {},
): Promise<Harness> {
	const h = harness();
	for (const [path, kind] of Object.entries(options.kinds ?? {})) h.backend.kinds.set(path, kind);
	h.backend.commit({ ...files, ".gitignore": withSection(null, []) });
	expect((await h.pull()).outcome).toBe("completed");
	h.backend.commit({ ".gitignore": null, ...files });
	expect((await h.pull()).outcome).toBe("completed");
	if (options.firstPush !== true) await h.store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
	h.vault.log.length = 0;
	h.backend.pushes = 0;
	h.backend.untracks.length = 0;
	return h;
}

const DRAFTS = { ".gitignore": RULES, "notes/a.md": "A", "drafts/b.md": "B", "drafts/c.md": "C" };

/** Nothing of an untracking shows: on the remote, in the records, or in what is remembered. */
async function expectUntouched(h: Harness, files: Record<string, FileContent>): Promise<void> {
	expect(await h.remote()).toEqual(Object.keys(files).sort());
	expect(Object.keys(await h.records()).sort()).toEqual(Object.keys(files).sort());
	expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
}

describe("untracking", () => {
	test("takes the files out of the remote in one commit of its own, keeps them on the device, and drops their records", async () => {
		const h = await synced(DRAFTS, { firstPush: true });
		const before = h.vault.snapshot();
		const head = h.backend.revision;
		await markPushFailure(h.store, 1234);

		const result = await h.untrack(["drafts/c.md", "drafts/b.md"]);

		expect(result).toEqual({
			outcome: "untracked",
			revision: h.backend.revision,
			untracked: ["drafts/b.md", "drafts/c.md"],
			recovered: null,
		});
		expect(h.backend.revision).not.toBe(head);
		// The two of `synced`, and the untracking.
		expect(h.backend.revisionCount).toBe(3);
		expect(h.backend.untracks).toEqual([true]);
		expect(h.backend.lastUntrack).toBe(true);
		expect(h.backend.lastDeviceName).toBe("iPhone");
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		// The vault is not written, and nothing in it is deleted.
		expect(h.vault.snapshot()).toEqual(before);
		expect(h.vault.log).toEqual([]);
		expect(await h.records()).toEqual({ ".gitignore": blobHash(RULES), "notes/a.md": blobHash("A") });
		expect(await h.base()).toBe(h.backend.revision);
		expect((await h.store.getListing())?.revision).toBe(h.backend.revision);
		expect((await h.store.getListing())?.entries.map((entry) => entry.path).sort()).toEqual([".gitignore", "notes/a.md"]);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// It sent nothing of the vault: the question before the first push
		// is still to be asked, and a push that did not finish is as unsent.
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
		expect(await readPushFailure(h.store)).toEqual({ at: 1234 });
	});

	test("the pull and the push right after neither delete the files nor send them again", async () => {
		const h = await synced(DRAFTS);
		await h.untrack(["drafts/b.md", "drafts/c.md"]);
		const before = h.vault.snapshot();
		const head = h.backend.revision;
		h.vault.log.length = 0;

		const pulled = await h.pull();
		expect(pulled).toMatchObject({
			outcome: "completed",
			counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
			conflicts: [],
			trashed: [],
			deferred: [],
		});
		expect(pulled.recoveredUntrack).toBeUndefined();
		expect(h.vault.snapshot()).toEqual(before);
		expect(h.vault.log).toEqual([]);

		// An edit of an untracked file is not sent either.
		h.vault.put("drafts/b.md", "B2");
		const pushed = await h.push();
		expect(pushed).toMatchObject({ outcome: "nothing-to-push", refused: [], leftOut: [], held: [] });
		expect(h.backend.revision).toBe(head);
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(h.vault.text("drafts/b.md")).toBe("B2");
		expect(h.vault.text("drafts/c.md")).toBe("C");
		expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "notes/a.md"]);
	});

	test("only what was shown is deleted, though more can be untracked", async () => {
		const h = await synced(DRAFTS);
		const result = await h.untrack(["drafts/b.md"]);
		expect(result).toMatchObject({ outcome: "untracked", untracked: ["drafts/b.md"] });
		expect(await h.remote()).toEqual([".gitignore", "drafts/c.md", "notes/a.md"]);
		expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "drafts/c.md", "notes/a.md"]);
	});

	test("what was shown and is no longer on the remote, or no longer matched by a rule, is not deleted", async () => {
		const h = await synced({ ...DRAFTS, "old/x.md": "X" });
		// Another device took one out, and the rule for the others is gone.
		h.backend.commit({ "drafts/b.md": null, ".gitignore": gitignore(["/old/"]) });
		expect((await h.pull()).outcome).toBe("completed");
		const result = await h.untrack(["drafts/b.md", "drafts/c.md", "notes/a.md", "old/x.md", "never/there.md"]);
		expect(result).toMatchObject({ outcome: "untracked", untracked: ["old/x.md"] });
		expect(await h.remote()).toEqual([".gitignore", "drafts/c.md", "notes/a.md"]);
	});

	test("a path the remote spells otherwise since is taken from the new listing, by its key", async () => {
		const nfc = "drafts/ガイド.md";
		const nfd = nfc.normalize("NFD");
		expect(nfd).not.toBe(nfc);
		const h = await synced({ ".gitignore": RULES, "notes/a.md": "A", [nfd]: "old" });
		// The content has changed as well since the list was shown.
		h.backend.commit({ [nfd]: "new" });
		expect((await h.pull()).outcome).toBe("completed");

		const result = await h.untrack([nfc]);

		expect(result).toMatchObject({ outcome: "untracked", untracked: [nfd] });
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "notes/a.md"]);
	});

	test("where the remote holds two spellings of one key, only the one that was shown is deleted", async () => {
		const nfc = "drafts/ガイド.md";
		const nfd = nfc.normalize("NFD");
		const h = await synced({ ".gitignore": RULES, "notes/a.md": "A", [nfc]: "one", [nfd]: "two" });
		const result = await h.untrack([nfc]);
		expect(result).toMatchObject({ outcome: "untracked", untracked: [nfc] });
		expect(await h.remote()).toEqual([".gitignore", nfd, "notes/a.md"].sort());
	});

	test("nothing left to untrack: no commit is made", async () => {
		const h = await synced(DRAFTS);
		const head = h.backend.revision;
		for (const shown of [[], ["notes/a.md"], ["gone.md"], [".gitignore"]]) {
			expect(await h.untrack(shown)).toEqual({ outcome: "nothing-to-untrack", revision: null, untracked: [], recovered: null });
		}
		expect(h.backend.pushes).toBe(0);
		expect(h.backend.revision).toBe(head);
		await expectUntouched(h, DRAFTS);
	});

	test("a file in Sync Evo's own folder, which has no record, and a symlink", async () => {
		const files = { ".gitignore": RULES, "notes/a.md": "A", [OWN]: "another device's", "drafts/link": "../target" };
		const h = await synced(files, { kinds: { "drafts/link": "symlink" } });
		h.vault.put(OWN, "this device's");
		expect(Object.keys(await h.records())).not.toContain(OWN);
		h.vault.log.length = 0;

		const result = await h.untrack([OWN, "drafts/link"]);

		expect(result).toMatchObject({ outcome: "untracked", untracked: [OWN, "drafts/link"] });
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(h.vault.text(OWN)).toBe("this device's");
		expect(h.vault.log).toEqual([]);
		expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "notes/a.md"]);
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
		expect(h.vault.text(OWN)).toBe("this device's");
	});

	test("a submodule is never deleted, though a rule matches it and it was shown", async () => {
		const h = await synced({ ".gitignore": gitignore(["/knowledge/"]), "notes/a.md": "A", knowledge: "c".repeat(40) }, {
			kinds: { knowledge: "submodule" },
		});
		expect(await h.untrack(["knowledge"])).toMatchObject({ outcome: "nothing-to-untrack" });
		expect(h.backend.pushes).toBe(0);
	});
});

describe("untracking looks for itself whether it can go by the rules of this device", () => {
	const shown = ["drafts/b.md", "drafts/c.md"];

	test("a remote without commits", async () => {
		const h = harness();
		h.vault.put(".gitignore", RULES);
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "remote-empty", untracked: [], revision: null });
		expect(h.backend.pushes).toBe(0);
	});

	test("a device that has not pulled, or not the head of the remote", async () => {
		const h = harness();
		h.backend.commit(DRAFTS);
		h.vault.putAll(DRAFTS);
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "pull-unfinished" });

		expect((await h.pull()).outcome).toBe("completed");
		h.backend.commit({ "notes/new.md": "N" });
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "pull-unfinished" });
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual([".gitignore", "drafts/b.md", "drafts/c.md", "notes/a.md", "notes/new.md"]);
	});

	test("a .gitignore a pull was writing when it stopped", async () => {
		const h = await synced(DRAFTS);
		await h.store.putMarker(makeMarker(".gitignore", blobHash(RULES), blobHash("x"), false));
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "gitignore-unsettled" });
		expect(h.backend.pushes).toBe(0);
	});

	test("a .gitignore whose conflict a pull was in the middle of when it stopped: the marker of the copy says so", async () => {
		const h = await synced(DRAFTS);
		const copy = "_conflicts/2026-10-11 .gitignore (iPhone)";
		await h.store.putMarker(makeMarker(copy, null, blobHash(RULES), true, ".gitignore"));
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "gitignore-unsettled" });
		expect(h.backend.pushes).toBe(0);
	});

	test("a .gitignore an editor holds and cannot save", async () => {
		const h = await synced(DRAFTS);
		h.vault.openFailing(".gitignore");
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "gitignore-unsettled" });
		expect(h.backend.pushes).toBe(0);
	});

	test("a write of Sync Evo's own to the .gitignore that stopped half way is finished first, and then sent as it is", async () => {
		const h = await synced(DRAFTS);
		const writing = gitignore(["/drafts/", "/more/"]);
		await h.store.setMeta("gitignore-write", { before: RULES, writing });
		h.vault.put(".gitignore", writing.slice(0, 20));
		// Finished, it is a file the remote does not hold yet: it goes with the deletions.
		expect(await h.untrack(shown)).toMatchObject({ outcome: "untracked", untracked: shown });
		expect(h.vault.text(".gitignore")).toBe(writing);
		expect(await h.store.getMeta("gitignore-write")).toBeUndefined();
		expect(new TextDecoder().decode(h.backend.read(".gitignore"))).toBe(writing);
		expect(h.backend.pushes).toBe(1);
	});

	test("a .gitignore that cannot be read", async () => {
		const h = await synced(DRAFTS);
		expect(await h.untrack(shown, { sizeLimit: 10 })).toMatchObject({ outcome: "sync-first", reason: "gitignore-unreadable" });
		expect(h.backend.pushes).toBe(0);
	});

	test("no section, though the file is the remote's: the default lines are applied without being on the remote", async () => {
		const files = { ".gitignore": "/drafts/\n", "notes/a.md": "A", "drafts/b.md": "B", ".obsidian/workspace.json": "{}" };
		const h = await synced(files);
		expect(await h.untrack(["drafts/b.md", ".obsidian/workspace.json"])).toMatchObject({ outcome: "sync-first", reason: "no-section" });
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual(Object.keys(files).sort());
	});

	test("no .gitignore at all", async () => {
		const h = await synced({ "notes/a.md": "A", ".obsidian/workspace.json": "{}" });
		expect(await h.untrack([".obsidian/workspace.json"])).toMatchObject({ outcome: "sync-first", reason: "no-section" });
		expect(h.backend.pushes).toBe(0);
	});

	test("a broken section, though the file is the remote's", async () => {
		const broken = `${SECTION_START}\n/drafts/\n`;
		const h = await synced({ ...DRAFTS, ".gitignore": broken });
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "section-broken" });
		expect(h.backend.pushes).toBe(0);
	});

	test("the remote's .gitignore changed since this device last synced it, and this device has another", async () => {
		const h = await synced(DRAFTS);
		h.vault.put(".gitignore", gitignore(["/drafts/", "/more/"]));
		// As if the pull had not taken in the remote's change: the record is of something else.
		await h.store.commitWrite({ key: ".gitignore", path: ".gitignore", kind: "file", hash: blobHash("older") });
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "gitignore-differs" });
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual(Object.keys(DRAFTS).sort());
	});

	test("the remote's .gitignore is a symlink of the same content", async () => {
		const h = await synced(DRAFTS);
		h.backend.kinds.set(".gitignore", "symlink");
		await h.store.clearListing();
		// The base revision is still the head: only the kind is bent.
		expect(await h.untrack(shown)).toMatchObject({ outcome: "sync-first", reason: "gitignore-differs" });
		expect(h.backend.pushes).toBe(0);
	});

	test("refused, nothing is sent or recorded, whichever the reason", async () => {
		const h = await synced(DRAFTS);
		h.vault.put(".gitignore", `${SECTION_START}\n/drafts/\n`);
		const records = await h.records();
		const head = h.backend.revision;
		await h.untrack(shown);
		expect(h.backend.revision).toBe(head);
		expect(await h.records()).toEqual(records);
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});
});

describe("the rules of this device go in the same commit", () => {
	const shown = ["drafts/b.md", "drafts/c.md"];

	test("a .gitignore edited here and not sent: in the commit of the deletions, and its record moved on to it", async () => {
		const h = await synced({ ...DRAFTS, ".gitignore": gitignore() });
		// The rule that makes the files match was written on this device,
		// with other changes beside it.
		h.vault.put(".gitignore", RULES);
		h.vault.put("notes/a.md", "A2");
		h.vault.put("notes/unsent.md", "U");
		const head = h.backend.revision;
		const before = h.backend.revisionCount;

		const result = await h.untrack(shown);

		expect(result).toMatchObject({ outcome: "untracked", untracked: shown, revision: h.backend.revision });
		expect(h.backend.revisionCount).toBe(before + 1);
		expect(h.backend.untracks).toEqual([true]);
		expect(h.backend.revision).not.toBe(head);
		// The deletions and the rules, and nothing else of the vault.
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(new TextDecoder().decode(h.backend.read(".gitignore"))).toBe(RULES);
		expect(new TextDecoder().decode(h.backend.read("notes/a.md"))).toBe("A");
		expect(await h.records()).toEqual({ ".gitignore": blobHash(RULES), "notes/a.md": blobHash("A") });
		expect(h.vault.text("drafts/b.md")).toBe("B");

		// The pull right after finds nothing, and the push sends the rest alone.
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
		expect(await h.push()).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 1, deleted: 0 } });
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md", "notes/unsent.md"]);
	});

	test("a .gitignore the remote does not hold at all is added in the commit", async () => {
		const h = await synced({ "notes/a.md": "A", "drafts/b.md": "B", "drafts/c.md": "C" });
		h.vault.put(".gitignore", RULES);
		expect(await h.untrack(shown)).toMatchObject({ outcome: "untracked", untracked: shown });
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(await h.records()).toEqual({ ".gitignore": blobHash(RULES), "notes/a.md": blobHash("A") });
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, conflicts: 0 } });
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
	});

	test("remembered with the record of the .gitignore, and recorded so by the sync that finds it went through", async () => {
		const h = await synced({ ...DRAFTS, ".gitignore": gitignore() });
		h.vault.put(".gitignore", RULES);
		h.backend.publishFault = "lost-answer";
		await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		expect(await readPendingPush(h.store)).toMatchObject({
			untrack: true,
			records: [{ path: ".gitignore", hash: blobHash(RULES) }],
			counts: { added: 0, modified: 1, deleted: 2 },
		});
		expect(await h.pull()).toMatchObject({ outcome: "completed", recoveredUntrack: 2, counts: { fetched: 0, deleted: 0 } });
		expect(await h.records()).toEqual({ ".gitignore": blobHash(RULES), "notes/a.md": blobHash("A") });
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});

	test("another device takes the rules and the deletions in together, and keeps its files, edited ones too", async () => {
		const files = { ...DRAFTS, ".gitignore": gitignore() };
		const a = harness();
		a.backend.commit(files);
		const b = harness(a.backend);
		expect((await a.pull()).outcome).toBe("completed");
		expect((await b.pull()).outcome).toBe("completed");
		// The other device has edited one of the files meanwhile.
		b.vault.put("drafts/b.md", "B on the other device");
		a.vault.put(".gitignore", RULES);

		expect((await a.untrackSync(shown)).untrack).toMatchObject({ outcome: "untracked", untracked: shown });

		const pulled = await b.pull();
		expect(pulled).toMatchObject({ outcome: "completed", counts: { deleted: 0, conflicts: 0 } });
		expect(b.vault.text(".gitignore")).toBe(RULES);
		expect(b.vault.text("drafts/b.md")).toBe("B on the other device");
		expect(b.vault.text("drafts/c.md")).toBe("C");
		// Nor are they sent back: they are excluded there as well now.
		await b.store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
		expect(await b.push()).toMatchObject({ outcome: "nothing-to-push" });
		expect(await a.remote()).toEqual([".gitignore", "notes/a.md"]);
	});
});

describe("an untracking that does not get to its end", () => {
	const shown = ["drafts/b.md", "drafts/c.md"];

	test("the remote moved while it ran: nothing is changed, and nothing stays remembered", async () => {
		const h = await synced(DRAFTS);
		h.backend.beforeMove = () => {
			h.backend.beforeMove = undefined;
			h.backend.commit({ "notes/other.md": "from a Mac" });
		};
		const result = await h.untrack(shown);
		expect(result).toEqual({ outcome: "remote-moved", revision: null, untracked: [], recovered: null });
		expect(await h.remote()).toEqual([...Object.keys(DRAFTS), "notes/other.md"].sort());
		expect(Object.keys(await h.records()).sort()).toEqual(Object.keys(DRAFTS).sort());
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		// The sync after it goes on as if nothing had been asked.
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 1, deleted: 0 } });
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});

	test("a failure before the branch was asked to move: the commit is forgotten at once", async () => {
		const h = await synced(DRAFTS);
		let remembered: unknown;
		h.backend.beforeMove = () => {
			remembered = h.store.getMeta(PENDING_PUSH_KEY);
			throw new BackendError("unreachable", "timed out");
		};
		await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "unreachable" });
		// It was remembered before the branch was to move, with the mark.
		expect(await remembered).toMatchObject({ untrack: true, deleted: ["drafts/b.md", "drafts/c.md"], records: [] });
		h.backend.beforeMove = undefined;
		await expectUntouched(h, DRAFTS);
		const pulled = await h.pull();
		expect(pulled.recoveredUntrack).toBeUndefined();
		expect(pulled.recoveredPush).toBeUndefined();
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});

	test("the request that moves the branch was lost: it stays remembered, and the next sync finds that it did not happen", async () => {
		const h = await synced(DRAFTS);
		h.backend.publishFault = "lost-request";
		await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		expect(await readPendingPush(h.store)).toMatchObject({ untrack: true, deleted: ["drafts/b.md", "drafts/c.md"] });
		expect(await h.remote()).toEqual(Object.keys(DRAFTS).sort());

		const pulled = await h.pull();
		expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
		expect(pulled.recoveredUntrack).toBeUndefined();
		await expectUntouched(h, DRAFTS);
		// The files are excluded as before: an edit is not sent.
		h.vault.put("drafts/b.md", "B2");
		expect(await h.push()).toMatchObject({ outcome: "nothing-to-push" });
	});

	test.each(["pull", "push", "untrack"] as const)(
		"the answer was lost after the branch moved: the next %s records it, and tells it as an untracking",
		async (next) => {
			const h = await synced(DRAFTS, { firstPush: true });
			await markPushFailure(h.store, 1234);
			h.backend.publishFault = "lost-answer";
			await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "unreachable" });
			h.backend.publishFault = null;
			// The remote has it; this device does not know.
			expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
			expect(Object.keys(await h.records()).sort()).toEqual(Object.keys(DRAFTS).sort());
			const before = h.vault.snapshot();

			if (next === "pull") {
				const pulled = await h.pull();
				expect(pulled).toMatchObject({ outcome: "completed", recoveredUntrack: 2, counts: { fetched: 0, deleted: 0 } });
				expect(pulled.recoveredPush).toBeUndefined();
				// The note of a push that did not finish is not taken away by it.
				expect(await readPushFailure(h.store)).toEqual({ at: 1234 });
			} else if (next === "push") {
				const pushed = await h.push();
				expect(pushed).toMatchObject({ outcome: "nothing-to-push", recovered: null, recoveredUntrack: 2 });
			} else {
				const again = await h.untrack(shown);
				expect(again).toEqual({ outcome: "nothing-to-untrack", revision: null, untracked: [], recovered: null, recoveredUntrack: 2 });
			}

			// Recorded: the files are on the device, and are not deleted by a pull.
			expect(h.vault.snapshot()).toEqual(before);
			expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "notes/a.md"]);
			expect(await h.base()).toBe(h.backend.revision);
			expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
			expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
			const pulled = await h.pull();
			expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
			expect(pulled.recoveredUntrack).toBeUndefined();
			expect(h.vault.snapshot()).toEqual(before);
		},
	);

	test("an ordinary push whose answer was lost: the untracking records it, and takes the note of that push away", async () => {
		const h = await synced(DRAFTS);
		h.vault.put("notes/a.md", "A2");
		h.backend.publishFault = "lost-answer";
		await expect(h.push()).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		expect(await readPushFailure(h.store)).not.toBeNull();
		expect(await readPendingPush(h.store)).not.toBeNull();

		const result = await h.untrack(shown);

		expect(result).toMatchObject({
			outcome: "untracked",
			untracked: shown,
			recovered: { added: 0, modified: 1, deleted: 0 },
		});
		expect(result.recoveredUntrack).toBeUndefined();
		// That push went through after all: there is nothing unsent to tell of.
		expect(await readPushFailure(h.store)).toBeNull();
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(await h.records()).toEqual({ ".gitignore": blobHash(RULES), "notes/a.md": blobHash("A2") });
	});

	test("another device pushed on top of it before this device found out: it is still recorded", async () => {
		const h = await synced(DRAFTS);
		h.backend.publishFault = "lost-answer";
		await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "unreachable" });
		h.backend.publishFault = null;
		h.backend.commit({ "notes/other.md": "from a Mac" });

		const pulled = await h.pull();

		expect(pulled).toMatchObject({ outcome: "completed", recoveredUntrack: 2, counts: { fetched: 1, deleted: 0 } });
		expect(h.vault.text("drafts/b.md")).toBe("B");
		expect(h.vault.text("drafts/c.md")).toBe("C");
		expect(Object.keys(await h.records()).sort()).toEqual([".gitignore", "notes/a.md", "notes/other.md"]);
	});

	test("the app is gone at any point: the files are never deleted on the device, and the records follow the remote", async () => {
		// How each run ended, and whether the remote had moved by then.
		const seen = new Set<string>();
		for (let after = 0; after < 12; after++) {
			const h = await synced(DRAFTS);
			h.crash.after(after);
			let ended = "resolved";
			try {
				await h.untrack(shown);
			} catch {
				ended = "rejected";
			}
			h.crash.revive();
			const reached = !(await h.remote()).includes("drafts/b.md");
			seen.add(`${ended}, ${reached ? "moved" : "not moved"}`);

			const pulled = await h.pull();

			expect(pulled.outcome, `after ${after}`).toBe("completed");
			expect(pulled.counts, `after ${after}`).toMatchObject({ fetched: 0, deleted: 0, conflicts: 0 });
			expect(h.vault.text("drafts/b.md"), `after ${after}`).toBe("B");
			expect(h.vault.text("drafts/c.md"), `after ${after}`).toBe("C");
			const expected = reached ? [".gitignore", "notes/a.md"] : Object.keys(DRAFTS).sort();
			expect(Object.keys(await h.records()).sort(), `after ${after}`).toEqual(expected);
			expect(await h.base(), `after ${after}`).toBe(h.backend.revision);
			expect(await h.store.getMeta(PENDING_PUSH_KEY), `after ${after}`).toBeUndefined();
			// One that ran to its end changed the remote; the first changes
			// to the sync state come before anything is sent.
			if (ended === "resolved") expect(reached, `after ${after}`).toBe(true);
			if (after === 0) expect(reached).toBe(false);
		}
		// Among them the one this is about: gone after the branch moved,
		// with the records still to be taken away.
		expect([...seen].sort()).toEqual(["rejected, moved", "rejected, not moved", "resolved, moved"]);
	});

	test("the remote does not hold what was listed: nothing is sent, and the listing is discarded", async () => {
		const h = await synced(DRAFTS);
		// The head is the same, and holds other content than the stored listing says.
		h.backend.amend({ "drafts/b.md": "not what was listed" });
		await expect(h.untrack(shown)).rejects.toMatchObject({ kind: "not-as-listed" });
		expect(await h.store.getListing()).toBeNull();
		expect(await h.store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(await h.remote()).toEqual(Object.keys(DRAFTS).sort());
		expect(Object.keys(await h.records()).sort()).toEqual(Object.keys(DRAFTS).sort());
	});

	test("stopped before anything is sent, or while the remote is sent to: nothing shows, and nothing stays remembered", async () => {
		const h = await synced(DRAFTS);
		const stopped = new AbortController();
		stopped.abort();
		expect(await h.untrack(shown, { signal: stopped.signal })).toMatchObject({ outcome: "cancelled", untracked: [] });
		expect(h.backend.pushes).toBe(0);

		const during = new AbortController();
		h.backend.beforeMove = () => {
			during.abort();
			throw new BackendError("cancelled", "push: cancelled");
		};
		expect(await h.untrack(shown, { signal: during.signal })).toMatchObject({ outcome: "cancelled", untracked: [] });
		h.backend.beforeMove = undefined;
		await expectUntouched(h, DRAFTS);
	});

	test("the listing of the new commit could not be had: the next sync lists again, and finds nothing to do", async () => {
		const h = await synced(DRAFTS);
		h.backend.listingFault = true;
		const logged: string[] = [];
		expect(await h.untrack(shown, { log: (line) => logged.push(line) })).toMatchObject({ outcome: "untracked" });
		expect(await h.store.getListing()).toBeNull();
		expect(logged).toHaveLength(1);
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});
});

describe("what is remembered of a push that untracks", () => {
	const pending = { revision: "r2", parent: "r1", records: [], deleted: ["a.md"], counts: { added: 0, modified: 0, deleted: 1 } };

	test("the mark is stored and read back; without it, what is stored reads as an ordinary push", async () => {
		const store = new MemoryStateStore();
		await rememberPendingPush(store, { ...pending, untrack: true });
		expect(await readPendingPush(store)).toEqual({ ...pending, untrack: true });
		await rememberPendingPush(store, pending);
		expect(await store.getMeta(PENDING_PUSH_KEY)).toEqual(pending);
		expect(await readPendingPush(store)).toEqual(pending);
		// Anything but `true` is no mark.
		await store.setMeta(PENDING_PUSH_KEY, { ...pending, untrack: "yes" });
		expect(await readPendingPush(store)).toEqual(pending);
	});

	test("recorded, it does not count as the first push having gone through; an ordinary one does", async () => {
		const store = new MemoryStateStore();
		await finishPush(store, { ...pending, untrack: true });
		expect(await store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
		await finishPush(store, pending);
		expect(await store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBe(true);
	});

	test("settled, it is answered as what it was", async () => {
		const never = async (): Promise<never> => {
			throw new Error("not asked");
		};
		const store = new MemoryStateStore();
		await rememberPendingPush(store, { ...pending, untrack: true });
		expect(await settlePendingPush(store, "r2", never)).toEqual({ counts: pending.counts, untrack: true });
		await rememberPendingPush(store, pending);
		expect(await settlePendingPush(store, "r2", never)).toEqual({ counts: pending.counts, untrack: false });
		expect(await settlePendingPush(store, "r2", never)).toBeNull();
	});
});

describe("untracking after the download it needs", () => {
	const shown = ["drafts/b.md", "drafts/c.md"];

	test("rules that are on the remote already: the pull, and no push; what the vault has changed is not sent", async () => {
		const h = await synced({ ...DRAFTS, ".gitignore": gitignore() }, { firstPush: true });
		// The rule came from another device.
		h.backend.commit({ ".gitignore": RULES });
		h.vault.put("notes/unsent.md", "U");

		const result = await h.untrackSync(shown);

		expect(result.steps).toEqual(["pull", "untrack"]);
		expect(result.told).toEqual(["pull:completed"]);
		expect(result.pull).toMatchObject({ outcome: "completed", counts: { fetched: 1 } });
		expect(result.untrack).toMatchObject({ outcome: "untracked", untracked: shown });
		expect(result.skipped).toBeUndefined();
		expect(h.backend.untracks).toEqual([true]);
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(h.asked).toEqual([]);
		expect(h.vault.text("drafts/b.md")).toBe("B");
		expect(h.vault.text("notes/unsent.md")).toBe("U");
		// The question before the first push is still to come.
		expect(await h.store.getMeta(FIRST_PUSH_CONFIRMED_KEY)).toBeUndefined();
		const pushed = await h.push();
		expect(h.asked).toHaveLength(1);
		expect(h.asked[0]?.firstPush).toEqual({ added: ["notes/unsent.md"], modified: [], deleted: [] });
		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 1, modified: 0, deleted: 0 } });
	});

	test("rules written on this device: the pull, then one commit of the .gitignore and the deletions, and no push", async () => {
		const h = await synced({ ...DRAFTS, ".gitignore": gitignore() });
		h.vault.put(".gitignore", RULES);
		h.vault.put("notes/unsent.md", "U");
		const before = h.backend.revisionCount;

		const result = await h.untrackSync(shown);

		expect(result.steps).toEqual(["pull", "untrack"]);
		expect(result.told).toEqual(["pull:completed"]);
		expect(result.untrack).toMatchObject({ outcome: "untracked", untracked: shown, revision: h.backend.revision });
		expect(h.backend.untracks).toEqual([true]);
		expect(h.backend.revisionCount).toBe(before + 1);
		expect(await h.remote()).toEqual([".gitignore", "notes/a.md"]);
		expect(new TextDecoder().decode(h.backend.read(".gitignore"))).toBe(RULES);
		expect(h.asked).toEqual([]);
		expect(h.vault.text("drafts/b.md")).toBe("B");
		expect(h.vault.text("notes/unsent.md")).toBe("U");
		expect(await h.pull()).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0 } });
	});

	test("a .gitignore without a section: nothing is untracked, and nothing sent to add it", async () => {
		const files = { "notes/a.md": "A", ".obsidian/workspace.json": "{}", ".trash/old.md": "O" };
		const h = await synced(files);
		const result = await h.untrackSync([".obsidian/workspace.json", ".trash/old.md"]);
		expect(result.steps).toEqual(["pull", "untrack"]);
		expect(result.untrack).toMatchObject({ outcome: "sync-first", reason: "no-section" });
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual(Object.keys(files).sort());
	});

	test("the pull is declined: no push, and nothing is untracked", async () => {
		const many = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`notes/${index}.md`, String(index)]));
		const h = await synced({ ...DRAFTS, ...many });
		h.backend.commit(Object.fromEntries(Object.keys(many).map((path) => [path, null])));
		const head = h.backend.revision;
		h.pullAnswer = "cancel";

		const result = await h.untrackSync(shown);

		expect(h.pullAsked).toHaveLength(1);
		expect(result.steps).toEqual(["pull"]);
		expect(result.told).toEqual(["pull:declined"]);
		expect(result).toMatchObject({ pull: { outcome: "declined" }, untrack: null, skipped: "pull-declined" });
		expect(h.backend.pushes).toBe(0);
		expect(h.backend.revision).toBe(head);
		expect(h.vault.text("drafts/b.md")).toBe("B");
	});

	test("the pull is stopped: nothing is untracked", async () => {
		const h = await synced(DRAFTS);
		const stopped = new AbortController();
		stopped.abort();
		const result = await h.untrackSync(shown, {
			pull: { signal: stopped.signal },
			untrack: { signal: stopped.signal },
		});
		expect(result).toMatchObject({ pull: { outcome: "cancelled" }, untrack: null, skipped: "pull-cancelled" });
		expect(h.backend.pushes).toBe(0);
		expect(await h.remote()).toEqual(Object.keys(DRAFTS).sort());
	});

	test("stopped after the pull: no untracking is begun", async () => {
		const again = await synced(DRAFTS);
		const controller = new AbortController();
		const pulled = runUntrackSync({
			pull: {
				store: again.store,
				backend: again.backend,
				vault: again.vault,
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now: () => Date.UTC(2026, 9, 10, 13, 0, 0),
				confirm: async () => "proceed",
			},
			untrack: { store: again.store, backend: again.backend, vault: again.vault, paths, deviceName: "iPhone", signal: controller.signal },
			shown,
			onPulled: () => controller.abort(),
		});
		expect(await pulled).toMatchObject({ pull: { outcome: "completed" }, untrack: null, skipped: "cancelled" });
		expect(again.backend.pushes).toBe(0);
	});

	test("a broken section: nothing is sent, and the untracking says why", async () => {
		const broken = `${SECTION_START}\n/drafts/\n`;
		const h = await synced({ ...DRAFTS, ".gitignore": broken }, { firstPush: true });
		// What a push would have sent, and asked about.
		h.vault.put("notes/unsent.md", "U");
		const head = h.backend.revision;
		const result = await h.untrackSync(shown);
		expect(result.steps).toEqual(["pull", "untrack"]);
		expect(result.told).toEqual(["pull:completed"]);
		expect(result.untrack).toMatchObject({ outcome: "sync-first", reason: "section-broken" });
		expect(result.skipped).toBeUndefined();
		expect(h.asked).toEqual([]);
		expect(h.backend.pushes).toBe(0);
		expect(h.backend.revision).toBe(head);
		expect(await readPushFailure(h.store)).toBeNull();
	});

	test("a pull that left files for later: nothing is untracked", async () => {
		const h = await synced({ ...DRAFTS, ".gitignore": gitignore() });
		h.backend.commit({ ".gitignore": RULES, "notes/a.md": "A2" });
		// An editor that cannot save keeps the pull from that file.
		h.vault.openFailing("notes/a.md");
		h.vault.put("notes/unsent.md", "U");
		const head = h.backend.revision;
		const result = await h.untrackSync(shown);
		expect(result.pull.outcome).toBe("incomplete");
		expect(result.steps).toEqual(["pull", "untrack"]);
		expect(result.untrack).toMatchObject({ outcome: "sync-first", reason: "pull-unfinished" });
		expect(h.backend.pushes).toBe(0);
		expect(h.backend.revision).toBe(head);
		expect(await h.remote()).toContain("drafts/b.md");
	});

	test("a .gitignore that cannot be read, and one an editor cannot save: nothing is sent", async () => {
		const unreadable = await synced(DRAFTS);
		unreadable.vault.put("notes/unsent.md", "U");
		const first = await unreadable.untrackSync(shown, { untrack: { sizeLimit: 10 } });
		expect(first.steps).toEqual(["pull", "untrack"]);
		expect(first).toMatchObject({ untrack: { outcome: "sync-first", reason: "gitignore-unreadable" } });
		expect(unreadable.backend.pushes).toBe(0);

		const unsaved = await synced(DRAFTS);
		unsaved.vault.put("notes/unsent.md", "U");
		unsaved.vault.openFailing(".gitignore");
		const second = await unsaved.untrackSync(shown);
		expect(second.steps).toEqual(["pull", "untrack"]);
		expect(second).toMatchObject({ untrack: { outcome: "sync-first", reason: "gitignore-unsettled" } });
		expect(unsaved.backend.pushes).toBe(0);
	});

	test("stopped by the signal of the pull alone, after the pull: no untracking is begun", async () => {
		const h = await synced(DRAFTS);
		const controller = new AbortController();
		const steps: UntrackStep[] = [];
		const at = (): number => Date.UTC(2026, 9, 10, 13, 0, 0);
		const result = await runUntrackSync({
			pull: {
				store: h.store,
				backend: h.backend,
				vault: h.vault,
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now: at,
				confirm: async () => "proceed",
				signal: controller.signal,
			},
			untrack: { store: h.store, backend: h.backend, vault: h.vault, paths, deviceName: "iPhone" },
			shown,
			onStep: (step) => steps.push(step),
			onPulled: () => controller.abort(),
		});
		expect(result).toMatchObject({ pull: { outcome: "completed" }, untrack: null, skipped: "cancelled" });
		expect(steps).toEqual(["pull"]);
		expect(h.backend.pushes).toBe(0);
	});

	test("a pull that rejects is followed by nothing, and no push is noted as not made", async () => {
		const h = await synced(DRAFTS);
		const steps: UntrackStep[] = [];
		const failing = {
			hashContent: (content: Uint8Array) => h.backend.hashContent(content),
			list: async (): Promise<never> => {
				throw new BackendError("unreachable", "timed out");
			},
			checkBase: h.backend.checkBase.bind(h.backend),
			fetch: h.backend.fetch.bind(h.backend),
			push: h.backend.push.bind(h.backend),
		};
		const run = runUntrackSync({
			pull: {
				store: h.store,
				backend: failing,
				vault: h.vault,
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now: () => Date.UTC(2026, 9, 10, 13, 0, 0),
				confirm: async () => "proceed",
			},
			untrack: { store: h.store, backend: h.backend, vault: h.vault, paths, deviceName: "iPhone" },
			shown,
			onStep: (step) => steps.push(step),
		});
		await expect(run).rejects.toMatchObject({ kind: "unreachable" });
		expect(steps).toEqual(["pull"]);
		expect(h.backend.pushes).toBe(0);
		expect(await readPushFailure(h.store)).toBeNull();
	});
});
