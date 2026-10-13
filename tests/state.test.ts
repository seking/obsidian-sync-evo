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
import type { ListResult, RemoteEntry, RemoteListing } from "../src/core/backend";
import { planSync } from "../src/core/plan";
import {
	awaitsSubmodule,
	copiedPathOf,
	currentListing,
	isListing,
	isStatUpdateOf,
	isUnchangedByStat,
	makeMarker,
	makeMergeMarker,
	makeRecord,
	mergeOf,
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

	const submodule = { path: "lib", kind: "submodule", hash: OTHER };
	const source = { submodule: "lib", repository: "octo/lib", revision: OTHER };

	test.each([
		["a submodule whose inside is listed", { ...submodule, contents: { listed: true, repository: "octo/lib" } }],
		["a submodule that was not listed", { ...submodule, contents: { listed: false, reason: "not-supported" } }],
		["one not listed, with the repository", { ...submodule, contents: { listed: false, reason: "no-access", repository: "octo/lib" } }],
		["a submodule nothing is said of", submodule],
		["a file below a submodule", { ...entry, path: "lib/a.md", source }],
		["a symlink below a submodule", { path: "lib/link", kind: "symlink", hash: HASH, source }],
	])("a listing with %s is one", (_name, good) => {
		expect(isListing({ revision: "r", entries: [entry, good] })).toBe(true);
	});

	test.each(["not-supported", "no-access", "no-commit", "too-large", "nested"])(
		"%s is a reason a submodule was not listed",
		(reason) => {
			expect(isListing({ revision: "r", entries: [{ ...submodule, contents: { listed: false, reason } }] })).toBe(true);
		},
	);

	test.each([
		["on a file says what is inside it", { ...entry, contents: { listed: true, repository: "octo/lib" } }],
		["on a symlink says what is inside it", { path: "l", kind: "symlink", hash: HASH, contents: { listed: false, reason: "nested" } }],
		["is a submodule read from another place", { ...submodule, source }],
		["is a submodule whose inside is null", { ...submodule, contents: null }],
		["is a submodule whose inside is a string", { ...submodule, contents: "listed" }],
		["is a submodule that does not say whether it is listed", { ...submodule, contents: { repository: "octo/lib" } }],
		["is a submodule listed as a string", { ...submodule, contents: { listed: "true", repository: "octo/lib" } }],
		["is a listed submodule without the repository", { ...submodule, contents: { listed: true } }],
		["is a listed submodule whose repository is no string", { ...submodule, contents: { listed: true, repository: 1 } }],
		["is a submodule not listed for no reason", { ...submodule, contents: { listed: false } }],
		["is a submodule not listed for an unknown reason", { ...submodule, contents: { listed: false, reason: "from-a-newer-version" } }],
		["is a submodule not listed whose repository is no string", { ...submodule, contents: { listed: false, reason: "no-access", repository: null } }],
		["has a source that is null", { ...entry, source: null }],
		["has a source that is a string", { ...entry, source: "octo/lib" }],
		["has a source without the submodule", { ...entry, source: { repository: "octo/lib", revision: OTHER } }],
		["has a source without the repository", { ...entry, source: { submodule: "lib", revision: OTHER } }],
		["has a source without the commit", { ...entry, source: { submodule: "lib", repository: "octo/lib" } }],
		["has a source whose commit is no string", { ...entry, source: { ...source, revision: 1 } }],
	])("one entry that %s makes the whole listing none", (_name, bad) => {
		expect(isListing({ revision: "r", entries: [entry, bad, entry] })).toBe(false);
	});
});

describe("a listing that waits for a submodule", () => {
	const file: RemoteEntry = { path: "a.md", kind: "file", hash: HASH, size: 3 };
	const submodule: RemoteEntry = { path: "lib", kind: "submodule", hash: OTHER };
	const listingOf = (...entries: RemoteEntry[]): RemoteListing => ({ revision: "r", entries });

	test("not one without a submodule, nor one of a remote with nothing in it", () => {
		expect(awaitsSubmodule(listingOf(file, { path: "l", kind: "symlink", hash: HASH }))).toBe(false);
		expect(awaitsSubmodule({ revision: null, entries: [] })).toBe(false);
	});

	test("one that says nothing of what is inside a submodule: stored before submodules were listed", () => {
		expect(awaitsSubmodule(listingOf(file, submodule))).toBe(true);
	});

	test("not one whose submodule is listed", () => {
		const listed: RemoteEntry = { ...submodule, contents: { listed: true, repository: "octo/lib" } };
		const below: RemoteEntry = { ...file, path: "lib/a.md", source: { submodule: "lib", repository: "octo/lib", revision: OTHER } };
		expect(awaitsSubmodule(listingOf(file, listed, below))).toBe(false);
	});

	test.each(["no-access", "no-commit"] as const)("one whose submodule was not listed for %s, which ends without the remote moving", (reason) => {
		expect(awaitsSubmodule(listingOf(file, { ...submodule, contents: { listed: false, reason, repository: "octo/lib" } }))).toBe(true);
	});

	test.each(["not-supported", "too-large", "nested"] as const)("not one whose submodule was not listed for %s, which only a new commit ends", (reason) => {
		expect(awaitsSubmodule(listingOf(file, { ...submodule, contents: { listed: false, reason } }))).toBe(false);
	});

	test("one submodule that is waited for is enough", () => {
		const listed: RemoteEntry = { ...submodule, contents: { listed: true, repository: "octo/lib" } };
		const waiting: RemoteEntry = { path: "wip", kind: "submodule", hash: HASH, contents: { listed: false, reason: "no-commit", repository: "octo/wip" } };
		expect(awaitsSubmodule(listingOf(listed, waiting))).toBe(true);
	});
});

describe("the listing of the head of the remote", () => {
	const file: RemoteEntry = { path: "a.md", kind: "file", hash: HASH, size: 3 };
	const submodule: RemoteEntry = { path: "lib", kind: "submodule", hash: OTHER };
	const listed: RemoteEntry = { ...submodule, contents: { listed: true, repository: "octo/lib" } };
	const waiting: RemoteEntry = { ...submodule, contents: { listed: false, reason: "no-access", repository: "octo/lib" } };

	/** A remote that answers with `answer`, and notes what it was asked with. */
	function remoteThat(answer: ListResult): { asked: (string | null)[]; list: (known: string | null) => Promise<ListResult> } {
		const asked: (string | null)[] = [];
		return {
			asked,
			list: async (known) => {
				asked.push(known);
				return answer;
			},
		};
	}

	test("without a stored listing, the remote is asked for all of it, and the answer is stored", async () => {
		const store = new MemoryStateStore();
		const fresh: RemoteListing = { revision: "r1", entries: [file] };
		const remote = remoteThat({ changed: true, listing: fresh });
		expect(await currentListing(store, remote.list)).toEqual(fresh);
		expect(remote.asked).toEqual([null]);
		expect(await store.getListing()).toEqual(fresh);
	});

	test("with a stored listing, the remote is asked with its revision, and the stored one is used while it has not moved", async () => {
		const store = new MemoryStateStore();
		const stored: RemoteListing = { revision: "r1", entries: [file, listed] };
		await store.putListing(stored);
		const remote = remoteThat({ changed: false });
		expect(await currentListing(store, remote.list)).toEqual(stored);
		expect(remote.asked).toEqual(["r1"]);
	});

	test("a remote that moved gives the listing, which takes the place of the stored one", async () => {
		const store = new MemoryStateStore();
		await store.putListing({ revision: "r1", entries: [file] });
		const fresh: RemoteListing = { revision: "r2", entries: [file, listed] };
		const remote = remoteThat({ changed: true, listing: fresh });
		expect(await currentListing(store, remote.list)).toEqual(fresh);
		expect(remote.asked).toEqual(["r1"]);
		expect(await store.getListing()).toEqual(fresh);
	});

	test.each([
		["says nothing of what is inside a submodule", submodule],
		["waits for a repository to come in sight", waiting],
		["waits for a commit to be pushed", { ...submodule, contents: { listed: false, reason: "no-commit", repository: "octo/lib" } } as RemoteEntry],
	])("a stored listing that %s is not asked with: the remote is listed again though it has not moved", async (_name, entry) => {
		const store = new MemoryStateStore();
		await store.putListing({ revision: "r1", entries: [file, entry] });
		// The same revision, and the submodule is listed now.
		const fresh: RemoteListing = { revision: "r1", entries: [file, listed] };
		const remote = remoteThat({ changed: true, listing: fresh });
		expect(await currentListing(store, remote.list)).toEqual(fresh);
		expect(remote.asked).toEqual([null]);
		expect(await store.getListing()).toEqual(fresh);
	});

	test.each(["not-supported", "too-large", "nested"] as const)(
		"a stored listing whose submodule was not listed for %s is asked with as any other",
		async (reason) => {
			const store = new MemoryStateStore();
			const stored: RemoteListing = { revision: "r1", entries: [file, { ...submodule, contents: { listed: false, reason } }] };
			await store.putListing(stored);
			const remote = remoteThat({ changed: false });
			expect(await currentListing(store, remote.list)).toEqual(stored);
			expect(remote.asked).toEqual(["r1"]);
		},
	);

	test("an answer of nothing changed to a question that named no listing is refused", async () => {
		await expect(currentListing(new MemoryStateStore(), remoteThat({ changed: false }).list)).rejects.toThrow();
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

	test("the marker of a merge says what it writes, what the remote has, and where the content from before is", () => {
		const marker = makeMergeMarker("notes/a.md", OTHER, HASH, "c".repeat(40), ".trash/.sync-evo-merged/2026-10-13 a.md");
		expect(marker).toEqual({
			key: "notes/a.md",
			path: "notes/a.md",
			before: OTHER,
			writing: HASH,
			conflictCopy: false,
			merge: { onto: "c".repeat(40), kept: ".trash/.sync-evo-merged/2026-10-13 a.md" },
		});
		expect(mergeOf(marker)).toEqual({ onto: "c".repeat(40), kept: ".trash/.sync-evo-merged/2026-10-13 a.md" });
		expect(mergeOf(makeMarker("notes/a.md", OTHER, HASH, false))).toBeNull();
	});

	test("stored field by field: what a marker says of a merge is kept when it is whole, and never on a copy", () => {
		const marker = makeMergeMarker("notes/a.md", OTHER, HASH, "c".repeat(40), ".trash/.sync-evo-merged/2026-10-13 a.md");
		const merge = { onto: "c".repeat(40), kept: ".trash/.sync-evo-merged/2026-10-13 a.md" };
		expect(plainMarker({ ...marker, extra: 1 } as WriteMarker)).toEqual(marker);
		expect(plainMarker({ ...marker, merge: { ...merge, more: 1 } } as WriteMarker)).toEqual(marker);
		const plain = makeMarker("notes/a.md", OTHER, HASH, false);
		for (const bad of [null, "x", {}, { onto: "c" }, { kept: ".trash/.sync-evo-merged/2026-10-13 a.md" }, { onto: 1, kept: ".trash/.sync-evo-merged/2026-10-13 a.md" }]) {
			const stored = plainMarker({ ...plain, merge: bad } as unknown as WriteMarker);
			expect(stored).toEqual(plain);
			expect(mergeOf({ ...plain, merge: bad } as unknown as WriteMarker)).toBeNull();
		}
		const copy = makeMarker("_conflicts/2026-10-11 a (iPhone).md", null, HASH, true, "notes/a.md");
		expect(plainMarker({ ...copy, merge })).toEqual(copy);
		expect(mergeOf({ ...copy, merge })).toBeNull();
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
