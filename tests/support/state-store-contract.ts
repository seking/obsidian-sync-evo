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
import type { RemoteListing } from "../../src/core/backend";
import {
	BASE_REVISION_KEY,
	makeMarker,
	makeRecord,
	readBaseRevision,
	type StateStore,
	type StoredRecord,
	writeBaseRevision,
} from "../../src/core/state";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

/** When the sync that wrote the records of these tests began: long after every time they use. */
const SYNC_START = 10_000_000;

/** A record of a regular file, with a time and a size safely before the sync. */
export function fileRecord(path: string, hash = HASH_A, mtime = 1000, size = 10): StoredRecord {
	return makeRecord({ path, kind: "file", hash }, { mtime, size }, SYNC_START);
}

/** Stores records as a pull does: one transaction each. */
async function seed(store: StateStore, records: readonly StoredRecord[]): Promise<void> {
	for (const record of records) await store.commitWrite(record);
}

function byKey<T extends { readonly key: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * What every `StateStore` must do, whatever it keeps the state in. `open`
 * gives a new, empty store each time.
 */
export function describeStateStore(name: string, open: () => Promise<StateStore>): void {
	describe(`${name}: the state store contract`, () => {
		test("a new store is empty", async () => {
			const store = await open();
			expect(await store.readRecords()).toEqual([]);
			expect(await store.readMarkers()).toEqual([]);
			expect(await store.getListing()).toBeNull();
			expect(await store.getMeta("anything")).toBeUndefined();
			expect(await readBaseRevision(store)).toBeNull();
		});

		test("records of every kind are read back as they were stored", async () => {
			const store = await open();
			const records: StoredRecord[] = [
				fileRecord("notes/a.md"),
				// Written during the sync: no time and no size.
				makeRecord({ path: "notes/b.md", kind: "file", hash: HASH_B }, { mtime: SYNC_START, size: 3 }, SYNC_START),
				makeRecord({ path: "link", kind: "symlink", hash: HASH_C }, undefined, SYNC_START),
				makeRecord({ path: "vendor/lib", kind: "submodule", hash: HASH_A }, undefined, SYNC_START),
			];
			await seed(store, records);
			expect(byKey(await store.readRecords())).toEqual(byKey(records));
			expect(records[1]).not.toHaveProperty("mtime");
		});

		test("a record keeps the spelling of the remote and is stored under the NFC key", async () => {
			const store = await open();
			const nfd = "notes/cafe\u0301.md";
			await store.commitWrite(fileRecord(nfd));
			expect(await store.readRecords()).toEqual([
				{ key: "notes/caf\u00e9.md", path: nfd, kind: "file", hash: HASH_A, mtime: 1000, size: 10 },
			]);

			// The remote changed the spelling only: one record, not two.
			await store.commitWrite(fileRecord("notes/caf\u00e9.md"));
			expect((await store.readRecords()).map((record) => record.path)).toEqual(["notes/caf\u00e9.md"]);
		});

		test("a record is stored under the key of its path, whatever key it carries", async () => {
			const store = await open();
			await store.commitWrite({ ...fileRecord("a.md"), key: "something-else" });
			expect((await store.readRecords()).map((record) => record.key)).toEqual(["a.md"]);
		});

		test("only the fields of a record are stored", async () => {
			const store = await open();
			const carrying = { ...fileRecord("a.md"), extra: "not part of a record" };
			await store.commitWrite(carrying);
			expect(await store.readRecords()).toEqual([fileRecord("a.md")]);

			await store.updateStats([{ ...fileRecord("a.md", HASH_A, 1500, 10), extra: "nor this" } as StoredRecord]);
			expect(await store.readRecords()).toEqual([fileRecord("a.md", HASH_A, 1500, 10)]);
		});

		test("storing a written file's record removes its marker, and only its own", async () => {
			const store = await open();
			await store.putMarker(makeMarker("a.md", null, HASH_A, false));
			await store.putMarker(makeMarker("b.md", HASH_C, HASH_B, false));

			await store.commitWrite(fileRecord("a.md"));

			expect(await store.readRecords()).toEqual([fileRecord("a.md")]);
			expect(await store.readMarkers()).toEqual([makeMarker("b.md", HASH_C, HASH_B, false)]);
		});

		test("when storing a written file's record fails, the old record and the marker both stay", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md", HASH_A));
			const marker = makeMarker("a.md", HASH_A, HASH_B, false);
			await store.putMarker(marker);

			// A function cannot be stored, so the write of the record fails
			// after the removal of the marker was asked for.
			const unstorable = { ...fileRecord("a.md", HASH_B), hash: (() => HASH_B) as unknown as string };
			await expect(store.commitWrite(unstorable)).rejects.toMatchObject({ name: "DataCloneError" });

			expect(await store.readRecords()).toEqual([fileRecord("a.md", HASH_A)]);
			expect(await store.readMarkers()).toEqual([marker]);
		});

		test("many records are stored and others removed at once, each stored one's marker with it", async () => {
			const store = await open();
			await seed(store, [fileRecord("a.md", HASH_A), fileRecord("gone.md")]);
			await store.putMarker(makeMarker("b.md", null, HASH_B, false));
			await store.putMarker(makeMarker("c.md", HASH_C, HASH_B, false));

			await store.commitRecords([fileRecord("a.md", HASH_B), fileRecord("b.md", HASH_B)], ["gone.md"]);

			expect((await store.readRecords()).sort((x, y) => x.key.localeCompare(y.key))).toEqual([
				fileRecord("a.md", HASH_B),
				fileRecord("b.md", HASH_B),
			]);
			expect(await store.readMarkers()).toEqual([makeMarker("c.md", HASH_C, HASH_B, false)]);
		});

		test("when one of many records cannot be stored, none is, and nothing is removed", async () => {
			const store = await open();
			await seed(store, [fileRecord("a.md", HASH_A), fileRecord("gone.md")]);
			const marker = makeMarker("b.md", null, HASH_B, false);
			await store.putMarker(marker);

			const unstorable = { ...fileRecord("c.md", HASH_B), hash: (() => HASH_B) as unknown as string };
			await expect(
				store.commitRecords([fileRecord("b.md", HASH_B), unstorable], ["gone.md"]),
			).rejects.toMatchObject({ name: "DataCloneError" });

			expect((await store.readRecords()).sort((x, y) => x.key.localeCompare(y.key))).toEqual([
				fileRecord("a.md", HASH_A),
				fileRecord("gone.md"),
			]);
			expect(await store.readMarkers()).toEqual([marker]);
		});

		test("when one of many updates cannot be stored, none is", async () => {
			const store = await open();
			const before = [fileRecord("a.md"), fileRecord("b.md"), fileRecord("c.md")];
			await seed(store, before);

			const unstorable = { ...fileRecord("b.md"), mtime: (() => 1500) as unknown as number };
			// The cause itself, not only that the transaction was given up.
			await expect(
				store.updateStats([fileRecord("a.md", HASH_A, 1500, 10), unstorable, fileRecord("c.md", HASH_A, 1500, 10)]),
			).rejects.toMatchObject({ name: "DataCloneError" });
			expect(byKey(await store.readRecords())).toEqual(before);
		});

		test("an update that could not be stored does no harm when it is dropped anyway", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md"));

			// No record under its key, so it is never stored, nor looked at that closely.
			const unstorable = { ...fileRecord("never.md"), mtime: (() => 1500) as unknown as number };
			await store.updateStats([unstorable, fileRecord("a.md", HASH_A, 1500, 10)]);

			expect(await store.readRecords()).toEqual([fileRecord("a.md", HASH_A, 1500, 10)]);
		});

		test("markers are read back, with and without a file before the write", async () => {
			const store = await open();
			const markers = [
				makeMarker("new.md", null, HASH_A, false),
				makeMarker("old.md", HASH_B, HASH_C, false),
				makeMarker("old.conflict-from-iPhone-20261007-101500.md", null, HASH_B, true),
				// With the file the copy is of, which its name does not tell.
				makeMarker("_conflicts/2026-10-07 old (iPhone).md", null, HASH_B, true, "notes/old.md"),
			];
			for (const marker of markers) await store.putMarker(marker);
			expect(byKey(await store.readMarkers())).toEqual(byKey(markers));

			// Put again for the same path: replaced, not added.
			await store.putMarker(makeMarker("new.md", null, HASH_C, false));
			expect(await store.readMarkers()).toHaveLength(4);
		});

		test("a marker can be removed alone, leaving the record", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md"));
			await store.putMarker(makeMarker("a.md", HASH_A, HASH_B, false));

			await store.deleteMarker("a.md");

			expect(await store.readMarkers()).toEqual([]);
			expect(await store.readRecords()).toEqual([fileRecord("a.md")]);
		});

		test("a record can be removed alone or together with its marker", async () => {
			const store = await open();
			await seed(store, [fileRecord("a.md"), fileRecord("b.md"), fileRecord("c.md")]);
			await store.putMarker(makeMarker("a.md", HASH_A, HASH_B, false));
			await store.putMarker(makeMarker("b.md", HASH_A, HASH_B, false));

			await store.deleteRecord("a.md");
			await store.deleteRecord("b.md", { withMarker: true });
			// Removing what is not there is not an error.
			await store.deleteRecord("missing.md", { withMarker: true });
			// Nor is removing the record of a key that never had one: a file
			// that is untracked in Sync Evo's own folder is such a key.
			await store.deleteRecord("never.md");
			await store.deleteRecord(".obsidian/plugins/sync-evo/main.js");

			expect(await store.readRecords()).toEqual([fileRecord("c.md")]);
			expect(await store.readMarkers()).toEqual([makeMarker("a.md", HASH_A, HASH_B, false)]);
		});

		test("an update of times and sizes replaces those of the records it names, and no others", async () => {
			const store = await open();
			const racy = makeRecord({ path: "c.md", kind: "file", hash: HASH_C }, undefined, SYNC_START);
			await seed(store, [fileRecord("a.md", HASH_A, 1000, 10), fileRecord("b.md"), racy]);

			await store.updateStats([fileRecord("a.md", HASH_A, 1500, 10), fileRecord("c.md", HASH_C, 1200, 4)]);
			await store.updateStats([]);

			expect(byKey(await store.readRecords())).toEqual([
				fileRecord("a.md", HASH_A, 1500, 10),
				fileRecord("b.md"),
				fileRecord("c.md", HASH_C, 1200, 4),
			]);
		});

		test("an update can take the time and the size away again", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md"));
			await store.updateStats([makeRecord({ path: "a.md", kind: "file", hash: HASH_A }, undefined, SYNC_START)]);
			expect(await store.readRecords()).toEqual([{ key: "a.md", path: "a.md", kind: "file", hash: HASH_A }]);
		});

		test("an update made before a file was written does not put the old hash back", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md", HASH_A, 1000, 10));
			// Held in a batch while the pull writes the file.
			const held = fileRecord("a.md", HASH_A, 1500, 10);
			const written = makeRecord({ path: "a.md", kind: "file", hash: HASH_B }, undefined, SYNC_START);
			await store.commitWrite(written);

			await store.updateStats([held]);

			expect(await store.readRecords()).toEqual([written]);
		});

		test("an update does not undo a spelling taken over from the remote", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("cafe\u0301.md"));
			const held = fileRecord("cafe\u0301.md", HASH_A, 1500, 10);
			await store.commitWrite(fileRecord("caf\u00e9.md"));

			await store.updateStats([held]);

			expect(await store.readRecords()).toEqual([fileRecord("caf\u00e9.md")]);
		});

		test("an update makes no record: one for a path without a record, or removed since, is dropped", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("gone.md"));
			await store.deleteRecord("gone.md");

			await store.updateStats([fileRecord("gone.md", HASH_A, 1500, 10), fileRecord("never.md")]);

			expect(await store.readRecords()).toEqual([]);
		});

		test("an update leaves a symlink or a submodule of the same path and hash alone", async () => {
			const store = await open();
			const link = makeRecord({ path: "x", kind: "symlink", hash: HASH_A }, undefined, SYNC_START);
			await store.commitWrite(link);

			await store.updateStats([fileRecord("x", HASH_A, 1500, 10)]);
			await store.updateStats([{ ...link, mtime: 1500, size: 10 }]);

			expect(await store.readRecords()).toEqual([link]);
		});

		test("the updates that apply are stored when others in the same call are dropped", async () => {
			const store = await open();
			await seed(store, [fileRecord("a.md", HASH_A), fileRecord("b.md", HASH_B)]);

			await store.updateStats([
				fileRecord("a.md", HASH_A, 1500, 10),
				fileRecord("b.md", HASH_C, 1500, 10),
				fileRecord("c.md", HASH_A, 1500, 10),
			]);

			expect(byKey(await store.readRecords())).toEqual([fileRecord("a.md", HASH_A, 1500, 10), fileRecord("b.md", HASH_B)]);
		});

		test("the listing is replaced whole, with its revision", async () => {
			const store = await open();
			const first: RemoteListing = {
				revision: "rev-1",
				entries: [
					{ path: "a.md", kind: "file", hash: HASH_A, size: 3 },
					{ path: "link", kind: "symlink", hash: HASH_B },
				],
			};
			await store.putListing(first);
			expect(await store.getListing()).toEqual(first);

			const second: RemoteListing = { revision: "rev-2", entries: [{ path: "b.md", kind: "file", hash: HASH_C }] };
			await store.putListing(second);
			expect(await store.getListing()).toEqual(second);

			await store.clearListing();
			expect(await store.getListing()).toBeNull();
		});

		test("the listing of a remote with nothing in it is a listing", async () => {
			const store = await open();
			await store.putListing({ revision: null, entries: [] });
			expect(await store.getListing()).toEqual({ revision: null, entries: [] });
		});

		test("the revision of the listing and the base revision are separate values", async () => {
			const store = await open();
			await writeBaseRevision(store, "rev-1");
			await store.putListing({ revision: "rev-2", entries: [] });
			expect(await readBaseRevision(store)).toBe("rev-1");

			await store.clearListing();
			expect(await readBaseRevision(store)).toBe("rev-1");
			await store.deleteMeta(BASE_REVISION_KEY);
			expect(await readBaseRevision(store)).toBeNull();
		});

		test("other values are kept by key", async () => {
			const store = await open();
			await store.setMeta("push-failed", true);
			await store.setMeta("confirmed", { deletes: ["a.md"], at: 5 });
			await store.setMeta("nothing", null);

			expect(await store.getMeta("push-failed")).toBe(true);
			expect(await store.getMeta("confirmed")).toEqual({ deletes: ["a.md"], at: 5 });
			expect(await store.getMeta("nothing")).toBeNull();

			await store.setMeta("push-failed", false);
			await store.deleteMeta("confirmed");
			expect(await store.getMeta("push-failed")).toBe(false);
			expect(await store.getMeta("confirmed")).toBeUndefined();
		});

		test("what is read is a copy: changing it does not change what is stored", async () => {
			const store = await open();
			const value = { list: [1] };
			await store.setMeta("k", value);
			value.list.push(2);
			const read = (await store.getMeta("k")) as { list: number[] };
			read.list.push(3);
			expect(await store.getMeta("k")).toEqual({ list: [1] });
		});

		test("nothing works after close", async () => {
			const store = await open();
			await store.commitWrite(fileRecord("a.md"));
			await store.close();
			await expect(store.readRecords()).rejects.toThrow();
			await expect(store.commitWrite(fileRecord("b.md"))).rejects.toThrow();
		});

		test("6,655 records are written one by one, updated in one call, and read", async () => {
			const store = await open();
			const path = (i: number): string => `notes/${i}/ノート ${i}.md`;
			const records = Array.from({ length: 6655 }, (_, i) => fileRecord(path(i), HASH_A, 1000, i));
			// As a first fetch does: a marker, then the record with the marker's removal.
			for (const record of records) {
				await store.putMarker(makeMarker(record.path, null, record.hash, false));
				await store.commitWrite(record);
			}
			expect(byKey(await store.readRecords())).toEqual(byKey(records));
			expect(await store.readMarkers()).toEqual([]);

			const updates = records.map((record, i) => fileRecord(path(i), HASH_A, 2000, i));
			await store.updateStats(updates);
			expect(byKey(await store.readRecords())).toEqual(byKey(updates));
			// 13,310 transactions: the stand-in for IndexedDB that the tests run
			// on sometimes needs more than the default five seconds for them.
		}, 60_000);
	});
}
