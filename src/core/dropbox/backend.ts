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

// A folder in the app folder of Dropbox as a remote (R-3, R-4). Dropbox has
// no commit: the revision of a listing is the cursor of `list_folder`, and
// the listing is kept with it, so that the next one is the changes since,
// laid on top. A push writes file by file, each write and delete guarded by
// the version (`rev`) the listing had, so that nothing another device wrote
// first is written over or deleted.

import {
	type Backend,
	BackendError,
	type BaseRelation,
	type FetchedFile,
	type ListResult,
	type PushRequest,
	type PushResult,
	type RemoteEntry,
	type RemoteListing,
	type StartRequest,
	type StartResult,
} from "../backend";
import { fetchConcurrently } from "../concurrent-fetch";
import { type DropboxClient, DropboxApiError } from "./client";
import { dropboxContentHash } from "./content-hash";

/** The calls of the client a backend is built from. */
export type DropboxBackendClient = Pick<DropboxClient, "rpc" | "upload" | "download">;

export interface DropboxBackendOptions {
	/**
	 * The folder of the vault in the app folder, by its name (R-4). Every
	 * path of a listing is below it, and spelled without it.
	 */
	readonly folder: string;
	/** Awaited between the blocks of a large file while it is hashed. */
	readonly yieldControl?: () => Promise<void>;
	/** Once aborted, a fetch starts nothing more, and a push sends nothing more. */
	readonly signal?: AbortSignal;
	/** How many files are fetched at once. */
	readonly maxConcurrentFetches?: number;
	/** The most the files fetched at once may add up to, in bytes. */
	readonly maxConcurrentFetchBytes?: number;
}

/** How many entries a page of `list_folder` holds at most. Dropbox's own limit is 2,000. */
const PAGE_LIMIT = 2000;
/** How many versions `list_revisions` answers at most. Also Dropbox's own limit. */
const REVISIONS_LIMIT = 100;

/** An entry of `list_folder` and of its `continue`, as far as it is read. */
interface ListedItem {
	readonly tag: "file" | "folder" | "deleted";
	readonly lower: string;
	readonly display: string;
	readonly rev?: string;
	readonly size?: number;
	readonly hash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): BackendError {
	return new BackendError("other", `${what}: the response is not in the expected form`);
}

/**
 * An entry of a listing as far as it is read, or `null` for a file that has
 * no content to sync: one Dropbox cannot download (a Paper document, made
 * in the app of Dropbox), which has no `content_hash`. Left out like an
 * empty folder.
 */
function itemOf(what: string, value: unknown): ListedItem | null {
	if (!isRecord(value)) throw malformed(what);
	const tag = value[".tag"];
	const lower = value.path_lower;
	const display = value.path_display;
	if ((tag !== "file" && tag !== "folder" && tag !== "deleted") || typeof lower !== "string" || typeof display !== "string") {
		throw malformed(what);
	}
	if (tag !== "file") return { tag, lower, display };
	const { rev, size, content_hash } = value;
	if (value.is_downloadable === false || content_hash === undefined) return null;
	if (typeof rev !== "string" || typeof size !== "number" || typeof content_hash !== "string") throw malformed(what);
	return { tag, lower, display, rev, size, hash: content_hash };
}

interface Page {
	readonly items: ListedItem[];
	readonly cursor: string;
	readonly hasMore: boolean;
}

function pageOf(what: string, value: unknown): Page {
	if (!isRecord(value) || !Array.isArray(value.entries) || typeof value.cursor !== "string" || typeof value.has_more !== "boolean") {
		throw malformed(what);
	}
	const items = value.entries.map((entry) => itemOf(what, entry)).filter((item): item is ListedItem => item !== null);
	return { items, cursor: value.cursor, hasMore: value.has_more };
}

/** The last segment of a path. */
function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The entries of a listing by their folded path, and how its folders are
 * spelled. Dropbox does not tell case apart, and spells the parents of a
 * path in `path_display` as they were once, not always as they are: only
 * the last segment is sure. The parents are spelled as the listing already
 * spells them, or as the folder entries Dropbox gave say.
 */
class Tree {
	private readonly files = new Map<string, RemoteEntry>();
	private readonly folders = new Map<string, string>();

	constructor(entries: readonly RemoteEntry[]) {
		for (const entry of entries) {
			this.files.set(entry.path.toLowerCase(), entry);
			this.learnParents(entry.path);
		}
	}

	get entries(): RemoteEntry[] {
		return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	/** Lays one item on the tree, relative to the root: what `list_folder/continue` asks of its order. */
	apply(item: ListedItem, lower: string, display: string): void {
		const path = this.spell(lower, display);
		if (item.tag === "deleted") {
			this.remove(lower);
			return;
		}
		if (item.tag === "folder") {
			// A file that was where the folder is now.
			this.files.delete(lower);
			this.folders.set(lower, path);
			this.learnParents(path);
			return;
		}
		// A folder that was where the file is now: everything below it.
		this.folders.delete(lower);
		this.removeBelow(lower);
		this.files.set(lower, {
			path,
			kind: "file",
			hash: item.hash ?? "",
			...(item.size === undefined ? {} : { size: item.size }),
			...(item.rev === undefined ? {} : { version: item.rev }),
		});
		this.learnParents(path);
	}

	private remove(lower: string): void {
		this.files.delete(lower);
		this.folders.delete(lower);
		this.removeBelow(lower);
	}

	private removeBelow(lower: string): void {
		const prefix = `${lower}/`;
		for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
		for (const key of [...this.folders.keys()]) if (key.startsWith(prefix)) this.folders.delete(key);
	}

	private learnParents(path: string): void {
		for (let parent = parentOf(path); parent !== ""; parent = parentOf(parent)) {
			const lower = parent.toLowerCase();
			if (this.folders.has(lower)) return;
			this.folders.set(lower, parent);
		}
	}

	/** `display`, with each parent spelled as the tree knows it. */
	private spell(lower: string, display: string): string {
		const parent = parentOf(lower);
		const name = nameOf(display);
		if (parent === "") return name;
		const spelled = this.folders.get(parent) ?? this.spell(parent, parentOf(display));
		return `${spelled}/${name}`;
	}
}

export class DropboxBackend implements Backend {
	private readonly client: DropboxBackendClient;
	private readonly options: DropboxBackendOptions;
	/** The folder of the vault as Dropbox takes a path: `/name`. */
	private readonly root: string;
	private readonly rootLower: string;
	/**
	 * The listing this backend last answered or built, which a push lays its
	 * changes on to answer the listing after it. A listing is a cursor and
	 * the entries together; neither is of use alone.
	 */
	private last: RemoteListing | null = null;

	constructor(client: DropboxBackendClient, options: DropboxBackendOptions) {
		this.client = client;
		this.options = options;
		this.root = `/${options.folder}`;
		this.rootLower = this.root.toLowerCase();
	}

	hashContent(content: Uint8Array): Promise<string> {
		return dropboxContentHash(content, this.options.yieldControl);
	}

	/** The path Dropbox takes for a path of the listing. */
	private full(path: string): string {
		return `${this.root}/${path}`;
	}

	/**
	 * A path below the root, folded and as spelled, or `null` for the root
	 * itself, and for anything not below it, which a listing of the root
	 * never holds.
	 */
	private relative(item: ListedItem): { readonly lower: string; readonly display: string } | null {
		const prefix = `${this.rootLower}/`;
		if (!item.lower.startsWith(prefix)) return null;
		const lower = item.lower.slice(prefix.length);
		// The display has the same number of segments as the folded path.
		const depth = this.root.split("/").length;
		const display = item.display.split("/").slice(depth).join("/");
		return lower === "" ? null : { lower, display };
	}

	/**
	 * With a listing whose cursor Dropbox still takes, the changes since are
	 * laid on its entries, in the order Dropbox gives them; with none, or one
	 * Dropbox answers `reset` to, the whole folder is listed. A folder that
	 * is not there is an empty remote without a revision, like a repository
	 * without commits. No page left unread: a failure on the way fails it all.
	 */
	async list(known: RemoteListing | null): Promise<ListResult> {
		if (known !== null && known.revision !== null) {
			const changes = await this.changesSince(known.revision);
			if (changes !== null) {
				if (changes.items.length === 0) {
					this.last = known;
					return { changed: false };
				}
				// The folder of the vault itself was deleted: an empty remote,
				// as when it is listed and not there. Not every file deleted
				// one by one, which a pull would delete on the device.
				if (changes.items.some((item) => item.tag === "deleted" && item.lower === this.rootLower)) {
					const empty = { revision: null, entries: [] };
					this.last = empty;
					return { changed: true, listing: empty };
				}
				const tree = new Tree(known.entries);
				this.lay(tree, changes.items);
				const listing = { revision: changes.cursor, entries: tree.entries };
				this.last = listing;
				return { changed: true, listing };
			}
		}
		const listing = await this.listAll();
		this.last = listing;
		return { changed: true, listing };
	}

	private lay(tree: Tree, items: readonly ListedItem[]): void {
		for (const item of items) {
			const path = this.relative(item);
			if (path !== null) tree.apply(item, path.lower, path.display);
		}
	}

	/** Every page of the changes since `cursor`, or `null` when Dropbox will not go on from it (`reset`). */
	private async changesSince(cursor: string): Promise<Page | null> {
		const what = "list the changes";
		const items: ListedItem[] = [];
		let next = cursor;
		for (;;) {
			let page: Page;
			try {
				page = pageOf(what, await this.client.rpc("files/list_folder/continue", { cursor: next }));
			} catch (error) {
				if (error instanceof DropboxApiError && (error.is("reset") || error.is("path", "not_found"))) return null;
				throw error;
			}
			items.push(...page.items);
			next = page.cursor;
			if (!page.hasMore) return { items, cursor: next, hasMore: false };
		}
	}

	private async listAll(): Promise<RemoteListing> {
		const what = "list the folder";
		let page: Page;
		try {
			page = pageOf(
				what,
				// What Dropbox cannot download is left out of the cursor as well.
				await this.client.rpc("files/list_folder", {
					path: this.root,
					recursive: true,
					include_deleted: false,
					include_non_downloadable_files: false,
					limit: PAGE_LIMIT,
				}),
			);
		} catch (error) {
			if (error instanceof DropboxApiError && error.is("path", "not_found")) return { revision: null, entries: [] };
			throw error;
		}
		const tree = new Tree([]);
		for (;;) {
			// Folders come before what is in them, so their spelling is known
			// by the time a file below them is laid.
			this.lay(tree, page.items);
			if (!page.hasMore) return { revision: page.cursor, entries: tree.entries };
			page = pageOf(what, await this.client.rpc("files/list_folder/continue", { cursor: page.cursor }));
		}
	}

	checkBase(_base: string, _head: string): Promise<BaseRelation> {
		// No history to rewrite: a cursor only ever moves on.
		return Promise.resolve("continues");
	}

	/**
	 * Each file by the version the listing named (`rev:`), so that what
	 * comes is what was listed, also when the file changed since. Several at
	 * a time.
	 */
	fetch(_revision: string | null, entries: readonly RemoteEntry[]): AsyncIterable<FetchedFile> {
		const { signal, maxConcurrentFetches, maxConcurrentFetchBytes } = this.options;
		return fetchConcurrently(entries, (entry) => this.read(entry), {
			...(signal === undefined ? {} : { signal }),
			...(maxConcurrentFetches === undefined ? {} : { maxCount: maxConcurrentFetches }),
			...(maxConcurrentFetchBytes === undefined ? {} : { maxBytes: maxConcurrentFetchBytes }),
		});
	}

	private async read(entry: RemoteEntry): Promise<Uint8Array> {
		if (entry.kind !== "file") throw new BackendError("other", `fetch: not a file: ${entry.path}`);
		const path = entry.version === undefined ? this.full(entry.path) : `rev:${entry.version}`;
		const { content } = await this.client.download({ path }, entry.size ?? 0);
		return content;
	}

	/**
	 * The content the file at `path` had with `hash`, found among its
	 * versions (`list_revisions`). Only the latest page of them is looked at:
	 * a file saved more than a hundred times since is not merged.
	 */
	async contentOf(hash: string, path: string): Promise<Uint8Array | null> {
		let json: unknown;
		try {
			json = await this.client.rpc("files/list_revisions", { path: this.full(path), mode: "path", limit: REVISIONS_LIMIT });
		} catch (error) {
			if (error instanceof DropboxApiError) return null;
			throw error;
		}
		if (!isRecord(json) || !Array.isArray(json.entries)) throw malformed("list the versions");
		for (const value of json.entries) {
			if (!isRecord(value) || value.content_hash !== hash || typeof value.rev !== "string") continue;
			try {
				return (await this.client.download({ path: `rev:${value.rev}` }, typeof value.size === "number" ? value.size : 0)).content;
			} catch (error) {
				if (error instanceof DropboxApiError) return null;
				throw error;
			}
		}
		return null;
	}

	/**
	 * The first file of a folder that is not there yet. Dropbox makes the
	 * folder with it.
	 */
	async start(request: StartRequest): Promise<StartResult> {
		const written = await this.write(request.path, request.content, undefined);
		if (written === "changed") return { status: "stale" };
		if (written === "no-space") throw new BackendError("other", "start: there is no room left on Dropbox");
		const listing = await this.listAll();
		this.last = listing;
		if (listing.revision === null) throw new BackendError("other", "start: the folder is not there after a file was written to it");
		return { status: "started", revision: listing.revision, entry: written, listing };
	}

	/**
	 * Writes, then deletes, one at a time, and in the order that leaves the
	 * remote whole the longest: a delete that makes room for a write of the
	 * same path in another case goes before that write; every other delete
	 * after the writes. What another device changed first is left as it is
	 * (`PushFile.refused`, `kept`), and the rest goes on.
	 *
	 * A push that untracks writes the `.gitignore` first and deletes only
	 * once it is through: a delete that came first would have the other
	 * devices delete files the rules have not told them to keep. When the
	 * remote would not take the `.gitignore`, nothing is deleted ("stale").
	 */
	async push(request: PushRequest): Promise<PushResult> {
		if (request.baseRevision === null) return { status: "stale" };
		const written: RemoteEntry[] = [];
		const kept: RemoteEntry[] = [];
		let deleted = 0;
		const writing = new Set(request.writes.map((file) => file.path.toLowerCase()));
		const first = request.deletes.filter((entry) => writing.has(entry.path.toLowerCase()));
		const rest = request.deletes.filter((entry) => !writing.has(entry.path.toLowerCase()));
		const remove = async (entry: RemoteEntry): Promise<void> => {
			this.throwIfCancelled("push");
			if (await this.remove(entry)) deleted += 1;
			else kept.push(entry);
		};

		for (const entry of first) await remove(entry);
		for (const file of request.writes) {
			this.throwIfCancelled("push");
			const content = await file.read();
			if (content === null) continue;
			const hash = await this.hashContent(content);
			// Already what the remote holds: nothing to write, and it is
			// recorded as the version that is there.
			if (file.replaces !== undefined && file.replaces.hash === hash) {
				written.push({ ...file.replaces, path: file.path, hash });
				continue;
			}
			const result = await this.write(file.path, content, file.replaces);
			if (result === "changed" || result === "no-space") {
				if (request.untrack === true) return { status: "stale" };
				file.refused?.(result);
				continue;
			}
			written.push({ ...result, path: file.path, hash });
		}
		for (const entry of rest) await remove(entry);

		const keptPart = kept.length === 0 ? {} : { kept };
		if (written.length === 0 && deleted === 0) return { status: "unchanged", ...keptPart };
		const listing = await this.after(request.baseRevision);
		if (listing === null) {
			// The push went through, and Dropbox could not say what it
			// holds now. A cursor that names nothing the next sync can go on
			// from: it lists the folder again.
			return { status: "pushed", revision: request.baseRevision, written, ...keptPart };
		}
		// A file another device wrote over in the moment since: the listing
		// holds its version, and the next pull takes it up as changed there.
		// Recorded as written, it would read as the same on both sides.
		const listed = new Map(listing.entries.map((entry) => [entry.path.toLowerCase(), entry.version]));
		const still = written.filter((entry) => listed.get(entry.path.toLowerCase()) === entry.version);
		return { status: "pushed", revision: listing.revision ?? request.baseRevision, written: still, listing, ...keptPart };
	}

	/**
	 * The listing after a push: the changes since `base` laid on the listing
	 * of `base`, which this backend answered before the push. `null` when it
	 * has no such listing, or Dropbox could not be asked.
	 */
	private async after(base: string): Promise<RemoteListing | null> {
		const last = this.last;
		if (last === null || last.revision !== base) return null;
		try {
			const listed = await this.list(last);
			return listed.changed ? listed.listing : last;
		} catch (error) {
			if (error instanceof BackendError && error.kind === "cancelled") throw error;
			return null;
		}
	}

	/**
	 * Writes one file: over the version `replaces` names, or as a new one.
	 * "changed" when Dropbox holds another version there, or a file where
	 * none was listed; "no-space" when the account has no room for it.
	 */
	private async write(
		path: string,
		content: Uint8Array,
		replaces: RemoteEntry | undefined,
	): Promise<RemoteEntry | "changed" | "no-space"> {
		const mode = replaces?.version === undefined ? "add" : { ".tag": "update", update: replaces.version };
		let json: unknown;
		try {
			json = await this.client.upload({ path: this.full(path), mode, autorename: false, mute: true, strict_conflict: false }, content);
		} catch (error) {
			if (error instanceof DropboxApiError && error.is("path", "conflict")) return "changed";
			// The account is full, or its uploads are over their limit.
			if (error instanceof DropboxApiError && (error.is("path", "insufficient_space") || error.is("upload_traffic_limit_reached"))) {
				return "no-space";
			}
			throw error;
		}
		const item = itemOf("upload", { ...(isRecord(json) ? json : {}), ".tag": "file" });
		if (item === null) throw malformed("upload");
		return {
			path,
			kind: "file",
			hash: item.hash ?? "",
			...(item.size === undefined ? {} : { size: item.size }),
			...(item.rev === undefined ? {} : { version: item.rev }),
		};
	}

	/**
	 * Deletes one file, only while it is the version the listing named.
	 * True when it is gone, also when it was gone already; false when
	 * Dropbox holds another version there.
	 */
	private async remove(entry: RemoteEntry): Promise<boolean> {
		try {
			await this.client.rpc("files/delete_v2", {
				path: this.full(entry.path),
				...(entry.version === undefined ? {} : { parent_rev: entry.version }),
			});
			return true;
		} catch (error) {
			if (!(error instanceof DropboxApiError)) throw error;
			if (error.is("path_lookup", "not_found")) return true;
			// Another version than `parent_rev` (`DeleteError.path_write`,
			// `WriteError.conflict`), or a folder put where the file was.
			if (error.is("path_write", "conflict")) return false;
			throw error;
		}
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}
}
