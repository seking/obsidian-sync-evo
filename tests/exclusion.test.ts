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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { conflictCopyPath } from "../src/core/conflict-name";
import {
	createExclusion,
	defaultSectionLines,
	type Exclusion,
	fixedExclusionsOff,
	isInConfigDir,
	type KnownPaths,
	knownPaths,
	nestedGitignores,
	unsyncedSubmodules,
	type PathType,
	remoteFilesMatchingRules,
	untrackableByAddedLines,
	untrackableFiles,
} from "../src/core/exclusion";
import {
	defaultSectionState,
	findSection,
	readSectionState,
	SECTION_END,
	SECTION_START,
	type SectionState,
	sectionLines,
	withFixedExclusions,
	withSection,
} from "../src/core/gitignore-section";
import { earlierCopyPath } from "./support/earlier-copy-name";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** Every path is on the remote. */
const known: KnownPaths = { has: () => true, onRemote: () => true, copyOnRemote: () => true };
/** Nothing is on the remote and nothing has a record. */
const unknown = knownPaths([], []);

const entryAt = (path: string): { path: string } => ({ path });

function exclusionFor(gitignore: string | null): Exclusion {
	return createExclusion({ ...paths, gitignore });
}

describe("the lines of the default section", () => {
	test("for the usual folders they are the list of the requirements", () => {
		expect(defaultSectionLines(paths)).toEqual([
			"/.obsidian/community-plugins.json",
			"/.obsidian/plugins/",
			"/.obsidian/workspace.json",
			"/.obsidian/workspace-mobile.json",
			"/.obsidian/plugins/sync-evo/",
			"/.trash/",
			".DS_Store",
			"._*",
			"Thumbs.db",
			"ehthumbs.db",
			"desktop.ini",
			"$RECYCLE.BIN/",
			"*.icloud",
		]);
	});

	test("they follow the name of the configuration folder and the folder of the plugin", () => {
		const lines = defaultSectionLines({ configDir: ".config", pluginDir: ".config/plugins/sync-evo-beta" });
		expect(lines.slice(0, 5)).toEqual([
			"/.config/community-plugins.json",
			"/.config/plugins/",
			"/.config/workspace.json",
			"/.config/workspace-mobile.json",
			"/.config/plugins/sync-evo-beta/",
		]);
	});

	test("characters that mean something in .gitignore get a backslash", () => {
		const odd = { configDir: ".conf[1]*", pluginDir: ".conf[1]*/plugins/sync?evo\\x" };
		const lines = defaultSectionLines(odd);
		expect(lines[1]).toBe("/.conf\\[1\\]\\*/plugins/");
		expect(lines[4]).toBe("/.conf\\[1\\]\\*/plugins/sync\\?evo\\\\x/");

		// And the lines then match those very names, and not what the
		// characters would otherwise stand for.
		const exclusion = createExclusion({ ...odd, gitignore: null });
		expect(exclusion.matchesRule(".conf[1]*/workspace.json", "file")).toBe(true);
		expect(exclusion.matchesRule(".conf1x/workspace.json", "file")).toBe(false);
		expect(exclusion.matchesRule(".conf[1]*/plugins", "folder")).toBe(true);
	});
});

describe("a vault whose .gitignore has no section", () => {
	test.each([
		[".obsidian/workspace.json", "file"],
		[".obsidian/workspace-mobile.json", "file"],
		[".obsidian/community-plugins.json", "file"],
		[".obsidian/plugins", "folder"],
		[".obsidian/plugins/dataview/main.js", "file"],
		[".trash", "folder"],
		[".trash/old.md", "file"],
		[".DS_Store", "file"],
		["notes/.DS_Store", "file"],
		["notes/._a.md", "file"],
		["._folder", "folder"],
		["img/Thumbs.db", "file"],
		["img/ehthumbs.db", "file"],
		["desktop.ini", "file"],
		["$RECYCLE.BIN", "folder"],
		["$RECYCLE.BIN/S-1-5/x", "file"],
		["notes/.a.md.icloud", "file"],
	] as const)("%s is matched, with no .gitignore at all and with one that says nothing of it", (path, type) => {
		expect(exclusionFor(null).matchesRule(path, type)).toBe(true);
		expect(exclusionFor("*.log\n").matchesRule(path, type)).toBe(true);
	});

	test.each([
		[".obsidian/app.json", "file"],
		[".obsidian/themes", "folder"],
		[".obsidian", "folder"],
		["workspace.json", "file"],
		["notes/workspace.json", "file"],
		["notes/.trash", "folder"],
		["notes/a.md", "file"],
	] as const)("%s is not matched", (path, type) => {
		expect(exclusionFor(null).matchesRule(path, type)).toBe(false);
	});

	test("a matched path is excluded while the remote does not hold it, and synced once it does", () => {
		const exclusion = exclusionFor(null);
		for (const path of [".obsidian/workspace.json", ".trash/old.md", ".obsidian/plugins/dataview/main.js"]) {
			expect(exclusion.excludes(path, "file", unknown)).toBe(true);
			expect(exclusion.excludes(path, "file", known)).toBe(false);
		}
	});

	test("the file wins over the section, since its lines come later", () => {
		const exclusion = exclusionFor("!/.obsidian/workspace.json\n!.DS_Store\n");
		expect(exclusion.matchesRule(".obsidian/workspace.json", "file")).toBe(false);
		expect(exclusion.matchesRule("notes/.DS_Store", "file")).toBe(false);
		expect(exclusion.matchesRule(".obsidian/workspace-mobile.json", "file")).toBe(true);
	});

	test("a folder the section excludes whole cannot be brought back in part", () => {
		const exclusion = exclusionFor("!/.obsidian/plugins/dataview/\n!/.obsidian/plugins/dataview/main.js\n");
		expect(exclusion.matchesRule(".obsidian/plugins/dataview/main.js", "file")).toBe(true);
	});

	test("a byte order mark at the start of the file is not part of the first rule", () => {
		expect(exclusionFor("\uFEFF/drafts/\n").matchesRule("drafts", "folder")).toBe(true);
	});

	test("line ends of Windows are read like any other", () => {
		const exclusion = exclusionFor("/drafts/\r\n*.log\r\n");
		expect(exclusion.matchesRule("drafts", "folder")).toBe(true);
		expect(exclusion.matchesRule("a.log", "file")).toBe(true);
	});
});

describe("a vault whose .gitignore has a section", () => {
	const defaultOnly = [".obsidian/workspace.json", ".obsidian/plugins/dataview/main.js", ".trash/old.md", "notes/.DS_Store"];

	test("the rules are the file alone: a line deleted from the section does not come back", () => {
		const lines = defaultSectionLines(paths).filter((line) => line !== "/.trash/" && line !== ".DS_Store");
		const exclusion = exclusionFor(withSection("*.log\n", lines));
		expect(exclusion.matchesRule(".trash/old.md", "file")).toBe(false);
		expect(exclusion.matchesRule("notes/.DS_Store", "file")).toBe(false);
		expect(exclusion.matchesRule(".obsidian/workspace.json", "file")).toBe(true);
		expect(exclusion.matchesRule("a.log", "file")).toBe(true);
	});

	test("an empty section leaves nothing out", () => {
		for (const text of [withSection(null, []), withSection("\uFEFF# mine\r\n", []), `x\n${withSection(null, [])}`]) {
			const exclusion = exclusionFor(text);
			for (const path of defaultOnly) expect(exclusion.matchesRule(path, "file")).toBe(false);
		}
	});

	test.each([
		["a start without an end", `${SECTION_START}\n/drafts/\n`],
		["two starts", `${SECTION_START}\n${SECTION_START}\n/drafts/\n${SECTION_END}\n`],
		["an end alone", `/drafts/\n${SECTION_END}\n`],
	])("a broken section counts as one, and its lines are still rules: %s", (_name, text) => {
		const exclusion = exclusionFor(text);
		for (const path of defaultOnly) expect(exclusion.matchesRule(path, "file")).toBe(false);
		expect(exclusion.matchesRule("drafts", "folder")).toBe(true);
	});

	test("a marker of another name is no section, and the default lines still apply", () => {
		const exclusion = exclusionFor("# >>> Sync EvoPro\n# <<< Sync EvoPro\n");
		for (const path of defaultOnly) expect(exclusion.matchesRule(path, "file")).toBe(true);
	});

	test("without a section the default lines apply, with or without a .gitignore; nothing else decides it", () => {
		for (const gitignore of [null, "", "*.log\n"]) {
			for (const path of defaultOnly) expect(exclusionFor(gitignore).matchesRule(path, "file")).toBe(true);
			// The one way to have none of them: a section, empty.
			const emptied = exclusionFor(withSection(gitignore, []));
			for (const path of defaultOnly) expect(emptied.matchesRule(path, "file")).toBe(false);
		}
		expect(exclusionFor(withSection("*.log\n", [])).matchesRule("a.log", "file")).toBe(true);
	});

	test("the two fixed exclusions of the code do not depend on any of this", () => {
		const exclusion = createExclusion({ ...paths, gitignore: withSection(null, []) });
		expect(exclusion.hardExclusionOf(".obsidian/plugins/sync-evo/main.js")).toBe("own-folder");
		expect(exclusion.excludes(".git/config", "file", known)).toBe(true);
	});
});

describe("the fixed exclusions that are not in effect", () => {
	const off = (gitignore: string | null): string[] => fixedExclusionsOff(createExclusion({ ...paths, gitignore }), paths);
	const section = (change: (lines: string[]) => string[], outside = ""): string =>
		withSection(outside, change(defaultSectionLines(paths)));

	test("none, with the default section, written or taken as written", () => {
		expect(off(null)).toEqual([]);
		expect(off("*.log\n")).toEqual([]);
		expect(off(section((lines) => lines))).toEqual([]);
	});

	test("all of them, in the order of the section, when there is no line at all", () => {
		const all = defaultSectionLines(paths).slice(2);
		expect(all).toHaveLength(11);
		expect(off(withSection(null, []))).toEqual(all);
		expect(off(withSection("*.log\n", []))).toEqual(all);
		expect(off(`${SECTION_START}\n`)).toEqual(all);
	});

	test("a line that was deleted, by the text of the line", () => {
		const deleted = ["/.obsidian/workspace-mobile.json", "/.trash/", "._*", "$RECYCLE.BIN/"];
		expect(off(section((lines) => lines.filter((line) => !deleted.includes(line))))).toEqual(deleted);
	});

	test("a line that a ! outside the section undoes", () => {
		expect(off(section((lines) => lines, "!.DS_Store\n!/.obsidian/workspace.json\n!*.icloud\n"))).toEqual([
			"/.obsidian/workspace.json",
			".DS_Store",
			"*.icloud",
		]);
	});

	test("the same rule written another way, or outside the section, is in effect", () => {
		const text = section(
			(lines) => lines.filter((line) => !["/.trash/", ".DS_Store", "/.obsidian/workspace.json", "Thumbs.db"].includes(line)),
			".trash\n**/.DS_Store\n/.obsidian/workspace*.json\n*.db\n",
		);
		expect(off(text)).toEqual([]);
	});

	test("the plugin's own folder is judged by the rules, though the code leaves it out anyway", () => {
		const text = section((lines) => lines.filter((line) => line !== "/.obsidian/plugins/sync-evo/"));
		// The line for all plugins still covers it.
		expect(off(text)).toEqual([]);
		const pluginsSynced = section((lines) =>
			lines.filter((line) => line !== "/.obsidian/plugins/sync-evo/" && line !== "/.obsidian/plugins/"),
		);
		expect(off(pluginsSynced)).toEqual(["/.obsidian/plugins/sync-evo/"]);
		expect(createExclusion({ ...paths, gitignore: pluginsSynced }).hardExclusionOf(".obsidian/plugins/sync-evo")).toBe(
			"own-folder",
		);
	});

	test("what the remote holds is not asked: a tracked .trash does not make its line count as off", () => {
		// `excludes` would answer false for these, and the warning would never go.
		const exclusion = exclusionFor(section((lines) => lines));
		expect(exclusion.excludes(".trash", "folder", known)).toBe(false);
		expect(fixedExclusionsOff(exclusion, paths)).toEqual([]);
	});

	test("restoring in the settings brings the deleted lines back into effect, but not the ones undone outside", () => {
		const text = section((lines) => lines.filter((line) => line !== "/.trash/" && line !== ".DS_Store"), "!*.icloud\n");
		expect(off(text)).toEqual(["/.trash/", ".DS_Store", "*.icloud"]);
		const restored = withFixedExclusions(readSectionState(defaultSectionLines(paths).slice(0, 3), paths), paths);
		expect(off(withSection(text, sectionLines(restored, paths)))).toEqual(["*.icloud"]);
	});

	test("the lines follow the names of the configuration folder and of the plugin's folder", () => {
		const other = { configDir: ".config[1]", pluginDir: ".config[1]/plugins/evo" };
		const emptied = createExclusion({ ...other, gitignore: withSection(null, []) });
		expect(fixedExclusionsOff(emptied, other).slice(0, 3)).toEqual([
			"/.config\\[1\\]/workspace.json",
			"/.config\\[1\\]/workspace-mobile.json",
			"/.config\\[1\\]/plugins/evo/",
		]);
		expect(fixedExclusionsOff(createExclusion({ ...other, gitignore: null }), other)).toEqual([]);
		// The lines of `.obsidian` do nothing for it.
		const wrongName = createExclusion({ ...other, gitignore: withSection(null, defaultSectionLines(paths)) });
		expect(fixedExclusionsOff(wrongName, other)).toEqual(fixedExclusionsOff(emptied, other).slice(0, 3));
	});
});

describe("the files of the remote that a rule matches", () => {
	const file = (path: string) => ({ path, kind: "file" as const, hash: "h" });
	const matched = (gitignore: string | null, entries: readonly { path: string; kind: "file" | "symlink" | "submodule" }[]) =>
		remoteFilesMatchingRules(exclusionFor(gitignore), entries).map((entry) => entry.path);

	test("they are the ones the rules would leave out if the remote did not hold them", () => {
		const entries = [
			file("notes/a.md"),
			file("drafts/b.md"),
			file("Drafts/Sub/c.md"),
			file("img/IMG_1.PNG"),
			file(".obsidian/app.json"),
			file(".obsidian/workspace.json"),
			file(".obsidian/plugins/dataview/main.js"),
			file(".trash/old.md"),
			file("notes/.DS_Store"),
			file(".gitignore"),
		];
		expect(matched("/drafts/\n*.png\n", entries)).toEqual([
			"drafts/b.md",
			"Drafts/Sub/c.md",
			"img/IMG_1.PNG",
			".obsidian/workspace.json",
			".obsidian/plugins/dataview/main.js",
			".trash/old.md",
			"notes/.DS_Store",
		]);
		// By the rules in effect: with an empty section, only what the file says.
		expect(matched(withSection("/drafts/\n", []), entries)).toEqual(["drafts/b.md", "Drafts/Sub/c.md"]);
		expect(matched(withSection(null, []), entries)).toEqual([]);
	});

	test("the entries come back as they were given, in their order", () => {
		const entries = [file("drafts/b.md"), file("a.md"), file("drafts/a.md")];
		const result = remoteFilesMatchingRules(exclusionFor("/drafts/\n"), entries);
		expect(result).toEqual([entries[0], entries[2]]);
		expect(result[0]).toBe(entries[0]);
	});

	test("what the code leaves out is not listed, whatever the rules say", () => {
		const entries = [
			file(".obsidian/plugins/sync-evo/main.js"),
			file(".obsidian/plugins/Sync-Evo/data.json"),
			file("sub/.git/config"),
			file(".obsidian/plugins/other/main.js"),
		];
		expect(matched(null, entries)).toEqual([".obsidian/plugins/other/main.js"]);
		expect(matched("*\n", entries)).toEqual([".obsidian/plugins/other/main.js"]);
	});

	test("a submodule and what lies below one are not listed; a symlink is", () => {
		const entries = [
			{ path: "drafts/module", kind: "submodule" as const },
			file("drafts/module/a.md"),
			file("drafts/module/deep/b.md"),
			file("drafts/module-notes.md"),
			{ path: "drafts/link", kind: "symlink" as const },
			file("drafts/c.md"),
		];
		expect(matched("/drafts/\n", entries)).toEqual(["drafts/module-notes.md", "drafts/link", "drafts/c.md"]);
	});

	test("a path that is not one from the root is passed over, in either normalization", () => {
		const nfc = "ガイド";
		const entries = [file("/a.md"), file("a//b.md"), file(""), file("../x"), file(`${nfc.normalize("NFD")}/a.md`)];
		expect(matched(`*\n`, entries)).toEqual([`${nfc.normalize("NFD")}/a.md`]);
		expect(matched(`/${nfc}/\n`, entries)).toEqual([`${nfc.normalize("NFD")}/a.md`]);
	});

	test("a copy kept from a conflict is judged by the file it is a copy of, as everywhere", () => {
		const copy = earlierCopyPath("drafts/a.md", "iPhone", new Date(2026, 9, 3, 22, 15, 0));
		expect(matched("/drafts/a.md\n", [file(copy), file("drafts/b.md")])).toEqual([copy]);
	});
});

describe("the files of the remote that can be untracked", () => {
	const file = (path: string) => ({ path, kind: "file" as const, hash: "h" });
	const link = (path: string) => ({ path, kind: "symlink" as const, hash: "h" });
	const submodule = (path: string) => ({ path, kind: "submodule" as const, hash: "h" });
	const own = (path: string) => ({ path, ownFolder: true });
	const other = (path: string) => ({ path, ownFolder: false });
	const untrackable = (gitignore: string | null, entries: Parameters<typeof untrackableFiles>[1]) => {
		const found = untrackableFiles(exclusionFor(gitignore), entries);
		return {
			files: found.files.map(({ entry, ownFolder }) => ({ path: entry.path, ownFolder })),
			submodules: found.submodules,
		};
	};

	test("Sync Evo's own folder is listed where a rule matches it, and marked; a .git never is", () => {
		const entries = [
			file("notes/a.md"),
			file(".obsidian/plugins/sync-evo/main.js"),
			file(".obsidian/plugins/Sync-Evo/data.json"),
			file(".obsidian/plugins/other/main.js"),
			file("sub/.git/config"),
			file(".trash/old.md"),
		];
		// The default lines count as there, and leave the folder out.
		expect(untrackable(null, entries).files).toEqual([
			own(".obsidian/plugins/sync-evo/main.js"),
			own(".obsidian/plugins/Sync-Evo/data.json"),
			other(".obsidian/plugins/other/main.js"),
			other(".trash/old.md"),
		]);
		// The same files without the own folder are the ones that stay synced.
		expect(remoteFilesMatchingRules(exclusionFor(null), entries).map((entry) => entry.path)).toEqual([
			".obsidian/plugins/other/main.js",
			".trash/old.md",
		]);
	});

	test("the own folder is not listed once no rule matches it: the line was deleted, or a ! outside the section undoes it", () => {
		const entries = [file(".obsidian/plugins/sync-evo/main.js"), file(".trash/old.md")];
		const lines = defaultSectionLines(paths);
		const without = lines.filter((line) => !line.startsWith("/.obsidian/plugins/"));
		expect(untrackable(withSection(null, without), entries).files).toEqual([other(".trash/old.md")]);
		expect(untrackable(withSection(null, []), entries).files).toEqual([]);
		// A folder that is left out whole cannot be taken back in from below.
		expect(untrackable(withSection("!/.obsidian/plugins/sync-evo/main.js\n", lines), entries).files).toEqual([
			own(".obsidian/plugins/sync-evo/main.js"),
			other(".trash/old.md"),
		]);
		expect(untrackable(withSection("!/.trash/\n", lines), entries).files).toEqual([own(".obsidian/plugins/sync-evo/main.js")]);
		expect(untrackable(withSection("!/.obsidian/plugins/\n!/.obsidian/plugins/sync-evo/\n", lines), entries).files).toEqual([
			other(".trash/old.md"),
		]);
	});

	test("a symlink is listed, and told by its kind", () => {
		const entries = [link("drafts/link"), file("drafts/a.md"), link("notes/link")];
		const found = untrackableFiles(exclusionFor("/drafts/\n"), entries);
		expect(found.files.map((entry) => entry.entry)).toEqual([entries[0], entries[1]]);
		expect(found.files[0]?.entry.kind).toBe("symlink");
		// A rule for a folder does not match a link of that name: to git it is a file.
		expect(untrackable("/notes/link/\n", entries).files).toEqual([]);
	});

	test("a submodule is not listed, and is answered apart when a rule matches it, as a file or as a folder", () => {
		const entries = [submodule("knowledge"), submodule("lib"), submodule("vendor/x"), file("vendor/a.md"), file("knowledge/a.md")];
		// `/knowledge/` only matches a folder, `/lib` either, and `/vendor/` what is below it.
		expect(untrackable("/knowledge/\n/lib\n/vendor/\n", entries)).toEqual({
			files: [other("vendor/a.md")],
			submodules: ["knowledge", "lib", "vendor/x"],
		});
		expect(untrackable(withSection(null, []), entries)).toEqual({ files: [], submodules: [] });
		// What lies below one is not listed whatever matches it.
		expect(untrackable("*.md\n", entries)).toEqual({ files: [other("vendor/a.md")], submodules: [] });
	});

	test("a path that is not one from the root is passed over", () => {
		expect(untrackable("*\n", [file("/a.md"), file("a//b.md"), file(""), submodule("../x"), file("b.md")])).toEqual({
			files: [other("b.md")],
			submodules: [],
		});
	});

	test("by lines that were added: what they match, and the file as it is now matches too", () => {
		const entries = [
			file(".trash/old.md"),
			file(".obsidian/workspace.json"),
			file(".obsidian/plugins/sync-evo/main.js"),
			file("debug.log"),
			submodule(".obsidian/plugins/dataview"),
		];
		const lines = defaultSectionLines(paths);
		const text = withSection("*.log\n!/.trash/\n", lines);
		const found = untrackableByAddedLines(paths, lines, text, entries);
		// Not the trash, which a line of the user's takes back in; not the
		// log, which no added line matches.
		expect(found.files.map(({ entry, ownFolder }) => ({ path: entry.path, ownFolder }))).toEqual([
			other(".obsidian/workspace.json"),
			own(".obsidian/plugins/sync-evo/main.js"),
		]);
		expect(found.submodules).toEqual([".obsidian/plugins/dataview"]);
	});
});

describe("the submodules whose content is not synced", () => {
	const submodule = (path: string) => ({ path, kind: "submodule" as const });

	test("each submodule of the remote, sorted; a file or a symlink is none", () => {
		const entries = [
			submodule("vendor/lib"),
			{ path: "a.md", kind: "file" as const },
			{ path: "link", kind: "symlink" as const },
			submodule("knowledge"),
		];
		expect(unsyncedSubmodules(exclusionFor(null), entries)).toEqual(["knowledge", "vendor/lib"]);
	});

	test("not one that a rule matches, itself or a folder above it", () => {
		const entries = [submodule("knowledge"), submodule("vendor/lib"), submodule("kept")];
		expect(unsyncedSubmodules(exclusionFor("/knowledge/\n/vendor/\n"), entries)).toEqual(["kept"]);
	});

	test("a rule undone by a later one leaves it counted", () => {
		expect(unsyncedSubmodules(exclusionFor("/knowledge/\n!/knowledge/\n"), [submodule("knowledge")])).toEqual(["knowledge"]);
	});
});

describe("the .gitignore files below the root", () => {
	const file = (path: string) => ({ path, kind: "file" as const });
	const nested = (gitignore: string | null, remote: readonly string[], local: readonly string[] = []): string[] =>
		nestedGitignores(exclusionFor(gitignore), remote.map(file), local);

	test("found on the remote and in the vault, each once, sorted; the one at the root is not one of them", () => {
		expect(
			nested(null, [".gitignore", "notes/.gitignore", "a.md", "b/c/.gitignore"], ["notes/.gitignore", "a/.gitignore", ".gitignore"]),
		).toEqual(["a/.gitignore", "b/c/.gitignore", "notes/.gitignore"]);
	});

	test("only a file of exactly that name", () => {
		const entries = [
			file("notes/.gitignore.bak"),
			file("notes/x.gitignore"),
			file("notes/.GITIGNORE"),
			{ path: "link/.gitignore", kind: "symlink" as const },
		];
		expect(nestedGitignores(exclusionFor(null), entries, [])).toEqual([]);
	});

	test("not below either of the two fixed exclusions of the code", () => {
		expect(nested("", ["sub/.git/.gitignore", ".obsidian/plugins/sync-evo/.gitignore", ".Obsidian/Plugins/Sync-Evo/x/.gitignore"])).toEqual([]);
	});

	test("not where a rule matches the file or a folder above it, though the remote holds it", () => {
		const rules = "/knowledge/\nbuild/\n**/.gitignore.d/\ndocs/.gitignore\n";
		const remote = ["knowledge/.gitignore", "knowledge/deep/.gitignore", "a/build/x/.gitignore", "docs/.gitignore", "kept/.gitignore"];
		expect(nested(rules, remote, remote)).toEqual(["kept/.gitignore"]);
		// `excludes` would leave none of them out: the remote holds them all.
		const known = knownPaths(remote.map(entryAt), []);
		expect(exclusionFor(rules).excludes("knowledge/.gitignore", "file", known)).toBe(false);
	});

	test("the lines of the default section count while the file has no section", () => {
		const remote = [".obsidian/plugins/dataview/.gitignore", ".trash/.gitignore", ".obsidian/snippets/.gitignore"];
		expect(nested(null, remote)).toEqual([".obsidian/snippets/.gitignore"]);
		expect(nested(withSection(null, []), remote)).toEqual([...remote].sort());
	});

	test("a rule undone by a later one leaves the file counted", () => {
		expect(nested("/drafts/\n!/drafts/\n", ["drafts/.gitignore"])).toEqual(["drafts/.gitignore"]);
	});

	test("not below a submodule, and not the submodule's own entry", () => {
		const entries = [
			{ path: "knowledge", kind: "submodule" as const },
			file("knowledge/.gitignore"),
			file("knowledge/deep/.gitignore"),
			file("knowledgeable/.gitignore"),
		];
		expect(nestedGitignores(exclusionFor(""), entries, ["knowledge/local/.gitignore"])).toEqual(["knowledgeable/.gitignore"]);
	});

	test("one path in NFC and NFD is told once, as the remote spells it; a path that is none is passed over", () => {
		const nfc = "caf\u00e9/.gitignore";
		const nfd = "cafe\u0301/.gitignore";
		expect(nested("", [nfd], [nfc])).toEqual([nfd]);
		expect(nested("", ["a//.gitignore", "/.gitignore", "../.gitignore"])).toEqual([]);
	});
});

describe("the two fixed exclusions", () => {
	const undoEverything = "!.git\n!.git/\n!.git/**\n!**/.git/**\n!/.obsidian/plugins/\n!/.obsidian/plugins/sync-evo/\n!*\n";

	test.each([
		".git",
		".git/config",
		".git/objects/ab/cdef",
		"sub/.git",
		"sub/module/.git/HEAD",
		".GIT/config",
		"sub/.Git",
	])("%s is under .git, whatever the rules say", (path) => {
		for (const gitignore of [null, undoEverything]) {
			const exclusion = exclusionFor(gitignore);
			expect(exclusion.hardExclusionOf(path)).toBe("dot-git");
			expect(exclusion.excludes(path, "file", unknown)).toBe(true);
			expect(exclusion.excludes(path, "file", known)).toBe(true);
			expect(exclusion.excludes(path, "folder", known)).toBe(true);
		}
	});

	test.each([
		".obsidian/plugins/sync-evo",
		".obsidian/plugins/sync-evo/main.js",
		".obsidian/plugins/sync-evo/sub/x",
		".obsidian/plugins/Sync-Evo/main.js",
		".Obsidian/Plugins/sync-evo/manifest.json",
	])("%s is the plugin's own folder, whatever the rules say and whatever the remote holds", (path) => {
		for (const gitignore of [null, undoEverything]) {
			const exclusion = exclusionFor(gitignore);
			expect(exclusion.hardExclusionOf(path)).toBe("own-folder");
			expect(exclusion.excludes(path, "file", known)).toBe(true);
		}
	});

	test.each([
		".gitignore",
		".gitmodules",
		".gitattributes",
		".github/workflows/ci.yml",
		"notes/.gitkeep",
		"a.git",
		"git/config",
		".obsidian/plugins/sync-evo-2/main.js",
		".obsidian/plugins/sync-evo.md",
		".obsidian/plugins/dataview/main.js",
		"copy/.obsidian/plugins/sync-evo/main.js",
	])("%s is neither", (path) => {
		expect(exclusionFor(null).hardExclusionOf(path)).toBeUndefined();
	});

	test("the plugin's folder is the one the app names, with or without slashes around it", () => {
		const exclusion = createExclusion({ configDir: ".config", pluginDir: "/.config/plugins/evo/", gitignore: null });
		expect(exclusion.hardExclusionOf(".config/plugins/evo/main.js")).toBe("own-folder");
		expect(exclusion.hardExclusionOf(".obsidian/plugins/sync-evo/main.js")).toBeUndefined();
	});

	test("the plugin's folder is matched in either normalization", () => {
		const exclusion = createExclusion({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/が", gitignore: null });
		expect(exclusion.hardExclusionOf(".obsidian/plugins/が/main.js")).toBe("own-folder");
	});
});

describe("paths that start with a dot", () => {
	test.each([
		[".github/workflows/ci.yml", "file"],
		[".github", "folder"],
		[".gitmodules", "file"],
		[".claude/skills/a/SKILL.md", "file"],
		["notes/.hidden.md", "file"],
		[".obsidian/app.json", "file"],
	] as const)("%s is an ordinary path: no rule matches it and nothing excludes it", (path, type) => {
		const exclusion = exclusionFor(null);
		expect(exclusion.hardExclusionOf(path)).toBeUndefined();
		expect(exclusion.matchesRule(path, type)).toBe(false);
		expect(exclusion.excludes(path, type, unknown)).toBe(false);
	});

	test("and a rule excludes it like any other", () => {
		const exclusion = exclusionFor("/.github/\n");
		expect(exclusion.excludes(".github/workflows/ci.yml", "file", unknown)).toBe(true);
		expect(exclusion.excludes(".github/workflows/ci.yml", "file", known)).toBe(false);
	});
});

describe("the root .gitignore", () => {
	test.each([".gitignore\n", ".*\n", "*\n", "/.gitignore\n"])("is never matched, even by the rule %j", (rules) => {
		const exclusion = exclusionFor(rules);
		expect(exclusion.matchesRule(".gitignore", "file")).toBe(false);
		expect(exclusion.excludes(".gitignore", "file", unknown)).toBe(false);
	});

	test("one in a subfolder is an ordinary file, which a rule can match", () => {
		expect(exclusionFor(null).matchesRule("notes/.gitignore", "file")).toBe(false);
		expect(exclusionFor(".gitignore\n").matchesRule("notes/.gitignore", "file")).toBe(true);
	});

	test("the rules of one in a subfolder have no effect: only the root text is ever given", () => {
		// `notes/.gitignore` holds `*.png`. Nothing reads it, so the exclusion
		// is made from the root file alone.
		const exclusion = exclusionFor("*.log\n");
		expect(exclusion.matchesRule("notes/a.png", "file")).toBe(false);
		expect(exclusion.excludes("notes/a.png", "file", unknown)).toBe(false);
		expect(exclusion.excludes("notes/.gitignore", "file", unknown)).toBe(false);
	});
});

describe("normalization and case", () => {
	// 下書き is the name the task gives, but it is the same in both forms.
	// ガイド is not: its two voiced characters come apart in NFD.
	const nfc = "下書きガイド";
	const nfd = nfc.normalize("NFD");

	test("the name really differs between the two forms", () => {
		expect(nfd).not.toBe(nfc);
		expect(nfd.normalize("NFC")).toBe(nfc);
	});

	test("a rule typed in NFC matches a folder returned in NFD, and what is in it", () => {
		const exclusion = exclusionFor(`/下書き/\n/${nfc}/\n`);
		expect(exclusion.matchesRule("下書き".normalize("NFD"), "folder")).toBe(true);
		expect(exclusion.matchesRule(nfd, "folder")).toBe(true);
		expect(exclusion.matchesRule(`${nfd}/メモ.md`, "file")).toBe(true);
		expect(exclusion.matchesRule(nfc, "folder")).toBe(true);
	});

	test("only the path is normalized: a rule is taken as it was typed", () => {
		// It also shows that the two forms do not match by themselves, so the
		// test above can fail.
		expect(exclusionFor(`/${nfd}/\n`).matchesRule(nfc, "folder")).toBe(false);
	});

	test("upper and lower case are the same anywhere in the path", () => {
		const exclusion = exclusionFor("/drafts/\n*.png\n");
		expect(exclusion.matchesRule("Drafts", "folder")).toBe(true);
		expect(exclusion.matchesRule("DRAFTS/a.md", "file")).toBe(true);
		expect(exclusion.matchesRule("photos/IMG_1.PNG", "file")).toBe(true);
	});
});

describe("the type of a path", () => {
	test("a rule for folders only matches when the path is given as a folder", () => {
		const exclusion = exclusionFor("/drafts/\n");
		expect(exclusion.matchesRule("drafts", "folder")).toBe(true);
		expect(exclusion.matchesRule("drafts", "file")).toBe(false);
		expect(exclusionFor(null).matchesRule("$RECYCLE.BIN", "folder")).toBe(true);
		expect(exclusionFor(null).matchesRule("$RECYCLE.BIN", "file")).toBe(false);
	});
});

describe("a copy kept from a conflict, of the earlier form beside its file", () => {
	const at = new Date(2026, 9, 3, 22, 15, 0);

	test("is judged by the name of the file it is a copy of", () => {
		const exclusion = exclusionFor("/exact.md\n*.conflict-from-*\n!keep.md\n");
		// The rule names the original, not the copy.
		expect(exclusion.matchesRule(earlierCopyPath("exact.md", "iPhone", at), "file")).toBe(true);
		// A rule that would match the name of the copy does not count when the
		// original is not matched.
		expect(exclusion.matchesRule(earlierCopyPath("keep.md", "iPhone", at), "file")).toBe(false);
	});

	test("a copy of a copy goes back to the first name", () => {
		const exclusion = exclusionFor("/exact.md\n");
		const first = earlierCopyPath("exact.md", "iPhone", at);
		expect(exclusion.matchesRule(earlierCopyPath(first, "Mac", at, 2), "file")).toBe(true);
	});

	test("the copy of the root .gitignore is never matched either", () => {
		const exclusion = exclusionFor(".*\n");
		expect(exclusion.matchesRule(earlierCopyPath(".gitignore", "iPhone", at), "file")).toBe(false);
	});

	test("is synced while the file it is a copy of is on the remote, though a rule matches it", () => {
		const exclusion = exclusionFor("/drafts/\n*.png\n");
		for (const original of ["drafts/a.md", "img.png"]) {
			const copy = earlierCopyPath(original, "iPhone", at);
			expect(exclusion.matchesRule(copy, "file")).toBe(true);
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(original)], []))).toBe(false);
			// Neither the copy nor the original is known: excluded.
			expect(exclusion.excludes(copy, "file", unknown)).toBe(true);
			// The copy itself is known, by the remote or by a record: synced.
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(copy)], []))).toBe(false);
			expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt(copy)]))).toBe(false);
		}
	});

	test("a record of the original is not enough: the remote has to hold it", () => {
		const exclusion = exclusionFor("*.png\n");
		const copy = earlierCopyPath("img.png", "iPhone", at);
		expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt("img.png")]))).toBe(true);
		// The original itself is still synced by its record, as any path is.
		expect(exclusion.excludes("img.png", "file", knownPaths([], [entryAt("img.png")]))).toBe(false);
	});

	test("for a copy of a copy it is the first file that is asked about", () => {
		const exclusion = exclusionFor("*.png\n");
		const first = earlierCopyPath("img.png", "iPhone", at);
		const second = earlierCopyPath(first, "Mac", at, 2);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt("img.png")], []))).toBe(false);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt(first)], []))).toBe(true);
	});

	test("a copy is synced while the remote holds a copy of the same name with another number, though the first file is gone", () => {
		const exclusion = exclusionFor("*.png\n");
		const first = earlierCopyPath("img.png", "iPhone", at);
		const second = earlierCopyPath("img.png", "iPhone", at, 2);
		const third = earlierCopyPath("img.png", "iPhone", at, 3);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt(first)], []))).toBe(false);
		expect(exclusion.excludes(first, "file", knownPaths([entryAt(second)], []))).toBe(false);
		expect(exclusion.excludes(third, "file", knownPaths([entryAt(second)], []))).toBe(false);
		// Without regard to case, as every known path is asked.
		expect(exclusion.excludes(second, "file", knownPaths([entryAt(first.replace("img", "IMG"))], []))).toBe(false);
		// A record of the other copy is not enough, as for the first file.
		expect(exclusion.excludes(second, "file", knownPaths([], [entryAt(first)]))).toBe(true);
		// A copy of another time, or of another device, is a copy of another conflict.
		const later = earlierCopyPath("img.png", "iPhone", new Date(2026, 9, 3, 22, 15, 1));
		const other = earlierCopyPath("img.png", "Mac", at);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt(later), entryAt(other)], []))).toBe(true);
		// And in the configuration folder no copy is sent, whatever the remote holds.
		const config = earlierCopyPath(".obsidian/app.json", "iPhone", at);
		const configSecond = earlierCopyPath(".obsidian/app.json", "iPhone", at, 2);
		expect(exclusion.excludes(configSecond, "file", knownPaths([entryAt(config)], []))).toBe(true);
	});

	test("an ordinary file next to a known one is not known for that", () => {
		const exclusion = exclusionFor("/drafts/\n");
		expect(exclusion.excludes("drafts/b.md", "file", knownPaths([entryAt("drafts/a.md")], []))).toBe(true);
	});

	test("a known original does not lift the two fixed exclusions", () => {
		const copy = earlierCopyPath(".obsidian/plugins/sync-evo/main.js", "iPhone", at);
		expect(exclusionFor(null).excludes(copy, "file", known)).toBe(true);
	});

	test("a copy of a file inside the configuration folder is left out, though the file is on the remote", () => {
		const exclusion = exclusionFor(null);
		for (const original of [".obsidian/app.json", ".obsidian/themes/x/theme.css", ".obsidian/snippets/a.css"]) {
			const copy = earlierCopyPath(original, "Mac", at);
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(original)], []))).toBe(true);
			expect(exclusion.excludes(copy, "file", unknown)).toBe(true);
			// A copy of the copy as well.
			const second = earlierCopyPath(copy, "iPhone", at, 2);
			expect(exclusion.excludes(second, "file", knownPaths([entryAt(original)], []))).toBe(true);
			// The file itself is synced like any other.
			expect(exclusion.excludes(original, "file", unknown)).toBe(false);
			// A copy that is known itself, sent by an earlier version, stays synced.
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(copy)], []))).toBe(false);
			expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt(copy)]))).toBe(false);
		}
	});

	test("that is by the name the configuration folder has, and not by a name that begins like it", () => {
		const copy = earlierCopyPath(".obsidian/app.json", "Mac", at);
		const beside = earlierCopyPath(".obsidian-old/app.json", "Mac", at);
		const remote = knownPaths([entryAt(".obsidian/app.json"), entryAt(".obsidian-old/app.json")], []);
		expect(exclusionFor(null).excludes(beside, "file", remote)).toBe(false);
		const renamed = createExclusion({ configDir: ".config", pluginDir: ".config/plugins/sync-evo", gitignore: null });
		expect(renamed.excludes(copy, "file", remote)).toBe(false);
		const inRenamed = earlierCopyPath(".config/app.json", "Mac", at);
		expect(renamed.excludes(inRenamed, "file", knownPaths([entryAt(".config/app.json")], []))).toBe(true);
	});

	test("a folder is never taken for a copy", () => {
		const exclusion = exclusionFor("/a.md/\n");
		expect(exclusion.matchesRule("a.conflict-from-iPhone-20261003-221500.md", "folder")).toBe(false);
	});
});

describe("a copy kept from a conflict, in the folder of the copies", () => {
	const at = new Date(2026, 9, 11, 22, 15, 0);
	const copy = conflictCopyPath("drafts/a.md", "iPhone", at);

	test("is synced whatever the rules say, known or not", () => {
		for (const rules of ["", "/drafts/\n*.md\n", "*\n", "_conflicts/\n", "/_conflicts\n", "_conflicts/*\n", "2026*\n"]) {
			const exclusion = exclusionFor(rules);
			expect(exclusion.excludes(copy, "file", unknown)).toBe(false);
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(copy)], []))).toBe(false);
			// No rule matches it, as none matches the root `.gitignore`: it is
			// not offered for untracking either.
			expect(exclusion.matchesRule(copy, "file")).toBe(false);
		}
	});

	test("the file it is a copy of is not asked about: its name does not tell it", () => {
		const exclusion = exclusionFor("/drafts/\n");
		expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt("drafts/a.md")]))).toBe(false);
		expect(exclusion.excludes(copy, "file", knownPaths([entryAt("other.md")], []))).toBe(false);
	});

	test("also the copy of a file in the configuration folder that another device made", () => {
		const exclusion = exclusionFor("");
		const settings = conflictCopyPath(".obsidian/app.json", "Mac", at);
		expect(settings).toBe("_conflicts/2026-10-11 app (Mac).json");
		expect(exclusion.excludes(settings, "file", unknown)).toBe(false);
	});

	test("the folder itself is never left out, so that a scan goes into it", () => {
		for (const rules of ["", "_conflicts/\n", "/_conflicts\n", "_*\n", "*\n"]) {
			const exclusion = exclusionFor(rules);
			expect(exclusion.excludes("_conflicts", "folder", unknown)).toBe(false);
			expect(exclusion.excludes("_Conflicts", "folder", unknown)).toBe(false);
		}
		// What the rules say of the folder is still what they say.
		expect(exclusionFor("_conflicts/\n").matchesRule("_conflicts", "folder")).toBe(true);
		expect(exclusionFor("").matchesRule("_conflicts", "folder")).toBe(false);
	});

	test("a file there that is not named like a copy, and a folder below, go by the rules", () => {
		const exclusion = exclusionFor("_conflicts/\n");
		expect(exclusion.excludes("_conflicts/notes.md", "file", unknown)).toBe(true);
		expect(exclusion.excludes("_conflicts/2026.10.11 a.md", "file", unknown)).toBe(true);
		expect(exclusion.excludes("_conflicts/sub", "folder", unknown)).toBe(true);
		expect(exclusion.excludes("_conflicts/sub/2026-10-11 a (iPhone).md", "file", unknown)).toBe(true);
		// Known, they are synced like any other path a rule matches.
		expect(exclusion.excludes("_conflicts/notes.md", "file", knownPaths([entryAt("_conflicts/notes.md")], []))).toBe(false);
		// Without a rule they are files like any other.
		expect(exclusionFor("").excludes("_conflicts/notes.md", "file", unknown)).toBe(false);
		expect(exclusionFor("").excludes("_conflicts/sub", "folder", unknown)).toBe(false);
	});

	test("a folder of that name anywhere else is a folder like any other", () => {
		const exclusion = exclusionFor("_conflicts/\n");
		expect(exclusion.excludes("notes/_conflicts", "folder", unknown)).toBe(true);
		expect(exclusion.excludes("notes/_conflicts/2026-10-11 a (iPhone).md", "file", unknown)).toBe(true);
	});

	test("a vault that spells the folder otherwise has its copies there", () => {
		const exclusion = exclusionFor("_conflicts/\n");
		expect(exclusion.excludes("_Conflicts/2026-10-11 a (iPhone).md", "file", unknown)).toBe(false);
	});

	test("what an older version makes of a copy in the folder is a copy in the folder, not one of the earlier form", () => {
		// Read by its end, it would be judged by `_conflicts/2026-10-11 a (iPhone).md`,
		// and left out with it once a rule matches the folder.
		const made = earlierCopyPath(copy, "Mac", at);
		const exclusion = exclusionFor("_conflicts/\n");
		expect(exclusion.matchesRule(made, "file")).toBe(false);
		expect(exclusion.excludes(made, "file", unknown)).toBe(false);
		// A file there that is no copy in the folder is read by its end as ever.
		const beside = earlierCopyPath("_conflicts/notes.md", "Mac", at);
		expect(exclusion.excludes(beside, "file", unknown)).toBe(true);
		expect(exclusion.excludes(beside, "file", knownPaths([entryAt("_conflicts/notes.md")], []))).toBe(false);
	});

	test("the second copy of a day, with its number, is a copy like the first", () => {
		const exclusion = exclusionFor("_conflicts/\n*.md\n");
		expect(exclusion.excludes("_conflicts/2026-10-12 a (iPhone) (1).md", "file", unknown)).toBe(false);
		expect(exclusion.matchesRule("_conflicts/2026-10-12 a (iPhone) (1).md", "file")).toBe(false);
	});

	test.each(["_conflicts/20261012 a (iPhone).md", "_conflicts/20261012-001421 a (iPhone).md"])(
		"%j, as a beta once named its copies, is a file like any other and goes by the rules",
		(named) => {
			// Without a rule it is a new file, and is sent.
			expect(exclusionFor("").excludes(named, "file", unknown)).toBe(false);
			// Under a rule it is left out, unless it is known.
			const exclusion = exclusionFor("_conflicts/\n");
			expect(exclusion.matchesRule(named, "file")).toBe(true);
			expect(exclusion.excludes(named, "file", unknown)).toBe(true);
			expect(exclusion.excludes(named, "file", knownPaths([entryAt(named)], []))).toBe(false);
			// Not judged by any other file: it is no copy of the earlier form either.
			expect(exclusion.excludes(named, "file", knownPaths([entryAt("_conflicts/a.md"), entryAt("a.md")], []))).toBe(true);
		},
	);

	test("the two fixed exclusions come first", () => {
		const exclusion = createExclusion({ configDir: ".obsidian", pluginDir: "_conflicts", gitignore: "" });
		expect(exclusion.excludes("_conflicts", "folder", unknown)).toBe(true);
		expect(exclusion.excludes(copy, "file", unknown)).toBe(true);
	});
});

describe("inside the configuration folder", () => {
	test("every depth, and the folder itself is not inside it", () => {
		expect(isInConfigDir(".obsidian/app.json", ".obsidian")).toBe(true);
		expect(isInConfigDir(".obsidian/themes/x/theme.css", ".obsidian")).toBe(true);
		expect(isInConfigDir(".obsidian", ".obsidian")).toBe(false);
		expect(isInConfigDir("notes/.obsidian/app.json", ".obsidian")).toBe(false);
		expect(isInConfigDir(".obsidian-old/app.json", ".obsidian")).toBe(false);
		expect(isInConfigDir("a.md", ".obsidian")).toBe(false);
	});

	test("the name is taken with or without slashes, in any case and normalization", () => {
		expect(isInConfigDir(".obsidian/app.json", "/.obsidian/")).toBe(true);
		expect(isInConfigDir(".Obsidian/app.json", ".obsidian")).toBe(true);
		expect(isInConfigDir(".config/app.json", ".config")).toBe(true);
		expect(isInConfigDir(".obsidian/app.json", ".config")).toBe(false);
		expect(isInConfigDir(".ガイド/app.json".normalize("NFD"), ".ガイド".normalize("NFC"))).toBe(true);
		// No name: nothing is inside it.
		expect(isInConfigDir("a.md", "")).toBe(false);
	});
});

describe("what is known", () => {
	const paths = knownPaths([entryAt("notes/a.md"), entryAt("Drafts/Sub/b.md")], [entryAt("old/c.md"), entryAt("ガイド/が.md")]);

	test("a file is known by the remote or by a record; only the first is on the remote", () => {
		expect(paths.has("notes/a.md", "file")).toBe(true);
		expect(paths.has("old/c.md", "file")).toBe(true);
		expect(paths.has("notes/b.md", "file")).toBe(false);
		expect(paths.onRemote("notes/a.md")).toBe(true);
		expect(paths.onRemote("old/c.md")).toBe(false);
	});

	test("a folder is known by a path below it, at any depth, and not by a name that starts the same", () => {
		expect(paths.has("notes", "folder")).toBe(true);
		expect(paths.has("drafts/sub", "folder")).toBe(true);
		expect(paths.has("old", "folder")).toBe(true);
		expect(paths.has("note", "folder")).toBe(false);
		expect(paths.has("notes/a.md", "folder")).toBe(false);
		expect(paths.has("notes", "file")).toBe(false);
	});

	test("asked without regard to case or normalization", () => {
		expect(paths.has("NOTES/A.MD", "file")).toBe(true);
		expect(paths.has("drafts", "folder")).toBe(true);
		expect(paths.has("ガイド/が.md".normalize("NFD"), "file")).toBe(true);
	});
});

describe("a path that is not one from the vault root", () => {
	test.each(["", "/", "/a.md", "./a.md", "../a.md", ".", "..", "a/", "a//b.md", "a/./b.md", "a/../b.md"])(
		"%j is refused",
		(path) => {
			const exclusion = exclusionFor(null);
			expect(() => exclusion.matchesRule(path, "file")).toThrow(/Not a path from the vault root/);
			expect(() => exclusion.hardExclusionOf(path)).toThrow(/Not a path from the vault root/);
			expect(() => exclusion.excludes(path, "folder", unknown)).toThrow(/Not a path from the vault root/);
		},
	);

	test("a plugin folder that is no path is refused when the exclusion is made", () => {
		expect(() => createExclusion({ configDir: ".obsidian", pluginDir: "", gitignore: null })).toThrow();
	});
});

// The same rules, asked of git itself. Left out on purpose are the three
// places where the library is known to differ: `?` and `[]` against
// characters outside ASCII, upper and lower case outside ASCII, and `***`.
function gitIsInstalled(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!gitIsInstalled())("the same answers as git check-ignore", () => {
	// The configuration of the user and of the machine is kept out: a global
	// excludes file would answer for rules that are not in the test.
	const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

	/** Builds a repository with these rules and paths, and asks git which of the paths it ignores. */
	/** A section with no line in it, as `withSection` writes one. */
	const EMPTY_SECTION = `${SECTION_START}\n${SECTION_END}\n`;

	function ignoredByGit(rules: string, entries: readonly (readonly [string, PathType])[]): Set<string> {
		const repo = mkdtempSync(join(tmpdir(), "sync-evo-check-ignore-"));
		try {
			const git = (args: readonly string[], input?: string): string =>
				execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
			git(["init", "--quiet"]);
			// What git uses on a Mac, and what the exclusion always does.
			git(["config", "core.ignorecase", "true"]);
			git(["config", "core.excludesFile", ""]);
			git(["config", "core.precomposeUnicode", "false"]);
			writeFileSync(join(repo, ".gitignore"), rules);
			// Git tells a folder from a file by looking at the disk.
			for (const [path, type] of entries) {
				if (type === "folder") {
					mkdirSync(join(repo, path), { recursive: true });
				} else {
					mkdirSync(dirname(join(repo, path)), { recursive: true });
					writeFileSync(join(repo, path), "");
				}
			}
			let out = "";
			try {
				out = git(["check-ignore", "--no-index", "--stdin", "-z"], entries.map(([path]) => path).join("\0"));
			} catch (error) {
				// Status 1 says that none of the paths is ignored.
				if ((error as { status?: number }).status !== 1) throw error;
			}
			return new Set(out.split("\0").filter((path) => path !== ""));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	function expectSameAsGit(rules: string, entries: readonly (readonly [string, PathType])[]): void {
		const byGit = ignoredByGit(rules, entries);
		// Without the default section in front: only the rules under test.
		// Rules that have no section get an empty one after them, which is
		// what keeps the default lines out, and is two comments to the
		// library. Git is asked about the rules as they were given.
		const withoutDefaults =
			findSection(rules).kind === "none" ? `${rules}${rules.endsWith("\n") || rules === "" ? "" : "\n"}${EMPTY_SECTION}` : rules;
		expect(findSection(withoutDefaults).kind).not.toBe("none");
		const exclusion = createExclusion({
			configDir: "unused-config",
			pluginDir: "unused-config/own",
			gitignore: withoutDefaults,
		});
		const answers = entries.map(([path, type]) => `${path} (${type}): ${exclusion.matchesRule(path, type)}`);
		expect(answers).toEqual(entries.map(([path, type]) => `${path} (${type}): ${byGit.has(path)}`));
		// The rules do match some paths and leave others, so the comparison can fail.
		expect(byGit.size).toBeGreaterThan(0);
		expect(byGit.size).toBeLessThan(entries.length);
	}

	test("negation, wildcards, rules for folders, and anchoring", () => {
		const rules = [
			"# a comment",
			"",
			"*.log",
			"!keep.log",
			"/drafts/",
			"!/drafts/kept.md",
			"$RECYCLE.BIN/",
			"build",
			"/rooted.md",
			"docs/**/tmp",
			"**/cache/",
			"secret/*",
			"!secret/public.md",
			"a/*.txt",
			"temp-*/",
			"deep/**",
			"!deep/**/",
			"!deep/**/*.md",
			"trailing\\ ",
			"\\#hash.md",
			"\\!bang.md",
			"lit\\[eral\\].md",
			"cl[ae]ss.md",
			"one?.md",
		].join("\n");
		expectSameAsGit(rules, [
			["x.log", "file"],
			["sub/y.log", "file"],
			["keep.log", "file"],
			["sub/keep.log", "file"],
			["drafts", "folder"],
			["drafts/a.md", "file"],
			// The folder is excluded, so a later `!` cannot bring this back.
			["drafts/kept.md", "file"],
			["drafts/sub/b.md", "file"],
			// Anchored to the root: not the same name further down.
			["notes/drafts", "folder"],
			["notes/drafts/c.md", "file"],
			["$RECYCLE.BIN", "folder"],
			["sub/$RECYCLE.BIN", "folder"],
			["sub/$RECYCLE.BIN/x", "file"],
			// A rule for folders does not match a file of that name.
			["files/$RECYCLE.BIN", "file"],
			["build", "folder"],
			["build/out.js", "file"],
			// Without a slash the rule matches at any depth, files too.
			["src/build", "file"],
			["rooted.md", "file"],
			["sub/rooted.md", "file"],
			["docs/tmp", "file"],
			["docs/a/b/tmp", "folder"],
			["docs/a/b/tmp/x", "file"],
			["other/tmp", "file"],
			["x/cache", "folder"],
			["x/cache/y", "file"],
			["cache", "folder"],
			["y/z/cache", "file"],
			["secret", "folder"],
			["secret/private.md", "file"],
			["secret/public.md", "file"],
			["secret/sub", "folder"],
			["a/b.txt", "file"],
			// `*` does not cross a slash.
			["a/c/d.txt", "file"],
			["temp-1", "folder"],
			["temp-2", "file"],
			["deep", "folder"],
			["deep/a.md", "file"],
			["deep/a.bin", "file"],
			["deep/b/c.md", "file"],
			["deep/b/c.bin", "file"],
			["trailing ", "file"],
			["trailing", "file"],
			["#hash.md", "file"],
			["!bang.md", "file"],
			["lit[eral].md", "file"],
			["literal.md", "file"],
			["class.md", "file"],
			["cless.md", "file"],
			["cliss.md", "file"],
			["one1.md", "file"],
			["one.md", "file"],
			["one12.md", "file"],
			["plain.md", "file"],
		]);
	});

	test("everything but one kind of file", () => {
		expectSameAsGit("*\n!*/\n!*.md\n", [
			["a.md", "file"],
			["a.png", "file"],
			["notes", "folder"],
			["notes/b.md", "file"],
			["notes/b.pdf", "file"],
			["notes/deep/er", "folder"],
			["notes/deep/er/c.md", "file"],
			["notes/deep/er/c.txt", "file"],
			["LICENSE", "file"],
		]);
	});

	test("everything but one folder, and in it only one folder", () => {
		expectSameAsGit("/*\n!/notes/\n/notes/*\n!/notes/keep/\n", [
			["a.md", "file"],
			["other", "folder"],
			["other/b.md", "file"],
			["notes", "folder"],
			["notes/c.md", "file"],
			["notes/drop", "folder"],
			["notes/drop/d.md", "file"],
			["notes/keep", "folder"],
			["notes/keep/e.md", "file"],
			["notes/keep/sub/f.md", "file"],
			["sub/notes/g.md", "file"],
		]);
	});

	test("upper and lower case, with core.ignorecase on", () => {
		// Each name is on the disk in one spelling only, so that the test is
		// the same on a file system that tells the cases apart.
		expectSameAsGit("/Archive/\n*.PNG\nReadMe.md\n/lower/Mixed.TXT\n", [
			["archive", "folder"],
			["archive/a.md", "file"],
			["sub/Archive", "folder"],
			["photo.png", "file"],
			["IMG_1.PNG", "file"],
			["img/Shot.Png", "file"],
			["README.MD", "file"],
			["docs/readme.md", "file"],
			["LOWER/mixed.txt", "file"],
			["other.md", "file"],
		]);
	});

	test("the lines of the default section", () => {
		const lines = defaultSectionLines(paths).join("\n");
		expectSameAsGit(lines, [
			[".obsidian", "folder"],
			[".obsidian/app.json", "file"],
			[".obsidian/community-plugins.json", "file"],
			[".obsidian/core-plugins.json", "file"],
			[".obsidian/plugins", "folder"],
			[".obsidian/plugins/dataview/main.js", "file"],
			[".obsidian/workspace.json", "file"],
			[".obsidian/workspace-mobile.json", "file"],
			[".obsidian/themes/a/theme.css", "file"],
			["notes/workspace.json", "file"],
			[".trash", "folder"],
			[".trash/old.md", "file"],
			["notes/.trash/x.md", "file"],
			[".DS_Store", "file"],
			["notes/.DS_Store", "file"],
			["notes/._a.md", "file"],
			["._dir", "folder"],
			["img/Thumbs.db", "file"],
			["img/ehthumbs.db", "file"],
			["desktop.ini", "file"],
			["$RECYCLE.BIN", "folder"],
			["notes/.a.md.icloud", "file"],
			[".github/workflows/ci.yml", "file"],
			[".gitmodules", "file"],
			["notes/a.md", "file"],
		]);
	});

	// The forms the settings write into the section, as a whole file: the
	// section between its markers, and the rules of the user after it.
	describe("the section the settings write", () => {
		const defaults = defaultSectionState(paths);
		const allKinds = { image: true, audio: true, video: true, pdf: true, other: true };
		const sectionOf = (change: Partial<SectionState>, outside = ""): string =>
			withSection(outside, sectionLines({ ...defaults, ...change }, paths));

		// The root `.gitignore` is not among them: the helper would write it
		// over the rules.
		const notes: readonly (readonly [string, PathType])[] = [
			["a.md", "file"],
			["b.canvas", "file"],
			["c.base", "file"],
			["d.txt", "file"],
			["LICENSE", "file"],
			[".gitmodules", "file"],
			["notes", "folder"],
			["notes/e.md", "file"],
			["notes/e.csv", "file"],
			["notes/.gitignore", "file"],
			["notes/deep/er", "folder"],
			["notes/deep/er/f.md", "file"],
			["notes/deep/er/f.zip", "file"],
		];
		const media: readonly (readonly [string, PathType])[] = [
			["img/a.png", "file"],
			["img/IMG_1.JPG", "file"],
			["img/b.avif", "file"],
			["rec/a.mp3", "file"],
			["rec/b.opus", "file"],
			["rec/c.webm", "file"],
			["film/a.mp4", "file"],
			["film/b.MOV", "file"],
			["docs/a.pdf", "file"],
			// A folder named like a file of a kind.
			["album.png", "folder"],
			["album.png/cover.md", "file"],
		];
		const config: readonly (readonly [string, PathType])[] = [
			[".obsidian", "folder"],
			[".obsidian/app.json", "file"],
			[".obsidian/types.json", "file"],
			[".obsidian/appearance.json", "file"],
			[".obsidian/hotkeys.json", "file"],
			[".obsidian/core-plugins.json", "file"],
			[".obsidian/core-plugins-migration.json", "file"],
			[".obsidian/graph.json", "file"],
			[".obsidian/daily-notes.json", "file"],
			[".obsidian/community-plugins.json", "file"],
			[".obsidian/workspace.json", "file"],
			[".obsidian/workspace-mobile.json", "file"],
			[".obsidian/notes.txt", "file"],
			[".obsidian/icons/a.png", "file"],
			[".obsidian/icons/b.webm", "file"],
			[".obsidian/sub/x.json", "file"],
			[".obsidian/themes", "folder"],
			[".obsidian/themes/a/theme.css", "file"],
			[".obsidian/themes/a/manifest.json", "file"],
			[".obsidian/snippets/a.css", "file"],
			[".obsidian/plugins", "folder"],
			[".obsidian/plugins/dataview/main.js", "file"],
			[".obsidian/plugins/dataview/data.json", "file"],
			[".obsidian/plugins/sync-evo", "folder"],
			[".obsidian/plugins/sync-evo/main.js", "file"],
			[".obsidian/.DS_Store", "file"],
			["notes/app.json", "file"],
			["x.json", "file"],
		];
		const fixed: readonly (readonly [string, PathType])[] = [
			[".trash", "folder"],
			[".trash/old.md", "file"],
			["notes/.trash/x.md", "file"],
			[".DS_Store", "file"],
			["notes/.DS_Store", "file"],
			["notes/._e.md", "file"],
			["img/Thumbs.db", "file"],
			["img/ehthumbs.db", "file"],
			["desktop.ini", "file"],
			["$RECYCLE.BIN", "folder"],
			["$RECYCLE.BIN/S-1/x.md", "file"],
			["notes/.e.md.icloud", "file"],
		];
		const everything = [...notes, ...media, ...config, ...fixed];

		test("the default section, between its markers", () => {
			expectSameAsGit(sectionOf({}), everything);
			expectSameAsGit(sectionOf({}).replace(/\n/g, "\r\n"), everything);
			expectSameAsGit(`\uFEFF${sectionOf({})}`, everything);
		});

		test('"other" off, with every kind on and with some off', () => {
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, other: false } }), everything);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, other: false, image: false, pdf: false } }), everything);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, other: false, audio: false } }), everything);
			expectSameAsGit(
				sectionOf({ kinds: { image: false, audio: false, video: false, pdf: false, other: false } }),
				everything,
			);
		});

		test("kinds off one by one, and webm with sound, with picture, and with both", () => {
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, image: false } }), everything);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, audio: false } }), everything);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, video: false, pdf: false } }), everything);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, audio: false, video: false } }), everything);
		});

		test("the settings of the core plugins off, with other parts on and off", () => {
			const off = { ...defaults.config, "core-plugin-settings": false };
			expectSameAsGit(sectionOf({ config: off }), everything);
			expectSameAsGit(
				sectionOf({
					config: {
						...off,
						appearance: false,
						"themes-and-snippets": false,
						"core-plugin-list": false,
						"community-plugin-list": true,
						"community-plugins": true,
					},
				}),
				everything,
			);
			// Together with "other" off: the two forms that take the folder out and put parts back.
			expectSameAsGit(
				sectionOf({ kinds: { ...allKinds, other: false, video: false }, config: { ...off, hotkeys: false } }),
				everything,
			);
		});

		test("parts of the configuration folder off, with the settings of the core plugins on", () => {
			expectSameAsGit(
				sectionOf({
					config: {
						...defaults.config,
						"main-settings": false,
						"themes-and-snippets": false,
						hotkeys: false,
						"community-plugins": true,
					},
				}),
				everything,
			);
		});

		test("folders with characters that mean something in .gitignore", () => {
			const folders = ["drafts", "dra[f]ts", "a*b", "what?", "back\\slash", "!bang", "#hash", "end ", "notes/pri[v]ate", "下書き"];
			const entries: (readonly [string, PathType])[] = [];
			for (const folder of folders) entries.push([folder, "folder"], [`${folder}/a.md`, "file"]);
			expectSameAsGit(sectionOf({ folders }), [
				...entries,
				// What the lines would match if the characters were not escaped.
				["draft", "folder"],
				["drafts2/a.md", "file"],
				["drafs/a.md", "file"],
				["aXb/a.md", "file"],
				["whatX/a.md", "file"],
				["backslash/a.md", "file"],
				["bang/a.md", "file"],
				["end/a.md", "file"],
				["notes/private/a.md", "file"],
				// From the root only.
				["notes/drafts/a.md", "file"],
				["other/a*b/a.md", "file"],
				// A file of that name is not the folder.
				["notes/what?", "file"],
				...notes,
			]);
		});

		test("fixed exclusions that were deleted from the section", () => {
			const kept = defaults.fixed.filter((line) => !["/.trash/", "._*", "/.obsidian/workspace.json"].includes(line));
			expectSameAsGit(sectionOf({ fixed: kept }), everything);
			expectSameAsGit(sectionOf({ fixed: [] }), everything);
		});

		test("a ! outside the section undoes a line of it, but not inside a folder it left out", () => {
			const outside = [
				"!.DS_Store",
				"!/.obsidian/workspace.json",
				"!*.png",
				"!/drafts/keep.md",
				"!/.obsidian/plugins/dataview/",
				"!/.obsidian/plugins/dataview/main.js",
				"!/.trash/",
				"*.csv",
				"",
			].join("\n");
			const entries: (readonly [string, PathType])[] = [...everything, ["drafts/keep.md", "file"], ["drafts/b.md", "file"]];
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, image: false }, folders: ["drafts"] }, outside), entries);
			expectSameAsGit(sectionOf({ kinds: { ...allKinds, other: false, image: false }, folders: ["drafts"] }, outside), entries);
		});

		test("a section the user moved below their own rules", () => {
			const section = sectionOf({ kinds: { ...allKinds, pdf: false } });
			expectSameAsGit(`!*.pdf\n*.md\n${section}!/.trash/\n`, everything);
		});
	});

	test("names outside ASCII, where no wildcard is next to them", () => {
		expectSameAsGit("/下書き/\n*.メモ\nノート/*.md\n", [
			["下書き", "folder"],
			["下書き/a.md", "file"],
			["ほか/下書き", "folder"],
			["a.メモ", "file"],
			["ノート/a.md", "file"],
			["ノート/sub/a.md", "file"],
			["ノート.md", "file"],
		]);
	});
});
