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

// A push between its last two steps. The commit of a push is made, and then
// the branch is moved to it; whether that second step took effect is not
// always known to the device that asked for it (the answer never arrives,
// the app is stopped). So what the push would record is stored before the
// branch is moved, and whoever looks at the remote next (a push or a pull)
// compares its head with the commit that was made: the same, or a commit
// built on it, and the push has happened and is recorded now; anything
// else, and it has not.

import type { Backend, RemoteListing } from "./backend";
import { pathKey } from "./paths";
import {
	plainRecord,
	readBaseRevision,
	type StateStore,
	type StoredRecord,
	writeBaseRevision,
} from "./state";

/** The key, among the other values of the sync state, of a push that may or may not have happened. */
export const PENDING_PUSH_KEY = "pending-push";

/**
 * The key of the answer "yes" to the question before the first push of a
 * sync state, set once a push has gone through. It goes with the sync state
 * when that is discarded.
 */
export const FIRST_PUSH_CONFIRMED_KEY = "first-push-confirmed";

/**
 * The key of the hashes of the files over `LARGE_FILE_BYTES` the user has
 * said "send" to (`push.ts`). The same content is not asked about again. It
 * goes with the sync state when that is discarded.
 */
export const APPROVED_LARGE_FILES_KEY = "approved-large-files";

/** What a push changed on the remote, as the commit names it. */
export interface PushCounts {
	readonly added: number;
	readonly modified: number;
	readonly deleted: number;
}

/** The value under `PENDING_PUSH_KEY`. */
export interface PendingPushState {
	/** The commit that was made. */
	readonly revision: string;
	/** The revision it was made on. */
	readonly parent: string;
	/** The records of the files it holds as they were sent. */
	readonly records: readonly StoredRecord[];
	/** The keys of the records of the files it deleted. */
	readonly deleted: readonly string[];
	readonly counts: PushCounts;
}

export function rememberPendingPush(store: Pick<StateStore, "setMeta">, pending: PendingPushState): Promise<void> {
	return store.setMeta(PENDING_PUSH_KEY, {
		revision: pending.revision,
		parent: pending.parent,
		records: pending.records.map(plainRecord),
		deleted: [...pending.deleted],
		counts: { ...pending.counts },
	});
}

export function forgetPendingPush(store: Pick<StateStore, "deleteMeta">): Promise<void> {
	return store.deleteMeta(PENDING_PUSH_KEY);
}

/** `null` for nothing, and for anything that is not whole: a push that cannot be recorded in full is not recorded. */
export async function readPendingPush(store: Pick<StateStore, "getMeta">): Promise<PendingPushState | null> {
	const value = await store.getMeta(PENDING_PUSH_KEY);
	if (typeof value !== "object" || value === null) return null;
	const { revision, parent, records, deleted, counts } = value as Record<string, unknown>;
	if (typeof revision !== "string" || typeof parent !== "string") return null;
	if (!Array.isArray(records) || !Array.isArray(deleted) || !deleted.every((key) => typeof key === "string")) {
		return null;
	}
	const read: StoredRecord[] = [];
	for (const item of records as unknown[]) {
		if (typeof item !== "object" || item === null) return null;
		const { path, kind, hash, mtime, size } = item as Record<string, unknown>;
		if (typeof path !== "string" || kind !== "file" || typeof hash !== "string") return null;
		const base = { key: pathKey(path), path, kind, hash } as const;
		read.push(typeof mtime === "number" && typeof size === "number" ? { ...base, mtime, size } : base);
	}
	const { added, modified, deleted: removed } = (typeof counts === "object" && counts !== null ? counts : {}) as Record<
		string,
		unknown
	>;
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	return {
		revision,
		parent,
		records: read,
		deleted: deleted as string[],
		counts: { added: count(added), modified: count(modified), deleted: count(removed) },
	};
}

/**
 * Records a push that has happened: the branch points at its commit. In
 * this order, each step of which can be made again after a stop:
 *
 * 1. the records of the files that were sent;
 * 2. the records of the files that were deleted, removed;
 * 3. the listing of the new head as the remote gave it, when it is handed
 *    in; with `null`, the stored one is cleared, and the next sync lists
 *    again. A listing is never worked out from what was sent: the remote
 *    is the one to say what it holds. Left as it is (`undefined`) when the
 *    caller has listed the head already;
 * 4. the base revision, when it was the parent of the commit. A device
 *    whose base revision is further back has a pull to finish first, which
 *    is what moves it: a history that was rewritten is told by the base
 *    revision, and must not read as continuous because of a push;
 * 5. that a push has gone through, and last, the push itself forgotten.
 *
 * A pull right after finds nothing to do.
 */
export async function finishPush(
	store: StateStore,
	pending: PendingPushState,
	listing?: RemoteListing | null,
): Promise<void> {
	for (const record of pending.records) await store.commitWrite(record);
	for (const key of pending.deleted) await store.deleteRecord(key);
	if (listing === null) await store.clearListing();
	else if (listing !== undefined) await store.putListing(listing);
	if ((await readBaseRevision(store)) === pending.parent) await writeBaseRevision(store, pending.revision);
	await store.setMeta(FIRST_PUSH_CONFIRMED_KEY, true);
	await forgetPendingPush(store);
}

/**
 * Looks at a push that was left between its last two steps, now that the
 * head of the remote is known. Called by a push and by a pull once they
 * have the listing of the head, which is the stored one by then (and the
 * remote's own), and before anything is decided from the records.
 *
 * - The head is the commit of that push: it went through.
 * - The head is another commit that is built on it (`checkBase`, asked only
 *   then): it went through, and another device has pushed since. Told
 *   apart from the next case because the records decide what a pull makes
 *   of a file this device sent and the other device then edited: with the
 *   record of what was sent it is an ordinary fetch, and without it a
 *   conflict that never was, whose copy would be sent in turn.
 * - Any other head, or none: it did not go through, or the history was
 *   rewritten. It is forgotten.
 *
 * A push that went through is recorded, and what it changed is answered,
 * for the user to be told. Only the files of that push are recorded; what
 * the other device changed on top is the plan's to find, from the listing
 * of the head.
 *
 * Rejects when the remote could not say whether the head is built on the
 * commit. The push stays remembered then, and the sync that asked ends
 * there: going on with the old records is what makes the false conflict.
 */
export async function settlePendingPush(
	store: StateStore,
	head: string | null,
	checkBase: Backend["checkBase"],
): Promise<PushCounts | null> {
	const pending = await readPendingPush(store);
	if (pending === null) {
		// What could not be read.
		if ((await store.getMeta(PENDING_PUSH_KEY)) !== undefined) await forgetPendingPush(store);
		return null;
	}
	if (head !== pending.revision) {
		// "rewritten" is also the answer for a commit the remote does not know.
		if (head === null || (await checkBase(pending.revision, head)) !== "continues") {
			await forgetPendingPush(store);
			return null;
		}
	}
	await finishPush(store, pending);
	return pending.counts;
}
