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
import type { RemoteEntry } from "../src/core/backend";
import { exceedsDeletionThreshold } from "../src/core/deletion-threshold";
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { DEFAULT_SIZE_LIMIT, type LocalEntry, type SyncRecord } from "../src/core/plan";
import {
	confirmationOf,
	isConfirmed,
	keepLocal,
	needsConfirmation,
	planPull,
	type PullPlan,
	pullLosses,
} from "../src/core/pull-plan";
import { blobHash } from "./support/memory-backend";

const ownFolder = ".obsidian/plugins/sync-evo";

function rules(gitignore: string | null): Exclusion {
	return createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore });
}

/** One side of a scenario: path → content. */
type Files = Record<string, string>;

function remoteOf(files: Files): RemoteEntry[] {
	return Object.entries(files).map(([path, content]) => ({
		path,
		kind: "file",
		hash: blobHash(content),
		size: content.length,
	}));
}

function localOf(files: Files): LocalEntry[] {
	return Object.entries(files).map(([path, content]) => ({ path, hash: blobHash(content) }));
}

function recordsOf(files: Files): SyncRecord[] {
	return Object.entries(files).map(([path, content]) => ({ path, kind: "file", hash: blobHash(content) }));
}

function link(path: string, target = "../target"): RemoteEntry {
	return { path, kind: "symlink", hash: blobHash(target), size: target.length };
}

interface Scenario {
	remote?: Files | RemoteEntry[];
	local?: Files;
	records?: Files | SyncRecord[];
	exclusion?: Exclusion;
	sizeLimit?: number;
}

function pull(scenario: Scenario): PullPlan {
	const { remote = {}, records = {} } = scenario;
	return planPull({
		remote: Array.isArray(remote) ? remote : remoteOf(remote),
		local: localOf(scenario.local ?? {}),
		records: Array.isArray(records) ? records : recordsOf(records),
		exclusion: scenario.exclusion ?? rules(null),
		...(scenario.sizeLimit === undefined ? {} : { sizeLimit: scenario.sizeLimit }),
	});
}

/** Every step of a plan that touches a file or a record, in the order it is carried out. */
function steps(plan: PullPlan): string[] {
	return [
		...plan.records.map((change) =>
			change.type === "set" ? `record ${change.record.path}` : `drop ${change.record.path}`,
		),
		...plan.deletes.map((entry) => `delete ${entry.local.path} (${entry.cause})`),
		...plan.asides.map((entry) => `aside ${entry.local.path} (${entry.cause})`),
		...plan.folderRenames.map((entry) => `folder ${entry.from} -> ${entry.to}`),
		...plan.renames.map((entry) => {
			const held = entry.step === "already-renamed" ? undefined : entry.occupant;
			const occupant = held === undefined ? "" : held.sameAsRemote ? ", occupant same" : ", occupant aside";
			const from = entry.step === "already-renamed" ? "" : `${entry.from.path} -> `;
			const via = entry.step === "rename" && entry.viaFolder ? ", via folder" : "";
			return `${entry.step} ${from}${entry.to}${via}${occupant}, then ${entry.then}`;
		}),
		...plan.strays.map((entry) => `stray ${entry.local.path} -> ${entry.to}${entry.aside ? " (aside)" : ""}`),
		...plan.writes.map((entry) => `${entry.type} ${entry.remote.path}`),
	];
}

function skips(plan: PullPlan): string[] {
	return plan.skipped.map((skip) => `${skip.reason} ${skip.key}`);
}

function counted(plan: PullPlan): string[] {
	return pullLosses(plan, false).deletions.map((loss) => loss.path);
}

describe("the half of the decision a pull acts on", () => {
	test("what only a push can do is left alone, file and record", () => {
		const plan = pull({
			remote: { "kept.md": "K", "deleted-here.md": "D", "edited-here.md": "E" },
			records: { "kept.md": "K", "deleted-here.md": "D", "edited-here.md": "E" },
			local: { "kept.md": "K", "edited-here.md": "E2", "new-here.md": "N" },
		});
		expect(steps(plan)).toEqual([]);
		expect(plan.fetch).toEqual([]);
		expect(plan.pushOnly.map((action) => `${action.type} ${action.key}`)).toEqual([
			"delete-remote deleted-here.md",
			"upload edited-here.md",
			"upload new-here.md",
		]);
	});

	test("each kind of change on the remote becomes one step", () => {
		const plan = pull({
			remote: { "changed.md": "C2", "added.md": "A", "both.md": "theirs" },
			records: { "changed.md": "C", "both.md": "B", "gone.md": "G", "gone-twice.md": "X" },
			local: { "changed.md": "C", "both.md": "mine", "gone.md": "G" },
		});
		expect(steps(plan)).toEqual([
			"drop gone-twice.md",
			"delete gone.md (deleted)",
			"download added.md",
			"conflict both.md",
			"download changed.md",
		]);
	});

	test("a file the remote deleted and the vault edited stays", () => {
		const plan = pull({ records: { "a.md": "A" }, local: { "a.md": "A2" } });
		expect(steps(plan)).toEqual([]);
		expect(counted(plan)).toEqual([]);
	});

	test("deleted on the remote, edited in the vault, and matched by a rule: only the record goes", () => {
		const plan = pull({
			records: { "drafts/a.md": "A" },
			local: { "drafts/a.md": "A2" },
			exclusion: rules("/drafts/\n"),
		});
		expect(steps(plan)).toEqual(["drop drafts/a.md"]);
		expect(plan.deletes).toEqual([]);
	});

	test("what is fetched is a list of remote entries, one per write", () => {
		const plan = pull({
			remote: { "a.md": "A", "b.md": "theirs", "same.md": "S" },
			local: { "b.md": "mine", "same.md": "S" },
		});
		expect(plan.fetch).toEqual([
			{ path: "a.md", kind: "file", hash: blobHash("A"), size: 1 },
			{ path: "b.md", kind: "file", hash: blobHash("theirs"), size: 6 },
		]);
	});
});

describe("paths without a record", () => {
	test("a first fetch: same content is recorded, other content is a conflict, the rest is fetched", () => {
		const plan = pull({
			remote: { "same.md": "S", "differs.md": "theirs", "remote-only.md": "R" },
			local: { "same.md": "S", "differs.md": "mine", "local-only.md": "L" },
		});
		expect(plan.recordCount).toBe(0);
		expect(steps(plan)).toEqual(["record same.md", "conflict differs.md", "download remote-only.md"]);
		expect(plan.deletes).toEqual([]);
		expect(pullLosses(plan, true)).toEqual({ rewritten: true, deletions: [], overwrites: [] });
	});

	test("lost records: files that still match are not fetched again", () => {
		const files = { "a.md": "A", "b.md": "B" };
		const plan = pull({ remote: files, local: files });
		expect(steps(plan)).toEqual(["record a.md", "record b.md"]);
		expect(plan.fetch).toEqual([]);
	});

	test("an empty remote and no records: nothing to do", () => {
		const plan = pull({ local: { "a.md": "A", "b.md": "B" } });
		expect(steps(plan)).toEqual([]);
		expect(plan.fetch).toEqual([]);
		expect(plan.skipped).toEqual([]);
		expect(plan.emptiedFolders).toEqual([]);
		expect(needsConfirmation(pullLosses(plan, false), plan.recordCount)).toBe(false);
	});
});

describe("remote paths that differ only in case or normalization", () => {
	test("two files that differ only in case: neither is written, recorded, or deleted", () => {
		const plan = pull({ remote: { "a.md": "one", "A.md": "two" } });
		expect(steps(plan)).toEqual([]);
		expect(skips(plan)).toEqual(["case-collision A.md", "case-collision a.md"]);
		expect(plan.collisions).toEqual([{ folded: "a.md", spellings: ["A.md", "a.md"] }]);
	});

	test("a folder spelled two ways: everything below both is left alone", () => {
		const plan = pull({
			remote: { "notes/a.md": "A2", "Notes/b.md": "B", "other.md": "O" },
			records: { "notes/a.md": "A", "notes/gone.md": "G" },
			local: { "notes/a.md": "A", "notes/gone.md": "G", "notes/mine.md": "M" },
		});
		// The group has a record whose remote content changed, and a
		// recorded file the remote deleted: neither is acted on.
		expect(steps(plan)).toEqual(["download other.md"]);
		expect(counted(plan)).toEqual([]);
		expect(skips(plan)).toEqual([
			"case-collision Notes/b.md",
			"case-collision notes/a.md",
			"case-collision notes/gone.md",
			"case-collision notes/mine.md",
		]);
		expect(plan.collisions).toEqual([{ folded: "notes", spellings: ["Notes", "notes"] }]);
		const skip = plan.skipped.find((entry) => entry.key === "notes/a.md");
		expect(skip?.remote.map((entry) => entry.path)).toEqual(["notes/a.md"]);
		expect(skip?.local.map((entry) => entry.path)).toEqual(["notes/a.md"]);
		expect(skip?.records.map((entry) => entry.path)).toEqual(["notes/a.md"]);
	});

	test("a file and a folder of the same name in another case collide too", () => {
		const plan = pull({ remote: { Readme: "R", "readme/a.md": "A" } });
		expect(steps(plan)).toEqual([]);
		expect(plan.collisions).toEqual([{ folded: "readme", spellings: ["Readme", "readme"] }]);
	});

	test("only the topmost name of a collision is reported", () => {
		const plan = pull({ remote: { "x/notes/sub/a.md": "A", "x/Notes/sub/b.md": "B", "x/c.md": "C" } });
		expect(plan.collisions).toEqual([{ folded: "x/notes", spellings: ["x/Notes", "x/notes"] }]);
		expect(steps(plan)).toEqual(["download x/c.md"]);
	});

	test("two files that differ only in normalization are skipped with both spellings", () => {
		const nfc = "が.md";
		const nfd = nfc.normalize("NFD");
		const plan = pull({ remote: { [nfc]: "one", [nfd]: "two" }, local: { [nfc]: "mine" } });
		expect(steps(plan)).toEqual([]);
		expect(skips(plan)).toEqual([`duplicate-path ${nfc}`]);
		expect(plan.skipped[0]?.remote.map((entry) => entry.path).sort()).toEqual([nfc, nfd].sort());
	});

	test("one folder spelled in NFC and NFD is not a collision", () => {
		const folder = "が";
		const plan = pull({ remote: { [`${folder}/a.md`]: "A", [`${folder.normalize("NFD")}/b.md`]: "B" } });
		expect(plan.collisions).toEqual([]);
		expect(plan.writes.map((write) => write.key)).toEqual([`${folder}/a.md`, `${folder}/b.md`]);
	});
});

describe("files over the size limit", () => {
	const big = (size: number): RemoteEntry[] => [{ path: "big.bin", kind: "file", hash: blobHash("new"), size }];

	test("not fetched", () => {
		const plan = pull({ remote: big(DEFAULT_SIZE_LIMIT + 1) });
		expect(steps(plan)).toEqual([]);
		expect(plan.fetch).toEqual([]);
		expect(skips(plan)).toEqual(["too-large big.bin"]);
		expect(plan.skipped[0]?.remote[0]?.size).toBe(DEFAULT_SIZE_LIMIT + 1);
	});

	test("a file of exactly the limit is fetched", () => {
		expect(steps(pull({ remote: big(DEFAULT_SIZE_LIMIT) }))).toEqual(["download big.bin"]);
	});

	test("a recorded file that grew past the limit keeps its record and its vault file", () => {
		const plan = pull({ remote: big(11), records: { "big.bin": "old" }, local: { "big.bin": "old" }, sizeLimit: 10 });
		expect(steps(plan)).toEqual([]);
		expect(skips(plan)).toEqual(["too-large big.bin"]);
		expect(plan.skipped[0]?.records.map((record) => record.hash)).toEqual([blobHash("old")]);
	});

	test("the limit can be set", () => {
		expect(steps(pull({ remote: big(11), sizeLimit: 11 }))).toEqual(["download big.bin"]);
	});
});

describe("other paths that are skipped", () => {
	test("a path that is not a path, and the plugin's own folder on the remote", () => {
		const plan = pull({ remote: { "a//b.md": "X", [`${ownFolder}/main.js`]: "M", "ok.md": "O" } });
		expect(steps(plan)).toEqual(["download ok.md"]);
		expect(skips(plan)).toEqual([`own-folder ${ownFolder}/main.js`, "invalid-path a//b.md"]);
		expect(plan.skipped.find((skip) => skip.reason === "own-folder")?.remote).toHaveLength(1);
	});

	test("a submodule gets no record, and nothing below it is touched", () => {
		const plan = pull({
			remote: [{ path: "knowledge", kind: "submodule", hash: "c0ffee" }, ...remoteOf({ "a.md": "A" })],
			records: { "knowledge/old.md": "O" },
			local: { "knowledge/old.md": "O", "knowledge/mine.md": "M" },
		});
		expect(steps(plan)).toEqual(["download a.md"]);
		expect(skips(plan)).toEqual([
			"submodule knowledge",
			"under-non-file knowledge/mine.md",
			"under-non-file knowledge/old.md",
		]);
		expect(plan.symlinks).toEqual([]);
	});
});

describe("symlinks", () => {
	const linkRecord = (path: string, target = "../target"): SyncRecord => ({
		path,
		kind: "symlink",
		hash: blobHash(target),
	});

	test("a symlink without a record is recorded, not fetched, and told once", () => {
		const plan = pull({ remote: [link(".claude/skills")] });
		expect(plan.fetch).toEqual([]);
		expect(plan.writes).toEqual([]);
		expect(plan.records).toEqual([
			{ type: "set", key: ".claude/skills", record: linkRecord(".claude/skills") },
		]);
		expect(plan.symlinks.map((entry) => [entry.key, entry.firstSeen])).toEqual([[".claude/skills", true]]);
		expect(plan.skipped).toEqual([]);
	});

	test("a symlink that has its record needs nothing and is not told again", () => {
		const plan = pull({ remote: [link("link")], records: [linkRecord("link")] });
		expect(steps(plan)).toEqual([]);
		expect(plan.symlinks.map((entry) => entry.firstSeen)).toEqual([false]);
	});

	test("a symlink that points elsewhere now only has its record brought up to date", () => {
		const plan = pull({ remote: [link("link", "../other")], records: [linkRecord("link")] });
		expect(plan.records).toEqual([{ type: "set", key: "link", record: linkRecord("link", "../other") }]);
		expect(plan.symlinks.map((entry) => entry.firstSeen)).toEqual([false]);
	});

	test("a vault file at the path of a new symlink is neither compared nor touched", () => {
		const plan = pull({ remote: [link("link")], local: { link: "a real file" } });
		expect(steps(plan)).toEqual(["record link"]);
		expect(plan.symlinks[0]?.local.map((entry) => entry.path)).toEqual(["link"]);
	});

	test("paths below a symlink stay untouched", () => {
		const plan = pull({
			remote: [link("link")],
			records: [linkRecord("link"), ...recordsOf({ "link/gone.md": "G" })],
			local: { "link/gone.md": "G", "link/mine.md": "M" },
		});
		expect(steps(plan)).toEqual([]);
		expect(skips(plan)).toEqual(["under-non-file link/gone.md", "under-non-file link/mine.md"]);
	});

	describe("a symlink that became a regular file", () => {
		test("is fetched when the vault has nothing there", () => {
			const plan = pull({ remote: { link: "now a file" }, records: [linkRecord("link")] });
			expect(steps(plan)).toEqual(["drop link", "download link"]);
			expect(plan.symlinks).toEqual([]);
		});

		test("is only recorded when the vault holds the same content", () => {
			const plan = pull({ remote: { link: "F" }, records: [linkRecord("link")], local: { link: "F" } });
			expect(steps(plan)).toEqual(["drop link", "record link"]);
		});

		test("is a conflict when the vault holds other content", () => {
			const plan = pull({ remote: { link: "F" }, records: [linkRecord("link")], local: { link: "mine" } });
			expect(steps(plan)).toEqual(["drop link", "conflict link"]);
		});

		test("a folder that took its place is fetched in the same pull", () => {
			const plan = pull({ remote: { "link/a.md": "A" }, records: [linkRecord("link")] });
			expect(steps(plan)).toEqual(["drop link", "download link/a.md"]);
		});
	});

	describe("a regular file that became a symlink", () => {
		test("an unchanged vault file is deleted and the symlink recorded", () => {
			const plan = pull({ remote: [link("a")], records: { a: "A" }, local: { a: "A" } });
			expect(steps(plan)).toEqual(["delete a (became-symlink)"]);
			expect(plan.deletes[0]?.recordAfter).toEqual(linkRecord("a"));
			expect(plan.symlinks.map((entry) => [entry.firstSeen, entry.local])).toEqual([[true, []]]);
			expect(counted(plan)).toEqual(["a"]);
		});

		test("an edited vault file is moved to a conflict copy, never deleted", () => {
			const plan = pull({ remote: [link("a")], records: { a: "A" }, local: { a: "A2" } });
			expect(steps(plan)).toEqual(["aside a (became-symlink)"]);
			expect(plan.asides[0]).toMatchObject({ nameAfter: "a", recordAfter: linkRecord("a") });
			expect(plan.deletes).toEqual([]);
		});

		test("with no vault file only the record changes", () => {
			const plan = pull({ remote: [link("a")], records: { a: "A" } });
			expect(plan.records).toEqual([{ type: "set", key: "a", record: linkRecord("a") }]);
		});
	});

	test("a symlink removed on the remote: the record goes and a vault file stays", () => {
		const plan = pull({ records: [linkRecord("link")], local: { link: "mine" } });
		expect(steps(plan)).toEqual(["drop link"]);
		expect(plan.pushOnly.map((action) => `${action.type} ${action.key}`)).toEqual(["upload link"]);
	});
});

describe("the spelling of a record", () => {
	test("follows the remote when only the normalization changed; the vault file keeps its name", () => {
		const nfc = "notes/が.md";
		const nfd = nfc.normalize("NFD");
		const plan = pull({ remote: { [nfc]: "A" }, records: { [nfd]: "A" }, local: { [nfd]: "A" } });
		expect(plan.records).toEqual([
			{
				type: "set",
				key: nfc,
				record: { path: nfc, kind: "file", hash: blobHash("A") },
				local: { path: nfd, hash: blobHash("A") },
			},
		]);
		expect(plan.renames).toEqual([]);
		expect(plan.folderRenames).toEqual([]);
		expect(steps(plan)).toHaveLength(1);
	});
});

describe("a rename on the remote that only changes the case", () => {
	test("is a rename, not a deletion and a write", () => {
		const plan = pull({ remote: { "Notes.md": "N" }, records: { "notes.md": "N" }, local: { "notes.md": "N" } });
		expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, then done"]);
		expect(plan.renames[0]).toMatchObject({
			kind: "remote-rename",
			fromNow: "notes.md",
			dropRecord: { path: "notes.md", hash: blobHash("N") },
			recordAfter: { path: "Notes.md", kind: "file", hash: blobHash("N") },
		});
		expect(plan.deletes).toEqual([]);
		expect(plan.fetch).toEqual([]);
		expect(pullLosses(plan, true)).toMatchObject({ deletions: [], overwrites: [] });
	});

	test("the content is written after the rename when it changed too", () => {
		const plan = pull({ remote: { "Notes.md": "N2" }, records: { "notes.md": "N" }, local: { "notes.md": "N" } });
		expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, then write", "download Notes.md"]);
		// Between the two steps the record has the new name and the old
		// content, so a pull that stops there plans a plain download.
		expect(plan.renames[0]?.recordAfter).toEqual({ path: "Notes.md", kind: "file", hash: blobHash("N") });
		expect(plan.writes[0]).toMatchObject({
			afterRename: true,
			local: { path: "Notes.md", hash: blobHash("N") },
			record: { path: "Notes.md", hash: blobHash("N") },
		});
		expect(pullLosses(plan, true).overwrites).toEqual([{ key: "Notes.md", path: "notes.md" }]);
	});

	test("a file the vault edited is renamed and then handled as a conflict", () => {
		const plan = pull({ remote: { "Notes.md": "N2" }, records: { "notes.md": "N" }, local: { "notes.md": "mine" } });
		expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, then conflict", "conflict Notes.md"]);
		expect(plan.writes[0]).toMatchObject({ afterRename: true, local: { path: "Notes.md", hash: blobHash("mine") } });
	});

	test("an edit in the vault with unchanged remote content is renamed and left for a push", () => {
		const plan = pull({ remote: { "Notes.md": "N" }, records: { "notes.md": "N" }, local: { "notes.md": "mine" } });
		expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, then done"]);
		expect(plan.renames[0]?.recordAfter).toEqual({ path: "Notes.md", kind: "file", hash: blobHash("N") });
	});

	test("the same edit on both sides is renamed and recorded", () => {
		const plan = pull({ remote: { "Notes.md": "N2" }, records: { "notes.md": "N" }, local: { "notes.md": "N2" } });
		expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, then done"]);
		expect(plan.renames[0]?.recordAfter?.hash).toBe(blobHash("N2"));
	});

	test("a change of normalization alone is never a pair", () => {
		const nfc = "が.md";
		const plan = pull({
			remote: { [nfc]: "A2" },
			records: { [nfc.normalize("NFD")]: "A" },
			local: { [nfc.normalize("NFD")]: "A" },
		});
		expect(plan.renames).toEqual([]);
		expect(steps(plan)).toEqual([`download ${nfc}`]);
	});

	test("a file deleted on both sides while the remote added the other case is not a pair", () => {
		const plan = pull({ remote: { "Notes.md": "N" }, records: { "notes.md": "N" } });
		expect(steps(plan)).toEqual(["drop notes.md", "download Notes.md"]);
	});

	describe("when the vault already holds another file under the new spelling", () => {
		test("that file is moved to a conflict copy first, then the old file is renamed", () => {
			const plan = pull({
				remote: { "Notes.md": "N" },
				records: { "notes.md": "N" },
				local: { "notes.md": "N", "Notes.md": "made here" },
			});
			expect(steps(plan)).toEqual(["rename notes.md -> Notes.md, occupant aside, then done"]);
			expect(plan.renames[0]).toMatchObject({
				occupant: { local: { path: "Notes.md", hash: blobHash("made here") }, sameAsRemote: false },
			});
			expect(plan.deletes).toEqual([]);
		});

		test("and the remote content changed: written after the rename", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "N", "Notes.md": "made here" },
			});
			expect(steps(plan)).toEqual([
				"rename notes.md -> Notes.md, occupant aside, then write",
				"download Notes.md",
			]);
		});

		test("and the old file was edited too: two copies, the second one made after the rename", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "edited", "Notes.md": "made here" },
			});
			expect(steps(plan)).toEqual([
				"rename notes.md -> Notes.md, occupant aside, then conflict",
				"conflict Notes.md",
			]);
			// Both copies are named after the new spelling: the first after
			// `to`, the second after the path of the conflict.
			expect(plan.renames[0]?.to).toBe("Notes.md");
			expect(plan.writes[0]).toMatchObject({ type: "conflict", afterRename: true, local: { path: "Notes.md" } });
		});

		test("a file that already is the remote content stays, and the unchanged old file is deleted", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "N", "Notes.md": "N2" },
			});
			expect(steps(plan)).toEqual(["delete-old notes.md -> Notes.md, occupant same, then done"]);
			expect(plan.renames[0]?.recordAfter).toEqual({ path: "Notes.md", kind: "file", hash: blobHash("N2") });
			expect(plan.fetch).toEqual([]);
			// Part of a pair: not counted, but named when the history was rewritten.
			expect(counted(plan)).toEqual([]);
			expect(pullLosses(plan, true).deletions).toEqual([{ key: "notes.md", path: "notes.md" }]);
		});

		test("a file that still is the recorded content, like the old one: no copy of the same bytes", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "N", "Notes.md": "N" },
			});
			expect(steps(plan)).toEqual([
				"delete-old notes.md -> Notes.md, occupant aside, then write",
				"download Notes.md",
			]);
			expect(plan.renames[0]?.recordAfter).toEqual({ path: "Notes.md", kind: "file", hash: blobHash("N") });
			expect(plan.writes[0]).toMatchObject({ local: { path: "Notes.md", hash: blobHash("N") } });
			expect(pullLosses(plan, true)).toMatchObject({
				deletions: [{ key: "notes.md", path: "notes.md" }],
				overwrites: [{ key: "Notes.md", path: "Notes.md" }],
			});
		});

		test("the same, but the old file was edited: the occupant is moved aside as before", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "edited", "Notes.md": "N" },
			});
			expect(steps(plan)).toEqual([
				"rename notes.md -> Notes.md, occupant aside, then conflict",
				"conflict Notes.md",
			]);
		});

		test("the same, with an edited old file: it is moved to a copy instead of deleted", () => {
			const plan = pull({
				remote: { "Notes.md": "N2" },
				records: { "notes.md": "N" },
				local: { "notes.md": "edited", "Notes.md": "N2" },
			});
			expect(steps(plan)).toEqual(["old-aside notes.md -> Notes.md, occupant same, then done"]);
			expect(pullLosses(plan, true).deletions).toEqual([]);
		});
	});

	describe("resuming after the rename, before the record was fixed", () => {
		test("no file under the old name and the recorded content under the new one: already renamed", () => {
			const plan = pull({ remote: { "Notes.md": "N2" }, records: { "notes.md": "N" }, local: { "Notes.md": "N" } });
			expect(steps(plan)).toEqual(["already-renamed Notes.md, then write", "download Notes.md"]);
			expect(plan.renames[0]).toMatchObject({
				dropRecord: { path: "notes.md" },
				recordAfter: { path: "Notes.md", hash: blobHash("N") },
			});
			expect(plan.renames[0]).not.toHaveProperty("from");
			expect(plan.renames[0]).not.toHaveProperty("occupant");
			expect(plan.asides).toEqual([]);
			// The same key as before the rename, so the confirmation still covers it.
			expect(pullLosses(plan, true).overwrites).toEqual([{ key: "Notes.md", path: "Notes.md" }]);
		});

		test("with unchanged content only the record is fixed", () => {
			const plan = pull({ remote: { "Notes.md": "N" }, records: { "notes.md": "N" }, local: { "Notes.md": "N" } });
			expect(steps(plan)).toEqual(["already-renamed Notes.md, then done"]);
		});

		test("other content under the new name is a file of its own: a conflict, as without a record", () => {
			const plan = pull({ remote: { "Notes.md": "N2" }, records: { "notes.md": "N" }, local: { "Notes.md": "X" } });
			expect(steps(plan)).toEqual(["drop notes.md", "conflict Notes.md"]);
		});
	});

	describe("of a folder", () => {
		const before = { "notes/a.md": "A", "notes/sub/b.md": "B" };
		const after = { "Notes/a.md": "A", "Notes/sub/b.md": "B2" };

		test("where the scan returns the old spelling: one folder rename carries the files", () => {
			const plan = pull({
				remote: after,
				records: before,
				local: { ...before, "notes/unsent.md": "U" },
			});
			expect(steps(plan)).toEqual([
				"folder notes -> Notes",
				"rename notes/a.md -> Notes/a.md, via folder, then done",
				"rename notes/sub/b.md -> Notes/sub/b.md, via folder, then write",
				"download Notes/sub/b.md",
			]);
			expect(plan.deletes).toEqual([]);
			expect(counted(plan)).toEqual([]);
			expect(plan.strays).toEqual([]);
			expect(plan.emptiedFolders).toEqual([]);
			expect(plan.renames.map((rename) => rename.recordAfter?.path)).toEqual(["Notes/a.md", "Notes/sub/b.md"]);
		});

		test("where the vault holds both folders: files move one by one, with those the remote never got", () => {
			const plan = pull({
				remote: after,
				records: before,
				local: { ...before, "notes/unsent.md": "U", "notes/x.md": "old x", "Notes/x.md": "X" },
			});
			expect(steps(plan)).toEqual([
				"rename notes/a.md -> Notes/a.md, then done",
				"rename notes/sub/b.md -> Notes/sub/b.md, then write",
				"stray notes/unsent.md -> Notes/unsent.md",
				"stray notes/x.md -> Notes/x.md (aside)",
				"download Notes/sub/b.md",
			]);
			expect(plan.folderRenames).toEqual([]);
			expect(plan.renames).toMatchObject([{ fromNow: "notes/a.md" }, { fromNow: "notes/sub/b.md" }]);
			// The file the user put in `Notes/` is not touched.
			expect(plan.pushOnly.map((action) => action.key)).toContain("Notes/x.md");
			expect(plan.emptiedFolders).toEqual(["notes/sub", "notes"]);
		});

		test("a file deleted in the same range is deleted under the old spelling, before the rename", () => {
			const plan = pull({
				remote: { "Notes/a.md": "A" },
				records: { "notes/a.md": "A", "notes/old.md": "O" },
				local: { "notes/a.md": "A", "notes/old.md": "O" },
			});
			expect(steps(plan)).toEqual([
				"delete notes/old.md (deleted)",
				"folder notes -> Notes",
				"rename notes/a.md -> Notes/a.md, via folder, then done",
			]);
			// The folder that may be empty is named as it is spelled by then.
			expect(plan.emptiedFolders).toEqual(["Notes"]);
			expect(counted(plan)).toEqual(["notes/old.md"]);
		});

		test("nested folders are renamed from the top down", () => {
			const plan = pull({
				remote: { "Notes/Sub/a.md": "A", "Notes/b.md": "B" },
				records: { "notes/sub/a.md": "A", "notes/b.md": "B" },
				local: { "notes/sub/a.md": "A", "notes/b.md": "B" },
			});
			expect(plan.folderRenames).toEqual([
				{ from: "notes", to: "Notes" },
				{ from: "Notes/sub", to: "Notes/Sub" },
			]);
			expect(plan.renames).toMatchObject([{ viaFolder: true }, { viaFolder: true }]);
		});

		test("two vault folders that become one: only the first is renamed whole", () => {
			const plan = pull({
				remote: { "Notes/a.md": "A", "Notes/b.md": "B" },
				records: { "notes/a.md": "A", "NOTES/b.md": "B" },
				local: { "notes/a.md": "A", "NOTES/b.md": "B" },
			});
			expect(steps(plan)).toEqual([
				"folder NOTES -> Notes",
				"rename notes/a.md -> Notes/a.md, then done",
				"rename NOTES/b.md -> Notes/b.md, via folder, then done",
			]);
			expect(plan.renames[0]).toMatchObject({ fromNow: "notes/a.md", viaFolder: false });
			expect(plan.emptiedFolders).toEqual(["notes"]);
		});

		test("resumed after every file was moved: the old folder is still a candidate", () => {
			const plan = pull({
				remote: { "Notes/a.md": "A", "Notes/b.md": "B" },
				records: { "notes/a.md": "A", "notes/b.md": "B" },
				local: { "Notes/a.md": "A", "Notes/b.md": "B", "Notes/x.md": "X" },
			});
			expect(steps(plan)).toEqual([
				"already-renamed Notes/a.md, then done",
				"already-renamed Notes/b.md, then done",
			]);
			expect(plan.emptiedFolders).toEqual(["notes"]);
		});

		test("a stray does not take the name of a folder the pull is about to write into", () => {
			const plan = pull({
				remote: { "Notes/a/x.md": "X", "Notes/b.md": "B" },
				records: { "notes/b.md": "B" },
				local: { "notes/b.md": "B", "notes/a": "unsent", "Notes/mine.md": "M" },
			});
			expect(steps(plan)).toEqual([
				"rename notes/b.md -> Notes/b.md, then done",
				"stray notes/a -> Notes/a (aside)",
				"download Notes/a/x.md",
			]);
		});

		test("a stray that would land below a file the pull writes stays where it is", () => {
			const plan = pull({
				remote: { "Notes/a": "A", "Notes/b.md": "B" },
				records: { "notes/b.md": "B" },
				local: { "notes/b.md": "B", "notes/a/x.md": "unsent", "Notes/mine.md": "M" },
			});
			expect(steps(plan)).toEqual(["rename notes/b.md -> Notes/b.md, then done", "download Notes/a"]);
			expect(plan.strays).toEqual([]);
		});

		test("a nested folder whose new name is taken once the parent is renamed is not renamed as a whole", () => {
			// `notes/Sub` goes along with `notes` and is `Notes/Sub` by then,
			// though the scan found no folder of that spelling.
			const plan = pull({
				remote: { "Notes/Sub/a.md": "A" },
				records: { "notes/sub/a.md": "A" },
				local: { "notes/sub/a.md": "A", "notes/Sub/x.md": "X", "notes/sub/unsent.md": "U" },
			});
			expect(plan.folderRenames).toEqual([{ from: "notes", to: "Notes" }]);
			expect(steps(plan)).toEqual([
				"folder notes -> Notes",
				"rename notes/sub/a.md -> Notes/Sub/a.md, then done",
				"stray notes/sub/unsent.md -> Notes/Sub/unsent.md",
			]);
			expect(plan.renames[0]).toMatchObject({ fromNow: "Notes/sub/a.md", viaFolder: false });
			expect(plan.emptiedFolders).toEqual(["Notes/sub", "Notes"]);
		});

		test("60 files in a renamed folder are 60 renames and no deletion", () => {
			const names = Array.from({ length: 60 }, (_, i) => `n${i}.md`);
			const under = (folder: string): Files => Object.fromEntries(names.map((name) => [`${folder}/${name}`, name]));
			const plan = pull({ remote: under("Notes"), records: under("notes"), local: under("notes") });
			expect(plan.renames).toHaveLength(60);
			expect(plan.folderRenames).toEqual([{ from: "notes", to: "Notes" }]);
			expect(plan.deletes).toEqual([]);
			expect(needsConfirmation(pullLosses(plan, false), plan.recordCount)).toBe(false);
		});
	});
});

describe("a vault file under another case than the path about to be written", () => {
	test("a first fetch into a vault that spells a folder otherwise", () => {
		const plan = pull({
			remote: { "Notes/a.md": "A", "Notes/b.md": "theirs" },
			local: { "notes/a.md": "A", "notes/b.md": "mine", "notes/c.md": "C" },
		});
		expect(steps(plan)).toEqual([
			"folder notes -> Notes",
			"rename notes/a.md -> Notes/a.md, via folder, then done",
			"rename notes/b.md -> Notes/b.md, via folder, then conflict",
			"conflict Notes/b.md",
		]);
		expect(plan.renames.map((rename) => rename.kind)).toEqual(["vault-spelling", "vault-spelling"]);
		expect(plan.renames.map((rename) => rename.recordAfter?.path)).toEqual(["Notes/a.md", undefined]);
	});

	test("recorded under the remote's spelling, changed on the remote: renamed back, then written", () => {
		const plan = pull({ remote: { "a.md": "A2" }, records: { "a.md": "A" }, local: { "A.md": "A" } });
		expect(steps(plan)).toEqual(["rename A.md -> a.md, then write", "download a.md"]);
	});

	test("two such files: the device tells the cases apart, and the path is simply fetched", () => {
		const plan = pull({ remote: { "a.md": "A" }, local: { "A.md": "1", "a.MD": "2" } });
		expect(steps(plan)).toEqual(["download a.md"]);
	});

	test("when that file is one the pull must not touch, nothing is written", () => {
		const blocked = planPull({
			remote: remoteOf({ "a.md": "A" }),
			local: [{ path: "A.md", hash: blobHash("1"), size: 500 }],
			records: [],
			exclusion: rules(null),
			sizeLimit: 100,
		});
		expect(steps(blocked)).toEqual([]);
		expect(skips(blocked)).toEqual(["too-large A.md", "blocked a.md"]);
	});

	// T020 item n. The record and the remote agree on `drafts/a.md`; the
	// vault spells it `Drafts/a.md`.
	test("record and remote agree and nothing changed: a pull does nothing, with or without a rule", () => {
		for (const exclusion of [rules(null), rules("/drafts/\n")]) {
			const plan = pull({
				remote: { "drafts/a.md": "A" },
				records: { "drafts/a.md": "A" },
				local: { "Drafts/a.md": "A" },
				exclusion,
			});
			expect(steps(plan)).toEqual([]);
			expect(plan.pushOnly.map((action) => `${action.type} ${action.key}`)).toContain("delete-remote drafts/a.md");
		}
	});
});

describe("files and folders that traded places", () => {
	test("file to folder: the unchanged file is deleted before the files below are written", () => {
		const plan = pull({ remote: { "a/x.md": "X" }, records: { a: "A" }, local: { a: "A" } });
		expect(steps(plan)).toEqual(["delete a (swap)", "download a/x.md"]);
		expect(counted(plan)).toEqual([]);
		expect(pullLosses(plan, true).deletions).toEqual([{ key: "a", path: "a" }]);
	});

	test("file to folder, with an edited file: it is moved to a conflict copy", () => {
		const plan = pull({ remote: { "a/x.md": "X" }, records: { a: "A" }, local: { a: "A2" } });
		expect(steps(plan)).toEqual(["aside a (became-folder)", "download a/x.md"]);
		expect(plan.asides[0]).toMatchObject({ nameAfter: "a", record: { path: "a" } });
		expect(plan.pushOnly).toEqual([]);
	});

	test("a new vault file where the remote has a new folder is moved aside as well", () => {
		const plan = pull({ remote: { "a/x.md": "X", "a/y.md": "Y" }, local: { a: "mine" } });
		expect(steps(plan)).toEqual(["aside a (became-folder)", "download a/x.md", "download a/y.md"]);
		expect(plan.asides[0]?.record).toBeUndefined();
	});

	test("folder to file: the unchanged files are deleted and the folder makes way", () => {
		const plan = pull({
			remote: { a: "A" },
			records: { "a/x.md": "X", "a/y.md": "Y" },
			local: { "a/x.md": "X", "a/y.md": "Y" },
		});
		expect(steps(plan)).toEqual(["delete a/x.md (swap)", "delete a/y.md (swap)", "download a"]);
		expect(plan.writes[0]).toMatchObject({ replacesFolder: true });
		expect(counted(plan)).toEqual([]);
	});

	test("folder to file, with a file the remote never got: the remote file waits", () => {
		const plan = pull({
			remote: { a: "A" },
			records: { "a/x.md": "X", "a/y.md": "Y" },
			local: { "a/x.md": "X", "a/y.md": "edited", "a/new.md": "N" },
		});
		expect(steps(plan)).toEqual(["delete a/x.md (deleted)"]);
		expect(skips(plan)).toEqual(["blocked a"]);
		expect(plan.skipped[0]?.local.map((entry) => entry.path).sort()).toEqual(["a/new.md", "a/y.md"]);
		expect(plan.fetch).toEqual([]);
		// Nothing is written in its place, so this is a plain deletion.
		expect(counted(plan)).toEqual(["a/x.md"]);
	});
});

describe("counting deletions", () => {
	const many = (count: number, folder: string): Files =>
		Object.fromEntries(Array.from({ length: count }, (_, i) => [`${folder}/n${i}.md`, `content ${i}`]));

	test("the threshold: more than 50, or more than 5 and more than a tenth", () => {
		expect(exceedsDeletionThreshold(50, 6655)).toBe(false);
		expect(exceedsDeletionThreshold(51, 6655)).toBe(true);
		expect(exceedsDeletionThreshold(5, 5)).toBe(false);
		expect(exceedsDeletionThreshold(6, 30)).toBe(true);
		expect(exceedsDeletionThreshold(6, 59)).toBe(true);
		expect(exceedsDeletionThreshold(6, 60)).toBe(false);
		expect(exceedsDeletionThreshold(0, 0)).toBe(false);
	});

	test("51 deleted files stop the pull", () => {
		const rest = many(1000, "keep");
		const gone = many(51, "gone");
		const plan = pull({ remote: rest, records: { ...rest, ...gone }, local: { ...rest, ...gone } });
		const losses = pullLosses(plan, false);
		expect(losses.deletions).toHaveLength(51);
		expect(losses.overwrites).toEqual([]);
		expect(plan.recordCount).toBe(1051);
		expect(needsConfirmation(losses, plan.recordCount)).toBe(true);
	});

	test("a folder of 60 files moved elsewhere does not", () => {
		const rest = many(1000, "keep");
		const plan = pull({
			remote: { ...rest, ...many(60, "new") },
			records: { ...rest, ...many(60, "old") },
			local: { ...rest, ...many(60, "old") },
		});
		expect(plan.deletes).toHaveLength(60);
		expect(plan.deletes.every((entry) => entry.cause === "moved")).toBe(true);
		expect(needsConfirmation(pullLosses(plan, false), plan.recordCount)).toBe(false);
		// The content is fetched again by the same pull, so not even a
		// rewritten history makes these a loss.
		expect(pullLosses(plan, true).deletions).toEqual([]);
	});

	test("one added path stands for one deleted path only", () => {
		const plan = pull({
			remote: { "new/copy.md": "" },
			records: { "a.md": "", "b.md": "", "c.md": "" },
			local: { "a.md": "", "b.md": "", "c.md": "" },
		});
		expect(plan.deletes.map((entry) => entry.cause)).toEqual(["moved", "deleted", "deleted"]);
		expect(counted(plan)).toEqual(["b.md", "c.md"]);
	});

	test("content the vault already holds elsewhere is not an added path", () => {
		const plan = pull({ remote: { "b.md": "X" }, records: { "a.md": "X" }, local: { "a.md": "X", "b.md": "X" } });
		expect(counted(plan)).toEqual(["a.md"]);
	});

	test("edited files, dropped records, and skipped paths are not deletions", () => {
		const plan = pull({
			remote: [{ path: "big.bin", kind: "file", hash: blobHash("B2"), size: DEFAULT_SIZE_LIMIT + 1 }],
			records: { "edited.md": "E", "gone-here-too.md": "G", "big.bin": "B" },
			local: { "edited.md": "E2", "big.bin": "B" },
		});
		expect(counted(plan)).toEqual([]);
	});
});

describe("when the history was rewritten", () => {
	const scenario: Scenario = {
		remote: { "reverted.md": "old", "untouched.md": "U", "theirs.md": "T" },
		records: { "reverted.md": "new", "untouched.md": "U", "sent-from-here.md": "S" },
		local: { "reverted.md": "new", "untouched.md": "U", "sent-from-here.md": "S" },
	};

	test("one deletion or one overwrite is enough to ask, and both are listed apart", () => {
		const plan = pull(scenario);
		const losses = pullLosses(plan, true);
		expect(losses.deletions).toEqual([{ key: "sent-from-here.md", path: "sent-from-here.md" }]);
		expect(losses.overwrites).toEqual([{ key: "reverted.md", path: "reverted.md" }]);
		expect(needsConfirmation(losses, plan.recordCount)).toBe(true);
		expect(needsConfirmation(pullLosses(plan, false), plan.recordCount)).toBe(false);
	});

	test("a fetch of a path that is new to the vault is not an overwrite", () => {
		const plan = pull({ remote: { "a.md": "A" } });
		expect(needsConfirmation(pullLosses(plan, true), plan.recordCount)).toBe(false);
	});

	test("keeping the vault files: records change, the files stay, the rest is pulled", () => {
		const plan = pull(scenario);
		const kept = keepLocal(plan, new Set(["sent-from-here.md", "reverted.md"]));
		expect(steps(kept)).toEqual(["drop sent-from-here.md", "record reverted.md", "download theirs.md"]);
		expect(kept.records[1]).toMatchObject({ record: { path: "reverted.md", hash: blobHash("old") } });
		expect(kept.fetch.map((entry) => entry.path)).toEqual(["theirs.md"]);
		expect(kept.recordCount).toBe(3);
		expect(pullLosses(kept, true)).toMatchObject({ deletions: [], overwrites: [] });
	});

	test("keeping only some of them leaves the others as planned", () => {
		const kept = keepLocal(pull(scenario), new Set(["reverted.md"]));
		expect(steps(kept)).toEqual([
			"record reverted.md",
			"delete sent-from-here.md (deleted)",
			"download theirs.md",
		]);
	});

	test("a kept file that was also renamed is still renamed; only its content stays", () => {
		const plan = pull({ remote: { "Notes.md": "old" }, records: { "notes.md": "new" }, local: { "notes.md": "new" } });
		expect(pullLosses(plan, true).overwrites).toEqual([{ key: "Notes.md", path: "notes.md" }]);
		const kept = keepLocal(plan, new Set(["Notes.md"]));
		expect(steps(kept)).toEqual(["rename notes.md -> Notes.md, then done"]);
		expect(kept.renames[0]).toMatchObject({
			dropRecord: { path: "notes.md", hash: blobHash("new") },
			recordAfter: { path: "Notes.md", hash: blobHash("old") },
		});
		expect(kept.fetch).toEqual([]);
	});

	test("the same after the rename was already made", () => {
		const plan = pull({ remote: { "Notes.md": "old" }, records: { "notes.md": "new" }, local: { "Notes.md": "new" } });
		const kept = keepLocal(plan, new Set(["Notes.md"]));
		expect(steps(kept)).toEqual(["drop notes.md", "record Notes.md"]);
		expect(kept.records[1]).toMatchObject({ record: { hash: blobHash("old") } });
	});

	test("a kept file the vault spells in another case is still given the remote's spelling", () => {
		const plan = pull({ remote: { "a.md": "A2" }, records: { "a.md": "A" }, local: { "A.md": "A" } });
		expect(steps(plan)).toEqual(["rename A.md -> a.md, then write", "download a.md"]);
		expect(pullLosses(plan, true).overwrites).toEqual([{ key: "a.md", path: "A.md" }]);

		const kept = keepLocal(plan, new Set(["a.md"]));
		expect(steps(kept)).toEqual(["rename A.md -> a.md, then done"]);
		expect(kept.renames[0]).toMatchObject({
			kind: "vault-spelling",
			recordAfter: { path: "a.md", kind: "file", hash: blobHash("A2") },
		});
		expect(kept.fetch).toEqual([]);
		// Nothing is left for a push that would delete the remote file.
		expect(kept.pushOnly).toEqual([]);
		expect(pullLosses(kept, true)).toMatchObject({ deletions: [], overwrites: [] });
	});

	test("and the state that leaves behind plans no pull action and asks nothing", () => {
		const after = pull({ remote: { "a.md": "A2" }, records: { "a.md": "A2" }, local: { "a.md": "A" } });
		expect(steps(after)).toEqual([]);
		expect(after.pushOnly.map((action) => `${action.type} ${action.key}`)).toEqual(["upload a.md"]);
		expect(needsConfirmation(pullLosses(after, true), after.recordCount)).toBe(false);
	});

	// A file under the other case is never deleted as part of such a rename.
	// It can only be a deletion of its own, beside a write to the other
	// spelling; kept, it is in the way of that write like any unsent file.
	test("a kept deletion beside a write to the other case: the content goes to a copy, the write is made", () => {
		const scenario: Scenario = {
			remote: { "a.md": "A2" },
			records: { "a.md": "A", "A.md": "X" },
			local: { "A.md": "X" },
		};
		const plan = pull(scenario);
		expect(steps(plan)).toEqual(["delete A.md (deleted)", "download a.md"]);
		const kept = keepLocal(plan, new Set(["A.md"]));
		expect(steps(kept)).toEqual(["drop A.md", "rename A.md -> a.md, then conflict", "conflict a.md"]);
		expect(kept.deletes).toEqual([]);
	});

	test("a kept file where the remote now has a folder is moved to a copy, so the folder can be written", () => {
		const plan = pull({ remote: { "a/x.md": "X" }, records: { a: "A" }, local: { a: "A" } });
		const kept = keepLocal(plan, new Set(["a"]));
		expect(steps(kept)).toEqual(["drop a", "aside a (became-folder)", "download a/x.md"]);
		expect(kept.deletes).toEqual([]);
	});
});

describe("a confirmation that is remembered", () => {
	const scenario: Scenario = {
		remote: { "reverted.md": "old" },
		records: { "reverted.md": "new", "a.md": "A", "b.md": "B" },
		local: { "reverted.md": "new", "a.md": "A", "b.md": "B" },
	};

	test("covers what is left of the same pull", () => {
		const confirmed = confirmationOf(pullLosses(pull(scenario), true));
		expect(confirmed).toEqual({ rewritten: true, deletions: ["a.md", "b.md"], overwrites: ["reverted.md"] });

		// `a.md` is gone and its record with it; the rest is still to do.
		const resumed = pull({
			...scenario,
			records: { "reverted.md": "new", "b.md": "B" },
			local: { "reverted.md": "new", "b.md": "B" },
		});
		expect(isConfirmed(pullLosses(resumed, true), confirmed)).toBe(true);
	});

	test("does not cover a path that was not in it", () => {
		const confirmed = confirmationOf(pullLosses(pull(scenario), true));
		const more = pull({
			...scenario,
			records: { "reverted.md": "new", "a.md": "A", "b.md": "B", "c.md": "C" },
			local: { "reverted.md": "new", "a.md": "A", "b.md": "B", "c.md": "C" },
		});
		expect(isConfirmed(pullLosses(more, true), confirmed)).toBe(false);
	});

	test("given for deletions alone does not cover overwrites after a rewrite", () => {
		const plan = pull(scenario);
		const confirmed = confirmationOf(pullLosses(plan, false));
		expect(confirmed).toEqual({ rewritten: false, deletions: ["a.md", "b.md"], overwrites: [] });
		expect(isConfirmed(pullLosses(plan, false), confirmed)).toBe(true);
		expect(isConfirmed(pullLosses(plan, true), confirmed)).toBe(false);
	});

	test("nothing remembered covers nothing", () => {
		expect(isConfirmed(pullLosses(pull(scenario), false), undefined)).toBe(false);
	});
});

describe("folders that may be left empty", () => {
	test("every folder above a deleted file, deepest first", () => {
		const plan = pull({
			remote: { "keep/a.md": "A" },
			records: { "keep/a.md": "A", "x/y/z.md": "Z", "x/w.md": "W" },
			local: { "keep/a.md": "A", "x/y/z.md": "Z", "x/w.md": "W" },
		});
		expect(plan.emptiedFolders).toEqual(["x/y", "x"]);
	});

	test("a pull that removes nothing names no folder", () => {
		const plan = pull({ remote: { "a/b.md": "B2" }, records: { "a/b.md": "B" }, local: { "a/b.md": "B" } });
		expect(plan.emptiedFolders).toEqual([]);
	});

	test("a file that is moved to the name of a copy leaves its folder: the copy goes to the folder of the copies", () => {
		const plan = pull({ remote: [link("x/y/link")], records: { "x/y/link": "A" }, local: { "x/y/link": "A2" } });
		expect(plan.asides.map((aside) => aside.local.path)).toEqual(["x/y/link"]);
		expect(plan.emptiedFolders).toEqual(["x/y", "x"]);
	});

	test("a rename within one folder does not empty it", () => {
		const plan = pull({ remote: { "n/A.md": "A" }, records: { "n/a.md": "A" }, local: { "n/a.md": "A" } });
		expect(plan.emptiedFolders).toEqual([]);
	});
});
