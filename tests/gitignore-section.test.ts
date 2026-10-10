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
import { defaultSectionLines } from "../src/core/exclusion";
import {
	defaultSectionState,
	escaped,
	findSection,
	fixedExclusions,
	folderLine,
	folderOfLine,
	isHandEdited,
	readSectionState,
	SECTION_END,
	SECTION_START,
	type SectionState,
	sectionLines,
	unescaped,
	withFixedExclusions,
	withSection,
} from "../src/core/gitignore-section";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };
const defaults = defaultSectionState(paths);

function state(change: {
	kinds?: Partial<SectionState["kinds"]>;
	config?: Partial<SectionState["config"]>;
	folders?: string[];
	fixed?: string[];
	unknown?: string[];
}): SectionState {
	return {
		kinds: { ...defaults.kinds, ...change.kinds },
		config: { ...defaults.config, ...change.config },
		folders: change.folders ?? [],
		fixed: change.fixed ?? defaults.fixed,
		unknown: change.unknown ?? [],
	};
}

const FIXED = [
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
];

describe("the two markers", () => {
	test("their text is the one every device shares", () => {
		expect(SECTION_START).toBe(
			"# >>> Sync Evo: managed section. Do not edit these lines by hand; change them in the Sync Evo settings. >>>",
		);
		expect(SECTION_END).toBe("# <<< Sync Evo: end of managed section <<<");
	});
});

describe("finding the section", () => {
	test("a text without a marker has none", () => {
		expect(findSection("")).toEqual({ kind: "none" });
		expect(findSection("*.log\n# a comment\n")).toEqual({ kind: "none" });
		expect(findSection("﻿*.log\n")).toEqual({ kind: "none" });
	});

	test("the section is cut out with what is before and after it, markers included", () => {
		const text = `${SECTION_START}\n/a/\n*.png\n${SECTION_END}\n*.log\n`;
		expect(findSection(text)).toEqual({
			kind: "found",
			before: `${SECTION_START}\n`,
			lines: ["/a/", "*.png"],
			after: `${SECTION_END}\n*.log\n`,
		});
	});

	test("it need not be at the top, and may be empty or end the file without a line end", () => {
		expect(findSection(`*.log\n${SECTION_START}\n${SECTION_END}`)).toEqual({
			kind: "found",
			before: `*.log\n${SECTION_START}\n`,
			lines: [],
			after: SECTION_END,
		});
	});

	test("only the start of a marker is looked at: a later version may word the rest anew", () => {
		const found = findSection("# >>> Sync Evo: 管理区画 >>>\n/a/\n# <<< Sync Evo\n");
		expect(found).toMatchObject({ kind: "found", lines: ["/a/"] });
		expect(findSection("# >>> Sync Evo\n/a/\n# <<< Sync Evo: end\n")).toMatchObject({ kind: "found", lines: ["/a/"] });
		expect(findSection("# >>> Sync Evo \t\n/a/\n# <<< Sync Evo\t\n")).toMatchObject({ kind: "found", lines: ["/a/"] });
	});

	test("a marker of another name is not one, nor one that does not start the line", () => {
		expect(findSection("# >>> Sync Evo Pro\n/a/\n# <<< Sync Evo Pro\n")).toMatchObject({ kind: "found" });
		expect(findSection("# >>> Sync EvoPro\n/a/\n# <<< Sync EvoPro\n")).toEqual({ kind: "none" });
		expect(findSection("# >>> Sync Evo-2\n# <<< Sync Evo.\n")).toEqual({ kind: "none" });
		expect(findSection(" # >>> Sync Evo:\n # <<< Sync Evo:\n")).toEqual({ kind: "none" });
		expect(findSection("#>>> Sync Evo:\n# <<<Sync Evo:\n")).toEqual({ kind: "none" });
	});

	test("line ends of Windows and spaces at the end of a marker are not part of it", () => {
		const text = `*.log\r\n${SECTION_START}  \r\n/a/\r\n\r\n*.png\r\n${SECTION_END} \r\nx\r\n`;
		expect(findSection(text)).toEqual({
			kind: "found",
			before: `*.log\r\n${SECTION_START}  \r\n`,
			lines: ["/a/", "", "*.png"],
			after: `${SECTION_END} \r\nx\r\n`,
		});
		expect(findSection("# >>> Sync Evo\r\n# <<< Sync Evo\r\n")).toMatchObject({ kind: "found", lines: [] });
	});

	test("a byte order mark in front of the first marker is skipped, and stays in the text before", () => {
		const text = `﻿${SECTION_START}\n/a/\n${SECTION_END}\n`;
		expect(findSection(text)).toEqual({
			kind: "found",
			before: `﻿${SECTION_START}\n`,
			lines: ["/a/"],
			after: `${SECTION_END}\n`,
		});
	});

	test.each([
		["a start without an end", `${SECTION_START}\n/a/\n*.log\n`],
		["a start as the last line", `*.log\n${SECTION_START}`],
		["two starts", `${SECTION_START}\n/a/\n${SECTION_START}\n/b/\n${SECTION_END}\n`],
		["two sections", `${SECTION_START}\n${SECTION_END}\n${SECTION_START}\n${SECTION_END}\n`],
		["the end before the start", `${SECTION_END}\n/a/\n${SECTION_START}\n`],
		["an end before a whole section", `${SECTION_END}\n${SECTION_START}\n/a/\n${SECTION_END}\n`],
		["an end alone", `/a/\n${SECTION_END}\n`],
	])("%s is a broken section", (_name, text) => {
		expect(findSection(text)).toEqual({ kind: "broken" });
		expect(findSection(text.replace(/\n/g, "\r\n"))).toEqual({ kind: "broken" });
		expect(() => withSection(text, ["/x/"])).toThrow(/broken/);
	});

	test("a second end after the section is left where it is, outside", () => {
		const text = `${SECTION_START}\n/a/\n${SECTION_END}\n*.log\n${SECTION_END}\n`;
		expect(findSection(text)).toMatchObject({ kind: "found", lines: ["/a/"], after: `${SECTION_END}\n*.log\n${SECTION_END}\n` });
	});
});

describe("the lines of a state", () => {
	test("the default state writes the list of the requirements, and no other list is kept", () => {
		expect(sectionLines(defaults, paths)).toEqual([
			"/.obsidian/community-plugins.json",
			"/.obsidian/plugins/",
			...FIXED,
		]);
		expect(sectionLines(defaults, paths)).toEqual(defaultSectionLines(paths));
		expect(fixedExclusions(paths).map((fixed) => fixed.line)).toEqual(FIXED);
	});

	test("with everything synced and no fixed exclusion the section is empty", () => {
		const all = state({ config: { "community-plugin-list": true, "community-plugins": true }, fixed: [] });
		expect(sectionLines(all, paths)).toEqual([]);
	});

	test("a kind that is off is one line for each of its extensions, and the configuration folder is taken out after them", () => {
		expect(sectionLines(state({ kinds: { pdf: false }, fixed: [] }), paths).slice(0, 2)).toEqual([
			"*.pdf",
			"!/.obsidian/**",
		]);
		const lines = sectionLines(state({ kinds: { image: false, video: false }, fixed: [], config: allConfigOn }), paths);
		expect(lines).toEqual([
			"*.bmp",
			"*.png",
			"*.jpg",
			"*.jpeg",
			"*.gif",
			"*.svg",
			"*.webp",
			"*.avif",
			"*.mp4",
			"*.ogv",
			"*.mov",
			"*.mkv",
			"!/.obsidian/**",
		]);
	});

	test("webm is left out only when both sound and picture are off", () => {
		const lines = (kinds: Partial<SectionState["kinds"]>): string[] => sectionLines(state({ kinds }), paths);
		expect(lines({ audio: false })).not.toContain("*.webm");
		expect(lines({ video: false })).not.toContain("*.webm");
		const both = lines({ audio: false, video: false });
		expect(both.slice(0, 14)).toEqual([
			"*.mp3",
			"*.wav",
			"*.m4a",
			"*.3gp",
			"*.flac",
			"*.ogg",
			"*.oga",
			"*.opus",
			"*.webm",
			"*.mp4",
			"*.ogv",
			"*.mov",
			"*.mkv",
			"!/.obsidian/**",
		]);
		// With "other" off it is kept while either of the two is on.
		expect(lines({ other: false, audio: false })).toContain("!*.webm");
		expect(lines({ other: false, video: false })).toContain("!*.webm");
		expect(lines({ other: false, audio: false, video: false })).not.toContain("!*.webm");
	});

	test('with "other" off everything is left out, and what is synced is brought back', () => {
		const lines = sectionLines(
			state({ kinds: { other: false, image: false, audio: false, video: false }, fixed: [], config: allConfigOn }),
			paths,
		);
		expect(lines).toEqual(["*", "!*/", "!.gitignore", "!*.md", "!*.canvas", "!*.base", "!*.pdf", "!/.obsidian/**"]);
	});

	test("the parts of the configuration folder that are off are named by their files and folders", () => {
		const lines = sectionLines(
			state({
				config: { "main-settings": false, "themes-and-snippets": false, "core-plugin-list": false },
				fixed: [],
			}),
			paths,
		);
		expect(lines).toEqual([
			"/.obsidian/app.json",
			"/.obsidian/types.json",
			"/.obsidian/themes/",
			"/.obsidian/snippets/",
			"/.obsidian/core-plugins.json",
			"/.obsidian/core-plugins-migration.json",
			"/.obsidian/community-plugins.json",
			"/.obsidian/plugins/",
		]);
	});

	test("with the settings of the core plugins off, every .json goes and the files of the parts that are on come back", () => {
		const lines = sectionLines(
			state({
				config: { "core-plugin-settings": false, appearance: false, "themes-and-snippets": false },
				fixed: [],
			}),
			paths,
		);
		expect(lines).toEqual([
			"/.obsidian/*.json",
			"!/.obsidian/app.json",
			"!/.obsidian/types.json",
			"!/.obsidian/hotkeys.json",
			"!/.obsidian/core-plugins.json",
			"!/.obsidian/core-plugins-migration.json",
			"/.obsidian/themes/",
			"/.obsidian/snippets/",
			"/.obsidian/plugins/",
		]);
	});

	test("the order is kinds, folders, configuration folder, fixed exclusions, unknown lines", () => {
		const lines = sectionLines(
			state({
				kinds: { pdf: false },
				folders: ["drafts", "notes/private"],
				fixed: ["*.icloud", "/.trash/"],
				unknown: ["# kept", "", "*.future", "   "],
			}),
			paths,
		);
		expect(lines).toEqual([
			"*.pdf",
			"!/.obsidian/**",
			"/drafts/",
			"/notes/private/",
			"/.obsidian/community-plugins.json",
			"/.obsidian/plugins/",
			// In the order of the default section, not the one they are given in.
			"/.trash/",
			"*.icloud",
			"# kept",
			"*.future",
		]);
	});

	test("a line two parts of the state ask for is written once", () => {
		const lines = sectionLines(state({ folders: [".trash", "drafts", "drafts", ".obsidian/plugins"] }), paths);
		expect(lines.filter((line) => line === "/.trash/")).toHaveLength(1);
		expect(lines.filter((line) => line === "/drafts/")).toHaveLength(1);
		expect(lines.filter((line) => line === "/.obsidian/plugins/")).toHaveLength(1);
		expect(sectionLines(readSectionState(lines, paths), paths)).toEqual(lines);
	});

	test("a folder that is the line of a switch or a fixed exclusion is read back as that", () => {
		const lines = sectionLines(state({ folders: [".trash", ".obsidian/themes"], fixed: [] }), paths);
		expect(lines.slice(0, 2)).toEqual(["/.trash/", "/.obsidian/themes/"]);
		const read = readSectionState(lines, paths);
		expect(read.folders).toEqual([]);
		expect(read.fixed).toEqual(["/.trash/"]);
		expect(read.config["themes-and-snippets"]).toBe(false);
		// Nothing that was left out is let in by the rewrite.
		expect(sectionLines(read, paths)).toEqual(expect.arrayContaining(lines));
	});
});

const allConfigOn = { "community-plugin-list": true, "community-plugins": true };

describe("the lines of a folder", () => {
	test("characters that mean something in .gitignore get a backslash, and lose it when read", () => {
		for (const [folder, line] of [
			["drafts", "/drafts/"],
			["notes/private", "/notes/private/"],
			["dra[f]ts", "/dra\\[f\\]ts/"],
			["a*b?", "/a\\*b\\?/"],
			["back\\slash", "/back\\\\slash/"],
			// Never at the start or the end of the line, so they need none.
			["!bang", "/!bang/"],
			["#hash", "/#hash/"],
			["end ", "/end /"],
			["下書き", "/下書き/"],
		] as const) {
			expect(folderLine(folder)).toBe(line);
			expect(folderOfLine(line)).toBe(folder);
			expect(unescaped(escaped(folder))).toBe(folder);
		}
	});

	test.each(["", "/drafts", "drafts/", "a//b", "./a", "a/..", "a\nb", "a\rb"])("%j is no folder to write", (folder) => {
		expect(() => folderLine(folder)).toThrow(/Not a folder/);
		expect(() => sectionLines(state({ folders: [folder] }), paths)).toThrow(/Not a folder/);
	});

	test.each([
		"drafts/",
		"/drafts",
		"!/drafts/",
		"/",
		"//",
		"/a//b/",
		"/dra*fts/",
		"/dra[f]ts/",
		"/what?/",
		"/**/",
		"/a/**/b/",
		"/needless\\!/",
		"/end\\/",
	])("%j is not the line of one folder", (line) => {
		expect(folderOfLine(line)).toBeNull();
		// And so it is kept as it is, and not written back with a backslash.
		expect(readSectionState([line], paths)).toMatchObject({ folders: [], unknown: [line] });
		expect(sectionLines(readSectionState([line], paths), paths)).toEqual([line]);
	});
});

describe("reading the state", () => {
	test("an empty section has everything synced and no fixed exclusion", () => {
		expect(readSectionState([], paths)).toEqual(state({ config: allConfigOn, fixed: [] }));
	});

	test("the default lines read as the default state", () => {
		expect(readSectionState(defaultSectionLines(paths), paths)).toEqual(defaults);
	});

	// Every switch on its own, a few together, and both forms of the two
	// switches that change how the others are written.
	const kindCases: Partial<SectionState["kinds"]>[] = [
		{},
		{ image: false },
		{ audio: false },
		{ video: false },
		{ pdf: false },
		{ audio: false, video: false },
		{ image: false, audio: false, video: false, pdf: false },
	];
	const configCases: Partial<SectionState["config"]>[] = [
		{},
		allConfigOn,
		{ "main-settings": false },
		{ appearance: false },
		{ "themes-and-snippets": false },
		{ hotkeys: false },
		{ "core-plugin-list": false },
		{ "community-plugin-list": true },
		{ "community-plugins": true },
		{ "main-settings": false, hotkeys: false, "themes-and-snippets": false, "community-plugins": true },
	];
	const states: SectionState[] = [];
	for (const other of [true, false]) {
		for (const kinds of kindCases) states.push(state({ kinds: { ...kinds, other } }));
		for (const coreSettings of [true, false]) {
			for (const config of configCases) {
				states.push(state({ kinds: { other }, config: { ...config, "core-plugin-settings": coreSettings } }));
			}
		}
	}
	states.push(
		state({ folders: ["drafts", "a*b/[c]", "end ", "下書き"], fixed: [".DS_Store", "/.trash/"].reverse() }),
		state({
			kinds: { other: false, pdf: false },
			config: { "core-plugin-settings": false, hotkeys: false },
			folders: ["drafts"],
			fixed: [],
			unknown: ["# from a later version", "*.future", "!/drafts/keep/"],
		}),
	);

	test.each(states.map((each) => [JSON.stringify({ ...each.kinds, ...each.config }), each] as const))(
		"written and read back, the state is the same, and written again so are the lines: %s",
		(_name, each) => {
			const lines = sectionLines(each, paths);
			const read = readSectionState(lines, paths);
			// The fixed exclusions come back in the order they are written in.
			expect(read).toEqual({ ...each, fixed: FIXED.filter((line) => each.fixed.includes(line)) });
			expect(sectionLines(read, paths)).toEqual(lines);
			expect(isHandEdited(lines, paths)).toBe(false);
			// Through a file as well.
			const text = withSection("*.log\n", lines);
			const found = findSection(text);
			expect(found.kind === "found" && readSectionState(found.lines, paths)).toEqual(read);
			expect(withSection(text, sectionLines(read, paths))).toBe(text);
		},
	);

	test("a kind with only some of its lines left is off", () => {
		expect(readSectionState(["*.png"], paths).kinds).toMatchObject({ image: false, audio: true, other: true });
		expect(readSectionState(["*.mkv", "!/.obsidian/**"], paths).kinds).toMatchObject({ video: false, audio: true });
		// With "other" off: one line that brings it back is missing.
		const otherOff = sectionLines(state({ kinds: { other: false } }), paths);
		expect(readSectionState(otherOff, paths).kinds).toEqual({ image: true, audio: true, video: true, pdf: true, other: false });
		const withoutGif = otherOff.filter((line) => line !== "!*.gif");
		expect(readSectionState(withoutGif, paths).kinds).toMatchObject({ image: false, audio: true, video: true, pdf: true });
		// Written again, the kind is off whole.
		const rewritten = sectionLines(readSectionState(withoutGif, paths), paths);
		expect(rewritten.filter((line) => /^!\*\.(bmp|png|jpg|jpeg|svg|webp|avif)$/.test(line))).toEqual([]);
		expect(isHandEdited(withoutGif, paths)).toBe(true);
	});

	test("a line that leaves a kind out counts, also where everything is left out already", () => {
		const lines = [...sectionLines(state({ kinds: { other: false } }), paths), "*.pdf"];
		expect(readSectionState(lines, paths).kinds).toMatchObject({ pdf: false, image: true });
		expect(readSectionState(lines, paths).unknown).toEqual([]);
	});

	test("the lines for webm are known and say nothing", () => {
		const read = readSectionState(["!*.webm"], paths);
		expect(read.kinds).toEqual({ image: true, audio: true, video: true, pdf: true, other: true });
		expect(read.unknown).toEqual([]);
		// So a state with both off writes one line for it, each time.
		const lines = sectionLines(state({ kinds: { audio: false, video: false } }), paths);
		const again = sectionLines(readSectionState(lines, paths), paths);
		expect(again.filter((line) => line === "*.webm")).toHaveLength(1);
	});

	test("a line that leaves webm out is kept while sound or picture is on", () => {
		// Put there by hand: dropped, the next switch would send the files.
		const read = readSectionState(["*.webm"], paths);
		expect(read.kinds).toMatchObject({ audio: true, video: true });
		expect(read.unknown).toEqual(["*.webm"]);
		expect(sectionLines(read, paths)).toEqual(["*.webm"]);
		expect(isHandEdited(["*.webm"], paths)).toBe(false);

		// Once both are off the state writes the line itself, and once.
		const both = sectionLines({ ...read, kinds: { ...read.kinds, audio: false, video: false } }, paths);
		expect(both.filter((line) => line === "*.webm")).toHaveLength(1);
		expect(readSectionState(both, paths).unknown).toEqual([]);
	});

	test("a part of the configuration folder with only some of its lines left is off", () => {
		expect(readSectionState(["/.obsidian/types.json"], paths).config).toMatchObject({ "main-settings": false });
		expect(readSectionState(["/.obsidian/snippets/"], paths).config).toMatchObject({ "themes-and-snippets": false });
		expect(readSectionState(["/.obsidian/core-plugins-migration.json"], paths).config).toMatchObject({
			"core-plugin-list": false,
			"core-plugin-settings": true,
		});
		// With the settings of the core plugins off: one line that brings a file back is missing.
		const off = sectionLines(state({ config: { "core-plugin-settings": false } }), paths);
		const withoutTypes = off.filter((line) => line !== "!/.obsidian/types.json");
		expect(readSectionState(withoutTypes, paths).config).toMatchObject({
			"main-settings": false,
			appearance: true,
			"core-plugin-list": true,
			"core-plugin-settings": false,
		});
		expect(sectionLines(readSectionState(withoutTypes, paths), paths)).not.toContain("!/.obsidian/app.json");
		expect(isHandEdited(withoutTypes, paths)).toBe(true);
	});

	test("lines for another name of the configuration folder are not known, and the folder lines among them are folders", () => {
		const read = readSectionState(["/.config/app.json", "/.config/plugins/", "!/.config/**"], paths);
		expect(read.config).toMatchObject({ "main-settings": true, "community-plugins": true });
		expect(read.folders).toEqual([".config/plugins"]);
		expect(read.unknown).toEqual(["/.config/app.json", "!/.config/**"]);
	});

	test("spaces at the end of a line are not part of the rule, as for git; an escaped one is", () => {
		const read = readSectionState(["*.pdf  ", "/drafts/ ", "/.trash/ ", "odd\\ "], paths);
		expect(read.kinds.pdf).toBe(false);
		expect(read.folders).toEqual(["drafts"]);
		expect(read.fixed).toEqual(["/.trash/"]);
		expect(read.unknown).toEqual(["odd\\ "]);
		expect(isHandEdited(["*.pdf  ", "!/.obsidian/**"], paths)).toBe(true);
	});

	test("a rule in another case is not the line of a switch", () => {
		const read = readSectionState(["*.PNG", "/.Obsidian/app.json"], paths);
		expect(read.kinds.image).toBe(true);
		expect(read.unknown).toEqual(["*.PNG", "/.Obsidian/app.json"]);
	});
});

describe("unknown lines", () => {
	const lines = ["# a note of a later version", "*.future", "", "/.trash/", "!/drafts/keep/", "*.future", "/dra*fts/"];

	test("they stay, in their order, after everything else, and without the empty lines", () => {
		const read = readSectionState(lines, paths);
		expect(read.unknown).toEqual(["# a note of a later version", "*.future", "!/drafts/keep/", "*.future", "/dra*fts/"]);
		expect(sectionLines(read, paths)).toEqual(["/.trash/", ...read.unknown]);
	});

	test("they do not grow in number, however often the section is rewritten", () => {
		let current: readonly string[] = lines;
		for (let round = 0; round < 3; round += 1) {
			const switched = { ...readSectionState(current, paths), folders: [`round-${round}`] };
			current = sectionLines(switched, paths);
			expect(current.filter((line) => line === "*.future")).toHaveLength(2);
			expect(current.filter((line) => line.startsWith("#"))).toHaveLength(1);
			expect(current.slice(-5)).toEqual(readSectionState(lines, paths).unknown);
		}
	});
});

describe("a section edited by hand", () => {
	test("the order alone does not count, nor an empty line", () => {
		const lines = sectionLines(state({ kinds: { pdf: false }, folders: ["drafts"], unknown: ["*.future"] }), paths);
		expect(isHandEdited(lines, paths)).toBe(false);
		expect(isHandEdited([...lines].reverse(), paths)).toBe(false);
		expect(isHandEdited(["", ...lines, "", " "], paths)).toBe(false);
		expect(isHandEdited([], paths)).toBe(false);
	});

	test("a line that a rewrite would add, drop, or write once does", () => {
		// The line that takes the configuration folder out is missing.
		expect(isHandEdited(["*.pdf"], paths)).toBe(true);
		// It is there without a line to undo.
		expect(isHandEdited(["!/.obsidian/**"], paths)).toBe(true);
		expect(isHandEdited(["*.png"], paths)).toBe(true);
		expect(isHandEdited(["!*.webm"], paths)).toBe(true);
		expect(isHandEdited(["/.trash/", "/.trash/"], paths)).toBe(true);
		expect(isHandEdited(["/drafts/", "/drafts/"], paths)).toBe(true);
	});

	test("unknown lines and deleted fixed exclusions do not", () => {
		expect(isHandEdited(["# note", "*.future", "*.future", "/dra*fts/"], paths)).toBe(false);
		expect(isHandEdited(defaultSectionLines(paths).filter((line) => line !== "/.trash/"), paths)).toBe(false);
	});
});

describe("the fixed exclusions", () => {
	const withoutTrash = defaultSectionLines(paths).filter((line) => line !== "/.trash/" && line !== ".DS_Store");

	test("a line that was deleted does not come back when a switch rewrites the section", () => {
		const read = readSectionState(withoutTrash, paths);
		expect(read.fixed).toEqual(FIXED.filter((line) => line !== "/.trash/" && line !== ".DS_Store"));
		const switched: SectionState = {
			...read,
			kinds: { ...read.kinds, image: false, other: false },
			config: { ...read.config, "core-plugin-settings": false, "community-plugins": true },
			folders: ["drafts"],
		};
		const lines = sectionLines(switched, paths);
		expect(lines).not.toContain("/.trash/");
		expect(lines).not.toContain(".DS_Store");
		expect(lines).toContain("/.obsidian/workspace.json");
		// The line of the plugin's own folder stays when all plugins are synced.
		expect(lines).toContain("/.obsidian/plugins/sync-evo/");
		expect(lines).not.toContain("/.obsidian/plugins/");
		expect(readSectionState(lines, paths).fixed).toEqual(read.fixed);
	});

	test("restoring puts every one of them back, and changes nothing else", () => {
		const read = { ...readSectionState(withoutTrash, paths), folders: ["drafts"], unknown: ["*.future"] };
		const restored = withFixedExclusions(read, paths);
		expect(restored).toEqual({ ...read, fixed: FIXED });
		expect(sectionLines(restored, paths)).toEqual([
			"/drafts/",
			"/.obsidian/community-plugins.json",
			"/.obsidian/plugins/",
			...FIXED,
			"*.future",
		]);
		expect(withFixedExclusions(restored, paths)).toEqual(restored);
	});

	test("each has a path it is there to leave out, of the type its line matches", () => {
		expect(fixedExclusions(paths).map((fixed) => [fixed.path, fixed.type])).toEqual([
			[".obsidian/workspace.json", "file"],
			[".obsidian/workspace-mobile.json", "file"],
			[".obsidian/plugins/sync-evo", "folder"],
			[".trash", "folder"],
			[".DS_Store", "file"],
			["._a.md", "file"],
			["Thumbs.db", "file"],
			["ehthumbs.db", "file"],
			["desktop.ini", "file"],
			["$RECYCLE.BIN", "folder"],
			[".a.md.icloud", "file"],
		]);
	});
});

describe("a configuration folder of another name", () => {
	const other = { configDir: "/.config[1]/", pluginDir: ".config[1]/plugins/sync-evo-beta" };

	test("every line that names it follows, with the backslashes the name needs", () => {
		const lines = sectionLines(
			{
				...defaultSectionState(other),
				kinds: { image: true, audio: true, video: true, pdf: false, other: false },
				config: {
					...defaultSectionState(other).config,
					"core-plugin-settings": false,
					"themes-and-snippets": false,
					hotkeys: false,
				},
			},
			other,
		);
		expect(lines.filter((line) => line.includes("config"))).toEqual([
			"!/.config\\[1\\]/**",
			"/.config\\[1\\]/*.json",
			"!/.config\\[1\\]/app.json",
			"!/.config\\[1\\]/types.json",
			"!/.config\\[1\\]/appearance.json",
			"!/.config\\[1\\]/core-plugins.json",
			"!/.config\\[1\\]/core-plugins-migration.json",
			"/.config\\[1\\]/themes/",
			"/.config\\[1\\]/snippets/",
			"/.config\\[1\\]/plugins/",
			"/.config\\[1\\]/workspace.json",
			"/.config\\[1\\]/workspace-mobile.json",
			"/.config\\[1\\]/plugins/sync-evo-beta/",
		]);
		expect(lines.some((line) => line.includes(".obsidian"))).toBe(false);
		const read = readSectionState(lines, other);
		expect(read.config).toMatchObject({ "core-plugin-settings": false, hotkeys: false, appearance: true });
		expect(read.kinds).toMatchObject({ pdf: false, other: false, image: true });
		expect(read.folders).toEqual([]);
		expect(read.unknown).toEqual([]);
		expect(sectionLines(read, other)).toEqual(lines);
	});

	test("the lines of .obsidian mean nothing to it", () => {
		const read = readSectionState(defaultSectionLines(paths), other);
		expect(read.config).toMatchObject({ "community-plugin-list": true, "community-plugins": true });
		expect(read.folders).toEqual([".obsidian/plugins", ".obsidian/plugins/sync-evo"]);
		expect(read.unknown).toEqual([
			"/.obsidian/community-plugins.json",
			"/.obsidian/workspace.json",
			"/.obsidian/workspace-mobile.json",
		]);
	});
});

describe("writing the section into a text", () => {
	const lines = ["/drafts/", "*.icloud"];

	test("without a .gitignore the file is the section, with line ends of Unix", () => {
		const text = `${SECTION_START}\n/drafts/\n*.icloud\n${SECTION_END}\n`;
		expect(withSection(null, lines)).toBe(text);
		expect(withSection("", lines)).toBe(text);
		expect(withSection(null, [])).toBe(`${SECTION_START}\n${SECTION_END}\n`);
	});

	test.each([
		["line ends of Unix", "*.log\n!keep.log\n", "\n"],
		["line ends of Windows", "*.log\r\n!keep.log\r\n", "\r\n"],
		["no line end at the end", "*.log\n!keep.log", "\n"],
		["no line end at all", "*.log", "\n"],
		["one line of Windows without a line end after it", "*.log\r\n!keep.log", "\r\n"],
		["a byte order mark", "﻿*.log\n", "\n"],
		["a byte order mark and line ends of Windows", "﻿*.log\r\n\r\n# x \r\n", "\r\n"],
		["only a byte order mark", "﻿", "\n"],
		["empty lines and spaces", "\n\n  *.log  \n\t\n", "\n"],
	])("without a section it goes on top, and the rest is the same to the byte: %s", (_name, text, lineEnd) => {
		const bom = text.startsWith("﻿") ? "﻿" : "";
		const rest = text.slice(bom.length);
		const written = withSection(text, lines);
		const section = [SECTION_START, ...lines, SECTION_END].map((line) => `${line}${lineEnd}`).join("");
		expect(written).toBe(`${bom}${section}${rest}`);
		// Written again, and with other lines and back, nothing else moves.
		expect(withSection(written, lines)).toBe(written);
		expect(withSection(withSection(written, ["*.png"]), lines)).toBe(written);
		expect(withSection(written, [])).toBe(`${bom}${SECTION_START}${lineEnd}${SECTION_END}${lineEnd}${rest}`);
		expect(findSection(written)).toMatchObject({ kind: "found", lines });
	});

	test.each([
		["at the top", "", "*.log\n"],
		["in the middle", "# mine\n*.log\n", "\n!keep.log\n"],
		["at the end", "*.log\n", ""],
		["after a byte order mark", "﻿", "*.log\n"],
		["after a byte order mark and a rule", "﻿*.log\n", "x"],
	])("a section that is there is replaced where it stands: %s", (_name, before, after) => {
		for (const lineEnd of ["\n", "\r\n"]) {
			const outside = (text: string): string => text.replace(/\n/g, lineEnd);
			// The markers as another version wrote them, with spaces after them.
			const start = `# >>> Sync Evo: another wording  ${lineEnd}`;
			for (const end of [`# <<< Sync Evo ${lineEnd}`, "# <<< Sync Evo"]) {
				if (!end.endsWith(lineEnd) && after !== "") continue;
				const text = `${outside(before)}${start}/old/${lineEnd}${lineEnd}*.gone${lineEnd}${end}${outside(after)}`;
				const written = withSection(text, lines);
				expect(written).toBe(`${outside(before)}${start}/drafts/${lineEnd}*.icloud${lineEnd}${end}${outside(after)}`);
				expect(withSection(written, lines)).toBe(written);
				expect(withSection(written, [])).toBe(`${outside(before)}${start}${end}${outside(after)}`);
			}
		}
	});

	test("the line end is the first one of the file", () => {
		const text = `*.log\r\n${SECTION_START}\n${SECTION_END}\n`;
		expect(withSection(text, ["/a/"])).toBe(`*.log\r\n${SECTION_START}\n/a/\r\n${SECTION_END}\n`);
	});

	test("a switch changes the section and nothing outside it", () => {
		const before = "﻿# my rules\r\n*.log\r\n";
		const after = "!/.obsidian/workspace.json\r\n  \r\nlast";
		const section = defaultSectionLines(paths).map((line) => `${line}\r\n`).join("");
		const text = `${before}${SECTION_START}\r\n${section}${SECTION_END}\r\n${after}`;
		const found = findSection(text);
		if (found.kind !== "found") throw new Error("no section");
		const read = readSectionState(found.lines, paths);
		expect(read).toEqual(defaults);
		const written = withSection(text, sectionLines({ ...read, folders: ["drafts"] }, paths));
		expect(written.startsWith(`${before}${SECTION_START}\r\n/drafts/\r\n/.obsidian/community-plugins.json\r\n`)).toBe(true);
		expect(written.endsWith(`*.icloud\r\n${SECTION_END}\r\n${after}`)).toBe(true);
		expect(written.length).toBe(text.length + "/drafts/\r\n".length);
		// And back.
		expect(withSection(written, sectionLines(read, paths))).toBe(text);
	});
});
