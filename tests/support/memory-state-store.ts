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

import type { RemoteListing } from "../../src/core/backend";
import {
	isListing,
	isStatUpdateOf,
	plainMarker,
	plainRecord,
	type StateSeed,
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

	async commitRecords(records: readonly StoredRecord[], deleted: readonly string[]): Promise<void> {
		this.expectOpen();
		// All are copied before any is stored, so that a failure stores none.
		const stored = records.map((record) => structuredClone(plainRecord(record)));
		for (const record of stored) {
			this.markers.delete(record.key);
			this.records.set(record.key, record);
		}
		for (const key of deleted) this.records.delete(key);
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

	/** As on a device: emptied, and then holding `seed`, in one step. Not part of `StateStore`. */
	async startOver(seed: StateSeed): Promise<void> {
		this.expectOpen();
		const markers = structuredClone(seed.markers.map(plainMarker));
		const meta = structuredClone(seed.meta);
		const listing = structuredClone({ revision: seed.listing.revision, entries: seed.listing.entries });
		this.clear();
		for (const marker of markers) this.markers.set(marker.key, marker);
		for (const [key, value] of meta) this.meta.set(key, value);
		this.listing = listing;
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
