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
	isInConfigDir,
	type KnownPaths,
	knownPaths,
	type PathType,
} from "../src/core/exclusion";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** Every path is on the remote. */
const known: KnownPaths = { has: () => true, onRemote: () => true };
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

describe("a copy kept from a conflict", () => {
	const at = new Date(2026, 9, 3, 22, 15, 0);

	test("is judged by the name of the file it is a copy of", () => {
		const exclusion = exclusionFor("/exact.md\n*.conflict-from-*\n!keep.md\n");
		// The rule names the original, not the copy.
		expect(exclusion.matchesRule(conflictCopyPath("exact.md", "iPhone", at), "file")).toBe(true);
		// A rule that would match the name of the copy does not count when the
		// original is not matched.
		expect(exclusion.matchesRule(conflictCopyPath("keep.md", "iPhone", at), "file")).toBe(false);
	});

	test("a copy of a copy goes back to the first name", () => {
		const exclusion = exclusionFor("/exact.md\n");
		const first = conflictCopyPath("exact.md", "iPhone", at);
		expect(exclusion.matchesRule(conflictCopyPath(first, "Mac", at, 2), "file")).toBe(true);
	});

	test("the copy of the root .gitignore is never matched either", () => {
		const exclusion = exclusionFor(".*\n");
		expect(exclusion.matchesRule(conflictCopyPath(".gitignore", "iPhone", at), "file")).toBe(false);
	});

	test("is synced while the file it is a copy of is on the remote, though a rule matches it", () => {
		const exclusion = exclusionFor("/drafts/\n*.png\n");
		for (const original of ["drafts/a.md", "img.png"]) {
			const copy = conflictCopyPath(original, "iPhone", at);
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
		const copy = conflictCopyPath("img.png", "iPhone", at);
		expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt("img.png")]))).toBe(true);
		// The original itself is still synced by its record, as any path is.
		expect(exclusion.excludes("img.png", "file", knownPaths([], [entryAt("img.png")]))).toBe(false);
	});

	test("for a copy of a copy it is the first file that is asked about", () => {
		const exclusion = exclusionFor("*.png\n");
		const first = conflictCopyPath("img.png", "iPhone", at);
		const second = conflictCopyPath(first, "Mac", at, 2);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt("img.png")], []))).toBe(false);
		expect(exclusion.excludes(second, "file", knownPaths([entryAt(first)], []))).toBe(true);
	});

	test("an ordinary file next to a known one is not known for that", () => {
		const exclusion = exclusionFor("/drafts/\n");
		expect(exclusion.excludes("drafts/b.md", "file", knownPaths([entryAt("drafts/a.md")], []))).toBe(true);
	});

	test("a known original does not lift the two fixed exclusions", () => {
		const copy = conflictCopyPath(".obsidian/plugins/sync-evo/main.js", "iPhone", at);
		expect(exclusionFor(null).excludes(copy, "file", known)).toBe(true);
	});

	test("a copy of a file inside the configuration folder is left out, though the file is on the remote", () => {
		const exclusion = exclusionFor(null);
		for (const original of [".obsidian/app.json", ".obsidian/themes/x/theme.css", ".obsidian/snippets/a.css"]) {
			const copy = conflictCopyPath(original, "Mac", at);
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(original)], []))).toBe(true);
			expect(exclusion.excludes(copy, "file", unknown)).toBe(true);
			// A copy of the copy as well.
			const second = conflictCopyPath(copy, "iPhone", at, 2);
			expect(exclusion.excludes(second, "file", knownPaths([entryAt(original)], []))).toBe(true);
			// The file itself is synced like any other.
			expect(exclusion.excludes(original, "file", unknown)).toBe(false);
			// A copy that is known itself, sent by an earlier version, stays synced.
			expect(exclusion.excludes(copy, "file", knownPaths([entryAt(copy)], []))).toBe(false);
			expect(exclusion.excludes(copy, "file", knownPaths([], [entryAt(copy)]))).toBe(false);
		}
	});

	test("that is by the name the configuration folder has, and not by a name that begins like it", () => {
		const copy = conflictCopyPath(".obsidian/app.json", "Mac", at);
		const beside = conflictCopyPath(".obsidian-old/app.json", "Mac", at);
		const remote = knownPaths([entryAt(".obsidian/app.json"), entryAt(".obsidian-old/app.json")], []);
		expect(exclusionFor(null).excludes(beside, "file", remote)).toBe(false);
		const renamed = createExclusion({ configDir: ".config", pluginDir: ".config/plugins/sync-evo", gitignore: null });
		expect(renamed.excludes(copy, "file", remote)).toBe(false);
		const inRenamed = conflictCopyPath(".config/app.json", "Mac", at);
		expect(renamed.excludes(inRenamed, "file", knownPaths([entryAt(".config/app.json")], []))).toBe(true);
	});

	test("a folder is never taken for a copy", () => {
		const exclusion = exclusionFor("/a.md/\n");
		expect(exclusion.matchesRule("a.conflict-from-iPhone-20261003-221500.md", "folder")).toBe(false);
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
		const exclusion = createExclusion({ configDir: "unused-config", pluginDir: "unused-config/own", gitignore: rules });
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
