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
import type { EntryKind } from "./backend";
import { copyFamilyOf } from "./conflict-copies";
import { originalPathOfConflictCopy } from "./conflict-name";
import {
	defaultSectionState,
	findSection,
	fixedExclusions,
	sectionLines,
	trimSlashes,
	withSection,
} from "./gitignore-section";
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
	 * A copy that was itself in conflict leaves its content under its own
	 * name with another number (`copyCandidate`). That one is synced while
	 * the remote holds a copy of that name, the one it was in conflict with,
	 * though the first file may be gone from the remote by then.
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
	/**
	 * For a path named like a copy kept from a conflict: whether the remote
	 * holds another copy of the same name but for the number at its end.
	 */
	copyOnRemote(key: string): boolean;
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
	// The name the copies of one conflict share → the copies the remote holds.
	const copies = new Map<string, Set<string>>();
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const [entries, isRemote] of [
		[remote, true],
		[records, false],
	] as const) {
		for (const entry of entries) {
			const key = foldedKey(entry.path);
			if (isRemote) {
				onRemote.add(key);
				const family = copyFamilyOf(entry.path);
				if (family !== null) {
					const group = copies.get(family);
					if (group === undefined) copies.set(family, new Set([key]));
					else group.add(key);
				}
			}
			files.add(key);
			for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
				folders.add(key.slice(0, slash));
			}
		}
	}
	return {
		has: (key, type) => (type === "folder" ? folders : files).has(foldedKey(key)),
		onRemote: (key) => onRemote.has(foldedKey(key)),
		copyOnRemote: (key) => {
			const family = copyFamilyOf(key);
			const group = family === null ? undefined : copies.get(family);
			if (group === undefined) return false;
			// Itself does not count: the remote may hold the very name
			// in another case, and no other copy.
			return group.size > 1 || !group.has(foldedKey(key));
		},
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
	const rules = ignore({ ignorecase: true }).add(effectiveRules(input));
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
					if (known.onRemote(original) || known.copyOnRemote(key)) return false;
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
 * (`fixedExclusions`). They are what the default state writes, and are kept
 * nowhere else.
 */
export function defaultSectionLines(paths: ExclusionPaths): string[] {
	return sectionLines(defaultSectionState(paths), paths);
}

/**
 * The fixed exclusions that are not in effect, by their lines in the default
 * section: the user deleted the line, or a `!` after it undoes it. The
 * warning of the settings is made from this.
 *
 * Each line is judged by the rules alone, on a path it is there to leave
 * out. Whether a line is there is not looked at: the same rule written
 * another way, or outside the section, is as good. `excludes` is not asked.
 * It would call the trash of a remote that tracks `.trash/` synced, and warn
 * forever about a line that works; and it would never warn about Sync Evo's
 * own folder, which the code leaves out, while a `git add -A` on a Mac
 * commits it.
 *
 * While the file has no section, the lines of the default section count as
 * there, so nothing is off but what a `!` of the file undoes.
 */
export function fixedExclusionsOff(exclusion: Exclusion, paths: ExclusionPaths): string[] {
	return fixedExclusions(paths)
		.filter((fixed) => !exclusion.matchesRule(fixed.path, fixed.type))
		.map((fixed) => fixed.line);
}

/**
 * The files of a remote listing that a rule matches now. They stay synced
 * (`excludes`), the way git keeps tracking a file that is added to
 * `.gitignore` later; this is the list to show for that.
 *
 * Not in it: what the two fixed exclusions cover, which are not synced
 * whatever the remote holds; a submodule and what lies below one, which is
 * for git on a Mac to take out; and a path nothing can be decided about.
 * What a user can take out of the remote is one list more
 * (`untrackableFiles`): it also holds Sync Evo's own folder.
 */
export function remoteFilesMatchingRules<T extends { readonly path: string; readonly kind: EntryKind }>(
	exclusion: Exclusion,
	entries: readonly T[],
): T[] {
	return untrackableFiles(exclusion, entries)
		.files.filter((file) => !file.ownFolder)
		.map((file) => file.entry);
}

/** A file of the remote that can be taken out of it, and stays on the device (`untrackableFiles`). */
export interface UntrackableEntry<T> {
	/** As the listing gave it. A symlink is told by its kind. */
	readonly entry: T;
	/**
	 * Whether it lies in the folder Sync Evo itself is installed in. No sync
	 * touches it there; taking it out of the remote is the user's to ask for.
	 */
	readonly ownFolder: boolean;
}

export interface Untrackable<T> {
	/** In the order of the listing. */
	readonly files: readonly UntrackableEntry<T>[];
	/**
	 * The submodules a rule matches, by their paths in the order of the
	 * listing. They are not taken out here: that is for git on a Mac.
	 */
	readonly submodules: readonly string[];
}

/**
 * The files of a remote listing that can be untracked: taken out of the
 * remote and left on the device, as `git rm --cached` does. Every file and
 * symlink a rule matches now, also in Sync Evo's own folder: no sync reads
 * or writes there, and the files of another device's plugin stay on the
 * remote until someone takes them out. Without a rule that matches them they
 * are not listed, like any other file.
 *
 * Not in it: a `.git` and what lies below it, which no tree holds; what lies
 * below a submodule; and a path nothing can be decided about. A submodule
 * itself is answered apart, when a rule matches it. The tree holds one line
 * for it and nothing of what is below, so it is asked about as a file and as
 * a folder: `/knowledge/` only matches a folder.
 */
export function untrackableFiles<T extends { readonly path: string; readonly kind: EntryKind }>(
	exclusion: Exclusion,
	entries: readonly T[],
): Untrackable<T> {
	const isBelowSubmodule = belowSubmodules(entries);
	const files: UntrackableEntry<T>[] = [];
	const submodules: string[] = [];
	for (const entry of entries) {
		const key = pathKey(entry.path);
		if (!isPathFromRoot(key) || isBelowSubmodule(key)) continue;
		const hard = exclusion.hardExclusionOf(key);
		if (hard === "dot-git") continue;
		if (entry.kind === "submodule") {
			if (exclusion.matchesRule(key, "file") || exclusion.matchesRule(key, "folder")) submodules.push(entry.path);
		} else if (exclusion.matchesRule(key, "file")) {
			files.push({ entry, ownFolder: hard === "own-folder" });
		}
	}
	return { files, submodules };
}

/**
 * What can be untracked because of lines that were just added to the section
 * of a file that had none: what the lines match, and the file as it is now
 * matches too. Not what the file matches now and did not before: before, the
 * lines of the default section counted as there (`effectiveRules`), so that
 * list would be empty. And not by the lines alone: a line that a later one of
 * the user's undoes leaves nothing out.
 *
 * `lines` are the lines of the section without its two markers, and `text`
 * is the whole file with them in it.
 */
export function untrackableByAddedLines<T extends { readonly path: string; readonly kind: EntryKind }>(
	paths: ExclusionPaths,
	lines: readonly string[],
	text: string,
	entries: readonly T[],
): Untrackable<T> {
	const added = untrackableFiles(createExclusion({ ...paths, gitignore: withSection(null, lines) }), entries);
	const now = untrackableFiles(createExclusion({ ...paths, gitignore: text }), entries);
	const files = new Set(now.files.map((file) => file.entry));
	const submodules = new Set(now.submodules);
	return {
		files: added.files.filter((file) => files.has(file.entry)),
		submodules: added.submodules.filter((path) => submodules.has(path)),
	};
}

/**
 * The `.gitignore` files below the root, of the remote and of the vault:
 * they are synced as the files they are, and none of their rules is read,
 * which is not what git on a Mac does with them. Each path once, as the
 * remote spells it where it holds it, sorted.
 *
 * Not in it: one below either of the two fixed exclusions; one below a
 * submodule, whose rules are for the repository it is; and one that a rule
 * matches, itself or a folder above it. That is asked of the rules alone
 * (`matchesRule`), since `excludes` leaves nothing out that the remote
 * holds: a `knowledge/.gitignore` inside a folder the root leaves out would
 * be told on every device for good. `local` is what the scan found, which
 * does not go below a folder a rule matches unless something there is known.
 */
export function nestedGitignores(
	exclusion: Exclusion,
	remote: readonly { readonly path: string; readonly kind: EntryKind }[],
	local: readonly string[],
): string[] {
	const isBelowSubmodule = belowSubmodules(remote);
	const counts = (key: string): boolean => {
		const slash = key.lastIndexOf("/");
		if (slash === -1 || key.slice(slash + 1) !== ROOT_GITIGNORE) return false;
		if (!isPathFromRoot(key) || isBelowSubmodule(key) || exclusion.hardExclusionOf(key) !== undefined) return false;
		if (exclusion.matchesRule(key, "file")) return false;
		for (let at = key.indexOf("/"); at !== -1; at = key.indexOf("/", at + 1)) {
			if (exclusion.matchesRule(key.slice(0, at), "folder")) return false;
		}
		return true;
	};
	const found = new Map<string, string>();
	const remoteFiles = remote.filter((entry) => entry.kind === "file").map((entry) => entry.path);
	for (const path of [...remoteFiles, ...local]) {
		const key = pathKey(path);
		if (!found.has(key) && counts(key)) found.set(key, path);
	}
	return [...found.values()].sort();
}

// Whether a key lies below one of the submodules of a listing.
function belowSubmodules(
	entries: readonly { readonly path: string; readonly kind: EntryKind }[],
): (key: string) => boolean {
	const submodules = new Set<string>();
	for (const entry of entries) {
		if (entry.kind === "submodule") submodules.add(pathKey(entry.path));
	}
	return (key) => {
		for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
			if (submodules.has(key.slice(0, slash))) return true;
		}
		return false;
	};
}

const ROOT_GITIGNORE = ".gitignore";

// The rules that are in effect. Once the file has a section they are the
// file and nothing else: a user may delete a line of the section, and it
// must not come back from here. A broken section counts as one, since its
// lines are still rules, and so does an empty one, which is how a user says
// that the section is not wanted.
//
// Only while the file has no section are the lines of the default section
// put in front: for the pull that runs before a sync adds the section, and
// for a device that only ever pulls. In front, so that what the user wrote
// wins where the two disagree (in git the later line does).
function effectiveRules(input: ExclusionInput): string {
	// Git skips a byte order mark at the start of the file; the library would
	// take it for the first character of the first rule.
	const text = (input.gitignore ?? "").replace(/^\uFEFF/, "");
	if (findSection(text).kind !== "none") return text;
	return [...defaultSectionLines(input), text].join("\n");
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
