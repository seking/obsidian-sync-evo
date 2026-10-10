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

// The section Sync Evo keeps in the root `.gitignore`: finding it in the
// text, reading the state of the switches of the settings from its lines,
// and writing the lines of a state back. The state is stored nowhere else,
// so that a device that pulls the file shows the same switches.
//
// Nothing here reads or writes a file, and nothing here decides what is
// synced: the text is handed in and a text is handed back, and the rules are
// applied in `exclusion.ts`, by the lines alone.

import type { ExclusionPaths, PathType } from "./exclusion";
import { isPathFromRoot } from "./paths";

/**
 * The two lines that mark the section. Every device shares them, and builds
 * of different versions meet in one file, so the text is never changed. Only
 * the start of each is looked at (`findSection`); the rest is for the reader.
 */
export const SECTION_START =
	"# >>> Sync Evo: managed section. Do not edit these lines by hand; change them in the Sync Evo settings. >>>";
export const SECTION_END = "# <<< Sync Evo: end of managed section <<<";

// What a marker is told by. After it comes a `:`, a blank, or the end of the
// line, so that `# >>> Sync Evo Pro` is the marker of something else. A CR
// or a space at the end of the line is a blank like any other.
const START_MARK = /^# >>> Sync Evo(?:[:\s]|$)/;
const END_MARK = /^# <<< Sync Evo(?:[:\s]|$)/;

const BOM = "﻿";

export type SectionSearch =
	/** No marker at all. */
	| { readonly kind: "none" }
	/**
	 * One section. `before` runs to the end of the line of the first marker
	 * and `after` starts at the second, so the markers stay as they are
	 * written, whatever version wrote them. `lines` are the lines between,
	 * without their line ends.
	 */
	| { readonly kind: "found"; readonly before: string; readonly lines: readonly string[]; readonly after: string }
	/**
	 * Markers that do not enclose one section: a start without an end after
	 * it, more than one start, or an end before the start. Nothing is
	 * guessed from these. Taking the rest of the file for the section would
	 * rewrite rules the user wrote.
	 */
	| { readonly kind: "broken" };

/**
 * Looks for the section in the text of a `.gitignore`. It need not be at the
 * top: a section the user moved is still the section, where it is.
 */
export function findSection(text: string): SectionSearch {
	// Git skips a byte order mark, and so the first line is read without it.
	const top = text.startsWith(BOM) ? BOM.length : 0;
	let starts = 0;
	let ends = 0;
	let afterStart = -1;
	let end = -1;
	let endCameFirst = false;
	for (let from = top; from < text.length; ) {
		const newline = text.indexOf("\n", from);
		const next = newline === -1 ? text.length : newline + 1;
		const line = text.slice(from, next);
		if (START_MARK.test(line)) {
			starts += 1;
			afterStart = next;
		} else if (END_MARK.test(line)) {
			ends += 1;
			if (starts === 0) endCameFirst = true;
			else if (end === -1) end = from;
		}
		from = next;
	}
	if (starts === 0 && ends === 0) return { kind: "none" };
	if (starts !== 1 || endCameFirst || end === -1) return { kind: "broken" };
	// Every line between the markers ends with a line end, since the second
	// marker comes after it.
	const lines = text
		.slice(afterStart, end)
		.split("\n")
		.slice(0, -1)
		.map((line) => line.replace(/\r$/, ""));
	return { kind: "found", before: text.slice(0, afterStart), lines, after: text.slice(end) };
}

/**
 * The text with these lines as its section. A section that is there is
 * replaced where it stands; without one, the section is put at the top, so
 * that the rules the user wrote come later and win. Not one byte outside the
 * section changes, the two markers of a section that is there included.
 *
 * The lines get the line end the file already uses, so that a file from
 * Windows does not end up with both. A byte order mark stays the first thing
 * in the file. `null` is a vault without a `.gitignore`.
 *
 * A broken section is a mistake of the caller and throws: there is no place
 * to write to that could not be a rule of the user.
 */
export function withSection(text: string | null, lines: readonly string[]): string {
	const current = text ?? "";
	const found = findSection(current);
	if (found.kind === "broken") throw new Error("The section of .gitignore is broken; nothing can be written into it");
	const lineEnd = lineEndOf(current);
	const body = lines.map((line) => `${line}${lineEnd}`).join("");
	if (found.kind === "found") return `${found.before}${body}${found.after}`;
	const bom = current.startsWith(BOM) ? BOM : "";
	return `${bom}${SECTION_START}${lineEnd}${body}${SECTION_END}${lineEnd}${current.slice(bom.length)}`;
}

// The first line end decides. A file that mixes the two has no line end of
// its own, and either choice is as good.
function lineEndOf(text: string): "\n" | "\r\n" {
	const newline = text.indexOf("\n");
	return newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
}

/** The kinds of file the settings switch, as the official Sync has them. */
export type FileKind = "image" | "audio" | "video" | "pdf" | "other";

/** The parts of the configuration folder the settings switch, in the order of the official Sync. */
export type ConfigItem =
	| "main-settings"
	| "appearance"
	| "themes-and-snippets"
	| "hotkeys"
	| "core-plugin-list"
	| "core-plugin-settings"
	| "community-plugin-list"
	| "community-plugins";

/**
 * What the section says, as the settings show it. `true` is "synced": the
 * section only ever lists what is left out.
 */
export interface SectionState {
	readonly kinds: Readonly<Record<FileKind, boolean>>;
	/** The folders that are not synced, from the vault root, as they are named (no `\`). */
	readonly folders: readonly string[];
	readonly config: Readonly<Record<ConfigItem, boolean>>;
	/**
	 * The lines of `fixedExclusions` the section holds. One the user deleted
	 * is not in here, and so is not written back by a switch.
	 */
	readonly fixed: readonly string[];
	/**
	 * Lines that are none of the above, comments included, in their order.
	 * A later version may have written them, so they are kept.
	 */
	readonly unknown: readonly string[];
}

// The extensions that belong to one kind alone, in the order of the
// requirements. `webm` is both sound and picture, so it belongs to neither
// and stands between them: it is left out only when both kinds are.
const KIND_EXTENSIONS: readonly (readonly [Exclude<FileKind, "other">, readonly string[]])[] = [
	["image", ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"]],
	["audio", ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"]],
	["video", ["mp4", "ogv", "mov", "mkv"]],
	["pdf", ["pdf"]],
];
const SHARED_EXTENSION = "webm";
// `webm` is written after the last extension of this kind.
const SHARED_EXTENSION_AFTER: FileKind = "audio";

// What stays synced when "other" is off, whatever else is switched: the
// folders (git does not look inside a folder it left out, so nothing below
// could be brought back), the `.gitignore` itself, and the notes.
const ALL = "*";
const KEPT_WHEN_OTHER_IS_OFF: readonly string[] = ["!*/", "!.gitignore", "!*.md", "!*.canvas", "!*.base"];

// The files and folders of each part of the configuration folder. The
// settings of the core plugins have none: they are every other `.json`
// directly in the folder.
const CONFIG_ITEMS: readonly {
	readonly item: ConfigItem;
	readonly files?: readonly string[];
	readonly folders?: readonly string[];
}[] = [
	{ item: "main-settings", files: ["app.json", "types.json"] },
	{ item: "appearance", files: ["appearance.json"] },
	{ item: "themes-and-snippets", folders: ["themes", "snippets"] },
	{ item: "hotkeys", files: ["hotkeys.json"] },
	{ item: "core-plugin-list", files: ["core-plugins.json", "core-plugins-migration.json"] },
	{ item: "core-plugin-settings" },
	{ item: "community-plugin-list", files: ["community-plugins.json"] },
	{ item: "community-plugins", folders: ["plugins"] },
];

/** One line of the section that no switch stands for. */
export interface FixedExclusion {
	/** The line, as it is written in the section. */
	readonly line: string;
	/**
	 * A path the line is there to leave out, to ask the rules whether it
	 * still does. One at the root is enough for the lines that match in
	 * every folder.
	 */
	readonly path: string;
	readonly type: PathType;
}

/**
 * The fixed exclusions, in the order they are written: the layout of the
 * workspace, Sync Evo's own folder, the trash, and what operating systems
 * leave behind.
 *
 * Lines inside the configuration folder are written from the root, with its
 * name: a bare `workspace.json` would match a file of that name anywhere in
 * the vault. The lines for the operating systems have no `/` in front, so
 * that they match in every folder. `.git/` is not listed; git leaves it out
 * by itself, and so does `hardExclusionOf`.
 */
export function fixedExclusions(paths: ExclusionPaths): FixedExclusion[] {
	const config = trimSlashes(paths.configDir);
	const own = trimSlashes(paths.pluginDir);
	return [
		{ line: `/${escaped(config)}/workspace.json`, path: `${config}/workspace.json`, type: "file" },
		{ line: `/${escaped(config)}/workspace-mobile.json`, path: `${config}/workspace-mobile.json`, type: "file" },
		{ line: `/${escaped(own)}/`, path: own, type: "folder" },
		{ line: "/.trash/", path: ".trash", type: "folder" },
		{ line: ".DS_Store", path: ".DS_Store", type: "file" },
		{ line: "._*", path: "._a.md", type: "file" },
		{ line: "Thumbs.db", path: "Thumbs.db", type: "file" },
		{ line: "ehthumbs.db", path: "ehthumbs.db", type: "file" },
		{ line: "desktop.ini", path: "desktop.ini", type: "file" },
		{ line: "$RECYCLE.BIN/", path: "$RECYCLE.BIN", type: "folder" },
		{ line: "*.icloud", path: ".a.md.icloud", type: "file" },
	];
}

/**
 * The state of a section nothing has been switched in: everything is synced
 * but the two parts of the configuration folder that are off by default, and
 * every fixed exclusion is there.
 */
export function defaultSectionState(paths: ExclusionPaths): SectionState {
	return {
		kinds: { image: true, audio: true, video: true, pdf: true, other: true },
		folders: [],
		config: {
			"main-settings": true,
			appearance: true,
			"themes-and-snippets": true,
			hotkeys: true,
			"core-plugin-list": true,
			"core-plugin-settings": true,
			"community-plugin-list": false,
			"community-plugins": false,
		},
		fixed: fixedExclusions(paths).map((fixed) => fixed.line),
		unknown: [],
	};
}

/**
 * The state with every fixed exclusion in it: what "restore" in the settings
 * writes. The lines that are there stay; the ones that were deleted come
 * back. A line that a `!` outside the section undoes is not helped by this.
 */
export function withFixedExclusions(state: SectionState, paths: ExclusionPaths): SectionState {
	return { ...state, fixed: fixedExclusions(paths).map((fixed) => fixed.line) };
}

/**
 * The lines of the section for a state, in the one order they are written
 * in: the kinds, the folders, the parts of the configuration folder, the
 * fixed exclusions, and last the lines that are not known. In git the later
 * line wins, so the lines for the kinds do not reach into the configuration
 * folder (the `!` after them undoes that), and the lines after do.
 *
 * A line is written once, though two parts of the state ask for it (a
 * folder of the list that is also a fixed exclusion): reading it back finds
 * it once, and writing that must change nothing. It is written at the later
 * of its places, which is where it is read from.
 */
export function sectionLines(state: SectionState, paths: ExclusionPaths): string[] {
	const config = `/${escaped(trimSlashes(paths.configDir))}`;
	const insideConfig = `!${config}/**`;
	const kinds: string[] = [];
	const known: string[] = [];

	if (state.kinds.other) {
		const off = kindLines(state, "*.", (synced) => !synced);
		kinds.push(...off);
		// Only with a line to undo: an empty section stays empty.
		if (off.length > 0) kinds.push(insideConfig);
	} else {
		kinds.push(ALL, ...KEPT_WHEN_OTHER_IS_OFF, ...kindLines(state, "!*.", (synced) => synced), insideConfig);
	}

	if (state.config["core-plugin-settings"]) {
		for (const { item, files = [], folders = [] } of CONFIG_ITEMS) {
			if (state.config[item]) continue;
			known.push(...files.map((file) => `${config}/${file}`), ...folders.map((folder) => `${config}/${folder}/`));
		}
	} else {
		// Every `.json` directly in the folder goes, and the files of the
		// parts that are on come back. A folder is not a `.json`, so the
		// folders of the parts that are off are still named.
		known.push(`${config}/*.json`);
		for (const { item, files = [] } of CONFIG_ITEMS) {
			if (state.config[item]) known.push(...files.map((file) => `!${config}/${file}`));
		}
		for (const { item, folders = [] } of CONFIG_ITEMS) {
			if (!state.config[item]) known.push(...folders.map((folder) => `${config}/${folder}/`));
		}
	}

	const kept = new Set(state.fixed);
	known.push(...fixedExclusions(paths).flatMap((fixed) => (kept.has(fixed.line) ? [fixed.line] : [])));

	const folders = new Set(state.folders.map(folderLine).filter((line) => !known.includes(line)));
	const written = new Set([...kinds, ...folders, ...known]);
	// Not a second time: the line for `webm` is kept as unknown while only
	// one of sound and picture is off, and is written above once both are.
	return [...written, ...state.unknown.filter((line) => !isBlank(line) && !written.has(line))];
}

// One line for each extension of the kinds `wanted` picks, with `webm` when
// it picks both sound and picture ("*.": both off) or either ("!*.": one on).
function kindLines(state: SectionState, prefix: "*." | "!*.", wanted: (synced: boolean) => boolean): string[] {
	const shared = prefix === "*." ? !state.kinds.audio && !state.kinds.video : state.kinds.audio || state.kinds.video;
	const lines: string[] = [];
	for (const [kind, extensions] of KIND_EXTENSIONS) {
		if (wanted(state.kinds[kind])) lines.push(...extensions.map((extension) => `${prefix}${extension}`));
		if (kind === SHARED_EXTENSION_AFTER && shared) lines.push(`${prefix}${SHARED_EXTENSION}`);
	}
	return lines;
}

/**
 * Reads the state from the lines of a section.
 *
 * Where the lines of one switch are only partly there, it is read as off.
 * Read as on, the next switch would write the section without the lines that
 * are left, and what the user had left out would be sent by the next push.
 * Read as off, more is left out than before, which sends nothing and is
 * undone by switching it on. For the same reason a line that leaves a kind
 * or a part out counts in either form of the section, also where the form
 * the section is in would not have written it.
 *
 * The two lines for `webm` are known and say nothing: whether it is left
 * out follows from sound and picture. One exception, on the side of leaving
 * out: a `*.webm` that the state would not write (sound or picture is on)
 * was put there by hand, and is kept as an unknown line. Dropped, the next
 * switch would send the files it left out.
 */
export function readSectionState(lines: readonly string[], paths: ExclusionPaths): SectionState {
	const config = `/${escaped(trimSlashes(paths.configDir))}`;
	const fixedLines = fixedExclusions(paths).map((fixed) => fixed.line);

	const known = new Set<string>([
		ALL,
		...KEPT_WHEN_OTHER_IS_OFF,
		`*.${SHARED_EXTENSION}`,
		`!*.${SHARED_EXTENSION}`,
		`!${config}/**`,
		`${config}/*.json`,
		...fixedLines,
	]);
	for (const [, extensions] of KIND_EXTENSIONS) {
		for (const extension of extensions) known.add(`*.${extension}`).add(`!*.${extension}`);
	}
	for (const { files = [], folders = [] } of CONFIG_ITEMS) {
		for (const file of files) known.add(`${config}/${file}`).add(`!${config}/${file}`);
		for (const folder of folders) known.add(`${config}/${folder}/`);
	}

	const present = new Set<string>();
	const folders: string[] = [];
	const unknown: string[] = [];
	for (const line of lines) {
		if (isBlank(line)) continue;
		// Git does not count spaces at the end of a line. No line that is
		// known ends with one that is escaped.
		const rule = line.replace(/ +$/, "");
		if (known.has(rule)) {
			present.add(rule);
			continue;
		}
		const folder = folderOfLine(rule);
		if (folder === null) unknown.push(line);
		else if (!folders.includes(folder)) folders.push(folder);
	}

	const otherOn = !present.has(ALL);
	const coreSettingsOn = !present.has(`${config}/*.json`);
	const kinds: Record<FileKind, boolean> = { image: true, audio: true, video: true, pdf: true, other: otherOn };
	for (const [kind, extensions] of KIND_EXTENSIONS) {
		kinds[kind] =
			!extensions.some((extension) => present.has(`*.${extension}`)) &&
			(otherOn || extensions.every((extension) => present.has(`!*.${extension}`)));
	}
	const items = {} as Record<ConfigItem, boolean>;
	for (const { item, files = [], folders: itemFolders = [] } of CONFIG_ITEMS) {
		items[item] =
			!files.some((file) => present.has(`${config}/${file}`)) &&
			!itemFolders.some((folder) => present.has(`${config}/${folder}/`)) &&
			(coreSettingsOn || files.every((file) => present.has(`!${config}/${file}`)));
	}
	items["core-plugin-settings"] = coreSettingsOn;
	const leavesShared = `*.${SHARED_EXTENSION}`;
	if (present.has(leavesShared) && (kinds.audio || kinds.video)) unknown.push(leavesShared);

	return { kinds, folders, config: items, fixed: fixedLines.filter((line) => present.has(line)), unknown };
}

/**
 * Whether the lines are not what Sync Evo would write for the state it reads
 * from them: someone edited the section by hand, and the next switch will
 * rewrite it.
 *
 * Only which lines there are is compared, not their order. A line of a kind
 * that a later version adds is an unknown line to this one, which puts it
 * last; compared by order, the section would count as edited for as long as
 * the two versions share the file. Empty lines are not compared either.
 */
export function isHandEdited(lines: readonly string[], paths: ExclusionPaths): boolean {
	const current = lines.filter((line) => !isBlank(line)).sort();
	const written = sectionLines(readSectionState(lines, paths), paths).sort();
	return current.length !== written.length || current.some((line, index) => line !== written[index]);
}

/**
 * The line that leaves a folder out: from the root, since `drafts/` would
 * also match `notes/drafts/`, and with a `/` at the end, so that it is no
 * file of that name.
 *
 * A path that is not one from the vault root, or that has a line end in it,
 * is a mistake of the caller and throws. The second would end the line, and
 * the rest of the name would be read as a rule of its own.
 */
export function folderLine(folder: string): string {
	if (!isPathFromRoot(folder) || /[\r\n]/.test(folder)) {
		throw new Error(`Not a folder a line of .gitignore can name: ${JSON.stringify(folder)}`);
	}
	return `/${escaped(folder)}/`;
}

/**
 * The folder a line leaves out, as it is named, or `null` when the line is
 * not one `folderLine` writes. A line with a wildcard that is not escaped
 * (`/dra*fts/`) names no one folder; written back from a name it would get a
 * `\` and stop matching what it matched.
 */
export function folderOfLine(line: string): string | null {
	if (!line.startsWith("/") || !line.endsWith("/") || line.length < 3) return null;
	const body = line.slice(1, -1);
	const folder = unescaped(body);
	return isPathFromRoot(folder) && escaped(folder) === body ? folder : null;
}

/**
 * A path as a line of `.gitignore` names it: the characters that mean
 * something there get a `\` in front. A `!` or `#` only means something at
 * the start of a line and a space only at its end; every line built here
 * starts with `/` and ends with `/` or a fixed name, so neither can be at
 * those places.
 */
export function escaped(path: string): string {
	return path.replace(/[\\[\]*?]/g, "\\$&");
}

/** The path a line names: `escaped`, undone. */
export function unescaped(pattern: string): string {
	return pattern.replace(/\\(.)/g, "$1");
}

export function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

// A line of spaces is no rule to git, like an empty one.
function isBlank(line: string): boolean {
	return /^ *$/.test(line);
}
