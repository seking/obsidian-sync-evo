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

// A push, from the listing of the remote to the records: what is looked at,
// in which order, when the user is asked, and what is remembered. The
// decision is `push-plan.ts`; sending is the backend's.
//
// The order, and why:
//
// 1. The listing of the head, and with it the parent of the commit: the
//    push is planned from the remote as it is now, and built on that. Not on
//    the base revision, which stays behind for as long as a pull has files
//    left to do; a push would then be refused until every one was done.
//    What such a pull has yet to write is not touched: the plan sends only
//    what the remote has not changed since the record.
// 2. A push that was left not knowing whether it went through
//    (`push-pending.ts`).
// 3. The paths that are not looked at: what a pull that stopped left half
//    written, and what the pull before this push put off. A push settles
//    neither; it leaves them alone, and sends the rest.
// 3a. The section Sync Evo keeps in the root `.gitignore`, added when the
//    file has none (`addSection`). Here and not in a step between the pull
//    and the push: only from here on is it known that this push gets as far
//    as sending, and a section that is written and not sent is a change on
//    this device alone, which the remote's next change to the file turns
//    into a conflict. Before the scan, so that the file is planned, shown in
//    the question and sent like any other the user edited; a remote without
//    commits gets it as its first (`start`).
// 4. The scan, with every open editor saved, the hashing, and the plan.
// 5. Asking the user: before the first push of a sync state, and when the
//    plan deletes too much. One question, also when both are a reason.
// 6. For a remote without commits, its first: the `.gitignore` alone
//    (`start`). The rest is sent on top of it.
// 7. Sending. Each file is read when it is sent, and recorded as it was
//    read. The commit is remembered before the branch is moved.
// 8. The records, the listing as the remote gives it for the new commit,
//    and the base revision (`finishPush`).

import { untilAborted } from "./archive-fetch";
import { type Backend, BackendError, type PushFile, type RemoteEntry, type RemoteListing } from "./backend";
import { originalPathOfConflictCopy } from "./conflict-name";
import { createExclusion, type Exclusion, type ExclusionPaths, untrackableByAddedLines } from "./exclusion";
import { isFirstFetchConfirmed, markFirstFetchConfirmed } from "./first-fetch";
import { addDefaultSection, isGitignoreAsRecorded, settleGitignoreWrite } from "./gitignore-file";
import { lightCheckLine, scanLightly, type VaultIndex } from "./light-scan";
import { readLocal, saved } from "./local-read";
import {
	type NoticeRef,
	PUSH_NOTICE_KINDS,
	readNotices,
	reconcileNotices,
	ruleNotices,
	SHARED_NOTICE_KINDS,
	writeNotices,
} from "./notices";
import { foldedKey, pathKey } from "./paths";
import { DEFAULT_SIZE_LIMIT } from "./plan";
import type { PullVault } from "./pull-io";
import {
	FIRST_PUSH_CONFIRMED_KEY,
	finishPush,
	forgetPendingPush,
	type PendingPushState,
	type PushCounts,
	rememberPendingPush,
	settlePendingPush,
} from "./push-pending";
import { clearPushFailure, markPushFailure, readPushFailure, restorePushFailure } from "./push-failure";
import { type HeldRename, needsPushConfirmation, type PushPlan, type PushRefusal, planPush } from "./push-plan";
import { type ScanResult, scanVault } from "./scan";
import {
	currentListing,
	type FileStat,
	makeRecord,
	readBaseRevision,
	type StateStore,
	type StoredRecord,
	writeBaseRevision,
} from "./state";

/**
 * The vault, as far as a push needs it: it reads. The one file it ever
 * writes is the root `.gitignore`: the section Sync Evo keeps in it, when
 * it has none (`addSection`), and an empty file for the first commit of a
 * remote that has none, in a vault that still has none either.
 */
export type PushVault = Pick<PullVault, "list" | "stat" | "read" | "saveOpenEditors" | "write">;

/** Everything the first push of a sync state sends, as the remote will spell it. Each list is sorted. */
export interface FirstPushFiles {
	readonly added: readonly string[];
	readonly modified: readonly string[];
	readonly deleted: readonly string[];
}

/**
 * The section this push added to the root `.gitignore`, for telling the
 * user: it was written without asking.
 */
export interface SectionAdded {
	/** Every line that was put at the top of the file, the two markers included. */
	readonly lines: readonly string[];
	/** Whether the vault had no `.gitignore`, and the file was made. */
	readonly created: boolean;
	/**
	 * The files the remote holds that the added lines match, as the remote
	 * spells them, sorted. They stay synced (`remoteFilesMatchingRules`).
	 */
	readonly tracked: readonly string[];
}

/**
 * What the user is shown when the push stops to ask. One question, also
 * when there is more than one reason to ask: at least one of the two is
 * set.
 */
export interface PushConfirmRequest {
	/** Set when no push of this sync state has gone through yet. */
	readonly firstPush: FirstPushFiles | null;
	/**
	 * Whether the remote has no commit yet. The push then makes two
	 * commits: the `.gitignore` alone, and the rest. Told with `firstPush`,
	 * which is set unless this sync state has pushed before, to a remote
	 * that has lost its commits since.
	 */
	readonly remoteEmpty: boolean;
	/**
	 * The files the push deletes on the remote that count toward the
	 * threshold, when they are past it; `null` when they are not.
	 */
	readonly deletions: readonly string[] | null;
	/** The number of records before the push, of every kind. */
	readonly recordCount: number;
	/**
	 * Set when this push added the section to `.gitignore` and `firstPush`
	 * is set: the question about everything that is sent is where what was
	 * written without asking is shown, before it goes to the remote.
	 */
	readonly sectionAdded?: SectionAdded;
}

/**
 * "proceed": send all of it. "cancel": send none of it. "later": no answer;
 * nothing is sent, and the next push asks again. The answer of a sync that
 * started by itself, which has no one to ask (`PushOutcome` "waiting").
 */
export type PushAnswer = "proceed" | "cancel" | "later";

export type ConfirmPush = (request: PushConfirmRequest) => Promise<PushAnswer>;

export type PushPhase = "listing" | "scanning" | "hashing" | "sending" | "finishing";

export interface PushProgress {
	readonly phase: PushPhase;
	readonly done: number;
	/** 0 while it is not known. */
	readonly total: number;
}

export interface PushDeps {
	/** The sync state, opened. */
	readonly store: StateStore;
	readonly backend: Pick<Backend, "hashContent" | "list" | "checkBase" | "push" | "start">;
	readonly vault: PushVault;
	/** The configuration folder and the plugin's own folder. */
	readonly paths: ExclusionPaths;
	/** The name of this device, for the description of the commit. */
	readonly deviceName: string;
	/** Milliseconds since the epoch, on the clock the file times come from. */
	readonly now: () => number;
	readonly confirm: ConfirmPush;
	/**
	 * Vault paths this push leaves alone on every side: what the pull right
	 * before it put off (`PullResult.deferred`). Such a file is in the
	 * middle of something only a pull can finish.
	 */
	readonly hold?: readonly string[];
	/**
	 * Whether the default section is added to a root `.gitignore` that has
	 * none, before the vault is looked at. Left out, it is. The app never
	 * says no; it is there for a caller that is about something else.
	 */
	readonly addSection?: boolean;
	/**
	 * Set for the light check, as for a pull (`PullDeps.index`): the vault
	 * is not walked. A new file with a `.` name somewhere in its path is
	 * not found, and not sent, until a push that scans.
	 */
	readonly index?: VaultIndex;
	/**
	 * Called once the section is written, with what the result will carry.
	 * For a push that then rejects: the file was changed all the same, and
	 * no result says so.
	 */
	readonly onSectionAdded?: (added: SectionAdded) => void;
	readonly onProgress?: (progress: PushProgress) => void;
	/**
	 * Stops the push before the next thing it would do, for as long as
	 * nothing of it shows on the remote. Once the branch has moved, the
	 * push records what it sent whatever the signal says.
	 */
	readonly signal?: AbortSignal;
	/** Awaited now and then while the vault is hashed, so that the screen does not stand still. */
	readonly yieldControl?: () => Promise<void>;
	/** The largest file that is synced, in bytes. `DEFAULT_SIZE_LIMIT` when absent. */
	readonly sizeLimit?: number;
	/** A line for the developer console, in English. */
	readonly log?: (message: string) => void;
}

/**
 * - "pushed": one commit was made and the branch points at it. Two for a
 *   remote that had none: the `.gitignore` alone, and the rest.
 * - "nothing-to-push": the remote already holds what the vault has, as far
 *   as a push may send it. No commit was made.
 * - "pull-first": nothing was sent, and a pull has to come first
 *   (`PullFirstReason`).
 * - "declined": the user was asked and said no. Nothing was sent.
 * - "cancelled": stopped through the signal before the branch was moved,
 *   also while the question was open. Nothing shows on the remote.
 * - "waiting": the question was not answered ("later"), and waits for a
 *   push that can ask it (`PushRunResult.waitingFor`). Nothing was sent. No
 *   failure, like a "no": a push that had not got to its end before this
 *   one is as unfinished as it was. The section this push added to
 *   `.gitignore` is in the file all the same (`sectionAdded`).
 */
export type PushOutcome = "pushed" | "nothing-to-push" | "pull-first" | "declined" | "cancelled" | "waiting";

/**
 * What a push that ended "waiting" has to ask: everything it sends, since
 * no push of this sync state has gone through yet, or else the deletions
 * that are past the threshold.
 */
export type PushWaitReason = "first-push" | "deletions";

/**
 * - "no-base": this device has not pulled to the end yet, so what the vault
 *   holds is not known to belong to the remote.
 * - "remote-empty": the remote has no commit to build on, and none can be
 *   made: this device has synced with it before, when it had commits, or
 *   the remote is of a kind that cannot be started (`Backend.start`).
 * - "not-default-branch": the remote has no commit, and its first one can
 *   only be made on its default branch, which is not the configured one
 *   (`PushRunResult.defaultBranch`).
 * - "remote-moved": another device has pushed since the remote was listed:
 *   found before anything was sent, or when the branch was to be moved.
 *   The branch is never forced.
 * - "gitignore-unsettled": the root `.gitignore` could not be relied on: a
 *   pull that stopped was writing it, a write of Sync Evo's own to it did
 *   not get to its end and could not be settled (`settleGitignoreWrite`),
 *   or an editor that has it open could not save. Its rules decide what is
 *   sent, so nothing is.
 * - "gitignore-unreadable": the root `.gitignore` is there and cannot be
 *   read as the file it is: a cloud drive has taken it off the device, it
 *   is a folder, or (before the first commit of a remote, which is this
 *   file) the vault spells it in another case.
 */
export type PullFirstReason =
	| "no-base"
	| "remote-empty"
	| "not-default-branch"
	| "remote-moved"
	| "gitignore-unsettled"
	| "gitignore-unreadable";

/**
 * Why a file was left out: when its turn to be sent came, or ("unreadable"
 * and "not-downloaded") already when the vault was compared. The rest of
 * the push went on, and the next push takes the file up again.
 *
 * "not-downloaded": a new file that a cloud drive took off the device
 * before it was ever synced. Only this device knows of it, and it is not
 * sent until it is downloaded.
 *
 * "too-large": the file grew past the size limit after the push was
 * planned. "refused-size": the remote would not take its content because
 * of its size, though it is within the limit. "refused-workflows": the
 * remote would not take a workflow file from these credentials. The next
 * push meets the same answer unless something has changed.
 */
export type LeftOutReason =
	| "save-failed"
	| "gone"
	| "too-large"
	| "refused-size"
	| "refused-workflows"
	| "unreadable"
	| "not-downloaded";

export interface LeftOutFile {
	readonly path: string;
	readonly reason: LeftOutReason;
}

/** What happened, without a word of text: wording it is the caller's. */
export interface PushRunResult {
	readonly outcome: PushOutcome;
	/** Only for "pull-first". */
	readonly reason?: PullFirstReason;
	/** Only for "waiting". */
	readonly waitingFor?: PushWaitReason;
	/** Only for "not-default-branch": the branch the first commit of the remote would go to. */
	readonly defaultBranch?: string;
	/** The commit that was made; `null` when none was. */
	readonly revision: string | null;
	/** What the commit changed, as its description counts it. All 0 unless "pushed". */
	readonly counts: PushCounts;
	/**
	 * Set when this push found that an earlier one, which had ended without
	 * knowing whether it went through, did go through: what that one
	 * changed. It is recorded now, and told as a success.
	 */
	readonly recovered: PushCounts | null;
	/**
	 * Set when the earlier push this one found to have gone through was one
	 * that untracked (`untrack.ts`): how many files it took out of the
	 * remote. `recovered` is `null` then. They are still on this device, and
	 * are told as untracked and not as deleted.
	 */
	readonly recoveredUntrack?: number;
	/** New files that are not sent (`PushRefusalReason`), by every push for as long as that is so. */
	readonly refused: readonly PushRefusal[];
	readonly heldRenames: readonly HeldRename[];
	/**
	 * Vault paths that were not looked at, as far as the scan found them:
	 * left half written by a pull that stopped, put off by the pull before
	 * this push, or open in an editor that could not save. Nothing of them
	 * was sent or deleted. Without the files that could not be read, which
	 * are in `leftOut`, and without the ones a cloud drive has taken off
	 * the device. Of those, the ones that were synced before are not told:
	 * nothing is wrong with them. The new ones are in `leftOut`.
	 */
	readonly held: readonly string[];
	readonly leftOut: readonly LeftOutFile[];
	/**
	 * The one-time notices that apply for the first time, already
	 * remembered. Empty for a push that was declined or stopped at the
	 * question. A push that failed before the remote answered remembers
	 * none: what is not shown is not used up. One that failed to record
	 * the push after the remote answered has remembered them, though no
	 * result shows them.
	 */
	readonly notices: readonly NoticeRef[];
	/**
	 * Only for "pushed": the files the remote holds with other content
	 * than this device sent, as the remote spells them. The record of each
	 * is of what was sent, so the next pull finds the vault unchanged and
	 * the remote changed, and writes the remote's content over the file.
	 */
	readonly storedOtherwise: readonly string[];
	/**
	 * Set when this push added the section to `.gitignore`, however it
	 * ended: the file on this device was changed. `asked`: whether the
	 * question of this push showed it (`PushConfirmRequest.sectionAdded`).
	 * `sent`: whether the remote holds the file with the section now. Not
	 * told by the outcome: the first commit of a remote without commits is
	 * this file, and it stays there when the push that follows it is
	 * turned down or stopped.
	 */
	readonly sectionAdded?: SectionAdded & { readonly asked: boolean; readonly sent: boolean };
}

const GITIGNORE = ".gitignore";
const NO_COUNTS: PushCounts = { added: 0, modified: 0, deleted: 0 };

/**
 * Pushes. Resolves with what happened. Rejects when the remote or the sync
 * state failed; nothing shows on the remote then, with one exception: a
 * failure of the very last request, which may have gone through all the
 * same. The commit is remembered for that, and the next push or pull finds
 * out (`settlePendingPush`).
 */
export async function runPush(deps: PushDeps): Promise<PushRunResult> {
	return new PushRun(deps).push();
}

class PushRun {
	private readonly startedAt: number;
	private readonly sizeLimit: number;
	/** The paths the plan leaves alone (`PlanInput.held`), without the cases. */
	private readonly held = new Set<string>();
	private recovered: PushCounts | null = null;
	private recoveredUntrack: number | null = null;
	private plan: PushPlan | null = null;
	private notices: NoticeRef[] = [];
	private readonly leftOut: LeftOutFile[] = [];
	/** The held paths that `PushRunResult.held` does not list, without the cases. */
	private readonly quiet = new Set<string>();
	/** Whether the commit that was made is remembered (`rememberPendingPush`). */
	private remembered = false;
	/** Whether the request that moves the branch was sent, or was about to be. */
	private publishing = false;
	/** The section this push added to `.gitignore`, and whether its question showed it. */
	private sectionAdded: SectionAdded | null = null;
	private sectionAsked = false;
	/** Whether the `.gitignore` with the section is on the remote. */
	private sectionSent = false;

	constructor(private readonly deps: PushDeps) {
		this.startedAt = deps.now();
		this.sizeLimit = deps.sizeLimit ?? DEFAULT_SIZE_LIMIT;
	}

	async push(): Promise<PushRunResult> {
		const { store } = this.deps;
		// From here until the push has gone through, it counts as one that
		// did not get to its end (`push-failure.ts`): also when the app is
		// closed under it. Written by every push, also one that finds
		// nothing to send.
		const before = await readPushFailure(store);
		await markPushFailure(store, this.startedAt);
		try {
			const result = await this.run();
			// Quietly: the push has ended as it has, whatever becomes of this.
			if (result.outcome === "pushed" || result.outcome === "nothing-to-push") {
				await this.quietly(() => clearPushFailure(store));
			} else if (
				result.outcome !== "pull-first" ||
				result.reason === "remote-empty" ||
				result.reason === "not-default-branch"
			) {
				// A "no" and a stop are the user's, and no failure; a
				// question left for later is none either. Nor is a remote
				// without commits that nothing can be sent to: no later
				// push would ever take the note away.
				await this.quietly(() => restorePushFailure(store, before));
			}
			return result;
		} catch (error) {
			// The commit was made and remembered, and the request that moves
			// the branch was never sent: the push has not happened, and
			// nothing is left to find out. Forgotten here, so that the next
			// sync does not ask the remote about it. Not once that request
			// may have been sent.
			if (this.remembered && !this.publishing) await this.quietly(() => forgetPendingPush(this.deps.store));
			// The listing this push was planned from is not what the remote
			// holds. The next sync lists the remote again.
			if (error instanceof BackendError && error.kind === "not-as-listed") {
				await this.quietly(() => this.deps.store.clearListing());
			}
			// Stopped while the remote was asked or sent to. The branch was
			// not moved by a request that was never sent.
			if (this.aborted() && error instanceof BackendError && error.kind === "cancelled") {
				await this.quietly(() => restorePushFailure(store, before));
				return this.result("cancelled");
			}
			throw error;
		}
	}

	private aborted(): boolean {
		return this.deps.signal?.aborted === true;
	}

	/** For tidying up after a failure: what fails here must not take the place of that failure. */
	private async quietly(step: () => Promise<void>): Promise<void> {
		try {
			await step();
		} catch {
			// The failure that led here is the one to tell.
		}
	}

	/**
	 * A request that is on its way is not waited for once the push is
	 * stopped. Only around the request: nothing follows it then.
	 */
	private asked<T>(request: () => Promise<T>): Promise<T> {
		return this.aborted() ? request() : untilAborted(request(), this.deps.signal);
	}

	private progress(phase: PushPhase, done = 0, total = 0): void {
		this.deps.onProgress?.({ phase, done, total });
	}

	private result(outcome: PushOutcome, extra: Partial<PushRunResult> = {}): PushRunResult {
		const plan = this.plan;
		return {
			outcome,
			revision: null,
			counts: NO_COUNTS,
			recovered: this.recovered,
			...(this.recoveredUntrack === null ? {} : { recoveredUntrack: this.recoveredUntrack }),
			refused: plan?.refused ?? [],
			heldRenames: plan?.heldRenames ?? [],
			held: (plan?.skipped ?? [])
				.filter((skip) => skip.reason === "held")
				.flatMap((skip) => skip.local.map((entry) => entry.path))
				.filter((path) => !this.quiet.has(foldedKey(path))),
			leftOut: this.leftOut,
			notices: this.notices,
			storedOtherwise: [],
			...(this.sectionAdded === null
				? {}
				: { sectionAdded: { ...this.sectionAdded, asked: this.sectionAsked, sent: this.sectionSent } }),
			...extra,
		};
	}

	private async run(): Promise<PushRunResult> {
		const { deps } = this;
		const { store, vault } = deps;
		this.progress("listing");
		const listing = await currentListing(store, (known) => this.asked(() => deps.backend.list(known)));
		const settled = await settlePendingPush(store, listing.revision, (base, head) =>
			this.asked(() => deps.backend.checkBase(base, head)),
		);
		if (settled?.untrack === true) this.recoveredUntrack = settled.counts.deleted;
		else this.recovered = settled?.counts ?? null;
		const base = await readBaseRevision(store);
		const records = await store.readRecords();
		// A remote without commits is given its first one by this push,
		// further down. Not when this device has synced with it before:
		// the commits it had are gone, and what the vault holds is not all
		// new to it. That is a pull's to look at.
		const starting = listing.revision === null;
		if (starting) {
			if (deps.backend.start === undefined || base !== null || records.length > 0) {
				return this.result("pull-first", { reason: "remote-empty" });
			}
		} else if (base === null) {
			// Without a pull that got to the end, nothing in the vault is
			// known to belong to this remote. Looked at after the listing,
			// so that a remote without commits is told as what it is.
			return this.result("pull-first", { reason: "no-base" });
		}
		if (this.aborted()) return this.result("cancelled");

		// What a pull that stopped was writing may be half a file. A pull
		// puts it right (`settleMarkers` in `pull.ts`); a push only keeps
		// away from it, and from the file a half-written copy is a copy of.
		for (const marker of await store.readMarkers()) {
			this.held.add(foldedKey(marker.path));
			const original = marker.conflictCopy ? originalPathOfConflictCopy(marker.path) : null;
			if (original !== null) this.held.add(foldedKey(original));
		}
		for (const path of deps.hold ?? []) this.held.add(foldedKey(path));

		// The rules are the ones this device has: a push alone fetches
		// nothing, and after a pull they are the remote's. They decide what
		// is sent, so a `.gitignore` that may be half written, or behind
		// what an editor holds, is not gone by.
		// Nor one that Sync Evo itself was writing when it was stopped: that
		// is settled here, and only what could not be stops the push.
		if (this.held.has(GITIGNORE) || !(await settleGitignoreWrite({ store, vault })) || !(await saved(vault, GITIGNORE))) {
			return this.result("pull-first", { reason: "gitignore-unsettled" });
		}
		if (deps.addSection !== false && !(await this.addSection(listing, records))) {
			return this.result("pull-first", { reason: "gitignore-unsettled" });
		}
		const exclusion = createExclusion({ ...deps.paths, gitignore: await this.rootGitignore() });

		this.progress("scanning");
		const began = deps.now();
		const scanned = { exclusion, remote: listing.entries, records };
		const light = deps.index === undefined ? null : await scanLightly({ ...scanned, index: deps.index, vault });
		const scan = light ?? (await scanVault({ ...scanned, lister: vault }));
		const local = await readLocal(
			{
				vault,
				backend: deps.backend,
				store,
				now: deps.now,
				startedAt: this.startedAt,
				sizeLimit: this.sizeLimit,
				held: this.held,
				aborted: () => this.aborted(),
				onProgress: (done, total) => this.progress("hashing", done, total),
				saveEditors: true,
				...(deps.yieldControl === undefined ? {} : { yieldControl: deps.yieldControl }),
				...(light === null ? {} : { indexed: light.indexed }),
			},
			scan,
			records,
			listing,
		);
		if (local === null) return this.result("cancelled");
		if (light !== null) deps.log?.(`push: ${lightCheckLine(light, local, deps.now() - began)}`);
		// On disk it may be behind what the user sees.
		for (const path of local.unsaved) this.held.add(foldedKey(path));
		// Nothing is known of the content: not sent, and not deleted on the
		// remote. A file that could not be read is told; one a cloud drive
		// holds is not, since nothing is wrong with it. Unless it is new:
		// with no record and nothing at its path on the remote, it is a
		// file to add, which no device gets for as long as it stays away.
		// That one is told, by every push while it is so.
		for (const path of local.unreadable) {
			this.held.add(foldedKey(path));
			this.quiet.add(foldedKey(path));
			this.leftOut.push({ path, reason: "unreadable" });
		}
		// The rules of a `.gitignore` that is not on the device are not
		// known, and a push without them would send what they exclude.
		if (local.placeholders.some((path) => foldedKey(path) === GITIGNORE)) {
			return this.result("pull-first", { reason: "gitignore-unreadable" });
		}
		if (starting) {
			// The first commit is the `.gitignore`, as a file of that very
			// name. Looked at before the question, so that no "yes" ends here.
			const stat = await vault.stat(GITIGNORE);
			const respelled = local.entries.some((entry) => entry.path !== GITIGNORE && foldedKey(entry.path) === GITIGNORE);
			if (stat === null ? respelled : stat.type !== "file") {
				return this.result("pull-first", { reason: "gitignore-unreadable" });
			}
		}
		const known = new Set([...records.map((record) => record.key), ...listing.entries.map((entry) => pathKey(entry.path))]);
		for (const path of local.placeholders) {
			this.held.add(foldedKey(path));
			this.quiet.add(foldedKey(path));
			if (!known.has(pathKey(path))) this.leftOut.push({ path, reason: "not-downloaded" });
		}

		const plan = planPush({
			remote: listing.entries,
			local: local.entries,
			records,
			exclusion,
			sizeLimit: this.sizeLimit,
			held: this.held,
		});
		this.plan = plan;
		// Remembered only where the result that carries them is one the
		// user is shown them with: a push that is declined, stopped at the
		// question, or fails while it sends, tells them the next time
		// instead.
		const notices = await this.noticeUpdate(plan, exclusion, listing, scan);
		const tell = async (): Promise<void> => {
			await writeNotices(store, notices.remember);
			this.notices = [...notices.show];
		};
		if (plan.sends.length + plan.deletes.length === 0) {
			await tell();
			return this.result("nothing-to-push");
		}

		// The reasons to ask, in one question. No answer is remembered
		// here: a push that fails is counted and asked again,
		// and the first push counts as asked once one has gone through.
		// Before anything goes to a remote without commits, the question is
		// also the one a first fetch would have asked (`first-fetch.ts`),
		// which a push alone never comes by: everything in the vault is
		// about to be sent to the repository it names.
		const firstDue =
			(await store.getMeta(FIRST_PUSH_CONFIRMED_KEY)) !== true || (starting && !(await isFirstFetchConfirmed(store)));
		const guardDue = needsPushConfirmation(plan);
		if (firstDue || guardDue) {
			const added = firstDue ? this.sectionAdded : null;
			const answer = await deps.confirm({
				firstPush: firstDue ? firstPushFiles(plan) : null,
				remoteEmpty: starting,
				deletions: guardDue ? plan.countedDeletions : null,
				recordCount: plan.recordCount,
				...(added === null ? {} : { sectionAdded: added }),
			});
			// Shown to no one: the section is told by the result instead.
			if (answer === "later") return this.result("waiting", { waitingFor: firstDue ? "first-push" : "deletions" });
			this.sectionAsked = added !== null;
			// A question that was closed because the push was stopped is no
			// answer of the user's: told as the stop it is.
			if (answer !== "proceed") return this.result(this.aborted() ? "cancelled" : "declined");
		}
		if (this.aborted()) return this.result("cancelled");

		// The time and the size each file had right before it was read, by
		// the key it is sent under. Taken before the read and not after: an
		// edit that lands in between then shows as a time that is not the
		// record's, and the file is hashed again.
		const stats = new Map<string, FileStat>();
		let total = 0;
		let done = 0;
		// The first commit of a remote without commits holds the
		// `.gitignore` alone; the rest is sent on top of it, like any push.
		let parent = listing.revision;
		let started = 0;
		if (parent === null) {
			const first = await this.start();
			if ("outcome" in first) return first;
			parent = first.revision;
			started = 1;
			// The first commit is the `.gitignore` of the vault, as it is.
			this.sectionSent = this.sectionAdded !== null;
		}
		const onto = parent;
		const sends = started === 0 ? plan.sends : plan.sends.filter((send) => send.key !== GITIGNORE);
		if (started === 1 && sends.length === 0) {
			// The vault held nothing else to send.
			await tell();
			await store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
			return this.result("pushed", { revision: onto, counts: { ...NO_COUNTS, added: 1 } });
		}

		const writes = sends.map((send): PushFile => {
			const { path } = send.local;
			const leave = (reason: LeftOutReason): null => {
				this.leftOut.push({ path, reason });
				return null;
			};
			return {
				path: send.path,
				hash: send.local.hash,
				size: send.local.size ?? 0,
				...(send.replaces === undefined ? {} : { replaces: send.replaces }),
				// What is on disk now is what is sent, also when it is
				// newer than what was planned: a note that is typed in
				// during the push is no reason to fail all of it.
				read: async () => {
					this.progress("sending", ++done, total);
					if (!(await saved(vault, path))) return leave("save-failed");
					try {
						const stat = await vault.stat(path);
						if (stat === null || stat.type !== "file") return leave("gone");
						if (stat.size > this.sizeLimit) return leave("too-large");
						const content = await vault.read(path);
						stats.set(pathKey(send.path), { mtime: stat.mtime, size: stat.size });
						return content;
					} catch {
						return leave("unreadable");
					}
				},
				refused: (reason) => {
					stats.delete(pathKey(send.path));
					leave(reason === "workflows" ? "refused-workflows" : "refused-size");
				},
			};
		});

		total = writes.length;
		this.progress("sending", 0, total);
		const pushed = await deps.backend.push({
			baseRevision: onto,
			writes,
			deletes: plan.deletes.map((entry) => entry.remote),
			deviceName: deps.deviceName,
			beforePublish: async ({ revision, written }) => {
				await rememberPendingPush(store, this.pendingOf(plan, onto, revision, written, stats));
				this.remembered = true;
				this.progress("finishing");
			},
			onPublish: () => {
				this.publishing = true;
			},
		});
		// Only now that the remote has answered, whatever it answered: a
		// push that threw is told as a failure, without the notices.
		await tell();
		if (pushed.status === "stale") {
			// A plain "no": the commit that was made is not in the branch.
			if (this.remembered) await forgetPendingPush(store);
			return this.result("pull-first", { reason: "remote-moved" });
		}
		if (pushed.status === "unchanged") {
			// The user has answered for this remote, also when the remote
			// then took none of the files: not asked again for that.
			if (this.leftOut.some((file) => file.reason === "refused-size" || file.reason === "refused-workflows")) await store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
			if (started === 0) return this.result("nothing-to-push");
			// The first commit was made, and nothing could be read of the rest.
			await store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
			return this.result("pushed", { revision: onto, counts: { ...NO_COUNTS, added: 1 } });
		}
		const { revision, written } = pushed;
		if (written.some((entry) => pathKey(entry.path) === GITIGNORE)) this.sectionSent = this.sectionAdded !== null;
		if (revision === null) throw new Error("The remote answered a push without a revision.");

		// From here on the push has happened, and is recorded whatever the
		// signal says. Stopped in between, the next push or pull does it.
		const pending = this.pendingOf(plan, onto, revision, written, stats);
		// The listing of the new commit is the remote's own, or none at
		// all: the next sync then lists the remote again.
		const stored = pushed.listing ?? null;
		await finishPush(store, pending, stored);
		if (stored === null) deps.log?.("push: the tree of the new commit could not be fetched; the next sync lists the remote again");

		// A remote that stored a file as other bytes than it was sent. The
		// record stays the one of what was sent, which is what the vault
		// holds: the sync decision then reads "the vault did not change,
		// the remote did" (`decide` in `plan.ts`: the record is the vault's
		// hash and not the remote's), and the next pull fetches the remote's
		// content over the file, with no conflict. A record of the remote's
		// hash would instead make the vault read as edited, and every push
		// would send the file again.
		const storedOtherwise = stored === null ? [] : differing(written, stored);
		if (storedOtherwise.length > 0) {
			deps.log?.(`push: GitHub stored other content than was sent: ${storedOtherwise.join(", ")}`);
		}
		// The two commits are told as the one push they are.
		const counts = { ...pending.counts, added: pending.counts.added + started };
		return this.result("pushed", { revision, counts, storedOtherwise });
	}

	/**
	 * Makes the first commit of a remote that has none: the `.gitignore`
	 * of the vault, which holds the section by now (`addSection`), or an
	 * empty one where the vault still has none: the section could not be
	 * written, or was not to be. An empty one is written to the vault once
	 * the remote has it, and not before: a file the remote did not take
	 * would be one the user never made. Recorded as a pull of that
	 * one file would be: the commit is the base revision from here on, and
	 * the push that follows is one like any other. Answers how the push
	 * ends instead when no commit was made.
	 *
	 * Stopped or failed after the commit was made and before it is
	 * recorded, the remote is no longer empty and this device has no base
	 * revision: the next push asks for a pull first, which finds the
	 * `.gitignore` the same on both sides, or writes it.
	 */
	private async start(): Promise<{ readonly revision: string } | PushRunResult> {
		const { store, vault, backend } = this.deps;
		if (backend.start === undefined) return this.result("pull-first", { reason: "remote-empty" });
		const start = backend.start.bind(backend);
		const before = await vault.stat(GITIGNORE);
		if (before !== null && before.type !== "file") return this.result("pull-first", { reason: "gitignore-unreadable" });
		const content = before === null ? new Uint8Array() : await vault.read(GITIGNORE);
		const first = await this.asked(() => start({ path: GITIGNORE, content, deviceName: this.deps.deviceName }));
		if (first.status === "stale") return this.result("pull-first", { reason: "remote-moved" });
		if (first.status === "other-branch") {
			return this.result("pull-first", { reason: "not-default-branch", defaultBranch: first.defaultBranch });
		}
		const { revision, entry } = first;
		let stat = before;
		if (stat === null) {
			await vault.write(GITIGNORE, content);
			stat = await vault.stat(GITIGNORE);
		}
		const record = { path: entry.path, kind: "file", hash: entry.hash } as const;
		await store.commitWrite(
			makeRecord(record, stat === null ? undefined : { mtime: stat.mtime, size: stat.size }, this.startedAt),
		);
		await store.putListing({ revision, entries: [entry] });
		await writeBaseRevision(store, revision);
		await markFirstFetchConfirmed(store);
		return { revision };
	}

	/** What is recorded once the commit is the head of the remote. */
	private pendingOf(
		plan: PushPlan,
		parent: string,
		revision: string,
		written: readonly RemoteEntry[],
		stats: ReadonlyMap<string, FileStat>,
	): PendingPushState {
		const replaced = new Map<string, string>();
		for (const send of plan.sends) {
			if (send.replaces !== undefined) replaced.set(send.path, send.replaces.hash);
		}
		let added = 0;
		let modified = 0;
		for (const entry of written) {
			const before = replaced.get(entry.path);
			if (before === undefined) added += 1;
			else if (before !== entry.hash) modified += 1;
		}
		return {
			revision,
			parent,
			// With the hash of what was sent, which is not always the one
			// that was planned.
			records: written.map((entry) =>
				makeRecord({ path: entry.path, kind: "file", hash: entry.hash }, stats.get(pathKey(entry.path)), this.startedAt),
			),
			deleted: plan.deletes.map((entry) => entry.key),
			counts: { added, modified, deleted: plan.deletes.length },
		};
	}

	/**
	 * Adds the default section to a root `.gitignore` that has none, or
	 * makes the file with it. Answers `false` when the write failed halfway
	 * and the file can no longer be gone by; `true` in every other case,
	 * also when nothing was added. Then the lines of the section are applied
	 * without being written (`effectiveRules`), as they were by the pull, and
	 * the next sync tries again.
	 *
	 * Called with the `.gitignore` known to be settled: no marker, no write
	 * of its own left unfinished, not put off by the pull before, saved by
	 * every editor. Not added:
	 *
	 * - once the push was stopped;
	 * - when the remote's `.gitignore` is not the one this device last
	 *   synced (`isGitignoreAsRecorded`): the push would not send the file.
	 *   That is the pull that did not get to this file, and a push alone
	 *   after another device changed it;
	 * - when the file has a section, an empty or a broken one included, or
	 *   is there and cannot be read (`SectionLeftReason`).
	 */
	private async addSection(listing: RemoteListing, records: readonly StoredRecord[]): Promise<boolean> {
		const { deps } = this;
		if (this.aborted()) return true;
		if (!isGitignoreAsRecorded(listing.entries, records)) {
			deps.log?.("push: no section was added to .gitignore: the remote's is not the one this device last synced");
			return true;
		}
		const addition = await addDefaultSection({
			store: deps.store,
			vault: deps.vault,
			paths: deps.paths,
			sizeLimit: this.sizeLimit,
		});
		if (addition.kind === "unsettled") return false;
		if (addition.kind === "left") {
			if (addition.reason !== "present") deps.log?.(`push: no section was added to .gitignore: ${addition.reason}`);
			return true;
		}
		// By the added lines, and by the file as it is now. Without Sync
		// Evo's own folder, which is not synced: these are told as files
		// that stay synced.
		const tracked = untrackableByAddedLines(deps.paths, addition.lines.slice(1, -1), addition.text, listing.entries)
			.files.filter((file) => !file.ownFolder)
			.map((file) => file.entry.path)
			.sort();
		this.sectionAdded = { lines: addition.lines, created: addition.created, tracked };
		deps.onSectionAdded?.(this.sectionAdded);
		return true;
	}

	/** The `.gitignore` at the vault root, as it is now. */
	private async rootGitignore(): Promise<string | null> {
		const { vault } = this.deps;
		const stat = await vault.stat(GITIGNORE);
		if (stat === null || stat.type !== "file" || stat.size > this.sizeLimit) return null;
		return new TextDecoder().decode(await vault.read(GITIGNORE));
	}

	/**
	 * Works out which of the notices a push finds apply now: what to
	 * remember, and the ones that apply for the first time. What only a
	 * pull finds out is left as it is remembered. Nothing is stored here.
	 */
	private async noticeUpdate(
		plan: PushPlan,
		exclusion: Exclusion,
		listing: RemoteListing,
		scan: ScanResult,
	): Promise<ReturnType<typeof reconcileNotices>> {
		const { store, paths } = this.deps;
		const remembered = await readNotices(store);
		const mine = (notice: NoticeRef): boolean =>
			SHARED_NOTICE_KINDS.includes(notice.kind) || PUSH_NOTICE_KINDS.includes(notice.kind);
		// A light check forgets nothing, as in a pull (`updateNotices`): it
		// has not seen all a scan sees.
		const light = this.deps.index !== undefined;
		const current: NoticeRef[] = remembered.filter((notice) => light || !mine(notice));
		// By the rules this push goes by: the file as it is on this device,
		// with the section when this push added it.
		current.push(
			...ruleNotices(
				exclusion,
				paths,
				listing.entries,
				scan.paths.map((scanned) => scanned.path),
			),
		);
		for (const skip of plan.skipped) {
			if (skip.reason !== "too-large") continue;
			// Named as a pull names it, so that the two tell it once between them.
			const path = skip.remote[0]?.path ?? skip.local[0]?.path ?? skip.records[0]?.path ?? skip.key;
			current.push({ kind: "too-large", path });
		}
		for (const refusal of plan.refused) {
			if (refusal.reason === "case-collision") current.push({ kind: "local-path-collision", path: refusal.path });
		}
		for (const rename of plan.heldRenames) current.push({ kind: "rename-not-sent", path: rename.to });

		return reconcileNotices(remembered, current);
	}
}

function firstPushFiles(plan: PushPlan): FirstPushFiles {
	const paths = (list: readonly string[]): string[] => [...list].sort();
	return {
		added: paths(plan.sends.filter((send) => send.replaces === undefined).map((send) => send.path)),
		modified: paths(plan.sends.filter((send) => send.replaces !== undefined).map((send) => send.path)),
		deleted: paths(plan.deletes.map((entry) => entry.remote.path)),
	};
}

/** The paths of the files that were sent which the listing of the new commit holds under another hash, or not at all. */
function differing(written: readonly RemoteEntry[], listing: RemoteListing): string[] {
	const listed = new Map(listing.entries.map((entry) => [entry.path, entry.hash]));
	return written
		.filter((entry) => listed.get(entry.path) !== entry.hash)
		.map((entry) => entry.path)
		.sort();
}
