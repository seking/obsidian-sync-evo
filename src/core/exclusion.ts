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

// What is left out of the sync. The one place that decides it: the scan of
// the vault and the sync decision both ask here, so that a first fetch, a
// pull, and a push can never disagree about a path.
//
// There are two layers. The rules are the user's: the `.gitignore` at the
// vault root, read the way git reads it, and applied only to paths the
// remote does not hold. Below them is a floor of two things no rule can
// change. Nothing here reads or writes a file; the text of `.gitignore` is
// handed in.
//
// Only the root `.gitignore` is read. One in a subfolder is an ordinary file
// and its rules have no effect. Reading those too would change the input of
// `createExclusion` and what `matchesRule` does with it, and nothing outside
// this file.

import ignore from "ignore";
import { originalPathOfConflictCopy } from "./conflict-name";
import { foldedKey, isPathFromRoot, pathKey } from "./paths";

/**
 * A folder is told from a file by the caller, since nothing here looks at a
 * disk: a rule such as `/drafts/` only matches a folder.
 */
export type PathType = "file" | "folder";

/**
 * The two things that are never synced, whatever the rules say and whatever
 * the remote holds: never read, written, sent, or deleted.
 *
 * - "dot-git": a `.git` at any depth and everything below it. It is not
 *   content of the vault, and a git host does not take it.
 * - "own-folder": the folder Sync Evo itself is installed in. Writing the
 *   `main.js` of another device there would be the plugin updating itself.
 */
export type HardExclusion = "dot-git" | "own-folder";

/** What the app knows about the vault that the exclusion depends on. */
export interface ExclusionPaths {
	/** The name of the configuration folder; `.obsidian` unless the user changed it. */
	readonly configDir: string;
	/** The folder of this plugin, from the vault root. */
	readonly pluginDir: string;
}

export interface ExclusionInput extends ExclusionPaths {
	/** The text of the `.gitignore` at the vault root, or `null` when there is none. */
	readonly gitignore: string | null;
}

export interface Exclusion {
	/** Which of the two fixed exclusions `path` falls under, if any. */
	hardExclusionOf(path: string): HardExclusion | undefined;

	/**
	 * Whether a rule matches `path`, as `git check-ignore` would answer for
	 * a path git does not track. This alone does not exclude anything; see
	 * `excludes`.
	 *
	 * - A copy kept from a conflict is judged by the name of the file it is
	 *   a copy of.
	 * - The root `.gitignore` itself never matches: it is always synced.
	 * - Upper and lower case are not told apart, anywhere in the path.
	 */
	matchesRule(path: string, type: PathType): boolean;

	/**
	 * Whether `path` is left out of the sync. A path that is known (on the
	 * remote, or with a record) is synced even when a rule matches it, the
	 * way git keeps tracking a file that is added to `.gitignore` later.
	 * Only the two fixed exclusions do not care.
	 *
	 * A copy kept from a conflict is new by nature. It is synced when the
	 * file it is a copy of is on the remote, whatever the rules say:
	 * otherwise the copy of a tracked file that a rule matches (`drafts/a.md`
	 * after `/drafts/` was added, a tracked `img.png` under `*.png`) would
	 * never reach the other devices. A record of that file is not enough.
	 * Once the remote has deleted it, the file is on its way out, and its
	 * copy is like any other new file a rule matches. For a copy of a copy
	 * it is the first file that is asked about, as for the rule.
	 *
	 * A copy of a file inside the configuration folder is left out, unless
	 * it is known itself. No pull makes such a copy (`isInConfigDir`); one
	 * that an earlier version made stays on the device, and is not sent.
	 */
	excludes(path: string, type: PathType, known: KnownPaths): boolean;
}

/**
 * What the remote holds and what has a record, as far as the exclusion
 * needs to ask. Both questions take NFC keys.
 */
export interface KnownPaths {
	/**
	 * For a file: whether it is on the remote or has a record. For a folder:
	 * whether any path below it is or has.
	 */
	has(key: string, type: PathType): boolean;
	/** Whether the remote holds this file. A record does not count. */
	onRemote(key: string): boolean;
}

/**
 * The known paths of a remote listing and the records. The scan and the
 * sync decision both get theirs from here, and from both lists at once, so
 * that neither can go by the remote alone or by the records alone.
 *
 * Asked without regard to case, so that a folder the vault spells `Drafts`
 * counts as holding the remote's `drafts/a.md`. Taking a path for known by
 * mistake only means it is looked at; leaving out a file that is synced
 * would look like the user deleting it.
 */
export function knownPaths(
	remote: readonly { readonly path: string }[],
	records: readonly { readonly path: string }[],
): KnownPaths {
	const onRemote = new Set<string>();
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const [entries, isRemote] of [
		[remote, true],
		[records, false],
	] as const) {
		for (const entry of entries) {
			const key = foldedKey(entry.path);
			if (isRemote) onRemote.add(key);
			files.add(key);
			for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
				folders.add(key.slice(0, slash));
			}
		}
	}
	return {
		has: (key, type) => (type === "folder" ? folders : files).has(foldedKey(key)),
		onRemote: (key) => onRemote.has(foldedKey(key)),
	};
}

/**
 * Every method takes a path from the vault root, in any normalization. A
 * path that is not one (empty, starting or ending with `/`, with a `.` or
 * `..` part) is a mistake of the caller and throws: `ignore` would refuse
 * some of them, and guessing what was meant could exclude the wrong file.
 */
export function createExclusion(input: ExclusionInput): Exclusion {
	// The case is stated rather than left to the default of the library:
	// `*.png` has to match `IMG_1.PNG`, as it does for git on a Mac.
	const rules = ignore({ ignorecase: true }).add(effectiveRules(input.gitignore, defaultSectionLines(input)));
	const ownFolder = foldedKey(checkedKey(trimSlashes(input.pluginDir)));

	// Compared without case, unlike the keys of the three sides. On a file
	// system that does not tell the cases apart `.GIT` is `.git`, and taking
	// a folder for one of these two by mistake only means it is not synced.
	const hardExclusionOf = (path: string): HardExclusion | undefined => {
		const folded = foldedKey(checkedKey(path));
		if (folded.split("/").includes(".git")) return "dot-git";
		if (folded === ownFolder || folded.startsWith(`${ownFolder}/`)) return "own-folder";
		return undefined;
	};

	const matchesRule = (path: string, type: PathType): boolean => {
		const subject = type === "file" ? withoutConflictNames(checkedKey(path)) : checkedKey(path);
		if (subject === ROOT_GITIGNORE) return false;
		// `ignore` looks at no disk. The slash at the end is what tells it
		// that this is a folder.
		return rules.ignores(type === "folder" ? `${subject}/` : subject);
	};

	return {
		hardExclusionOf,
		matchesRule,
		excludes: (path, type, known) => {
			if (hardExclusionOf(path) !== undefined) return true;
			const key = checkedKey(path);
			if (known.has(key, type)) return false;
			if (type === "file") {
				const original = withoutConflictNames(key);
				if (original !== key) {
					if (isInConfigDir(original, input.configDir)) return true;
					if (known.onRemote(original)) return false;
				}
			}
			return matchesRule(path, type);
		},
	};
}

/**
 * Whether `path` is inside the configuration folder, at any depth. A file
 * there is the app's or a plugin's and not a note, so what the vault has of
 * it is never kept as a copy of a conflict: the copy would be read by nothing
 * and sent to every device. Where a copy would be made, the content goes to
 * the `.trash/` of the vault instead (`pull-apply.ts`).
 *
 * Without the cases, like the two fixed exclusions: most vaults are on a
 * file system that does not tell them apart.
 */
export function isInConfigDir(path: string, configDir: string): boolean {
	const config = foldedKey(trimSlashes(configDir));
	return config !== "" && foldedKey(path).startsWith(`${config}/`);
}

/**
 * The lines of the section Sync Evo keeps at the top of `.gitignore`, as
 * they are when nothing has been switched: the two parts of the
 * configuration folder that are off by default, then the fixed exclusions
 * (the layout of the workspace, Sync Evo's own folder, the trash, and what
 * operating systems leave behind).
 *
 * Lines inside the configuration folder are written from the root, with its
 * name: a bare `workspace.json` would match a file of that name anywhere in
 * the vault. The lines for the operating systems have no `/` in front, so
 * that they match in every folder. `.git/` is not listed; git leaves it out
 * by itself, and so does `hardExclusionOf`.
 */
export function defaultSectionLines(paths: ExclusionPaths): string[] {
	const config = `/${escaped(trimSlashes(paths.configDir))}`;
	return [
		`${config}/community-plugins.json`,
		`${config}/plugins/`,
		`${config}/workspace.json`,
		`${config}/workspace-mobile.json`,
		`/${escaped(trimSlashes(paths.pluginDir))}/`,
		"/.trash/",
		".DS_Store",
		"._*",
		"Thumbs.db",
		"ehthumbs.db",
		"desktop.ini",
		"$RECYCLE.BIN/",
		"*.icloud",
	];
}

const ROOT_GITIGNORE = ".gitignore";

// The rules that are in effect: the lines of the section first, then the
// file, so that what the user wrote wins where the two disagree (in git the
// later line does).
//
// For now the lines are always put in front. No build writes the section
// into `.gitignore` yet, and the text of the lines that mark it is not
// decided. The task that adds both (T042) replaces this with "only when the
// file has no section": a user may then delete a line of the section, and it
// must not come back from here.
function effectiveRules(gitignore: string | null, sectionLines: readonly string[]): string {
	// Git skips a byte order mark at the start of the file; the library would
	// take it for the first character of the first rule.
	const text = (gitignore ?? "").replace(/^\uFEFF/, "");
	return [...sectionLines, text].join("\n");
}

// The characters that mean something in a line of `.gitignore` get a `\` in
// front. A `!` or `#` only means something at the start of a line and a
// space only at its end; every line built here starts with `/` and ends with
// `/` or a fixed name, so neither can be at those places.
function escaped(path: string): string {
	return path.replace(/[\\[\]*?]/g, "\\$&");
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function checkedKey(path: string): string {
	const key = pathKey(path);
	if (!isPathFromRoot(key)) {
		throw new Error(`Not a path from the vault root: ${JSON.stringify(path)}`);
	}
	return key;
}

// A copy of a copy is followed down to the file it all started from.
function withoutConflictNames(key: string): string {
	let subject = key;
	for (;;) {
		const original = originalPathOfConflictCopy(subject);
		if (original === null) return subject;
		subject = original;
	}
}
