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

import type { RemoteListing } from "../../src/core/backend";
import {
	isListing,
	isStatUpdateOf,
	plainMarker,
	plainRecord,
	type StateStore,
	type StoredRecord,
	type WriteMarker,
} from "../../src/core/state";

/**
 * A sync state that lives in memory, for tests. It behaves like the one on a
 * device where a test can tell: values are copied in and out, a value that
 * cannot be stored fails the whole call, and nothing works after `close`.
 */
export class MemoryStateStore implements StateStore {
	private readonly records = new Map<string, StoredRecord>();
	private readonly markers = new Map<string, WriteMarker>();
	private readonly meta = new Map<string, unknown>();
	private listing: unknown = undefined;
	private closed = false;

	async readRecords(): Promise<StoredRecord[]> {
		this.expectOpen();
		return structuredClone([...this.records.values()]);
	}

	async commitWrite(record: StoredRecord): Promise<void> {
		this.expectOpen();
		// Copied before anything is changed, so that a failure changes nothing.
		const stored = structuredClone(plainRecord(record));
		this.markers.delete(stored.key);
		this.records.set(stored.key, stored);
	}

	async updateStats(records: readonly StoredRecord[]): Promise<void> {
		this.expectOpen();
		// Like the store on a device: an update that is dropped is never
		// copied, so one that could not be stored fails the call only when it
		// would have been stored. All are copied before any is stored, so
		// that a failure stores none.
		const updates: StoredRecord[] = [];
		for (const record of records) {
			const update = plainRecord(record);
			const stored = this.records.get(update.key);
			if (stored !== undefined && isStatUpdateOf(stored, update)) updates.push(structuredClone(update));
		}
		for (const update of updates) this.records.set(update.key, update);
	}

	async deleteRecord(key: string, options?: { readonly withMarker?: boolean }): Promise<void> {
		this.expectOpen();
		this.records.delete(key);
		if (options?.withMarker === true) this.markers.delete(key);
	}

	async readMarkers(): Promise<WriteMarker[]> {
		this.expectOpen();
		return structuredClone([...this.markers.values()]);
	}

	async putMarker(marker: WriteMarker): Promise<void> {
		this.expectOpen();
		const stored = structuredClone(plainMarker(marker));
		this.markers.set(stored.key, stored);
	}

	async deleteMarker(key: string): Promise<void> {
		this.expectOpen();
		this.markers.delete(key);
	}

	async getListing(): Promise<RemoteListing | null> {
		this.expectOpen();
		return isListing(this.listing) ? structuredClone(this.listing) : null;
	}

	async putListing(listing: RemoteListing): Promise<void> {
		this.expectOpen();
		this.listing = structuredClone({ revision: listing.revision, entries: listing.entries });
	}

	async clearListing(): Promise<void> {
		this.expectOpen();
		this.listing = undefined;
	}

	async getMeta(key: string): Promise<unknown> {
		this.expectOpen();
		return structuredClone(this.meta.get(key));
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		this.expectOpen();
		this.meta.set(key, structuredClone(value));
	}

	async deleteMeta(key: string): Promise<void> {
		this.expectOpen();
		this.meta.delete(key);
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	/** Empties the store, as discarding the sync state leaves it. Not part of `StateStore`. */
	clear(): void {
		this.records.clear();
		this.markers.clear();
		this.meta.clear();
		this.listing = undefined;
	}

	private expectOpen(): void {
		if (this.closed) throw new Error("the state store is closed");
	}
}
