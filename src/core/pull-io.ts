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

// What a pull is handed and what it hands back. The pull itself does no I/O
// of its own: the vault, the remote, the sync state, the clock, and the user
// are all behind what is declared here, so that it runs the same in the app
// and in a test.

import type { ArchiveDownload, ArchiveGate } from "./archive-fetch";
import type { Backend, FetchedFile, RemoteEntry } from "./backend";
import type { DeviceExclusion } from "./device-exclusion";
import type { ExclusionPaths } from "./exclusion";
import type { FirstFetchFiles } from "./first-fetch";
import type { VaultIndex } from "./light-scan";
import type { ListedStats } from "./listed-stats";
import type { NoticeRef } from "./notices";
import type { PullLosses } from "./pull-plan";
import type { PushCounts } from "./push-pending";
import type { FolderLister, LinkProbe } from "./scan";
import type { FileStat, StateSeed, StateStore } from "./state";

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
export interface PullVault extends FolderLister, LinkProbe {
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

/** A read gave another number of bytes than the file is said to have, twice. */
export class ShortReadError extends Error {
	constructor(path: string, read: number, size: number) {
		super(`read ${read} of the ${size} bytes of ${path}`);
		this.name = "ShortReadError";
	}
}

/**
 * Reads the file `stat` is of, and takes the content only when it is as long
 * as the file is said to be. A read that fails is safe: the file is left
 * alone. One that answers with a part of the file is not: the part would be
 * taken for an edit, and sent over the whole file on the remote. A cloud
 * drive that has the content off the device (iCloud Drive) fetches it when
 * the file is read, and what a read gives when that fetch breaks off is not
 * known.
 *
 * The file may also have been written between the stat and the read, so it
 * is looked at once more before the read is given up. Answers the stat the
 * content goes with. Throws what the vault throws, a `ShortReadError`, or
 * when the file is gone at the second look.
 */
export async function readWhole(
	vault: Pick<PullVault, "stat" | "read">,
	path: string,
	stat: VaultStat,
): Promise<{ readonly content: Uint8Array; readonly stat: VaultStat }> {
	const content = await vault.read(path);
	if (content.length === stat.size) return { content, stat };
	const again = await vault.stat(path);
	if (again === null || again.type !== "file") throw new ShortReadError(path, content.length, stat.size);
	const second = await vault.read(path);
	if (second.length !== again.size) throw new ShortReadError(path, second.length, again.size);
	return { content: second, stat: again };
}

/** The part of a question that is about a first fetch (`first-fetch.ts`). */
export interface FirstFetchRequest {
	readonly files: FirstFetchFiles;
	/**
	 * Whether going on discards the sync state first: the "first fetch"
	 * command. The question is then asked whatever the vault holds.
	 */
	readonly discardsState: boolean;
}

/**
 * What the user is shown when the pull stops to ask. One question, also when
 * there are two reasons to ask: at least one of `losses` and `firstFetch` is
 * set.
 */
export interface PullConfirmRequest {
	/**
	 * What the pull takes away, when that is a reason to ask; `null` when it
	 * is not. `losses.rewritten` says whether the history of the remote was
	 * rewritten.
	 */
	readonly losses: PullLosses | null;
	/** The number of records before the pull, of every kind. */
	readonly recordCount: number;
	/** Set when this is a first fetch the user has not said yes to. */
	readonly firstFetch: FirstFetchRequest | null;
}

/**
 * - "proceed": do all of it.
 * - "cancel": do none of it. The whole pull is given up.
 * - "keep-local": only offered when the history was rewritten. The listed
 *   files stay as they are and everything else is pulled. Given for any
 *   other request, it is taken as "cancel".
 * - "later": no answer. The pull ends where it stands and the question is
 *   asked again by the next pull. Unlike "cancel" it takes nothing back:
 *   what was confirmed before stays confirmed. What a pull that started by
 *   itself goes by without asking (`PullDeps.automatic`, `PullOutcome`
 *   "waiting").
 *
 * A request about a first fetch alone is answered with "proceed", "cancel"
 * or "later".
 */
export type PullAnswer = "proceed" | "cancel" | "keep-local" | "later";

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

/** A file as a source of contents yields it. */
export interface SourcedFile extends FetchedFile {
	/**
	 * What `Backend.hashContent` answers for `content`, when the source has
	 * computed it already. The write compares this with the listing instead
	 * of hashing the content a second time. Never the hash of the entry
	 * taken on trust.
	 */
	readonly hash?: string;
}

/**
 * Thrown by a source of contents when the sync state failed inside it, with
 * what the store threw as `cause`. Anything else a source throws is a
 * failure to fetch: the files that were not yielded wait for the next sync.
 * This is not: the pull rejects with `cause`, as it does when the sync state
 * fails anywhere else.
 */
export class SourcedStateError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("The sync state failed while the contents were fetched.");
		this.name = "SourcedStateError";
		this.cause = cause;
	}
}

/**
 * Yields the content of the listed entries, like `Backend.fetch`. The pull
 * decides what to fetch and writes what comes back; how the bytes are
 * obtained is this part alone, so that an archive can take its place.
 */
export type ContentSource = (
	revision: string | null,
	entries: readonly RemoteEntry[],
) => AsyncIterable<SourcedFile>;

export type PullPhase = "listing" | "scanning" | "hashing" | "applying";

export interface PullProgress {
	readonly phase: PullPhase;
	readonly done: number;
	/** 0 while it is not known. */
	readonly total: number;
	/** Whether views were closed for the duration of the pull (`BulkWriteSession`). */
	readonly closedViews: boolean;
	/**
	 * Set while the archive of the commit is downloaded. `done` stands still
	 * then, with nothing to count: the download is one request.
	 */
	readonly archive?: ArchiveDownload;
}

export interface PullDeps {
	/** The sync state, opened. */
	readonly store: StateStore;
	readonly backend: Backend;
	readonly vault: PullVault;
	/** The configuration folder and the plugin's own folder. */
	readonly paths: ExclusionPaths;
	/** What this device alone does not sync (`device-exclusion.ts`). Absent: nothing. */
	readonly device?: Pick<DeviceExclusion, "kinds" | "folders">;
	/** The id of this plugin, as `community-plugins.json` lists it. */
	readonly pluginId: string;
	/** The name of this device, for the names of conflict copies. */
	readonly deviceName: string;
	/**
	 * Whether a conflict is merged where it can be (`PullMerge`), before the
	 * vault's content is kept as a copy. Absent or `false`: every conflict
	 * is kept as a copy, and nothing is asked of the remote for it.
	 */
	readonly mergeConflicts?: boolean;
	/** Milliseconds since the epoch, on the clock the file times come from. */
	readonly now: () => number;
	readonly confirm: ConfirmPull;
	/**
	 * Whether the pull started by itself, with no one there to ask. Such a
	 * pull asks nothing: where it would, it ends "waiting", as if answered
	 * "later", and `confirm` is not called. And it starts no first fetch,
	 * whether or not there is something to ask about one: fetching a whole
	 * repository is begun by the user, who is then there to keep the screen
	 * on (`PullWaitReason` "first-fetch"). One that was begun and stopped
	 * halfway is gone on with.
	 */
	readonly automatic?: boolean;
	/**
	 * Whether the file at a path is being typed in right now (`editing.ts`).
	 * Set for a pull that started by itself, and only for that: it does
	 * nothing to such a file. Not a write, a copy, a deletion or a rename;
	 * the file is put off ("being-edited") and taken up by the next sync,
	 * once the typing has stopped. Asked right before each file is touched,
	 * not once for the pull: typing begins and ends while a pull runs.
	 */
	readonly beingEdited?: (path: string) => boolean;
	/**
	 * Set for the "first fetch" command: the pull starts over. It decides as
	 * if there were no sync state, without reading or changing the one given
	 * as `store`, and always asks first (`FirstFetchRequest.discardsState`).
	 * Once the user said yes, what a pull that stopped left half written is
	 * settled with the markers of `store`, which nothing else would know
	 * of; then this is called: it discards the sync state and answers the
	 * one that takes its place, which the pull goes on with. That one holds
	 * `seed` and nothing else, from the moment the old one is gone: the
	 * markers that could not be settled and what is yet to be told must not
	 * be lost to the app being stopped in between. Never called when the
	 * user said no, and nothing is settled then.
	 */
	readonly discardState?: (seed: StateSeed) => Promise<StateStore>;
	/**
	 * Set for the light check: the vault is not walked, and its files are
	 * told apart from the app's index instead (`light-scan.ts`). For a sync
	 * that starts by itself at an interval. Such a pull does not find a new
	 * path with a `.` name, and forgets no notice (`updateNotices`).
	 */
	readonly index?: VaultIndex;
	/**
	 * For a check that walks the vault: the time and the size of the files
	 * as the listing of each folder holds them (`listed-stats.ts`). A file
	 * whose time and size there are its record's is not asked of the disk.
	 * Absent where the listing holds none of that.
	 */
	readonly listedStats?: ListedStats;
	readonly beginBulkWrite?: BeginBulkWrite;
	/**
	 * Yields files one at a time; `backend.fetch` when absent. The pull uses
	 * it for a few files, and for what the archive of the remote
	 * (`Backend.fetchArchive`) did not give when it fetches many. Which of
	 * the two means is used is decided in `archive-fetch.ts`.
	 */
	readonly fetchContents?: ContentSource;
	/**
	 * Kept by whoever starts the pulls, and handed to each: so that the
	 * archive of the remote is not asked for while one a stopped pull asked
	 * for is still on its way (`ArchiveGate`).
	 */
	readonly archiveGate?: ArchiveGate;
	/**
	 * Whether this device may fetch by the archive of the remote at all; it
	 * may when absent. Where it may not, every file is fetched one at a time
	 * and nothing about the archive is told (`ArchiveSourceDeps.allowed`).
	 */
	readonly archiveAllowed?: boolean;
	/** For the record of how the fetching went, in English. Nothing a user has to read. */
	readonly log?: (message: string) => void;
	readonly onProgress?: (progress: PullProgress) => void;
	/**
	 * Stops the pull between two files: after the one being written is
	 * written and recorded. A request that is on its way is not waited for.
	 */
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
 *   Nothing was changed, but for the answer to the question before a first
 *   fetch, when the vault has files and it was asked.
 * - "declined": the user was asked and said no. Nothing of the plan was
 *   carried out: no file, no record. What a pull that stopped had left half
 *   done is the exception, since it is settled before anything is asked:
 *   `halfWritten` and `halfCopies` list what was moved away, and
 *   `conflicts` a conflict that pull had finished and not told. The paths
 *   the plan cannot write ("blocked" in `unwritable`) are listed all the
 *   same, since their notice is told by this pull too. Not when the pull was
 *   to start over (`PullDeps.discardState`): that one leaves the sync state
 *   and the vault alone altogether, down to what is remembered of notices.
 * - "cancelled": stopped through the signal. What was done is recorded; the
 *   base revision is where it was. The "blocked" paths are listed here too,
 *   also when the stop came before anything was done. A stop while the
 *   question was open is this too, and not a "no": it changes what a "no"
 *   changes, but for the confirmation from before, which stays.
 * - "waiting": the question was not answered ("later"), and waits for a
 *   pull that can ask it (`PullResult.waitingFor`). As after a "no", nothing
 *   of the plan was carried out, and what a pull that stopped had left half
 *   done was settled before. Nothing that is remembered was touched: not
 *   what was confirmed before, and not what is remembered of notices, so the
 *   result carries none and lists no "blocked" path. No push follows.
 */
export type PullOutcome = "completed" | "incomplete" | "remote-empty" | "declined" | "cancelled" | "waiting";

/**
 * What a pull that ended "waiting" has to ask. One reason, the gravest when
 * there is more than one:
 *
 * - "rewritten": the history of the remote was rewritten, and the pull
 *   takes files away or writes over them.
 * - "deletions": the pull deletes more files than it does unasked.
 * - "first-fetch": a first fetch the user has not said yes to: into a
 *   vault whose files differ from the remote's, or, for a pull that started
 *   by itself (`PullDeps.automatic`), any first fetch that has not begun.
 *   That one ends before the vault is looked at.
 */
export type PullWaitReason = "rewritten" | "deletions" | "first-fetch";

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
 * A file both sides had changed, which now holds the changes of both
 * (`merge.ts`). The remote does not hold that content yet: the file reads
 * as changed on this device, and the next push sends it.
 */
export interface PullMerge {
	readonly path: string;
	/**
	 * Where the content the vault had before the merge is: a file in the
	 * `.trash/` of the vault, in the folder of such files (`MERGED_FOLDER`),
	 * whatever the app's setting for deleted files.
	 */
	readonly keptAt: string;
}

/**
 * A file that was left as it is and is tried again by the next sync. While
 * there is one, the base revision does not move.
 *
 * - "save-failed": an editor that has it open could not save.
 * - "changed-during-pull": it kept changing while the pull worked on it.
 * - "being-edited": the user is typing in it right now
 *   (`PullDeps.beingEdited`). Only in a pull that started by itself. Found
 *   before anything is done to the file: nothing was written, no copy was
 *   made, and the editor was not even asked to save.
 * - "hash-mismatch": the content that was fetched is not what the listing
 *   said it would be.
 * - "fetch-failed": the content could not be fetched (see `fetchError`).
 * - "unreadable": the vault could not tell what is at the path.
 * - "not-downloaded": a cloud drive keeps only a placeholder of the file on
 *   this device (`ScannedPath` "placeholder"), and the pull has something
 *   to do at its path. Nothing is wrong with the file; the user has to
 *   have it downloaded.
 * - "trash-failed": a pull that stopped left it half written, and it could
 *   not be moved to the `.trash/` of the vault. Unlike the "trash-failed" of
 *   an unwritable path, the file is not known to hold anything that may be
 *   compared, so the pull is not done while it is there.
 * - "depends-on-deferred": a step it comes after was put off.
 */
export type DeferReason =
	| "save-failed"
	| "changed-during-pull"
	| "being-edited"
	| "hash-mismatch"
	| "fetch-failed"
	| "unreadable"
	| "not-downloaded"
	| "trash-failed"
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
	/**
	 * Set when the pull walked the vault and looked at every file it found
	 * (a check that is not the light one). Absent otherwise.
	 */
	readonly walked?: true;
	/** The head that was pulled; `null` for a remote without content. */
	readonly revision: string | null;
	readonly remoteEmpty: boolean;
	/** Whether the history of the remote no longer builds on the base revision. */
	readonly rewritten: boolean;
	/** Only for "waiting". */
	readonly waitingFor?: PullWaitReason;
	readonly counts: {
		/** Files written with the remote's content. */
		readonly fetched: number;
		readonly deleted: number;
		readonly renamed: number;
		readonly conflicts: number;
	};
	/**
	 * With the conflicts a pull that stopped had made the copy of and not
	 * told: each is listed once, by the pull that finds the file with the
	 * content of the remote, or that writes it. That is also so when the
	 * file itself was left half written and is listed in `halfWritten`: what
	 * the user had is in the copy then, and not in the `.trash/`.
	 */
	readonly conflicts: readonly PullConflict[];
	/**
	 * Files inside the configuration folder that had a conflict and hold the
	 * content of the remote now. No copy is kept of such a file: what the
	 * vault had is in its `.trash/`, whatever the app's setting for deleted
	 * files. Not among `conflicts`, and not counted there.
	 */
	readonly replacedSettings: readonly string[];
	/**
	 * Files that had a conflict and were merged (`PullDeps.mergeConflicts`).
	 * Not among `conflicts` and not counted there, nor in `counts.fetched`.
	 * With the ones a pull that stopped had written and not told: each is
	 * listed once.
	 */
	readonly merged: readonly PullMerge[];
	/**
	 * Files moved to the `.trash/` of the vault to protect their content, as
	 * they were spelled. With the files inside the configuration folder that
	 * were in the way of something else and would have been moved to the name
	 * of a copy anywhere else, and with the ones that had a conflict there
	 * and were moved away but not written (`unwritable`, or `deferred`).
	 */
	readonly trashed: readonly string[];
	/**
	 * Files a pull that stopped was writing, found with a content that is
	 * neither the one before the write nor the one written: half written, or
	 * edited since. They were moved to the `.trash/` of the vault before
	 * anything was compared or asked, also by a pull that then did nothing
	 * else. The plan takes each for a file that is not there; whether this
	 * pull fetched it is not said here. Listed by every pull until one has
	 * answered: a pull that was killed after moving one has told nothing.
	 */
	readonly halfWritten: readonly string[];
	/**
	 * The files of `halfWritten` that were being written with a merged
	 * content, each with where the content the vault had before the merge
	 * is: the remote's content is fetched for such a file, and nothing of
	 * the merge is left at its path. Listed like `halfWritten`, by every pull
	 * until one has answered.
	 */
	readonly halfMerged: readonly PullMerge[];
	/**
	 * The same for the copies of conflicts: a copy a pull that stopped was
	 * writing, found with another content than the one it was to get. Moved
	 * to the `.trash/` of the vault; the file it is a copy of was not
	 * written yet, and its conflict is handled from the start.
	 */
	readonly halfCopies: readonly string[];
	readonly deferred: readonly DeferredFile[];
	readonly unwritable: readonly UnwritablePath[];
	/** Files the user chose to keep when the history was rewritten. */
	readonly keptLocal: readonly string[];
	/**
	 * Conflict copies this pull moved to the `.trash/` of the vault because
	 * they were made 30 days ago or more (`conflict-tidy.ts`), as they were
	 * spelled. Only by a pull that ended "completed" or "incomplete", and
	 * never by a first fetch.
	 */
	readonly tidiedCopies: readonly string[];
	/** Symlinks of the remote that no record held before. Told once: they have a record now. */
	readonly newSymlinks: readonly string[];
	/**
	 * The one-time notices that apply for the first time, already
	 * remembered; and "plugin-not-listed", which is told every time.
	 */
	readonly notices: readonly NoticeRef[];
	/** Whether views were closed while the pull wrote, and reopened since. */
	readonly closedViews: boolean;
	/**
	 * How many files the archive of the remote was asked for and did not
	 * give as they are listed: left out of it, or of another content. They
	 * were fetched one at a time instead. 0 when no archive was used.
	 */
	readonly refetched: number;
	/** What the fetching threw, when it stopped before the end. */
	readonly fetchError?: unknown;
	/**
	 * Set when this pull found that a push which had ended without knowing
	 * whether it went through did go through (`push-pending.ts`): what that
	 * push changed on the remote. It is recorded now, and told as a success.
	 */
	readonly recoveredPush?: PushCounts;
	/**
	 * Set instead when that push was one that untracked (`untrack.ts`): how
	 * many files it took out of the remote. They are still on this device.
	 */
	readonly recoveredUntrack?: number;
}
