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

// Untracking: files the remote holds and a rule of `.gitignore` matches are
// taken out of the remote, and stay on this device, as `git rm --cached`
// does. One commit that only deletes, apart from any push of the vault's
// changes, and nothing in the vault is read for it but the root `.gitignore`.
//
// The user is asked before any of this runs, with the list of the files
// (`untrack-report.ts`). What is deleted is never more than that list.
//
// The rules have to be on the remote first. A commit that takes a file out
// while the remote's `.gitignore` does not leave it out would have another
// device, which has edited that file, send it again: to that device the file
// is one the remote deleted and the vault changed, and nothing says it is to
// be left out. So the sync runs first (`runUntrackSync`), and the commit is
// only made where the `.gitignore` of this device is the remote's
// (`runUntrack`, which looks for itself).
//
// The records are taken away the way a push takes them away: remembered
// before the branch is moved (`push-pending.ts`), and settled by whoever
// looks at the remote next when this was stopped in between. A record that
// stayed would have the next pull read "the remote deleted it", and delete
// the file on this device.

import { untilAborted } from "./archive-fetch";
import { type Backend, BackendError, type RemoteEntry } from "./backend";
import { originalPathOfConflictCopy } from "./conflict-name";
import { createExclusion, type ExclusionPaths, untrackableFiles } from "./exclusion";
import { readRootGitignore, ROOT_GITIGNORE, settleGitignoreWrite } from "./gitignore-file";
import { findSection } from "./gitignore-section";
import { saved } from "./local-read";
import { foldedKey, pathKey } from "./paths";
import { DEFAULT_SIZE_LIMIT } from "./plan";
import { type PullDeps, type PullResult, runPull } from "./pull";
import { type PushDeps, type PushRunResult, type PushVault, runPush } from "./push";
import { clearPushFailure } from "./push-failure";
import {
	finishPush,
	forgetPendingPush,
	type PendingPushState,
	type PushCounts,
	rememberPendingPush,
	settlePendingPush,
} from "./push-pending";
import { currentListing, readBaseRevision, type StateStore } from "./state";
import { pathsToHold, pushFollows } from "./sync";

export interface UntrackDeps {
	/** The sync state, opened. */
	readonly store: StateStore;
	readonly backend: Pick<Backend, "hashContent" | "list" | "checkBase" | "push">;
	/** Only the root `.gitignore` is read, and written only to finish a write of Sync Evo's own. */
	readonly vault: PushVault;
	/** The configuration folder and the plugin's own folder. */
	readonly paths: ExclusionPaths;
	/** The name of this device, for the description of the commit. */
	readonly deviceName: string;
	/**
	 * Stops it before the next thing it would do, for as long as nothing of
	 * it shows on the remote. Once the branch has moved, what was untracked
	 * is recorded whatever the signal says.
	 */
	readonly signal?: AbortSignal;
	/** The largest file that is synced, in bytes. `DEFAULT_SIZE_LIMIT` when absent. */
	readonly sizeLimit?: number;
	/** A line for the developer console, in English. */
	readonly log?: (message: string) => void;
}

/**
 * - "untracked": one commit was made and the branch points at it. The files
 *   are out of the remote, on this device as they were, and without records.
 * - "nothing-to-untrack": none of the files that were shown is on the remote
 *   and matched by a rule any more. No commit was made.
 * - "sync-first": nothing was sent, and a sync has to come first
 *   (`UntrackRefusal`).
 * - "remote-moved": another device has pushed since the remote was listed.
 *   Nothing was changed.
 * - "cancelled": stopped through the signal before the branch was moved.
 *   Nothing shows on the remote.
 */
export type UntrackOutcome = "untracked" | "nothing-to-untrack" | "sync-first" | "remote-moved" | "cancelled";

/**
 * Why nothing was untracked, and a sync has to come first.
 *
 * - "remote-empty": the remote has no commit.
 * - "pull-unfinished": this device has not pulled the head of the remote to
 *   the end: it never pulled, the remote has moved since, or the last pull
 *   left files for later.
 * - "gitignore-unsettled": the root `.gitignore` cannot be gone by: a pull
 *   that stopped was writing it, a write of Sync Evo's own to it could not
 *   be settled, or an editor that has it open could not save.
 * - "gitignore-unreadable": the root `.gitignore` is there and cannot be
 *   read as the file it is.
 * - "no-section": the root `.gitignore` has no section, or the vault has no
 *   such file. The lines of the default section are then applied without
 *   being in the file, and so are not on the remote. A sync that sends adds
 *   the section; one that cannot (the file would be over the size limit)
 *   leaves this as it is.
 * - "section-broken": the file has markers that enclose no one section.
 *   What its lines are meant to say is the user's to put right first.
 * - "gitignore-not-sent": the remote holds no root `.gitignore`, or another
 *   one than this device has: the rules that were shown are not there yet,
 *   or the remote's are not here yet.
 */
export type UntrackRefusal =
	| "remote-empty"
	| "pull-unfinished"
	| "gitignore-unsettled"
	| "gitignore-unreadable"
	| "no-section"
	| "section-broken"
	| "gitignore-not-sent";

/**
 * Whether a push can put right what untracking was refused for. It can send
 * the `.gitignore` of this device, and add the section to one that has none.
 * It cannot get a pull to its end, settle or read a `.gitignore` it leaves
 * alone itself, or mend a section that is the user's to mend; and a remote
 * without commits holds nothing to untrack, whatever is sent to it.
 */
export function pushCanSettle(reason: UntrackRefusal | undefined): boolean {
	switch (reason) {
		case "no-section":
		case "gitignore-not-sent":
			return true;
		case "remote-empty":
		case "pull-unfinished":
		case "gitignore-unsettled":
		case "gitignore-unreadable":
		case "section-broken":
		case undefined:
			return false;
	}
}

/** What happened, without a word of text: wording it is the caller's (`untrack-report.ts`). */
export interface UntrackRunResult {
	readonly outcome: UntrackOutcome;
	/** Only for "sync-first". */
	readonly reason?: UntrackRefusal;
	/** The commit that was made; `null` when none was. */
	readonly revision: string | null;
	/** The files that were taken out of the remote, as the remote spelled them, sorted. Empty unless "untracked". */
	readonly untracked: readonly string[];
	/**
	 * Set when this found that an earlier push, which had ended without
	 * knowing whether it went through, did go through: what that one
	 * changed. It is recorded now.
	 */
	readonly recovered: PushCounts | null;
	/** Set instead when that push was one that untracked: how many files it took out of the remote. */
	readonly recoveredUntrack?: number;
}

/**
 * Untracks, of the paths that were shown to the user, the ones the remote
 * holds and a rule matches now. `shown` is what the confirmation listed, as
 * the remote spelled it then. Looked up anew in the listing of the head:
 * what was listed when the question was drawn may be spelled otherwise by
 * now, or hold other content, and the remote refuses an entry that is not
 * the one it holds.
 *
 * Nothing is sent unless this device has pulled the head to the end and its
 * root `.gitignore` is the remote's, with a section in it (`UntrackRefusal`).
 * No push of the vault's changes is made here, and the note of a push that
 * did not get to its end (`push-failure.ts`) is not touched by what this
 * sends, which is nothing of the vault. It is taken away only where this
 * finds that very push to have gone through after all, as a pull does.
 *
 * Resolves with what happened. Rejects when the remote or the sync state
 * failed; nothing shows on the remote then, but for a failure of the very
 * last request, which may have gone through. The commit is remembered for
 * that, and the next sync finds out (`settlePendingPush`).
 */
export async function runUntrack(deps: UntrackDeps, shown: readonly string[]): Promise<UntrackRunResult> {
	return new UntrackRun(deps, shown).untrack();
}

class UntrackRun {
	private readonly sizeLimit: number;
	private recovered: PushCounts | null = null;
	private recoveredUntrack: number | null = null;
	/** Whether the commit that was made is remembered (`rememberPendingPush`). */
	private remembered = false;
	/** Whether the request that moves the branch was sent, or was about to be. */
	private publishing = false;

	constructor(
		private readonly deps: UntrackDeps,
		private readonly shown: readonly string[],
	) {
		this.sizeLimit = deps.sizeLimit ?? DEFAULT_SIZE_LIMIT;
	}

	async untrack(): Promise<UntrackRunResult> {
		const { store } = this.deps;
		try {
			return await this.run();
		} catch (error) {
			// As a push does (`PushRun.push`): a commit whose branch was
			// never asked to move has not happened, and is forgotten; one
			// whose request may have been sent stays remembered.
			if (this.remembered && !this.publishing) await this.quietly(() => forgetPendingPush(store));
			// The listing the entries were taken from is not what the remote
			// holds. The next sync lists the remote again.
			if (error instanceof BackendError && error.kind === "not-as-listed") {
				await this.quietly(() => store.clearListing());
			}
			if (this.aborted() && error instanceof BackendError && error.kind === "cancelled") {
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

	/** A request that is on its way is not waited for once this is stopped. */
	private asked<T>(request: () => Promise<T>): Promise<T> {
		return this.aborted() ? request() : untilAborted(request(), this.deps.signal);
	}

	private result(outcome: UntrackOutcome, extra: Partial<UntrackRunResult> = {}): UntrackRunResult {
		return {
			outcome,
			revision: null,
			untracked: [],
			recovered: this.recovered,
			...(this.recoveredUntrack === null ? {} : { recoveredUntrack: this.recoveredUntrack }),
			...extra,
		};
	}

	private refused(reason: UntrackRefusal): UntrackRunResult {
		return this.result("sync-first", { reason });
	}

	private async run(): Promise<UntrackRunResult> {
		const { deps } = this;
		const { store, vault, backend } = deps;
		const listing = await currentListing(store, (known) => this.asked(() => backend.list(known)));
		const settled = await settlePendingPush(store, listing.revision, (base, head) =>
			this.asked(() => backend.checkBase(base, head)),
		);
		if (settled !== null) {
			if (settled.untrack) {
				this.recoveredUntrack = settled.counts.deleted;
			} else {
				this.recovered = settled.counts;
				// The push that had not got to its end, as far as this
				// device knew, has. As in a pull (`PullRun`).
				await clearPushFailure(store);
			}
		}

		const head = listing.revision;
		if (head === null) return this.refused("remote-empty");
		// The listing is the head's, and the rules of this device are only
		// the remote's once a pull has got to the end of that head.
		if ((await readBaseRevision(store)) !== head) return this.refused("pull-unfinished");
		if (this.aborted()) return this.result("cancelled");

		// What a pull that stopped was writing may be half a file, and so
		// may what Sync Evo itself was writing; and on disk the file may be
		// behind what an editor holds. As for a push.
		for (const marker of await store.readMarkers()) {
			const original = marker.conflictCopy ? originalPathOfConflictCopy(marker.path) : null;
			if (foldedKey(marker.path) === ROOT_GITIGNORE || (original !== null && foldedKey(original) === ROOT_GITIGNORE)) {
				return this.refused("gitignore-unsettled");
			}
		}
		if (!(await settleGitignoreWrite({ store, vault })) || !(await saved(vault, ROOT_GITIGNORE))) {
			return this.refused("gitignore-unsettled");
		}
		const gitignore = await readRootGitignore(vault, this.sizeLimit);
		if (gitignore.kind === "unreadable") return this.refused("gitignore-unreadable");
		if (gitignore.kind === "absent") return this.refused("no-section");
		// Without a section the lines of the default one are applied as if
		// they were in the file (`effectiveRules`): rules the remote does
		// not hold. A broken one applies the file alone, but which of its
		// lines the user means is not known until it is put right.
		const section = findSection(gitignore.text).kind;
		if (section !== "found") return this.refused(section === "none" ? "no-section" : "section-broken");
		// The remote's file is this one, byte for byte: one entry of that
		// very name, and a file.
		const named = listing.entries.filter((entry) => foldedKey(entry.path) === ROOT_GITIGNORE);
		const [remote] = named;
		if (
			named.length !== 1 ||
			remote === undefined ||
			remote.path !== ROOT_GITIGNORE ||
			remote.kind !== "file" ||
			remote.hash !== (await backend.hashContent(gitignore.content))
		) {
			return this.refused("gitignore-not-sent");
		}

		const deletes = this.targets(listing.entries, gitignore.text);
		if (deletes.length === 0) return this.result("nothing-to-untrack");
		if (this.aborted()) return this.result("cancelled");

		const pendingOf = (revision: string): PendingPushState => ({
			revision,
			parent: head,
			records: [],
			deleted: [...new Set(deletes.map((entry) => pathKey(entry.path)))],
			counts: { added: 0, modified: 0, deleted: deletes.length },
			untrack: true,
		});
		const pushed = await backend.push({
			baseRevision: head,
			writes: [],
			deletes,
			deviceName: deps.deviceName,
			untrack: true,
			beforePublish: async ({ revision }) => {
				await rememberPendingPush(store, pendingOf(revision));
				this.remembered = true;
			},
			onPublish: () => {
				this.publishing = true;
			},
		});
		if (pushed.status === "stale") {
			// A plain "no": the commit that was made is not in the branch.
			if (this.remembered) await forgetPendingPush(store);
			return this.result("remote-moved");
		}
		if (pushed.status === "unchanged") {
			// No remote answers so to deletes of what it holds. No commit
			// was made, whatever was remembered.
			if (this.remembered) await forgetPendingPush(store);
			return this.result("nothing-to-untrack");
		}
		const { revision } = pushed;
		if (revision === null) throw new Error("The remote answered a push without a revision.");

		// From here on it has happened, and is recorded whatever the signal
		// says. Stopped in between, the next push or pull does it. The
		// listing is the remote's own for the new commit, or none at all.
		const stored = pushed.listing ?? null;
		await finishPush(store, pendingOf(revision), stored);
		if (stored === null) deps.log?.("untrack: the tree of the new commit could not be fetched; the next sync lists the remote again");
		return this.result("untracked", { revision, untracked: deletes.map((entry) => entry.path).sort() });
	}

	/**
	 * The entries to delete: of what can be untracked now, by the rules of
	 * the file as it is, the ones that were shown. Compared by the NFC key,
	 * so that a path the remote spells in the other normalization since is
	 * still the one that was shown. Where the remote holds more than one
	 * path of a key, only a spelling that was shown itself counts: the
	 * other is a file the user has not seen.
	 */
	private targets(entries: readonly RemoteEntry[], gitignore: string): RemoteEntry[] {
		const spelled = new Set(this.shown);
		const keys = new Set(this.shown.map((path) => pathKey(path)));
		const perKey = new Map<string, number>();
		for (const entry of entries) {
			const key = pathKey(entry.path);
			perKey.set(key, (perKey.get(key) ?? 0) + 1);
		}
		const exclusion = createExclusion({ ...this.deps.paths, gitignore });
		return untrackableFiles(exclusion, entries)
			.files.map((file) => file.entry)
			.filter((entry) => {
				const key = pathKey(entry.path);
				return keys.has(key) && ((perKey.get(key) ?? 0) === 1 || spelled.has(entry.path));
			});
	}
}

// ---------------------------------------------------------------------------
// With the sync that comes first

/**
 * - "pull-declined", "pull-cancelled": the pull ended on a "no" or a stop.
 * - "push-not-done": the rules were not on the remote, and the push that
 *   would have sent them ended otherwise than by sending, or by finding
 *   nothing to send (`UntrackSyncResult.push`).
 * - "cancelled": stopped between the steps.
 */
export type UntrackSkip = "pull-declined" | "pull-cancelled" | "push-not-done" | "cancelled";

export type UntrackStep = "pull" | "push" | "untrack";

export interface UntrackSyncDeps {
	readonly pull: PullDeps;
	/** `hold` is filled in from the pull. */
	readonly push: Omit<PushDeps, "hold">;
	readonly untrack: UntrackDeps;
	/** The paths the confirmation listed (`runUntrack`). */
	readonly shown: readonly string[];
	/**
	 * Called when each step begins: the pull, the untracking (twice where
	 * a push is made in between), and the push. For a line of progress, and
	 * for telling which of them it was that rejected.
	 */
	readonly onStep?: (step: UntrackStep) => void;
	/** Called with what the pull answered, before anything else begins. */
	readonly onPulled?: (result: PullResult) => void;
	/** Called with what the push answered, when one was made, before the untracking begins. */
	readonly onPushed?: (result: PushRunResult) => void;
}

export interface UntrackSyncResult {
	readonly pull: PullResult;
	/** `null` when no push was made. */
	readonly push: PushRunResult | null;
	/** `null` when the untracking was not got to (`skipped`). */
	readonly untrack: UntrackRunResult | null;
	/** Why the untracking was not got to. Set exactly when `untrack` is `null`. */
	readonly skipped?: UntrackSkip;
}

/**
 * Untracks after the sync it needs: a pull, and then, only where the rules
 * of this device are not on the remote yet, a push. Rules that came from
 * another device are there already, and are untracked by without a scan of
 * the vault or a question of a push. No push is made either where one would
 * not put the rules there (`pushCanSettle`): the untracking is answered as
 * refused, with the reason, and nothing of the vault is sent for it.
 *
 * Whether the push follows the pull, and what it keeps away from, is as in
 * a sync (`pushFollows`, `pathsToHold`). It is a push like any other: it
 * sends what the vault has changed, asks what a push asks, and adds the
 * section to a `.gitignore` that has none.
 *
 * Nothing is untracked after a pull that was declined or stopped, or after
 * a push that neither sent nor found nothing to send. The rules stay, and
 * the files can be untracked later.
 *
 * Rejects as the pull, the push, or the untracking does. A pull that rejects
 * is followed by nothing; unlike in a sync, no push is noted as not made
 * (`push-failure.ts`): none was asked for.
 */
export async function runUntrackSync(deps: UntrackSyncDeps): Promise<UntrackSyncResult> {
	const stopped = (): boolean =>
		deps.pull.signal?.aborted === true || deps.push.signal?.aborted === true || deps.untrack.signal?.aborted === true;

	deps.onStep?.("pull");
	const pull = await runPull(deps.pull);
	deps.onPulled?.(pull);
	if (!pushFollows(pull)) {
		// A question left for later is one nobody said yes to, like a "no".
		const skipped = pull.outcome === "cancelled" ? "pull-cancelled" : "pull-declined";
		return { pull, push: null, untrack: null, skipped };
	}
	if (stopped()) return { pull, push: null, untrack: null, skipped: "cancelled" };

	deps.onStep?.("untrack");
	const first = await runUntrack(deps.untrack, deps.shown);
	if (first.outcome !== "sync-first" || !pushCanSettle(first.reason)) return { pull, push: null, untrack: first };
	if (stopped()) return { pull, push: null, untrack: null, skipped: "cancelled" };

	deps.onStep?.("push");
	const push = await runPush({ ...deps.push, hold: pathsToHold(pull) });
	deps.onPushed?.(push);
	if (push.outcome !== "pushed" && push.outcome !== "nothing-to-push") {
		return { pull, push, untrack: null, skipped: "push-not-done" };
	}
	if (stopped()) return { pull, push, untrack: null, skipped: "cancelled" };
	deps.onStep?.("untrack");
	return { pull, push, untrack: await runUntrack(deps.untrack, deps.shown) };
}
