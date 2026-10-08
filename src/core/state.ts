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

// The sync state one device keeps for one vault: what is in it, the rules
// about it that need no storage, and the interface of the place it is kept.
// Where that place is (IndexedDB on a device, memory in tests) is decided
// outside the core.

import type { EntryKind, ListResult, RemoteEntry, RemoteListing } from "./backend";
import { pathKey } from "./paths";
import type { SyncRecord } from "./plan";

/**
 * A record as it is stored. It is a `SyncRecord`, so a list of these is what
 * the sync decision takes as its records.
 */
export interface StoredRecord extends SyncRecord {
	/** `pathKey(path)`. What the record is stored and found under. */
	readonly key: string;
	/**
	 * The modification time (milliseconds since the epoch) and the size of the
	 * vault file when its content was known to have `hash`. Only on regular
	 * files, and always both or neither. A record without them says nothing
	 * about the file on disk, so the file is read and hashed.
	 */
	readonly mtime?: number;
	readonly size?: number;
}

/** What the file system says about a file without reading it. */
export interface FileStat {
	/** Milliseconds since the epoch. */
	readonly mtime: number;
	readonly size: number;
}

/**
 * Whether a file can be taken as unchanged since its record was written,
 * without reading it. So that a sync does not read every file of the vault
 * to hash it again.
 *
 * This misses an edit by a tool that keeps both the modification time and
 * the size. Sync Evo is not meant to be used next to such a tool.
 */
export function isUnchangedByStat(record: StoredRecord, stat: FileStat): boolean {
	return (
		record.kind === "file" &&
		record.mtime !== undefined &&
		record.size !== undefined &&
		record.mtime === stat.mtime &&
		record.size === stat.size
	);
}

/**
 * How long before the start of a sync a modification time is still too recent
 * to be stored, in milliseconds. Some file systems keep the time only to one
 * or two seconds (FAT and exFAT, HFS+, some network mounts). On those, a file
 * written after the sync began can carry a time from just before it, and an
 * edit in the same second and to the same size would then never be seen. Two
 * seconds cover the coarsest of them. The cost is one more hashing, on the
 * next sync, of each file that was touched in the two seconds before this one.
 */
export const RACY_MTIME_MARGIN_MS = 2000;

/**
 * The record to store for an entry that is now in sync.
 *
 * `stat` is what the vault file looked like when its content had the entry's
 * hash; leave it out when there is no such file (a symlink or a submodule is
 * not written to the vault). `syncStartedAt` is when the sync that stores the
 * record began, on the clock the modification times come from.
 *
 * A modification time at or after that start, or less than
 * `RACY_MTIME_MARGIN_MS` before it, is not stored. An edit made right after,
 * within the same tick of the file system's clock and to the same size, would
 * leave the time and the size as they are, and the stored pair would call the
 * file unchanged for good. Without the pair the next sync hashes the file,
 * and stores the pair then, when the time is safely in the past. No extra
 * field is needed to say "hash this again".
 */
export function makeRecord(entry: SyncRecord, stat: FileStat | undefined, syncStartedAt: number): StoredRecord {
	const base = { key: pathKey(entry.path), path: entry.path, kind: entry.kind, hash: entry.hash };
	if (entry.kind !== "file" || stat === undefined || stat.mtime >= syncStartedAt - RACY_MTIME_MARGIN_MS) {
		return base;
	}
	return { ...base, mtime: stat.mtime, size: stat.size };
}

/**
 * For a file that was hashed again and still has the hash of its record: the
 * record with the time and the size the file has now, or `null` when what is
 * stored already says the same. Stored so that the file is not hashed on
 * every sync from now on. The same rule about recent times applies.
 */
export function refreshStat(record: StoredRecord, stat: FileStat, syncStartedAt: number): StoredRecord | null {
	const next = makeRecord(record, stat, syncStartedAt);
	return next.mtime === record.mtime && next.size === record.size ? null : next;
}

/**
 * Whether `update` may replace `stored` as an update of the time and the size
 * alone (`StateStore.updateStats`): both are the record of the same regular
 * file with the same content. Compared are
 *
 * - `kind`, which must be "file" on both: nothing else has a time or a size;
 * - `hash`: a different one means the file was written or sent since the
 *   update was made, and the update describes content that is gone;
 * - `path`, to the character: the same key with another spelling means a
 *   pull has taken over a new spelling from the remote since, which the
 *   update would undo.
 *
 * The time and the size are not compared; they are what changes. The key
 * follows from the path.
 */
export function isStatUpdateOf(stored: StoredRecord, update: StoredRecord): boolean {
	return (
		stored.kind === "file" &&
		update.kind === "file" &&
		stored.hash === update.hash &&
		stored.path === update.path
	);
}

/** Field by field, so that nothing else an object happens to carry is stored. */
export function plainRecord(record: StoredRecord): StoredRecord {
	// The key is taken from the path again: a record can then never be stored
	// under a key that is not its own.
	const base = { key: pathKey(record.path), path: record.path, kind: record.kind, hash: record.hash };
	if (record.kind !== "file" || record.mtime === undefined || record.size === undefined) return base;
	return { ...base, mtime: record.mtime, size: record.size };
}

/**
 * Says that Sync Evo is about to write a file. It is stored before the write
 * and removed together with the storing of the record, so one that is still
 * there when a sync starts marks a file that may be half written. What is
 * done about it then is decided where the pull resumes.
 */
export interface WriteMarker {
	/** `pathKey(path)`. */
	readonly key: string;
	/** The path being written, as it is spelled in the vault. */
	readonly path: string;
	/** The hash of the vault file before the write, or `null` when there was no file. */
	readonly before: string | null;
	/** The hash of the content that was going to be written. */
	readonly writing: string;
	/**
	 * Whether the path is a copy kept from a conflict rather than a path of
	 * the remote. Such a path gets no record, and is resumed differently.
	 */
	readonly conflictCopy: boolean;
}

export function makeMarker(
	path: string,
	before: string | null,
	writing: string,
	conflictCopy: boolean,
): WriteMarker {
	return { key: pathKey(path), path, before, writing, conflictCopy };
}

/** Field by field, like `plainRecord`. */
export function plainMarker(marker: WriteMarker): WriteMarker {
	return {
		key: pathKey(marker.path),
		path: marker.path,
		before: marker.before,
		writing: marker.writing,
		conflictCopy: marker.conflictCopy,
	};
}

/** The key of the base revision among the other values (`getMeta`). */
export const BASE_REVISION_KEY = "base-revision";

/**
 * Where the sync state is kept. Every method that writes is one transaction:
 * when its promise resolves, all of it is stored, and when it rejects, none
 * of it is.
 */
export interface StateStore {
	/** Every record, in no particular order. */
	readRecords(): Promise<StoredRecord[]>;

	/**
	 * Stores the record of a file that was just written and removes the write
	 * marker of the same key, in one transaction. Never one without the
	 * other: a marker gone with the old record left would, once the remote
	 * changes that file again, look like an edit on both sides.
	 *
	 * It is also how a record is stored that follows no write to the vault:
	 * after a push, when a first fetch finds the same content already in the
	 * vault, or when only the spelling is taken over from the tree. There is
	 * no marker then, and removing none changes nothing.
	 */
	commitWrite(record: StoredRecord): Promise<void>;

	/**
	 * Replaces the time and the size of many records in one transaction, for
	 * files that were hashed again and found unchanged (see `RecordBatcher`).
	 * It cannot create a record or change what one says about the remote:
	 * each record given is stored only where the one stored under its key
	 * passes `isStatUpdateOf`. Where there is none, or it differs, what is
	 * stored stays and the update is dropped without an error. An update that
	 * was made before a file was written, and arrives after, can therefore
	 * not put the old hash back.
	 */
	updateStats(records: readonly StoredRecord[]): Promise<void>;

	/** Removes a record, and with `withMarker` the marker of the same key in the same transaction. */
	deleteRecord(key: string, options?: { readonly withMarker?: boolean }): Promise<void>;

	readMarkers(): Promise<WriteMarker[]>;
	/** Stores one marker. Resolved before the file is touched. */
	putMarker(marker: WriteMarker): Promise<void>;
	/** Removes a marker and leaves the record of that key as it is. */
	deleteMarker(key: string): Promise<void>;

	/**
	 * The listing of the remote as it was last fetched, or `null` when there
	 * is none or it cannot be read; the caller then lists again. Its revision
	 * is the head that was last listed. That is not the base revision, which
	 * only moves once everything of a pull is done.
	 */
	getListing(): Promise<RemoteListing | null>;
	/** Replaces the listing. The revision and the entries are stored as one value, so they always belong together. */
	putListing(listing: RemoteListing): Promise<void>;
	clearListing(): Promise<void>;

	/**
	 * The other values of the sync state, each under a name: the base
	 * revision, a failed push, what the user has confirmed, and so on. The
	 * code that owns a value names its key and checks what it reads.
	 * `undefined` when nothing is stored under the key.
	 */
	getMeta(key: string): Promise<unknown>;
	/** `value` must be plain data: what JSON can hold, or a typed array. */
	setMeta(key: string, value: unknown): Promise<void>;
	deleteMeta(key: string): Promise<void>;

	/** Lets go of the storage. Every later call fails. */
	close(): Promise<void>;
}

/**
 * What a sync state that takes the place of a discarded one starts with:
 * what the old one knew and the new one has to know too. Stored as one step
 * with the discarding where the storage can do that, so that the app being
 * stopped leaves either the old state or the new one with all of this.
 */
export interface StateSeed {
	readonly listing: RemoteListing;
	readonly markers: readonly WriteMarker[];
	/** The other values (`setMeta`), each with its key. */
	readonly meta: readonly (readonly [key: string, value: unknown])[];
}

/** The base revision, or `null` when there is none: nothing has been pulled to the end yet. */
export async function readBaseRevision(store: StateStore): Promise<string | null> {
	const value = await store.getMeta(BASE_REVISION_KEY);
	return typeof value === "string" ? value : null;
}

export function writeBaseRevision(store: StateStore, revision: string): Promise<void> {
	return store.setMeta(BASE_REVISION_KEY, revision);
}

/**
 * The listing of the head of the remote: the stored one while the remote
 * has not moved past it, and otherwise the one the remote gives now, which
 * is stored. `list` is `Backend.list`.
 */
export async function currentListing(
	store: Pick<StateStore, "getListing" | "putListing">,
	list: (known: string | null) => Promise<ListResult>,
): Promise<RemoteListing> {
	const stored = await store.getListing();
	// Without a listing to fall back on, "unchanged" would be of no use.
	const listed = await list(stored === null ? null : stored.revision);
	if (!listed.changed) {
		if (stored !== null) return stored;
		throw new Error("The remote answered that nothing changed since a listing that was never taken.");
	}
	await store.putListing(listed.listing);
	return listed.listing;
}

const ENTRY_KINDS: readonly EntryKind[] = ["file", "symlink", "submodule"];

function isRemoteEntry(value: unknown): value is RemoteEntry {
	if (typeof value !== "object" || value === null) return false;
	const { path, kind, hash, size } = value as Record<string, unknown>;
	return (
		typeof path === "string" &&
		ENTRY_KINDS.some((known) => known === kind) &&
		typeof hash === "string" &&
		(size === undefined || typeof size === "number")
	);
}

/**
 * Whether a stored value is a listing, down to every entry. One entry that
 * is not what a listing holds makes the whole value no listing: the sync
 * decides from the listing what to send and what to delete, and a listing
 * that is wrong in one place is not known to be right in another. The caller
 * lists the remote again instead.
 */
export function isListing(value: unknown): value is RemoteListing {
	if (typeof value !== "object" || value === null) return false;
	const { revision, entries } = value as { revision?: unknown; entries?: unknown };
	if (revision !== null && typeof revision !== "string") return false;
	return Array.isArray(entries) && entries.every(isRemoteEntry);
}

export interface RecordBatcherOptions {
	/** The current time in milliseconds. */
	readonly now: () => number;
	/** How many records are held before they are stored. */
	readonly maxCount?: number;
	/** How long the oldest held record waits, in milliseconds, before all are stored. */
	readonly maxAgeMs?: number;
}

/**
 * Collects record updates that follow no write to the vault (a new time and
 * size after a file was hashed again) and stores them many at a time. One
 * transaction per record would be thousands of them in a sync that changes
 * nothing. A batch that is lost with the app costs only the hashing of those
 * files on the next sync, so nothing is done to make it survive.
 *
 * There is no timer: the age is looked at when a record is added, so nothing
 * is written at a moment the caller did not choose. `flush` is awaited at the
 * end. A record that is written another way while its update waits here is
 * safe: the store drops an update whose hash, kind, or path no longer match
 * what is stored (`StateStore.updateStats`).
 */
export class RecordBatcher {
	private readonly store: Pick<StateStore, "updateStats">;
	private readonly now: () => number;
	private readonly maxCount: number;
	private readonly maxAgeMs: number;
	// By key, so that a path added twice is stored once, as it was added last.
	private pending = new Map<string, StoredRecord>();
	private firstAt = 0;

	constructor(store: Pick<StateStore, "updateStats">, options: RecordBatcherOptions) {
		this.store = store;
		this.now = options.now;
		this.maxCount = options.maxCount ?? 500;
		this.maxAgeMs = options.maxAgeMs ?? 1000;
	}

	/** How many records are waiting to be stored. */
	get size(): number {
		return this.pending.size;
	}

	/** Takes a record, and stores all that are held when there are enough or the oldest has waited long enough. */
	async add(record: StoredRecord): Promise<void> {
		const now = this.now();
		if (this.pending.size === 0) this.firstAt = now;
		this.pending.set(pathKey(record.path), record);
		if (this.pending.size >= this.maxCount || now - this.firstAt >= this.maxAgeMs) await this.flush();
	}

	/**
	 * Stores what is held. When that fails, the records are not kept for
	 * another try: the failure is the caller's to handle, and what was lost
	 * is found again by hashing.
	 */
	async flush(): Promise<void> {
		if (this.pending.size === 0) return;
		const records = [...this.pending.values()];
		this.pending = new Map();
		await this.store.updateStats(records);
	}
}
