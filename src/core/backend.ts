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

/**
 * Why what is inside a submodule is not in a listing.
 *
 * - "not-supported": the place it points to is one this remote cannot read
 *   (another host), or the remote does not say where it points to.
 * - "no-access": the place is out of sight of the credentials, or not there.
 * - "no-commit": the place is in sight and does not hold the commit the
 *   submodule points to, as when it was not pushed there yet.
 * - "too-large": what the commit holds could not be listed whole.
 * - "nested": it is a submodule inside a submodule.
 */
export type SubmoduleSkip = "not-supported" | "no-access" | "no-commit" | "too-large" | "nested";

/** What a listing says of a submodule beside the commit it points to. */
export type SubmoduleContents =
	/** Everything the commit holds is in the listing, below the path of the submodule (`RemoteEntry.source`). */
	| { readonly listed: true; readonly repository: string }
	/** Nothing below the path of the submodule is in the listing, which says nothing of what is there. */
	| { readonly listed: false; readonly reason: SubmoduleSkip; readonly repository?: string };

/**
 * Where the content of an entry is when the remote itself does not hold it:
 * the place a submodule points to. An entry that has one is read from
 * there, and is never written: a push leaves what is below a submodule as
 * it is.
 */
export interface EntrySource {
	/** The path of the submodule the entry is below, as the remote spells it. */
	readonly submodule: string;
	/** The place, as the backend names it (`owner/name`). */
	readonly repository: string;
	/** The commit of that place the entry is of. */
	readonly revision: string;
}

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
	/** Of a submodule: whether what is inside it is in the listing. Absent on a remote that never lists it. */
	readonly contents?: SubmoduleContents;
	/** Of an entry below a submodule: where it is read from. */
	readonly source?: EntrySource;
	/**
	 * The remote's own name for this version of the file, on a remote that
	 * guards each write of a file by the version it replaces (Dropbox's
	 * `rev`). Absent on a remote whose revision names every file at once.
	 */
	readonly version?: string;
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

/** Why a remote would not take one file of a push (`PushFile.refused`). */
export type PushRefusal = "too-large" | "workflows" | "changed" | "no-space";

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
	 * and once (but see `PushRequest.sentBlobs`). What it answers is what is sent, also when it is no longer
	 * the content of `hash`: a note that is typed in while the push runs is
	 * sent as it is by then, under the hash it has by then (`PushResult`).
	 * `null` leaves the file out of this push, and everything else is sent.
	 */
	read(): Promise<Uint8Array | null>;
	/**
	 * Told when the remote would not take the file that `read` gave. The
	 * file is left out of this push like one that read as `null`, and
	 * everything else is sent: what a remote refuses is not always known
	 * before it is met, and one file must not keep the others from being
	 * sent.
	 *
	 * "too-large": the content, because of its size. "workflows": the
	 * path, because the credentials lack the permission the host asks for
	 * workflow files. "changed": the remote holds another version of the
	 * file than `replaces` names, or a file where none was listed: another
	 * device wrote it first. Only on a remote that writes file by file
	 * (`RemoteEntry.version`); the next pull takes it as a conflict.
	 * "no-space": the account on the remote has no room left for it.
	 */
	refused?(reason: PushRefusal): void;
}

/** A revision that was made and is not the head of the remote yet. */
export interface PendingPush {
	readonly revision: string;
	/** The written files as that revision holds them, like `PushResult.written`. */
	readonly written: readonly RemoteEntry[];
}

/**
 * The contents this device has sent to the remote before, by hash, kept
 * from one push to the next (`sent-blobs.ts`). Only for a remote that
 * stores a content apart from the revision that names it, so that a
 * content sent by a push that never got to its revision is still there.
 */
export interface SentBlobs {
	/** Whether the content was sent, and is taken to be on the remote still. */
	has(hash: string): boolean;
	/** The content is on the remote now. */
	add(hash: string): void;
	/** The remote has shown not to hold a content that was remembered: none of them is counted on any more. */
	forget(): void;
	/**
	 * Stores what was added. Awaited once every content was sent and
	 * before the revision is made, so that a failure of the last steps
	 * leaves the contents remembered. Never rejects.
	 */
	save(): Promise<void>;
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
	 * Whether the deletes untrack: the files are taken out of the remote
	 * because a rule leaves them out, and stay on the device that asks. A
	 * remote that keeps a description of each change says so in it. Only
	 * such a push may name a symlink among its deletes; a submodule never.
	 * It carries no write but one of the root `.gitignore`: the rules that
	 * leave the files out, which go in the same commit where the remote
	 * does not hold them yet.
	 */
	readonly untrack?: boolean;
	/**
	 * Left out, every content is sent. With it, a content that was sent
	 * before is named and not sent again, and `PushFile.read` may be
	 * called a second time for such a file: when the remote turns out not
	 * to hold the content any more, the file is read and sent again.
	 */
	readonly sentBlobs?: SentBlobs;
	/**
	 * Awaited once, after everything was sent and right before the new
	 * revision is made the head of the remote: the last moment at which
	 * nothing of the push shows. Whether that last step took effect is not
	 * always known (an answer that never arrives), so the caller stores the
	 * revision here, and can tell later by looking at the head. A rejection
	 * ends the push with nothing changed. Not called when there is nothing
	 * to make a revision of, nor by a remote that writes file by file,
	 * which makes no revision (`Backend.push`): what is stored here would
	 * not know of the deletes such a remote keeps (`kept`).
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
			 * `read` answered `null`, and the ones the remote refused
			 * (`PushFile.refused`).
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
			/**
			 * The deletes that were not made, because the remote holds
			 * another version of the file than the one listed: another
			 * device changed it first. Each is the entry of `deletes` itself. Only on a remote that writes file
			 * by file (`RemoteEntry.version`); elsewhere a push is made
			 * whole or not at all. The next pull takes each one as changed
			 * on the remote and deleted on the device.
			 */
			readonly kept?: readonly RemoteEntry[];
	  }
	/**
	 * There was nothing to send, or what was read is what the remote already
	 * holds, or the remote took none of it (`PushFile.refused`, `kept`). No
	 * revision was made.
	 */
	| { readonly status: "unchanged"; readonly kept?: readonly RemoteEntry[] }
	/** The remote moved past `baseRevision`. Nothing was changed. */
	| { readonly status: "stale" };

/** The first file of a remote that has no revision yet. */
export interface StartRequest {
	readonly path: string;
	readonly content: Uint8Array;
	/** The name of this device, for a remote that keeps a description of each change. */
	readonly deviceName?: string;
}

export type StartResult =
	| {
			readonly status: "started";
			/** The revision that was made, which holds the one file. */
			readonly revision: string;
			/** The file as the remote now holds it. */
			readonly entry: RemoteEntry;
			/**
			 * Everything `revision` holds, where that can be more than the
			 * one file: on a remote whose revision is a moment and not a
			 * commit, another device may have written beside it. Absent,
			 * the revision holds `entry` alone.
			 */
			readonly listing?: RemoteListing;
	  }
	/** The remote has a revision by now. Nothing was changed. */
	| { readonly status: "stale" }
	/**
	 * The first revision of this remote can only be made on another branch
	 * than the configured one, and none is made on a branch the user did
	 * not name. Nothing was changed.
	 */
	| { readonly status: "other-branch"; readonly defaultBranch: string };

export interface Backend {
	/** Hashes local content the same way the listing's `hash` is computed. */
	hashContent(content: Uint8Array): Promise<string>;

	/**
	 * Lists the remote. When `known` is the listing the caller already has
	 * and the remote has not moved past its revision, answers `changed:
	 * false` without listing. Pass `null` to always get a listing. Fails
	 * rather than return a partial listing.
	 *
	 * A remote that tells only what changed since a revision (a cursor)
	 * builds the new listing on top of the entries of `known`: the two are
	 * one value, stored together (`StateStore.putListing`), so that no
	 * change is laid twice on a listing that already holds it.
	 *
	 * `changed: false` is only useful to a caller that still holds the listing
	 * it got for `known`. A caller that does not must pass `null`. The sync
	 * records are not a substitute for that listing: they only cover paths
	 * that were synced, so a remote path that was never written to the vault
	 * would look absent from the remote, and a vault file of the same name
	 * would be sent over it.
	 */
	list(known: RemoteListing | null): Promise<ListResult>;

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
	 *
	 * With `source`, what the place a submodule points to holds at the
	 * commit of the source, under the paths the listing has for it: below
	 * the path of the submodule.
	 */
	fetchArchive?(revision: string, source?: EntrySource): Promise<ArchiveContents>;

	/**
	 * The content that has `hash`, whichever revision named it: what the
	 * file at `path` held when it was last synced, which a merge compares
	 * the two sides with (`merge.ts`). A remote that keeps contents by file
	 * and not by hash looks among the versions of `path`. `null` when the
	 * remote does not hold such a content, or not any more. Absent on a
	 * remote that cannot look a content up; nothing is merged there.
	 *
	 * Like `fetch`, it does not promise that what comes back has the hash.
	 * The caller checks with `hashContent`.
	 */
	contentOf?(hash: string, path: string): Promise<Uint8Array | null>;

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
	 *
	 * A remote that writes file by file (`RemoteEntry.version`) makes no
	 * revision of the push: it writes and deletes one file at a time, each
	 * only over the version that was listed. What another device changed
	 * first is left as it is, told by `PushFile.refused` ("changed") and
	 * `kept`, and the rest goes on. It never calls `beforePublish`: a push
	 * that stops half way leaves files that the next sync finds the same
	 * on both sides, and records then.
	 */
	push(request: PushRequest): Promise<PushResult>;

	/**
	 * Makes the first revision of a remote that has none, with one file in
	 * it; everything else is then sent with `push`, on top of it. Absent on
	 * a remote that cannot: nothing is sent to it while it is empty.
	 *
	 * A failure does not always mean that nothing changed. The caller
	 * records nothing then, and the next sync finds a remote that is not
	 * empty, which a pull has to look at first.
	 */
	start?(request: StartRequest): Promise<StartResult>;
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
	/**
	 * The remote would not take the content of one file because of its
	 * size. A push leaves that file out and sends the rest (`PushFile.refused`).
	 */
	| "too-large"
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
