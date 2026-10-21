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

import { createHash } from "node:crypto";
import {
	BackendError,
	type Backend,
	type BaseRelation,
	type FetchedFile,
	type ListResult,
	type PushRequest,
	type PushResult,
	type RemoteEntry,
	type RemoteListing,
	type StartRequest,
	type StartResult,
} from "../../src/core/backend";

export type FileContent = string | Uint8Array;

export function bytes(content: FileContent): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** The hash git gives a blob with this content. */
export function blobHash(content: FileContent): string {
	const data = bytes(content);
	return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

/**
 * A remote that lives in memory, for tests. It has revisions and refuses a
 * push made against an old one, like a git host. `commit` and `rewriteHistory`
 * stand in for another device changing the remote.
 */
export class MemoryBackend implements Backend {
	private files = new Map<string, string>();
	// Content by hash, kept forever, so that a listing taken at an older
	// revision can still be fetched.
	private readonly contents = new Map<string, Uint8Array>();
	private history: string[] = [];
	// The files of every revision, for an archive of one that is no longer the head.
	private readonly snapshots = new Map<string, ReadonlyMap<string, string>>();
	private counter = 0;
	/**
	 * Fails the last step of a push, as a connection that drops does:
	 * "lost-request" before the revision is made the head, "lost-answer"
	 * after. Either way the push rejects with "unreachable".
	 */
	publishFault: "lost-request" | "lost-answer" | null = null;
	/**
	 * Called once the revision of a push is made, and before it is made the
	 * head. A test throws from it for a push that is stopped right there.
	 */
	beforeMove: (() => void) | undefined;
	/** Whether a push that went through answers without the listing of its revision. */
	listingFault = false;
	/** The device name the last push that went through was given. */
	lastDeviceName: string | undefined;
	/** Whether the last push that went through was one that untracks (`PushRequest.untrack`). */
	lastUntrack: boolean | undefined;

	/** How many revisions the history holds. */
	get revisionCount(): number {
		return this.history.length;
	}

	get revision(): string | null {
		return this.history[this.history.length - 1] ?? null;
	}

	async hashContent(content: Uint8Array): Promise<string> {
		return blobHash(content);
	}

	async list(known: RemoteListing | null): Promise<ListResult> {
		if (known !== null && known.revision === this.revision) return { changed: false };
		return { changed: true, listing: { revision: this.revision, entries: this.entries() } };
	}

	async checkBase(base: string, head: string): Promise<BaseRelation> {
		if (head !== this.revision) throw new BackendError("not-found", `no such head: ${head}`);
		return this.history.includes(base) ? "continues" : "rewritten";
	}

	async *fetch(_revision: string | null, entries: readonly RemoteEntry[]): AsyncIterable<FetchedFile> {
		for (const entry of entries) {
			const content = this.contents.get(entry.hash);
			if (content === undefined) throw new BackendError("not-found", `no content: ${entry.path}`);
			yield { entry, content };
		}
	}

	/** The hashes `contentOf` was asked for, in order. */
	readonly contentRequests: string[] = [];
	/** Hashes the remote holds no content of any more, as after a force push. */
	readonly lostContents = new Set<string>();
	/** Thrown by `contentOf`, while set. */
	contentFailure: unknown = undefined;
	/** What `contentOf` answers in place of the content, while set: a remote that gives something else. */
	contentInstead: Uint8Array | undefined;

	async contentOf(hash: string): Promise<Uint8Array | null> {
		this.contentRequests.push(hash);
		if (this.contentFailure !== undefined) throw this.contentFailure;
		if (this.lostContents.has(hash)) return null;
		return this.contentInstead ?? this.contents.get(hash) ?? null;
	}

	async push(request: PushRequest): Promise<PushResult> {
		if (request.baseRevision !== this.revision) return { status: "stale" };
		if (request.writes.length === 0 && request.deletes.length === 0) return { status: "unchanged" };

		// Everything is checked before anything is changed.
		for (const entry of request.deletes) this.expectListed(entry);
		for (const file of request.writes) {
			if (file.replaces !== undefined) this.expectListed(file.replaces);
			else if (this.files.has(file.path)) throw new BackendError("other", `not a new path: ${file.path}`);
		}
		// What is read is what is sent, under the hash it has.
		const sent: { path: string; content: Uint8Array }[] = [];
		for (const file of request.writes) {
			const content = await file.read();
			if (content !== null) sent.push({ path: file.path, content });
		}
		const same = sent.every(({ path, content }) => this.files.get(path) === blobHash(content));
		if (request.deletes.length === 0 && same) return { status: "unchanged" };

		// The revision is made, and then made the head: two steps, like a
		// commit and the move of a branch.
		// A name of its own, also when it never becomes the head: another
		// device's revision must not be taken for this one.
		const revision = this.nextRevision();
		const written = sent.map(({ path, content }): RemoteEntry => {
			return { path, kind: "file", hash: blobHash(content), size: content.length };
		});
		await request.beforePublish?.({ revision, written });
		this.beforeMove?.();
		request.onPublish?.();
		if (this.publishFault === "lost-request") throw new BackendError("unreachable", "timed out");
		// Another device may have pushed while the files were read.
		if (request.baseRevision !== this.revision) return { status: "stale" };

		for (const entry of request.deletes) this.files.delete(entry.path);
		for (const { path, content } of sent) this.store(path, content);
		this.lastDeviceName = request.deviceName;
		this.lastUntrack = request.untrack === true;
		this.advance(revision);
		if (this.publishFault === "lost-answer") throw new BackendError("unreachable", "timed out");
		if (this.listingFault) return { status: "pushed", revision, written };
		return { status: "pushed", revision, written, listing: { revision, entries: this.entries() } };
	}

	/** The branch a remote without revisions gets its first one on; `null`: the configured one. */
	defaultBranch: string | null = null;
	/** Fails `start` after the revision was made, like an answer that never arrives. */
	startFault = false;

	async start(request: StartRequest): Promise<StartResult> {
		if (this.revision !== null) return { status: "stale" };
		if (this.defaultBranch !== null) return { status: "other-branch", defaultBranch: this.defaultBranch };
		this.store(request.path, request.content);
		this.lastDeviceName = request.deviceName;
		const revision = this.nextRevision();
		this.advance(revision);
		if (this.startFault) throw new BackendError("unreachable", "timed out");
		const entry: RemoteEntry = { path: request.path, kind: "file", hash: blobHash(request.content), size: request.content.length };
		return { status: "started", revision, entry };
	}

	/** Another device pushes: sets the given paths, or removes them with `null`. */
	commit(changes: Record<string, FileContent | null>): string {
		for (const [path, content] of Object.entries(changes)) {
			if (content === null) this.files.delete(path);
			else this.store(path, bytes(content));
		}
		return this.advance();
	}

	/**
	 * Changes what the head holds without making a revision. Nothing a real
	 * remote does; it stands in for a remote that holds other content than
	 * the listing of its head said (a listing that was worked out, and not
	 * asked for).
	 */
	amend(changes: Record<string, FileContent>): void {
		for (const [path, content] of Object.entries(changes)) this.store(path, bytes(content));
	}

	/** Another device force-pushes: the remote holds exactly `files`, on a new history. */
	rewriteHistory(files: Record<string, FileContent>): string {
		this.files = new Map();
		this.history = [];
		return this.commit(files);
	}

	read(path: string): Uint8Array | undefined {
		const hash = this.files.get(path);
		return hash === undefined ? undefined : this.contents.get(hash);
	}

	/** Path → content of every file at a revision. */
	protected filesAt(revision: string): Map<string, Uint8Array> {
		const snapshot = this.snapshots.get(revision);
		if (snapshot === undefined) throw new BackendError("not-found", `no such revision: ${revision}`);
		return new Map([...snapshot].map(([path, hash]) => [path, this.contents.get(hash) ?? new Uint8Array()]));
	}

	private expectListed(entry: RemoteEntry): void {
		if (this.files.get(entry.path) !== entry.hash) {
			throw new BackendError("not-as-listed", `not the listed entry: ${entry.path}`);
		}
	}

	private entries(): RemoteEntry[] {
		return [...this.files].map(([path, hash]) => ({
			path,
			kind: "file",
			hash,
			size: this.contents.get(hash)?.length ?? 0,
		}));
	}

	private store(path: string, content: Uint8Array): RemoteEntry {
		const hash = blobHash(content);
		this.contents.set(hash, content);
		this.files.set(path, hash);
		return { path, kind: "file", hash, size: content.length };
	}

	private nextRevision(): string {
		this.counter += 1;
		return `rev-${this.counter}`;
	}

	private advance(revision = this.nextRevision()): string {
		this.history.push(revision);
		this.snapshots.set(revision, new Map(this.files));
		return revision;
	}
}
