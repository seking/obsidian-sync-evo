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

// The contents a push has sent to the remote as blobs, remembered across
// pushes, so that a push that was stopped half way does not send them
// again. A push of many files that go one request each (images, PDFs, files
// over 1 MB) is otherwise begun from its first file every time the app is
// put in the back under it.
//
// Only the hash of the content and when it was sent are kept. A blob is
// addressed by its content alone: it serves whatever the head of the remote
// is by then, and whatever else the next push sends with it. The trees and
// the commit are made again every time, which is a few requests.
//
// Nothing here is needed for a push to be right. A blob that is remembered
// and is gone from the remote is found out when the tree that names it is
// refused, and is sent again (`GitHubBackend.push`); a memory that is lost
// costs the requests it would have saved.
//
// Kept as one value among the others of the sync state, written as a whole.
// So it is written now and then, and not for every blob: `add` saves after
// every `SAVE_EVERY_BLOBS` or `SAVE_EVERY_MS`, and the push and the app save
// at the moments after which nothing more may run (`save`).

import type { SentBlobs } from "./backend";
import type { StateStore } from "./state";

/** The key, among the other values of the sync state, of the blobs that were sent. */
export const SENT_BLOBS_KEY = "sent-blobs";

/**
 * How long a blob that was sent is taken to be on the remote. GitHub removes
 * a blob that no commit leads to, some time after it was made; how long
 * after is not published. Short of what is thought likely, and a guess all
 * the same: what it gets wrong is caught when the tree is refused.
 */
export const SENT_BLOB_MS = 7 * 24 * 60 * 60 * 1000;

/** `add` saves once this many blobs were added since the last save. */
export const SAVE_EVERY_BLOBS = 20;

/** `add` saves once this long has passed since the last save. */
export const SAVE_EVERY_MS = 5000;

// A time this far ahead of the clock is one of a clock that was since set
// back, and tells nothing of the age of the blob.
const AHEAD_MS = 24 * 60 * 60 * 1000;

type SentBlobStore = Pick<StateStore, "getMeta" | "setMeta">;

/** Forgets every blob that was sent. For where a push is recorded as having gone through (`finishPush`). */
export function forgetSentBlobs(store: Pick<StateStore, "deleteMeta">): Promise<void> {
	return store.deleteMeta(SENT_BLOBS_KEY);
}

/** What is stored under `SENT_BLOBS_KEY`: when each content was sent, by its hash. Anything else reads as nothing. */
function storedBlobs(value: unknown, now: number): Map<string, number> {
	const blobs = new Map<string, number>();
	if (typeof value !== "object" || value === null || Array.isArray(value)) return blobs;
	for (const [hash, at] of Object.entries(value)) {
		if (typeof at !== "number" || !Number.isFinite(at)) continue;
		if (now - at > SENT_BLOB_MS || at - now > AHEAD_MS) continue;
		blobs.set(hash, at);
	}
	return blobs;
}

/**
 * The blobs that were sent, for one sync. Made before the push and handed
 * to it (`PushDeps.sentBlobs`); nothing is read from the store until the
 * push calls `load`.
 */
export class SentBlobMemory implements SentBlobs {
	private blobs = new Map<string, number>();
	private loaded = false;
	/** Whether the store holds something other than `blobs`. */
	private dirty = false;
	private unsaved = 0;
	private savedAt: number;
	/** The save that runs, and those waiting behind it. */
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: SentBlobStore,
		private readonly now: () => number,
		private readonly log?: (line: string) => void,
	) {
		this.savedAt = now();
	}

	/**
	 * Reads what the store holds, without what is too old to count on.
	 * Called by a push right before it sends, and by no one before: a push
	 * that is found to have gone through on the way there forgets the
	 * stored blobs (`finishPush`), and must not find them here again.
	 */
	async load(): Promise<void> {
		const now = this.now();
		this.blobs = storedBlobs(await this.store.getMeta(SENT_BLOBS_KEY), now);
		this.loaded = true;
		this.dirty = false;
		this.unsaved = 0;
		this.savedAt = now;
	}

	has(hash: string): boolean {
		return this.blobs.has(hash);
	}

	add(hash: string): void {
		if (!this.loaded) return;
		const now = this.now();
		this.blobs.set(hash, now);
		this.dirty = true;
		this.unsaved++;
		if (this.unsaved >= SAVE_EVERY_BLOBS || now - this.savedAt >= SAVE_EVERY_MS) void this.save();
	}

	/**
	 * Every remembered blob is taken to be gone from the remote. In the
	 * store too, by the save that follows.
	 */
	forget(): void {
		if (!this.loaded || this.blobs.size === 0) return;
		this.blobs.clear();
		this.dirty = true;
	}

	/**
	 * The push has gone through and the stored blobs were forgotten with
	 * it (`finishPush`): nothing is left to save, also for a save that is
	 * asked for later in the same sync.
	 */
	settled(): void {
		this.blobs.clear();
		this.dirty = false;
		this.unsaved = 0;
	}

	/**
	 * Writes what was added since the last save. Never rejects: a memory
	 * that could not be written costs requests, and is no failure of the
	 * push. May be called at any time, and not awaited, also while a save
	 * runs.
	 */
	save(): Promise<void> {
		this.saving = this.saving.then(async () => {
			if (!this.loaded || !this.dirty) return;
			this.dirty = false;
			this.unsaved = 0;
			this.savedAt = this.now();
			try {
				await this.store.setMeta(SENT_BLOBS_KEY, Object.fromEntries(this.blobs));
			} catch (error) {
				this.dirty = true;
				this.log?.(`push: the sent blobs could not be remembered: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		return this.saving;
	}
}
