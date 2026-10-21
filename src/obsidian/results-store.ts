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

// The results of the last syncs that had something to tell, for the screen
// that lists them (`results-view.ts`). In IndexedDB, so that they outlive a
// restart of the app, which on a phone comes often and before they are
// looked at. A database of their own and not the sync state: that is
// discarded by a change of the connection and by a first fetch, right where
// the results matter most.

import { keepResult, readResults, type SyncResult } from "../core/sync-results";
import { readAppId } from "./state-db";
import type { App } from "obsidian";

const STORE = "results";
/** The one key: one value holds every result, so that they are written and read as one. */
const KEY = "recent";

export interface ResultsStoreDeps {
	/** The id of the vault, read each time, unchecked. */
	readonly appId: () => unknown;
	/** Read each time, so that nothing touches IndexedDB before it is needed. */
	readonly indexedDb: () => IDBFactory | undefined;
}

export function resultsStoreDepsOf(app: App): ResultsStoreDeps {
	return {
		appId: () => readAppId(app),
		indexedDb: () => (window as { indexedDB?: IDBFactory }).indexedDB,
	};
}

/** The name of the database of one vault, or `null` when the id of the vault is not known (`stateDbName`). */
export function resultsDbName(appId: unknown): string | null {
	return typeof appId === "string" && appId !== "" ? `sync-evo-results-${appId}` : null;
}

/**
 * The results, kept in memory as well: where IndexedDB cannot be used, they
 * are there until the app is closed. Nothing here fails a sync, or rejects.
 */
export class ResultsStore {
	private readonly deps: ResultsStoreDeps;
	private results: SyncResult[] = [];
	/** Whether `results` holds what was stored as well, or that could not be read. */
	private loaded: Promise<void> | null = null;
	/** The writes, one after the other, so that a later one is never overtaken. */
	private queue: Promise<void> = Promise.resolve();

	constructor(deps: ResultsStoreDeps) {
		this.deps = deps;
	}

	/** The results, the newest first, with those of a sync that has just ended. */
	async list(): Promise<readonly SyncResult[]> {
		await this.queue;
		await this.load();
		return this.results;
	}

	/**
	 * Keeps the result of a sync that has ended, and stores what is kept.
	 * What is stored is read again in the same transaction: another window
	 * of the vault may have added to it since, and a read that failed before
	 * must not make this write lose what was stored.
	 */
	add(result: SyncResult): Promise<void> {
		this.queue = this.queue.then(async () => {
			await this.load();
			this.results = keepResult(this.results, result);
			try {
				this.results = await this.use<SyncResult[]>("readwrite", (store, done) => {
					const read = store.get(KEY) as IDBRequest<unknown>;
					read.onsuccess = () => {
						const kept = keepResult(readResults(read.result), result);
						store.put(kept, KEY);
						done(kept);
					};
				});
			} catch {
				// Kept in memory, until the app is closed.
			}
		});
		return this.queue;
	}

	private load(): Promise<void> {
		this.loaded ??= this.use<unknown>("readonly", (store, done) => {
			const read = store.get(KEY) as IDBRequest<unknown>;
			read.onsuccess = () => done(read.result);
		})
			.then((stored) => {
				// Nothing is added before this has ended (`add`).
				this.results = readResults(stored);
			})
			.catch(() => undefined);
		return this.loaded;
	}

	/**
	 * Work in a transaction of its own, on a connection that is closed again
	 * once it has ended. Resolves with what the work handed `done`, once the
	 * transaction has completed; rejects when it did not.
	 */
	private async use<T>(
		mode: IDBTransactionMode,
		work: (store: IDBObjectStore, done: (value: T) => void) => void,
	): Promise<T> {
		const db = await this.open();
		try {
			return await new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(STORE, mode);
				let value: { readonly is: T } | null = null;
				work(transaction.objectStore(STORE), (given) => {
					value = { is: given };
				});
				transaction.oncomplete = () => {
					if (value === null) reject(new Error("no value"));
					else resolve(value.is);
				};
				transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
				// A request that failed fails the whole transaction: nothing of
				// it is taken for done. Handled here, and not left to the window.
				transaction.onerror = (event) => {
					event.preventDefault();
					transaction.abort();
				};
			});
		} finally {
			db.close();
		}
	}

	private open(): Promise<IDBDatabase> {
		const name = resultsDbName(this.deps.appId());
		const factory = this.deps.indexedDb();
		if (name === null || factory === undefined) return Promise.reject(new Error("no database"));
		return new Promise((resolve, reject) => {
			let request: IDBOpenDBRequest;
			try {
				request = factory.open(name, 1);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			request.onupgradeneeded = () => {
				request.result.createObjectStore(STORE);
			};
			request.onsuccess = () => {
				const db = request.result;
				// Another window upgrades or removes it: not held up by this one.
				db.onversionchange = () => db.close();
				resolve(db);
			};
			request.onerror = (event) => {
				event.preventDefault();
				reject(request.error ?? new Error("open failed"));
			};
		});
	}
}
