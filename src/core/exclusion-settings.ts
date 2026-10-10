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

// What the settings screen shows of the root `.gitignore`, and what it
// writes to it. Everything the screen shows is worked out here from the file
// as it is now, and every change is made from the file as it is read right
// before the write, never from what the screen was showing. The screen puts
// it on the display and decides nothing.
//
// What the section holds is `gitignore-section.ts`; how the file is read and
// written is `gitignore-file.ts`.

import type { EntryKind, RemoteEntry } from "./backend";
import {
	createExclusion,
	defaultSectionLines,
	type ExclusionPaths,
	fixedExclusionsOff,
	type Untrackable,
	untrackableByAddedLines,
	untrackableFiles,
} from "./exclusion";
import {
	GITIGNORE_WRITE_KEY,
	type GitignoreWrite,
	type GitignoreWriteDeps,
	readRootGitignore,
	type RootGitignore,
	settleGitignoreWrite,
	type UnreadableGitignore,
	writeRootGitignore,
} from "./gitignore-file";
import {
	type ConfigItem,
	type FileKind,
	findSection,
	isHandEdited,
	readSectionState,
	type SectionState,
	sectionLines,
	trimSlashes,
	withFixedExclusions,
	withSection,
} from "./gitignore-section";
import type { Translate } from "./i18n";
import { type NoticeKind, type NoticeRef, readNotices } from "./notices";
import { isPathFromRoot, pathKey } from "./paths";
import { megabytes } from "./pull-report";
import type { StateStore } from "./state";

/** The switches for the kinds of file, in the order they are shown. */
export const SHOWN_FILE_KINDS: readonly FileKind[] = ["image", "audio", "video", "pdf", "other"];

/** The switches for the parts of the configuration folder, in the order they are shown. */
export const SHOWN_CONFIG_ITEMS: readonly ConfigItem[] = [
	"main-settings",
	"appearance",
	"themes-and-snippets",
	"hotkeys",
	"core-plugin-list",
	"core-plugin-settings",
	"community-plugin-list",
	"community-plugins",
];

export type ExclusionView =
	/** Something is at the path and what it says is not known. Nothing is shown of it, and nothing written. */
	| { readonly kind: "unreadable"; readonly reason: UnreadableGitignore }
	/** A write that did not get to its end is still remembered (`settleGitignoreWrite`): the file may be half of one. */
	| { readonly kind: "unsettled" }
	/**
	 * Markers that enclose no one section. There is nothing to switch, and
	 * nowhere a switch could write; the user puts the file right by hand.
	 */
	| { readonly kind: "broken"; readonly text: string; readonly fixedOff: readonly string[] }
	/**
	 * No section, or no file at all (`text` is `null`). `addable`: whether
	 * the file with the default section would still be under the size limit.
	 */
	| {
			readonly kind: "none";
			readonly text: string | null;
			readonly fixedOff: readonly string[];
			readonly addable: boolean;
	  }
	| {
			readonly kind: "section";
			readonly text: string;
			/** The switches, as the lines of the section read. An empty section reads as everything on. */
			readonly state: SectionState;
			/** Whether the lines are not what Sync Evo writes for that state: the next switch rewrites them. */
			readonly handEdited: boolean;
			readonly fixedOff: readonly string[];
			/**
			 * Whether the section lacks a line of a fixed exclusion that is
			 * not in effect, so that restoring writes something. Without
			 * one, what is off is undone by a `!` further down, and
			 * restoring would change nothing.
			 */
			readonly restorable: boolean;
	  };

/**
 * `fixedOff` in every view: the fixed exclusions that are not in effect, by
 * their lines, asked of the rules of the file as it is now
 * (`fixedExclusionsOff`), and not of what a sync remembered. What "restore"
 * did is then seen at once.
 */
export function exclusionView(gitignore: RootGitignore, paths: ExclusionPaths, sizeLimit: number): ExclusionView {
	if (gitignore.kind === "unreadable") return { kind: "unreadable", reason: gitignore.reason };
	const text = gitignore.kind === "text" ? gitignore.text : null;
	const fixedOff = fixedExclusionsOff(createExclusion({ ...paths, gitignore: text }), paths);
	const found = findSection(text ?? "");
	if (found.kind === "broken") return { kind: "broken", text: text ?? "", fixedOff };
	if (found.kind === "none") {
		const added = withSection(text, defaultSectionLines(paths));
		return { kind: "none", text, fixedOff, addable: byteLength(added) <= sizeLimit };
	}
	const state = readSectionState(found.lines, paths);
	return {
		kind: "section",
		text: text ?? "",
		state,
		handEdited: isHandEdited(found.lines, paths),
		fixedOff,
		restorable: fixedOff.some((line) => !state.fixed.includes(line)),
	};
}

/** One thing the screen changes in the section. `synced` is what the switch was set to. */
export type ExclusionEdit =
	| { readonly kind: "file-kind"; readonly item: FileKind; readonly synced: boolean }
	| { readonly kind: "config-item"; readonly item: ConfigItem; readonly synced: boolean }
	/** `folder` is one `folderToExclude` answered. */
	| { readonly kind: "add-folder"; readonly folder: string }
	| { readonly kind: "remove-folder"; readonly folder: string }
	/** Puts back the lines of the fixed exclusions the section lacks. */
	| { readonly kind: "restore-fixed" }
	/** Puts the default section at the top of a file that has none. */
	| { readonly kind: "add-section" };

/**
 * The folder to leave out for what was typed into the field, as a path from
 * the vault root, or `null` when it names none. A `/` at either end is what
 * a user copies from a path, and is dropped.
 */
export function folderToExclude(typed: string): string | null {
	const folder = trimSlashes(typed.trim());
	return isPathFromRoot(folder) && !/[\r\n]/.test(folder) ? folder : null;
}

/**
 * The text of the file with one thing changed, or `null` when the file as
 * it is does not take the change: a switch where there is no section or a
 * broken one, a section to add where there is one. `text` is the file as it
 * was just read (`null`: there is none).
 *
 * The state is read from the lines, one item of it is changed, and the lines
 * of that state are written back in place (`withSection`): nothing outside
 * the section changes, and a line of a fixed exclusion the user deleted does
 * not come back unless that is what was asked for.
 */
export function editedGitignore(text: string | null, edit: ExclusionEdit, paths: ExclusionPaths): string | null {
	const found = findSection(text ?? "");
	if (edit.kind === "add-section") {
		return found.kind === "none" ? withSection(text, defaultSectionLines(paths)) : null;
	}
	if (found.kind !== "found") return null;
	const state = readSectionState(found.lines, paths);
	return withSection(text, sectionLines(editedState(state, edit, paths), paths));
}

function editedState(
	state: SectionState,
	edit: Exclude<ExclusionEdit, { kind: "add-section" }>,
	paths: ExclusionPaths,
): SectionState {
	switch (edit.kind) {
		case "file-kind":
			return { ...state, kinds: { ...state.kinds, [edit.item]: edit.synced } };
		case "config-item":
			return { ...state, config: { ...state.config, [edit.item]: edit.synced } };
		case "add-folder":
			return state.folders.includes(edit.folder) ? state : { ...state, folders: [...state.folders, edit.folder] };
		case "remove-folder":
			return { ...state, folders: state.folders.filter((folder) => folder !== edit.folder) };
		case "restore-fixed":
			return withFixedExclusions(state, paths);
	}
}

const BOM = "﻿";

/**
 * The text of the file as the editing field takes it: without a byte order
 * mark, which a field shows as nothing and a user deletes without knowing,
 * and with the line ends a field has in any case.
 */
export function editorText(text: string | null): string {
	return (text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * The text to save for what the field holds. `opened` is the file the field
 * was filled from. A field that was not edited gives the file back to the
 * byte, mixed line ends included; an edited one gets the byte order mark and
 * the line end the file had, unless it was emptied.
 */
export function textFromEditor(typed: string, opened: string | null): string {
	const lines = typed.replace(/\r\n/g, "\n");
	if (lines === editorText(opened)) return opened ?? "";
	// A field that was emptied is an empty file, and not one of a mark alone.
	if (lines === "") return "";
	const file = opened ?? "";
	const newline = file.indexOf("\n");
	const crlf = newline > 0 && file[newline - 1] === "\r";
	return `${file.startsWith(BOM) ? BOM : ""}${crlf ? lines.replace(/\n/g, "\r\n") : lines}`;
}

/**
 * How a write of the settings ended. Beside what `writeRootGitignore`
 * answers:
 *
 * - "unchanged": the file already says it. Nothing was written.
 * - "over-limit": the file would be over the size limit, and a file over it
 *   is not synced and not read as rules. Nothing was written.
 * - "unreadable": the file is there and cannot be read. Nothing was written.
 *
 * "changed" is also the answer where the file no longer takes the change
 * (`editedGitignore`): it is not the file the screen showed.
 */
export type ExclusionWrite = GitignoreWrite | "unchanged" | "over-limit" | "unreadable";

export interface ExclusionDeps extends GitignoreWriteDeps {
	readonly paths: ExclusionPaths;
	readonly sizeLimit: number;
}

/** A file of the remote that can be untracked, as a screen lists it. */
export interface UntrackableFile {
	/** As the remote spells it. */
	readonly path: string;
	/** Whether it is a symbolic link on the remote. This device holds no file for it. */
	readonly symlink: boolean;
	/** Whether it lies in Sync Evo's own folder, which no sync touches. */
	readonly ownFolder: boolean;
}

/** What can be untracked, for a screen: each list sorted. */
export interface UntrackList {
	readonly files: readonly UntrackableFile[];
	/** The submodules a rule matches. They are not untracked here: that is for git on a Mac. */
	readonly submodules: readonly string[];
}

function untrackList(found: Untrackable<{ readonly path: string; readonly kind: EntryKind }>): UntrackList {
	const files = found.files.map(
		(file): UntrackableFile => ({
			path: file.entry.path,
			symlink: file.entry.kind === "symlink",
			ownFolder: file.ownFolder,
		}),
	);
	const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	return { files: files.sort((a, b) => byPath(a.path, b.path)), submodules: [...found.submodules].sort(byPath) };
}

/** How a change of the settings ended, and what it leaves to ask. */
export interface ExclusionChanged {
	readonly write: ExclusionWrite;
	/**
	 * Set when the file was written, has a section now, and the remote was
	 * listed: the files of that listing the change made a rule match
	 * (`newlyMatched`), which the user is asked about untracking. Empty
	 * lists when there are none. `null` in every other case: nothing to ask.
	 */
	readonly matched: UntrackList | null;
}

/**
 * What a change of the file made a rule match, of the files the remote held
 * when it was last listed: matched by `after` and not by `before` (`null`:
 * there was no file). `null` unless `after` has a section, since only then
 * can anything be untracked (`ExclusionScreen.untrack`).
 *
 * A file that had no section before is the one case with more to it. Its
 * `before` counts the lines of the default section as there, so adding that
 * very section changes nothing by the comparison, though the lines are only
 * now rules of the file. What the lines of the new section match, and the
 * file as it is now matches too, is listed as well (`untrackableByAddedLines`).
 */
export function newlyMatched(
	paths: ExclusionPaths,
	before: string | null,
	after: string,
	entries: readonly RemoteEntry[],
): UntrackList | null {
	const section = findSection(after);
	if (section.kind !== "found") return null;
	const was = createExclusion({ ...paths, gitignore: before });
	const now = untrackableFiles(createExclusion({ ...paths, gitignore: after }), entries);
	const files = new Set(now.files.filter((file) => !was.matchesRule(pathKey(file.entry.path), "file")));
	const submodules = new Set(
		now.submodules.filter((path) => !was.matchesRule(pathKey(path), "file") && !was.matchesRule(pathKey(path), "folder")),
	);
	if (findSection(before ?? "").kind === "none") {
		const added = untrackableByAddedLines(paths, section.lines, after, entries);
		const sectionMatches = new Set(added.files.map((file) => file.entry));
		for (const file of now.files) if (sectionMatches.has(file.entry)) files.add(file);
		for (const path of added.submodules) submodules.add(path);
	}
	return untrackList({
		files: now.files.filter((file) => files.has(file)),
		submodules: now.submodules.filter((path) => submodules.has(path)),
	});
}

/**
 * Makes one change of the screen in the file: what is remembered of a write
 * is settled, the file is read again, the change is made in what was read,
 * and that is written, guarded (`writeRootGitignore`). Answers with what the
 * change left to ask (`ExclusionChanged.matched`).
 *
 * The caller sees to it that no sync runs meanwhile (`GitignoreGate`). A
 * failure of the sync state is thrown.
 */
export async function applyExclusionEdit(deps: ExclusionScreenDeps, edit: ExclusionEdit): Promise<ExclusionChanged> {
	if (!(await settleGitignoreWrite(deps))) return unwritten("unsettled");
	const current = await readRootGitignore(deps.vault, deps.sizeLimit);
	if (current.kind === "unreadable") return unwritten("unreadable");
	const before = current.kind === "text" ? current.text : null;
	const next = editedGitignore(before, edit, deps.paths);
	return next === null ? unwritten("changed") : writeChecked(deps, next, before);
}

/**
 * Saves the whole file as the editing field has it (`textFromEditor`).
 * `opened` is the file the field was filled from, or `null` when there was
 * none: a file that is anything else by now was changed since, by a sync or
 * by the user, and is not written over.
 */
export async function saveGitignoreText(
	deps: ExclusionScreenDeps,
	text: string,
	opened: string | null,
): Promise<ExclusionChanged> {
	if (!(await settleGitignoreWrite(deps))) return unwritten("unsettled");
	const current = await readRootGitignore(deps.vault, deps.sizeLimit);
	if (current.kind === "unreadable") return unwritten("unreadable");
	const before = current.kind === "text" ? current.text : null;
	return before === opened ? writeChecked(deps, text, before) : unwritten("changed");
}

function unwritten(write: ExclusionWrite): ExclusionChanged {
	return { write, matched: null };
}

// An empty text where there is no file is no change either: no file is made
// to hold nothing. What the change made a rule match is asked of the remote
// as it was last listed, like everything the screen shows. When that
// listing cannot be read, the file is written all the same: the answer is
// "written" with nothing to ask, and not a failure of the write.
async function writeChecked(deps: ExclusionScreenDeps, text: string, before: string | null): Promise<ExclusionChanged> {
	if (text === (before ?? "")) return unwritten("unchanged");
	if (byteLength(text) > deps.sizeLimit) return unwritten("over-limit");
	const write = await writeRootGitignore(deps, text, before);
	if (write !== "written") return unwritten(write);
	let listing: Awaited<ReturnType<typeof deps.store.getListing>>;
	try {
		listing = await deps.store.getListing();
	} catch {
		return { write, matched: null };
	}
	return { write, matched: listing === null ? null : newlyMatched(deps.paths, before, text, listing.entries) };
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The remembered notices the screen lists: the ones that are about how the
 * vault is set up, and stay true until the user does something about them.
 * A fixed exclusion that is off is not among them, since the screen asks the
 * file itself about those (`ExclusionView`).
 */
export const SCREEN_NOTICE_KINDS: readonly NoticeKind[] = ["nested-gitignore", "own-folder-on-remote", "git-at-root"];

/** Everything this part of the screen shows. */
export interface ExclusionScreen {
	readonly view: ExclusionView;
	/**
	 * How many files of the remote, as it was last listed, a rule of the
	 * file matches now (`untrackableFiles`): the ones in Sync Evo's own
	 * folder, which are not synced, and the rest, which stay synced. `null`
	 * without a listing, or without rules to ask.
	 */
	readonly tracked: number | null;
	/**
	 * What can be untracked, of the same listing. `null` where nothing can
	 * be, whatever `tracked` counts, and no way to untrack is offered: there
	 * is no listing, or the file is not one with a section. Without a
	 * section the lines of the default one are applied as if they were in
	 * the file, and untracking by them would delete by rules the remote
	 * does not hold; adding the section, or a sync, comes first. With one,
	 * `files` are the `tracked` files.
	 */
	readonly untrack: UntrackList | null;
	/** The remembered notices of `SCREEN_NOTICE_KINDS`, as of the last sync. */
	readonly notices: readonly NoticeRef[];
	/** Whether the screen offers to add the section. `null` where the file is not one without a section. */
	readonly addSection: SectionOffer | null;
}

/**
 * - "offer": the button is shown.
 * - "sync-first": the remote was never listed, so this device has not
 *   pulled yet. A `.gitignore` the remote holds would be in conflict with
 *   one made or changed here before the first fetch. The sync adds the
 *   section, after its pull.
 * - "over-limit": with the section the file would be over the size limit.
 *
 * Whether the remote's `.gitignore` is the one this device last synced is
 * not looked at, unlike where a push adds the section: here the user asks
 * for it.
 */
export type SectionOffer = "offer" | "sync-first" | "over-limit";

export interface ExclusionScreenDeps extends ExclusionDeps {
	readonly store: Pick<StateStore, "getMeta" | "setMeta" | "deleteMeta" | "getListing">;
}

/**
 * Reads everything the screen shows. With `settle`, a write that is still
 * remembered is settled first, which can write the file; a caller that may
 * not write (a sync is running) passes `false`, and is shown no file while
 * one is remembered. Nothing else here writes. A failure of the sync state
 * is thrown.
 */
export async function readExclusionScreen(
	deps: ExclusionScreenDeps,
	options: { readonly settle: boolean },
): Promise<ExclusionScreen> {
	const { store, paths } = deps;
	const settled = options.settle
		? await settleGitignoreWrite(deps)
		: (await store.getMeta(GITIGNORE_WRITE_KEY)) === undefined;
	const view: ExclusionView = settled
		? exclusionView(await readRootGitignore(deps.vault, deps.sizeLimit), paths, deps.sizeLimit)
		: { kind: "unsettled" };
	const notices = (await readNotices(store)).filter((notice) => SCREEN_NOTICE_KINDS.includes(notice.kind));
	if (view.kind === "unreadable" || view.kind === "unsettled") {
		return { view, tracked: null, untrack: null, notices, addSection: null };
	}
	const listing = await store.getListing();
	const found =
		listing === null ? null : untrackableFiles(createExclusion({ ...paths, gitignore: view.text }), listing.entries);
	const tracked = found === null ? null : found.files.length;
	const untrack = found === null || view.kind !== "section" ? null : untrackList(found);
	if (view.kind !== "none") return { view, tracked, untrack, notices, addSection: null };
	const addSection: SectionOffer = listing === null ? "sync-first" : view.addable ? "offer" : "over-limit";
	return { view, tracked, untrack, notices, addSection };
}

/** Why the file is not shown, for a `.gitignore` that is there and is not read. */
export function unreadableGitignoreText(t: Translate, reason: UnreadableGitignore, sizeLimit: number): string {
	switch (reason) {
		case "not-a-file":
			return t("settings.exclusion.unreadable.notAFile");
		case "too-large":
			return t("settings.exclusion.unreadable.tooLarge", { limit: megabytes(sizeLimit) });
		case "not-downloaded":
			return t("settings.exclusion.unreadable.notDownloaded");
		case "respelled":
			return t("settings.exclusion.unreadable.respelled");
		case "read-failed":
			return t("settings.exclusion.unreadable.readFailed");
		case "not-text":
			return t("settings.exclusion.unreadable.notText");
	}
}

/** What to tell of a write that wrote nothing, or `null` where there is nothing to tell. */
export function exclusionWriteText(t: Translate, write: ExclusionWrite, sizeLimit: number): string | null {
	switch (write) {
		case "written":
		case "unchanged":
			return null;
		case "changed":
			return t("settings.exclusion.write.changed");
		case "refused":
			return t("settings.exclusion.write.refused");
		case "unsettled":
			return t("settings.exclusion.write.unsettled");
		case "over-limit":
			return t("settings.exclusion.write.overLimit", { limit: megabytes(sizeLimit) });
		case "unreadable":
			return t("settings.exclusion.write.unreadable");
	}
}
