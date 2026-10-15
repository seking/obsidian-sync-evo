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

// Carries out what a pull decided (`pull-plan.ts`), step by step and in the
// order the plan gives. It decides nothing again, with one exception: every
// file is looked at once more right before it is changed, because the plan
// was made from a scan that is seconds or minutes old by then, and the user
// may be typing.
//
// Three things are in one place each, so that each can change on its own:
// the look before a change (`look`), the writing of remote content with its
// marker and its record (`writeRemote`), and the handling of a conflict
// (`conflict`).
//
// A copy is always made in the folder of the copies, under a name of its own
// (`conflict-name.ts`), whatever the file is and wherever it lies. Whether a
// copy with the same content is there already is not looked at: only the
// copy a pull that stopped was writing for this very conflict is used again
// (`AwaitedConflict`).
//
// Where the device is set to merge (`ApplyEnv.merge`), a conflict is merged
// before a copy is thought of (`merge`), and the copy is what is left for
// every conflict that does not merge. The file then holds the changes of
// both sides, which the remote does not: its record names the remote's
// content, so that the push after this pull sends the file. What the vault
// had before is put into its `.trash/` first.
//
// Inside the configuration folder no copy is ever made (`isInConfigDir`).
// What would be kept as a copy anywhere else goes to the `.trash/` of the
// vault there: the vault's side of a conflict (`replaceSettings`), and a file
// that is in the way of something else (`moveAside`).
//
// What goes wrong with one file does not stop the others. It ends up in one
// of two lists. "Unwritable": the vault refused; the path has no record of
// the new content, so the next pull tries again, and the base revision may
// move. "Deferred": the file was left alone because it could not be
// handled safely just now; the base revision must not move, so that the next
// sync does not take the pull for done. A failure of the sync state is
// neither: it is thrown, and ends the pull.

import type { Backend, RemoteEntry, RemoteListing } from "./backend";
import { CONFLICT_FOLDER, MERGED_FOLDER, conflictCopyPath, isConflictFolder, mergedCopyPath } from "./conflict-name";
import { isInConfigDir } from "./exclusion";
import { areMergeable, isMergedPath, mergeContents } from "./merge";
import { foldedKey, pathKey } from "./paths";
import type { LocalEntry, SyncRecord } from "./plan";
import {
	type ContentSource,
	type DeferReason,
	type DeferredFile,
	type PullConflict,
	type PullConflictCause,
	type PullMerge,
	type PullVault,
	readWhole,
	type SourcedFile,
	SourcedStateError,
	type UnwritablePath,
	type UnwritableReason,
} from "./pull-io";
import type {
	FolderRename,
	PullAside,
	PullDelete,
	PullPlan,
	PullRename,
	PullWrite,
	RecordChange,
	StrayMove,
} from "./pull-plan";
import {
	type FileStat,
	makeMarker,
	makeMergeMarker,
	makeRecord,
	markedRecord,
	RACY_MTIME_MARGIN_MS,
	type StateStore,
} from "./state";

/** What an LFS pointer file starts with. Such a file is written as it is. */
const LFS_POINTER_START = "version https://git-lfs.github.com/spec/v1";

export function isLfsPointer(content: Uint8Array): boolean {
	if (content.length < LFS_POINTER_START.length) return false;
	for (let i = 0; i < LFS_POINTER_START.length; i++) {
		if (content[i] !== LFS_POINTER_START.charCodeAt(i)) return false;
	}
	return true;
}

/** A vault file whose content is known: it had `hash` when it looked like `stat`. */
export interface Seen {
	readonly hash: string;
	readonly stat: FileStat;
}

/** A vault file as it was read. */
type ReadFile = Seen & { readonly content: Uint8Array };

/**
 * A conflict whose copy a pull that stopped wrote in full, and which no pull
 * has told (`settleCopy` in `pull.ts`). Whether it got as far as the file is
 * not kept anywhere, and the content it was to write is not either. So it is
 * told when `path` holds what the remote has by then: found so, or written
 * by the plan. Until then it waits, across pulls.
 *
 * It is also how the conflict is gone on with and not begun again: where the
 * file still holds the content of `hash`, the copy at `copyPath` is the one
 * of this conflict, and no second one is made (`awaitedCopy`).
 */
export interface AwaitedConflict {
	readonly path: string;
	readonly copyPath: string;
	/** The hash of what the copy was written with. */
	readonly hash: string;
}

/** What a pull did, collected as it goes. */
export class Tally {
	fetched = 0;
	deleted = 0;
	renamed = 0;
	readonly conflicts: PullConflict[] = [];
	/** `PullResult.merged`. */
	readonly merged: PullMerge[] = [];
	/** `PullResult.replacedSettings`. */
	readonly replacedSettings: string[] = [];
	readonly trashed: string[] = [];
	/** `PullResult.halfWritten`. */
	readonly halfWritten: string[] = [];
	/** `PullResult.halfMerged`. */
	readonly halfMerged: PullMerge[] = [];
	/** `PullResult.halfCopies`. */
	readonly halfCopies: string[] = [];
	readonly deferred: DeferredFile[] = [];
	readonly unwritable: Omit<UnwritablePath, "isNew">[] = [];
	/**
	 * What the "unwritable-path" notices are about: the paths of the remote
	 * the vault refused to write in this pull, as the remote spells them,
	 * and the vault files it refused to take away or to move. Beside each,
	 * the path it was reported under in `unwritable`.
	 */
	readonly refused: { readonly remotePath: string; readonly reportedAs: string }[] = [];
	fetchError: unknown = undefined;
	/** Files the archive did not give as they are listed (`PullResult.refetched`). */
	refetched = 0;
	/** Keys written with the remote's content in this pull. */
	readonly written = new Set<string>();
	/** Paths written in this pull whose content is an LFS pointer. */
	readonly lfsPointers: string[] = [];
	/** Whether a `community-plugins.json` was written that does not list this plugin. */
	pluginNotListed = false;
}

export interface ApplyEnv {
	readonly store: StateStore;
	readonly backend: Backend;
	readonly vault: PullVault;
	readonly fetchContents: ContentSource;
	readonly deviceName: string;
	readonly now: () => number;
	/** When the pull began: see `makeRecord`. */
	readonly startedAt: number;
	readonly signal?: AbortSignal;
	readonly listing: RemoteListing;
	/**
	 * Whether a file goes to the `.trash/` of the vault before it is deleted
	 * or written over: the history was rewritten, and the content may be
	 * nowhere else.
	 */
	readonly protect: boolean;
	/** `PullDeps.mergeConflicts`. */
	readonly merge: boolean;
	/** The vault files as the scan and the hashing found them, by key. Kept up to date here. */
	readonly seen: Map<string, Seen>;
	/** Every path the scan found, for the files below a folder that is to be renamed. */
	readonly localPaths: Iterable<string>;
	/** The conflicts whose copy is written and that are yet to be told, as the markers were settled. */
	readonly awaited: readonly AwaitedConflict[];
	readonly tally: Tally;
	/** Awaited before each write of a file. */
	readonly beforeWrite: () => Promise<void>;
	/** `PullDeps.beingEdited`. */
	readonly beingEdited?: (path: string) => boolean;
	readonly onStep?: (done: number, total: number) => void;
	/** The name of the configuration folder, where no copy of a conflict is made. */
	readonly configDir: string;
	/** The key of `community-plugins.json` and the id it has to list. */
	readonly communityPluginsKey: string;
	readonly pluginId: string;
}

/** A name in a folder, by what it is and how the vault spells it. */
interface ListedName {
	readonly type: "file" | "folder";
	readonly name: string;
}

/** `look` and its like answer this when the file was put off; it is in the tally by then. */
const PUT_OFF = Symbol("put off");
type PutOff = typeof PUT_OFF;

/** The most names tried for one copy before the path is given up as unwritable. */
const MAX_COPY_ATTEMPTS = 1000;

/**
 * Carries out `plan`. Answers `false` when the signal stopped it before the
 * end. Everything that was done by then is recorded.
 */
export function applyPlan(env: ApplyEnv, plan: PullPlan): Promise<boolean> {
	return new Applier(env).run(plan);
}

class Applier {
	private readonly store: StateStore;
	private readonly vault: PullVault;
	private readonly tally: Tally;
	private readonly seen: Map<string, Seen>;
	private remoteNames: Set<string> | undefined;
	/** Folder renames that are in effect, in the order of the plan. */
	private readonly renamedFolders: FolderRename[] = [];
	/** New spellings of folders whose rename could not be looked at: a listing failed. */
	private readonly unseenFolders: string[] = [];
	/**
	 * The folders that were not renamed because a file in them is being
	 * typed in (`applyFolderRename`), by their new names. Their files are
	 * not renamed either: the whole folder waits for the next sync.
	 */
	private readonly editedFolders: string[] = [];
	/** Keys whose rename did not happen. The write that comes after is not made. */
	private readonly held = new Map<string, "deferred" | "unwritable">();
	private readonly listings = new Map<string, ReadonlyMap<string, ListedName>>();
	private done = 0;
	private total = 0;

	constructor(private readonly env: ApplyEnv) {
		this.store = env.store;
		this.vault = env.vault;
		this.tally = env.tally;
		this.seen = env.seen;
	}

	async run(plan: PullPlan): Promise<boolean> {
		this.total =
			plan.records.length +
			plan.deletes.length +
			plan.asides.length +
			plan.folderRenames.length +
			plan.renames.length +
			plan.strays.length +
			plan.writes.length;
		// The total before the first step: a fetch of everything at once
		// shows nothing of its own for a while.
		if (this.total > 0) this.env.onStep?.(0, this.total);

		// The record changes touch no file and take no time. They are all
		// made even when the signal is already set, so that what they settle
		// (a symlink that was told, a file the user chose to keep) is not
		// left half settled.
		for (const change of plan.records) {
			await this.applyRecord(change);
			this.step();
		}

		const phases: readonly (() => Promise<boolean>)[] = [
			() => this.each(plan.deletes, (entry) => this.applyDelete(entry)),
			() => this.each(plan.asides, (entry) => this.applyAside(entry)),
			() => this.each(plan.folderRenames, (entry) => this.applyFolderRename(entry)),
			() => this.each(plan.renames, (entry) => this.applyRename(entry)),
			() => this.each(plan.strays, (entry) => this.applyStray(entry)),
			() => this.applyWrites(plan.writes),
		];
		for (const phase of phases) {
			if (!(await phase())) return false;
		}

		// Only the folders the plan names, and only when nothing is in them:
		// a folder that was empty before is the user's.
		for (const folder of plan.emptiedFolders) {
			try {
				await this.vault.removeFolderIfEmpty(folder);
			} catch {
				// An empty folder that stays does no harm.
			}
		}
		this.listings.clear();
		return true;
	}

	private aborted(): boolean {
		return this.env.signal?.aborted === true;
	}

	private step(): void {
		this.done += 1;
		this.env.onStep?.(this.done, this.total);
	}

	private async each<T>(items: readonly T[], apply: (item: T) => Promise<void>): Promise<boolean> {
		for (const item of items) {
			if (this.aborted()) return false;
			await apply(item);
			this.step();
		}
		return true;
	}

	private defer(path: string, reason: DeferReason): void {
		this.tally.deferred.push({ path, reason });
	}

	private unwritable(path: string, reason: UnwritableReason, error?: unknown): void {
		this.tally.unwritable.push({ path, reason, ...(error === undefined ? {} : { error }) });
	}

	/**
	 * The same, for the write or the rename of a remote path itself, or the
	 * removal or the move of a vault file: told once (`Tally.refused`).
	 * `remotePath` is what the notice is remembered under, so it has to be
	 * the same path for as long as the same thing fails.
	 */
	private refuse(remotePath: string, reportedAs: string, reason: UnwritableReason, error?: unknown): void {
		this.unwritable(reportedAs, reason, error);
		this.tally.refused.push({ remotePath, reportedAs });
	}

	// -----------------------------------------------------------------------
	// Looking at the vault

	/** Where a path the scan found is now, after the folder renames that were made. */
	private current(path: string): string {
		let now = path;
		for (const { from, to } of this.renamedFolders) {
			if (now.startsWith(`${from}/`)) now = to + now.slice(from.length);
		}
		return now;
	}

	/**
	 * What is at the path, spelled exactly so. The file system is not asked
	 * directly: where the cases are not told apart it answers "yes" for the
	 * old spelling of a file that was just renamed. Each folder on the way
	 * is listed instead, and the names compared in NFC with the cases told
	 * apart. Listings are kept until the next change to the vault.
	 *
	 * Throws when a folder on the way cannot be listed. Only folders that
	 * were just found in a listing are listed, so that is a failure and not
	 * a folder that is missing; and it must never read as "nothing there",
	 * which would pass for a rename that was already made.
	 */
	private async exactly(path: string): Promise<"file" | "folder" | null> {
		let folder = "";
		let found: "file" | "folder" | null = "folder";
		for (const part of path.split("/")) {
			if (found !== "folder") return null;
			const names = await this.namesIn(folder);
			found = names.get(pathKey(part))?.type ?? null;
			folder = folder === "" ? part : `${folder}/${part}`;
		}
		return found;
	}

	/**
	 * The path of something a rename just put at `path`, as the vault spells
	 * it now. A rename gives the last name as it was asked for, but leaves
	 * the folders on the way as they are spelled (`PullVault.rename`): where
	 * the cases are not told apart, a file moved to `Notes/x.md` beside a
	 * folder `notes` is at `notes/x.md`. Read from the same listings as
	 * `exactly`: a name spelled so wins, then the one name that differs in
	 * case. A name that is not found is left as it was given, and so is the
	 * whole path when a folder cannot be listed.
	 */
	private async spelledNow(path: string): Promise<string> {
		try {
			let spelled = "";
			for (const part of path.split("/")) {
				const names = await this.namesIn(spelled);
				let name = names.get(pathKey(part))?.name;
				if (name === undefined) {
					const folded = foldedKey(part);
					const alike = [...names.values()].filter((entry) => foldedKey(entry.name) === folded);
					name = alike.length === 1 ? alike[0]?.name : undefined;
				}
				spelled = (spelled === "" ? "" : `${spelled}/`) + (name ?? part);
			}
			return spelled;
		} catch {
			return path;
		}
	}

	private async namesIn(folder: string): Promise<ReadonlyMap<string, ListedName>> {
		const cached = this.listings.get(folder);
		if (cached !== undefined) return cached;
		const names = new Map<string, ListedName>();
		const listed = await this.vault.list(folder === "" ? "/" : folder);
		// Only the last part of what comes back is read: a lister builds the
		// rest from the folder it was asked for.
		for (const file of listed.files) names.set(pathKey(lastPart(file)), { type: "file", name: lastPart(file) });
		for (const sub of listed.folders) names.set(pathKey(lastPart(sub)), { type: "folder", name: lastPart(sub) });
		this.listings.set(folder, names);
		return names;
	}

	/** Every change to the vault goes through here, so that no listing outlives it. */
	private async change<T>(act: () => Promise<T>): Promise<T> {
		this.listings.clear();
		try {
			return await act();
		} finally {
			this.listings.clear();
		}
	}

	/**
	 * Whether the file at `path` may be looked at and changed now: nobody
	 * is typing in it, and what its editors hold is on disk. Asked before
	 * anything is done to a file. Otherwise the file is put off, with the
	 * reason, and nothing was done to it.
	 *
	 * A file that is being typed in is not even asked to save: on a phone
	 * the composition of an input method is on the screen and not in the
	 * note, and a save in the middle of it is one more thing done to the
	 * editor under the user's fingers.
	 */
	private async saved(path: string): Promise<boolean> {
		if (this.env.beingEdited?.(path) === true) {
			this.defer(path, "being-edited");
			return false;
		}
		try {
			if ((await this.vault.saveOpenEditors(path)) !== "failed") return true;
		} catch {
			// As when the editor says it could not.
		}
		this.defer(path, "save-failed");
		return false;
	}

	/**
	 * The content hash of the file at `path`, by its time and size when those
	 * are the ones it was last hashed at, by reading it otherwise. A time too
	 * close to the start of the pull is never trusted (`RACY_MTIME_MARGIN_MS`):
	 * an edit within the same tick of the clock and to the same size would
	 * not show.
	 */
	private async probe(path: string, key: string): Promise<Seen | "folder" | null> {
		const stat = await this.vault.stat(path);
		if (stat === null) {
			this.seen.delete(key);
			return null;
		}
		if (stat.type === "folder") return "folder";
		const before = this.seen.get(key);
		if (
			before !== undefined &&
			before.stat.mtime === stat.mtime &&
			before.stat.size === stat.size &&
			stat.mtime < this.env.startedAt - RACY_MTIME_MARGIN_MS
		) {
			return before;
		}
		const whole = await readWhole(this.vault, path, stat);
		return this.remember(key, await this.env.backend.hashContent(whole.content), whole.stat);
	}

	private remember(key: string, hash: string, stat: FileStat): Seen {
		const seen: Seen = { hash, stat: { mtime: stat.mtime, size: stat.size } };
		this.seen.set(key, seen);
		return seen;
	}

	/**
	 * The look at a file right before it is changed: the editors that have
	 * it open save first, then the file is read again if it may have changed.
	 * Answers what is there now. A file that cannot be looked at safely is
	 * put off.
	 */
	private async look(path: string, key: string): Promise<Seen | "folder" | null | PutOff> {
		if (!(await this.saved(path))) {
			return PUT_OFF;
		}
		try {
			return await this.probe(path, key);
		} catch {
			this.defer(path, "unreadable");
			return PUT_OFF;
		}
	}

	/** A file's time and size, when there is a file. */
	private async statOf(path: string): Promise<FileStat | undefined> {
		try {
			const stat = await this.vault.stat(path);
			return stat?.type === "file" ? { mtime: stat.mtime, size: stat.size } : undefined;
		} catch {
			return undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Taking a file out of the way

	/** Deletes a file the plan gives up: to the `.trash/` of the vault when its content needs protecting. */
	private async trash(path: string, key: string): Promise<void> {
		await this.change(() => this.vault.trash(path, this.env.protect ? "vault-trash" : "user-setting"));
		if (this.env.protect) this.tally.trashed.push(path);
		this.seen.delete(key);
	}

	/**
	 * A name for the copy of `original` that nothing has: not the vault, and
	 * not the remote, whose file of that name this or a later pull writes.
	 * Whether a file is one of the same content plays no part. The plain
	 * name is taken as a matter of course: it tells the day and not the
	 * time, and a note in conflict twice on a day gets a number the second
	 * time.
	 *
	 * Nor the name of the copy of a conflict that waits (`AwaitedConflict`),
	 * also when that copy has just been deleted: the conflict is told by
	 * that name, and must not find the content of another file under it.
	 *
	 * Throws when the copy has nowhere to go (`copyFolder`), or no name is
	 * free.
	 */
	private async freeCopyPath(original: string): Promise<string> {
		const folder = await this.copyFolder();
		const at = new Date(this.env.now());
		for (let n = 1; n <= MAX_COPY_ATTEMPTS; n++) {
			const candidate = conflictCopyPath(original, this.env.deviceName, at, n, folder);
			if (this.remoteHas(candidate) || this.awaitedHas(candidate)) continue;
			if ((await this.vault.stat(candidate)) === null) return candidate;
		}
		throw new Error(`No free name for a copy of ${original}`);
	}

	/**
	 * The folder of the copies as the vault spells it: one that is there
	 * under another case is used as it is, so that the copies of a vault are
	 * in one folder also where the cases are told apart. A folder that is
	 * missing is not made here: writing the copy or moving a file to its
	 * name makes it (`PullVault.write`, `PullVault.rename`).
	 *
	 * Throws when a file has the name and no folder does. Nothing is moved
	 * out of the way for a copy: it is not written, and the path it would
	 * have been a copy of is reported as one that cannot be written.
	 */
	private async copyFolder(): Promise<string> {
		const named = [...(await this.namesIn("")).values()].filter((entry) => isConflictFolder(entry.name));
		const folders = named.filter((entry) => entry.type === "folder");
		const folder = folders.find((entry) => entry.name === CONFLICT_FOLDER) ?? folders[0];
		if (folder !== undefined) return folder.name;
		if (named.length > 0) throw new Error(`a file is at ${named[0]?.name ?? CONFLICT_FOLDER}`);
		return CONFLICT_FOLDER;
	}

	/** Whether a conflict that waits has its copy at the path. Without the cases, like `remoteHas`. */
	private awaitedHas(path: string): boolean {
		const folded = foldedKey(path);
		return this.env.awaited.some((waiting) => foldedKey(waiting.copyPath) === folded);
	}

	private remoteHas(path: string): boolean {
		if (this.remoteNames === undefined) {
			// Without the cases: a copy that differs from a remote path only
			// in case could not be sent.
			this.remoteNames = new Set(this.env.listing.entries.map((entry) => foldedKey(entry.path)));
		}
		return this.remoteNames.has(foldedKey(path));
	}

	/**
	 * To the `.trash/` of the vault, whatever the setting: for content that
	 * may be nowhere else.
	 */
	private async trashInVault(path: string, key: string): Promise<void> {
		await this.change(() => this.vault.trash(path, "vault-trash"));
		this.seen.delete(key);
	}

	/**
	 * Moves the file at `path` to the name of a copy of `original`, in the
	 * folder of the copies, which the rename makes when it is missing. By a
	 * rename, so that its content is never in two places or in none. Answers
	 * whether it is out of the way. When the vault refused, the file is
	 * reported and told once under `noticePath`: what the pull could not do
	 * because the file is still there.
	 *
	 * Inside the configuration folder the copy is not made: the file goes to
	 * the `.trash/` of the vault, and is told as moved there.
	 */
	private async moveAside(
		path: string,
		key: string,
		original: string,
		cause: PullConflictCause,
		noticePath: string,
	): Promise<boolean> {
		if (isInConfigDir(original, this.env.configDir)) {
			try {
				await this.trashInVault(path, key);
			} catch (error) {
				this.refuse(noticePath, path, "trash-failed", error);
				return false;
			}
			this.tally.trashed.push(path);
			return true;
		}
		let copy: string;
		try {
			copy = await this.freeCopyPath(original);
			await this.change(() => this.vault.rename(path, copy));
		} catch (error) {
			this.refuse(noticePath, path, "rename-failed", error);
			return false;
		}
		// Reported as it is spelled now: a folder that was made since the
		// name was chosen may be spelled otherwise.
		copy = await this.spelledNow(copy);
		const was = this.seen.get(key);
		this.seen.delete(key);
		if (was !== undefined) this.seen.set(pathKey(copy), was);
		this.tally.conflicts.push({ path: original, copyPath: copy, cause });
		return true;
	}

	// -----------------------------------------------------------------------
	// The steps before the writes

	private async applyRecord(change: RecordChange): Promise<void> {
		if (change.type === "drop") {
			await this.store.deleteRecord(change.key);
			return;
		}
		if (change.type === "mark") {
			await this.store.commitWrite(markedRecord(change.record, change.wasExcluded));
			return;
		}
		// The time and the size only go with a record of what the file holds.
		const seen = change.local === undefined ? undefined : this.seen.get(pathKey(change.local.path));
		const stat = seen !== undefined && seen.hash === change.record.hash ? seen.stat : undefined;
		await this.store.commitWrite(makeRecord(change.record, stat, this.env.startedAt));
	}

	private async applyDelete(entry: PullDelete): Promise<void> {
		const path = entry.local.path;
		const now = await this.look(path, pathKey(path));
		if (now === PUT_OFF) return;
		if (now !== null) {
			// Edited since the decision, or a folder by now. That is the
			// remote deleting what the vault changed: the file stays, and so
			// does its record, which is what the next plan would decide too.
			// Nothing is put off by it.
			if (now === "folder" || now.hash !== entry.local.hash) return;
			try {
				await this.trash(path, pathKey(path));
			} catch (error) {
				this.refuse(path, path, "trash-failed", error);
				return;
			}
			this.tally.deleted += 1;
		}
		// Gone by the user's hand or by ours: the record goes with it.
		await this.settleRecord(entry.key, entry.recordAfter);
	}

	/** Stores what the path is from now on, or removes its record. */
	private async settleRecord(key: string, after: SyncRecord | undefined): Promise<void> {
		if (after === undefined) await this.store.deleteRecord(key);
		else await this.store.commitWrite(makeRecord(after, undefined, this.env.startedAt));
	}

	private async applyAside(entry: PullAside): Promise<void> {
		const path = entry.local.path;
		if (!(await this.saved(path))) {
			return;
		}
		// Whatever the file holds by now goes along: a rename loses nothing.
		// Not knowing whether it is there is no reason to take its record.
		let there: boolean;
		try {
			there = (await this.vault.stat(path))?.type === "file";
		} catch {
			this.defer(path, "unreadable");
			return;
		}
		// Told under the path the remote has something else at now, which
		// the vault cannot follow while the file is in its place.
		const { nameAfter } = entry;
		if (there && !(await this.moveAside(path, pathKey(path), nameAfter, entry.cause, nameAfter))) return;
		if (entry.record !== undefined || entry.recordAfter !== undefined) {
			await this.settleRecord(entry.key, entry.recordAfter);
		}
	}

	private async applyFolderRename(entry: FolderRename): Promise<void> {
		let hasOld: boolean;
		let hasNew: "file" | "folder" | null;
		try {
			hasOld = (await this.exactly(entry.from)) === "folder";
			hasNew = await this.exactly(entry.to);
		} catch {
			// Where the folder is could not be seen. Its files are not
			// renamed one by one on a guess; they wait.
			this.unseenFolders.push(entry.to);
			return;
		}
		if (!hasOld && hasNew === "folder") {
			// A pull that stopped had renamed it.
			this.renamedFolders.push(entry);
			return;
		}
		if (!hasOld || hasNew !== null) return;
		// A file in the folder is being typed in. The folder is not renamed
		// under it, and its other files are not renamed one by one either:
		// where the disk does not tell the cases apart, a file cannot get
		// the folder's new spelling by itself, and each would be told as a
		// path the vault refused. All of the folder waits for the next sync.
		if (this.editedBelow(entry.from)) {
			this.editedFolders.push(entry.to);
			return;
		}
		// When the vault refuses, or accepts and does nothing, the files are
		// renamed one by one instead; each of those steps looks where its
		// file is.
		try {
			await this.change(() => this.vault.rename(entry.from, entry.to));
			if ((await this.exactly(entry.to)) === "folder") this.renamedFolders.push(entry);
		} catch {
			return;
		}
		// Both there: something appeared under the new name since the scan.
		// Nothing is renamed over it, and the files follow one by one.
	}

	/** Whether a file the scan found below `folder` is being typed in right now. Without the cases, like the question. */
	private editedBelow(folder: string): boolean {
		const { beingEdited } = this.env;
		if (beingEdited === undefined) return false;
		const inside = `${foldedKey(folder)}/`;
		for (const path of this.env.localPaths) {
			if (foldedKey(path).startsWith(inside) && beingEdited(this.current(path))) return true;
		}
		return false;
	}

	private async applyRename(rename: PullRename): Promise<void> {
		const { key, to } = rename;
		// What is at `to` once the step is done, when that is known.
		let landed: Seen | undefined;

		if (rename.step === "already-renamed") {
			landed = this.seen.get(key);
		} else {
			const scannedKey = pathKey(rename.from.path);
			const from = this.current(rename.from.path);
			let outcome: Seen | undefined | "done" | "deferred" | "unwritable";
			if (rename.step === "rename") outcome = await this.renameFile(from, scannedKey, rename);
			else if (rename.step === "delete-old") outcome = await this.deleteOld(from, scannedKey, rename.from);
			else outcome = await this.oldAside(from, scannedKey, to);
			if (outcome === "deferred" || outcome === "unwritable") {
				this.held.set(key, outcome);
				return;
			}
			// After the other two steps the file under the new spelling is
			// the one the scan found there.
			landed = outcome === "done" ? this.seen.get(key) : outcome;
		}

		// The new record before the old one goes: a pull that stops between
		// the two leaves a record without a file, which is dropped, rather
		// than a file without a record, which is a conflict.
		const { recordAfter, dropRecord } = rename;
		if (recordAfter !== undefined) {
			const stat = landed !== undefined && landed.hash === recordAfter.hash ? landed.stat : undefined;
			await this.store.commitWrite(makeRecord(recordAfter, stat, this.env.startedAt));
		}
		if (dropRecord !== undefined && pathKey(dropRecord.path) !== key) {
			await this.store.deleteRecord(pathKey(dropRecord.path));
		}
		if (rename.step === "rename") this.tally.renamed += 1;
	}

	/**
	 * Gives the file at `from` the name `to`. Answers what is at `to`
	 * afterwards, when its content is known. A folder that cannot be listed
	 * on the way puts the file off: where it is has to be seen, not guessed.
	 */
	private async renameFile(
		from: string,
		scannedKey: string,
		rename: PullRename & { readonly step: "rename" },
	): Promise<Seen | undefined | "deferred" | "unwritable"> {
		if (this.editedFolders.some((folder) => rename.to.startsWith(`${folder}/`))) {
			// The file that is typed in, and the ones that wait with it.
			const typing = this.env.beingEdited?.(from) === true;
			this.defer(rename.from.path, typing ? "being-edited" : "depends-on-deferred");
			return "deferred";
		}
		try {
			if (this.unseenFolders.some((folder) => rename.to.startsWith(`${folder}/`))) {
				throw new Error("the folder could not be listed");
			}
			return await this.renameSeen(from, scannedKey, rename);
		} catch {
			this.defer(rename.from.path, "unreadable");
			return "deferred";
		}
	}

	private async renameSeen(
		expected: string,
		scannedKey: string,
		rename: PullRename & { readonly step: "rename" },
	): Promise<Seen | undefined | "deferred" | "unwritable"> {
		const { key, to } = rename;
		const atNew = (await this.exactly(to)) === "file";

		// Where the file is: where the folder renames should have brought
		// it, or, when one of them was not made after all, where the scan
		// found it. That is looked at, not assumed.
		let from: string | undefined;
		for (const candidate of [expected, rename.from.path]) {
			if (pathKey(candidate) !== key && (await this.exactly(candidate)) === "file") {
				from = candidate;
				break;
			}
		}

		if (from === undefined) {
			if (!atNew) {
				// Under neither spelling. Nothing is known about the file,
				// so nothing is said about it in the records either.
				this.refuse(to, rename.from.path, "rename-failed");
				return "unwritable";
			}
			// Already under the new name: the folder renames brought it
			// there, or a pull that stopped did.
			const brought = this.seen.get(scannedKey);
			if (brought !== undefined && pathKey(expected) === key) {
				this.seen.delete(scannedKey);
				this.seen.set(key, brought);
			}
			return this.seen.get(key);
		}

		if (atNew) {
			// Another file has the name, on a device that tells the cases
			// apart. It moves to a copy first, by a rename; renaming over it
			// would fail, and must never succeed.
			if (!(await this.saved(to))) {
				return "deferred";
			}
			if (!(await this.moveAside(to, key, to, "name-taken", to))) return "unwritable";
		}

		const now = await this.look(from, scannedKey);
		if (now === PUT_OFF) return "deferred";
		try {
			await this.change(() => this.vault.rename(from, to));
		} catch (error) {
			this.refuse(to, from, "rename-failed", error);
			return "unwritable";
		}
		// A rename that was accepted and left the old spelling in place did
		// not do what the record is about to say.
		if ((await this.exactly(to)) !== "file") {
			this.refuse(to, from, "rename-failed");
			return "unwritable";
		}
		this.seen.delete(scannedKey);
		const stat = await this.statOf(to);
		if (now === null || now === "folder" || stat === undefined) return undefined;
		return this.remember(key, now.hash, stat);
	}

	/** The file under the old spelling is a second copy of what the vault holds under the new one. */
	private async deleteOld(
		from: string,
		scannedKey: string,
		expected: LocalEntry,
	): Promise<"done" | "deferred" | "unwritable"> {
		const now = await this.look(from, scannedKey);
		if (now === PUT_OFF) return "deferred";
		if (now === null) return "done";
		if (now === "folder" || now.hash !== expected.hash) {
			this.defer(from, "changed-during-pull");
			return "deferred";
		}
		try {
			await this.trash(from, scannedKey);
		} catch (error) {
			this.refuse(from, from, "trash-failed", error);
			return "unwritable";
		}
		this.tally.deleted += 1;
		return "done";
	}

	private async oldAside(from: string, scannedKey: string, to: string): Promise<"done" | "deferred" | "unwritable"> {
		if (!(await this.saved(from))) {
			return "deferred";
		}
		try {
			if ((await this.vault.stat(from))?.type !== "file") return "done";
		} catch {
			this.defer(from, "unreadable");
			return "deferred";
		}
		return (await this.moveAside(from, scannedKey, to, "name-taken", to)) ? "done" : "unwritable";
	}

	private async applyStray(stray: StrayMove): Promise<void> {
		const scannedKey = pathKey(stray.local.path);
		const from = this.current(stray.local.path);
		let taken = stray.aside;
		try {
			if ((await this.exactly(from)) !== "file") return;
			// The name may have been taken since the scan, too.
			taken = taken || (await this.exactly(stray.to)) !== null;
		} catch {
			this.defer(from, "unreadable");
			return;
		}
		if (!(await this.saved(from))) {
			return;
		}
		// A stray is on no remote, so there is no path of the remote to tell
		// a refusal under. It is told under where the file is, which is where
		// the next pull finds it: that pull refuses it under the same path,
		// and is not told again, or moves it, and the notice is forgotten.
		if (taken) {
			await this.moveAside(from, scannedKey, stray.to, "name-taken", from);
			return;
		}
		try {
			await this.change(() => this.vault.rename(from, stray.to));
		} catch (error) {
			this.refuse(from, from, "rename-failed", error);
			return;
		}
		// Where the cases are not told apart and the folder still has its
		// old spelling, the file is where it was, and the rename succeeded.
		const to = await this.spelledNow(stray.to);
		const was = this.seen.get(scannedKey);
		this.seen.delete(scannedKey);
		if (was !== undefined) this.seen.set(pathKey(to), was);
	}

	// -----------------------------------------------------------------------
	// The writes

	private async applyWrites(writes: readonly PullWrite[]): Promise<boolean> {
		// What to fetch is a list of entries and nothing else, so that
		// whatever yields their content can be replaced.
		const waiting = new Map<string, PullWrite>();
		const wanted: RemoteEntry[] = [];
		for (const write of writes) {
			const held = this.held.get(write.key);
			if (held === undefined) {
				waiting.set(write.remote.path, write);
				wanted.push(write.remote);
				continue;
			}
			if (held === "deferred") this.defer(write.remote.path, "depends-on-deferred");
			else this.unwritable(write.remote.path, "depends-on-unwritable");
			this.step();
		}
		if (wanted.length === 0) return true;

		const contents = this.env.fetchContents(this.env.listing.revision, wanted)[Symbol.asyncIterator]();
		let stopped = false;
		try {
			for (;;) {
				if (this.aborted()) {
					stopped = true;
					break;
				}
				let next: IteratorResult<SourcedFile>;
				try {
					next = await contents.next();
				} catch (error) {
					// Not a failure to fetch, and not for the next sync to
					// mend: thrown as the store threw it, like every other
					// failure of the sync state.
					if (error instanceof SourcedStateError) throw error.cause;
					if (this.aborted()) {
						stopped = true;
						break;
					}
					// The files that are written stay written and recorded.
					// The rest waits for the next sync.
					this.tally.fetchError = error;
					break;
				}
				if (next.done === true) break;
				const write = waiting.get(next.value.entry.path);
				if (write === undefined) continue;
				waiting.delete(next.value.entry.path);
				await this.applyWrite(write, next.value.content, next.value.hash);
				this.step();
			}
		} finally {
			try {
				await contents.return?.();
			} catch {
				// Nothing more is wanted from it.
			}
		}
		if (stopped) return false;
		for (const write of waiting.values()) this.defer(write.remote.path, "fetch-failed");
		return true;
	}

	private async applyWrite(write: PullWrite, content: Uint8Array, hashed?: string): Promise<void> {
		const { remote } = write;
		const path = remote.path;

		// Before anything is written, and for every source of content alike.
		// A source that hashed the content hands the hash over (`SourcedFile`);
		// the comparison is made here all the same.
		if ((hashed ?? (await this.env.backend.hashContent(content))) !== remote.hash) {
			this.defer(path, "hash-mismatch");
			return;
		}

		if (write.type === "download" && write.replacesFolder) {
			let gone = false;
			try {
				gone = await this.change(() => this.vault.removeFolderIfEmpty(path));
			} catch {
				gone = false;
			}
			if (!gone) {
				this.refuse(path, path, "folder-in-the-way");
				return;
			}
		}

		let now = await this.look(path, write.key);
		if (now === PUT_OFF) return;
		if (now === "folder") {
			// A folder the plan did not know of: it only knows folders by
			// the files the scan found in them. One that is empty (left by a
			// pull that stopped after deleting its files, or made by the
			// user) makes way; git has no empty folders to keep.
			let gone = false;
			try {
				gone = await this.change(() => this.vault.removeFolderIfEmpty(path));
			} catch {
				gone = false;
			}
			if (!gone) {
				this.refuse(path, path, "folder-in-the-way");
				return;
			}
			now = null;
		}
		if (now === null) {
			// Nothing there: new to the vault, or deleted here since the
			// decision while the remote changed it. Either way it is fetched.
			await this.writeRemote(path, remote, content, null);
			return;
		}
		if (now.hash === remote.hash) {
			// Already the remote's content: a pull that stopped wrote it.
			await this.store.commitWrite(makeRecord(recordOf(remote), now.stat, this.env.startedAt));
			return;
		}
		if (write.type === "download" && write.local !== undefined && now.hash === write.local.hash) {
			// Still what the record says: the one case in which a file is
			// written over. When the history was rewritten the remote may
			// never have had this content, and it goes to the trash first.
			if (this.env.protect) {
				try {
					await this.change(() => this.vault.trash(path, "vault-trash"));
				} catch (error) {
					this.refuse(path, path, "trash-failed", error);
					return;
				}
				this.tally.trashed.push(path);
				this.seen.delete(write.key);
			}
			await this.writeRemote(path, remote, content, this.env.protect ? null : now.hash);
			return;
		}
		// Planned as a conflict, or not what the decision saw: changed since,
		// or a file where there was none. All of them are the same case.
		await this.conflict(path, remote, content, write.record);
	}

	/**
	 * The one place remote content is written to the vault: marker, write,
	 * then the record and the end of the marker in one transaction. `content`
	 * has been checked against `remote.hash`. `before` is the hash of the
	 * file that is written over, or `null`.
	 *
	 * `lastLook` is asked once the marker is put and right before the write,
	 * with nothing of this pull's left in between. When it answers `false`
	 * nothing is written and the marker goes; it has said why itself.
	 */
	private async writeRemote(
		path: string,
		remote: RemoteEntry,
		content: Uint8Array,
		before: string | null,
		lastLook?: () => Promise<boolean>,
	): Promise<boolean> {
		const key = pathKey(path);
		await this.store.putMarker(makeMarker(path, before, remote.hash, false));
		await this.env.beforeWrite();
		// Once more, right before the write: the typing can have begun since
		// the file was looked at, while the content was fetched or views were
		// closed. Nothing was begun; the marker goes, as below.
		if (this.env.beingEdited?.(path) === true) {
			this.defer(path, "being-edited");
			await this.store.deleteMarker(key);
			return false;
		}
		if (lastLook !== undefined && !(await lastLook())) {
			// Nothing was begun, whatever is at the path by now. With the
			// marker left, a resume would take that for half a write.
			await this.store.deleteMarker(key);
			return false;
		}
		try {
			await this.change(() => this.vault.write(path, content));
		} catch (error) {
			await this.dropMarkerIfUntouched(path, key, before);
			this.refuse(path, path, "write-failed", error);
			return false;
		}
		const stat = await this.statOf(path);
		await this.store.commitWrite(makeRecord(recordOf(remote), stat, this.env.startedAt));
		if (stat === undefined) this.seen.delete(key);
		else this.remember(key, remote.hash, stat);

		this.tally.fetched += 1;
		this.tally.written.add(key);
		if (isLfsPointer(content)) this.tally.lfsPointers.push(path);
		if (key === this.env.communityPluginsKey && !listsPlugin(content, this.env.pluginId)) {
			this.tally.pluginNotListed = true;
		}
		return true;
	}

	// A write that failed may have left half a file. Then the marker stays,
	// for the resume to find. When the path is as it was, nothing was begun.
	private async dropMarkerIfUntouched(path: string, key: string, before: string | null): Promise<void> {
		let untouched = false;
		try {
			const stat = await this.vault.stat(path);
			if (stat === null) untouched = before === null;
			else if (stat.type === "file" && before !== null) {
				untouched = (await this.env.backend.hashContent(await this.vault.read(path))) === before;
			}
		} catch {
			untouched = false;
		}
		if (untouched) await this.store.deleteMarker(key);
	}

	// -----------------------------------------------------------------------
	// Conflicts

	/**
	 * Both sides have content the other never got. The vault's goes to a
	 * copy, the remote's to the path; in that order, so that the vault's
	 * content is in one of the two places whenever the pull stops.
	 *
	 * The editors save before the file is read, or what was typed last would
	 * be in neither place. They save again before the path is written,
	 * because the user may have typed on in between.
	 *
	 * Inside the configuration folder there is no copy (`replaceSettings`).
	 *
	 * `record` is what the path was last synced with, when the plan knew of
	 * such a content: what a merge compares the two sides with (`merge`).
	 */
	private async conflict(
		path: string,
		remote: RemoteEntry,
		content: Uint8Array,
		record: SyncRecord | undefined,
	): Promise<void> {
		const key = pathKey(path);
		let mine = await this.readSaved(path, key);
		if (mine === PUT_OFF) return;
		if (mine === null) {
			await this.writeRemote(path, remote, content, null);
			return;
		}
		if (mine.hash === remote.hash) {
			await this.store.commitWrite(makeRecord(recordOf(remote), mine.stat, this.env.startedAt));
			return;
		}

		if (isInConfigDir(path, this.env.configDir)) {
			await this.replaceSettings(path, key, remote, content);
			return;
		}

		let copy = await this.awaitedCopy(path, mine.hash);
		// Whether this pull wrote the copy. Only then is it ours to rewrite
		// or to take away again.
		const ours = copy === null;
		if (copy === null) {
			// Merged, where that can be done; the copy is for what is left.
			// Not a conflict a pull that stopped has made the copy of: that
			// one is gone on with as it was begun.
			const left = await this.merge(path, key, remote, content, mine, record);
			if (left === null) return;
			mine = left;
			copy = await this.writeCopy(path, null, mine, null);
			if (copy === null) return;
		}

		// Whether the file was deleted while the copy was made. The copy has
		// the content then, and the remote's is written like a new file.
		let gone = false;
		for (let rewrites = 0; ; rewrites++) {
			const now = await this.look(path, key);
			if (now === PUT_OFF) {
				await this.withdrawCopy(copy, ours);
				return;
			}
			if (now === null) {
				gone = true;
				break;
			}
			if (now !== "folder" && now.hash === mine.hash) break;
			// Changed since it was read. Our own copy is written again with
			// the newer content, at the same path, once. A file that keeps
			// changing is being typed in: it is left alone, and so that the
			// next sync does not find a copy from a moment ago and make
			// another, this one is taken away. What it held is in the file.
			if (now === "folder" || !ours || rewrites === 1) {
				await this.withdrawCopy(copy, ours);
				this.defer(path, "changed-during-pull");
				return;
			}
			const newer = await this.readSaved(path, key);
			if (newer === PUT_OFF) {
				await this.withdrawCopy(copy, ours);
				return;
			}
			if (newer === null) {
				gone = true;
				break;
			}
			if ((await this.writeCopy(path, copy, newer, mine.hash)) === null) {
				await this.withdrawCopy(copy, ours);
				return;
			}
			mine = newer;
		}

		const written = await this.writeRemote(path, remote, content, gone ? null : mine.hash);
		// The typing began at the last moment (`writeRemote`). The file is
		// as it was and will be other by the next sync, which would not
		// know this copy for its own and would make another.
		if (!written && this.env.beingEdited?.(path) === true) {
			await this.withdrawCopy(copy, ours);
			return;
		}
		// The conflict is over, or given up: either way no resume is to
		// take the copy for the first half of one that is under way.
		await this.store.deleteMarker(pathKey(copy));
		if (!written) return;
		this.tally.conflicts.push({ path, copyPath: copy, cause: "conflict" });
	}

	/**
	 * Merges the two sides of a conflict, where the device is set to and it
	 * can be done, and writes the merged content to the path. Answers `null`
	 * when nothing is left to do for the path in this pull: it was merged,
	 * or put off, or the pull was stopped. Otherwise the vault's content,
	 * for the copy that is made instead: `mine`, or what the file holds by
	 * now when it changed in between.
	 *
	 * The order is the one of a copy and the path (`conflict`): the vault's
	 * content is put into the `.trash/` of the vault first (`keepBefore`),
	 * then the file is looked at once more, then it is written. So the
	 * content from before the merge is in one of the two places whenever the
	 * pull stops, and the path is never without a file: a pull that stops in
	 * between finds the conflict as it was, and merges again.
	 *
	 * A file that changed since it was read is merged again with the newer
	 * content, once, and the content that is kept is written again with it,
	 * at the same place. A file that changed a second time is being typed
	 * in, and is left to the next sync. What was kept stays in the `.trash/`
	 * then, also when the file was put off: it holds nothing the file does
	 * not, and nothing takes a file out of there again.
	 */
	private async merge(
		path: string,
		key: string,
		remote: RemoteEntry,
		content: Uint8Array,
		mine: ReadFile,
		record: SyncRecord | undefined,
	): Promise<ReadFile | null> {
		const base = await this.baseOf(path, remote, content, mine, record);
		if (base === "stopped") return null;
		let merged = base === null ? null : mergeContents(path, mine.content, base, content);
		if (base === null || merged === null) return mine;

		let kept: string | null = null;
		for (let again = 0; ; again++) {
			const hash = await this.env.backend.hashContent(merged);
			if (hash === mine.hash) {
				// Everything the remote changed is in the file already. That
				// is also what a merge reads as that was written by a pull
				// which then lost its marker: merged again, it gives itself.
				// Nothing is written and nothing is kept; the record alone
				// says that the file is the remote's content with changes.
				await this.store.commitWrite(makeRecord(recordOf(remote), undefined, this.env.startedAt));
				return null;
			}
			// Without it nothing is merged: a merge can spoil a text, and
			// what the vault had would be nowhere then. A copy is made.
			kept = await this.keepBefore(path, kept, mine.content);
			if (kept === null) return mine;

			const now = await this.look(path, key);
			if (now === PUT_OFF) return null;
			if (now === null) {
				// Deleted while this went on. The remote's content is written
				// like a new file, as after a copy (`conflict`).
				await this.writeRemote(path, remote, content, null);
				return null;
			}
			if (now !== "folder" && now.hash === mine.hash) {
				await this.writeMerged(path, remote, merged, hash, mine.hash, kept);
				return null;
			}
			if (now === "folder" || again === 1) {
				this.defer(path, "changed-during-pull");
				return null;
			}
			const newer = await this.readSaved(path, key);
			if (newer === PUT_OFF) return null;
			if (newer === null) {
				await this.writeRemote(path, remote, content, null);
				return null;
			}
			if (newer.hash === remote.hash) {
				await this.store.commitWrite(makeRecord(recordOf(remote), newer.stat, this.env.startedAt));
				return null;
			}
			const next = mergeContents(path, newer.content, base, content);
			if (next === null) return newer;
			mine = newer;
			merged = next;
		}
	}

	/**
	 * What the file at `path` held when it was last synced, for a merge: the
	 * content of the record's hash, asked of the remote, in one request.
	 * `null` when there is nothing to merge with, for whatever reason; the
	 * conflict is then kept as a copy. "stopped" when the pull was stopped
	 * while the remote was asked: nothing was done to the file, and nothing
	 * is to be.
	 *
	 * Nothing is asked of the remote before everything else says that the
	 * conflict can be merged: the device is set to, the remote has a regular
	 * file, there is a record of one with a content that is neither side's,
	 * and both sides are text of a name that is merged.
	 *
	 * Not when the history was rewritten (`ApplyEnv.protect`): the remote's
	 * content may not have come from the record's then, and a merge would
	 * take for the remote's changes what never were changes. And not for a
	 * file below a submodule.
	 *
	 * Any failure of the request is the same as a remote that does not hold
	 * the content: a merge is an offer, and no reason to fail a pull.
	 */
	private async baseOf(
		path: string,
		remote: RemoteEntry,
		content: Uint8Array,
		mine: ReadFile,
		record: SyncRecord | undefined,
	): Promise<Uint8Array | null | "stopped"> {
		const { backend } = this.env;
		if (!this.env.merge || this.env.protect || backend.contentOf === undefined) return null;
		if (remote.kind !== "file" || record === undefined || record.kind !== "file") return null;
		// Not below a submodule: what a merge makes is neither side's, and
		// could not be sent from there. The vault's side is kept as a copy.
		if (remote.source !== undefined) return null;
		if (record.hash === mine.hash || record.hash === remote.hash) return null;
		if (!isMergedPath(path) || !areMergeable([mine.content, content])) return null;
		try {
			const base = await backend.contentOf(record.hash);
			if (base === null || (await backend.hashContent(base)) !== record.hash) return null;
			return base;
		} catch {
			return this.aborted() ? "stopped" : null;
		}
	}

	/**
	 * Puts the content a file had before a merge into the `.trash/` of the
	 * vault, whatever the app's setting for deleted files: into the folder
	 * of such content there (`MERGED_FOLDER`), under a name nothing has, or
	 * at `over`, where this pull put the content a moment ago. Answers where
	 * it is, or `null` when it could not be written.
	 *
	 * Written there as a file of its own, and not by moving the file away
	 * (`PullVault.trash`): the path would be empty until the merged content
	 * is written, and a pull that stopped in between would leave a file that
	 * reads as deleted on this device. Not directly in the `.trash/` either,
	 * where nothing tells it from a file the user deleted.
	 *
	 * No marker: what is half written there is in nobody's way, and a pull
	 * that resumes writes the content again, under the next name.
	 */
	private async keepBefore(path: string, over: string | null, content: Uint8Array): Promise<string | null> {
		try {
			const kept = over ?? (await this.freeMergedPath(path));
			await this.env.beforeWrite();
			await this.change(() => this.vault.write(kept, content));
			return kept;
		} catch {
			return null;
		}
	}

	/**
	 * A path for the content from before a merge that no file has
	 * (`mergedCopyPath`), with the day of this device's clock, like the name
	 * of a copy (`freeCopyPath`). Only the vault is asked: nothing in the
	 * `.trash/` is synced.
	 */
	private async freeMergedPath(path: string): Promise<string> {
		const at = new Date(this.env.now());
		for (let n = 1; n <= MAX_COPY_ATTEMPTS; n++) {
			const candidate = mergedCopyPath(path, at, n);
			if ((await this.vault.stat(candidate)) === null) return candidate;
		}
		throw new Error(`No free name in ${MERGED_FOLDER}/ for ${path}`);
	}

	/**
	 * Writes a merged content to the path, with the care of `writeRemote`:
	 * marker, write, then the record and the end of the marker in one
	 * transaction. `hash` is the hash of `merged`, `before` the hash of the
	 * file that is written over, which was looked at right before, and
	 * `kept` where its content is.
	 *
	 * The marker says what is written, which is not the remote's content
	 * (`makeMergeMarker`). The record names the remote's hash all the same:
	 * the file is the remote's content with changes on top, and the push
	 * after this pull sends it as that. So the record carries neither the
	 * time nor the size of the file. With them, the next sync would not read
	 * the file (`isUnchangedByStat`) and would take the record's hash for
	 * the file's: the merged content would never be sent, and read as in
	 * sync. Only a merge that came out as the remote's very content is
	 * recorded like a fetch.
	 */
	private async writeMerged(
		path: string,
		remote: RemoteEntry,
		merged: Uint8Array,
		hash: string,
		before: string,
		kept: string,
	): Promise<void> {
		const key = pathKey(path);
		await this.store.putMarker(makeMergeMarker(path, before, hash, remote.hash, kept));
		await this.env.beforeWrite();
		// As in `writeRemote`: nothing was begun, and the marker goes.
		if (this.env.beingEdited?.(path) === true) {
			this.defer(path, "being-edited");
			await this.store.deleteMarker(key);
			return;
		}
		try {
			await this.change(() => this.vault.write(path, merged));
		} catch (error) {
			await this.dropMarkerIfUntouched(path, key, before);
			this.refuse(path, path, "write-failed", error);
			return;
		}
		const stat = await this.statOf(path);
		const same = hash === remote.hash;
		await this.store.commitWrite(makeRecord(recordOf(remote), same ? stat : undefined, this.env.startedAt));
		if (stat === undefined) this.seen.delete(key);
		else this.remember(key, hash, stat);
		if (same) this.tally.written.add(key);
		this.tally.merged.push({ path, keptAt: kept });
	}

	/**
	 * A conflict inside the configuration folder. The vault's content goes to
	 * the `.trash/` of the vault and the remote's to the path; in that order,
	 * like a copy and the path, and by a move, which takes whatever the file
	 * holds by then.
	 *
	 * No marker is needed for the first half. A pull that stops after it
	 * finds no file at the path, which is a fetch, with or without a record
	 * (`decide` in `plan.ts`); nothing is moved a second time. The second
	 * half is a write like any other, with its marker, and with one more
	 * look at the path (`stillAway`).
	 */
	private async replaceSettings(path: string, key: string, remote: RemoteEntry, content: Uint8Array): Promise<void> {
		try {
			await this.trashInVault(path, key);
		} catch (error) {
			this.refuse(path, path, "trash-failed", error);
			return;
		}
		const written = await this.writeRemote(path, remote, content, null, () => this.stillAway(path, key));
		// A file that is in the trash and not replaced is told all the same.
		(written ? this.tally.replacedSettings : this.tally.trashed).push(path);
	}

	/**
	 * Whether the path `replaceSettings` emptied is still empty, right before
	 * it is written. The app writes its settings again whenever the user
	 * switches something, and a file that landed since the move would be
	 * written over, with its content at the path no more and not in the
	 * `.trash/` either. Such a file is moved there as well; the path is told
	 * once, and what it held before is two files there then.
	 *
	 * Once, like the copy of a conflict that is written again (`conflict`):
	 * a path that is filled a second time is being written to, and is left
	 * to the next sync as it is. Nothing is lost by that. The file holds the
	 * newest content and has no record of it, so it is a conflict again.
	 */
	private async stillAway(path: string, key: string): Promise<boolean> {
		for (let moves = 0; ; moves++) {
			let file: boolean;
			try {
				const stat = await this.vault.stat(path);
				if (stat === null) return true;
				file = stat.type === "file";
			} catch {
				this.defer(path, "unreadable");
				return false;
			}
			// A folder is not moved anywhere: the next pull finds it in the way.
			if (!file || moves === 1) {
				this.defer(path, "changed-during-pull");
				return false;
			}
			try {
				await this.trashInVault(path, key);
			} catch (error) {
				this.refuse(path, path, "trash-failed", error);
				return false;
			}
		}
	}

	/** Has the editors save, then reads the file. `null` when there is none. */
	private async readSaved(path: string, key: string): Promise<ReadFile | null | PutOff> {
		if (!(await this.saved(path))) {
			return PUT_OFF;
		}
		try {
			const stat = await this.vault.stat(path);
			if (stat === null || stat.type !== "file") return null;
			const { content, stat: read } = await readWhole(this.vault, path, stat);
			const seen = this.remember(key, await this.env.backend.hashContent(content), read);
			return { ...seen, content };
		} catch {
			this.defer(path, "unreadable");
			return PUT_OFF;
		}
	}

	/**
	 * The copy a pull that stopped wrote for this conflict, when it is still
	 * the copy of it: the file holds the content the copy was written with,
	 * and the copy is there and holds it too. The conflict is then gone on
	 * with from its second half, with no copy made.
	 *
	 * Only what the marker of that pull said is gone by (`AwaitedConflict`).
	 * The folder of the copies is not searched for a file of the same
	 * content: a conflict that is handled from the start makes a copy of its
	 * own, whatever is there.
	 */
	private async awaitedCopy(path: string, hash: string): Promise<string | null> {
		const key = pathKey(path);
		for (const waiting of this.env.awaited) {
			if (pathKey(waiting.path) !== key || waiting.hash !== hash) continue;
			// A copy of the earlier form is beside its file, and a folder
			// that was renamed since has taken it along.
			const candidate = this.current(waiting.copyPath);
			try {
				const there = await this.probe(candidate, pathKey(candidate));
				if (there !== null && there !== "folder" && there.hash === hash) return candidate;
			} catch {
				// A copy that cannot be read is not one to rely on.
			}
		}
		return null;
	}

	/**
	 * Writes the vault's content of `path` to a copy: a new one, or `over`,
	 * the one this pull wrote a moment ago with the content of hash
	 * `before`. Answers the path of the copy, or `null` when it could not be
	 * written. Then `path` must not be written either, and is reported.
	 */
	private async writeCopy(
		path: string,
		over: string | null,
		mine: ReadFile,
		before: string | null,
	): Promise<string | null> {
		let copy: string;
		try {
			copy = over ?? (await this.freeCopyPath(path));
		} catch (error) {
			this.refuse(path, path, "copy-unwritable", error);
			return null;
		}
		const copyKey = pathKey(copy);
		// With the path the copy is of: the name of the copy does not tell it.
		await this.store.putMarker(makeMarker(copy, before, mine.hash, true, path));
		await this.env.beforeWrite();
		try {
			await this.change(() => this.vault.write(copy, mine.content));
		} catch (error) {
			if (over === null) await this.dropMarkerIfUntouched(copy, copyKey, null);
			this.refuse(path, path, "copy-unwritable", error);
			return null;
		}
		const stat = await this.statOf(copy);
		if (stat !== undefined) this.remember(copyKey, mine.hash, stat);
		return copy;
	}

	/**
	 * Takes back a copy this pull wrote for a conflict it then gave up: to
	 * the `.trash/` of the vault, whatever the setting, and without its
	 * marker. With the marker left, a resume would take the copy for done
	 * and write the path without looking at it again.
	 */
	private async withdrawCopy(copy: string, ours: boolean): Promise<void> {
		if (!ours) return;
		const copyKey = pathKey(copy);
		try {
			if ((await this.vault.stat(copy)) !== null) {
				await this.change(() => this.vault.trash(copy, "vault-trash"));
				this.tally.trashed.push(copy);
			}
		} catch {
			// The copy stays. It holds nothing the file does not.
		}
		this.seen.delete(copyKey);
		await this.store.deleteMarker(copyKey);
	}
}

function recordOf(remote: RemoteEntry): SyncRecord {
	return { path: remote.path, kind: remote.kind, hash: remote.hash };
}

function lastPart(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Whether the content of a `community-plugins.json` names the plugin. Anything that cannot be read does not. */
function listsPlugin(content: Uint8Array, pluginId: string): boolean {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(content));
		return Array.isArray(parsed) && parsed.includes(pluginId);
	} catch {
		return false;
	}
}
