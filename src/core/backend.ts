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

// The interface every remote (a git host, a cloud drive, the in-memory one
// used by tests) implements. It only lists, reads, and writes. What to fetch,
// send, or delete is decided elsewhere, from the listing alone.

export type EntryKind = "file" | "symlink" | "submodule";

export interface RemoteEntry {
	/** Path from the root, spelled exactly as the remote has it. */
	readonly path: string;
	readonly kind: EntryKind;
	/**
	 * Content identity in the backend's own scheme. For a file it equals
	 * `hashContent` of its bytes; for a submodule it is the commit it points to.
	 */
	readonly hash: string;
	/** Size in bytes, when the listing provides it. */
	readonly size?: number;
}

export interface RemoteListing {
	/**
	 * Identifies the remote state this listing was taken from (a commit, a
	 * change token). `null` when the remote has no such state yet, for example
	 * a repository without commits.
	 */
	readonly revision: string | null;
	/** Every entry at that revision. Never partial. */
	readonly entries: readonly RemoteEntry[];
}

export type ListResult =
	| { readonly changed: false }
	| { readonly changed: true; readonly listing: RemoteListing };

/** Whether the current remote state still builds on an earlier revision. */
export type BaseRelation = "continues" | "rewritten";

export interface FetchedFile {
	readonly entry: RemoteEntry;
	readonly content: Uint8Array;
}

export interface PushFile {
	/** Path as it should appear on the remote. */
	readonly path: string;
	readonly hash: string;
	readonly size: number;
	/**
	 * The entry this write takes the place of, as the listing at
	 * `baseRevision` gave it. Absent for a new path. A remote that addresses
	 * files by id, where one name can exist more than once, cannot tell from
	 * the path alone which file to replace.
	 */
	readonly replaces?: RemoteEntry;
	/** Read lazily, so that a large push does not hold every file in memory. */
	read(): Promise<Uint8Array>;
}

export interface PushRequest {
	/** The revision the changes were computed against; `null` for an empty remote. */
	readonly baseRevision: string | null;
	readonly writes: readonly PushFile[];
	/**
	 * Entries to remove, as the listing at `baseRevision` gave them. They are
	 * entries rather than paths so that the backend can tell which file is
	 * meant when a name is not unique, and can check that it is still the one
	 * that was listed.
	 */
	readonly deletes: readonly RemoteEntry[];
}

export type PushResult =
	| {
			readonly status: "pushed";
			/** The revision to use as the base from now on. */
			readonly revision: string | null;
			/** The written files as the remote now holds them. */
			readonly written: readonly RemoteEntry[];
	  }
	/** The remote moved past `baseRevision`. Nothing was changed. */
	| { readonly status: "stale" };

export interface Backend {
	/** Hashes local content the same way the listing's `hash` is computed. */
	hashContent(content: Uint8Array): Promise<string>;

	/**
	 * Lists the remote. When `known` is the revision the caller already has
	 * and the remote has not moved, answers `changed: false` without listing.
	 * Pass `null` to always get a listing. Fails rather than return a partial
	 * listing.
	 *
	 * `changed: false` is only useful to a caller that still holds the listing
	 * it got for `known`. A caller that does not must pass `null`. The sync
	 * records are not a substitute for that listing: they only cover paths
	 * that were synced, so a remote path that was never written to the vault
	 * would look absent from the remote, and a vault file of the same name
	 * would be sent over it.
	 */
	list(known: string | null): Promise<ListResult>;

	/**
	 * Tells whether `head` still builds on `base`. A failure to find out is
	 * thrown, never reported as "rewritten". Backends without history answer
	 * "continues".
	 */
	checkBase(base: string, head: string): Promise<BaseRelation>;

	/**
	 * Yields the content of each requested entry of a listing, once, in any
	 * order. How the bytes are obtained (one request per file, one archive,
	 * batches) is up to the backend. The consumer should use each item before
	 * asking for the next, so that contents do not pile up in memory.
	 *
	 * The content is not guaranteed to match `entry.hash`. The consumer checks
	 * that with `hashContent` before it writes anything.
	 */
	fetch(revision: string | null, entries: readonly RemoteEntry[]): AsyncIterable<FetchedFile>;

	/**
	 * Applies writes and deletes on top of `baseRevision`. Paths not named are
	 * left as they are. Answers "stale" instead of overwriting when the remote
	 * has moved. Fails, changing nothing, when a file's content does not match
	 * its `hash`.
	 */
	push(request: PushRequest): Promise<PushResult>;
}

export type BackendErrorKind =
	/** Network failure, timeout, or a server-side error. Worth retrying later. */
	| "unreachable"
	| "unauthorized"
	/** The configured target (repository, branch, folder) or a revision does not exist. */
	| "not-found"
	/** The remote could not return the whole listing. */
	| "incomplete-listing"
	| "other";

export class BackendError extends Error {
	readonly kind: BackendErrorKind;

	constructor(kind: BackendErrorKind, message: string) {
		super(message);
		this.name = "BackendError";
		this.kind = kind;
	}
}
