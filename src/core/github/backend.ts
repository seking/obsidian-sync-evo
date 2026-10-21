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

// A GitHub repository as a remote: the calls of the client put together into
// what a sync asks of any remote.

import {
	type ArchiveContents,
	type Backend,
	BackendError,
	type BaseRelation,
	type EntryKind,
	type EntrySource,
	type FetchedFile,
	type ListResult,
	type PushFile,
	type PushRequest,
	type PushResult,
	type RemoteEntry,
	type RemoteListing,
	type StartRequest,
	type StartResult,
	type SubmoduleSkip,
} from "../backend";
import { type CommitChange, commitMessage, untrackMessage } from "../commit-message";
import { fetchConcurrently } from "../concurrent-fetch";
import { gitBlobHash } from "../hash";
import { isPathFromRoot } from "../paths";
import { inlineText } from "../text";
import { openZip } from "../zip";
import type { FileMode, GitHubClient, GitTreeItem, RepositoryName, TreeChange } from "./client";
import { parseGitmodules, repositoryName, repositoryOfName, repositoryOfUrl } from "./submodules";

// Where it was before it moved to `text.ts`, for whoever names it from here.
export { inlineText };

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
	| "sees"
	| "repository"
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
	/**
	 * The most the blobs fetched at once may add up to, in bytes
	 * (`ConcurrentFetchOptions.maxBytes`). `MAX_CONCURRENT_FETCH_BYTES` when
	 * absent; a platform with less room for responses gives less.
	 */
	readonly maxConcurrentFetchBytes?: number;
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

/**
 * Whether a tree may have been refused for naming a blob the repository
 * does not hold: GitHub answers 422, "tree.sha <hash> is not a valid blob"
 * (measured 2026-10-12), and creates nothing. The wording may change and is
 * not relied on; the refusals of a tree that are known to be of something
 * else are left out, so that no blob is sent again for them.
 */
function mayNameUnknownBlob(error: unknown): boolean {
	if (!(error instanceof BackendError) || error.status !== 422 || error.kind !== "other") return false;
	return !/timed out|too large/i.test(error.message);
}

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

function entriesOfTree(items: readonly GitTreeItem[]): RemoteEntry[] {
	const entries: RemoteEntry[] = [];
	for (const item of items) {
		const entry = entryOfTreeItem(item);
		if (entry !== null) entries.push(entry);
	}
	return entries;
}

/** Where git keeps what its submodules point to. Read at the root of the tree alone. */
const GITMODULES = ".gitmodules";

// The repository a source names. It was written by `withSubmodules`, but a
// listing is also read back from where it was stored.
function repositoryOf(source: EntrySource): RepositoryName {
	const repository = repositoryOfName(source.repository);
	if (repository === null) throw new BackendError("other", `fetch: not a repository: ${source.repository}`);
	return repository;
}

// An archive of a folder's content, answered for under the paths below that folder.
function belowFolder(archive: ArchiveContents, folder: string): ArchiveContents {
	const prefix = `${folder}/`;
	const inner = (path: string): string | null => (path.startsWith(prefix) ? path.slice(prefix.length) : null);
	return {
		byteLength: archive.byteLength,
		sizeOf: (path) => {
			const at = inner(path);
			return at === null ? null : archive.sizeOf(at);
		},
		read: (path) => {
			const at = inner(path);
			if (at === null) throw new BackendError("other", `archive: not below ${folder}: ${path}`);
			return archive.read(at);
		},
	};
}

export class GitHubBackend implements Backend {
	private readonly client: GitHubBackendClient;
	private readonly options: GitHubBackendOptions;
	// What was read of submodules, for as long as this backend lives: the
	// URLs a `.gitmodules` names, by the hash of the file, and what a commit
	// of another repository holds, by repository and commit.
	private readonly gitmodules = new Map<string, Map<string, string>>();
	private readonly insides = new Map<string, readonly RemoteEntry[]>();

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
	async list(known: RemoteListing | null): Promise<ListResult> {
		const head = await this.client.resolveHead();
		// A repository without commits. It has no revision to compare with
		// `known`, so it is always answered as a listing.
		if (head.status === "empty") return { changed: true, listing: { revision: null, entries: [] } };
		if (head.sha === known?.revision) return { changed: false };

		const commit = await this.client.getCommit(head.sha);
		const entries = await this.withSubmodules(entriesOfTree(await this.client.getTree(commit.treeSha)));
		return { changed: true, listing: { revision: head.sha, entries } };
	}

	/**
	 * The entries of a tree of the repository, and with them what each of
	 * its submodules holds: the tree of the commit the submodule points to,
	 * in the repository `.gitmodules` of the same tree names for it, below
	 * the path of the submodule. Each such entry says where it is read from
	 * (`RemoteEntry.source`), and each submodule whether it was listed
	 * (`RemoteEntry.contents`). Two requests for each submodule, and one for
	 * `.gitmodules`; a tree without a submodule costs none.
	 *
	 * A submodule that cannot be listed is left as the one entry it is, with
	 * the reason: one that points to another host or that `.gitmodules` says
	 * nothing of, a repository the token does not see, a commit that
	 * repository does not hold, a tree that is too large to be listed whole,
	 * and a submodule inside a submodule. Every other failure fails the
	 * listing: nothing is known of the submodule then, and a listing is
	 * never partial.
	 */
	private async withSubmodules(entries: readonly RemoteEntry[]): Promise<RemoteEntry[]> {
		if (!entries.some((entry) => entry.kind === "submodule")) return [...entries];
		const urls = await this.gitmodulesOf(entries);
		const listed: RemoteEntry[] = [];
		for (const entry of entries) {
			if (entry.kind !== "submodule") {
				listed.push(entry);
				continue;
			}
			const url = urls.get(entry.path);
			const repository = url === undefined ? null : repositoryOfUrl(url, this.client.repository);
			if (repository === null) {
				listed.push({ ...entry, contents: { listed: false, reason: "not-supported" } });
				continue;
			}
			const inside = await this.insideOf(repository, entry.hash);
			const name = repositoryName(repository);
			if (typeof inside === "string") {
				listed.push({ ...entry, contents: { listed: false, reason: inside, repository: name } });
				continue;
			}
			listed.push({ ...entry, contents: { listed: true, repository: name } });
			const source: EntrySource = { submodule: entry.path, repository: name, revision: entry.hash };
			for (const item of inside) {
				const path = `${entry.path}/${item.path}`;
				if (item.kind === "submodule") listed.push({ ...item, path, contents: { listed: false, reason: "nested" } });
				else listed.push({ ...item, path, source });
			}
		}
		return listed;
	}

	// What `.gitmodules` at the root of the tree says, read once for a
	// content. Without the file, no submodule is said anything of.
	private async gitmodulesOf(entries: readonly RemoteEntry[]): Promise<Map<string, string>> {
		const file = entries.find((entry) => entry.path === GITMODULES && entry.kind === "file");
		if (file === undefined) return new Map();
		const known = this.gitmodules.get(file.hash);
		if (known !== undefined) return known;
		const content = await this.client.getBlob(file.hash, file.size);
		const urls = parseGitmodules(new TextDecoder().decode(content));
		this.gitmodules.set(file.hash, urls);
		return urls;
	}

	// What a commit of another repository holds, with the paths it has
	// there, or why it cannot be listed. Asked once for a commit: the tree
	// of a commit never changes, and a push lists again right after a pull.
	private async insideOf(
		repository: RepositoryName,
		commit: string,
	): Promise<readonly RemoteEntry[] | SubmoduleSkip> {
		const key = `${repositoryName(repository)}@${commit}`;
		const known = this.insides.get(key);
		if (known !== undefined) return known;
		let inside: readonly RemoteEntry[];
		try {
			const { treeSha } = await this.client.getCommit(commit, repository);
			inside = entriesOfTree(await this.client.getTree(treeSha, repository));
		} catch (error) {
			if (!(error instanceof BackendError)) throw error;
			if (error.kind === "incomplete-listing") return "too-large";
			if (error.kind === "forbidden") return "no-access";
			// A repository without commits answers 409 to these calls.
			if (error.kind === "other" && error.status === 409) return "no-commit";
			if (error.kind !== "not-found") throw error;
			// The same 404 for a commit that is not there and a repository
			// that is out of sight. Asking for the repository tells them apart.
			return (await this.client.sees(repository)) ? "no-commit" : "no-access";
		}
		this.insides.set(key, inside);
		return inside;
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
	 * An entry below a submodule is asked of the repository it is read from.
	 */
	async *fetch(_revision: string | null, entries: readonly RemoteEntry[]): AsyncGenerator<FetchedFile, void, void> {
		// Before anything is asked for: found on the way, the requests of the
		// entries around it would already be out. The hash of a submodule is
		// a commit of another repository.
		const submodule = entries.find((entry) => entry.kind === "submodule");
		if (submodule !== undefined) {
			throw new BackendError("other", `fetch: a submodule has no content: ${submodule.path}`);
		}
		const others = new Map<string, RepositoryName>();
		for (const entry of entries) {
			if (entry.source !== undefined) others.set(entry.source.repository, repositoryOf(entry.source));
		}
		const { signal, maxConcurrentFetchBytes: maxBytes } = this.options;
		const blobOf = (entry: RemoteEntry): Promise<Uint8Array> =>
			entry.source === undefined
				? this.client.getBlob(entry.hash, entry.size)
				: this.client.getBlob(entry.hash, entry.size, others.get(entry.source.repository));
		yield* fetchConcurrently(entries, blobOf, {
			...(signal === undefined ? {} : { signal }),
			...(maxBytes === undefined ? {} : { maxBytes }),
		});
	}

	/**
	 * One blob, by its hash, in one request. GitHub keeps a blob for as long
	 * as something reaches it, so one that no history holds any more (after
	 * a force push) is gone some day: its 404 is the "no" here. The same 404
	 * comes for a repository that is out of sight, which the caller cannot
	 * use either.
	 */
	async contentOf(hash: string, _path?: string): Promise<Uint8Array | null> {
		try {
			return await this.client.getBlob(hash);
		} catch (error) {
			if (error instanceof BackendError && error.kind === "not-found") return null;
			throw error;
		}
	}

	/**
	 * The zip of the commit, in one request and a redirect. Every entry of
	 * such a zip is below one folder named after the repository and the
	 * commit, which is left out so that the paths are those of the tree.
	 * Only the directory of the zip is read here.
	 *
	 * With a source, the zip of the commit the submodule points to, of the
	 * repository it points to. Its paths are those of that repository; they
	 * are answered for under the paths of the listing, below the submodule.
	 */
	async fetchArchive(revision: string, source?: EntrySource): Promise<ArchiveContents> {
		if (source === undefined) return openZip(new Uint8Array(await this.client.getZip(revision)), { stripTopFolder: true });
		const zip = await this.client.getZip(source.revision, repositoryOf(source));
		return belowFolder(openZip(new Uint8Array(zip), { stripTopFolder: true }), source.submodule);
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
		const untrack = request.untrack === true;
		if (writes.length === 0 && deletes.length === 0) return { status: "unchanged" };
		// Its commit is described as one that takes files out. The rules
		// that leave them out may go with them, and nothing else.
		if (untrack && writes.some((file) => file.path !== ".gitignore")) {
			throw new BackendError("other", "push: an untrack carries no writes but the root .gitignore");
		}
		if (baseRevision === null) {
			// The Git Data API refuses a repository without commits.
			throw new BackendError("other", "push: a repository without commits cannot be pushed to yet");
		}

		const head = await this.client.resolveHead();
		if (head.status !== "commit" || head.sha !== baseRevision) return { status: "stale" };

		const parent = await this.client.getCommit(baseRevision);
		const tree = new ParentTree(await this.client.getTree(parent.treeSha));
		const removals = deletes.map((entry) => tree.removalOf(entry, untrack));
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
		const drop = (list: { path: string }[], path: string): void => {
			const at = list.findIndex((entry) => entry.path === path);
			if (at >= 0) list.splice(at, 1);
		};
		// The blobs this push has made or found remembered, so that many
		// files of one content (empty ones, most of all) cost one request.
		const blobs = new Set<string>();
		// The contents the remote would not take, so that a second file of
		// the same content is not sent to be refused again.
		const refusedBlobs = new Set<string>();
		// Those of `blobs` that were not sent by this push but remembered
		// from one before (`PushRequest.sentBlobs`), and the files whose
		// entry names one of them, by path.
		const { sentBlobs } = request;
		const recalledBlobs = new Set<string>();
		const recalled = new Map<string, { file: PushFile; target: WriteTarget }>();
		// Makes the blob of a content, once. `false`: the remote would not
		// take it for its size, and the file is left out of the push.
		const sendBlob = async (file: PushFile, content: Uint8Array, hash: string): Promise<boolean> => {
			if (blobs.has(hash)) return true;
			if (refusedBlobs.has(hash)) {
				file.refused?.("too-large");
				return false;
			}
			this.throwIfStopped();
			let sha: string;
			try {
				sha = await this.client.createBlob(content);
			} catch (error) {
				if (!(error instanceof BackendError) || error.kind !== "too-large") throw error;
				refusedBlobs.add(hash);
				file.refused?.("too-large");
				return false;
			}
			// The record of the file is made with `hash`.
			if (sha !== hash) throw new BackendError("other", `push: the blob is not the content that was sent: ${file.path}`);
			blobs.add(hash);
			sentBlobs?.add(hash);
			return true;
		};
		// A tree was refused that names blobs remembered from a push before:
		// the repository may not hold them any more. None that is remembered
		// is counted on from here on, and the files of this tree that named
		// one are read and sent again. Answers the tree to ask for instead.
		const resend = async (pending: readonly TreeChange[]): Promise<TreeChange[]> => {
			sentBlobs?.forget();
			for (const hash of recalledBlobs) blobs.delete(hash);
			recalledBlobs.clear();
			const kept: TreeChange[] = [];
			for (const change of pending) {
				const again = recalled.get(change.path);
				if (again === undefined) {
					kept.push(change);
					continue;
				}
				recalled.delete(change.path);
				const { file, target } = again;
				const { path, mode } = target;
				drop(written, path);
				this.throwIfStopped();
				const content = await file.read();
				const hash = content === null ? null : await this.hashContent(content);
				if (content === null || hash === null || (hash !== target.existing && !(await sendBlob(file, content, hash)))) {
					// Not on the remote, so not among what was written.
					drop(changes, path);
					sent.delete(path);
					continue;
				}
				written.push({ path, kind: "file", hash, size: content.length });
				// Read again, and it is what the remote holds: nothing to send.
				if (hash === target.existing) drop(changes, path);
				else kept.push({ path, mode, sha: hash });
			}
			return kept;
		};
		const flush = async (): Promise<void> => {
			if (chunk.length === 0) return;
			let pending = chunk;
			// The refusal the tree met with its workflow files in it, once
			// it is asked for without them.
			let refusal: BackendError | null = null;
			let resent = false;
			for (;;) {
				this.throwIfStopped();
				try {
					if (pending.length > 0) current = await this.client.createTree(current, pending);
					else if (refusal !== null) await this.client.createBlob(new Uint8Array());
					break;
				} catch (error) {
					// GitHub refuses a tree that adds or changes a file under
					// `.github/workflows/` to a token without the Workflows
					// permission, with the words it has for any lack of
					// permission. The same tree without those files tells:
					// taken, and it was them. With nothing else in the tree,
					// a blob tells whether the token may write at all.
					if (error instanceof BackendError && isRefusal(error)) {
						if (refusal !== null) throw refusal;
						const kept = pending.filter((change) => !isWorkflowWrite(change));
						if (kept.length === pending.length) throw error;
						refusal = error;
						pending = kept;
						continue;
					}
					// After the workflow files, and once: the two may meet in one tree.
					if (resent || !mayNameUnknownBlob(error) || !pending.some((change) => recalled.has(change.path))) throw error;
					resent = true;
					pending = await resend(pending);
				}
			}
			if (refusal !== null) {
				for (const change of chunk) {
					if (!isWorkflowWrite(change)) continue;
					drop(written, change.path);
					drop(changes, change.path);
					sent.get(change.path)?.refused?.("workflows");
				}
			}
			// Every blob these trees name is in the repository: none of them is in doubt any more.
			for (const change of chunk) recalled.delete(change.path);
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
				// Sent by a push before this one, which did not get to its
				// commit. Should the repository not hold it any more, the
				// tree that names it is refused (`resend`).
				if (!blobs.has(hash) && sentBlobs?.has(hash) === true) {
					blobs.add(hash);
					recalledBlobs.add(hash);
				}
				// Not on the remote, so not among what was written.
				if (!(await sendBlob(file, content, hash))) continue;
				// Noted before the entry is added: adding it may send the
				// tree before it, and that tree being refused forgets every
				// remembered blob, this one among them. Its entry names the
				// blob all the same, and is in doubt until its own tree is taken.
				if (recalledBlobs.has(hash)) recalled.set(path, { file, target });
				await add({ path, mode, sha: hash }, 0);
			}
			sent.set(path, file);
			written.push(entry);
			changes.push({ kind: target.existing === undefined ? "added" : "modified", path });
		}
		// Before the last tree, the commit and the move of the branch: a
		// failure there leaves the blobs that were sent remembered.
		await sentBlobs?.save();
		await flush();
		if (current === parent.treeSha) return { status: "unchanged" };

		this.throwIfStopped();
		const revision = await this.client.createCommit({
			message: untrack ? untrackMessage(request.deviceName ?? "", changes) : commitMessage(request.deviceName ?? "", changes),
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
			// With what the submodules hold, like any listing. A push changes
			// none of them, so this is answered from what `list` has read.
			return { revision, entries: await this.withSubmodules(entriesOfTree(await this.client.getTree(treeSha))) };
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

	/**
	 * The removal of a file that is in the tree as it was listed. Never of a
	 * submodule, and of a symlink only where the push untracks
	 * (`PushRequest.untrack`): no device deletes a link by deleting a file,
	 * since none ever wrote it as one.
	 */
	removalOf(entry: RemoteEntry, symlinks = false): TreeChange & { readonly sha: null } {
		const item = symlinks && entry.kind === "symlink" ? this.symlinkAt(entry) : this.fileAt(entry);
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

	private symlinkAt(entry: RemoteEntry): GitTreeItem {
		const item = this.items.get(entry.path);
		if (item === undefined || item.type !== "blob" || item.mode !== SYMLINK_MODE || item.sha !== entry.hash) {
			throw notAsListed(entry.path, "not the symlink that was listed");
		}
		return item;
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
