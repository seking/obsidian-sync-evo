/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */


import { describe, expect, test } from "vitest";
import type { RemoteEntry } from "../src/core/backend";
import { createExclusion, defaultSectionLines } from "../src/core/exclusion";
import {
	applyExclusionEdit,
	editedGitignore,
	editorText,
	type ExclusionEdit,
	exclusionView,
	excludedOnRemoteCount,
	exclusionWriteText,
	folderToExclude,
	readExclusionScreen,
	saveGitignoreText,
	SHOWN_CONFIG_ITEMS,
	textFromEditor,
	unreadableGitignoreText,
} from "../src/core/exclusion-settings";
import { GITIGNORE_WRITE_KEY, type RootGitignore } from "../src/core/gitignore-file";
import {
	defaultSectionState,
	findSection,
	fixedExclusions,
	readSectionState,
	SECTION_END,
	SECTION_START,
	type SectionState,
	withSection,
} from "../src/core/gitignore-section";
import { translatorFor } from "../src/core/i18n/index";
import { writeNotices } from "../src/core/notices";
import { writeBaseRevision } from "../src/core/state";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };
const LIMIT = 1024 * 1024;
const t = translatorFor("en");

const textOf = (text: string): RootGitignore => ({ kind: "text", text, content: new TextEncoder().encode(text) });
const absent: RootGitignore = { kind: "absent" };

/** A file with these lines as its section, and `rest` after it. */
const withLines = (lines: readonly string[], rest = ""): string => withSection(rest, lines);
const defaults = (rest = ""): string => withLines(defaultSectionLines(paths), rest);

/** The state the section of a text reads as. */
function stateOf(text: string): SectionState {
	const found = findSection(text);
	if (found.kind !== "found") throw new Error(`no section: ${found.kind}`);
	return readSectionState(found.lines, paths);
}

function edited(text: string | null, edit: ExclusionEdit): string {
	const next = editedGitignore(text, edit, paths);
	if (next === null) throw new Error("the edit was not taken");
	return next;
}

describe("what the screen shows of a .gitignore", () => {
	test("a file that is not read: only why", () => {
		expect(exclusionView({ kind: "unreadable", reason: "not-downloaded" }, paths, LIMIT)).toEqual({
			kind: "unreadable",
			reason: "not-downloaded",
		});
	});

	test("no file: no section, the default lines count as there, and the section can be added", () => {
		expect(exclusionView(absent, paths, LIMIT)).toEqual({ kind: "none", text: null, fixedOff: [], addable: true });
	});

	test("a file without a section", () => {
		expect(exclusionView(textOf("*.log\n"), paths, LIMIT)).toEqual({
			kind: "none",
			text: "*.log\n",
			fixedOff: [],
			addable: true,
		});
	});

	test("without a section, only what a ! of the file undoes is off", () => {
		const view = exclusionView(textOf("!/.trash/\n"), paths, LIMIT);
		expect(view).toMatchObject({ kind: "none", fixedOff: ["/.trash/"] });
	});

	test("a file the section would take over the size limit cannot have it added", () => {
		const text = "*.log\n";
		const withSectionSize = new TextEncoder().encode(defaults(text)).length;
		expect(exclusionView(textOf(text), paths, withSectionSize)).toMatchObject({ kind: "none", addable: true });
		expect(exclusionView(textOf(text), paths, withSectionSize - 1)).toMatchObject({ kind: "none", addable: false });
	});

	test.each([
		["a start without an end", `${SECTION_START}\n*.png\n`],
		["two starts", `${SECTION_START}\n${SECTION_START}\n${SECTION_END}\n`],
		["an end before the start", `${SECTION_END}\n${SECTION_START}\n`],
	])("a broken section (%s): the text to put right, and no state", (_name, text) => {
		const view = exclusionView(textOf(text), paths, LIMIT);
		expect(view.kind).toBe("broken");
		expect(view).toMatchObject({ text });
		expect(view).not.toHaveProperty("state");
	});

	test("a broken section is judged by the file alone: every fixed exclusion it does not write is off", () => {
		const view = exclusionView(textOf(`${SECTION_START}\n/.trash/\n`), paths, LIMIT);
		const all = fixedExclusions(paths).map((fixed) => fixed.line);
		expect(view).toMatchObject({ kind: "broken", fixedOff: all.filter((line) => line !== "/.trash/") });
	});

	test("the default section: the default state, not edited by hand, nothing off", () => {
		expect(exclusionView(textOf(defaults("*.log\n")), paths, LIMIT)).toEqual({
			kind: "section",
			text: defaults("*.log\n"),
			state: defaultSectionState(paths),
			handEdited: false,
			fixedOff: [],
			restorable: false,
		});
	});

	test("an empty section reads as everything on, with every fixed exclusion off and restorable", () => {
		const view = exclusionView(textOf(withLines([])), paths, LIMIT);
		if (view.kind !== "section") throw new Error(view.kind);
		expect(Object.values(view.state.kinds)).toEqual([true, true, true, true, true]);
		expect(Object.values(view.state.config)).toEqual([true, true, true, true, true, true, true, true]);
		expect(view.handEdited).toBe(false);
		expect(view.fixedOff).toEqual(fixedExclusions(paths).map((fixed) => fixed.line));
		expect(view.restorable).toBe(true);
	});

	test("a section edited by hand says so", () => {
		// One of the two files of the main settings: read as off, and not what is written for off.
		const lines = [...defaultSectionLines(paths), "/.obsidian/app.json"];
		const view = exclusionView(textOf(withLines(lines)), paths, LIMIT);
		if (view.kind !== "section") throw new Error(view.kind);
		expect(view.handEdited).toBe(true);
		expect(view.state.config["main-settings"]).toBe(false);
	});

	test("a deleted line of a fixed exclusion is off, and can be restored", () => {
		const lines = defaultSectionLines(paths).filter((line) => line !== ".DS_Store");
		const view = exclusionView(textOf(withLines(lines)), paths, LIMIT);
		expect(view).toMatchObject({ kind: "section", fixedOff: [".DS_Store"], restorable: true, handEdited: false });
	});

	test("a line a ! outside the section undoes is off, and restoring would write nothing", () => {
		const view = exclusionView(textOf(defaults("!.DS_Store\n")), paths, LIMIT);
		expect(view).toMatchObject({ kind: "section", fixedOff: [".DS_Store"], restorable: false });
	});

	test("a deleted line that another rule of the file stands in for is not off", () => {
		const lines = defaultSectionLines(paths).filter((line) => line !== ".DS_Store");
		const view = exclusionView(textOf(withLines(lines, "**/.DS_Store\n")), paths, LIMIT);
		expect(view).toMatchObject({ kind: "section", fixedOff: [], restorable: false });
	});

	test("the switches are listed in the order of the requirements, each once", () => {
		expect(SHOWN_CONFIG_ITEMS).toEqual(Object.keys(defaultSectionState(paths).config));
		expect(SHOWN_CONFIG_ITEMS).toHaveLength(8);
	});
});

describe("changing one thing in the section", () => {
	const rest = "\n# mine\n*.log\n!keep.log\n";

	test("the lines of the kinds an earlier version wrote are taken out, with the ! line, and nothing outside it changed", () => {
		const lines = ["*.pdf", "*.png", "!/.obsidian/**", ...defaultSectionLines(paths)];
		const before = withLines(lines, rest);
		const after = edited(before, { kind: "drop-kinds" });
		expect(after).toBe(defaults(rest));
		expect(stateOf(after).kinds).toEqual(defaultSectionState(paths).kinds);
	});

	test("taking out the kinds of a section that has none changes nothing", () => {
		expect(edited(defaults(rest), { kind: "drop-kinds" })).toBe(defaults(rest));
	});

	test("any other change keeps the lines of the kinds an earlier version wrote", () => {
		// Another device may not have copied them to its own exclusion yet.
		const lines = ["*.pdf", "!/.obsidian/**", ...defaultSectionLines(paths)];
		const after = edited(withLines(lines), { kind: "add-folder", folder: "drafts" });
		expect(stateOf(after).kinds.pdf).toBe(false);
		expect(after.startsWith(`${SECTION_START}\n*.pdf\n!/.obsidian/**\n/drafts/\n`)).toBe(true);
		const flipped = edited(withLines(lines), { kind: "config-item", item: "hotkeys", synced: false });
		expect(stateOf(flipped).kinds.pdf).toBe(false);
		const restored = edited(withLines(["*.pdf", "!/.obsidian/**"]), { kind: "restore-fixed" });
		expect(stateOf(restored).kinds.pdf).toBe(false);
	});

	test.each(SHOWN_CONFIG_ITEMS)("the switch for %s changes that part alone, either way", (item) => {
		const start = defaultSectionState(paths);
		const flipped = edited(defaults(), { kind: "config-item", item, synced: !start.config[item] });
		expect(stateOf(flipped)).toEqual({ ...start, config: { ...start.config, [item]: !start.config[item] } });
		expect(stateOf(edited(flipped, { kind: "config-item", item, synced: start.config[item] }))).toEqual(start);
	});

	test("the change is made in the file as it is handed in, not in a state from before", () => {
		// The file was changed on another device since the screen was drawn:
		// the hotkeys are off there. Switching the appearance off keeps that.
		const pulled = edited(defaults(), { kind: "config-item", item: "hotkeys", synced: false });
		const after = edited(pulled, { kind: "config-item", item: "appearance", synced: false });
		expect(stateOf(after).config).toMatchObject({ hotkeys: false, appearance: false });
	});

	test("a folder is added as a line from the root, escaped, after the ones before it", () => {
		const one = edited(defaults(), { kind: "add-folder", folder: "drafts" });
		const two = edited(one, { kind: "add-folder", folder: "notes/[old] *" });
		expect(two).toContain("\n/drafts/\n/notes/\\[old\\] \\*/\n");
		expect(stateOf(two).folders).toEqual(["drafts", "notes/[old] *"]);
	});

	test("a folder that is listed is not added twice", () => {
		const one = edited(defaults(), { kind: "add-folder", folder: "drafts" });
		expect(edited(one, { kind: "add-folder", folder: "drafts" })).toBe(one);
	});

	test("a folder is removed, and the others stay", () => {
		const two = edited(edited(defaults(), { kind: "add-folder", folder: "a" }), { kind: "add-folder", folder: "b" });
		expect(stateOf(edited(two, { kind: "remove-folder", folder: "a" })).folders).toEqual(["b"]);
	});

	test("a switch does not bring back a line of a fixed exclusion the user deleted", () => {
		const lines = defaultSectionLines(paths).filter((line) => line !== ".DS_Store");
		const after = edited(withLines(lines), { kind: "config-item", item: "hotkeys", synced: false });
		expect(after.split("\n")).not.toContain(".DS_Store");
	});

	test("restoring brings back every line of a fixed exclusion, and changes no switch", () => {
		const lines = ["*.pdf", "!/.obsidian/**", "/drafts/", "/.trash/"];
		const after = edited(withLines(lines), { kind: "restore-fixed" });
		const state = stateOf(after);
		expect(state.fixed).toEqual(fixedExclusions(paths).map((fixed) => fixed.line));
		expect(state.kinds.pdf).toBe(false);
		expect(state.folders).toEqual(["drafts"]);
		expect(exclusionView(textOf(after), paths, LIMIT)).toMatchObject({ fixedOff: [], restorable: false });
	});

	test("restoring does not help a line a ! outside the section undoes", () => {
		const after = edited(withLines([], "!.DS_Store\n"), { kind: "restore-fixed" });
		expect(exclusionView(textOf(after), paths, LIMIT)).toMatchObject({ fixedOff: [".DS_Store"], restorable: false });
	});

	test("a line the section does not know is kept by a switch, comments too", () => {
		const lines = [...defaultSectionLines(paths), "# from a later version", "*.future"];
		const after = edited(withLines(lines), { kind: "config-item", item: "hotkeys", synced: false });
		expect(stateOf(after).unknown).toEqual(["# from a later version", "*.future"]);
	});

	test("a section edited by hand is rewritten in the one form by the next switch", () => {
		const lines = [...defaultSectionLines(paths), "/.obsidian/app.json"];
		const after = edited(withLines(lines), { kind: "config-item", item: "hotkeys", synced: false });
		expect(exclusionView(textOf(after), paths, LIMIT)).toMatchObject({ kind: "section", handEdited: false });
		// Read as off before, and still off: nothing more is synced than was.
		expect(stateOf(after).config["main-settings"]).toBe(false);
	});

	test("the line ends and the byte order mark of the file are kept", () => {
		const before = `﻿${SECTION_START}\r\n${SECTION_END}\r\n*.log\r\n`;
		const after = edited(before, { kind: "add-folder", folder: "drafts" });
		expect(after).toBe(`﻿${SECTION_START}\r\n/drafts/\r\n${SECTION_END}\r\n*.log\r\n`);
	});

	test("the section is added to a file without one, and to no file at all", () => {
		expect(edited("*.log\n", { kind: "add-section" })).toBe(defaults("*.log\n"));
		expect(edited(null, { kind: "add-section" })).toBe(defaults());
	});

	test("a file that has a section, or a broken one, is not given another", () => {
		expect(editedGitignore(withLines([]), { kind: "add-section" }, paths)).toBeNull();
		expect(editedGitignore(`${SECTION_START}\n`, { kind: "add-section" }, paths)).toBeNull();
	});

	test.each<ExclusionEdit>([
		{ kind: "drop-kinds" },
		{ kind: "config-item", item: "hotkeys", synced: false },
		{ kind: "add-folder", folder: "drafts" },
		{ kind: "remove-folder", folder: "drafts" },
		{ kind: "restore-fixed" },
	])("without a section, or with a broken one, there is nothing to switch: %j", (edit) => {
		expect(editedGitignore(null, edit, paths)).toBeNull();
		expect(editedGitignore("*.log\n", edit, paths)).toBeNull();
		expect(editedGitignore(`${SECTION_START}\n*.png\n`, edit, paths)).toBeNull();
	});
});

describe("the folder typed into the field", () => {
	test.each([
		["drafts", "drafts"],
		["  drafts  ", "drafts"],
		["/drafts/", "drafts"],
		["notes/old drafts/", "notes/old drafts"],
		[".obsidian/plugins", ".obsidian/plugins"],
	])("%j is %j", (typed, folder) => {
		expect(folderToExclude(typed)).toBe(folder);
	});

	test.each(["", "   ", "/", "a//b", "../up", "a/./b", "a\nb"])("%j names no folder", (typed) => {
		expect(folderToExclude(typed)).toBeNull();
	});
});

describe("the text of the editing field", () => {
	test("the field gets no byte order mark and one kind of line end", () => {
		expect(editorText("﻿a\r\nb\r\n")).toBe("a\nb\n");
		expect(editorText(null)).toBe("");
	});

	test("a field that was not edited gives the file back to the byte", () => {
		const mixed = "﻿a\r\nb\nc\r\n";
		expect(textFromEditor(editorText(mixed), mixed)).toBe(mixed);
		expect(textFromEditor("", null)).toBe("");
	});

	test("an edited field is saved with the mark and the line end the file had", () => {
		expect(textFromEditor("a\nb\nc\n", "﻿a\r\nb\r\n")).toBe("﻿a\r\nb\r\nc\r\n");
		expect(textFromEditor("a\nc\n", "a\nb\n")).toBe("a\nc\n");
		expect(textFromEditor("*.log\n", null)).toBe("*.log\n");
	});

	test("a field that was emptied is an empty file, without the mark the file had", () => {
		expect(textFromEditor("", "\uFEFFa\r\nb\r\n")).toBe("");
		expect(textFromEditor("", "a\n")).toBe("");
	});
});

function setup() {
	const vault = new MemoryPullVault({ caseSensitive: false, now: () => 1_000 });
	const store = new MemoryStateStore();
	return { vault, store, deps: { vault, store, paths, sizeLimit: LIMIT } };
}

const file = (path: string): RemoteEntry => ({ path, kind: "file", hash: "0".repeat(40) });

describe("a change of the screen, made in the file", () => {
	test("the file is read again and the change made in what it holds now", async () => {
		const { vault, deps } = setup();
		// What the screen was drawn from is not handed in at all. The file
		// has the hotkeys off, as a pull just wrote it.
		vault.put(".gitignore", edited(defaults("*.log\n"), { kind: "config-item", item: "hotkeys", synced: false }));

		expect((await applyExclusionEdit(deps, { kind: "config-item", item: "appearance", synced: false })).write).toBe("written");
		const text = vault.text(".gitignore") ?? "";
		expect(stateOf(text).config).toMatchObject({ hotkeys: false, appearance: false });
		expect(text.endsWith(`${SECTION_END}\n*.log\n`)).toBe(true);
	});

	test("nothing of the write stays remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", defaults());
		await applyExclusionEdit(deps, { kind: "config-item", item: "hotkeys", synced: false });
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("the section is added to a vault without a .gitignore", async () => {
		const { vault, deps } = setup();
		expect((await applyExclusionEdit(deps, { kind: "add-section" })).write).toBe("written");
		expect(vault.text(".gitignore")).toBe(defaults());
	});

	test("a switch on a file whose section is gone by now writes nothing", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.log\n");
		expect((await applyExclusionEdit(deps, { kind: "config-item", item: "hotkeys", synced: false })).write).toBe("changed");
		expect(vault.text(".gitignore")).toBe("*.log\n");
	});

	test("adding the section to a file a sync gave one meanwhile writes nothing", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		expect((await applyExclusionEdit(deps, { kind: "add-section" })).write).toBe("changed");
		expect(vault.text(".gitignore")).toBe(defaults());
	});

	test("a change that changes nothing writes nothing", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		expect((await applyExclusionEdit(deps, { kind: "restore-fixed" })).write).toBe("unchanged");
		expect(vault.log.filter((op) => op.startsWith("write"))).toEqual([]);
	});

	test("a file that is not read is not written", async () => {
		const { vault, deps } = setup();
		vault.put(".GITIGNORE", defaults());
		expect((await applyExclusionEdit(deps, { kind: "restore-fixed" })).write).toBe("unreadable");
	});

	test("a change that would take the file over the size limit is not made", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		const sizeLimit = new TextEncoder().encode(defaults()).length;
		const edit: ExclusionEdit = { kind: "add-folder", folder: "drafts" };
		expect((await applyExclusionEdit({ ...deps, sizeLimit }, edit)).write).toBe("over-limit");
		expect(vault.text(".gitignore")).toBe(defaults());
	});

	test("an edit that lands between the read and the write is not written over", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		let reads = 0;
		vault.before = (op, path) => {
			// The first read is the one the change is made from.
			if (op === "read" && path === ".gitignore" && ++reads === 2) vault.put(".gitignore", defaults("mine\n"));
		};
		expect((await applyExclusionEdit(deps, { kind: "config-item", item: "hotkeys", synced: false })).write).toBe("changed");
		expect(vault.text(".gitignore")).toBe(defaults("mine\n"));
	});

	test("a vault that refuses the write leaves the file, and nothing remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", defaults());
		vault.before = (op) => {
			if (op === "write") throw new Error("read-only");
		};
		expect((await applyExclusionEdit(deps, { kind: "config-item", item: "hotkeys", synced: false })).write).toBe("refused");
		expect(vault.text(".gitignore")).toBe(defaults());
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("a write from before that stopped half way is finished first, and the change made in the whole file", async () => {
		const { vault, store, deps } = setup();
		const writing = defaults("*.log\n");
		vault.put(".gitignore", writing.slice(0, 40));
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: "*.log\n", writing });

		expect((await applyExclusionEdit(deps, { kind: "config-item", item: "hotkeys", synced: false })).write).toBe("written");
		expect(vault.text(".gitignore")).toBe(edited(writing, { kind: "config-item", item: "hotkeys", synced: false }));
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("a write from before that cannot be settled stops the change, and stays remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put("..gitignore.icloud", "");
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: null, writing: defaults() });
		expect((await applyExclusionEdit(deps, { kind: "add-section" })).write).toBe("unsettled");
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual({ before: null, writing: defaults() });
	});
});

describe("taking the kinds an earlier version wrote out of the section, for a switch of this device", () => {
	test("the lines go, the rest of the file stays, and nothing is asked of the remote", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", withLines(["*.png", "*.mp4", "!/.obsidian/**", ...defaultSectionLines(paths)], "*.log\n"));
		store.getListing = async () => {
			throw new Error("not asked");
		};
		expect(await applyExclusionEdit(deps, { kind: "drop-kinds" })).toEqual({ write: "written" });
		expect(vault.text(".gitignore")).toBe(defaults("*.log\n"));
	});

	test("a section without them is not written", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		expect(await applyExclusionEdit(deps, { kind: "drop-kinds" })).toEqual({ write: "unchanged" });
		expect(vault.log.filter((op) => op.startsWith("write"))).toEqual([]);
	});
});

describe("what this device no longer syncs since what an exclusion does was changed", () => {
	const head = "r1";
	async function listed(entries: RemoteEntry[], text: string | null, base: string | null = head) {
		const { vault, store, deps } = setup();
		if (text !== null) vault.put(".gitignore", text);
		await store.putListing({ revision: head, entries });
		if (base !== null) await writeBaseRevision(store, base);
		return { vault, store, deps };
	}

	test("the files of the remote the rules exclude, and the kinds this device leaves out, not its own folder", async () => {
		const entries = [
			file("notes/a.md"),
			file("notes/photo.png"),
			file(".obsidian/plugins/other/main.js"),
			file(".obsidian/plugins/other/data.json"),
			file(".obsidian/plugins/sync-evo/main.js"),
			file(".obsidian/workspace.json"),
			file("drafts/b.md"),
		];
		const { deps } = await listed(entries, defaults());
		expect(await excludedOnRemoteCount(deps, [])).toBe(3);
		expect(await excludedOnRemoteCount(deps, ["image"])).toBe(4);
		const folder = await listed(entries, withLines([...defaultSectionLines(paths), "/drafts/"]));
		expect(await excludedOnRemoteCount(folder.deps, [])).toBe(4);
	});

	test("without a .gitignore, by the lines of the default section", async () => {
		const { deps } = await listed([file("notes/a.md"), file(".obsidian/workspace.json")], null);
		expect(await excludedOnRemoteCount(deps, [])).toBe(1);
	});

	test("none to tell: nothing excluded is on the remote", async () => {
		const { deps } = await listed([file("notes/a.md")], defaults());
		expect(await excludedOnRemoteCount(deps, ["image"])).toBe(0);
	});

	test("not yet: no listing, a remote without commits, a pull that has not got to the head, or a .gitignore that cannot be read", async () => {
		const none = setup();
		expect(await excludedOnRemoteCount(none.deps, [])).toBeNull();
		const empty = setup();
		await empty.store.putListing({ revision: null, entries: [] });
		expect(await excludedOnRemoteCount(empty.deps, [])).toBeNull();
		const behind = await listed([file(".obsidian/workspace.json")], defaults(), "r0");
		expect(await excludedOnRemoteCount(behind.deps, [])).toBeNull();
		const unread = await listed([file(".obsidian/workspace.json")], null);
		unread.vault.put(".GITIGNORE", defaults());
		expect(await excludedOnRemoteCount(unread.deps, [])).toBeNull();
	});
});

describe("saving the whole file from the editing field", () => {
	test("the text is written when the file is still the one the field was filled from", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.log\n");
		expect((await saveGitignoreText(deps, "*.log\n*.tmp\n", "*.log\n")).write).toBe("written");
		expect(vault.text(".gitignore")).toBe("*.log\n*.tmp\n");
	});

	test("a file that changed since the field was filled is not written over", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.log\n*.bak\n");
		expect((await saveGitignoreText(deps, "*.log\n*.tmp\n", "*.log\n")).write).toBe("changed");
		expect(vault.text(".gitignore")).toBe("*.log\n*.bak\n");
	});

	test("a file that appeared where there was none is not written over, and one that is gone is not made again", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.bak\n");
		expect((await saveGitignoreText(deps, "*.tmp\n", null)).write).toBe("changed");
		vault.remove(".gitignore");
		expect((await saveGitignoreText(deps, "*.tmp\n", "*.bak\n")).write).toBe("changed");
		expect(vault.text(".gitignore")).toBeUndefined();
	});

	test("a file is made where there was none", async () => {
		const { vault, deps } = setup();
		expect((await saveGitignoreText(deps, "*.tmp\n", null)).write).toBe("written");
		expect(vault.text(".gitignore")).toBe("*.tmp\n");
	});

	test("the same text, or nothing where there is no file, writes nothing", async () => {
		const { vault, deps } = setup();
		expect((await saveGitignoreText(deps, "", null)).write).toBe("unchanged");
		expect(vault.text(".gitignore")).toBeUndefined();
		vault.put(".gitignore", "*.log\n");
		expect((await saveGitignoreText(deps, "*.log\n", "*.log\n")).write).toBe("unchanged");
	});

	test("a text over the size limit is not saved", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "a\n");
		expect((await saveGitignoreText({ ...deps, sizeLimit: 4 }, "abcde", "a\n")).write).toBe("over-limit");
		expect(vault.text(".gitignore")).toBe("a\n");
	});

	test("the section may be broken, or deleted: the file is the user's to write", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		expect((await saveGitignoreText(deps, `${SECTION_START}\n*.png\n`, defaults())).write).toBe("written");
		expect(vault.text(".gitignore")).toBe(`${SECTION_START}\n*.png\n`);
	});
});

describe("reading everything the screen shows", () => {
	test("the view of the file, and nothing counted without a listing of the remote", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		const screen = await readExclusionScreen(deps, { settle: true });
		expect(screen.view).toMatchObject({ kind: "section", handEdited: false });
		expect(screen.tracked).toBeNull();
		expect(screen.notices).toEqual([]);
		expect(screen.addSection).toBeNull();
	});

	test("without a section and without a listing of the remote, the section is not offered: sync first", async () => {
		const { vault, deps } = setup();
		expect((await readExclusionScreen(deps, { settle: true })).addSection).toBe("sync-first");
		vault.put(".gitignore", "*.log\n");
		expect((await readExclusionScreen(deps, { settle: true })).addSection).toBe("sync-first");
	});

	test("once the remote was listed, the section is offered, also for a remote without commits", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "*.log\n");
		await store.putListing({ revision: null, entries: [] });
		expect((await readExclusionScreen(deps, { settle: true })).addSection).toBe("offer");
	});

	test("a file the section would take over the size limit is not offered it, and before a first pull it is still: sync first", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "*.log\n");
		const small = { ...deps, sizeLimit: 20 };
		expect((await readExclusionScreen(small, { settle: true })).addSection).toBe("sync-first");
		await store.putListing({ revision: "abc", entries: [] });
		expect((await readExclusionScreen(small, { settle: true })).addSection).toBe("over-limit");
	});

	test("a file with a section, or a broken one, has no section to offer", async () => {
		const { vault, store, deps } = setup();
		await store.putListing({ revision: "abc", entries: [] });
		vault.put(".gitignore", defaults());
		expect((await readExclusionScreen(deps, { settle: true })).addSection).toBeNull();
		vault.put(".gitignore", `${SECTION_START}\n`);
		expect((await readExclusionScreen(deps, { settle: true })).addSection).toBeNull();
	});

	test("the files of the last listing that a rule matches now are counted", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", withLines([...defaultSectionLines(paths), "/drafts/"], "*.log\n"));
		await store.putListing({
			revision: "abc",
			entries: [file("notes/a.md"), file("drafts/b.md"), file("debug.log"), file(".obsidian/workspace.json")],
		});
		expect((await readExclusionScreen(deps, { settle: true })).tracked).toBe(3);
	});

	test("without a section the default lines count for it too", async () => {
		const { store, deps } = setup();
		await store.putListing({ revision: "abc", entries: [file("notes/a.md"), file(".obsidian/workspace.json")] });
		const screen = await readExclusionScreen(deps, { settle: true });
		expect(screen.view.kind).toBe("none");
		expect(screen.tracked).toBe(1);
	});

	test("of the remembered notices, the ones about the vault are listed, and not the fixed exclusions", async () => {
		const { store, deps } = setup();
		await writeNotices(store, [
			{ kind: "fixed-exclusion-off", path: "/.trash/" },
			{ kind: "nested-gitignore", path: "notes/.gitignore" },
			{ kind: "too-large", path: "big.bin" },
			{ kind: "git-at-root", path: ".git" },
			{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" },
			{ kind: "submodule", path: "knowledge" },
			{ kind: "local-link", path: "Projects" },
		]);
		expect((await readExclusionScreen(deps, { settle: true })).notices).toEqual([
			{ kind: "nested-gitignore", path: "notes/.gitignore" },
			{ kind: "git-at-root", path: ".git" },
			{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" },
			{ kind: "submodule", path: "knowledge" },
			{ kind: "local-link", path: "Projects" },
		]);
	});

	test("a file that is not read: why, nothing counted, and the notices all the same", async () => {
		const { vault, store, deps } = setup();
		vault.makeFolder(".gitignore");
		await store.putListing({ revision: "abc", entries: [file("debug.log")] });
		await writeNotices(store, [{ kind: "git-at-root", path: ".git" }]);
		expect(await readExclusionScreen(deps, { settle: true })).toEqual({
			view: { kind: "unreadable", reason: "not-a-file" },
			tracked: null,
			untrack: null,
			notices: [{ kind: "git-at-root", path: ".git" }],
			addSection: null,
		});
	});

	test("what can be untracked is listed with the count: links and Sync Evo's own folder marked, submodules apart", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", withLines([...defaultSectionLines(paths), "/drafts/", "/knowledge/"]));
		await store.putListing({
			revision: "abc",
			entries: [
				file("notes/a.md"),
				file("drafts/b.md"),
				{ ...file("drafts/a-link"), kind: "symlink" },
				file(".obsidian/plugins/sync-evo/main.js"),
				{ ...file("knowledge"), kind: "submodule" },
				{ ...file("lib"), kind: "submodule" },
			],
		});
		const screen = await readExclusionScreen(deps, { settle: true });
		expect(screen.tracked).toBe(3);
		expect(screen.untrack).toEqual({
			files: [
				{ path: ".obsidian/plugins/sync-evo/main.js", symlink: false, ownFolder: true },
				{ path: "drafts/a-link", symlink: true, ownFolder: false },
				{ path: "drafts/b.md", symlink: false, ownFolder: false },
			],
			submodules: ["knowledge"],
		});
	});

	test("nothing can be untracked without a section, with a broken one, or without a listing, whatever is counted", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", defaults());
		expect((await readExclusionScreen(deps, { settle: true })).untrack).toBeNull();

		await store.putListing({ revision: "abc", entries: [file("notes/a.md"), file(".obsidian/workspace.json")] });
		expect((await readExclusionScreen(deps, { settle: true })).untrack).toEqual({
			files: [{ path: ".obsidian/workspace.json", symlink: false, ownFolder: false }],
			submodules: [],
		});

		// The default lines are applied as if they were there, and are not on the remote.
		vault.put(".gitignore", "*.log\n");
		expect(await readExclusionScreen(deps, { settle: true })).toMatchObject({ tracked: 1, untrack: null });
		vault.remove(".gitignore");
		expect(await readExclusionScreen(deps, { settle: true })).toMatchObject({ tracked: 1, untrack: null });
		vault.put(".gitignore", `${SECTION_START}\n/.obsidian/workspace.json\n`);
		expect(await readExclusionScreen(deps, { settle: true })).toMatchObject({
			view: { kind: "broken" },
			tracked: 1,
			untrack: null,
		});
	});

	test("with settling, a write that stopped half way is finished before the file is shown", async () => {
		const { vault, store, deps } = setup();
		const writing = defaults("*.log\n");
		vault.put(".gitignore", writing.slice(0, 40));
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: "*.log\n", writing });

		const screen = await readExclusionScreen(deps, { settle: true });
		expect(screen.view).toMatchObject({ kind: "section", text: writing });
		expect(vault.text(".gitignore")).toBe(writing);
	});

	test("without settling (a sync is running), nothing is written, and half a file is not shown", async () => {
		const { vault, store, deps } = setup();
		const writing = defaults("*.log\n");
		vault.put(".gitignore", writing.slice(0, 40));
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: "*.log\n", writing });

		const screen = await readExclusionScreen(deps, { settle: false });
		expect(screen.view).toEqual({ kind: "unsettled" });
		expect(vault.text(".gitignore")).toBe(writing.slice(0, 40));
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual({ before: "*.log\n", writing });
		expect(vault.log).toEqual([]);
	});

	test("without settling and with nothing remembered, the file is shown", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", defaults());
		expect((await readExclusionScreen(deps, { settle: false })).view.kind).toBe("section");
	});

	test("a write that cannot be settled: the file is not shown", async () => {
		const { vault, store, deps } = setup();
		vault.put("..gitignore.icloud", "");
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: null, writing: defaults() });
		expect((await readExclusionScreen(deps, { settle: true })).view).toEqual({ kind: "unsettled" });
	});
});

describe("the words for what went wrong", () => {
	test("a write that wrote, or had nothing to write, has nothing to tell", () => {
		expect(exclusionWriteText(t, "written", LIMIT)).toBeNull();
		expect(exclusionWriteText(t, "unchanged", LIMIT)).toBeNull();
	});

	test.each(["changed", "refused", "unsettled", "over-limit", "unreadable"] as const)("%s has a text of its own", (write) => {
		const text = exclusionWriteText(t, write, 38 * 1024 * 1024);
		expect(text).toMatch(/\.gitignore/);
		const others = (["changed", "refused", "unsettled", "over-limit", "unreadable"] as const).filter((other) => other !== write);
		for (const other of others) expect(exclusionWriteText(t, other, 38 * 1024 * 1024)).not.toBe(text);
	});

	test("the size limit is named in megabytes", () => {
		expect(exclusionWriteText(t, "over-limit", 38 * 1024 * 1024)).toContain("38 MB");
		expect(unreadableGitignoreText(t, "too-large", 38 * 1024 * 1024)).toContain("38 MB");
	});

	test("every reason a file is not read has a text of its own", () => {
		const reasons = ["not-a-file", "too-large", "not-downloaded", "respelled", "read-failed", "not-text"] as const;
		const texts = reasons.map((reason) => unreadableGitignoreText(t, reason, LIMIT));
		expect(new Set(texts).size).toBe(reasons.length);
	});
});
