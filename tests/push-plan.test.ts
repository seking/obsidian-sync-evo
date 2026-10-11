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
import type { EntryKind, RemoteEntry } from "../src/core/backend";
import { createExclusion } from "../src/core/exclusion";
import { foldedKey } from "../src/core/paths";
import type { LocalEntry, SyncRecord } from "../src/core/plan";
import {
	holdsDeletions,
	needsPushConfirmation,
	type PushPlan,
	planPush,
	remoteSpelling,
	withoutDeletions,
	withoutTidiedCopies,
} from "../src/core/push-plan";
import { blobHash } from "./support/memory-backend";
import { earlierCopyPath } from "./support/earlier-copy-name";

const ownFolder = ".obsidian/plugins/sync-evo";

interface Scenario {
	/** Files on both sides, with a record. */
	synced?: Record<string, string>;
	/** Files of the remote this device has no record of. */
	remoteOnly?: Record<string, string>;
	/** Paths of `synced` or `remoteOnly` that are not plain files on the remote. */
	kinds?: Record<string, EntryKind>;
	/** What happened in the vault since (`null` deletes). */
	local?: Record<string, string | null>;
	gitignore?: string;
	held?: string[];
	sizeLimit?: number;
}

function plan(scenario: Scenario): PushPlan {
	const kindOf = (path: string): EntryKind => scenario.kinds?.[path] ?? "file";
	const remote: RemoteEntry[] = [];
	const records: SyncRecord[] = [];
	const vault = new Map<string, string>();
	for (const [path, content] of Object.entries(scenario.synced ?? {})) {
		remote.push({ path, kind: kindOf(path), hash: blobHash(content), size: content.length });
		records.push({ path, kind: kindOf(path), hash: blobHash(content) });
		if (kindOf(path) === "file") vault.set(path, content);
	}
	for (const [path, content] of Object.entries(scenario.remoteOnly ?? {})) {
		remote.push({ path, kind: kindOf(path), hash: blobHash(content), size: content.length });
	}
	for (const [path, content] of Object.entries(scenario.local ?? {})) {
		if (content === null) vault.delete(path);
		else vault.set(path, content);
	}
	const local: LocalEntry[] = [...vault].map(([path, content]) => ({ path, hash: blobHash(content), size: content.length }));
	return planPush({
		remote,
		local,
		records,
		exclusion: createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore: scenario.gitignore ?? null }),
		...(scenario.held === undefined ? {} : { held: new Set(scenario.held.map(foldedKey)) }),
		...(scenario.sizeLimit === undefined ? {} : { sizeLimit: scenario.sizeLimit }),
	});
}

/** What a plan sends and deletes, as lines: "A", "M", and "D" with the path on the remote. */
function changes(made: PushPlan): string[] {
	return [
		...made.sends.map((send) => `${send.replaces === undefined ? "A" : "M"} ${send.path}`),
		...made.deletes.map((entry) => `D ${entry.remote.path}`),
	].sort();
}

describe("what a push sends", () => {
	test("new files, edited files, and the deletion of files the vault deleted", () => {
		const made = plan({
			synced: { "keep.md": "K", "edit.md": "E", "old.md": "O" },
			local: { "edit.md": "E2", "old.md": null, "new.md": "N" },
		});
		expect(changes(made)).toEqual(["A new.md", "D old.md", "M edit.md"]);
		expect(made.refused).toEqual([]);
		expect(made.recordCount).toBe(3);
	});

	test("nothing of what only a pull can do: a file the remote changed, added, or deleted, and a conflict", () => {
		const made = plan({
			synced: { "a.md": "A", "both.md": "B" },
			remoteOnly: { "theirs.md": "T" },
			local: { "both.md": "mine" },
		});
		// `both.md` was edited here alone, so it is sent. The file this device
		// never had is not deleted for being missing.
		expect(changes(made)).toEqual(["M both.md"]);
	});

	test("a file of the remote without a record is never deleted, and never written over", () => {
		const made = plan({ remoteOnly: { "a.md": "theirs", "gone.md": "G" }, local: { "a.md": "mine" } });
		expect(changes(made)).toEqual([]);
	});

	test("nothing at, or below, a symlink or a submodule, and neither is deleted", () => {
		const made = plan({
			synced: { link: "../target", knowledge: "c".repeat(40), "a.md": "A" },
			kinds: { link: "symlink", knowledge: "submodule" },
			local: { link: "a file now", "link/below.md": "B", "knowledge/note.md": "N", "a.md": "A2" },
		});
		expect(changes(made)).toEqual(["M a.md"]);
	});

	test("nothing that a rule of .gitignore excludes, the plugin's own folder, or a .git", () => {
		const made = plan({
			synced: { "a.md": "A" },
			gitignore: "private/\n",
			local: {
				"private/diary.md": "D",
				[`${ownFolder}/main.js`]: "js",
				".git/config": "c",
				"sub/.git/HEAD": "h",
				"b.md": "B",
			},
		});
		expect(changes(made)).toEqual(["A b.md"]);
	});

	test("a file over the size limit is not sent, on either side, and is not deleted", () => {
		const made = plan({
			synced: { "big.bin": "0123456789", "a.md": "A" },
			remoteOnly: { "theirs.bin": "0123456789ABCDEF" },
			local: { "big.bin": "0123456789 and more", "mine.bin": "0123456789ABCDEF", "theirs.bin": "x", "a.md": "A2" },
			sizeLimit: 12,
		});
		expect(changes(made)).toEqual(["M a.md"]);
		expect(made.skipped.filter((skip) => skip.reason === "too-large").map((skip) => skip.key)).toEqual([
			"big.bin",
			"mine.bin",
			"theirs.bin",
		]);
	});

	test("a held path is neither sent nor deleted", () => {
		const made = plan({
			synced: { "half.md": "H", "gone.md": "G", "a.md": "A" },
			local: { "half.md": "half writ", "gone.md": null, "a.md": "A2", "new-half.md": "x" },
			held: ["half.md", "gone.md", "new-half.md"],
		});
		expect(changes(made)).toEqual(["M a.md"]);
	});

	test("the copy of a conflict is sent like any new file, but not one of a file in the configuration folder", () => {
		const at = new Date(2026, 9, 3, 22, 15, 0);
		const copy = earlierCopyPath("notes/a.md", "iPhone", at);
		const settingsCopy = earlierCopyPath(".obsidian/app.json", "iPhone", at);
		const made = plan({
			synced: { "notes/a.md": "A", ".obsidian/app.json": "{}" },
			local: { [copy]: "mine", [settingsCopy]: "{mine}" },
		});
		expect(changes(made)).toEqual([`A ${copy}`]);
	});
});

describe("new paths that differ from others only in case", () => {
	test("a new file beside a file of the remote is not sent; everything else is", () => {
		const made = plan({ synced: { "Case.md": "C" }, local: { "case.md": "c", "other.md": "O" } });
		expect(changes(made)).toEqual(["A other.md"]);
		expect(made.refused).toEqual([{ path: "case.md", reason: "case-collision" }]);
	});

	test("a new file in a folder that differs in case from one of the remote is not sent", () => {
		const made = plan({ synced: { "notes/a.md": "A" }, local: { "Notes/b.md": "B" } });
		expect(changes(made)).toEqual([]);
		expect(made.refused).toEqual([{ path: "Notes/b.md", reason: "case-collision" }]);
	});

	test("two new files that differ only in case are both left", () => {
		const made = plan({ synced: { "a.md": "A" }, local: { "New.md": "1", "new.md": "2", "sub/X/a.md": "3", "sub/x/b.md": "4" } });
		expect(changes(made)).toEqual([]);
		expect(made.refused.map((file) => file.path).sort()).toEqual(["New.md", "new.md", "sub/X/a.md", "sub/x/b.md"]);
	});

	test("a rename that only changes the case is sent, as a deletion and an addition", () => {
		const made = plan({ synced: { "Case.md": "C" }, local: { "Case.md": null, "case.md": "C" } });
		expect(changes(made)).toEqual(["A case.md", "D Case.md"]);
		expect(made.refused).toEqual([]);
		expect(made.countedDeletions).toEqual([]);
	});

	test("so is the rename of a folder, with every file in it", () => {
		const made = plan({
			synced: { "notes/a.md": "A", "notes/b.md": "B" },
			local: { "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "A", "Notes/b.md": "B edited" },
		});
		expect(changes(made)).toEqual(["A Notes/a.md", "A Notes/b.md", "D notes/a.md", "D notes/b.md"]);
		expect(made.countedDeletions).toEqual([]);
	});

	test("a pair the remote already holds is left alone on every side", () => {
		// Not the push's to stop: the sync decision turns both away.
		const made = plan({ synced: { "a.md": "A", "A.md": "B", "x.md": "X" }, local: { "a.md": "A2", "x.md": "X2" } });
		expect(changes(made)).toEqual(["M x.md"]);
	});

	test("a rename whose new spelling a rule excludes sends neither the deletion nor the file", () => {
		const made = plan({
			synced: { "drafts/a.md": "A", "keep.md": "K" },
			gitignore: "/drafts/\n",
			local: { "drafts/a.md": null, "Drafts/a.md": "A", "keep.md": "K2" },
		});
		expect(changes(made)).toEqual(["M keep.md"]);
		expect(made.heldRenames).toEqual([{ from: "drafts/a.md", to: "Drafts/a.md" }]);
		expect(made.countedDeletions).toEqual([]);
	});

	test("without the rule, the same rename is sent", () => {
		const made = plan({ synced: { "drafts/a.md": "A" }, local: { "drafts/a.md": null, "Drafts/a.md": "A" } });
		expect(changes(made)).toEqual(["A Drafts/a.md", "D drafts/a.md"]);
		expect(made.heldRenames).toEqual([]);
	});

	test("a folder renamed in case while the remote has a file in it that is not deleted: nothing of the rename is sent", () => {
		// `notes/theirs.md` was never pulled, so `notes` stays on the remote,
		// and `Notes/a.md` beside it would be a pair. Its deletion is held
		// back with it: sent alone, the file would be gone from the remote.
		const made = plan({
			synced: { "notes/a.md": "A", "x.md": "X" },
			remoteOnly: { "notes/theirs.md": "T" },
			local: { "notes/a.md": null, "Notes/a.md": "A", "x.md": "X2" },
		});
		expect(changes(made)).toEqual(["M x.md"]);
		expect(made.refused).toEqual([{ path: "Notes/a.md", reason: "case-collision" }]);
		expect(made.heldRenames).toEqual([{ from: "notes/a.md", to: "Notes/a.md" }]);
	});

	test("a deletion that is held back can be in the way of another new path", () => {
		// `Docs/a.md` is not sent (a rule), so `docs/a.md` stays, and with it
		// the folder `docs`: the new `Docs/b.md` would make a pair of folders.
		const made = plan({
			synced: { "docs/a.md": "A" },
			gitignore: "/docs/a.md\n",
			local: { "docs/a.md": null, "Docs/a.md": "A", "Docs/b.md": "B" },
		});
		expect(changes(made)).toEqual([]);
		expect(made.heldRenames).toEqual([{ from: "docs/a.md", to: "Docs/a.md" }]);
		expect(made.refused).toEqual([{ path: "Docs/b.md", reason: "case-collision" }]);
	});
});

describe("new paths the remote has something else at", () => {
	test("a file where the remote has a folder, and a file below a file of the remote, are not sent", () => {
		const made = plan({
			synced: { "x.md": "X" },
			remoteOnly: { "a/theirs.md": "T", b: "a file" },
			local: { a: "a file here", "b/mine.md": "M", "x.md": "X2" },
		});
		expect(changes(made)).toEqual(["M x.md"]);
		expect(made.refused).toEqual([
			{ path: "a", reason: "remote-in-the-way" },
			{ path: "b/mine.md", reason: "remote-in-the-way" },
		]);
	});

	test("a folder the vault turned into a file is sent when every file of it is deleted", () => {
		const made = plan({
			synced: { "d/x.md": "X", "d/y.md": "Y" },
			local: { "d/x.md": null, "d/y.md": null, d: "a file now" },
		});
		expect(changes(made)).toEqual(["A d", "D d/x.md", "D d/y.md"]);
	});
});

describe("how a new path is spelled on the remote", () => {
	const nfc = "café";
	const nfd = "café";

	test("the name of a new file is in NFC", () => {
		expect(remoteSpelling([])(`notes/${nfd}.md`)).toBe(`notes/${nfc}.md`);
	});

	test("a folder the remote has keeps the remote's spelling, and what is new below it is in NFC", () => {
		const spell = remoteSpelling([{ path: `${nfd}/sub/a.md` }]);
		expect(spell(`${nfc}/new.md`)).toBe(`${nfd}/new.md`);
		expect(spell(`${nfc}/sub/${nfd}.md`)).toBe(`${nfd}/sub/${nfc}.md`);
		expect(spell(`${nfc}/other/${nfd}/x.md`)).toBe(`${nfd}/other/${nfc}/x.md`);
	});

	test("a folder that differs in case is another folder", () => {
		expect(remoteSpelling([{ path: "notes/a.md" }])("Notes/b.md")).toBe("Notes/b.md");
	});

	test("a file of an NFD path that is edited is sent under that path, and a new one beside it into the same folder", () => {
		const made = plan({
			synced: { [`${nfd}/${nfd}.md`]: "A" },
			local: { [`${nfd}/${nfd}.md`]: null, [`${nfc}/${nfc}.md`]: "A2", [`${nfc}/new.md`]: "N" },
		});
		expect(changes(made)).toEqual([`A ${nfd}/new.md`, `M ${nfd}/${nfd}.md`]);
	});
});

describe("what counts as a deletion", () => {
	const many = (count: number, content: (i: number) => string, folder = "n"): Record<string, string> =>
		Object.fromEntries(Array.from({ length: count }, (_, i) => [`${folder}/${String(i).padStart(3, "0")}.md`, content(i)]));
	const none = (files: Record<string, string>): Record<string, null> =>
		Object.fromEntries(Object.keys(files).map((path) => [path, null]));

	test("six of thirty stop the push, five do not", () => {
		const files = many(30, (i) => `note ${i}`);
		const six = Object.fromEntries(Object.keys(files).slice(0, 6).map((path) => [path, null]));
		const five = Object.fromEntries(Object.keys(files).slice(0, 5).map((path) => [path, null]));
		expect(needsPushConfirmation(plan({ synced: files, local: six }))).toBe(true);
		expect(needsPushConfirmation(plan({ synced: files, local: five }))).toBe(false);
	});

	test("fifty-one stop it in a vault of any size", () => {
		const files = many(1000, (i) => `note ${i}`);
		const gone = (count: number): Record<string, null> =>
			Object.fromEntries(Object.keys(files).slice(0, count).map((path) => [path, null]));
		expect(needsPushConfirmation(plan({ synced: files, local: gone(51) }))).toBe(true);
		expect(needsPushConfirmation(plan({ synced: files, local: gone(50) }))).toBe(false);
	});

	test("files that moved are not counted", () => {
		const files = many(20, (i) => `note ${i}`);
		const made = plan({ synced: files, local: { ...none(files), ...many(20, (i) => `note ${i}`, "moved") } });
		expect(made.deletes.length).toBe(20);
		expect(made.countedDeletions).toEqual([]);
		expect(needsPushConfirmation(made)).toBe(false);
	});

	test("one new path stands for one deleted file only: a hundred empty files deleted and one added", () => {
		const files = many(100, () => "");
		const made = plan({ synced: files, local: { ...none(files), "new-empty.md": "" } });
		expect(made.countedDeletions.length).toBe(99);
		expect(needsPushConfirmation(made)).toBe(true);
	});

	test("a move to a path that is not sent is a deletion", () => {
		const files = many(10, (i) => `note ${i}`);
		const made = plan({
			synced: files,
			gitignore: "private/\n",
			local: { ...none(files), ...many(10, (i) => `note ${i}`, "private") },
		});
		expect(made.sends).toEqual([]);
		expect(made.countedDeletions.length).toBe(10);
	});

	test("an edited file that takes the content of a deleted one is no move", () => {
		const made = plan({ synced: { "a.md": "A", "b.md": "B" }, local: { "a.md": null, "b.md": "A" } });
		expect(made.countedDeletions).toEqual(["a.md"]);
	});

	test("a rename that only changes the case is not counted, also when the file was edited too", () => {
		const files = many(10, (i) => `note ${i}`);
		const renamed = Object.fromEntries(
			Object.entries(files).map(([path, content]) => [path.replace("n/", "N/"), `${content} edited`]),
		);
		const made = plan({ synced: files, local: { ...none(files), ...renamed } });
		expect(made.deletes.length).toBe(10);
		expect(made.countedDeletions).toEqual([]);
	});

	test("a deletion that is held back is not counted", () => {
		const made = plan({
			synced: { "drafts/a.md": "A" },
			gitignore: "/drafts/\n",
			local: { "drafts/a.md": null, "Drafts/a.md": "A" },
		});
		expect(made.deletes).toEqual([]);
		expect(made.countedDeletions).toEqual([]);
	});
});

describe("the deletions that wait for a new file that is being typed in", () => {
	const known = (paths: readonly string[]) => (path: string): boolean => paths.includes(path);

	test("wait when a file that is held back for it is new", () => {
		expect(holdsDeletions(["new.md"], known(["old.md"]))).toBe(true);
		expect(holdsDeletions(["a.md", "new.md"], known(["a.md"]))).toBe(true);
	});

	test("do not when every such file is known, or there is none", () => {
		expect(holdsDeletions(["a.md"], known(["a.md", "old.md"]))).toBe(false);
		expect(holdsDeletions([], known([]))).toBe(false);
	});

	test("a plan without them sends what it sent, deletes nothing, and counts no deletion", () => {
		const exclusion = createExclusion({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo", gitignore: null });
		const hash = "a".repeat(40);
		const plan = planPush({
			remote: [
				{ path: "old.md", kind: "file", hash },
				{ path: "b.md", kind: "file", hash },
			],
			local: [{ path: "b.md", hash: "b".repeat(40), size: 1 }],
			records: [
				{ path: "old.md", kind: "file", hash },
				{ path: "b.md", kind: "file", hash },
			],
			exclusion,
			sizeLimit: 1000,
		});
		expect(plan.deletes.map((entry) => entry.remote.path)).toEqual(["old.md"]);

		const waiting = withoutDeletions(plan);

		expect(waiting.deletes).toEqual([]);
		expect(waiting.countedDeletions).toEqual([]);
		expect(waiting.sends).toEqual(plan.sends);
		expect(waiting.recordCount).toBe(plan.recordCount);
		// A plan that deletes nothing is the plan it was.
		expect(withoutDeletions(waiting)).toBe(waiting);
	});
});

describe("the conflict copies that were tidied", () => {
	const copies = Array.from({ length: 8 }, (_, i) => `_conflicts/20260801 n${i} (iPhone).md`);
	const notes = Array.from({ length: 12 }, (_, i) => `n/${i}.md`);
	const synced = Object.fromEntries([...copies, ...notes].map((path) => [path, `content of ${path}`]));
	const gone = (paths: readonly string[]): Record<string, null> => Object.fromEntries(paths.map((path) => [path, null]));

	test("are deleted on the remote like any file the vault deleted, and not counted among the deletions that ask", () => {
		const made = plan({ synced, local: gone(copies) });
		expect(made.deletes.map((entry) => entry.remote.path)).toEqual(copies);
		expect(needsPushConfirmation(made)).toBe(true);

		const discounted = withoutTidiedCopies(made, copies);

		expect(discounted.deletes).toEqual(made.deletes);
		expect(discounted.countedDeletions).toEqual([]);
		expect(needsPushConfirmation(discounted)).toBe(false);
	});

	test("the other deletions of the same push are counted as ever", () => {
		const made = plan({ synced, local: gone([...copies, ...notes.slice(0, 6)]) });
		const discounted = withoutTidiedCopies(made, copies);
		expect(discounted.countedDeletions).toEqual(notes.slice(0, 6));
		expect(needsPushConfirmation(discounted)).toBe(true);
	});

	test("a copy the user deleted by hand is counted: only what was tidied is passed over", () => {
		const made = plan({ synced, local: gone(copies) });
		expect(withoutTidiedCopies(made, copies.slice(0, 2)).countedDeletions).toEqual(copies.slice(2));
		expect(withoutTidiedCopies(made, [])).toBe(made);
	});

	test("whatever is remembered, only a copy in the folder of the copies is passed over", () => {
		const made = plan({ synced, local: gone(notes.slice(0, 6)) });
		expect(withoutTidiedCopies(made, notes)).toBe(made);
	});

	test("a copy the vault spelled in another case than the remote does is the same copy", () => {
		const made = plan({ synced, local: gone(copies) });
		const spelled = copies.map((path) => path.replace("_conflicts/", "_Conflicts/"));
		expect(withoutTidiedCopies(made, spelled).countedDeletions).toEqual([]);
	});
});
