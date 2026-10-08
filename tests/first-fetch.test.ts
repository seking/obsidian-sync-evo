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
import { createExclusion } from "../src/core/exclusion";
import {
	FIRST_FETCH_CONFIRMED_KEY,
	firstFetchFiles,
	hasFirstFetchQuestion,
	isFirstFetchConfirmed,
	markFirstFetchConfirmed,
} from "../src/core/first-fetch";
import type { LocalEntry, SyncRecord } from "../src/core/plan";
import { planPull } from "../src/core/pull-plan";
import { blobHash } from "./support/memory-backend";
import { MemoryStateStore } from "./support/memory-state-store";

const ownFolder = ".obsidian/plugins/sync-evo";

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

function link(path: string, target = "../target"): RemoteEntry {
	return { path, kind: "symlink", hash: blobHash(target), size: target.length };
}

function localOf(files: Files): LocalEntry[] {
	return Object.entries(files).map(([path, content]) => ({ path, hash: blobHash(content), size: content.length }));
}

function recordsOf(files: Files): SyncRecord[] {
	return Object.entries(files).map(([path, content]) => ({ path, kind: "file", hash: blobHash(content) }));
}

/** What a first fetch asks about, for a vault and a remote, with no record unless given. */
function files(scenario: {
	remote?: Files | RemoteEntry[];
	local?: Files;
	records?: Files;
	gitignore?: string;
	configDir?: string;
}) {
	const { remote = {} } = scenario;
	return firstFetchFiles(
		planPull({
			remote: Array.isArray(remote) ? remote : remoteOf(remote),
			local: localOf(scenario.local ?? {}),
			records: recordsOf(scenario.records ?? {}),
			exclusion: createExclusion({
				configDir: ".obsidian",
				pluginDir: ownFolder,
				gitignore: scenario.gitignore ?? null,
			}),
			sizeLimit: 1000,
		}),
		scenario.configDir ?? ".obsidian",
	);
}

describe("the files a first fetch asks about", () => {
	test("only here, different, the same, and new on the remote", () => {
		const counted = files({
			remote: { "same.md": "S", "different.md": "theirs", "new.md": "N" },
			local: { "same.md": "S", "different.md": "mine", "only-here.md": "O", "notes/too.md": "T" },
		});
		expect(counted).toEqual({
			localOnly: ["notes/too.md", "only-here.md"],
			different: ["different.md"],
			differentSettings: [],
			atSymlinks: [],
		});
		expect(hasFirstFetchQuestion(counted, ".obsidian")).toBe(true);
	});

	test("an empty vault, and a vault that holds what the remote holds, have nothing to ask about", () => {
		const remote = { "a.md": "A", "b.md": "B" };
		const vaults: Files[] = [{}, { "a.md": "A" }, remote];
		for (const local of vaults) {
			const counted = files({ remote, local });
			expect(counted).toEqual({ localOnly: [], different: [], differentSettings: [], atSymlinks: [] });
			expect(hasFirstFetchQuestion(counted, ".obsidian")).toBe(false);
		}
	});

	test("files in the configuration folder alone are nothing to ask about, but are shown with others", () => {
		// What Obsidian writes into a vault it has just created.
		const config = { ".obsidian/app.json": "{}", ".obsidian/appearance.json": "{}" };
		const remote = { "a.md": "A", ".obsidian/app.json": '{"theirs":true}' };
		const fresh = files({ remote, local: config });
		// The one that differs is listed apart: no copy is kept of it.
		expect(fresh).toEqual({
			localOnly: [".obsidian/appearance.json"],
			different: [],
			differentSettings: [".obsidian/app.json"],
			atSymlinks: [],
		});
		expect(hasFirstFetchQuestion(fresh, ".obsidian")).toBe(false);
		expect(hasFirstFetchQuestion(fresh, "/.obsidian/")).toBe(false);
		// Another name for the folder: these are then files like any other.
		expect(hasFirstFetchQuestion(fresh, ".config")).toBe(true);

		const used = files({ remote, local: { ...config, "note.md": "N" } });
		expect(used.localOnly).toEqual([".obsidian/appearance.json", "note.md"]);
		expect(hasFirstFetchQuestion(used, ".obsidian")).toBe(true);
		// A folder that only begins like it is not it.
		const beside = files({ remote, local: { ".obsidian-old/app.json": "{}" } });
		expect(hasFirstFetchQuestion(beside, ".obsidian")).toBe(true);
	});

	test("files in the configuration folder that differ are listed apart, at any depth and of any kind", () => {
		const remote = {
			"a.md": "theirs",
			".obsidian/app.json": "theirs",
			".obsidian/themes/x/theme.css": "theirs",
			".obsidian/snippets/a.css": "theirs",
			".obsidian-old/app.json": "theirs",
			".obsidian/hotkeys/b.json": "theirs",
		};
		const local = {
			"a.md": "mine",
			".obsidian/app.json": "mine",
			".obsidian/themes/x/theme.css": "mine",
			".obsidian/snippets/a.css": "mine",
			".obsidian-old/app.json": "mine",
			// A file where the remote has a folder.
			".obsidian/hotkeys": "mine",
		};
		const counted = files({ remote, local });
		expect(counted).toEqual({
			localOnly: [],
			different: [".obsidian-old/app.json", "a.md"],
			differentSettings: [
				".obsidian/app.json",
				".obsidian/hotkeys",
				".obsidian/snippets/a.css",
				".obsidian/themes/x/theme.css",
			],
			atSymlinks: [],
		});
		// With another name for the folder, these are files like any other.
		const renamed = files({ remote, local, configDir: ".obsidian-old" });
		expect(renamed.differentSettings).toEqual([".obsidian-old/app.json"]);
		expect(renamed.different).toHaveLength(5);
	});

	test("a copy an earlier version kept of a file in the configuration folder is in no list, and is not sent", () => {
		const settingsCopy = ".obsidian/app.conflict-from-Mac-20260101-090000.json";
		const noteCopy = "a.conflict-from-Mac-20260101-090000.md";
		const remote = { "a.md": "A", ".obsidian/app.json": "{}" };
		const local = { ...remote, [settingsCopy]: "old", [noteCopy]: "old" };
		const counted = files({ remote, local });
		expect(counted).toEqual({ localOnly: [noteCopy], different: [], differentSettings: [], atSymlinks: [] });

		const plan = planPull({
			remote: remoteOf(remote),
			local: localOf(local),
			records: [],
			exclusion: createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore: null }),
			sizeLimit: 1000,
		});
		expect(plan.pushOnly.map((action) => action.key)).toEqual([noteCopy]);
	});

	test("an empty remote: every file is only here", () => {
		expect(files({ local: { "b.md": "B", "a.md": "A" } }).localOnly).toEqual(["a.md", "b.md"]);
	});

	test("a file at the path of a symlink is counted apart, and alone is nothing to ask about", () => {
		const counted = files({ remote: [link("link"), ...remoteOf({ "a.md": "A" })], local: { link: "a file" } });
		expect(counted).toEqual({ localOnly: [], different: [], differentSettings: [], atSymlinks: ["link"] });
		expect(hasFirstFetchQuestion(counted, ".obsidian")).toBe(false);
	});

	test("excluded paths are in no list", () => {
		const counted = files({
			remote: { "a.md": "A", [`${ownFolder}/main.js`]: "theirs" },
			local: {
				[`${ownFolder}/main.js`]: "mine",
				[`${ownFolder}/data.json`]: "{}",
				".git/config": "G",
				"drafts/secret.md": "D",
			},
			gitignore: "/drafts/\n",
		});
		expect(counted).toEqual({ localOnly: [], different: [], differentSettings: [], atSymlinks: [] });
	});

	test("a file that is too large is in no list: it is never read", () => {
		const big = "x".repeat(1001);
		expect(files({ remote: { "a.md": "A" }, local: { "big.bin": big } }).localOnly).toEqual([]);
	});

	test("a file where the remote has a folder is kept as a copy, and counted as different", () => {
		const counted = files({ remote: { "notes/a.md": "A" }, local: { notes: "a file named notes" } });
		expect(counted).toEqual({ localOnly: [], different: ["notes"], differentSettings: [], atSymlinks: [] });
	});

	test("a file the remote spells in another case is shown as the vault spells it", () => {
		const counted = files({ remote: { "Notes/A.md": "theirs" }, local: { "notes/a.md": "mine" } });
		expect(counted).toEqual({ localOnly: [], different: ["notes/a.md"], differentSettings: [], atSymlinks: [] });
	});

	test("a file whose name is taken in the folder it follows is kept as a copy: different, and not only here", () => {
		// A device that tells the cases apart, holding both `notes` and `Notes`.
		// The remote's spelling is `Notes`: the files of `notes` move there,
		// and `notes/b.md` finds a `Notes/b.md` in its place.
		const counted = files({
			remote: { "Notes/a.md": "theirs" },
			local: { "notes/a.md": "mine", "notes/b.md": "one", "notes/c.md": "C", "Notes/b.md": "other" },
		});
		expect(counted).toEqual({
			// `notes/c.md` moves to a name that is free, as it is.
			localOnly: ["Notes/b.md", "notes/c.md"],
			different: ["notes/a.md", "notes/b.md"],
			differentSettings: [],
			atSymlinks: [],
		});
	});

	test("with records: an edited file under the old spelling, where the vault has the remote content under the new one", () => {
		const counted = files({
			remote: { "Notes.md": "theirs" },
			records: { "notes.md": "old" },
			local: { "notes.md": "edited", "Notes.md": "theirs" },
		});
		expect(counted).toEqual({ localOnly: [], different: ["notes.md"], differentSettings: [], atSymlinks: [] });
	});

	test("with records: another file at the new spelling makes way for the renamed one", () => {
		const counted = files({
			remote: { "Notes.md": "theirs" },
			records: { "notes.md": "old" },
			local: { "notes.md": "old", "Notes.md": "something else" },
		});
		// The renamed file is unchanged since its record, and is written over.
		expect(counted).toEqual({ localOnly: [], different: ["Notes.md"], differentSettings: [], atSymlinks: [] });
	});

	test("with records: both of them, when the renamed file was edited too", () => {
		const counted = files({
			remote: { "Notes.md": "theirs" },
			records: { "notes.md": "old" },
			local: { "notes.md": "edited", "Notes.md": "something else" },
		});
		expect(counted).toEqual({ localOnly: [], different: ["Notes.md", "notes.md"], differentSettings: [], atSymlinks: [] });
	});

	test("with records, a first fetch that resumes: what it wrote is not counted, an edit of it is not only here", () => {
		const counted = files({
			remote: { "a.md": "A", "b.md": "B", "c.md": "C" },
			records: { "a.md": "A", "b.md": "B" },
			local: { "a.md": "A", "b.md": "edited", "mine.md": "M" },
		});
		expect(counted).toEqual({ localOnly: ["mine.md"], different: [], differentSettings: [], atSymlinks: [] });
	});
});

describe("remembering the answer", () => {
	test("nothing is confirmed until it is marked, and only `true` counts", async () => {
		const store = new MemoryStateStore();
		expect(await isFirstFetchConfirmed(store)).toBe(false);
		await store.setMeta(FIRST_FETCH_CONFIRMED_KEY, "yes");
		expect(await isFirstFetchConfirmed(store)).toBe(false);
		await markFirstFetchConfirmed(store);
		expect(await isFirstFetchConfirmed(store)).toBe(true);
	});
});
