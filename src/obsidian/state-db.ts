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

// The sync state in IndexedDB: on the device, outside the vault. Nothing of
// it goes to the plugin's `data.json`, which is inside the vault and would be
// replaced by another device's when the plugin folder itself is synced, nor
// to the app's local storage, which is too small for thousands of records.

import type { App } from "obsidian";
import type { RemoteListing } from "../core/backend";
import {
	isListing,
	isStatUpdateOf,
	plainMarker,
	plainRecord,
	type StateSeed,
	type StateStore,
	type StoredRecord,
	type WriteMarker,
} from "../core/state";

/**
 * The version of the stored form, which is the version of the IndexedDB
 * database itself. It goes up by one with every change of form, together
 * with one more step in `MIGRATIONS`. IndexedDB then does the rest: it runs
 * the steps a database is behind by, and refuses to open one that is ahead.
 *
 * A field added to a record, a marker, the listing, or a value of the meta
 * store is a change of form as well, though no store changes: this code
 * writes back the fields it knows, so an older version that opened the
 * database would drop the new one without a word. Only a field that may be
 * lost like that is added without a new version.
 */
export const STATE_DB_VERSION = 1;

const RECORDS = "records";
const MARKERS = "markers";
const LISTING = "listing";
const META = "meta";
/** The one key in `LISTING`. One value holds the revision and the entries, so they cannot come apart. */
const LISTING_KEY = "current";

type Migration = (db: IDBDatabase, transaction: IDBTransaction) => void;

// The step at index n takes a database from version n to n + 1. A database
// that does not exist yet is at version 0. A later step gets the upgrade
// transaction to rewrite what is stored.
const MIGRATIONS: readonly Migration[] = [
	(db) => {
		db.createObjectStore(RECORDS, { keyPath: "key" });
		db.createObjectStore(MARKERS, { keyPath: "key" });
		db.createObjectStore(LISTING);
		db.createObjectStore(META);
	},
];

/**
 * The id the app gives the vault. `appId` is not part of the public API, so
 * what comes back is not trusted to be a string; `stateDbName` decides.
 */
export function readAppId(app: App): unknown {
	return (app as { appId?: unknown }).appId;
}

/**
 * The name of the database of one vault, or `null` when the id of the vault
 * is not known. IndexedDB is shared by every vault on the device, and the
 * name is all that keeps them apart. So there is no name to fall back on:
 * under a shared one, two vaults would read each other's records.
 *
 * On an iPhone the id is the place and the name of the vault
 * (`documents/notes`). A `/` in the name of a database is fine.
 */
export function stateDbName(appId: unknown): string | null {
	return typeof appId === "string" && appId !== "" ? `sync-evo-${appId}` : null;
}

export type StateUnavailableReason =
	/** The app did not give the id of the vault. */
	| "no-app-id"
	/** There is no IndexedDB here. */
	| "no-indexeddb"
	/** IndexedDB refused to open the database. */
	| "open-failed"
	/**
	 * The state of an earlier connection is still there and could not be
	 * removed. It must not be used for the connection there is now.
	 */
	| "discard-failed";

export type StateOpenResult =
	| { readonly status: "ok"; readonly store: IdbStateStore }
	/**
	 * A later version of Sync Evo wrote the database. Nothing was changed.
	 * The sync must stop and say so: this version would misread what is
	 * there, and writing would break it for the newer one.
	 */
	| { readonly status: "newer-version" }
	| { readonly status: "unavailable"; readonly reason: StateUnavailableReason; readonly error?: unknown };

export type StateDiscardResult =
	| { readonly status: "ok" }
	| {
			readonly status: "unavailable";
			readonly reason: "no-app-id" | "no-indexeddb" | "delete-failed";
			readonly error?: unknown;
	  };

/** Opens the sync state of the vault with this id, creating or migrating it as needed. Never throws. */
export function openStateDb(appId: unknown, factory: IDBFactory | undefined): Promise<StateOpenResult> {
	const name = stateDbName(appId);
	if (name === null) return Promise.resolve({ status: "unavailable", reason: "no-app-id" });
	if (factory === undefined) return Promise.resolve({ status: "unavailable", reason: "no-indexeddb" });

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(name, STATE_DB_VERSION);
		} catch (error) {
			resolve({ status: "unavailable", reason: "open-failed", error });
			return;
		}
		request.onupgradeneeded = (event) => {
			const transaction = request.transaction;
			if (transaction === null) return;
			try {
				for (let version = event.oldVersion; version < STATE_DB_VERSION; version++) {
					const migrate = MIGRATIONS[version];
					if (migrate === undefined) throw new Error(`no migration from version ${version}`);
					migrate(request.result, transaction);
				}
			} catch {
				// Leaves the database at the version it had, and fails the open.
				transaction.abort();
			}
		};
		request.onsuccess = () => resolve({ status: "ok", store: new IdbStateStore(request.result) });
		request.onerror = (event) => {
			// Handled here; it must not go on to the window as an uncaught error.
			event.preventDefault();
			// What IndexedDB answers when the database has a higher version
			// than the one asked for. The database is left as it is.
			if (request.error?.name === "VersionError") resolve({ status: "newer-version" });
			else resolve({ status: "unavailable", reason: "open-failed", error: request.error });
		};
		// No `onblocked`: it only says that an upgrade waits for another
		// window to close its connection, which that window does when it is
		// told of the change (below). The open goes on by itself after that.
	});
}

/**
 * Removes the whole sync state of the vault with this id, whatever version
 * wrote it. Resolves when the database is gone, not before.
 *
 * Connections that are open, here or in another window of the same vault,
 * are told and close themselves (`versionchange`, below), once the
 * transactions they are in have finished. Until then the removal is
 * "blocked", which is a wait and not a failure: `onBlocked` is called, once,
 * so that the wait can be shown, and the promise still resolves only when the
 * removal is done. Reporting a blocked removal as failed would be wrong both ways:
 * it still happens later, and anything opened in between would wait behind it.
 */
export function discardStateDb(
	appId: unknown,
	factory: IDBFactory | undefined,
	onBlocked?: () => void,
): Promise<StateDiscardResult> {
	const name = stateDbName(appId);
	if (name === null) return Promise.resolve({ status: "unavailable", reason: "no-app-id" });
	if (factory === undefined) return Promise.resolve({ status: "unavailable", reason: "no-indexeddb" });

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.deleteDatabase(name);
		} catch (error) {
			resolve({ status: "unavailable", reason: "delete-failed", error });
			return;
		}
		request.onsuccess = () => resolve({ status: "ok" });
		request.onerror = (event) => {
			event.preventDefault();
			resolve({ status: "unavailable", reason: "delete-failed", error: request.error });
		};
		request.onblocked = () => onBlocked?.();
	});
}

type StoreName = typeof RECORDS | typeof MARKERS | typeof LISTING | typeof META;

/**
 * The sync state of one vault. Each method is one transaction and resolves
 * when that transaction has completed, not when its requests have succeeded:
 * only then is what was written sure to be read by the next transaction and
 * kept if the app is stopped. `durability` is left at the default; "strict"
 * took 17 times as long on an iPhone, and what the default can lose with a
 * crash of the whole system is a few records that the next sync makes again.
 */
export class IdbStateStore implements StateStore {
	private readonly db: IDBDatabase;
	private isClosed = false;

	constructor(db: IDBDatabase) {
		this.db = db;
		// Another connection wants to delete the database (the state is being
		// discarded from another window of the same vault) or to upgrade it.
		// Holding on would block that for as long as this window lives.
		db.onversionchange = () => {
			this.isClosed = true;
			db.close();
		};
		// The system took the database away.
		db.onclose = () => {
			this.isClosed = true;
		};
	}

	/** Whether the connection is gone: closed here, or given up for another window. Every call then fails. */
	get closed(): boolean {
		return this.isClosed;
	}

	readRecords(): Promise<StoredRecord[]> {
		return this.read(RECORDS, (store) => store.getAll() as IDBRequest<StoredRecord[]>);
	}

	commitWrite(record: StoredRecord): Promise<void> {
		const stored = plainRecord(record);
		return this.write([RECORDS, MARKERS], (transaction) => {
			transaction.objectStore(MARKERS).delete(stored.key);
			transaction.objectStore(RECORDS).put(stored);
		});
	}

	commitRecords(records: readonly StoredRecord[], deleted: readonly string[]): Promise<void> {
		if (records.length === 0 && deleted.length === 0) return Promise.resolve();
		const stored = records.map(plainRecord);
		return this.write([RECORDS, MARKERS], (transaction) => {
			const markers = transaction.objectStore(MARKERS);
			const store = transaction.objectStore(RECORDS);
			for (const record of stored) {
				markers.delete(record.key);
				store.put(record);
			}
			for (const key of deleted) store.delete(key);
		});
	}

	updateStats(records: readonly StoredRecord[]): Promise<void> {
		if (records.length === 0) return Promise.resolve();
		return this.write([RECORDS], (transaction, fail) => {
			const store = transaction.objectStore(RECORDS);
			for (const record of records) {
				const update = plainRecord(record);
				// Read and written in the same transaction, so nothing can
				// change the record between the comparison and the write.
				const request = store.get(update.key) as IDBRequest<StoredRecord | undefined>;
				request.onsuccess = () => {
					const stored = request.result;
					if (stored === undefined || !isStatUpdateOf(stored, update)) return;
					try {
						store.put(update);
					} catch (error) {
						// As in `transact`: one record that cannot be stored
						// must not leave the others of the call stored.
						fail(error);
					}
				};
			}
		});
	}

	deleteRecord(key: string, options?: { readonly withMarker?: boolean }): Promise<void> {
		const withMarker = options?.withMarker === true;
		return this.write(withMarker ? [RECORDS, MARKERS] : [RECORDS], (transaction) => {
			transaction.objectStore(RECORDS).delete(key);
			if (withMarker) transaction.objectStore(MARKERS).delete(key);
		});
	}

	readMarkers(): Promise<WriteMarker[]> {
		return this.read(MARKERS, (store) => store.getAll() as IDBRequest<WriteMarker[]>);
	}

	putMarker(marker: WriteMarker): Promise<void> {
		return this.write([MARKERS], (transaction) => {
			transaction.objectStore(MARKERS).put(plainMarker(marker));
		});
	}

	deleteMarker(key: string): Promise<void> {
		return this.write([MARKERS], (transaction) => {
			transaction.objectStore(MARKERS).delete(key);
		});
	}

	async getListing(): Promise<RemoteListing | null> {
		const value = await this.read(LISTING, (store) => store.get(LISTING_KEY) as IDBRequest<unknown>);
		return isListing(value) ? value : null;
	}

	putListing(listing: RemoteListing): Promise<void> {
		return this.write([LISTING], (transaction) => {
			transaction.objectStore(LISTING).put({ revision: listing.revision, entries: listing.entries }, LISTING_KEY);
		});
	}

	clearListing(): Promise<void> {
		return this.write([LISTING], (transaction) => {
			transaction.objectStore(LISTING).delete(LISTING_KEY);
		});
	}

	getMeta(key: string): Promise<unknown> {
		return this.read(META, (store) => store.get(key) as IDBRequest<unknown>);
	}

	setMeta(key: string, value: unknown): Promise<void> {
		return this.write([META], (transaction) => {
			transaction.objectStore(META).put(value, key);
		});
	}

	deleteMeta(key: string): Promise<void> {
		return this.write([META], (transaction) => {
			transaction.objectStore(META).delete(key);
		});
	}

	/**
	 * Empties the sync state and stores `seed` in it, in one transaction:
	 * for the "first fetch" command, which starts over with the connection
	 * it has. Stopped at any moment, the app finds the state as it was or
	 * the new one with all of `seed`, and never an empty one that has
	 * forgotten which files were left half written. Removing the database
	 * and opening another cannot give that.
	 *
	 * Not for a change of the connection (`discardStateDb`): that has to
	 * work on a database that cannot be opened, and has to close it under
	 * the other windows of the vault.
	 */
	startOver(seed: StateSeed): Promise<void> {
		const markers = seed.markers.map(plainMarker);
		return this.write([RECORDS, MARKERS, LISTING, META], (transaction) => {
			for (const name of [RECORDS, MARKERS, LISTING, META] as const) transaction.objectStore(name).clear();
			for (const marker of markers) transaction.objectStore(MARKERS).put(marker);
			const { revision, entries } = seed.listing;
			transaction.objectStore(LISTING).put({ revision, entries }, LISTING_KEY);
			for (const [key, value] of seed.meta) transaction.objectStore(META).put(value, key);
		});
	}

	/** Transactions already started still finish; IndexedDB closes the connection after them. */
	close(): Promise<void> {
		this.isClosed = true;
		this.db.close();
		return Promise.resolve();
	}

	/** Runs `work` in one read-write transaction; all of it is stored, or none. */
	private write(
		names: StoreName[],
		work: (transaction: IDBTransaction, fail: (error: unknown) => void) => void,
	): Promise<void> {
		return this.transact(names, "readwrite", (transaction, fail) => {
			work(transaction, fail);
			return undefined;
		}).then(() => undefined);
	}

	private read<T>(name: StoreName, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		return this.transact([name], "readonly", (transaction) => work(transaction.objectStore(name))).then(
			(request) => request.result,
		);
	}

	private transact<T>(
		names: StoreName[],
		mode: IDBTransactionMode,
		work: (transaction: IDBTransaction, fail: (error: unknown) => void) => T,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			// Throws when the connection is closed.
			const transaction = this.db.transaction(names, mode);
			let result: T;
			// What made this code abort the transaction. An abort asked for
			// here leaves `transaction.error` empty, and the caller is to
			// learn the cause, whether it came up at once or in the callback
			// of a request.
			let cause: { readonly error: unknown } | undefined;
			const fail = (error: unknown): void => {
				if (cause !== undefined) return;
				cause = { error };
				transaction.abort();
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onabort = () => {
				if (cause !== undefined) reject(cause.error instanceof Error ? cause.error : new Error(String(cause.error)));
				else reject(transaction.error ?? new Error("the transaction was aborted"));
			};
			try {
				result = work(transaction, fail);
			} catch (error) {
				// A request that throws (a value that cannot be stored) does
				// not abort the transaction by itself: the requests made
				// before it would still be carried out, one half of a write
				// without the other.
				fail(error);
			}
		});
	}
}
