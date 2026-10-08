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

/** `onDiscardBlocked` is given by whoever waits on `open` and can show that wait. */
export function syncStateDepsOf(app: App, onDiscardBlocked?: () => void): SyncStateDeps {
	return {
		appId: () => readAppId(app),
		note: discardNoteOf(app),
		indexedDb: () => (globalThis as { indexedDB?: IDBFactory }).indexedDB,
		...(onDiscardBlocked === undefined ? {} : { onDiscardBlocked }),
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
	// Discards that were asked for and whose turn in the queue has not come.
	// While there is one, a discard that succeeds does not clear the flag or
	// the note: an open can be queued between two requests, and what it opens
	// is the state the later request means.
	private discardsWaiting = 0;
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
	 *
	 * `after`: what the removal waits for, when a sync is still using the
	 * state. The state is closed under whatever uses it, so a sync that is
	 * running is stopped and awaited first; it must not ask for the state
	 * again meanwhile, or the two wait for each other. An open asked for
	 * later waits for all of it, as before.
	 */
	requestDiscard(after?: Promise<unknown>): void {
		this.discardRequested = true;
		try {
			this.deps.note.set();
		} catch {
			// The flag above still holds for as long as the app runs.
		}
		this.discardsWaiting += 1;
		this.queue = this.queue
			// However that sync ended, the state goes.
			.then(() => after?.catch(() => undefined))
			.then(() => {
				this.discardsWaiting -= 1;
				return this.discardIfDue();
			});
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
			// A request whose turn is still to come keeps the discard due. An
			// open may be queued ahead of it (a sync that starts between two
			// changes of the connection): what that open makes is what the
			// later request is about, and it must be removed in its turn, or
			// after a restart. With no request waiting, nothing was opened since the
			// removal, and clearing is right.
			if (result.status === "ok" && this.discardsWaiting === 0) {
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
