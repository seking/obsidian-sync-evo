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

	get revision(): string | null {
		return this.history[this.history.length - 1] ?? null;
	}

	async hashContent(content: Uint8Array): Promise<string> {
		return blobHash(content);
	}

	async list(known: string | null): Promise<ListResult> {
		if (known !== null && known === this.revision) return { changed: false };
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

	async push(request: PushRequest): Promise<PushResult> {
		if (request.baseRevision !== this.revision) return { status: "stale" };
		if (request.writes.length === 0 && request.deletes.length === 0) {
			return { status: "pushed", revision: this.revision, written: [] };
		}

		// Everything is checked before anything is changed.
		for (const entry of request.deletes) this.expectListed(entry);
		const contents: Uint8Array[] = [];
		for (const file of request.writes) {
			if (file.replaces !== undefined) this.expectListed(file.replaces);
			const content = await file.read();
			if (blobHash(content) !== file.hash) {
				throw new BackendError("other", `content does not match its hash: ${file.path}`);
			}
			contents.push(content);
		}

		for (const entry of request.deletes) this.files.delete(entry.path);
		const written = request.writes.map((file, i) => this.store(file.path, contents[i] ?? new Uint8Array()));
		this.advance();
		return { status: "pushed", revision: this.revision, written };
	}

	/** Another device pushes: sets the given paths, or removes them with `null`. */
	commit(changes: Record<string, FileContent | null>): string {
		for (const [path, content] of Object.entries(changes)) {
			if (content === null) this.files.delete(path);
			else this.store(path, bytes(content));
		}
		return this.advance();
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
			throw new BackendError("other", `not the listed entry: ${entry.path}`);
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

	private advance(): string {
		this.counter += 1;
		const revision = `rev-${this.counter}`;
		this.history.push(revision);
		this.snapshots.set(revision, new Map(this.files));
		return revision;
	}
}
