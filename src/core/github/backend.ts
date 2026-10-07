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
// what a sync asks of any remote. Reading only, so far.

import {
	type Backend,
	BackendError,
	type BaseRelation,
	type EntryKind,
	type FetchedFile,
	type ListResult,
	type PushResult,
	type RemoteEntry,
} from "../backend";
import { fetchConcurrently } from "../concurrent-fetch";
import { gitBlobHash } from "../hash";
import type { GitHubClient, GitTreeItem } from "./client";

/** The calls of the client a backend is built from. */
export type GitHubBackendClient = Pick<
	GitHubClient,
	"resolveHead" | "getCommit" | "getTree" | "getBlob" | "isAncestor"
>;

export interface GitHubBackendOptions {
	/** Awaited between the pieces of a large file while it is hashed (`gitBlobHash`). */
	readonly yieldControl?: () => Promise<void>;
	/**
	 * Aborted when the user stops the sync. A fetch then starts no more
	 * requests and ends with a "cancelled" failure, without waiting for the
	 * ones on their way.
	 */
	readonly signal?: AbortSignal;
}

const SYMLINK_MODE = "120000";

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

	// Sending is a later stage. Until then nothing of the vault leaves the device.
	async push(): Promise<PushResult> {
		throw new BackendError("other", "push: not implemented yet");
	}
}
