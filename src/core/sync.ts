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

// A sync: a pull, and then a push. The two are whole runs of their own;
// this only says whether the second follows the first, and what it is told
// of it.

import { type PullDeps, type PullResult, runPull } from "./pull";
import { type PushDeps, type PushRunResult, runPush } from "./push";

/**
 * Whether a push follows a pull that ended like this.
 *
 * Not after a "no" or a stop: the user ended the sync. And a pull that
 * declines what the remote deleted leaves records the push must not act on
 * as if the vault had deleted those files.
 *
 * After a pull that put files off, it does: the push is planned from the
 * remote as it is now, sends only what the remote has not changed, and is
 * told to keep away from the files that were put off (`pathsToHold`). A
 * device with one file that cannot be written would otherwise never send
 * anything.
 *
 * Not to a remote without commits: nothing can be built on it yet.
 */
export function pushFollows(pull: PullResult): boolean {
	switch (pull.outcome) {
		case "completed":
		case "incomplete":
			return true;
		case "remote-empty":
		case "declined":
		case "cancelled":
			return false;
	}
}

/** The vault paths the push after this pull leaves alone (`PushDeps.hold`). */
export function pathsToHold(pull: PullResult): string[] {
	return pull.deferred.map((file) => file.path);
}

export interface SyncDeps {
	readonly pull: PullDeps;
	/** `hold` is filled in from the pull. */
	readonly push: Omit<PushDeps, "hold">;
	/** Called with what the pull answered, before the push begins. */
	readonly onPulled?: (result: PullResult) => void;
}

export interface SyncResult {
	readonly pull: PullResult;
	/** `null` when no push followed. */
	readonly push: PushRunResult | null;
}

/** Pulls, then pushes. Rejects as the pull or the push does; a pull that rejects is followed by no push. */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
	const pull = await runPull(deps.pull);
	deps.onPulled?.(pull);
	if (!pushFollows(pull) || deps.push.signal?.aborted === true) return { pull, push: null };
	const push = await runPush({ ...deps.push, hold: pathsToHold(pull) });
	return { pull, push };
}
