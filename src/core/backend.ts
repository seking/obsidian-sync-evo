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

/**
 * Everything a revision holds, fetched in one piece (the zip of a commit).
 * The piece is in memory as it was downloaded; the content of a path is
 * produced when it is asked for and not kept, so that only one content is in
 * memory beside it.
 *
 * Nothing it holds is to be trusted: what a host packs can differ from what
 * it lists (files left out, line ends converted, symlinks as plain files).
 * The consumer asks for the paths it took from the listing and for no other,
 * and checks each content with `hashContent`.
 */
export interface ArchiveContents {
	/** The size of what was downloaded, in bytes. */
	readonly byteLength: number;
	/**
	 * The size the content of a path has, in bytes, without producing it.
	 * `null` when the archive does not hold the path.
	 */
	sizeOf(path: string): number | null;
	/** The content of a path the archive holds. Throws when it cannot be produced. */
	read(path: string): Uint8Array;
}

export interface PushFile {
	/** Path as it should appear on the remote. */
	readonly path: string;
	/**
	 * The hash and the size the file had when the push was planned. Not what
	 * is recorded: the content is read when it is sent, and may be newer by
	 * then (`read`).
	 */
	readonly hash: string;
	readonly size: number;
	/**
	 * The entry this write takes the place of, as the listing at
	 * `baseRevision` gave it. Absent for a new path. A remote that addresses
	 * files by id, where one name can exist more than once, cannot tell from
	 * the path alone which file to replace.
	 */
	readonly replaces?: RemoteEntry;
	/**
	 * Read lazily, so that a large push does not hold every file in memory,
	 * and once. What it answers is what is sent, also when it is no longer
	 * the content of `hash`: a note that is typed in while the push runs is
	 * sent as it is by then, under the hash it has by then (`PushResult`).
	 * `null` leaves the file out of this push, and everything else is sent.
	 */
	read(): Promise<Uint8Array | null>;
}

/** A revision that was made and is not the head of the remote yet. */
export interface PendingPush {
	readonly revision: string;
	/** The written files as that revision holds them, like `PushResult.written`. */
	readonly written: readonly RemoteEntry[];
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
	/** The name of this device, for a remote that keeps a description of each change. */
	readonly deviceName?: string;
	/**
	 * Awaited once, after everything was sent and right before the new
	 * revision is made the head of the remote: the last moment at which
	 * nothing of the push shows. Whether that last step took effect is not
	 * always known (an answer that never arrives), so the caller stores the
	 * revision here, and can tell later by looking at the head. A rejection
	 * ends the push with nothing changed. Not called when there is nothing
	 * to make a revision of.
	 */
	readonly beforePublish?: (pending: PendingPush) => Promise<void>;
	/**
	 * Called, and not awaited, right before the request that makes the new
	 * revision the head is sent. A push that ends without this having been
	 * called has changed nothing, whatever `beforePublish` was handed; one
	 * that fails after it may have gone through.
	 */
	readonly onPublish?: () => void;
}

export type PushResult =
	| {
			readonly status: "pushed";
			/** The revision to use as the base from now on. */
			readonly revision: string | null;
			/**
			 * The written files as the remote now holds them: each with the
			 * hash of the content that was sent. Without the files whose
			 * `read` answered `null`.
			 */
			readonly written: readonly RemoteEntry[];
			/**
			 * Everything the new revision holds, as the remote lists it:
			 * asked of the remote after the push, never worked out from what
			 * was sent. A remote may store a file as other bytes than it was
			 * sent, and a listing that says otherwise would have every later
			 * push of that file refused. Absent when the remote could not be
			 * asked; the caller then keeps no listing, and lists again.
			 */
			readonly listing?: RemoteListing;
	  }
	/**
	 * There was nothing to send, or what was read is what the remote already
	 * holds. No revision was made.
	 */
	| { readonly status: "unchanged" }
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
	 * Fetches everything the revision holds at once, whatever the number of
	 * files, in about one request. Absent on a remote that has no such way;
	 * its files are then always fetched with `fetch`. Whether this or `fetch`
	 * is used is decided by the caller (`archive-fetch.ts`), never in here.
	 *
	 * The revision is the one a listing was taken from, so that what is
	 * fetched cannot be newer than what was listed.
	 */
	fetchArchive?(revision: string): Promise<ArchiveContents>;

	/**
	 * Applies writes and deletes on top of `baseRevision`, as one revision.
	 * Paths not named are left as they are. Answers "stale" instead of
	 * overwriting when the remote has moved, and looks for that before any
	 * content is sent. Fails with "not-as-listed", changing nothing, when an
	 * entry to replace or to delete is not what the remote holds at
	 * `baseRevision`.
	 *
	 * A failure does not always mean that nothing changed: see
	 * `PushRequest.beforePublish`.
	 */
	push(request: PushRequest): Promise<PushResult>;
}

export type BackendErrorKind =
	/** Network failure, timeout, or a server-side error. Worth retrying later. */
	| "unreachable"
	/** The credentials were refused: wrong, revoked, or expired. */
	| "unauthorized"
	/** The credentials are valid but do not allow this operation on the target. */
	| "forbidden"
	/**
	 * The configured target (repository, folder) or a revision does not exist,
	 * or the credentials cannot see it. A remote that hides what a credential
	 * may not see answers the same for both.
	 */
	| "not-found"
	/**
	 * The target exists and has content, but not the configured branch. Kept
	 * apart from "not-found" because the branch is never created on the user's
	 * behalf: a missing branch cannot be told from a mistyped name.
	 */
	| "branch-not-found"
	/** The remote's request quota is used up. Always thrown as a `RateLimitedError`. */
	| "rate-limited"
	/**
	 * A push touched workflow files (`.github/workflows/`) and the credentials
	 * lack the separate permission the host requires for them.
	 */
	| "workflows-permission"
	/** The remote could not return the whole listing. */
	| "incomplete-listing"
	/**
	 * A push was refused before anything was sent: what the remote holds at
	 * the revision is not what the listing the push was planned from says.
	 * The listing is of no use then, and the remote is listed again.
	 */
	| "not-as-listed"
	/** The caller asked for the work to stop. Nothing is wrong with the remote. */
	| "cancelled"
	| "other";

/**
 * `message` is for developers and logs, in English. What the user reads is
 * chosen from `kind`.
 */
export class BackendError extends Error {
	readonly kind: BackendErrorKind;
	/**
	 * The status the remote answered with, when the failure is an answer of
	 * the remote. `kind` folds many statuses into one; the few places that
	 * have to tell them apart read this instead of the message.
	 */
	readonly status?: number;

	constructor(kind: BackendErrorKind, message: string, status?: number) {
		super(message);
		this.name = "BackendError";
		this.kind = kind;
		if (status !== undefined) this.status = status;
	}
}

export class RateLimitedError extends BackendError {
	/** When the remote accepts requests again, in milliseconds since the epoch. */
	readonly waitUntil: number;

	constructor(waitUntil: number, message: string) {
		super("rate-limited", message);
		this.name = "RateLimitedError";
		this.waitUntil = waitUntil;
	}
}
