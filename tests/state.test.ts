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
import { createExclusion } from "../src/core/exclusion";
import { planSync } from "../src/core/plan";
import {
	copiedPathOf,
	isListing,
	isStatUpdateOf,
	isUnchangedByStat,
	makeMarker,
	makeRecord,
	plainMarker,
	RACY_MTIME_MARGIN_MS,
	RecordBatcher,
	refreshStat,
	type StoredRecord,
	type WriteMarker,
} from "../src/core/state";
import { MemoryStateStore } from "./support/memory-state-store";
import { fileRecord } from "./support/state-store-contract";

const HASH = "a".repeat(40);
const OTHER = "b".repeat(40);
const SYNC_START = 50_000;
/** The latest modification time that is still stored. */
const SAFE = SYNC_START - RACY_MTIME_MARGIN_MS - 1;

describe("making a record", () => {
	test("the margin for coarse clocks is two seconds", () => {
		expect(RACY_MTIME_MARGIN_MS).toBe(2000);
	});

	test.each([0, 1000, SAFE])("a file last changed at %i, well before the sync began, keeps its time and size", (mtime) => {
		expect(makeRecord({ path: "a.md", kind: "file", hash: HASH }, { mtime, size: 7 }, SYNC_START)).toEqual({
			key: "a.md",
			path: "a.md",
			kind: "file",
			hash: HASH,
			mtime,
			size: 7,
		});
	});

	test.each([
		["at the start of the sync", SYNC_START],
		["after it", SYNC_START + 1],
		["long after it", SYNC_START + 60_000],
		// A file system that keeps whole or even seconds gives a file written
		// during the sync a time from before it.
		["one millisecond before it", SYNC_START - 1],
		["one second before it", SYNC_START - 1000],
		["exactly the margin before it", SYNC_START - RACY_MTIME_MARGIN_MS],
	])("a file changed %s gets neither", (_name, mtime) => {
		const record = makeRecord({ path: "a.md", kind: "file", hash: HASH }, { mtime, size: 7 }, SYNC_START);
		expect(record).toEqual({ key: "a.md", path: "a.md", kind: "file", hash: HASH });
	});

	test("the key is the NFC form and the path stays as the remote spelled it", () => {
		const record = makeRecord({ path: "cafe\u0301.md", kind: "file", hash: HASH }, undefined, SYNC_START);
		expect(record.key).toBe("caf\u00e9.md");
		expect(record.path).toBe("cafe\u0301.md");
	});

	test.each(["symlink", "submodule"] as const)("a %s never gets a time or a size", (kind) => {
		const record = makeRecord({ path: "x", kind, hash: HASH }, { mtime: 1, size: 1 }, SYNC_START);
		expect(record).toEqual({ key: "x", path: "x", kind, hash: HASH });
	});

	test("nothing but the fields of an entry is taken over", () => {
		const entry = { path: "a.md", kind: "file" as const, hash: HASH, size: 99, mode: "100755" };
		expect(makeRecord(entry, undefined, SYNC_START)).toEqual({ key: "a.md", path: "a.md", kind: "file", hash: HASH });
	});

	test("stored records are what the sync decision takes as records", () => {
		const record = fileRecord("a.md", HASH);
		const plan = planSync({
			remote: [{ path: "a.md", kind: "file", hash: OTHER }],
			local: [],
			records: [record],
			exclusion: createExclusion({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo", gitignore: null }),
		});
		expect(plan.actions.map((action) => action.type)).toEqual(["download"]);
	});
});

describe("unchanged without reading", () => {
	const record = fileRecord("a.md", HASH, 1000, 10);

	test("the same time and the same size: unchanged", () => {
		expect(isUnchangedByStat(record, { mtime: 1000, size: 10 })).toBe(true);
	});

	test.each([
		["a later time", { mtime: 1001, size: 10 }],
		["an earlier time", { mtime: 999, size: 10 }],
		["another size", { mtime: 1000, size: 11 }],
	])("%s: hashed again", (_name, stat) => {
		expect(isUnchangedByStat(record, stat)).toBe(false);
	});

	test("a record without a time and a size is always hashed again", () => {
		const racy = makeRecord({ path: "a.md", kind: "file", hash: HASH }, { mtime: SYNC_START, size: 10 }, SYNC_START);
		expect(isUnchangedByStat(racy, { mtime: SYNC_START, size: 10 })).toBe(false);
	});

	test("a record that is not of a file is never taken as an unchanged file", () => {
		const link = { ...fileRecord("a.md"), kind: "symlink" } satisfies StoredRecord;
		expect(isUnchangedByStat(link, { mtime: 1000, size: 10 })).toBe(false);
	});
});

describe("after hashing again and finding the same hash", () => {
	test("the time and the size are replaced and the rest stays", () => {
		const record = fileRecord("cafe\u0301.md", HASH, 1000, 10);
		expect(refreshStat(record, { mtime: 3000, size: 10 }, SYNC_START)).toEqual({
			...record,
			mtime: 3000,
			size: 10,
		});
	});

	test("a record written during the sync gets them on the next one", () => {
		const written = SYNC_START + 200;
		const first = makeRecord({ path: "a.md", kind: "file", hash: HASH }, { mtime: written, size: 10 }, SYNC_START);
		expect(first).not.toHaveProperty("mtime");

		const next = refreshStat(first, { mtime: written, size: 10 }, SYNC_START + 60_000);
		expect(next).toEqual({ ...first, mtime: written, size: 10 });
		expect(next !== null && isUnchangedByStat(next, { mtime: written, size: 10 })).toBe(true);
	});

	test("a file touched since this sync began loses them", () => {
		const record = fileRecord("a.md", HASH, 1000, 10);
		expect(refreshStat(record, { mtime: SYNC_START - 500, size: 10 }, SYNC_START)).toEqual({
			key: "a.md",
			path: "a.md",
			kind: "file",
			hash: HASH,
		});
	});

	test("nothing to store when the record already says the same", () => {
		expect(refreshStat(fileRecord("a.md", HASH, 1000, 10), { mtime: 1000, size: 10 }, SYNC_START)).toBeNull();
		const racy = makeRecord({ path: "a.md", kind: "file", hash: HASH }, undefined, SYNC_START);
		expect(refreshStat(racy, { mtime: SYNC_START, size: 10 }, SYNC_START)).toBeNull();
	});
});

describe("an update of the time and the size alone", () => {
	const stored = fileRecord("a.md", HASH, 1000, 10);

	test("is one when the path, the kind, and the hash are the same", () => {
		expect(isStatUpdateOf(stored, fileRecord("a.md", HASH, 3000, 12))).toBe(true);
		expect(isStatUpdateOf(stored, makeRecord(stored, undefined, SYNC_START))).toBe(true);
	});

	test("is none when the hash differs: the file was written since", () => {
		expect(isStatUpdateOf(stored, fileRecord("a.md", OTHER, 3000, 10))).toBe(false);
	});

	test("is none when only the spelling differs: the remote's new spelling was taken over since", () => {
		const nfc = fileRecord("caf\u00e9.md");
		const nfd = fileRecord("cafe\u0301.md");
		expect(nfc.key).toBe(nfd.key);
		expect(isStatUpdateOf(nfc, nfd)).toBe(false);
	});

	test("is none for anything but a regular file, on either side", () => {
		const link: StoredRecord = { key: "a.md", path: "a.md", kind: "symlink", hash: HASH };
		expect(isStatUpdateOf(link, stored)).toBe(false);
		expect(isStatUpdateOf(stored, link)).toBe(false);
		expect(isStatUpdateOf(link, link)).toBe(false);
	});
});

describe("telling a stored listing from anything else", () => {
	const entry = { path: "a.md", kind: "file", hash: HASH, size: 3 };

	test.each([
		["with entries of every kind", { revision: "r", entries: [entry, { path: "l", kind: "symlink", hash: HASH }, { path: "s", kind: "submodule", hash: OTHER }] }],
		["of a remote with nothing in it", { revision: null, entries: [] }],
	])("a listing %s is one", (_name, value) => {
		expect(isListing(value)).toBe(true);
	});

	test.each([
		["nothing", undefined],
		["null", null],
		["a string", "listing"],
		["no entries", { revision: "r" }],
		["entries that are no list", { revision: "r", entries: {} }],
		["no revision", { entries: [] }],
		["a revision that is a number", { revision: 1, entries: [] }],
	])("%s is none", (_name, value) => {
		expect(isListing(value)).toBe(false);
	});

	test.each([
		["is null", null],
		["is a string", "a.md"],
		["has no path", { kind: "file", hash: HASH }],
		["has a path that is no string", { ...entry, path: 1 }],
		["has no kind", { path: "a.md", hash: HASH }],
		["has an unknown kind", { ...entry, kind: "tree" }],
		["has no hash", { path: "a.md", kind: "file" }],
		["has a hash that is no string", { ...entry, hash: null }],
		["has a size that is no number", { ...entry, size: "3" }],
		["has a size that is null", { ...entry, size: null }],
	])("one entry that %s makes the whole listing none", (_name, bad) => {
		expect(isListing({ revision: "r", entries: [entry, bad, entry] })).toBe(false);
	});
});

describe("a write marker", () => {
	test("holds the path, its key, both hashes, and whether it is for a conflict copy", () => {
		expect(makeMarker("cafe\u0301.md", null, HASH, false)).toEqual({
			key: "caf\u00e9.md",
			path: "cafe\u0301.md",
			before: null,
			writing: HASH,
			conflictCopy: false,
		});
		expect(makeMarker("a.conflict-from-Mac-20261007-101500.md", OTHER, HASH, true)).toMatchObject({
			before: OTHER,
			conflictCopy: true,
		});
	});

	test("the marker of a copy holds the path of the file the copy is of, and no other marker does", () => {
		const copy = "_conflicts/2026-10-11 a (iPhone).md";
		expect(makeMarker(copy, null, HASH, true, "notes/a.md")).toEqual({
			key: copy,
			path: copy,
			before: null,
			writing: HASH,
			conflictCopy: true,
			original: "notes/a.md",
		});
		expect(makeMarker("a.md", null, HASH, false, "notes/a.md")).not.toHaveProperty("original");
		expect(makeMarker(copy, null, HASH, true)).not.toHaveProperty("original");
	});

	test("stored field by field: the path of the file is kept on a copy, and nothing else an object carries", () => {
		const copy = "_conflicts/2026-10-11 a (iPhone).md";
		const marker = makeMarker(copy, null, HASH, true, "notes/a.md");
		expect(plainMarker({ ...marker, extra: 1 } as WriteMarker)).toEqual(marker);
		expect(plainMarker({ ...makeMarker("a.md", null, HASH, false), original: "b.md" })).toEqual(
			makeMarker("a.md", null, HASH, false),
		);
		expect(plainMarker({ ...marker, original: 5 } as unknown as WriteMarker)).not.toHaveProperty("original");
	});

	test("what a copy is of: what its marker says, or else what a name of the earlier form tells, or nothing", () => {
		const copy = "_conflicts/2026-10-11 a (iPhone).md";
		expect(copiedPathOf(makeMarker(copy, null, HASH, true, "notes/a.md"))).toBe("notes/a.md");
		// Written by an earlier version, beside the file.
		expect(copiedPathOf(makeMarker("notes/a.conflict-from-Mac-20261007-101500.md", null, HASH, true))).toBe("notes/a.md");
		// What the marker says comes first.
		expect(copiedPathOf(makeMarker("notes/a.conflict-from-Mac-20261007-101500.md", null, HASH, true, "b.md"))).toBe("b.md");
		// Lost on the way through an earlier version: nothing tells it any more.
		expect(copiedPathOf(makeMarker(copy, null, HASH, true))).toBeNull();
		// Not a copy at all.
		expect(copiedPathOf(makeMarker("notes/a.conflict-from-Mac-20261007-101500.md", null, HASH, false))).toBeNull();
		expect(copiedPathOf(makeMarker("a.md", null, HASH, false))).toBeNull();
	});
});

describe("batching the updates that follow no write", () => {
	function setup(options: { maxCount?: number; maxAgeMs?: number } = {}) {
		const store = new MemoryStateStore();
		const calls: number[] = [];
		const clock = { now: 0 };
		const batcher = new RecordBatcher(
			{
				updateStats: async (records) => {
					calls.push(records.length);
					await store.updateStats(records);
				},
			},
			{ now: () => clock.now, ...options },
		);
		return { store, calls, clock, batcher };
	}

	test("nothing is stored until there are enough", async () => {
		const { store, calls, batcher } = setup({ maxCount: 3 });
		for (const path of ["a.md", "b.md", "c.md"]) await store.commitWrite(fileRecord(path, HASH, 1000, 10));
		await batcher.add(fileRecord("a.md", HASH, 3000, 10));
		await batcher.add(fileRecord("b.md", HASH, 3000, 10));
		expect(calls).toEqual([]);
		expect(batcher.size).toBe(2);
		expect((await store.readRecords()).map((record) => record.mtime)).toEqual([1000, 1000, 1000]);

		await batcher.add(fileRecord("c.md", HASH, 3000, 10));
		expect(calls).toEqual([3]);
		expect(batcher.size).toBe(0);
		expect((await store.readRecords()).map((record) => record.mtime)).toEqual([3000, 3000, 3000]);
	});

	test("500 at a time and within a second, unless told otherwise", async () => {
		const { calls, batcher } = setup();
		for (let i = 0; i < 1200; i++) await batcher.add(fileRecord(`${i}.md`));
		expect(calls).toEqual([500, 500]);
		await batcher.flush();
		expect(calls).toEqual([500, 500, 200]);
	});

	test("stored once the first one held has waited long enough", async () => {
		const { calls, clock, batcher } = setup({ maxAgeMs: 1000 });
		await batcher.add(fileRecord("a.md"));
		clock.now = 999;
		await batcher.add(fileRecord("b.md"));
		expect(calls).toEqual([]);

		clock.now = 1000;
		await batcher.add(fileRecord("c.md"));
		expect(calls).toEqual([3]);

		// The wait starts again with the next record.
		clock.now = 1900;
		await batcher.add(fileRecord("d.md"));
		clock.now = 2800;
		await batcher.add(fileRecord("e.md"));
		expect(calls).toEqual([3]);
		clock.now = 2900;
		await batcher.add(fileRecord("f.md"));
		expect(calls).toEqual([3, 3]);
	});

	test("flush stores what is held, and does nothing when nothing is", async () => {
		const { store, calls, batcher } = setup();
		await batcher.flush();
		expect(calls).toEqual([]);

		await store.commitWrite(fileRecord("a.md", HASH, 1000, 10));
		await batcher.add(fileRecord("a.md", HASH, 3000, 10));
		await batcher.flush();
		await batcher.flush();
		expect(calls).toEqual([1]);
		expect(await store.readRecords()).toEqual([fileRecord("a.md", HASH, 3000, 10)]);
	});

	test("a path added twice is stored once, as it was added last", async () => {
		const { store, calls, batcher } = setup();
		await store.commitWrite(fileRecord("caf\u00e9.md", HASH, 500, 10));
		await batcher.add(fileRecord("cafe\u0301.md", HASH, 1000, 10));
		await batcher.add(fileRecord("caf\u00e9.md", HASH, 1500, 10));
		await batcher.flush();
		expect(calls).toEqual([1]);
		expect(await store.readRecords()).toEqual([fileRecord("caf\u00e9.md", HASH, 1500, 10)]);
	});

	test("an update that waited while its file was written does not put the old hash back", async () => {
		const { store, batcher } = setup();
		await store.commitWrite(fileRecord("a.md", HASH, 1000, 10));

		await batcher.add(fileRecord("a.md", HASH, 3000, 10));
		// The pull writes the file before the batch is stored.
		await store.commitWrite(makeRecord({ path: "a.md", kind: "file", hash: OTHER }, undefined, SYNC_START));
		await batcher.flush();

		expect(await store.readRecords()).toEqual([{ key: "a.md", path: "a.md", kind: "file", hash: OTHER }]);
	});

	test("a failure to store is passed on, and the batch is not kept", async () => {
		let fail = true;
		const stored: number[] = [];
		const batcher = new RecordBatcher(
			{
				updateStats: async (records) => {
					if (fail) throw new Error("no space");
					stored.push(records.length);
				},
			},
			{ now: () => 0 },
		);
		await batcher.add(fileRecord("a.md"));
		await expect(batcher.flush()).rejects.toThrow("no space");
		expect(batcher.size).toBe(0);

		fail = false;
		await batcher.add(fileRecord("b.md"));
		await batcher.flush();
		expect(stored).toEqual([1]);
	});
});
