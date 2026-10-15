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
// does. A tidying up, and nothing more: no device of Sync Evo syncs those
// files anyway, and none deletes its own when the remote does, since a rule
// cuts a path off from the remote both ways (`exclusion.ts`). What it
// changes is that git on a computer stops sending them, and deletes them
// from its working tree at its next pull.
//
// One commit, apart from any push of the vault's changes: the deletions, and
// the root `.gitignore` of this device where the remote does not hold that
// one yet. Nothing else in the vault is read for it. The rules go in the
// same commit as the deletions: a deletion that reached another device
// without them would be one of a file that is not excluded there, and that
// device would delete its own. A pull takes in the deletions by the
// `.gitignore` the same pull brings (`pull.ts`), so the two arrive together.
// A download comes first (`runUntrackSync`), and the commit is only made
// where this device has pulled the head to its end (`runUntrack`, which
// looks for itself).
//
// The user is asked before any of this runs, with the list of the files
// (`untrack-report.ts`). What is deleted is never more than that list.
//
// The records of the files are taken away, and that of a `.gitignore` that
// was sent moved on, the way a push does it: remembered before the branch is
// moved (`push-pending.ts`), and settled by whoever looks at the remote next
// when this was stopped in between. The records are taken away right after
// the commit, and not left to the next sync, which would drop them too for a
// path a rule excludes (`SyncRecord.wasExcluded`): with no sync in between, a
// record that stayed would have a sync after the rule was taken away read
// "the remote deleted it", and delete the file on this device.

import { untilAborted } from "./archive-fetch";
import { type Backend, BackendError, type PushFile, type RemoteEntry } from "./backend";
import { createExclusion, type ExclusionPaths, untrackableFiles } from "./exclusion";
import { isGitignoreAsRecorded, readRootGitignore, ROOT_GITIGNORE, settleGitignoreWrite } from "./gitignore-file";
import { findSection } from "./gitignore-section";
import { saved } from "./local-read";
import { foldedKey, pathKey } from "./paths";
import { DEFAULT_SIZE_LIMIT } from "./plan";
import { type PullDeps, type PullResult, runPull } from "./pull";
import type { PushVault } from "./push";
import { clearPushFailure } from "./push-failure";
import {
	finishPush,
	forgetPendingPush,
	type PendingPushState,
	type PushCounts,
	rememberPendingPush,
	settlePendingPush,
} from "./push-pending";
import { copiedPathOf, currentListing, makeRecord, readBaseRevision, type StateStore } from "./state";
import { pushFollows } from "./sync";

export interface UntrackDeps {
	/** The sync state, opened. */
	readonly store: StateStore;
	readonly backend: Pick<Backend, "hashContent" | "list" | "checkBase" | "push">;
	/**
	 * Only the root `.gitignore` is read, and sent with the deletions where
	 * the remote does not hold it. Written only to finish a write of Sync
	 * Evo's own.
	 */
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
 *   The root `.gitignore` is on the remote as this device has it. On a
 *   remote that writes file by file, the ones another device changed first
 *   are left there (`UntrackRunResult.kept`).
 * - "nothing-to-untrack": none of the files that were shown is on the remote
 *   and matched by a rule any more. No commit was made.
 * - "sync-first": nothing was sent, and something has to be put right first
 *   (`UntrackRefusal`).
 * - "remote-moved": another device has pushed since the remote was listed.
 *   Nothing was changed. On a remote that writes file by file, also when
 *   another device changed every one of the files first.
 * - "cancelled": stopped through the signal before the branch was moved.
 *   Nothing shows on the remote.
 */
export type UntrackOutcome = "untracked" | "nothing-to-untrack" | "sync-first" | "remote-moved" | "cancelled";

/**
 * Why nothing was untracked.
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
 *   being in the file, and would not reach the remote with the deletions.
 *   The settings screen, or a sync that sends, adds the section.
 * - "section-broken": the file has markers that enclose no one section.
 *   What its lines are meant to say is the user's to put right first.
 * - "gitignore-differs": the remote's root `.gitignore` is not the one this
 *   device last synced (`isGitignoreAsRecorded`), and not this device's
 *   either: sent as it is, it would undo a change of another device that
 *   the pull did not take in. Also where the remote holds it as anything
 *   but one file of that very name.
 */
export type UntrackRefusal =
	| "remote-empty"
	| "pull-unfinished"
	| "gitignore-unsettled"
	| "gitignore-unreadable"
	| "no-section"
	| "section-broken"
	| "gitignore-differs";

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
	 * The files that were not taken out because another device changed them
	 * on the remote first, as the remote spelled them, sorted. Only on a
	 * remote that writes file by file (`PushResult.kept`).
	 */
	readonly kept?: readonly string[];
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
 * root `.gitignore` has a section in it (`UntrackRefusal`). Where that file
 * is not the remote's, it goes in the same commit, and its record is moved
 * on to what was sent. No other change of the vault is sent here, and the
 * note of a push that did not get to its end (`push-failure.ts`) is not
 * touched by this. It is taken away only where this finds that very push to
 * have gone through after all, as a pull does.
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
			const original = copiedPathOf(marker);
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
		// The rules the files were listed by go with them, where the remote
		// does not hold them yet. Only over the file this device last
		// synced: the remote's own, changed since, is not written over.
		const named = listing.entries.filter((entry) => foldedKey(entry.path) === ROOT_GITIGNORE);
		const [remote] = named;
		const hash = await backend.hashContent(gitignore.content);
		const unchanged = named.length === 1 && remote?.path === ROOT_GITIGNORE && remote.kind === "file" && remote.hash === hash;
		if (!unchanged && !isGitignoreAsRecorded(listing.entries, await store.readRecords())) {
			return this.refused("gitignore-differs");
		}
		const content = gitignore.content;
		const writes: PushFile[] = unchanged
			? []
			: [
					{
						path: ROOT_GITIGNORE,
						hash,
						size: content.length,
						...(remote === undefined ? {} : { replaces: remote }),
						read: () => Promise.resolve(content),
					},
				];

		const deletes = this.targets(listing.entries, gitignore.text);
		if (deletes.length === 0) return this.result("nothing-to-untrack");
		if (this.aborted()) return this.result("cancelled");

		// The record of the `.gitignore` is of what was sent, without the
		// time and the size of the file: the next sync hashes it once, and
		// finds it unchanged unless it was edited since.
		let sent: readonly RemoteEntry[] = [];
		// The deletes a remote that writes file by file would not make: the
		// file changed there since it was listed (`PushResult.kept`).
		let made = deletes;
		const pendingOf = (revision: string): PendingPushState => ({
			revision,
			parent: head,
			records: sent.map((entry) => makeRecord({ path: entry.path, kind: "file", hash: entry.hash }, undefined, 0)),
			deleted: [...new Set(made.map((entry) => pathKey(entry.path)))],
			counts: {
				added: sent.length > 0 && remote === undefined ? 1 : 0,
				modified: sent.length > 0 && remote !== undefined ? 1 : 0,
				deleted: made.length,
			},
			untrack: true,
		});
		const pushed = await backend.push({
			baseRevision: head,
			writes,
			deletes,
			deviceName: deps.deviceName,
			untrack: true,
			beforePublish: async ({ revision, written }) => {
				sent = written;
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
			// No commit was made, whatever was remembered.
			if (this.remembered) await forgetPendingPush(store);
			// A remote that writes file by file, where another device
			// changed every one of the files first.
			if ((pushed.kept ?? []).length > 0) return this.result("remote-moved");
			return this.result("nothing-to-untrack");
		}
		const { revision } = pushed;
		if (revision === null) throw new Error("The remote answered a push without a revision.");
		sent = pushed.written;
		const kept = new Set((pushed.kept ?? []).map((entry) => pathKey(entry.path)));
		made = deletes.filter((entry) => !kept.has(pathKey(entry.path)));

		// From here on it has happened, and is recorded whatever the signal
		// says. Stopped in between, the next push or pull does it. The
		// listing is the remote's own for the new commit, or none at all.
		const stored = pushed.listing ?? null;
		await finishPush(store, pendingOf(revision), stored);
		if (stored === null) deps.log?.("untrack: the tree of the new commit could not be fetched; the next sync lists the remote again");
		const left = deletes.filter((entry) => kept.has(pathKey(entry.path))).map((entry) => entry.path);
		return this.result("untracked", {
			revision,
			untracked: made.map((entry) => entry.path).sort(),
			...(left.length === 0 ? {} : { kept: left.sort() }),
		});
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
// With the download that comes first

/**
 * - "pull-declined", "pull-cancelled": the pull ended on a "no" or a stop.
 * - "cancelled": stopped between the steps.
 */
export type UntrackSkip = "pull-declined" | "pull-cancelled" | "cancelled";

export type UntrackStep = "pull" | "untrack";

export interface UntrackSyncDeps {
	readonly pull: PullDeps;
	readonly untrack: UntrackDeps;
	/** The paths the confirmation listed (`runUntrack`). */
	readonly shown: readonly string[];
	/**
	 * Called when each step begins: the pull, and the untracking. For a line
	 * of progress, and for telling which of them it was that rejected.
	 */
	readonly onStep?: (step: UntrackStep) => void;
	/** Called with what the pull answered, before anything else begins. */
	readonly onPulled?: (result: PullResult) => void;
}

export interface UntrackSyncResult {
	readonly pull: PullResult;
	/** `null` when the untracking was not got to (`skipped`). */
	readonly untrack: UntrackRunResult | null;
	/** Why the untracking was not got to. Set exactly when `untrack` is `null`. */
	readonly skipped?: UntrackSkip;
}

/**
 * Untracks after the download it needs: a pull, and then the one commit of
 * the untracking (`runUntrack`), which takes the rules of this device along
 * where the remote does not hold them. No push of the vault's changes is
 * made: nothing but the deletions and the `.gitignore` is sent for it.
 *
 * Nothing is untracked after a pull that was declined or stopped. The files
 * can be untracked later.
 *
 * Rejects as the pull or the untracking does. A pull that rejects is
 * followed by nothing; unlike in a sync, no push is noted as not made
 * (`push-failure.ts`): none was asked for.
 */
export async function runUntrackSync(deps: UntrackSyncDeps): Promise<UntrackSyncResult> {
	const stopped = (): boolean => deps.pull.signal?.aborted === true || deps.untrack.signal?.aborted === true;

	deps.onStep?.("pull");
	const pull = await runPull(deps.pull);
	deps.onPulled?.(pull);
	if (!pushFollows(pull)) {
		// A question left for later is one nobody said yes to, like a "no".
		const skipped = pull.outcome === "cancelled" ? "pull-cancelled" : "pull-declined";
		return { pull, untrack: null, skipped };
	}
	if (stopped()) return { pull, untrack: null, skipped: "cancelled" };

	deps.onStep?.("untrack");
	return { pull, untrack: await runUntrack(deps.untrack, deps.shown) };
}
