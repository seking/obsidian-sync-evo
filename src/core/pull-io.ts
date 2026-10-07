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

// What a pull is handed and what it hands back. The pull itself does no I/O
// of its own: the vault, the remote, the sync state, the clock, and the user
// are all behind what is declared here, so that it runs the same in the app
// and in a test.

import type { Backend, FetchedFile, RemoteEntry } from "./backend";
import type { ExclusionPaths } from "./exclusion";
import type { NoticeRef } from "./notices";
import type { PullLosses } from "./pull-plan";
import type { FolderLister } from "./scan";
import type { FileStat, StateStore } from "./state";

/**
 * Where a file goes that the pull takes out of the vault.
 *
 * - "user-setting": an ordinary deletion, of a file the remote deleted. It
 *   follows the app's setting for deleted files, down to deleting for good:
 *   the content is still in the history of the remote.
 * - "vault-trash": a file moved away to protect its content. Always the
 *   `.trash/` of the vault, whatever the setting says; with "delete for
 *   good" the protection would be the loss.
 */
export type TrashMode = "user-setting" | "vault-trash";

/**
 * - "not-open": no editor has the file open; nothing was done.
 * - "saved": every editor that has it open has written what was typed.
 * - "failed": an editor could not save. What is on disk may be behind what
 *   the user sees, so the file is not touched in this pull.
 */
export type SaveResult = "not-open" | "saved" | "failed";

export interface VaultStat extends FileStat {
	/** For a folder the time and the size mean nothing. */
	readonly type: "file" | "folder";
}

/**
 * The vault, as far as a pull needs it. Every path is from the vault root,
 * spelled as the pull wants it; which of the app's two ways of reaching a
 * file is used (names that start with a `.` are not in its own index) is
 * decided behind this interface.
 *
 * Nothing here may rewrite links in other files.
 */
export interface PullVault extends FolderLister {
	/**
	 * What is at the path, or `null` for nothing. Asked of the file system:
	 * where the cases are not told apart it answers for any spelling, so the
	 * pull never takes it as proof of a spelling.
	 */
	stat(path: string): Promise<VaultStat | null>;
	read(path: string): Promise<Uint8Array>;
	/** Creates the file or replaces its content. Folders on the way are created. */
	write(path: string, content: Uint8Array): Promise<void>;
	/**
	 * Renames a file or a folder in one call, with no name in between.
	 * Fails, changing nothing, when something else is at `to`. A change of
	 * case alone, of the name that is renamed, is a rename like any other.
	 *
	 * Only the last name of `to` is given to what is renamed. The folders on
	 * the way to `to` are created when they are missing, and keep the
	 * spelling the disk has when they are there: where the cases are not
	 * told apart, `rename("notes/a.md", "Notes/a.md")` beside a folder
	 * `notes` leaves the file where it is, and succeeds. The case of a
	 * folder is changed by renaming the folder. Whoever needs the path as it
	 * is spelled afterwards has to look.
	 */
	rename(from: string, to: string): Promise<void>;
	/** Takes a file out of the vault. */
	trash(path: string, mode: TrashMode): Promise<void>;
	/**
	 * Removes the folder when nothing is in it. Answers whether no folder is
	 * at the path afterwards: `true` also when there was none.
	 */
	removeFolderIfEmpty(path: string): Promise<boolean>;
	/**
	 * Makes every editor that has the file open write what was typed. An
	 * editor saves on its own only every few seconds; what it has not saved
	 * shows in neither the time nor the size of the file, and would be gone
	 * without a trace if the file were written over.
	 */
	saveOpenEditors(path: string): Promise<SaveResult>;
}

/** What the user is shown when the pull stops to ask. */
export interface PullConfirmRequest {
	/** `losses.rewritten` says whether the history of the remote was rewritten. */
	readonly losses: PullLosses;
	/** The number of records before the pull, of every kind. */
	readonly recordCount: number;
}

/**
 * - "proceed": do all of it.
 * - "cancel": do none of it. The whole pull is given up.
 * - "keep-local": only offered when the history was rewritten. The listed
 *   files stay as they are and everything else is pulled. Given for any
 *   other request, it is taken as "cancel".
 */
export type PullAnswer = "proceed" | "cancel" | "keep-local";

export type ConfirmPull = (request: PullConfirmRequest) => Promise<PullAnswer>;

export interface BulkWriteSession {
	/** Whether something was closed (graph views) that `restore` reopens. */
	readonly closedViews: boolean;
	/** Called once when the pull ends, however it ends. */
	restore(): Promise<void>;
}

/**
 * Called once, right before the first file is written by a pull that has no
 * base revision: a first fetch. A pull that writes nothing never calls it.
 */
export type BeginBulkWrite = () => Promise<BulkWriteSession>;

/**
 * Yields the content of the listed entries, like `Backend.fetch`. The pull
 * decides what to fetch and writes what comes back; how the bytes are
 * obtained is this part alone, so that an archive can take its place.
 */
export type ContentSource = (
	revision: string | null,
	entries: readonly RemoteEntry[],
) => AsyncIterable<FetchedFile>;

export type PullPhase = "listing" | "scanning" | "hashing" | "applying";

export interface PullProgress {
	readonly phase: PullPhase;
	readonly done: number;
	/** 0 while it is not known. */
	readonly total: number;
	/** Whether views were closed for the duration of the pull (`BulkWriteSession`). */
	readonly closedViews: boolean;
}

export interface PullDeps {
	/** The sync state, opened. */
	readonly store: StateStore;
	readonly backend: Backend;
	readonly vault: PullVault;
	/** The configuration folder and the plugin's own folder. */
	readonly paths: ExclusionPaths;
	/** The id of this plugin, as `community-plugins.json` lists it. */
	readonly pluginId: string;
	/** The name of this device, for the names of conflict copies. */
	readonly deviceName: string;
	/** Milliseconds since the epoch, on the clock the file times come from. */
	readonly now: () => number;
	readonly confirm: ConfirmPull;
	readonly beginBulkWrite?: BeginBulkWrite;
	/** `backend.fetch` when absent. */
	readonly fetchContents?: ContentSource;
	readonly onProgress?: (progress: PullProgress) => void;
	/** Stops the pull between two files. */
	readonly signal?: AbortSignal;
	/** Awaited now and then while the vault is hashed, so that the screen does not stand still. */
	readonly yieldControl?: () => Promise<void>;
	/** The largest file that is synced, in bytes. `DEFAULT_SIZE_LIMIT` when absent. */
	readonly sizeLimit?: number;
}

/**
 * - "completed": everything is done, and the base revision is the head.
 * - "incomplete": some files were put off to the next sync (`deferred`).
 *   What was done is recorded; the base revision is where it was.
 * - "remote-empty": the remote has no content and there is no base revision.
 *   Nothing was changed.
 * - "declined": the user was asked and said no. Nothing was changed: no
 *   file, no record, and every count is zero. The paths the plan cannot
 *   write ("blocked" in `unwritable`) are listed all the same, since their
 *   notice is told by this pull too.
 * - "cancelled": stopped through the signal. What was done is recorded; the
 *   base revision is where it was. The "blocked" paths are listed here too,
 *   also when the stop came before anything was done.
 */
export type PullOutcome = "completed" | "incomplete" | "remote-empty" | "declined" | "cancelled";

/**
 * Content of the vault that was kept under the name of a copy.
 *
 * - "conflict": both sides changed the file. `path` has the remote's content
 *   now.
 * - "became-symlink": the remote turned `path` into a symlink, which is not
 *   written. Nothing is at `path` now.
 * - "became-folder": the remote has files below `path`, which is a folder
 *   now.
 * - "name-taken": a file was in the way of another that got the name `path`
 *   through a rename that only changes the case. `path` holds that other
 *   file.
 */
export type PullConflictCause = "conflict" | "became-symlink" | "became-folder" | "name-taken";

export interface PullConflict {
	/** The path the copy is named after. What is there now depends on `cause`. */
	readonly path: string;
	/** Where the vault's content is. */
	readonly copyPath: string;
	readonly cause: PullConflictCause;
}

/**
 * A file that was left as it is and is tried again by the next sync. While
 * there is one, the base revision does not move.
 *
 * - "save-failed": an editor that has it open could not save.
 * - "changed-during-pull": it kept changing while the pull worked on it.
 * - "hash-mismatch": the content that was fetched is not what the listing
 *   said it would be.
 * - "fetch-failed": the content could not be fetched (see `fetchError`).
 * - "unreadable": the vault could not tell what is at the path.
 * - "depends-on-deferred": a step it comes after was put off.
 */
export type DeferReason =
	| "save-failed"
	| "changed-during-pull"
	| "hash-mismatch"
	| "fetch-failed"
	| "unreadable"
	| "depends-on-deferred";

export interface DeferredFile {
	readonly path: string;
	readonly reason: DeferReason;
}

/**
 * A path the vault did not take. It has no record of the new content, so it
 * is neither deleted on the remote nor counted as in sync, and the next pull
 * tries it again. The base revision moves all the same: nothing about such a
 * path depends on it.
 *
 * - "write-failed", "rename-failed", "trash-failed": the vault refused.
 *   For "trash-failed" the path is the vault file that was to be taken
 *   away; it stays, with its record. For "rename-failed" it is the vault
 *   file that was to be renamed or moved out of the way (to the name of a
 *   copy); it stays where it is.
 * - "copy-unwritable": the copy of a conflict could not be written, so the
 *   file it is a copy of was not written either.
 * - "folder-in-the-way": a folder is at the path, and it is not empty.
 * - "blocked": decided before anything was touched; see `PullSkipReason`.
 *   `inTheWay` lists what is in its place.
 * - "depends-on-unwritable": a step it comes after failed.
 */
export type UnwritableReason =
	| "write-failed"
	| "rename-failed"
	| "trash-failed"
	| "copy-unwritable"
	| "folder-in-the-way"
	| "blocked"
	| "depends-on-unwritable";

export interface UnwritablePath {
	readonly path: string;
	readonly reason: UnwritableReason;
	/** What the vault threw, for the log. */
	readonly error?: unknown;
	/**
	 * Only for "blocked": the vault files that are in the place of the
	 * remote file, as they are spelled.
	 */
	readonly inTheWay?: readonly string[];
	/**
	 * Whether this pull is the first to report it: its notice
	 * ("blocked-path" for "blocked", "unwritable-path" for the others) is
	 * among `PullResult.notices`. Such a path is listed by every pull for as
	 * long as it fails, and is worth telling once. Always `false` for the
	 * two "depends" reasons, which have no notice.
	 */
	readonly isNew: boolean;
}

/** What happened, without a word of text: wording it is the caller's. */
export interface PullResult {
	readonly outcome: PullOutcome;
	/** The head that was pulled; `null` for a remote without content. */
	readonly revision: string | null;
	readonly remoteEmpty: boolean;
	/** Whether the history of the remote no longer builds on the base revision. */
	readonly rewritten: boolean;
	readonly counts: {
		/** Files written with the remote's content. */
		readonly fetched: number;
		readonly deleted: number;
		readonly renamed: number;
		readonly conflicts: number;
	};
	readonly conflicts: readonly PullConflict[];
	/** Files moved to the `.trash/` of the vault to protect their content, as they were spelled. */
	readonly trashed: readonly string[];
	readonly deferred: readonly DeferredFile[];
	readonly unwritable: readonly UnwritablePath[];
	/** Files the user chose to keep when the history was rewritten. */
	readonly keptLocal: readonly string[];
	/** Symlinks of the remote that no record held before. Told once: they have a record now. */
	readonly newSymlinks: readonly string[];
	/**
	 * The one-time notices that apply for the first time, already
	 * remembered; and "plugin-not-listed", which is told every time.
	 */
	readonly notices: readonly NoticeRef[];
	/** Whether views were closed while the pull wrote, and reopened since. */
	readonly closedViews: boolean;
	/** What the fetching threw, when it stopped before the end. */
	readonly fetchError?: unknown;
}
