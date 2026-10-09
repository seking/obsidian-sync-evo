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

// A GitHub repository as a remote: the calls of the client put together into
// what a sync asks of any remote.

import {
	type ArchiveContents,
	type Backend,
	BackendError,
	type BaseRelation,
	type EntryKind,
	type FetchedFile,
	type ListResult,
	type PushFile,
	type PushRequest,
	type PushResult,
	type RemoteEntry,
	type RemoteListing,
	type StartRequest,
	type StartResult,
} from "../backend";
import { type CommitChange, commitMessage } from "../commit-message";
import { fetchConcurrently } from "../concurrent-fetch";
import { gitBlobHash } from "../hash";
import { isPathFromRoot } from "../paths";
import { openZip } from "../zip";
import type { FileMode, GitHubClient, GitTreeItem, TreeChange } from "./client";

/** The calls of the client a backend is built from. */
export type GitHubBackendClient = Pick<
	GitHubClient,
	| "resolveHead"
	| "getCommit"
	| "getTree"
	| "getBlob"
	| "getZip"
	| "isAncestor"
	| "createBlob"
	| "createTree"
	| "createCommit"
	| "updateRef"
	| "branch"
	| "defaultBranch"
	| "createFile"
>;

export interface GitHubBackendOptions {
	/** Awaited between the pieces of a large file while it is hashed (`gitBlobHash`). */
	readonly yieldControl?: () => Promise<void>;
	/**
	 * Aborted when the user stops the sync. A fetch then starts no more
	 * requests and ends with a "cancelled" failure, without waiting for the
	 * ones on their way. A push ends the same way before the next thing it
	 * would send, up to the request that moves the branch; that one is not
	 * sent either, and once it was, the push has happened.
	 */
	readonly signal?: AbortSignal;
}

const SYMLINK_MODE = "120000";
const EXECUTABLE_MODE = "100755";

/**
 * How much content one request for a tree carries inside it, in bytes
 * before it is escaped. A push with more than this builds its tree in
 * several requests, each on top of the tree of the one before, so that
 * thousands of notes cost a handful of requests against the limit on
 * creating content, and not one each. GitHub took a request of 40MB and
 * refused one of 61MB (measured 2026-10-10), so this is far inside.
 */
export const TREE_CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * How many files one request for a tree carries the content of. GitHub
 * gives a request about nine seconds and makes a blob of each content
 * inside that: 2,000 small files were taken in seven seconds, and 3,000
 * were taken once in nine and otherwise answered 422 "your request timed
 * out", whatever their size (measured 2026-10-10). 500 take about two.
 */
export const TREE_CHUNK_INLINE_FILES = 500;

/**
 * How many entries one request for a tree carries in all. An entry that
 * names a blob or removes a path costs GitHub far less than a content:
 * 30,000 that name a blob were taken in four seconds and 100,000 timed
 * out, 20,000 removals were taken in three and a half, and 9,500 removals
 * with 500 contents in three and a half (measured 2026-10-10).
 */
export const TREE_CHUNK_ENTRIES = 10_000;

/**
 * The largest file whose content is sent inside a tree. A larger one would
 * fill a request for a tree by itself, which is one request like a blob
 * is, and a blob takes far more than this (`GitHubClient.createBlob`).
 */
export const INLINE_FILE_BYTES = 1024 * 1024;

/** Where GitHub keeps workflow files. Spelled exactly so: `.GitHub/Workflows/` is not refused. */
const WORKFLOWS_FOLDER = ".github/workflows/";

/**
 * Whether the change adds or changes a file that needs the Workflows
 * permission: any file below the folder, of any name and at any depth.
 * Removing one does not need it (measured 2026-10-09).
 */
function isWorkflowWrite(change: TreeChange): boolean {
	return change.path.startsWith(WORKFLOWS_FOLDER) && !("sha" in change && change.sha === null);
}

/** A "no" for lack of permission, in either of the forms it is told in. */
function isRefusal(error: unknown): boolean {
	return error instanceof BackendError && (error.kind === "forbidden" || error.kind === "workflows-permission");
}

const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000e-\u001f]/;

// What a path and the fields around it add to the body of a request.
const TREE_ENTRY_BYTES = 100;

/**
 * The entry a tree item stands for, or `null` for a folder: git lists the
 * folders on the way to a file as items of their own, and a sync only knows
 * files.
 */
export function entryOfTreeItem(item: GitTreeItem): RemoteEntry | null {
	if (item.type === "tree") return null;
	const kind: EntryKind = item.type === "commit" ? "submodule" : item.mode === SYMLINK_MODE ? "symlink" : "file";
	return { path: item.path, kind, hash: item.sha, ...(item.size === undefined ? {} : { size: item.size }) };
}

export class GitHubBackend implements Backend {
	private readonly client: GitHubBackendClient;
	private readonly options: GitHubBackendOptions;

	constructor(client: GitHubBackendClient, options: GitHubBackendOptions = {}) {
		this.client = client;
		this.options = options;
	}

	hashContent(content: Uint8Array): Promise<string> {
		return gitBlobHash(content, this.options.yieldControl);
	}

	/**
	 * The tree of the commit the branch points at, in one call, whatever the
	 * number of files that changed. A tree GitHub cut short (over 100,000
	 * items or 7 MB) fails the listing in the client with
	 * "incomplete-listing": part of a listing would read as deletions.
	 */
	async list(known: string | null): Promise<ListResult> {
		const head = await this.client.resolveHead();
		// A repository without commits. It has no revision to compare with
		// `known`, so it is always answered as a listing.
		if (head.status === "empty") return { changed: true, listing: { revision: null, entries: [] } };
		if (head.sha === known) return { changed: false };

		const commit = await this.client.getCommit(head.sha);
		const entries: RemoteEntry[] = [];
		for (const item of await this.client.getTree(commit.treeSha)) {
			const entry = entryOfTreeItem(item);
			if (entry !== null) entries.push(entry);
		}
		return { changed: true, listing: { revision: head.sha, entries } };
	}

	/** Every failure to find out is thrown by the client; only GitHub's own "no" is "rewritten". */
	async checkBase(base: string, head: string): Promise<BaseRelation> {
		return (await this.client.isAncestor(base, head)) ? "continues" : "rewritten";
	}

	/**
	 * One blob per entry, several at a time (`fetchConcurrently`), yielded
	 * as they arrive. A blob is addressed by its hash, so the revision plays
	 * no part. The size the tree gave goes along: it sets how long the
	 * download may take, and how many are fetched at once. A cancelled
	 * client ends this with its "cancelled" failure. A submodule among the
	 * entries fails the fetch when it is first asked for, with no request sent.
	 */
	async *fetch(_revision: string | null, entries: readonly RemoteEntry[]): AsyncGenerator<FetchedFile, void, void> {
		// Before anything is asked for: found on the way, the requests of the
		// entries around it would already be out. The hash of a submodule is
		// a commit of another repository.
		const submodule = entries.find((entry) => entry.kind === "submodule");
		if (submodule !== undefined) {
			throw new BackendError("other", `fetch: a submodule has no content: ${submodule.path}`);
		}
		yield* fetchConcurrently(
			entries,
			(entry) => this.client.getBlob(entry.hash, entry.size),
			this.options.signal === undefined ? {} : { signal: this.options.signal },
		);
	}

	/**
	 * The zip of the commit, in one request and a redirect. Every entry of
	 * such a zip is below one folder named after the repository and the
	 * commit, which is left out so that the paths are those of the tree.
	 * Only the directory of the zip is read here.
	 */
	async fetchArchive(revision: string): Promise<ArchiveContents> {
		return openZip(new Uint8Array(await this.client.getZip(revision)), { stripTopFolder: true });
	}

	/**
	 * The first commit of a repository without commits, made with the one
	 * API that works on such a repository. GitHub puts that commit on the
	 * default branch of the repository, so the configured branch has to be
	 * that one: asked first, and nothing is created when it is not.
	 */
	async start(request: StartRequest): Promise<StartResult> {
		const head = await this.client.resolveHead();
		if (head.status !== "empty") return { status: "stale" };
		const defaultBranch = await this.client.defaultBranch();
		if (defaultBranch !== this.client.branch) return { status: "other-branch", defaultBranch };

		this.throwIfStopped();
		const { path, content } = request;
		const message = commitMessage(request.deviceName ?? "", [{ kind: "added", path }]);
		const created = await this.client.createFile(path, content, message);
		// Another device made the first commit between the look at the head
		// and this. With a parent, the commit is in the branch, on top of
		// that device's; nothing is answered of it, and the pull that has
		// to come first lists what the branch holds.
		if (created === "exists" || created.parents > 0) return { status: "stale" };
		// The record of the file is made with the hash.
		if (created.blobSha !== (await this.hashContent(content))) {
			throw new BackendError("other", `start: the blob is not the content that was sent: ${path}`);
		}
		return {
			status: "started",
			revision: created.commitSha,
			entry: { path, kind: "file", hash: created.blobSha, size: content.length },
		};
	}

	/**
	 * One commit on top of `baseRevision`, made with the Git Data API alone:
	 * blobs where they are needed, one tree or a chain of them, the commit,
	 * and the branch moved to it as a fast-forward. Nothing shows on the
	 * branch until that last step, and the branch is never forced.
	 *
	 * Before anything is sent, the head is looked at (a push on an old head
	 * would be refused only after everything was sent), and every entry of
	 * the request is checked against the tree of the parent commit, which is
	 * fetched for it: what is to be replaced or deleted must be the file
	 * that was listed, and nothing may land on, or below, a symlink, a
	 * submodule, or a file it does not name. The listing the caller planned
	 * from is not trusted for that. The tree is also where the modes come
	 * from: a file that is executable there stays so.
	 *
	 * After the branch has moved, the tree of the new commit is fetched and
	 * answered as the listing: what GitHub holds, and not what was sent.
	 */
	async push(request: PushRequest): Promise<PushResult> {
		const { baseRevision, writes, deletes } = request;
		if (writes.length === 0 && deletes.length === 0) return { status: "unchanged" };
		if (baseRevision === null) {
			// The Git Data API refuses a repository without commits.
			throw new BackendError("other", "push: a repository without commits cannot be pushed to yet");
		}

		const head = await this.client.resolveHead();
		if (head.status !== "commit" || head.sha !== baseRevision) return { status: "stale" };

		const parent = await this.client.getCommit(baseRevision);
		const tree = new ParentTree(await this.client.getTree(parent.treeSha));
		const removals = deletes.map((entry) => tree.removalOf(entry));
		const removed = new Set(removals.map((removal) => removal.path));
		const targets = writes.map((file) => tree.targetOf(file, removed));
		const named = new Set(removed);
		for (const target of targets) {
			if (named.has(target.path)) throw malformed(target.path, "named twice");
			named.add(target.path);
		}

		// The tree so far, and the changes that are not in it yet.
		let current = parent.treeSha;
		let chunk: TreeChange[] = [];
		let chunkBytes = 0;
		let chunkInline = 0;
		// The files whose entries are in a tree or a chunk, by path, and
		// what was noted of them: taken back when the tree is refused for them.
		const sent = new Map<string, PushFile>();
		const changes: CommitChange[] = removals.map((removal) => ({ kind: "deleted", path: removal.path }));
		const written: RemoteEntry[] = [];
		const flush = async (): Promise<void> => {
			if (chunk.length === 0) return;
			this.throwIfStopped();
			try {
				current = await this.client.createTree(current, chunk);
			} catch (error) {
				const kept = chunk.filter((change) => !isWorkflowWrite(change));
				if (kept.length === chunk.length || !isRefusal(error)) throw error;
				// GitHub refuses a tree that adds or changes a file under
				// `.github/workflows/` to a token without the Workflows
				// permission, with the words it has for any lack of
				// permission. The same tree without those files tells:
				// taken, and it was them. With nothing else in the tree,
				// a blob tells whether the token may write at all.
				this.throwIfStopped();
				try {
					if (kept.length > 0) current = await this.client.createTree(current, kept);
					else await this.client.createBlob(new Uint8Array());
				} catch (second) {
					if (!isRefusal(second)) throw second;
					throw error;
				}
				for (const change of chunk) {
					if (!isWorkflowWrite(change)) continue;
					const drop = (list: { path: string }[]): void => {
						const at = list.findIndex((entry) => entry.path === change.path);
						if (at >= 0) list.splice(at, 1);
					};
					drop(written);
					drop(changes);
					sent.get(change.path)?.refused?.("workflows");
				}
			}
			chunk = [];
			chunkBytes = 0;
			chunkInline = 0;
		};
		const add = async (change: TreeChange, bytes: number): Promise<void> => {
			const size = bytes + change.path.length * 3 + TREE_ENTRY_BYTES;
			const inline = "content" in change ? 1 : 0;
			const full =
				chunkBytes + size > TREE_CHUNK_BYTES ||
				chunkInline + inline > TREE_CHUNK_INLINE_FILES ||
				chunk.length + 1 > TREE_CHUNK_ENTRIES;
			if (chunk.length > 0 && full) await flush();
			chunk.push(change);
			chunkBytes += size;
			chunkInline += inline;
		};

		for (const removal of removals) await add(removal, 0);
		// A file that became a folder, or a folder that became a file: the
		// old side is taken out by a tree of its own first. What one request
		// does with a path that is removed and a path below it that is
		// written is not documented.
		if (targets.some((target) => target.swaps)) await flush();

		// The blobs this push has made, so that many files of one content
		// (empty ones, most of all) cost one request.
		const blobs = new Set<string>();
		// The contents the remote would not take, so that a second file of
		// the same content is not sent to be refused again.
		const refusedBlobs = new Set<string>();
		for (const [index, file] of writes.entries()) {
			const target = targets[index];
			if (target === undefined) continue;
			this.throwIfStopped();
			const content = await file.read();
			if (content === null) continue;
			const hash = await this.hashContent(content);
			const entry: RemoteEntry = { path: target.path, kind: "file", hash, size: content.length };
			// Read again, and it is what the remote holds: nothing to send.
			if (hash === target.existing) {
				written.push(entry);
				continue;
			}

			const { path, mode } = target;
			// An empty file goes as a blob: whether a tree takes an entry
			// whose content is the empty string is not known.
			const text = content.length > 0 && content.length <= INLINE_FILE_BYTES ? inlineText(content) : null;
			if (text !== null) {
				await add({ path, mode, content: text }, content.length);
			} else {
				// Not on the remote, so not among what was written.
				if (refusedBlobs.has(hash)) {
					file.refused?.("too-large");
					continue;
				}
				if (!blobs.has(hash)) {
					this.throwIfStopped();
					let sha: string;
					try {
						sha = await this.client.createBlob(content);
					} catch (error) {
						if (!(error instanceof BackendError) || error.kind !== "too-large") throw error;
						refusedBlobs.add(hash);
						file.refused?.("too-large");
						continue;
					}
					// The record of the file is made with `hash`.
					if (sha !== hash) throw new BackendError("other", `push: the blob is not the content that was sent: ${path}`);
					blobs.add(hash);
				}
				await add({ path, mode, sha: hash }, 0);
			}
			sent.set(path, file);
			written.push(entry);
			changes.push({ kind: target.existing === undefined ? "added" : "modified", path });
		}
		await flush();
		if (current === parent.treeSha) return { status: "unchanged" };

		this.throwIfStopped();
		const revision = await this.client.createCommit({
			message: commitMessage(request.deviceName ?? "", changes),
			tree: current,
			parents: [baseRevision],
		});
		await request.beforePublish?.({ revision, written });
		this.throwIfStopped();

		let moved: "updated" | "stale";
		request.onPublish?.();
		try {
			moved = (await this.client.updateRef(revision)).status;
		} catch (error) {
			// No answer is not a "no": the request may have gone through.
			// The head tells. Anything but the new commit there, and the
			// failure stands; the caller has the revision and looks again
			// the next time.
			if (!(error instanceof BackendError) || error.kind !== "unreachable") throw error;
			let now: Awaited<ReturnType<GitHubBackendClient["resolveHead"]>>;
			try {
				now = await this.client.resolveHead();
			} catch {
				throw error;
			}
			if (now.status !== "commit" || now.sha !== revision) throw error;
			moved = "updated";
		}
		if (moved === "stale") return { status: "stale" };
		const listing = await this.listingOf(revision, current);
		return { status: "pushed", revision, written, ...(listing === null ? {} : { listing }) };
	}

	/**
	 * What the commit a push has just made holds, as GitHub lists it: one
	 * request. `null` when it cannot be had. The push has happened either
	 * way, so this never fails it.
	 */
	private async listingOf(revision: string, treeSha: string): Promise<RemoteListing | null> {
		try {
			const entries: RemoteEntry[] = [];
			for (const item of await this.client.getTree(treeSha)) {
				const entry = entryOfTreeItem(item);
				if (entry !== null) entries.push(entry);
			}
			return { revision, entries };
		} catch {
			return null;
		}
	}

	private throwIfStopped(): void {
		if (this.options.signal?.aborted === true) throw new BackendError("cancelled", "push: cancelled");
	}
}

/** Where a write lands in the tree of the parent commit. */
interface WriteTarget {
	readonly path: string;
	readonly mode: FileMode;
	/** The blob the tree holds at the path; `undefined` for a path that is new. */
	readonly existing?: string;
	/** Whether the path takes the place of a folder, or lies below a file, that the same push removes. */
	readonly swaps: boolean;
}

/** The tree of the parent commit is not what the listing the push was planned from says. */
function notAsListed(path: string, why: string): BackendError {
	return new BackendError("not-as-listed", `push: ${why}: ${path}`);
}

/** The request contradicts itself, whatever the remote holds. */
function malformed(path: string, why: string): BackendError {
	return new BackendError("other", `push: ${why}: ${path}`);
}

/** The tree a push builds on, as GitHub has it: what every entry of the request is checked against. */
class ParentTree {
	private readonly items = new Map<string, GitTreeItem>();

	constructor(items: readonly GitTreeItem[]) {
		for (const item of items) this.items.set(item.path, item);
	}

	/** The removal of a file that is in the tree as it was listed. Never of a symlink or a submodule. */
	removalOf(entry: RemoteEntry): TreeChange & { readonly sha: null } {
		const item = this.fileAt(entry);
		return { path: item.path, mode: item.mode, sha: null };
	}

	targetOf(file: PushFile, removed: ReadonlySet<string>): WriteTarget {
		const { path, replaces } = file;
		if (!isPathFromRoot(path)) throw malformed(path, "not a path");

		// Nothing is written below a symlink, a submodule, or a file: the
		// tree would get a folder in its place. A file this push removes is
		// the one thing that may make way.
		let swaps = false;
		for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
			const above = this.items.get(path.slice(0, slash));
			if (above === undefined || above.type === "tree") continue;
			if (!removed.has(above.path)) throw notAsListed(path, "below something that is not a folder");
			swaps = true;
		}

		if (replaces !== undefined) {
			if (replaces.path !== path) throw malformed(path, "not the path of the entry it replaces");
			const item = this.fileAt(replaces);
			return { path, mode: item.mode === EXECUTABLE_MODE ? EXECUTABLE_MODE : "100644", existing: item.sha, swaps };
		}

		const there = this.items.get(path);
		if (there !== undefined) {
			// A folder may make way when the push removes every file in it.
			// Anything else at the path is content this push has not named.
			if (there.type !== "tree") throw notAsListed(path, "a new path that the remote already holds");
			const prefix = `${path}/`;
			for (const item of this.items.values()) {
				if (item.type === "tree" || !item.path.startsWith(prefix)) continue;
				if (!removed.has(item.path)) throw notAsListed(path, "a new path where the remote has a folder");
			}
			swaps = true;
		}
		return { path, mode: "100644", swaps };
	}

	private fileAt(entry: RemoteEntry): GitTreeItem {
		const item = this.items.get(entry.path);
		if (
			entry.kind !== "file" ||
			item === undefined ||
			item.type !== "blob" ||
			item.mode === SYMLINK_MODE ||
			item.sha !== entry.hash
		) {
			throw notAsListed(entry.path, "not the file that was listed");
		}
		return item;
	}
}

/**
 * The content as text, when sending it as text gives back these very
 * bytes: it is UTF-8, and encoding what was decoded makes no difference.
 * `null` for everything else, which goes as a blob: bytes that are not
 * UTF-8, a byte order mark (dropped by decoding), and control characters
 * other than tabs and line ends. A NUL marks a file as binary wherever git
 * looks at it; and each such character is six bytes in the body of the
 * request, which the size of a tree is not reckoned with.
 */
export function inlineText(content: Uint8Array): string | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return null;
	}
	if (CONTROL_CHARACTER.test(text)) return null;
	const again = new TextEncoder().encode(text);
	if (again.length !== content.length) return null;
	for (let i = 0; i < again.length; i++) {
		if (again[i] !== content[i]) return null;
	}
	return text;
}
