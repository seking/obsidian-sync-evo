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

// Tidying the folder of the conflict copies: a copy that was made 30 days
// ago or more is moved to the `.trash/` of the vault, by a sync, after its
// pull and before its push. A copy is something to look at once, and a
// conflict that is handled a second time leaves one more of them; without
// this the folder would only ever grow.
//
// Only a file that is told to be a copy by where it is and by the start of
// its name is touched (`isCopyInConflictFolder`), and its age is read from
// that name (`timeOfConflictCopy`, to within the offset of a time zone):
// the time of the file is the time this device got it. Anything
// else in the folder is the user's, and so is a copy that was renamed or
// moved out of it, which is how one is kept. A copy of the earlier form,
// beside its file, is never tidied.
//
// A copy that is moved away is a file the vault deleted: the push after it
// deletes it on the remote, and the other devices follow. What was moved is
// remembered, so that the push does not count it among the deletions it
// asks about (`TIDIED_COPIES_KEY`).

import { isConflictFolder, timeOfConflictCopy } from "./conflict-name";
import type { VaultIndex } from "./light-scan";
import { foldedKey, pathKey } from "./paths";
import type { PullVault } from "./pull-io";
import { fromRoot } from "./scan";
import { copiedPathOf, type StateStore } from "./state";

/** How long a conflict copy is kept from the time in its name, in milliseconds: 30 days of 24 hours. Not a setting. */
export const COPY_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The key, among the other values of the sync state, of the copies that were
 * tidied and whose deletion no push has sent yet: their paths, as they were
 * spelled. A value that may be lost (`STATE_DB_VERSION`): without it the
 * push counts them like any other deletion, and asks when they are many.
 */
export const TIDIED_COPIES_KEY = "tidied-copies";

export interface TidyDeps {
	readonly store: Pick<StateStore, "getMeta" | "setMeta" | "readMarkers">;
	readonly vault: Pick<PullVault, "list" | "trash" | "saveOpenEditors">;
	/** Milliseconds since the epoch. */
	readonly now: () => number;
	/**
	 * `PullDeps.index`: set for the light check. The copies are then taken
	 * from the app's index, and no folder is listed. A copy the index has
	 * not found yet waits for a sync that lists.
	 */
	readonly index?: VaultIndex;
	/** Whether a path is left where it is this time: the pull put it off, did not look at it, or has just fetched it. */
	readonly leaveAlone?: (path: string) => boolean;
	/** `PullDeps.beingEdited`: set for a sync that started by itself, which does nothing to a file that is typed in. */
	readonly beingEdited?: (path: string) => boolean;
	/** Stops it between two files. */
	readonly signal?: AbortSignal;
	/** `PullDeps.log`. */
	readonly log?: (message: string) => void;
}

/**
 * Whether a copy has had its time: the time in its name is 30 days or more
 * before `now`. Never a path that is no copy in the folder of the copies, a
 * name whose digits are no date and time, or a time that is yet to come.
 */
export function isCopyDue(path: string, now: number): boolean {
	const made = timeOfConflictCopy(path);
	return made !== null && now - made >= COPY_KEPT_MS;
}

/**
 * Moves every conflict copy that has had its time to the `.trash/` of the
 * vault, whatever the app's setting for deleted files, and answers the ones
 * it moved, as they were spelled. Two folders are listed for it, the root
 * and the folder of the copies, and none where the app's index is given;
 * the vault is not walked.
 *
 * Left where it is, for the next sync:
 *
 * - a copy that has a write marker, or is the file a marked copy is of: a
 *   pull that stopped was in the middle of it;
 * - a copy `leaveAlone` answers for;
 * - a copy that is being typed in, in a sync that started by itself;
 * - a copy an editor has open and cannot save.
 *
 * An editor that has a copy open saves first, so that what was typed goes to
 * the `.trash/` with the file. That the copy is open, or was edited, is
 * otherwise no reason to keep it.
 *
 * What the vault refuses does not fail the sync: a folder that cannot be
 * listed is not tidied this time, and a file that cannot be moved stays. A
 * failure of the sync state is thrown.
 */
export async function tidyConflictCopies(deps: TidyDeps): Promise<string[]> {
	const { store, vault } = deps;
	const now = deps.now();
	const due = (await copiesIn(deps)).filter((path) => isCopyDue(path, now));
	if (due.length === 0) return [];

	const marked = new Set<string>();
	for (const marker of await store.readMarkers()) {
		marked.add(foldedKey(marker.path));
		const original = copiedPathOf(marker);
		if (original !== null) marked.add(foldedKey(original));
	}
	const taken = due.filter(
		(path) => !marked.has(foldedKey(path)) && deps.leaveAlone?.(path) !== true && deps.beingEdited?.(path) !== true,
	);
	if (taken.length === 0) return [];

	// Remembered before the first is moved: killed in between, the push
	// would count the ones that are gone. One that then stays after all is
	// forgotten by the push, which finds its file (`forgetTidiedCopies`).
	await rememberTidiedCopies(store, taken);

	const tidied: string[] = [];
	for (const path of taken) {
		if (deps.signal?.aborted === true) break;
		// Asked again: the typing can have begun since the list was made.
		if (deps.beingEdited?.(path) === true) continue;
		try {
			if ((await vault.saveOpenEditors(path)) === "failed") continue;
			await vault.trash(path, "vault-trash");
		} catch {
			continue;
		}
		tidied.push(path);
	}
	return tidied;
}

// The files in the folder of the copies, as they are spelled.
async function copiesIn(deps: TidyDeps): Promise<string[]> {
	if (deps.index !== undefined) return deps.index.indexedFiles().map((file) => fromRoot(file.path));
	const files: string[] = [];
	try {
		// A vault can spell the folder in its own way, and one that tells
		// the cases apart can have two of them.
		for (const folder of (await deps.vault.list("/")).folders.map(fromRoot).filter(isConflictFolder)) {
			for (const file of (await deps.vault.list(folder)).files) {
				// Only the last part of what comes back is read: a lister
				// builds the rest from the folder it was asked for.
				files.push(`${folder}/${file.slice(file.lastIndexOf("/") + 1)}`);
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		deps.log?.(`conflict copies: the folder could not be listed (${detail})`);
		return [];
	}
	return files;
}

/**
 * The copies that were tidied and are not known to be gone from the remote,
 * as they were spelled. Empty for anything that cannot be read.
 */
export async function readTidiedCopies(store: Pick<StateStore, "getMeta">): Promise<string[]> {
	const value = await store.getMeta(TIDIED_COPIES_KEY);
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function rememberTidiedCopies(
	store: Pick<StateStore, "getMeta" | "setMeta">,
	paths: readonly string[],
): Promise<void> {
	const remembered = await readTidiedCopies(store);
	const keys = new Set(remembered.map(pathKey));
	const added = paths.filter((path) => !keys.has(pathKey(path)));
	if (added.length > 0) await store.setMeta(TIDIED_COPIES_KEY, [...remembered, ...added]);
}

/**
 * Forgets the tidied copies `isStillDeletion` does not answer for: the ones
 * whose deletion has been sent, and the ones that are no deletion any more
 * (the remote does not hold the path, or the vault has a file there again).
 * Nothing is written when none is forgotten.
 */
export async function forgetTidiedCopies(
	store: Pick<StateStore, "getMeta" | "setMeta" | "deleteMeta">,
	isStillDeletion: (path: string) => boolean,
): Promise<void> {
	const remembered = await readTidiedCopies(store);
	const kept = remembered.filter(isStillDeletion);
	if (kept.length === remembered.length) return;
	if (kept.length > 0) await store.setMeta(TIDIED_COPIES_KEY, kept);
	else await store.deleteMeta(TIDIED_COPIES_KEY);
}
