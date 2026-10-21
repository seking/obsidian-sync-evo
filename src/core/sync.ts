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

// A sync: a pull, and then a push. The two are whole runs of their own;
// this only says whether the second follows the first, and what it is told
// of it.

import { BackendError } from "./backend";
import type { VaultIndex } from "./light-scan";
import { type PullDeps, type PullResult, runPull } from "./pull";
import { type PushDeps, type PushRunResult, runPush } from "./push";
import { markPushFailure } from "./push-failure";

/**
 * Whether a push follows a pull that ended like this.
 *
 * Not after a "no" or a stop: the user ended the sync. And a pull that
 * declines what the remote deleted leaves records the push must not act on
 * as if the vault had deleted those files. A pull that waits for its
 * question to be answered has left the same, and is followed by none either.
 *
 * After a pull that put files off, it does: the push is planned from the
 * remote as it is now, sends only what the remote has not changed, and is
 * told to keep away from the files that were put off (`pathsToHold`). A
 * device with one file that cannot be written would otherwise never send
 * anything.
 *
 * After a pull that found a remote without commits, it does: the push
 * gives the remote its first commit.
 *
 * The section Sync Evo keeps in the root `.gitignore` is added by the push
 * (`addSection` in `push.ts`), and so only where one follows: between the
 * pull and what the push sends, on top of the file the pull left. No step of
 * its own does it here. Whether the file is the one to build on is not told
 * by how the pull ended but by the file: after a pull that put it off, the
 * push leaves it alone (`pathsToHold`) and sends nothing; after one that
 * put other files off, or found a remote without commits, the file is as
 * the remote has it, and gets the section.
 */
export function pushFollows(pull: PullResult): boolean {
	switch (pull.outcome) {
		case "completed":
		case "incomplete":
		case "remote-empty":
			return true;
		case "declined":
		case "cancelled":
		case "waiting":
			return false;
	}
}

/** The vault paths the push after this pull leaves alone (`PushDeps.hold`). */
export function pathsToHold(pull: PullResult): string[] {
	return pull.deferred.map((file) => file.path);
}

/**
 * Those of `pathsToHold` the push tells nothing of (`PushDeps.holdQuietly`):
 * what the pull left alone because it is being typed in.
 */
export function pathsToHoldQuietly(pull: PullResult): string[] {
	return pull.deferred.filter((file) => file.reason === "being-edited").map((file) => file.path);
}

export interface SyncDeps {
	readonly pull: PullDeps;
	/** `hold` and `holdQuietly` are filled in from the pull. */
	readonly push: Omit<PushDeps, "hold" | "holdQuietly">;
	/**
	 * Whether the sync started by itself. Nobody asked for its push, so one
	 * that never began, because the pull failed, is not told again when the
	 * app starts: a device without a network would be told every time.
	 */
	readonly automatic?: boolean;
	/** Called with what the pull answered, before the push begins. */
	readonly onPulled?: (result: PullResult) => void;
	/**
	 * The app's index of the vault, for the push after a pull that walked
	 * it (`PullResult.walked`): that push makes the light check
	 * (`PushDeps.index`) and does not walk the vault again. What another app
	 * makes in the vault between the two, and the app's index does not hold
	 * yet, is found by the next check that walks it.
	 */
	readonly indexAfterWalk?: VaultIndex;
}

export interface SyncResult {
	readonly pull: PullResult;
	/** `null` when no push followed. */
	readonly push: PushRunResult | null;
}

/** Pulls, then pushes. Rejects as the pull or the push does; a pull that rejects is followed by no push. */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
	let pull: PullResult;
	try {
		pull = await runPull(deps.pull);
	} catch (error) {
		// The user asked for a push too, and none was made. Not when the
		// sync was stopped: that is the user's, and no failure.
		if (deps.automatic !== true && !(error instanceof BackendError && error.kind === "cancelled")) await unsent(deps);
		throw error;
	}
	deps.onPulled?.(pull);
	if (!pushFollows(pull) || deps.push.signal?.aborted === true) return { pull, push: null };
	const index = deps.push.index ?? (pull.walked === true ? deps.indexAfterWalk : undefined);
	const push = await runPush({
		...deps.push,
		...(index === undefined ? {} : { index }),
		hold: pathsToHold(pull),
		holdQuietly: pathsToHoldQuietly(pull),
	});
	return { pull, push };
}

// The push of a sync that never began is told again like one that failed
// (`push-failure.ts`). What fails here must not take the place of how the
// pull ended.
async function unsent(deps: SyncDeps): Promise<void> {
	try {
		await markPushFailure(deps.push.store, deps.push.now());
	} catch {
		// The end of the pull is the one to tell.
	}
}
