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
import { en } from "../src/core/i18n/en";
import { translatorFor } from "../src/core/i18n/index";
import { NOTICES_KEY, type NoticeRef, readNotices, reconcileNotices, writeNotices } from "../src/core/notices";
import { MemoryStateStore } from "./support/memory-state-store";

const ownFolder: NoticeRef = { kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" };
const git: NoticeRef = { kind: "git-at-root", path: ".git" };

describe("what to show and what to remember", () => {
	test("something that applies for the first time is shown and remembered", () => {
		expect(reconcileNotices([], [git])).toEqual({ show: [git], remember: [git] });
	});

	test("something that was remembered and still applies is not shown again", () => {
		expect(reconcileNotices([git], [git])).toEqual({ show: [], remember: [git] });
	});

	test("something that no longer applies is forgotten", () => {
		expect(reconcileNotices([git, ownFolder], [ownFolder])).toEqual({ show: [], remember: [ownFolder] });
	});

	test("something that went away and came back is shown again", () => {
		const gone = reconcileNotices([git], []);
		expect(gone).toEqual({ show: [], remember: [] });
		expect(reconcileNotices(gone.remember, [git]).show).toEqual([git]);
	});

	test("the kind and the path are remembered as a pair", () => {
		const elsewhere: NoticeRef = { kind: "own-folder-on-remote", path: ".config/plugins/sync-evo" };
		const sameKind = reconcileNotices([ownFolder], [ownFolder, elsewhere]);
		expect(sameKind.show).toEqual([elsewhere]);
		const samePath: NoticeRef = { kind: "own-folder-on-remote", path: ".git" };
		expect(reconcileNotices([git], [git, samePath]).show).toEqual([samePath]);
	});

	test("the same pair given twice counts once", () => {
		expect(reconcileNotices([], [git, { ...git }])).toEqual({ show: [git], remember: [git] });
	});
});

describe("in the sync state", () => {
	test("nothing is remembered at first", async () => {
		expect(await readNotices(new MemoryStateStore())).toEqual([]);
	});

	test("what was written is read back", async () => {
		const store = new MemoryStateStore();
		await writeNotices(store, [git, ownFolder]);
		expect(await readNotices(store)).toEqual([git, ownFolder]);
	});

	test("only the kind and the path are stored", async () => {
		const store = new MemoryStateStore();
		await writeNotices(store, [{ ...git, extra: 1 } as NoticeRef]);
		expect(await store.getMeta(NOTICES_KEY)).toEqual([git]);
	});

	test.each([null, "notices", 5, { kind: "git-at-root", path: ".git" }])(
		"%j, which is not a list, reads as nothing remembered",
		async (stored) => {
			const store = new MemoryStateStore();
			await store.setMeta(NOTICES_KEY, stored);
			expect(await readNotices(store)).toEqual([]);
		},
	);

	test("an item that is not a pair of a known kind and a path is left out", async () => {
		const store = new MemoryStateStore();
		await store.setMeta(NOTICES_KEY, [
			git,
			null,
			"git-at-root",
			{ kind: "from-a-newer-version", path: "a" },
			{ kind: "git-at-root" },
			{ kind: "git-at-root", path: 5 },
			ownFolder,
		]);
		expect(await readNotices(store)).toEqual([git, ownFolder]);
	});

	test("a sync that finds the same thing twice tells the user once", async () => {
		const store = new MemoryStateStore();
		const shown: NoticeRef[] = [];
		for (let sync = 0; sync < 2; sync++) {
			const update = reconcileNotices(await readNotices(store), [git]);
			shown.push(...update.show);
			await writeNotices(store, update.remember);
		}
		expect(shown).toEqual([git]);
	});
});

describe("the texts", () => {
	test.each(["en", "ja"])("in %s, the notice about the plugin's own folder names the folder", (language) => {
		const text = translatorFor(language)("notice.ownFolderOnRemote", { path: ownFolder.path });
		expect(text).toContain(ownFolder.path);
		expect(text).not.toContain("{");
	});

	test.each(["en", "ja"])("in %s, the notice about .git points to git and to Obsidian Git", (language) => {
		const text = translatorFor(language)("notice.gitAtRoot");
		expect(text).toContain("git");
		expect(text).toContain("Obsidian Git");
	});

	test("Japanese has a text of its own for both", () => {
		expect(translatorFor("ja")("notice.gitAtRoot")).not.toBe(en["notice.gitAtRoot"]);
		expect(translatorFor("ja")("notice.ownFolderOnRemote", { path: "x" })).not.toBe(
			translatorFor("en")("notice.ownFolderOnRemote", { path: "x" }),
		);
	});
});
