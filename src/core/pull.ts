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

// A pull, from the listing of the remote to the base revision: what is
// looked at, in which order, when the user is asked, and what is remembered.
// The decision is `pull-plan.ts`; carrying it out is `pull-apply.ts`. A first
// fetch is this same pull, run when there is no base revision.
//
// The order, and why:
//
// 1. The listing. The one that is stored is used while the remote has not
//    moved past it.
// 2. Whether the history still builds on the base revision. Asked before
//    anything is touched, since it decides how carefully files are written
//    over; a failure to find out ends the pull.
//    Then what a pull that stopped left half done (`settleMarkers`), so
//    that everything after sees the vault as a pull may take it. A pull
//    that starts over does this later: once the user said yes, and before
//    the sync state is discarded.
// 3. The text the root `.gitignore` will have once the pull is done, worked
//    out without writing it. The rules decide what the scan looks at, so
//    they have to be the ones the remote has now; the file itself is
//    written by the plan, like any other.
// 4. The scan, the hashing of what it found, and the plan.
// 5. Asking the user, when the plan takes away too much, or when this is a
//    first fetch into a vault whose files differ from the remote's
//    (`first-fetch.ts`).
//    One question, also when both are reasons to ask.
// 6. The plan, step by step.
// 7. The conflict copies that have had their time (`conflict-tidy.ts`), in
//    a pull that got this far and is no first fetch.
// 8. The base revision, when nothing was put off.

import {
	type ArchiveDownload,
	archiveContentSource,
	isArchiveDisabled,
	readArchiveCeiling,
	untilAborted,
} from "./archive-fetch";
import { BackendError, type RemoteEntry, type RemoteListing } from "./backend";
import { tidyConflictCopies } from "./conflict-tidy";
import { createExclusion, type Exclusion } from "./exclusion";
import { GITIGNORE_WRITE_KEY, settleGitignoreWrite } from "./gitignore-file";
import { firstFetchFiles, hasFirstFetchQuestion, isFirstFetchConfirmed, markFirstFetchConfirmed } from "./first-fetch";
import { lightCheckLine, type LightScanResult, scanLightly } from "./light-scan";
import { type LocalRead, readLocal, withLinksRead } from "./local-read";
import {
	type NoticeKind,
	type NoticeRef,
	notSentNotices,
	PUSH_NOTICE_KINDS,
	readNotices,
	reconcileNotices,
	ruleNotices,
	submoduleNotices,
	writeNotices,
} from "./notices";
import { foldedKey, pathKey } from "./paths";
import { DEFAULT_SIZE_LIMIT, type LocalEntry } from "./plan";
import { type ApplyEnv, type AwaitedConflict, applyPlan, type Seen, Tally } from "./pull-apply";
import { clearPushFailure } from "./push-failure";
import { type PushCounts, settlePendingPush } from "./push-pending";
import type {
	BulkWriteSession,
	ContentSource,
	DeferReason,
	DeferredFile,
	PullConflict,
	PullDeps,
	PullMerge,
	PullOutcome,
	PullPhase,
	PullResult,
	PullWaitReason,
	UnwritablePath,
	UnwritableReason,
} from "./pull-io";
import { readWhole } from "./pull-io";
import {
	confirmationOf,
	isConfirmed,
	keepLocal,
	needsConfirmation,
	type PullConfirmation,
	type PullPlan,
	type PullSkip,
	planPull,
	pullLosses,
} from "./pull-plan";
import { fromRoot, type RenamingFound, type ScanResult, scanVault } from "./scan";
import {
	BASE_REVISION_KEY,
	copiedPathOf,
	currentListing,
	makeRecord,
	mergeOf,
	readBaseRevision,
	type FileStat,
	type StateSeed,
	type StateStore,
	type StoredRecord,
	type WriteMarker,
	writeBaseRevision,
} from "./state";
import { countingLister, diskTimes, fullCheckLine, PhaseClock } from "./timing";
import { withListedStats } from "./listed-stats";
import { withoutRenamingMark } from "./vault-routes";

export type * from "./pull-io";

/** The key, among the other values of the sync state, of what the user last said yes to. */
export const PULL_CONFIRMATION_KEY = "pull-confirmation";

/** The key of the symlinks of the remote and where they point. */
export const SYMLINK_TARGETS_KEY = "symlink-targets";

/**
 * The key of what a resuming pull found and no pull has answered with yet
 * (`Unsaid`): the paths it moved to the `.trash/` of the vault
 * (`PullResult.halfWritten`, `halfMerged` and `halfCopies`), and the conflicts and the
 * merges it tells of a pull that made them and told nothing (`tellAwaited`,
 * `settleMerge`). Stored before
 * each is moved or stops waiting, so that the user is told also when the
 * pull that did it is killed. Kept when a pull rejects; it goes when a pull
 * has answered, or with a sync state that is discarded.
 */
export const HALF_WRITTEN_KEY = "half-written";

/** The value under `HALF_WRITTEN_KEY`. */
interface Unsaid {
	/** `PullResult.halfWritten`. */
	readonly files: readonly string[];
	/** `PullResult.halfCopies`. */
	readonly copies: readonly string[];
	/** Conflicts of the cause "conflict" that were made by a pull that told nothing. */
	readonly conflicts: readonly Pick<PullConflict, "path" | "copyPath">[];
	/** Merges that were written by a pull that told nothing. Left out when there is none. */
	readonly merged?: readonly PullMerge[];
	/** `PullResult.halfMerged`. Left out when there is none. */
	readonly halfMerged?: readonly PullMerge[];
}

/**
 * The key of the conflicts that are yet to be told (`AwaitedConflict` in
 * `pull-apply.ts`). Unlike what is under `HALF_WRITTEN_KEY`, a pull that has
 * answered does not end them: each stays until its file holds the content
 * of the remote.
 */
export const AWAITED_CONFLICTS_KEY = "awaited-conflicts";

/** What is at the path of a marker. */
interface MarkedContent {
	readonly hash: string;
	readonly stat: FileStat;
}

/** The vault as the plan is made from it, and the plan. */
interface Survey {
	readonly scan: ScanResult;
	readonly local: { readonly entries: LocalEntry[]; readonly seen: Map<string, Seen>; readonly lfsPointers: string[] };
	readonly plan: PullPlan;
	/** The rules the scan and the plan went by. */
	readonly exclusion: Exclusion;
}

const GITIGNORE = ".gitignore";

/**
 * How many names a rename was left at, one inside the other, a pull gives
 * back (`settleRenamings`), each with a scan of its own. Each of them is a
 * pull that stopped between its two calls, so more than a few is not
 * expected; past it, the next pull goes on.
 */
const RENAMING_DEPTH = 8;

/**
 * Pulls. Resolves with what happened, also when the pull did not get to the
 * end. Rejects when it could not be carried out at all or the sync state
 * failed: the listing, the check of the history, the scan; with a
 * "cancelled" failure when it was stopped while the listing or the check of
 * the history was on its way, since nothing is known of the remote then.
 * What it found half done and moved away by then stays remembered, for the
 * next pull to tell.
 * The vault is consistent with the records either way, and the base
 * revision has only moved when everything was done.
 */
export async function runPull(deps: PullDeps): Promise<PullResult> {
	const run = new PullRun(deps);
	try {
		const result = await run.pull();
		await run.forgetUnsaid();
		return result;
	} finally {
		await run.restoreViews();
	}
}

class PullRun {
	/** Replaced once, by the empty one, when the pull starts over (`PullDeps.discardState`). */
	private store: StateStore;
	private readonly startedAt: number;
	private readonly sizeLimit: number;
	private readonly tally = new Tally();
	private session: BulkWriteSession | undefined;
	private closedViews = false;
	/** Whether this is a first fetch: only then are views closed for the writing. */
	private firstFetch = false;
	/** Whether the vault was walked and every file looked at (`PullResult.walked`). */
	private walked = false;
	/** Set while the archive of the commit is downloaded. */
	private download: ArchiveDownload | null = null;
	/** The steps of the plan as last reported, for reporting them again when only `download` changed. */
	private applied = { done: 0, total: 0 };
	/**
	 * The paths the plan leaves alone (`PlanInput.held`), without the cases:
	 * those of the markers that could not be settled.
	 */
	private readonly held = new Set<string>();
	/**
	 * The files the survey found it cannot know the content of, and that
	 * the pull is not done without (`holdUnread`). They are put off once the
	 * plan is carried out.
	 */
	private readonly unread: DeferredFile[] = [];
	/** The markers that could not be settled, and are left for the next pull. */
	private readonly unsettled: WriteMarker[] = [];
	/** The conflicts of `awaited` that this pull tells. They are in the tally too. */
	private readonly resumedConflicts: PullConflict[] = [];
	/** The merges a pull that stopped had written, which this pull tells. They are in the tally too. */
	private readonly resumedMerges: PullMerge[] = [];
	/** The conflicts that are yet to be told, as they are stored (`AWAITED_CONFLICTS_KEY`). */
	private awaited: AwaitedConflict[] = [];
	/** What a push that this pull found to have gone through had changed (`settlePendingPush`). */
	private recoveredPush: PushCounts | null = null;
	/** How many files such a push took out of the remote, when it was one that untracked. */
	private recoveredUntrack: number | null = null;
	/** The names a rename was left at that could not be given back (`settleRenamings`). */
	private readonly renamingLeft: string[] = [];
	/** Whether the sync state was discarded, once the user said yes to starting over. */
	private discarded = false;

	/** How long the pull spent in each phase, for the log. */
	private readonly clock: PhaseClock;

	constructor(private readonly deps: PullDeps) {
		this.store = deps.store;
		this.startedAt = deps.now();
		this.clock = new PhaseClock(deps.now);
		this.sizeLimit = deps.sizeLimit ?? DEFAULT_SIZE_LIMIT;
	}

	async restoreViews(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (session === undefined) return;
		try {
			await session.restore();
		} catch {
			// A view that does not reopen is no reason to call the pull failed.
		}
	}

	private progress(phase: PullPhase, done = 0, total = 0): void {
		this.clock.enter(phase);
		this.deps.onProgress?.({
			phase,
			done,
			total,
			closedViews: this.closedViews,
			...(this.download === null ? {} : { archive: this.download }),
		});
	}

	private aborted(): boolean {
		return this.deps.signal?.aborted === true;
	}

	/**
	 * What was asked of the remote before anything is changed, or a
	 * "cancelled" failure as soon as the pull is stopped: a request that is
	 * on its way cannot be taken back, and can take a minute to time out.
	 * Only around the request itself. Nothing may follow it that changes the
	 * sync state after the pull has ended.
	 *
	 * A pull that was stopped before it asked gets what the remote answers:
	 * a remote that sends requests refuses that one itself.
	 */
	private asked<T>(request: Promise<T>): Promise<T> {
		return this.aborted() ? request : untilAborted(request, this.deps.signal);
	}

	// -----------------------------------------------------------------------
	// What a pull that stopped left half done

	/**
	 * Settles every write marker that is left. A marker is stored before a
	 * file is written and removed with the storing of its record, so one
	 * that is found is of a write that did not get that far: not begun,
	 * broken off, or done but for the record. Which, is read from the file.
	 *
	 * A path of the remote:
	 *
	 * - The content that was to be written: it was written. The record is
	 *   made with that hash, and not with the one the remote has now: the
	 *   remote may have changed the file since, which is then an ordinary
	 *   fetch for the plan to find.
	 * - The content from before the write, or no file: nothing was begun, or
	 *   the user deleted it. Only the marker goes. The record stays as it
	 *   is: a marker of the second half of a conflict has a "before" that is
	 *   not the record's, and the conflict is still one.
	 * - Anything else: half written, or edited since the pull stopped, and
	 *   the content cannot tell which. The file goes to the `.trash/` of the
	 *   vault and its record goes too, so that the plan fetches the remote's
	 *   content like a file that is new. No copy is made of it: half a file
	 *   would stay as a copy, and be sent.
	 *
	 * The marker of a merge (`makeMergeMarker`) differs in the first case
	 * alone. The content that was to be written is not the remote's, so the
	 * record is not made with its hash: it is the one the merge would have
	 * stored (`settleMerge`). In the other two cases nothing of the merge is
	 * left to go on with, and they are as above: a file that still holds
	 * what it held before is a conflict again for the plan, which merges it
	 * again. A file that is moved away is told with where the content from
	 * before the merge is (`PullResult.halfMerged`): the path gets the
	 * remote's content, and what the vault had is in neither.
	 *
	 * Whether the remote still has the path plays no part: with the record
	 * made, or gone with the file, the plan decides the same as for any
	 * other path the remote deleted or spells otherwise now.
	 *
	 * The copy of a conflict, which has no record and is no path of the
	 * remote: one that holds what was to be written stays, and so does its
	 * conflict, which is told once the file holds what the remote has
	 * (`tellAwaited`). The plan goes on to the file where there is something
	 * left to do: it is handed the conflict, and uses that copy for a file
	 * that still holds what the copy was written with (`awaitedCopy` in
	 * `pull-apply.ts`), or fetches a file that was moved away. Which file the
	 * copy is of is what its marker says (`copiedPathOf`); the name of the
	 * copy does not tell it. A copy that holds anything else is half a
	 * copy and goes to the `.trash/`; the file it is a copy of was not
	 * written yet, and its conflict is handled from the start. The copies
	 * come after the files, because a copy waits with a file that could not
	 * be settled (`settleCopy`).
	 *
	 * Every step can be made again: killed after any of them, the next pull
	 * finds the marker and a file that reads as one of the cases above.
	 *
	 * What the vault refuses for one marker does not stop the pull: an
	 * editor that cannot save, a file that cannot be read, a file that
	 * cannot be moved away. That marker is left for the next pull, the path
	 * is put off (`deferred`, so that the base revision stays), and the plan
	 * of this pull leaves the path alone (`held`): it may be half written,
	 * and must not be compared, written over, sent, or kept as a copy. A
	 * failure of the sync state is thrown, and ends the pull.
	 *
	 * Answers how many markers and conflicts it looked at, or "stopped" when
	 * the signal stopped it.
	 */
	private async settleMarkers(listing: RemoteListing): Promise<number | "stopped"> {
		const { store, tally } = this;
		// What a pull found and was killed before it could tell.
		const unsaid = storedUnsaid(await store.getMeta(HALF_WRITTEN_KEY));
		tally.halfWritten.push(...unsaid.files);
		tally.halfCopies.push(...unsaid.copies);
		tally.halfMerged.push(...(unsaid.halfMerged ?? []));
		for (const conflict of unsaid.conflicts) this.tellResumed({ ...conflict, cause: "conflict" });
		this.resumedMerges.push(...(unsaid.merged ?? []));
		tally.merged.push(...(unsaid.merged ?? []));
		this.awaited = storedAwaited(await store.getMeta(AWAITED_CONFLICTS_KEY));

		const markers = await store.readMarkers();
		const ordered = [
			...markers.filter((marker) => !marker.conflictCopy),
			...markers.filter((marker) => marker.conflictCopy),
		];
		for (const marker of ordered) {
			if (this.aborted()) return "stopped";
			const { key, path } = marker;
			// Typed in right now, in a pull that started by itself: left as
			// it is, marker and all, like every file such a pull would touch.
			if (this.deps.beingEdited?.(path) === true) {
				this.hold(marker, "being-edited");
				continue;
			}
			const there = await this.contentAt(path);
			if (there === "save-failed" || there === "unreadable") {
				this.hold(marker, there);
			} else if (marker.conflictCopy) {
				await this.settleCopy(marker, there);
			} else if (there !== null && there.hash === marker.writing) {
				const merge = mergeOf(marker);
				if (merge !== null) {
					await this.settleMerge(marker, merge, there);
					continue;
				}
				// Removes the marker in the same transaction.
				const written = { path, kind: "file", hash: marker.writing } as const;
				await store.commitWrite(makeRecord(written, there.stat, this.startedAt));
			} else if (there === null || there.hash === marker.before) {
				await store.deleteMarker(key);
			} else {
				// The record first, and the marker last. Killed after the
				// record went, the file is found like this again. Killed
				// after the file went, there is no file and no record, which
				// is a fetch; with the record left, a remote that has its
				// content again would read as "deleted on this device".
				await store.deleteRecord(key);
				// Of a merge: where the content from before it is, remembered
				// with the path, before the file is moved.
				const merge = mergeOf(marker);
				const before =
					merge === null || tally.halfMerged.some((told) => told.path === path)
						? null
						: { path, keptAt: merge.kept };
				if (before !== null) tally.halfMerged.push(before);
				if (!(await this.trashHalf(path, tally.halfWritten, before !== null))) {
					if (before !== null) {
						tally.halfMerged.splice(tally.halfMerged.indexOf(before), 1);
						await this.rememberUnsaid();
					}
					this.hold(marker, "trash-failed");
					continue;
				}
				await store.deleteMarker(key);
			}
		}
		// With the files as the markers left them: a conflict that was
		// finished but for telling it is told by this pull whatever becomes
		// of its plan.
		const waiting = this.awaited.length;
		await this.tellAwaited(listing);
		return markers.length + waiting;
	}

	/**
	 * Settles a write of Sync Evo's own to the root `.gitignore` that did
	 * not get to its end (`settleGitignoreWrite`). Where it cannot be
	 * settled the file may be half written: it is left alone and put off,
	 * like a path whose marker could not be settled, so that the pull ends
	 * "incomplete" and the push after it sends nothing.
	 */
	private async settleGitignore(): Promise<void> {
		if (await settleGitignoreWrite({ store: this.store, vault: this.deps.vault })) return;
		if (this.held.has(GITIGNORE)) return;
		this.held.add(GITIGNORE);
		this.tally.deferred.push({ path: GITIGNORE, reason: "unreadable" });
	}

	/**
	 * Gives the names a rename in two calls was left at
	 * (`RoutedVault.rename`) back their names: the mark is taken off, in one
	 * call, which is no change of case alone and goes through. What the
	 * rename was for is then as if it had been done in one call and the pull
	 * stopped after it, which the plan goes on with (`applyFolderRename`,
	 * `renameSeen` in `pull-apply.ts`). Answers whether any was given back.
	 *
	 * Only a name Sync Evo put there (`renamingsToGiveBack`). A name of the
	 * user's that happens to end in the mark is left as it is, and not told:
	 * it is not synced either way, like a `.git`.
	 *
	 * One whose name is taken by something else, or that the vault does not
	 * let go, stays, is told ("renaming-left"), and is tried again by the
	 * next pull. Until then, what the remote and the records have at its
	 * name and below waits (`holdRenamingLeft`). So does one that is not
	 * tried (`giveBack` false), or that this survey tried already: found
	 * again by the scan after another was given back, it is not tried twice.
	 * The list of the ones left is emptied by the caller, once a survey.
	 */
	private async settleRenamings(
		found: readonly RenamingFound[],
		remote: readonly { readonly path: string }[],
		records: readonly { readonly path: string }[],
		giveBack: boolean,
	): Promise<boolean> {
		const { deps } = this;
		let given = false;
		for (const path of renamingsToGiveBack(found, remote, records)) {
			const name = withoutRenamingMark(path);
			const left = (why: string): void => {
				this.renamingLeft.push(path);
				this.holdRenamingLeft(name, remote, records);
				deps.log?.(`pull: left ${path}, not given back its name ${name}: ${why}`);
			};
			if (this.renamingLeft.some((other) => foldedKey(other) === foldedKey(path))) continue;
			if (!giveBack) {
				left("too deep");
				continue;
			}
			try {
				await deps.vault.rename(path, name);
				given = true;
				deps.log?.(`pull: gave ${path} back its name ${name}`);
			} catch (error) {
				left(error instanceof Error ? error.message : String(error));
			}
		}
		return given;
	}

	/**
	 * Keeps out of the plan (`PlanInput.held`) what the remote and the
	 * records have at `name` and below, a name a rename was left short of,
	 * and puts it off: the record stays, and nothing is fetched or deleted.
	 * Planned as usual, the records would read as deleted in the vault, the
	 * remote's files would be fetched to `name`, and the name could never be
	 * given back. The pull is not done while it is so, and the push after it
	 * leaves the paths alone (`pathsToHold` in `sync.ts`). Once the name is
	 * given back, the plan goes on with the rename.
	 */
	private holdRenamingLeft(
		name: string,
		remote: readonly { readonly path: string }[],
		records: readonly { readonly path: string }[],
	): void {
		const folded = foldedKey(name);
		for (const { path } of [...remote, ...records]) {
			const key = foldedKey(path);
			if (key !== folded && !key.startsWith(`${folded}/`)) continue;
			if (this.held.has(key)) continue;
			this.held.add(key);
			this.unread.push({ path, reason: "depends-on-deferred" });
		}
	}

	/**
	 * The marker of a merge whose content was written (`settleMarkers`):
	 * the record the merge would have stored, with the hash the remote had
	 * for the path and without the time and the size of the file
	 * (`writeMerged` in `pull-apply.ts`). The file then reads as changed on
	 * this device, and is sent. A remote that has changed the file again
	 * since is a conflict for the plan to find, between the merged content
	 * and the newer one.
	 *
	 * The merge is told by this pull: the one that wrote it told nothing.
	 * Remembered before the marker goes, like what is moved away.
	 */
	private async settleMerge(
		marker: WriteMarker,
		merge: { readonly onto: string; readonly kept: string },
		there: MarkedContent,
	): Promise<void> {
		const { path } = marker;
		if (!this.tally.merged.some((told) => told.path === path)) {
			const told: PullMerge = { path, keptAt: merge.kept };
			this.resumedMerges.push(told);
			this.tally.merged.push(told);
			await this.rememberUnsaid();
		}
		// A merge that came out as the remote's content is a file in sync.
		const stat = merge.onto === marker.writing ? there.stat : undefined;
		// Removes the marker in the same transaction.
		await this.store.commitWrite(makeRecord({ path, kind: "file", hash: merge.onto }, stat, this.startedAt));
	}

	/** The marker of the copy of a conflict (`settleMarkers`). */
	private async settleCopy(marker: WriteMarker, there: MarkedContent | null): Promise<void> {
		const { key, path } = marker;
		if (there !== null && there.hash !== marker.writing) {
			if (!(await this.trashHalf(path, this.tally.halfCopies))) {
				this.hold(marker, "trash-failed");
				return;
			}
		} else if (there !== null) {
			// A marker that does not say what the copy is of leaves a copy
			// that is a file like any other: nothing waits, and the conflict
			// is handled from the start.
			const original = copiedPathOf(marker);
			if (original !== null) {
				// The file could not be settled. The copy waits with it, marker
				// and all: without the marker it would be a file like any
				// other to the plan, which moves it with its folder or lists
				// it as one that is only here, and its conflict would be
				// forgotten with a sync state that is discarded. The file is
				// put off already, which says all there is to say.
				const originalKey = pathKey(original);
				if (this.unsettled.some((left) => !left.conflictCopy && left.key === originalKey)) {
					this.leave(marker);
					return;
				}
				// Remembered before the marker goes, like what is moved away.
				const told = (other: AwaitedConflict): boolean => other.path === original && other.copyPath === path;
				if (!this.awaited.some(told)) {
					this.awaited.push({ path: original, copyPath: path, hash: marker.writing });
					await this.rememberAwaited();
				}
			}
		}
		await this.store.deleteMarker(key);
	}

	/**
	 * Tells every conflict that waits (`AwaitedConflict`) and whose file
	 * holds what the remote has now, and forgets the ones that are over.
	 * Called once the markers are settled, and again once the plan was
	 * carried out, which may have written the file.
	 *
	 * Over, with nothing to tell: the remote has no file at the path, or has
	 * what the copy holds; or the copy is gone, or no longer holds what it
	 * was written with. One the plan has told itself
	 * (`conflict` in `pull-apply.ts`, which found the copy) is over too.
	 *
	 * Left waiting: everything else. The file is not there, holds another
	 * content, or cannot be looked at. "Now has the content of the remote",
	 * which is how a conflict is worded, would not be true of it.
	 */
	private async tellAwaited(listing: RemoteListing): Promise<void> {
		if (this.awaited.length === 0) return;
		const remote = new Map<string, string>();
		for (const entry of listing.entries) {
			if (entry.kind === "file") remote.set(pathKey(entry.path), entry.hash);
		}
		const left: AwaitedConflict[] = [];
		let told = false;
		for (const conflict of this.awaited) {
			const { path, copyPath } = conflict;
			const state = await this.stateOfAwaited(conflict, remote.get(pathKey(path)));
			if (state === "waiting") left.push(conflict);
			else if (state === "finished" && this.tellResumed({ path, copyPath, cause: "conflict" })) told = true;
		}
		if (left.length === this.awaited.length) return;
		// What is told first, and then what waits: killed in between, the
		// conflict is in both lists, and told once (`tellResumed`).
		if (told) await this.rememberUnsaid();
		this.awaited = left;
		await this.rememberAwaited();
	}

	private async stateOfAwaited(
		conflict: AwaitedConflict,
		remoteHash: string | undefined,
	): Promise<"finished" | "waiting" | "over"> {
		const { path, copyPath } = conflict;
		const tells = (other: PullConflict): boolean => other.path === path && other.copyPath === copyPath;
		if (this.tally.conflicts.some(tells)) return "finished";
		// May be half written: not looked at.
		if (this.held.has(foldedKey(path)) || this.held.has(foldedKey(copyPath))) return "waiting";
		if (remoteHash === undefined || remoteHash === conflict.hash) return "over";
		// The copy has to be the one that was written: the name of a copy
		// that is gone can be taken by the copy of another file, of the same
		// name and the same day. Read, and not only looked for.
		try {
			const { vault, backend } = this.deps;
			const copy = await vault.stat(copyPath);
			if (copy === null || copy.type !== "file" || copy.size > this.sizeLimit) return "over";
			if ((await backend.hashContent(await vault.read(copyPath))) !== conflict.hash) return "over";
		} catch {
			return "waiting";
		}
		const now = await this.contentAt(path);
		return now !== null && typeof now !== "string" && now.hash === remoteHash ? "finished" : "waiting";
	}

	/** Answers whether it is this call that tells it: not when the plan or the list of a pull that was killed has. */
	private tellResumed(conflict: PullConflict): boolean {
		const told = (other: PullConflict): boolean =>
			other.path === conflict.path && other.copyPath === conflict.copyPath;
		if (this.tally.conflicts.some(told)) return false;
		this.resumedConflicts.push(conflict);
		this.tally.conflicts.push(conflict);
		return true;
	}

	/**
	 * Leaves a marker for the next pull: what is at its path could not be
	 * looked at or moved away. For the copy of a conflict the file it is a
	 * copy of is held as well, so that its conflict is not handled beside a
	 * copy that may be half one.
	 */
	private hold(marker: WriteMarker, reason: DeferReason): void {
		this.tally.deferred.push({ path: marker.path, reason });
		this.leave(marker);
	}

	/** `hold`, without putting the path off: for a marker that waits for another one that is. */
	private leave(marker: WriteMarker): void {
		this.unsettled.push(marker);
		this.held.add(foldedKey(marker.path));
		const original = copiedPathOf(marker);
		if (original !== null) this.held.add(foldedKey(original));
	}

	/**
	 * The hash of the file at the path of a marker, or `null` when no file
	 * is there. An editor that has it open saves first: what was typed and
	 * not saved would be gone with a file that is moved away. Answers the
	 * reason instead when the vault could not tell.
	 */
	private async contentAt(path: string): Promise<MarkedContent | null | "save-failed" | "unreadable"> {
		const { vault, backend } = this.deps;
		try {
			if ((await vault.saveOpenEditors(path)) === "failed") return "save-failed";
		} catch {
			return "save-failed";
		}
		try {
			const stat = await vault.stat(path);
			if (stat === null || stat.type !== "file") return null;
			// Not read: a pull writes nothing of that size, so it is neither
			// content a marker knows.
			if (stat.size > this.sizeLimit) return { hash: "", stat };
			const whole = await readWhole(vault, path, stat);
			return { hash: await backend.hashContent(whole.content), stat: whole.stat };
		} catch {
			return "unreadable";
		}
	}

	/**
	 * To the `.trash/` of the vault, whatever the setting: the content may
	 * be the user's and nowhere else. Listed in `list`, which is remembered
	 * before the file is moved. Answers `false` when the vault refused; the
	 * path is not listed then. `more`: whether something else was added to
	 * what is remembered, and is stored with it.
	 */
	private async trashHalf(path: string, list: string[], more = false): Promise<boolean> {
		const added = !list.includes(path);
		if (added) list.push(path);
		if (added || more) await this.rememberUnsaid();
		try {
			await this.deps.vault.trash(path, "vault-trash");
			return true;
		} catch {
			if (added) {
				list.splice(list.indexOf(path), 1);
				await this.rememberUnsaid();
			}
			return false;
		}
	}

	private hasUnsaid(): boolean {
		const { halfWritten, halfMerged, halfCopies } = this.tally;
		const moved = halfWritten.length + halfMerged.length + halfCopies.length;
		return moved + this.resumedConflicts.length + this.resumedMerges.length > 0;
	}

	private unsaid(): Unsaid {
		return {
			files: [...this.tally.halfWritten],
			copies: [...this.tally.halfCopies],
			conflicts: this.resumedConflicts.map(({ path, copyPath }) => ({ path, copyPath })),
			...(this.resumedMerges.length === 0 ? {} : { merged: [...this.resumedMerges] }),
			...(this.tally.halfMerged.length === 0 ? {} : { halfMerged: [...this.tally.halfMerged] }),
		};
	}

	/** Stores what this pull has to tell of the markers, in the sync state it has now. */
	private async rememberUnsaid(): Promise<void> {
		if (this.hasUnsaid()) await this.store.setMeta(HALF_WRITTEN_KEY, this.unsaid());
		else await this.store.deleteMeta(HALF_WRITTEN_KEY);
	}

	private async rememberAwaited(): Promise<void> {
		if (this.awaited.length > 0) await this.store.setMeta(AWAITED_CONFLICTS_KEY, this.awaited);
		else await this.store.deleteMeta(AWAITED_CONFLICTS_KEY);
	}

	/** Called once the pull has answered: what it found of the markers is in its answer. */
	async forgetUnsaid(): Promise<void> {
		if (this.hasUnsaid()) await this.store.deleteMeta(HALF_WRITTEN_KEY);
	}

	async pull(): Promise<PullResult> {
		const { deps } = this;
		let store = this.store;
		// The "first fetch" command. Everything up to the question is decided
		// as if there were no sync state, and the one there is, which is only
		// discarded once the user said yes, is neither read nor changed
		// before that.
		const startOver = deps.discardState !== undefined;
		let base = startOver ? null : await readBaseRevision(store);
		this.firstFetch = base === null;

		this.progress("listing");
		const listing = startOver ? await this.freshListing() : await this.currentListing();
		const head = listing.revision;

		// A push that was stopped before it knew whether the branch had
		// moved: with its commit as the head, or below the head, it went
		// through, and is recorded before anything is decided from the
		// records. The files it sent would otherwise read as changed on
		// both sides. When the remote cannot say, the pull ends here by
		// rejecting, with the push still remembered. Not when the pull
		// starts over: the sync state is not touched then.
		if (!startOver) {
			const settled = await settlePendingPush(store, head, (from, to) =>
				this.asked(deps.backend.checkBase(from, to)),
			);
			if (settled !== null) {
				base = await readBaseRevision(store);
				if (settled.untrack) {
					// It sent none of the vault's changes: a push that did
					// not get to its end is as unsent as it was.
					this.recoveredUntrack = settled.counts.deleted;
				} else {
					this.recoveredPush = settled.counts;
					// The push that had not got to its end, as far as this
					// device knew, has. A push that finds this out is itself
					// under way, and takes the note away when it is through.
					await clearPushFailure(store);
				}
			}
		}

		// Whether the question before a first fetch is still to be asked. By
		// the base revision and not by the records: a remote that is empty,
		// or holds nothing but excluded paths, leaves no record.
		const unconfirmed = base === null && (startOver || !(await isFirstFetchConfirmed(store)));

		// A remote without content. With nothing pulled before, there is
		// nothing to do and nothing to compare, and nothing to ask: the
		// files of the vault are all "only on this device", and it is the
		// push that sends them which asks about them (`push.ts`). The
		// vault is only looked at when the pull starts over, whose question
		// is also about the sync state it discards. With a base revision, the
		// content that was there is gone: no history holds the base any
		// more, which is what a rewritten history is, and nothing can be
		// asked of the remote about a head it does not have.
		const nothingToPull = head === null && base === null;
		// A write of Sync Evo's own to the root `.gitignore` that did not get
		// to its end (`gitignore-file.ts`), before the file is read as rules,
		// and also where there is nothing to pull: the push that follows
		// goes by the file. Like the markers, not yet when the pull starts
		// over.
		if (!startOver) await this.settleGitignore();
		let rewritten = false;
		if (head === null) {
			if (base !== null) rewritten = true;
			else if (!startOver) return this.result("remote-empty", head, false, {});
		} else if (base !== null && head !== base) {
			rewritten = (await this.asked(deps.backend.checkBase(base, head))) === "rewritten";
		}
		const finish = (outcome: PullOutcome, extra: Partial<PullResult> = {}): PullResult =>
			this.result(outcome, head, rewritten, extra);
		if (this.aborted()) return finish("cancelled");

		// A pull that the user let go on after the history was rewritten
		// keeps protecting what it takes away until it is done, even if the
		// history reads as continuous by the time it resumes.
		const confirmed = startOver ? undefined : readConfirmation(await store.getMeta(PULL_CONFIRMATION_KEY));
		const protect = rewritten || confirmed?.rewritten === true;

		// Before any file is compared, so that the scan below sees the vault
		// as the plan may take it. Not yet when the pull starts over: neither
		// the sync state nor the vault is touched before the user said yes.
		// A file left half written is until then one of the files that
		// differ, which the question lists.
		if (!startOver && (await this.settleMarkers(listing)) === "stopped") return finish("cancelled");

		const records = startOver ? [] : await store.readRecords();
		// A pull that started by itself begins no first fetch, also where
		// there would be nothing to ask about it. Ended here, before the
		// vault is looked at: it comes by every few minutes for as long as
		// the user has not started one, and must cost nothing then. With
		// records, a first fetch was begun before, by a pull the user
		// started; that one is gone on with, unless the question further
		// down says otherwise.
		if (deps.automatic === true && unconfirmed && records.length === 0) {
			return finish("waiting", { waitingFor: "first-fetch" });
		}
		const first = await this.survey(listing, records, protect);
		if (first === null) return finish("cancelled");
		let { scan, local, plan, exclusion } = first;
		// `tried`: whether every write of the plan was attempted.
		const notices = (tried: boolean): Promise<NoticeRef[]> =>
			this.updateNotices(plan, scan, listing, local.lfsPointers, tried, exclusion);

		// The two reasons to ask. They rarely meet: a first fetch has no
		// history to be rewritten, and deletes nothing until it has records.
		// A first fetch that resumes can do both (its records are of files the
		// remote has deleted since, and the vault got files of its own), and
		// is then asked once, about both.
		const losses = pullLosses(plan, rewritten);
		// Not when there is nothing to pull: nothing is taken away then.
		const lossesDue =
			!nothingToPull && needsConfirmation(losses, plan.recordCount) && !isConfirmed(losses, confirmed);
		const files = unconfirmed ? firstFetchFiles(plan, deps.paths.configDir) : null;
		const firstDue = files !== null && (startOver || hasFirstFetchQuestion(files, this.deps.paths.configDir));
		const keptLocal: string[] = [];
		let declined = false;
		// Whether the question was closed because the pull was stopped. That
		// is no answer of the user's: the pull ends as a "no" does, with
		// nothing changed, and is told as the stop it is.
		let stopped = false;
		if (lossesDue || firstDue) {
			const request = {
				losses: lossesDue ? losses : null,
				recordCount: plan.recordCount,
				firstFetch: firstDue ? { files, discardsState: startOver } : null,
			};
			const answer = deps.automatic === true ? "later" : await deps.confirm(request);
			if (answer === "later") {
				// Asked of no one. Returned from here, before anything else:
				// nothing that is remembered is touched, so that the next
				// pull stands where this one stood, and asks.
				const waitingFor: PullWaitReason = !lossesDue ? "first-fetch" : losses.rewritten ? "rewritten" : "deletions";
				return finish("waiting", { waitingFor });
			}
			const keep = answer === "keep-local" && lossesDue && rewritten;
			if (answer !== "proceed" && !keep) {
				stopped = this.aborted();
				// What was confirmed before does not outlive a "no". A "no" to
				// a first fetch alone changes nothing at all. Nor does a stop,
				// which leaves what was confirmed before as it is.
				if (lossesDue && !stopped) await store.deleteMeta(PULL_CONFIRMATION_KEY);
				declined = true;
			} else {
				// Whether the markers of the old sync state were settled, which
				// may have changed the vault since it was planned from.
				let settled = false;
				if (deps.discardState !== undefined) {
					// With the sync state that is about to go, since it alone
					// knows what a pull that stopped was writing. Discarded
					// unread, its markers would leave half a file to be taken
					// for the user's: kept as a copy of a conflict, and sent.
					const looked = await this.settleMarkers(listing);
					if (looked === "stopped") return finish("cancelled");
					const before = this.held.size;
					const unfinished = (await store.getMeta(GITIGNORE_WRITE_KEY)) !== undefined;
					await this.settleGitignore();
					settled = looked > 0 || unfinished || this.held.size !== before;
					// Looked at right before, with nothing awaited in between:
					// a change of the connection stops this pull and waits
					// for it to end before it discards the state itself, and
					// must not find this pull waiting for the state in turn.
					if (this.aborted()) return finish("cancelled");
					// What the old state knew and the new one has to: the
					// listing this pull goes by, the markers that could not be
					// settled and the conflicts that wait, for the next pull,
					// and what this pull has yet to tell, should it be killed.
					// Handed over rather than stored afterwards: killed between
					// the two, a file left half written would have no marker,
					// and the next pull would take it for the user's.
					const meta: [string, unknown][] = [];
					if (this.hasUnsaid()) meta.push([HALF_WRITTEN_KEY, this.unsaid()]);
					if (this.awaited.length > 0) meta.push([AWAITED_CONFLICTS_KEY, this.awaited]);
					// A write of the `.gitignore` that could not be settled
					// is as much to be known of as a marker.
					const unfinishedWrite = await store.getMeta(GITIGNORE_WRITE_KEY);
					if (unfinishedWrite !== undefined) meta.push([GITIGNORE_WRITE_KEY, unfinishedWrite]);
					const seed: StateSeed = { listing, markers: this.unsettled, meta };
					store = await deps.discardState(seed);
					this.store = store;
					this.discarded = true;
					// The names a rename was left at are given back now, by
					// the survey below, and compared under their names. Left,
					// the files fetched to their names would keep them from
					// ever being given back.
					if (renamingsToGiveBack(scan.renaming, listing.entries, []).length > 0) settled = true;
				}
				// Before anything is changed, so that a first fetch that stops
				// halfway goes on without asking again. When there was nothing
				// to ask it is stored at the end instead, with the base
				// revision: until a first fetch is done, files that come to
				// the vault and differ are asked about by the next sync.
				if (firstDue) await markFirstFetchConfirmed(store);
				if (keep) {
					const all = [...losses.deletions, ...losses.overwrites];
					plan = keepLocal(plan, new Set(all.map((loss) => loss.key)));
					// A kept file the remote no longer holds has no record
					// now, and is sent like a new one. None of them is
					// excluded: a rule turns a path away before it could be
					// a deletion to ask about.
					keptLocal.push(...all.map((loss) => loss.path));
					// Nothing was confirmed by this answer, and a "yes" from
					// before was to another question. Left in place, it
					// would stand for this pull if it stops halfway.
					await store.deleteMeta(PULL_CONFIRMATION_KEY);
				} else if (lossesDue) {
					// Before anything is changed, so that a pull that stops
					// halfway goes on without asking again.
					await store.setMeta(PULL_CONFIRMATION_KEY, confirmationOf(losses));
				}
				if (settled) {
					// The vault is no longer the one the plan was made from: a
					// file was moved away, an editor saved, a path is held.
					// Planned again, and not asked again: the answer was to
					// starting over, and what changed is told by the result.
					// A pull that starts over has no records, so nothing was
					// taken out of the plan above that would have to be again.
					const again = await this.survey(listing, [], protect);
					if (again === null) return finish("cancelled");
					({ scan, local, plan, exclusion } = again);
				}
			}
		}
		// Nothing was planned but what a push sends, and the question is
		// answered: the same end as when it did not have to be asked.
		const said: PullOutcome = stopped ? "cancelled" : "declined";
		if (nothingToPull) return this.result(declined ? said : "remote-empty", head, false, {});

		// The plan is final. What it cannot write is listed from here on, by
		// every result of this pull: the "blocked-path" notice is made from
		// the plan whether or not it is carried out, and its text names the
		// files in the way, which are read from this list.
		for (const skip of plan.skipped) {
			if (skip.reason !== "blocked") continue;
			this.tally.unwritable.push({
				path: blockedPath(skip),
				reason: "blocked",
				inTheWay: skip.local.map((entry) => entry.path),
			});
		}
		// A pull that was to start over leaves the sync state as it is when
		// the user says no, down to what it remembers of notices.
		if (declined) return finish(said, startOver ? {} : { notices: await notices(false) });
		if (this.aborted()) return finish("cancelled", { notices: await notices(false) });

		// From here on the pull changes the vault, and what the survey could
		// not read is what it leaves for the next sync.
		this.tally.deferred.push(...this.unread);

		this.progress("applying", 0, 0);
		const completed = await applyPlan(
			this.applyEnv(listing, protect, local.seen, scan.paths.map((scanned) => scanned.path)),
			plan,
		);
		// A file the plan wrote may be the one a conflict waited for.
		await this.tellAwaited(listing);
		// The record changes are made whatever the signal says, so every
		// symlink has its record by now and is not told a second time.
		const newSymlinks = plan.symlinks.filter((link) => link.firstSeen).map((link) => link.remote.path);
		const tried = completed && this.tally.fetchError === undefined;
		const extra = { keptLocal, newSymlinks, notices: await notices(tried) };
		if (!completed) return finish("cancelled", extra);

		await this.updateSymlinkTargets(plan, listing);

		// Not in a first fetch, which would take away at once what it has
		// just fetched. Otherwise in every pull that got this far, also one
		// that left files for later.
		const done = { ...extra, tidiedCopies: base === null ? [] : await this.tidyCopies() };
		if (this.tally.deferred.length > 0 || this.tally.fetchError !== undefined) return finish("incomplete", done);

		// Everything is done: only now is the head what this device builds on.
		if (head === null) {
			await store.deleteMeta(BASE_REVISION_KEY);
		} else {
			// A first fetch that is done counts as answered, also when it had
			// nothing to ask. Otherwise a remote that is emptied later, which
			// takes the base revision away again, would make the next sync
			// read as a first fetch and ask about files that were synced.
			// Before the base revision: stopped between the two, the next
			// pull finds nothing left to do and nothing to ask.
			if (base === null) await markFirstFetchConfirmed(store);
			await writeBaseRevision(store, head);
		}
		await store.deleteMeta(PULL_CONFIRMATION_KEY);
		return finish("completed", done);
	}

	/**
	 * Moves the conflict copies that have had their time to the `.trash/` of
	 * the vault (`tidyConflictCopies`), and answers them. Left where they
	 * are: what this pull put off, and what it did not look at (`held`): such
	 * a path is in the middle of something. And what this pull wrote with
	 * the content of the remote: a device that was away for a month is not
	 * to take a copy away in the pull that fetched it, as a first fetch is
	 * not. The next sync does.
	 */
	private tidyCopies(): Promise<string[]> {
		const { deps } = this;
		const putOff = new Set(this.tally.deferred.map((file) => foldedKey(file.path)));
		const fetched = new Set([...this.tally.written].map(foldedKey));
		return tidyConflictCopies({
			store: this.store,
			vault: deps.vault,
			now: deps.now,
			leaveAlone: (path) => {
				const key = foldedKey(path);
				return putOff.has(key) || this.held.has(key) || fetched.has(key);
			},
			...(deps.index === undefined ? {} : { index: deps.index }),
			...(deps.beingEdited === undefined ? {} : { beingEdited: deps.beingEdited }),
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
			...(deps.log === undefined ? {} : { log: deps.log }),
		});
	}

	private result(
		outcome: PullOutcome,
		revision: string | null,
		rewritten: boolean,
		extra: Partial<PullResult>,
	): PullResult {
		this.deps.log?.(`pull: ${outcome} in ${this.clock.line()}`);
		const { tally } = this;
		// A path is new when its notice is shown by this pull.
		const shown = new Set<string>();
		const shownBlocked = new Set<string>();
		for (const notice of extra.notices ?? []) {
			if (notice.kind === "unwritable-path") shown.add(notice.path);
			if (notice.kind === "blocked-path") shownBlocked.add(notice.path);
		}
		const unwritable = tally.unwritable.map(
			(entry): UnwritablePath => ({
				...entry,
				isNew:
					entry.reason === "blocked"
						? shownBlocked.has(entry.path)
						: NOTICED_REASONS.has(entry.reason) &&
							tally.refused.some((item) => item.reportedAs === entry.path && shown.has(item.remotePath)),
			}),
		);
		return {
			outcome,
			revision,
			remoteEmpty: revision === null,
			rewritten,
			counts: {
				fetched: tally.fetched,
				deleted: tally.deleted,
				renamed: tally.renamed,
				conflicts: tally.conflicts.length,
			},
			conflicts: tally.conflicts,
			merged: tally.merged,
			replacedSettings: tally.replacedSettings,
			trashed: tally.trashed,
			halfWritten: tally.halfWritten,
			halfMerged: tally.halfMerged,
			halfCopies: tally.halfCopies,
			deferred: tally.deferred,
			unwritable,
			keptLocal: [],
			tidiedCopies: [],
			newSymlinks: [],
			notices: [],
			closedViews: this.closedViews,
			refetched: tally.refetched,
			...(tally.fetchError === undefined ? {} : { fetchError: tally.fetchError }),
			...(this.recoveredPush === null ? {} : { recoveredPush: this.recoveredPush }),
			...(this.recoveredUntrack === null ? {} : { recoveredUntrack: this.recoveredUntrack }),
			...(this.walked ? { walked: true } : {}),
			...extra,
		};
	}

	/**
	 * Steps 3 and 4: the rules, the scan, the hashing, and the plan. `null`
	 * when the signal stopped it.
	 */
	private async survey(
		listing: RemoteListing,
		records: readonly StoredRecord[],
		protect: boolean,
	): Promise<Survey | null> {
		const { deps } = this;
		let gitignore: string | null;
		try {
			gitignore = await this.gitignoreAfter(listing, records, protect);
		} catch (error) {
			// Stopped while the `.gitignore` of the remote was on its way.
			// Unlike a stop during the listing, this is a pull that ends:
			// the markers are settled, and the result tells what of.
			if (this.aborted() && error instanceof BackendError && error.kind === "cancelled") return null;
			throw error;
		}
		if (this.aborted()) return null;

		const exclusion = createExclusion({
			...deps.paths,
			gitignore,
			...(deps.device === undefined ? {} : { device: deps.device }),
		});

		this.progress("scanning");
		const began = deps.now();
		const scanned = { exclusion, remote: listing.entries, records };
		const statsLister = deps.listedStats === undefined ? null : withListedStats(deps.vault, deps.listedStats);
		const lister = countingLister(statsLister ?? deps.vault);
		const scanOnce = async (): Promise<{ light: LightScanResult | null; found: ScanResult }> => {
			const light =
				deps.index === undefined ? null : await scanLightly({ ...scanned, index: deps.index, vault: deps.vault });
			return { light, found: light ?? (await scanVault({ ...scanned, lister })) };
		};
		let { light, found } = await scanOnce();
		// Found by the scan, which lists every folder anyway, and not by a
		// look of its own before it: such a name is rare, and the vault is
		// scanned again only when one was given back. Not when the pull
		// starts over until the user said yes: the vault is not changed
		// before that.
		//
		// The scan does not go into a folder at such a name, so one inside
		// it (a rename of `a/b` and then of `a`, each stopped between) is
		// found by the scan after it was given back, and given back in turn.
		// Left, what the records have below it would read as deleted, and
		// what the remote has would be fetched to its name. Every scan goes
		// by `settleRenamings`, the last too: past `RENAMING_DEPTH`, what is
		// still to give back waits for the next pull, which goes on from it.
		// Found again by a second survey, and told once.
		this.renamingLeft.length = 0;
		if (deps.discardState === undefined || this.discarded) {
			for (let depth = 1; ; depth++) {
				const given = await this.settleRenamings(found.renaming, listing.entries, records, depth <= RENAMING_DEPTH);
				if (!given) break;
				({ light, found } = await scanOnce());
			}
		}
		const scanMs = deps.now() - began;
		const local = await readLocal(
			{
				vault: deps.vault,
				backend: deps.backend,
				store: this.store,
				now: deps.now,
				startedAt: this.startedAt,
				sizeLimit: this.sizeLimit,
				held: this.held,
				aborted: () => this.aborted(),
				onProgress: (done, total) => this.progress("hashing", done, total),
				...(deps.yieldControl === undefined ? {} : { yieldControl: deps.yieldControl }),
				...(light !== null
					? { indexed: light.indexed }
					: statsLister === null
						? {}
						: { indexed: statsLister.indexed() }),
				...(deps.log === undefined ? {} : { log: deps.log }),
			},
			found,
			records,
			listing,
		);
		if (local === null) return null;
		if (light === null) this.walked = true;
		const scan = withLinksRead(found, local);
		const checkMs = deps.now() - began;
		const checkLine =
			light === null
				? fullCheckLine(scan.paths.length, lister.listed(), scanMs, local, checkMs)
				: `${lightCheckLine(light, local, checkMs)} (${diskTimes(local)})`;
		deps.log?.(`pull: ${checkLine}`);
		this.holdUnread(local, listing, records);

		const plan = planPull({
			remote: listing.entries,
			local: local.entries,
			records,
			exclusion,
			sizeLimit: this.sizeLimit,
			...(this.held.size === 0 ? {} : { held: this.held }),
			links: scan.links,
		});
		return { scan, local, plan, exclusion };
	}

	/**
	 * Keeps the files whose content is not known out of the plan
	 * (`PlanInput.held`): nothing is written over them, they are not
	 * deleted, and no copy is made of them.
	 *
	 * A file that could not be read is put off, so that the pull ends
	 * "incomplete" and the base revision stays: something is wrong on this
	 * device, and the user is told. A file a cloud drive has taken off the
	 * device is put off only when the pull has something to do at its path
	 * (the remote changed or deleted it, or no record says it is the
	 * remote's): a vault can hold such files for good, and a pull that
	 * could never get to the end because of them would help no one.
	 *
	 * Put off in `unread` and not in the tally: a pull that ends before it
	 * changes anything (a "no" to its question, a stop) has not left these
	 * files for later, and must not say so.
	 *
	 * A path that is held is not read again by a second survey, and a
	 * placeholder that is held already is passed over here, so nothing is
	 * put off twice.
	 */
	private holdUnread(
		local: Pick<LocalRead, "unreadable" | "placeholders">,
		listing: RemoteListing,
		records: readonly StoredRecord[],
	): void {
		for (const path of local.unreadable) {
			this.held.add(foldedKey(path));
			this.unread.push({ path, reason: "unreadable" });
		}
		if (local.placeholders.length === 0) return;
		const remote = new Map(listing.entries.map((entry) => [pathKey(entry.path), entry.hash]));
		const recorded = new Map(records.map((record) => [record.key, record.hash]));
		for (const path of local.placeholders) {
			// Held by a marker, or by the survey before this one.
			if (this.held.has(foldedKey(path))) continue;
			this.held.add(foldedKey(path));
			const key = pathKey(path);
			if (remote.get(key) !== recorded.get(key)) this.unread.push({ path, reason: "not-downloaded" });
		}
	}

	/** The listing of the head: the stored one when the remote has not moved past it. */
	private currentListing(): Promise<RemoteListing> {
		return currentListing(this.store, (known) => this.asked(this.deps.backend.list(known)));
	}

	/** The listing of the head, asked of the remote without looking at the stored one. */
	private async freshListing(): Promise<RemoteListing> {
		const listed = await this.asked(this.deps.backend.list(null));
		if (!listed.changed) throw new Error("The remote answered that nothing changed since no listing.");
		return listed.listing;
	}

	private applyEnv(
		listing: RemoteListing,
		protect: boolean,
		seen: Map<string, Seen>,
		localPaths: readonly string[],
	): ApplyEnv {
		const { deps } = this;
		return {
			store: this.store,
			backend: deps.backend,
			vault: deps.vault,
			fetchContents: this.contentSource(listing),
			deviceName: deps.deviceName,
			now: deps.now,
			startedAt: this.startedAt,
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
			...(deps.log === undefined ? {} : { log: deps.log }),
			listing,
			protect,
			merge: deps.mergeConflicts === true,
			seen,
			localPaths,
			awaited: this.awaited,
			tally: this.tally,
			beforeWrite: () => this.beforeWrite(),
			...(deps.beingEdited === undefined ? {} : { beingEdited: deps.beingEdited }),
			onStep: (done, total) => {
				this.applied = { done, total };
				this.progress("applying", done, total);
			},
			configDir: deps.paths.configDir,
			communityPluginsKey: pathKey(`${trimSlashes(deps.paths.configDir)}/community-plugins.json`),
			pluginId: deps.pluginId,
		};
	}

	/**
	 * Where the contents come from: all at once when there are many, one
	 * file at a time otherwise (`archive-fetch.ts`). The mark an attempt at
	 * the archive leaves in the sync state is looked at in there, when the
	 * number of files to fetch is known, and not when the pull starts: a
	 * pull that fetches nothing has no use for it.
	 */
	private contentSource(listing: RemoteListing): ContentSource {
		const { deps } = this;
		return archiveContentSource({
			store: this.store,
			backend: deps.backend,
			listing,
			perFile: deps.fetchContents ?? ((revision, entries) => deps.backend.fetch(revision, entries)),
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
			...(deps.log === undefined ? {} : { log: deps.log }),
			...(deps.archiveGate === undefined ? {} : { gate: deps.archiveGate }),
			...(deps.archiveAllowed === undefined ? {} : { allowed: deps.archiveAllowed }),
			onDownload: (download) => {
				this.download = download;
				this.progress("applying", this.applied.done, this.applied.total);
			},
			onRefetch: (count) => {
				this.tally.refetched = count;
			},
		});
	}

	// Asked for at the first write rather than up front, so that a first
	// fetch that writes nothing closes nothing.
	private async beforeWrite(): Promise<void> {
		if (!this.firstFetch || this.session !== undefined || this.deps.beginBulkWrite === undefined) return;
		try {
			this.session = await this.deps.beginBulkWrite();
			this.closedViews = this.session.closedViews;
		} catch {
			// Writing with the views open is slow, not wrong.
			this.session = { closedViews: false, restore: async () => {} };
		}
	}

	// -----------------------------------------------------------------------
	// `.gitignore` first

	/**
	 * The text the root `.gitignore` will have once this pull is done, or
	 * `null` for none. Nothing is written here: the file goes through the
	 * plan like any other, so that a pull the user declines has changed
	 * nothing, and a `.gitignore` that was edited here becomes a conflict
	 * like any other file. But the rules have to be known before the scan,
	 * so the decision about this one path is made ahead, from its record,
	 * the vault's file and the remote's entry:
	 *
	 * - Where it puts the remote's content at the name (a fetch, or a
	 *   conflict, whose copy takes the vault's), the text is the remote's.
	 *   That one blob is fetched here, from the backend itself and not from
	 *   whatever the contents of the pull come from, which may be an archive
	 *   that is fetched once. A failure to fetch it fails the pull, before
	 *   anything of the plan is carried out. A stop is not kept waiting for
	 *   it (`asked`).
	 * - Everywhere else the text is the vault's: the two are the same, the
	 *   remote did not change it or has none, or the step takes something
	 *   away (a deletion, writing over the file after the history was
	 *   rewritten) and is the user's to confirm first.
	 *
	 * When the write is then put off, refused, or not confirmed, the file
	 * differs from the rules this pull went by. That is accepted: a rule
	 * only matters for a path the remote does not hold, a pull changes no
	 * such path because of a rule, and the next pull reads the rules again.
	 */
	private async gitignoreAfter(
		listing: RemoteListing,
		records: readonly StoredRecord[],
		protect: boolean,
	): Promise<string | null> {
		const { deps } = this;
		// May be half written, and is not read as content: the rules are the
		// ones it has as far as it can be read at all, and nothing is
		// planned for the path (`held`).
		if (this.held.has(GITIGNORE)) {
			try {
				return await this.rootGitignore();
			} catch {
				return null;
			}
		}
		const remote = listing.entries.filter((entry) => foldedKey(entry.path) === GITIGNORE);
		const [entry] = remote;
		// Anything but one plain file of exactly that name is not written
		// to that name by this pull.
		if (remote.length !== 1 || entry === undefined || entry.kind !== "file" || pathKey(entry.path) !== GITIGNORE) {
			return this.rootGitignore();
		}

		const local: LocalEntry[] = [];
		const listed = await deps.vault.list("/");
		for (const returned of listed.files) {
			const path = fromRoot(returned);
			if (foldedKey(path) !== GITIGNORE) continue;
			const stat = await deps.vault.stat(path);
			if (stat === null || stat.type !== "file") continue;
			if (stat.size > this.sizeLimit) {
				local.push({ path, hash: "", size: stat.size });
				continue;
			}
			const hash = await deps.backend.hashContent(await deps.vault.read(path));
			local.push({ path, hash, size: stat.size });
		}

		const plan = planPull({
			remote,
			local,
			records: records.filter((record) => foldedKey(record.path) === GITIGNORE),
			// No rule applies to the root `.gitignore`, and the three fixed
			// exclusions cannot match it.
			exclusion: createExclusion({ ...deps.paths, gitignore: null }),
			sizeLimit: this.sizeLimit,
		});
		const losses = pullLosses(plan, protect);
		const takesAway =
			plan.deletes.length + plan.asides.length + losses.deletions.length + losses.overwrites.length > 0;
		if (takesAway || !plan.writes.some((write) => write.key === GITIGNORE)) return this.rootGitignore();

		const contents = deps.backend.fetch(listing.revision, [entry])[Symbol.asyncIterator]();
		try {
			for (;;) {
				const next = await this.asked(contents.next());
				if (next.done === true) break;
				const file = next.value;
				if (file.entry.path !== entry.path) continue;
				if ((await deps.backend.hashContent(file.content)) !== entry.hash) break;
				return new TextDecoder().decode(file.content);
			}
		} finally {
			// Not awaited: it would wait for the request that is on its way.
			void Promise.resolve(contents.return?.()).catch(() => {});
		}
		throw new Error("The .gitignore of the remote could not be fetched as it is listed.");
	}

	/** The `.gitignore` at the vault root, as it is now. */
	private async rootGitignore(): Promise<string | null> {
		const { vault } = this.deps;
		const stat = await vault.stat(GITIGNORE);
		if (stat === null || stat.type !== "file" || stat.size > this.sizeLimit) return null;
		return new TextDecoder().decode((await readWhole(vault, GITIGNORE, stat)).content);
	}

	// -----------------------------------------------------------------------
	// What is told once

	/**
	 * Works out which notices apply now, remembers them, and answers the
	 * ones that apply for the first time.
	 */
	private async updateNotices(
		plan: PullPlan,
		scan: ScanResult,
		listing: RemoteListing,
		localLfsPointers: readonly string[],
		tried: boolean,
		exclusion: Exclusion,
	): Promise<NoticeRef[]> {
		const { deps, tally } = this;
		const remembered = await readNotices(this.store);
		const current: NoticeRef[] = [];
		const add = (kind: NoticeKind, path: string): void => {
			current.push({ kind, path });
		};

		// What only a push finds out is the next push's to forget.
		for (const notice of remembered) {
			if (PUSH_NOTICE_KINDS.includes(notice.kind)) current.push(notice);
		}
		// A light check forgets nothing. It does not see every path a scan
		// sees, so a notice it finds no reason for may apply all the same
		// (a `.gitignore` in a folder it did not list); forgotten here, the
		// next scan would tell it again, and so on after every light check.
		// What it does find is told. Forgetting is left to a pull that scans.
		if (deps.index !== undefined) current.push(...remembered);
		if (scan.rootHasGit) add("git-at-root", ".git");
		for (const path of this.renamingLeft) add("renaming-left", path);
		for (const path of scan.links) add("local-link", path);
		// By the rules this pull went by, which are the ones the root
		// `.gitignore` has once it is done (`gitignoreAfter`). A `.gitignore`
		// this pull fetches into a subfolder is in the listing already.
		current.push(
			...ruleNotices(
				exclusion,
				deps.paths,
				listing.entries,
				scan.paths.map((scanned) => scanned.path),
			),
		);
		current.push(...submoduleNotices(exclusion, listing.entries), ...notSentNotices(plan.skipped));
		// Read from the sync state and not handed over by the fetching: the
		// pull that made the device remember it can have been killed before
		// it told anything, and the next one tells it then.
		// Not on a device that may not use the archive: what it remembers is
		// of a version before it was kept from it, and changes nothing there.
		if (deps.archiveAllowed !== false) {
			if (await isArchiveDisabled(this.store)) add("archive-given-up", "");
			else {
				// The path is the ceiling: one that came down is told again.
				const ceiling = await readArchiveCeiling(this.store);
				if (ceiling !== null) add("archive-limited", String(ceiling));
			}
		}
		for (const collision of plan.collisions) {
			for (const spelling of collision.spellings) add("remote-path-collision", spelling);
		}
		let ownFolder = false;
		for (const skip of plan.skipped) {
			const path = skip.remote[0]?.path ?? skip.local[0]?.path ?? skip.records[0]?.path ?? skip.key;
			switch (skip.reason) {
				case "own-folder":
					// One notice for the folder, however many files it has.
					ownFolder = ownFolder || skip.remote.length > 0;
					break;
				case "duplicate-path":
					// Two spellings of one name in NFC and NFD.
					if (skip.remote.length > 1) {
						for (const entry of skip.remote) add("remote-path-collision", entry.path);
					}
					break;
				case "too-large":
					add("too-large", path);
					break;
				case "invalid-path":
					add("invalid-path", path);
					break;
				default:
					break;
			}
		}
		if (ownFolder) add("own-folder-on-remote", trimSlashes(deps.paths.pluginDir));

		// A pointer file is only recognized when its content passes through
		// here. One that was told before still is one while the remote holds
		// the path and this pull did not write other content there.
		for (const path of [...tally.lfsPointers, ...localLfsPointers]) add("lfs-pointer", path);
		const remoteFiles = new Set(
			listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
		);
		for (const notice of remembered) {
			if (notice.kind !== "lfs-pointer") continue;
			if (remoteFiles.has(notice.path) && !tally.written.has(pathKey(notice.path))) current.push(notice);
		}

		// A path the vault refused. Every pull tries it again, so one that
		// is not refused by a pull that tried it was written, or is gone from
		// the remote. A pull that did not get to it says nothing about it.
		//
		// A vault file that could not be taken away or moved is the other
		// thing told under this kind. Its path is not on the remote: it is
		// kept while the file is in the vault and no pull has tried it
		// since. A pull that put the file off (an editor that could not
		// save) has not tried it either.
		for (const { remotePath } of tally.refused) add("unwritable-path", remotePath);
		const putOff = new Set(tally.deferred.map((file) => pathKey(file.path)));
		const inVault = new Set(scan.paths.map((scanned) => scanned.key));
		for (const notice of remembered) {
			if (notice.kind !== "unwritable-path") continue;
			const key = pathKey(notice.path);
			if (!remoteFiles.has(notice.path)) {
				if ((!tried || putOff.has(key)) && inVault.has(key)) current.push(notice);
				continue;
			}
			if (tally.written.has(key)) continue;
			if (!tried || putOff.has(key)) current.push(notice);
		}

		// A remote file with vault files in its place. Decided by the plan
		// alone, so it applies for exactly as long as the plan says so.
		for (const skip of plan.skipped) {
			if (skip.reason === "blocked") add("blocked-path", blockedPath(skip));
		}

		const update = reconcileNotices(remembered, current);
		await writeNotices(this.store, update.remember);
		const show = [...update.show];
		// Not through the memory: it is about the file as it was just
		// written, and is told every time such a file is written.
		if (tally.pluginNotListed) {
			show.push({ kind: "plugin-not-listed", path: `${trimSlashes(deps.paths.configDir)}/community-plugins.json` });
		}
		// Nor this: it is about the rename, until the app starts again.
		for (const path of deps.vault.caseRenamedFolders?.() ?? []) show.push({ kind: "case-renamed-folder", path });
		return show;
	}

	/**
	 * Keeps where each symlink of the remote points, for the list in the
	 * settings. A symlink is never written, but its blob is a few bytes that
	 * say where it points; it is fetched when the symlink is new or changed.
	 * Nothing here can fail the pull: a target that could not be fetched is
	 * missing from the list until the next pull.
	 */
	private async updateSymlinkTargets(plan: PullPlan, listing: RemoteListing): Promise<void> {
		const { backend } = this.deps;
		try {
			const stored = storedTargets(await this.store.getMeta(SYMLINK_TARGETS_KEY));
			const kept: StoredTarget[] = [];
			const missing: RemoteEntry[] = [];
			for (const { remote } of plan.symlinks) {
				const have = stored.find((item) => item.path === remote.path && item.hash === remote.hash);
				if (have === undefined) missing.push(remote);
				else kept.push(have);
			}
			if (missing.length === 0 && kept.length === stored.length) return;
			try {
				if (missing.length > 0) {
					for await (const { entry, content } of backend.fetch(listing.revision, missing)) {
						if (this.aborted()) break;
						if ((await backend.hashContent(content)) !== entry.hash) continue;
						kept.push({ path: entry.path, hash: entry.hash, target: new TextDecoder().decode(content) });
					}
				}
			} catch {
				// What was fetched so far is kept.
			}
			await this.store.setMeta(SYMLINK_TARGETS_KEY, kept);
		} catch {
			// The list is a convenience.
		}
	}
}

interface StoredTarget {
	readonly path: string;
	/** The hash of the symlink's blob, to see when it points elsewhere. */
	readonly hash: string;
	readonly target: string;
}

function storedTargets(value: unknown): StoredTarget[] {
	if (!Array.isArray(value)) return [];
	const targets: StoredTarget[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const { path, hash, target } = item as Record<string, unknown>;
		if (typeof path === "string" && typeof hash === "string" && typeof target === "string") {
			targets.push({ path, hash, target });
		}
	}
	return targets;
}

export interface SymlinkTarget {
	/** The path of the symlink on the remote. */
	readonly path: string;
	/** Where it points, as the remote has it: usually a path relative to the symlink. */
	readonly target: string;
}

/** The symlinks of the remote that are skipped, with where they point, as of the last pull. */
export async function readSymlinkTargets(store: Pick<StateStore, "getMeta">): Promise<SymlinkTarget[]> {
	return storedTargets(await store.getMeta(SYMLINK_TARGETS_KEY))
		.map(({ path, target }) => ({ path, target }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function storedAwaited(value: unknown): AwaitedConflict[] {
	const awaited: AwaitedConflict[] = [];
	for (const item of Array.isArray(value) ? (value as unknown[]) : []) {
		if (typeof item !== "object" || item === null) continue;
		const { path, copyPath, hash } = item as Record<string, unknown>;
		if (typeof path === "string" && typeof copyPath === "string" && typeof hash === "string") {
			awaited.push({ path, copyPath, hash });
		}
	}
	return awaited;
}

function storedUnsaid(value: unknown): Unsaid {
	const { files, copies, conflicts, merged, halfMerged } = (
		typeof value === "object" && value !== null ? value : {}
	) as Record<string, unknown>;
	const paths = (list: unknown): string[] =>
		Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
	const pairs: Pick<PullConflict, "path" | "copyPath">[] = [];
	for (const item of Array.isArray(conflicts) ? (conflicts as unknown[]) : []) {
		if (typeof item !== "object" || item === null) continue;
		const { path, copyPath } = item as Record<string, unknown>;
		if (typeof path === "string" && typeof copyPath === "string") pairs.push({ path, copyPath });
	}
	const merges = (list: unknown): PullMerge[] => {
		const read: PullMerge[] = [];
		for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
			if (typeof item !== "object" || item === null) continue;
			const { path, keptAt } = item as Record<string, unknown>;
			if (typeof path === "string" && typeof keptAt === "string") read.push({ path, keptAt });
		}
		return read;
	};
	return {
		files: paths(files),
		copies: paths(copies),
		conflicts: pairs,
		merged: merges(merged),
		halfMerged: merges(halfMerged),
	};
}

function readConfirmation(value: unknown): PullConfirmation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { rewritten, deletions, overwrites } = value as Record<string, unknown>;
	const isKeys = (list: unknown): list is string[] =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	if (typeof rewritten !== "boolean" || !isKeys(deletions) || !isKeys(overwrites)) return undefined;
	return { rewritten, deletions, overwrites };
}

/**
 * The reasons of an unwritable path that have an "unwritable-path" notice:
 * the write or the rename of the remote path itself, the removal of a vault
 * file, and the move of a vault file out of the way. Every place that gives
 * one of these reasons does so through `refuse` (`pull-apply.ts`), which is
 * what makes the notice.
 */
const NOTICED_REASONS: ReadonlySet<UnwritableReason> = new Set([
	"write-failed",
	"rename-failed",
	"trash-failed",
	"copy-unwritable",
	"folder-in-the-way",
]);

/** The path a blocked remote file is reported and remembered under: the remote's spelling. */
function blockedPath(skip: PullSkip): string {
	return skip.remote[0]?.path ?? skip.key;
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Of the names a rename was left at that the scan found (`ScanResult.renaming`),
 * the ones Sync Evo put there: whose name without the mark the remote or a
 * record has as what it is. A file is given back where they have a file at
 * the name, and a folder where they have paths below the name: a file of
 * the user's at the name of a folder (`Notes.sync-evo-renaming` beside
 * `Notes/a.md`) is no rename of Sync Evo's. Compared without the cases:
 * the rename was to the remote's spelling, and the record has the one from
 * before. A rename of Sync Evo's is only ever made to a path the remote
 * has, and a record stays until its rename is done (`holdRenamingLeft`).
 * What is left out: a file that had no record (a spelling of the vault's
 * own, given the remote's) and that the remote deleted since. It stays
 * under the name between, not synced, and nothing of it is lost. Nothing
 * is written down of a rename between its two calls, so a name the user
 * made by putting the mark at a name the remote has cannot be told from
 * one of Sync Evo's, and is given back.
 */
function renamingsToGiveBack(
	found: readonly RenamingFound[],
	remote: readonly { readonly path: string }[],
	records: readonly { readonly path: string }[],
): string[] {
	if (found.length === 0) return [];
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const { path } of [...remote, ...records]) {
		const key = foldedKey(path);
		files.add(key);
		const parts = key.split("/");
		for (let end = 1; end < parts.length; end++) folders.add(parts.slice(0, end).join("/"));
	}
	return found
		.filter(({ path, type }) => (type === "file" ? files : folders).has(foldedKey(withoutRenamingMark(path))))
		.map(({ path }) => path);
}
