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
// What goes wrong with one file does not stop the others. It ends up in one
// of two lists. "Unwritable": the vault refused; the path has no record of
// the new content, so the next pull tries again, and the base revision may
// move. "Deferred": the file was left alone because it could not be
// handled safely just now; the base revision must not move, so that the next
// sync does not take the pull for done. A failure of the sync state is
// neither: it is thrown, and ends the pull.

import type { Backend, FetchedFile, RemoteEntry, RemoteListing } from "./backend";
import { CopyIndex, copyCandidate } from "./conflict-copies";
import { foldedKey, pathKey } from "./paths";
import type { LocalEntry, SyncRecord } from "./plan";
import type {
	ContentSource,
	DeferReason,
	DeferredFile,
	PullConflict,
	PullConflictCause,
	PullVault,
	UnwritablePath,
	UnwritableReason,
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
import { type FileStat, makeMarker, makeRecord, RACY_MTIME_MARGIN_MS, type StateStore } from "./state";

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

/** What a pull did, collected as it goes. */
export class Tally {
	fetched = 0;
	deleted = 0;
	renamed = 0;
	readonly conflicts: PullConflict[] = [];
	readonly trashed: string[] = [];
	readonly deferred: DeferredFile[] = [];
	readonly unwritable: Omit<UnwritablePath, "isNew">[] = [];
	/**
	 * What the "unwritable-path" notices are about: the paths of the remote
	 * the vault refused to write in this pull, as the remote spells them,
	 * and the vault files it refused to take away. Beside each, the path it
	 * was reported under in `unwritable`.
	 */
	readonly refused: { readonly remotePath: string; readonly reportedAs: string }[] = [];
	fetchError: unknown = undefined;
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
	/** The vault files as the scan and the hashing found them, by key. Kept up to date here. */
	readonly seen: Map<string, Seen>;
	/** Every path the scan found, for the copies among them. */
	readonly localPaths: Iterable<string>;
	readonly tally: Tally;
	/** Awaited before each write of a file. */
	readonly beforeWrite: () => Promise<void>;
	readonly onStep?: (done: number, total: number) => void;
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
	private readonly localCopies: CopyIndex;
	private remoteCopies: CopyIndex | undefined;
	private remoteNames: Set<string> | undefined;
	private remoteHashes: Map<string, string> | undefined;
	/** Folder renames that are in effect, in the order of the plan. */
	private readonly renamedFolders: FolderRename[] = [];
	/** New spellings of folders whose rename could not be looked at: a listing failed. */
	private readonly unseenFolders: string[] = [];
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
		this.localCopies = new CopyIndex(env.localPaths);
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
	 * removal of a vault file: told once (`Tally.refused`).
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

	private async save(path: string): Promise<boolean> {
		try {
			return (await this.vault.saveOpenEditors(path)) !== "failed";
		} catch {
			return false;
		}
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
		const content = await this.vault.read(path);
		return this.remember(key, await this.env.backend.hashContent(content), stat);
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
		if (!(await this.save(path))) {
			this.defer(path, "save-failed");
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
	 */
	private async freeCopyPath(original: string): Promise<string> {
		const at = new Date(this.env.now());
		for (let n = 1; n <= MAX_COPY_ATTEMPTS; n++) {
			const candidate = copyCandidate(original, this.env.deviceName, at, n);
			if (this.remoteHas(candidate)) continue;
			if ((await this.vault.stat(candidate)) === null) return candidate;
		}
		throw new Error(`No free name for a copy of ${original}`);
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
	 * Moves the file at `path` to the name of a copy of `original`, by a
	 * rename, so that its content is never in two places or in none. Answers
	 * the new path, or `null` when the vault refused.
	 */
	private async moveAside(
		path: string,
		key: string,
		original: string,
		cause: PullConflictCause,
	): Promise<string | null> {
		let copy: string;
		try {
			copy = await this.freeCopyPath(original);
			await this.change(() => this.vault.rename(path, copy));
		} catch (error) {
			this.unwritable(path, "rename-failed", error);
			return null;
		}
		// The copy is named after `original`, whose folders the vault may
		// spell otherwise; it is reported as it is spelled now.
		copy = await this.spelledNow(copy);
		const was = this.seen.get(key);
		this.seen.delete(key);
		if (was !== undefined) this.seen.set(pathKey(copy), was);
		this.localCopies.add(copy);
		this.tally.conflicts.push({ path: original, copyPath: copy, cause });
		return copy;
	}

	// -----------------------------------------------------------------------
	// The steps before the writes

	private async applyRecord(change: RecordChange): Promise<void> {
		if (change.type === "drop") {
			await this.store.deleteRecord(change.key);
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
		if (!(await this.save(path))) {
			this.defer(path, "save-failed");
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
		if (there && (await this.moveAside(path, pathKey(path), entry.nameAfter, entry.cause)) === null) return;
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
			if (!(await this.save(to))) {
				this.defer(to, "save-failed");
				return "deferred";
			}
			if ((await this.moveAside(to, key, to, "name-taken")) === null) return "unwritable";
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
		if (!(await this.save(from))) {
			this.defer(from, "save-failed");
			return "deferred";
		}
		try {
			if ((await this.vault.stat(from))?.type !== "file") return "done";
		} catch {
			this.defer(from, "unreadable");
			return "deferred";
		}
		return (await this.moveAside(from, scannedKey, to, "name-taken")) === null ? "unwritable" : "done";
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
		if (!(await this.save(from))) {
			this.defer(from, "save-failed");
			return;
		}
		if (taken) {
			await this.moveAside(from, scannedKey, stray.to, "name-taken");
			return;
		}
		try {
			await this.change(() => this.vault.rename(from, stray.to));
		} catch (error) {
			this.unwritable(from, "rename-failed", error);
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
				let next: IteratorResult<FetchedFile>;
				try {
					next = await contents.next();
				} catch (error) {
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
				await this.applyWrite(write, next.value.content);
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

	private async applyWrite(write: PullWrite, content: Uint8Array): Promise<void> {
		const { remote } = write;
		const path = remote.path;

		// Before anything is written, and for every source of content alike.
		if ((await this.env.backend.hashContent(content)) !== remote.hash) {
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
		await this.conflict(path, remote, content);
	}

	/**
	 * The one place remote content is written to the vault: marker, write,
	 * then the record and the end of the marker in one transaction. `content`
	 * has been checked against `remote.hash`. `before` is the hash of the
	 * file that is written over, or `null`.
	 */
	private async writeRemote(
		path: string,
		remote: RemoteEntry,
		content: Uint8Array,
		before: string | null,
	): Promise<boolean> {
		const key = pathKey(path);
		await this.store.putMarker(makeMarker(path, before, remote.hash, false));
		await this.env.beforeWrite();
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
	 */
	private async conflict(path: string, remote: RemoteEntry, content: Uint8Array): Promise<void> {
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

		// A merge of the two contents would be tried here (T039): when it
		// succeeds, the merged content is written through `writeRemote`'s
		// marker and re-check like the remote's, and no copy is made.

		let copy = await this.existingCopy(path, mine.hash);
		// Whether this pull wrote the copy. Only then is it ours to rewrite
		// or to take away again.
		const ours = copy === null;
		if (copy === null) {
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
		// The conflict is over, or given up: either way no resume is to
		// take the copy for the first half of one that is under way.
		await this.store.deleteMarker(pathKey(copy));
		if (!written) return;
		this.tally.conflicts.push({ path, copyPath: copy, cause: "conflict" });
	}

	/** Has the editors save, then reads the file. `null` when there is none. */
	private async readSaved(
		path: string,
		key: string,
	): Promise<(Seen & { readonly content: Uint8Array }) | null | PutOff> {
		if (!(await this.save(path))) {
			this.defer(path, "save-failed");
			return PUT_OFF;
		}
		try {
			const stat = await this.vault.stat(path);
			if (stat === null || stat.type !== "file") return null;
			const content = await this.vault.read(path);
			const seen = this.remember(key, await this.env.backend.hashContent(content), stat);
			return { ...seen, content };
		} catch {
			this.defer(path, "unreadable");
			return PUT_OFF;
		}
	}

	/**
	 * A copy of `path` that already holds this content, in the vault or on
	 * the remote. A pull that stopped after writing the copy finds it here
	 * when it is carried out again, and so does a device whose copy another
	 * device already sent.
	 */
	private async existingCopy(path: string, hash: string): Promise<string | null> {
		for (const candidate of this.localCopies.copiesOf(path)) {
			try {
				const there = await this.probe(candidate, pathKey(candidate));
				if (there !== null && there !== "folder" && there.hash === hash) return candidate;
			} catch {
				// A copy that cannot be read is not one to rely on.
			}
		}
		if (this.remoteCopies === undefined || this.remoteHashes === undefined) {
			const files = this.env.listing.entries.filter((entry) => entry.kind === "file");
			this.remoteCopies = new CopyIndex(files.map((entry) => entry.path));
			this.remoteHashes = new Map(files.map((entry) => [entry.path, entry.hash]));
		}
		for (const candidate of this.remoteCopies.copiesOf(path)) {
			if (this.remoteHashes.get(candidate) === hash) return candidate;
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
		mine: Seen & { readonly content: Uint8Array },
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
		await this.store.putMarker(makeMarker(copy, before, mine.hash, true));
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
		this.localCopies.add(copy);
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
