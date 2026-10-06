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

// The one way to the sync state of the vault, and the one place it is
// discarded from. Both are here so that the state of one connection can never
// be opened for another.

import type { App } from "obsidian";
import {
	discardStateDb,
	type IdbStateStore,
	openStateDb,
	readAppId,
	type StateDiscardResult,
	type StateOpenResult,
} from "./state-db";

/**
 * A note, kept outside the sync state, that the sync state must be discarded
 * before it is used again.
 *
 * The connection is saved at once and the database is removed some time
 * later, so the app can be stopped in between, and the removal can fail. The
 * note is what makes the next start finish the job. It cannot be kept in the
 * database: that is the very thing that may still be there when it should
 * not be. It is not part of the sync state either; it says nothing about any
 * file, only that what is stored is not to be believed.
 *
 * It is only for the time after a restart. The app's local storage does not
 * report a failed write (a full quota, for one), so `set` may do nothing and
 * `isSet` then answers no. While the app runs, `SyncState` goes by a flag of
 * its own and does not depend on the note having been stored.
 */
export interface DiscardNote {
	isSet(): boolean;
	set(): void;
	clear(): void;
}

// The app puts the id of the vault in front of the key, like for the settings.
const DISCARD_KEY = "sync-evo-discard-state";

/** The note in the app's local storage, next to the settings whose change it belongs to. */
export function discardNoteOf(app: App): DiscardNote {
	return {
		// Anything stored counts. Only `clear` takes it away.
		isSet: () => app.loadLocalStorage(DISCARD_KEY) != null,
		set: () => app.saveLocalStorage(DISCARD_KEY, true),
		clear: () => app.saveLocalStorage(DISCARD_KEY, null),
	};
}

export interface SyncStateDeps {
	/** The id of the vault, read each time, unchecked. */
	readonly appId: () => unknown;
	readonly note: DiscardNote;
	/** Read each time, so that nothing touches IndexedDB before it is needed. */
	readonly indexedDb: () => IDBFactory | undefined;
	/**
	 * Called when the removal of the state has to wait for a connection that
	 * is still open, in this window or another one of the same vault. The
	 * removal goes on by itself once that connection closes, and `open` waits
	 * with it, so this is the only sign of the wait there is.
	 *
	 * It can also be called for a short wait with no other window involved:
	 * a connection of this window closes only after the transactions it is in
	 * have finished. Whoever shows a message must not say that another window
	 * is the cause.
	 */
	readonly onDiscardBlocked?: () => void;
}

export function syncStateDepsOf(app: App): SyncStateDeps {
	return {
		appId: () => readAppId(app),
		note: discardNoteOf(app),
		indexedDb: () => (globalThis as { indexedDB?: IDBFactory }).indexedDB,
		// `onDiscardBlocked` is left out. Nothing in the plugin logs or shows
		// progress yet; the sync entry point (T023) is the caller that waits
		// on `open`, and passes it to show that wait.
	};
}

export class SyncState {
	private readonly deps: SyncStateDeps;
	// Discards and opens run one after the other, in the order they were
	// asked for. An open therefore never overtakes a discard asked for before
	// it, and nothing is written between a discard and the next one.
	private queue: Promise<unknown> = Promise.resolve();
	private current: IdbStateStore | null = null;
	// A discard was asked for in this session and has not succeeded yet. This,
	// not the note, is what the session goes by: the note may not have been
	// stored. Cleared only once the database is gone.
	private discardRequested = false;
	private noteRead = false;

	constructor(deps: SyncStateDeps) {
		this.deps = deps;
	}

	/**
	 * Says that the state must not be used any more, and starts removing it.
	 * Does not wait: it is called where the connection is saved, which cannot
	 * wait. The note is set before this returns, so the caller must call this
	 * BEFORE it saves the new connection: stopped between the two, the app
	 * then finds an old connection with a state to discard, which costs a
	 * first fetch, and never a new connection with the state of the old one.
	 */
	requestDiscard(): void {
		this.discardRequested = true;
		try {
			this.deps.note.set();
		} catch {
			// The flag above still holds for as long as the app runs.
		}
		this.queue = this.queue.then(() => this.discardIfDue());
	}

	/**
	 * Opens the state, after every discard asked for so far. While a discard
	 * is still due, it is tried again first, and when it fails again the
	 * state is reported unavailable rather than opened, with the reason the
	 * discard gave.
	 *
	 * The store is shared: a second call gets the same one while it is open.
	 */
	open(): Promise<StateOpenResult> {
		const opened = this.queue.then(() => this.openNow());
		this.queue = opened;
		return opened;
	}

	/** Resolves when every discard and open asked for so far has ended, one way or the other. */
	settled(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/** Lets go of the database. For when the plugin is unloaded. */
	close(): void {
		void this.current?.close();
		this.current = null;
	}

	// The note is read once, the first time it matters, and taken over into
	// the flag: it tells what an earlier session left undone. After that the
	// session goes by the flag alone. A note that could not be cleared would
	// otherwise have every open of the session discard the state again.
	private discardIsDue(): boolean {
		if (!this.noteRead) {
			this.noteRead = true;
			try {
				if (this.deps.note.isSet()) this.discardRequested = true;
			} catch {
				// Not known, so taken as set. An earlier session may have left
				// a discard undone, and opening then would put the state of
				// another connection under this one. Discarding without need
				// costs a first fetch, and nothing else.
				this.discardRequested = true;
			}
		}
		return this.discardRequested;
	}

	/**
	 * Removes the state when a discard is due. `null` when none was. Never
	 * rejects, so that the queue goes on after a failure. A failure leaves
	 * the flag and the note as they are, which is what the next open looks at.
	 */
	private async discardIfDue(): Promise<StateDiscardResult | null> {
		if (!this.discardIsDue()) return null;
		try {
			// Whatever still uses the store fails from here on, instead of
			// writing records of the old connection into a new database.
			this.close();
			const result = await discardStateDb(this.deps.appId(), this.deps.indexedDb(), this.deps.onDiscardBlocked);
			if (result.status === "ok") {
				// A later request may have asked again meanwhile. Clearing is
				// still right: nothing was opened since, so the database that
				// was just removed is the one that request meant.
				this.discardRequested = false;
				try {
					this.deps.note.clear();
				} catch {
					// The state is gone all the same. A note left behind costs
					// one more discard, and a first fetch, after a restart.
				}
			}
			return result;
		} catch (error) {
			return { status: "unavailable", reason: "delete-failed", error };
		}
	}

	private async openNow(): Promise<StateOpenResult> {
		try {
			const discard = await this.discardIfDue();
			if (discard !== null && discard.status !== "ok") {
				// Without the id of the vault or without IndexedDB there is
				// no state at all, old or new. That is what is wrong, and the
				// caller is told that rather than of a failed discard.
				const reason = discard.reason === "delete-failed" ? "discard-failed" : discard.reason;
				return { status: "unavailable", reason, error: discard.error };
			}
			if (this.current !== null && !this.current.closed) return { status: "ok", store: this.current };

			const result = await openStateDb(this.deps.appId(), this.deps.indexedDb());
			this.current = result.status === "ok" ? result.store : null;
			return result;
		} catch (error) {
			return { status: "unavailable", reason: "open-failed", error };
		}
	}
}
