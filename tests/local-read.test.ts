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
import type { RemoteListing } from "../src/core/backend";
import { type LocalRead, readLocal } from "../src/core/local-read";
import type { ScanResult } from "../src/core/scan";
import { type FileStat, makeRecord, type StoredRecord } from "../src/core/state";
import { blobHash, MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const START = Date.UTC(2026, 9, 3, 12, 0, 0);
/** Long enough before the sync that the time of a file is trusted. */
const BEFORE = START - 3_600_000;
const LATER = START - 1_800_000;
const NO_LISTING: RemoteListing = { revision: "r1", entries: [] };

interface Setup {
	readonly vault: MemoryPullVault;
	readonly store: MemoryStateStore;
	/** Every call that reached the disk, in order. */
	readonly ops: string[];
	/** Reads the files at `paths`, with what the index says of them when given. */
	read(paths: readonly string[], indexed?: Record<string, FileStat>, saveEditors?: boolean): Promise<LocalRead>;
	record(path: string): Promise<StoredRecord | undefined>;
}

/** A vault with these files, each recorded as it is on disk, written long ago. */
async function setup(files: Record<string, string>): Promise<Setup> {
	const vault = new MemoryPullVault({ caseSensitive: false, now: () => LATER });
	vault.putAll(files, BEFORE);
	const store = new MemoryStateStore();
	for (const [path, content] of Object.entries(files)) {
		await store.commitWrite(
			makeRecord({ path, kind: "file", hash: blobHash(content) }, { mtime: BEFORE, size: content.length }, START),
		);
	}
	const ops: string[] = [];
	vault.before = (op, path) => {
		ops.push(`${op} ${path}`);
	};
	return {
		vault,
		store,
		ops,
		async read(paths, indexed, saveEditors) {
			const scan: ScanResult = {
				paths: paths.map((path) => ({ path, key: path, state: "present" })),
				rootHasGit: false,
				links: [],
			};
			const local = await readLocal(
				{
					vault,
					backend: new MemoryBackend(),
					store,
					now: () => START,
					startedAt: START,
					sizeLimit: 1000,
					held: new Set(),
					aborted: () => false,
					onProgress: () => {},
					...(saveEditors === true ? { saveEditors } : {}),
					...(indexed === undefined ? {} : { indexed: new Map(Object.entries(indexed)) }),
				},
				scan,
				await store.readRecords(),
				NO_LISTING,
			);
			if (local === null) throw new Error("stopped");
			return local;
		},
		async record(path) {
			return (await store.readRecords()).find((record) => record.path === path);
		},
	};
}

const asRecorded = (content: string): FileStat => ({ mtime: BEFORE, size: content.length });

describe("without an index", () => {
	test("every file is asked of the disk, and one whose time and size are its record's is not read", async () => {
		const s = await setup({ "a.md": "A", "b.md": "B" });

		const local = await s.read(["a.md", "b.md"]);

		expect(s.ops).toEqual(["stat a.md", "stat b.md"]);
		expect(local.entries).toEqual([
			{ path: "a.md", hash: blobHash("A"), size: 1 },
			{ path: "b.md", hash: blobHash("B"), size: 1 },
		]);
		expect(local).toMatchObject({ statted: 2, hashed: 0 });
	});
});

describe("with the index of a light check", () => {
	test("a file whose time and size in the index are its record's is neither asked of the disk nor read", async () => {
		const s = await setup({ "a.md": "A", "b.md": "BB" });

		const local = await s.read(["a.md", "b.md"], { "a.md": asRecorded("A"), "b.md": asRecorded("BB") });

		expect(s.ops).toEqual([]);
		expect(local.entries).toEqual([
			{ path: "a.md", hash: blobHash("A"), size: 1 },
			{ path: "b.md", hash: blobHash("BB"), size: 2 },
		]);
		expect(local).toMatchObject({ statted: 0, hashed: 0 });
	});

	test("what is handed on of such a file is the time and the size of its record", async () => {
		const s = await setup({ "a.md": "A" });

		const local = await s.read(["a.md"], { "a.md": asRecorded("A") });

		expect([...local.seen]).toEqual([["a.md", { hash: blobHash("A"), stat: { mtime: BEFORE, size: 1 } }]]);
	});

	test("a file the index has another time of, which the disk has as recorded, is asked of the disk and not read", async () => {
		const s = await setup({ "a.md": "A" });
		const before = await s.record("a.md");

		const local = await s.read(["a.md"], { "a.md": { mtime: BEFORE + 999, size: 1 } });

		expect(s.ops).toEqual(["stat a.md"]);
		expect(local.entries).toEqual([{ path: "a.md", hash: blobHash("A"), size: 1 }]);
		expect(local).toMatchObject({ statted: 1, hashed: 0 });
		// The record is as it was: nothing of the index was written to it.
		expect(await s.record("a.md")).toEqual(before);
	});

	test("an index that differs from the disk for every file costs a look at each, on every check, and no reading", async () => {
		const files = { "a.md": "A", "b.md": "B", "c.md": "C" };
		const s = await setup(files);
		// Whole seconds, say, where the disk keeps milliseconds.
		const coarse = Object.fromEntries(Object.keys(files).map((path) => [path, { mtime: BEFORE - 1, size: 1 }]));
		const before = await s.store.readRecords();

		for (let check = 0; check < 3; check++) {
			const local = await s.read(Object.keys(files), coarse);
			expect(local).toMatchObject({ statted: 3, hashed: 0 });
			// A check that scans in between changes nothing either.
			expect(await s.read(Object.keys(files))).toMatchObject({ statted: 3, hashed: 0 });
		}

		expect(await s.store.readRecords()).toEqual(before);
		expect(s.ops.filter((op) => op.startsWith("read"))).toEqual([]);
	});

	test("a file that changed is read, and listed with what the disk has", async () => {
		const s = await setup({ "a.md": "A" });
		s.vault.before = undefined;
		s.vault.put("a.md", "edited", LATER);

		const local = await s.read(["a.md"], { "a.md": { mtime: LATER, size: 6 } });

		expect(local.entries).toEqual([{ path: "a.md", hash: blobHash("edited"), size: 6 }]);
		expect([...local.seen]).toEqual([["a.md", { hash: blobHash("edited"), stat: { mtime: LATER, size: 6 } }]]);
		expect(local).toMatchObject({ statted: 1, hashed: 1 });
	});

	test("a file that was touched and holds the same content gets the time of the disk in its record, not the index's", async () => {
		const s = await setup({ "a.md": "A" });
		s.vault.before = undefined;
		s.vault.put("a.md", "A", LATER);

		// The index has heard of a change, with a time of its own.
		await s.read(["a.md"], { "a.md": { mtime: LATER + 777, size: 1 } });

		expect(await s.record("a.md")).toMatchObject({ hash: blobHash("A"), mtime: LATER, size: 1 });
	});

	test("an index that is behind the disk writes nothing: the file is taken as unchanged, with the record's time", async () => {
		const s = await setup({ "a.md": "A" });
		s.vault.before = undefined;
		// Another app changed the file, and the index has not heard of it.
		s.vault.put("a.md", "X", LATER);
		const before = await s.record("a.md");

		const local = await s.read(["a.md"], { "a.md": asRecorded("A") });

		expect(local.entries).toEqual([{ path: "a.md", hash: blobHash("A"), size: 1 }]);
		// Not the disk's time: whoever writes over the file compares the
		// disk with this, and finds the change.
		expect(local.seen.get("a.md")?.stat).toEqual({ mtime: BEFORE, size: 1 });
		expect(await s.record("a.md")).toEqual(before);
	});

	test("a file without a record is asked of the disk and read", async () => {
		const s = await setup({});
		s.vault.put("new.md", "N", BEFORE);

		const local = await s.read(["new.md"], { "new.md": { mtime: BEFORE, size: 1 } });

		expect(local.entries).toEqual([{ path: "new.md", hash: blobHash("N"), size: 1 }]);
		expect(local).toMatchObject({ statted: 1, hashed: 1 });
		expect(await s.store.readRecords()).toEqual([]);
	});

	test("a record that holds no time is not settled by the index", async () => {
		const s = await setup({});
		s.vault.put("a.md", "A", BEFORE);
		await s.store.commitWrite(makeRecord({ path: "a.md", kind: "file", hash: blobHash("A") }, undefined, START));

		const local = await s.read(["a.md"], { "a.md": asRecorded("A") });

		expect(local).toMatchObject({ statted: 1, hashed: 1 });
		// The time and the size it gets are the disk's.
		expect(await s.record("a.md")).toMatchObject({ mtime: BEFORE, size: 1 });
	});

	test("a file the index does not list goes to the disk", async () => {
		const s = await setup({ ".x/c.yml": "C", "a.md": "A" });

		const local = await s.read([".x/c.yml", "a.md"], { "a.md": asRecorded("A") });

		expect(s.ops).toEqual(["stat .x/c.yml"]);
		expect(local).toMatchObject({ statted: 1, hashed: 0 });
	});

	test("a file over the size limit is not settled by the index", async () => {
		const big = "x".repeat(1001);
		const s = await setup({ "big.md": big });

		const local = await s.read(["big.md"], { "big.md": asRecorded(big) });

		expect(local.entries).toEqual([{ path: "big.md", hash: "", size: 1001 }]);
		expect(local.statted).toBe(1);
	});

	test("for a push the editor saves first, and a file it wrote just now is asked of the disk", async () => {
		const s = await setup({ "a.md": "A", "b.md": "B" });
		s.vault.open("a.md", "typed");
		s.vault.open("b.md");

		// The index has not heard of the save yet.
		const local = await s.read(["a.md", "b.md"], { "a.md": asRecorded("A"), "b.md": asRecorded("B") }, true);

		expect(s.ops.slice(0, 2)).toEqual(["save a.md", "stat a.md"]);
		expect(local.entries).toEqual([
			{ path: "a.md", hash: blobHash("typed"), size: 5 },
			{ path: "b.md", hash: blobHash("B"), size: 1 },
		]);
	});

	test("for a push a file no editor has open is settled by the index, after the editors were asked", async () => {
		const s = await setup({ "a.md": "A" });

		const local = await s.read(["a.md"], { "a.md": asRecorded("A") }, true);

		expect(s.ops).toEqual(["save a.md"]);
		expect(local).toMatchObject({ statted: 0, hashed: 0, unsaved: [] });
	});

	test("a file an editor cannot save is left out, whatever the index says", async () => {
		const s = await setup({ "a.md": "A" });
		s.vault.openFailing("a.md");

		const local = await s.read(["a.md"], { "a.md": asRecorded("A") }, true);

		expect(local.unsaved).toEqual(["a.md"]);
		expect(local.entries).toEqual([{ path: "a.md", hash: "" }]);
	});
});

describe("a file that is being typed in, for a push that started by itself", () => {
	test("is neither asked to save nor looked at, and is listed without a hash", async () => {
		const s = await setup({ "a.md": "A", "b.md": "B" });
		s.vault.open("a.md", "typed");
		const scan: ScanResult = {
			paths: ["a.md", "b.md"].map((path) => ({ path, key: path, state: "present" })),
			rootHasGit: false,
			links: [],
		};

		const local = await readLocal(
			{
				vault: s.vault,
				backend: new MemoryBackend(),
				store: s.store,
				now: () => START,
				startedAt: START,
				sizeLimit: 1000,
				held: new Set(),
				aborted: () => false,
				onProgress: () => {},
				saveEditors: true,
				beingEdited: (path) => path === "a.md",
			},
			scan,
			await s.store.readRecords(),
			NO_LISTING,
		);

		expect(local?.beingEdited).toEqual(["a.md"]);
		expect(local?.unsaved).toEqual([]);
		expect(local?.entries).toEqual([
			{ path: "a.md", hash: "" },
			{ path: "b.md", hash: blobHash("B"), size: 1 },
		]);
		expect(s.ops).toEqual(["save b.md", "stat b.md"]);
		expect(s.vault.text("a.md")).toBe("A");
	});
});
