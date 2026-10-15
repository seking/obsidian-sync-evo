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
// laid on top. A push commits its writes together and deletes together,
// each file guarded by the version (`rev`) the listing had, so that nothing
// another device wrote first is written over or deleted, and the rest goes
// on.

import {
	type Backend,
	BackendError,
	type BaseRelation,
	type FetchedFile,
	type ListResult,
	type PushFile,
	type PushRefusal,
	type PushRequest,
	type PushResult,
	type RemoteEntry,
	type RemoteListing,
	type StartRequest,
	type StartResult,
} from "../backend";
import { fetchConcurrently, MAX_CONCURRENT_FETCH_BYTES } from "../concurrent-fetch";
import { type DropboxClient, DropboxApiError } from "./client";
import { dropboxContentHash } from "./content-hash";

/** The calls of the client a backend is built from. */
export type DropboxBackendClient = Pick<DropboxClient, "rpc" | "upload" | "download" | "wait">;

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
	/** The most the files fetched at once, and the contents sent at once, may add up to, in bytes. */
	readonly maxConcurrentFetchBytes?: number;
}

/** How many entries a page of `list_folder` holds at most. Dropbox's own limit is 2,000. */
const PAGE_LIMIT = 2000;
/** How many versions `list_revisions` answers at most. Also Dropbox's own limit. */
const REVISIONS_LIMIT = 100;
/**
 * How many contents are sent at once before they are committed together.
 * Sending takes no lock on Dropbox (R-3); the bound is for the device.
 */
const MAX_CONCURRENT_UPLOADS = 8;
/** How many files one commit (`finish_batch_v2`) or one `delete_batch` takes at most. Dropbox's own limit. */
const BATCH_LIMIT = 1000;
/** How many times the entries of a commit that met another write are committed again. */
const BATCH_RETRIES = 5;
/** The first wait before such entries are committed again, doubled each time; and the wait between the checks of a delete. */
const BATCH_WAIT_MS = 1000;
/** How many times a delete of several files is checked on before it is given up: about five minutes. */
const MAX_DELETE_CHECKS = 300;

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

/** What a file a push wrote, or would not, comes to. */
interface Writes {
	readonly written: RemoteEntry[];
	readonly refused: Refused[];
}

/** The reasons Dropbox gives for not taking a write. */
type Refusal = Extract<PushRefusal, "changed" | "no-space">;

interface Refused {
	readonly file: PushFile;
	readonly reason: Refusal;
}

/** What the deletes of a push come to. */
interface Removes {
	readonly deleted: number;
	readonly kept: readonly RemoteEntry[];
}

/** A file whose content Dropbox holds in a closed upload session, to be committed. */
interface Sent {
	/** Its place among the files of the push. */
	readonly index: number;
	readonly file: PushFile;
	readonly session: string;
	readonly size: number;
	readonly hash: string;
}

/** How a write is guarded: over the version listed, or where none was. */
function modeOf(replaces: RemoteEntry | undefined): unknown {
	return replaces?.version === undefined ? "add" : { ".tag": "update", update: replaces.version };
}

/**
 * The tags of an error within an answer of 200, from the outside in, as
 * Dropbox spells them in the summary of a 409 (`a/b/c`).
 */
function tagsOf(value: unknown): string {
	const tags: string[] = [];
	for (let at = value; isRecord(at) && typeof at[".tag"] === "string"; at = at[at[".tag"]]) tags.push(at[".tag"]);
	return tags.join("/");
}

/**
 * Why Dropbox would not take a write: another version is there, or a file
 * where none was listed; or the account is full, or its uploads are over
 * their limit. Any other error is thrown.
 */
function refusalOf(error: DropboxApiError): Refusal {
	if (error.is("path", "conflict")) return "changed";
	if (error.is("path", "insufficient_space") || error.is("upload_traffic_limit_reached")) return "no-space";
	throw error;
}

/**
 * Whether a delete Dropbox refused left the file gone: it was gone
 * already. False when another version than `parent_rev` is there
 * (`DeleteError.path_write`, `WriteError.conflict`), or a folder was put
 * where the file was. Any other error is thrown.
 */
function removedBy(error: DropboxApiError): boolean {
	if (error.is("path_lookup", "not_found")) return true;
	if (error.is("path_write", "conflict")) return false;
	throw error;
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
	 * Writes, then deletes, in the order that leaves the remote whole the
	 * longest: a delete that makes room for a write of the same path in
	 * another case goes before that write; every other delete after the
	 * writes. What another device changed first is left as it is
	 * (`PushFile.refused`, `kept`), and the rest goes on.
	 *
	 * Several files are written as one: their contents are sent at once,
	 * each into an upload session, and committed together in one call.
	 * Dropbox locks the user's whole Dropbox for each commit, not while
	 * content comes in, and a commit of one file took about 1.4 seconds
	 * (R-3). Several deletes are one call too.
	 *
	 * A push that untracks writes the `.gitignore` first and deletes only
	 * once it is through: a delete that came first would have the other
	 * devices delete files the rules have not told them to keep. When the
	 * remote would not take the `.gitignore`, nothing is deleted ("stale").
	 */
	async push(request: PushRequest): Promise<PushResult> {
		if (request.baseRevision === null) return { status: "stale" };
		const kept: RemoteEntry[] = [];
		let deleted = 0;
		const writing = new Set(request.writes.map((file) => file.path.toLowerCase()));
		const first = request.deletes.filter((entry) => writing.has(entry.path.toLowerCase()));
		const rest = request.deletes.filter((entry) => !writing.has(entry.path.toLowerCase()));
		const count = (removed: { readonly deleted: number; readonly kept: readonly RemoteEntry[] }): void => {
			deleted += removed.deleted;
			kept.push(...removed.kept);
		};

		count(await this.removeEach(first));
		const { written, refused } = request.writes.length > 1 ? await this.writeTogether(request.writes) : await this.writeEach(request.writes);
		if (refused.length > 0 && request.untrack === true) return { status: "stale" };
		for (const { file, reason } of refused) file.refused?.(reason);
		count(rest.length > 1 ? await this.removeTogether(rest) : await this.removeEach(rest));

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
	 * The content of a file to be written, and its hash; `null` when there
	 * is nothing to send: it read as `null`, or as what the remote holds
	 * already, which is then `written` as the version that is there.
	 */
	private async contentToSend(file: PushFile, written: RemoteEntry[]): Promise<{ content: Uint8Array; hash: string } | null> {
		this.throwIfCancelled("push");
		const content = await file.read();
		if (content === null) return null;
		const hash = await this.hashContent(content);
		if (file.replaces !== undefined && file.replaces.hash === hash) {
			written.push({ ...file.replaces, path: file.path, hash });
			return null;
		}
		return { content, hash };
	}

	/** Writes each file by its own call: for a single file, one call fewer than a commit. */
	private async writeEach(files: readonly PushFile[]): Promise<Writes> {
		const written: RemoteEntry[] = [];
		const refused: Refused[] = [];
		for (const file of files) {
			const sending = await this.contentToSend(file, written);
			if (sending === null) continue;
			const result = await this.write(file.path, sending.content, file.replaces);
			if (result === "changed" || result === "no-space") refused.push({ file, reason: result });
			else written.push({ ...result, path: file.path, hash: sending.hash });
		}
		return { written, refused };
	}

	/**
	 * Sends the contents several at a time, each into an upload session that
	 * is closed with it, and then commits them all (`finish_batch_v2`). The
	 * contents on their way are bounded like a fetch: by a count, and by the
	 * bytes they hold, as all of them are in memory; a file is read only
	 * once there is room for it. One larger than the bound on bytes goes
	 * alone. Read one at a time, in order.
	 *
	 * Stopped before the commit, nothing is written: Dropbox drops the
	 * sessions.
	 */
	private async writeTogether(files: readonly PushFile[]): Promise<Writes> {
		const written: RemoteEntry[] = [];
		const sent: Sent[] = [];
		const maxBytes = this.options.maxConcurrentFetchBytes ?? MAX_CONCURRENT_FETCH_BYTES;
		const sending = new Set<Promise<void>>();
		let heldBytes = 0;
		// In an object: it is set from callbacks, which the type checker does
		// not follow for a variable.
		const state: { failure: { readonly error: unknown } | null } = { failure: null };

		// Until there is room for `size` more bytes, or nothing is on its way.
		const roomFor = async (size: number): Promise<void> => {
			while (sending.size > 0 && (sending.size >= MAX_CONCURRENT_UPLOADS || heldBytes + size > maxBytes)) {
				await Promise.race(sending);
			}
		};
		for (const [index, file] of files.entries()) {
			// By the size planned before it is read, so that what is read
			// waits within the bound too; again by the size read, which may
			// have grown.
			await roomFor(file.size);
			if (state.failure !== null) break;
			const one = await this.contentToSend(file, written);
			if (one === null) continue;
			const size = one.content.byteLength;
			await roomFor(size);
			if (state.failure !== null) break;
			this.throwIfCancelled("push");
			heldBytes += size;
			const on: Promise<void> = this.client
				.upload({ close: true, content_hash: one.hash }, one.content, "files/upload_session/start")
				.then(
					(json) => {
						if (!isRecord(json) || typeof json.session_id !== "string") throw malformed("start an upload");
						sent.push({ index, file, session: json.session_id, size, hash: one.hash });
					},
				)
				.catch((error: unknown) => {
					state.failure ??= { error };
				})
				.finally(() => {
					heldBytes -= size;
					sending.delete(on);
				});
			sending.add(on);
		}
		await Promise.all(sending);
		if (state.failure !== null) throw state.failure.error;

		// In the order asked for, whatever order the sessions came back in.
		sent.sort((a, b) => a.index - b.index);
		const refused: Refused[] = [];
		for (let at = 0; at < sent.length; at += BATCH_LIMIT) {
			await this.commit(sent.slice(at, at + BATCH_LIMIT), written, refused);
		}
		return { written, refused };
	}

	/**
	 * Commits the files of closed upload sessions in one call. Dropbox
	 * answers for each entry, in the order given: written, or refused as a
	 * single write would be. An entry that met another write is committed
	 * again, alone with the others that did, from the same session.
	 */
	private async commit(batch: readonly Sent[], written: RemoteEntry[], refused: Refused[]): Promise<void> {
		const what = "files/upload_session/finish_batch_v2";
		let left = batch;
		for (let retries = 0; left.length > 0; retries++) {
			this.throwIfCancelled("push");
			const json = await this.client.rpc(what, {
				entries: left.map((one) => ({
					cursor: { session_id: one.session, offset: one.size },
					commit: { path: this.full(one.file.path), mode: modeOf(one.file.replaces), autorename: false, mute: true, strict_conflict: false },
				})),
			});
			const entries = isRecord(json) && Array.isArray(json.entries) ? json.entries : null;
			if (entries === null || entries.length !== left.length) throw malformed("commit the files");
			const again: Sent[] = [];
			for (const [i, value] of entries.entries()) {
				const one = left[i] as Sent;
				if (isRecord(value) && value[".tag"] === "success") {
					written.push({ ...this.writtenEntry(one.file.path, value, "commit the files"), hash: one.hash });
					continue;
				}
				const error = new DropboxApiError(what, isRecord(value) ? tagsOf(value.failure) : "");
				if (error.is("too_many_write_operations")) again.push(one);
				else refused.push({ file: one.file, reason: refusalOf(error) });
			}
			if (again.length > 0) {
				if (retries >= BATCH_RETRIES) throw new BackendError("unreachable", `${what}: Dropbox stayed busy with other writes`);
				await this.client.wait("push", BATCH_WAIT_MS * 2 ** retries);
			}
			left = again;
		}
	}

	/**
	 * Writes one file: over the version `replaces` names, or as a new one.
	 * "changed" when Dropbox holds another version there, or a file where
	 * none was listed; "no-space" when the account has no room for it.
	 */
	private async write(path: string, content: Uint8Array, replaces: RemoteEntry | undefined): Promise<RemoteEntry | Refusal> {
		let json: unknown;
		try {
			json = await this.client.upload({ path: this.full(path), mode: modeOf(replaces), autorename: false, mute: true, strict_conflict: false }, content);
		} catch (error) {
			if (error instanceof DropboxApiError) return refusalOf(error);
			throw error;
		}
		return this.writtenEntry(path, json, "upload");
	}

	/** The entry of a file Dropbox answered for as written. */
	private writtenEntry(path: string, json: unknown, what: string): RemoteEntry {
		const item = itemOf(what, { ...(isRecord(json) ? json : {}), ".tag": "file" });
		if (item === null) throw malformed(what);
		return {
			path,
			kind: "file",
			hash: item.hash ?? "",
			...(item.size === undefined ? {} : { size: item.size }),
			...(item.rev === undefined ? {} : { version: item.rev }),
		};
	}

	/** Deletes each file by its own call, in order. */
	private async removeEach(entries: readonly RemoteEntry[]): Promise<Removes> {
		let deleted = 0;
		const kept: RemoteEntry[] = [];
		for (const entry of entries) {
			this.throwIfCancelled("push");
			if (await this.remove(entry)) deleted += 1;
			else kept.push(entry);
		}
		return { deleted, kept };
	}

	/**
	 * Deletes the files in one call each thousand (`delete_batch`), each only
	 * while it is the version the listing named. Dropbox answers later, even
	 * for a few files: it is asked again until it is done. An entry, or a
	 * call, that met another write is deleted by its own call, which waits
	 * as asked.
	 */
	private async removeTogether(entries: readonly RemoteEntry[]): Promise<Removes> {
		let deleted = 0;
		const kept: RemoteEntry[] = [];
		for (let at = 0; at < entries.length; at += BATCH_LIMIT) {
			const batch = entries.slice(at, at + BATCH_LIMIT);
			this.throwIfCancelled("push");
			const answer = await this.batchDelete(batch);
			const each: RemoteEntry[] = [];
			if (answer === "busy") each.push(...batch);
			else {
				if (answer.length !== batch.length) throw malformed("delete the files");
				for (const [i, value] of answer.entries()) {
					const entry = batch[i] as RemoteEntry;
					if (isRecord(value) && value[".tag"] === "success") {
						deleted += 1;
						continue;
					}
					const error = new DropboxApiError("files/delete_batch", isRecord(value) ? tagsOf(value.failure) : "");
					if (error.is("too_many_write_operations")) each.push(entry);
					else if (removedBy(error)) deleted += 1;
					else kept.push(entry);
				}
			}
			const one = await this.removeEach(each);
			deleted += one.deleted;
			kept.push(...one.kept);
		}
		return { deleted, kept };
	}

	/** The entries of a finished `delete_batch`, or "busy" when it failed for another write. */
	private async batchDelete(batch: readonly RemoteEntry[]): Promise<unknown[] | "busy"> {
		let answer = await this.client.rpc("files/delete_batch", {
			entries: batch.map((entry) => ({
				path: this.full(entry.path),
				...(entry.version === undefined ? {} : { parent_rev: entry.version }),
			})),
		});
		const job = isRecord(answer) && typeof answer.async_job_id === "string" ? answer.async_job_id : null;
		for (let checks = 0; isRecord(answer) && (answer[".tag"] === "async_job_id" || answer[".tag"] === "in_progress"); checks++) {
			if (job === null || checks >= MAX_DELETE_CHECKS) throw new BackendError("unreachable", "files/delete_batch: Dropbox did not finish");
			await this.client.wait("push", BATCH_WAIT_MS);
			answer = await this.client.rpc("files/delete_batch/check", { async_job_id: job });
		}
		if (!isRecord(answer)) throw malformed("delete the files");
		if (answer[".tag"] === "failed") {
			const error = new DropboxApiError("files/delete_batch", tagsOf(answer.failed));
			if (error.is("too_many_write_operations")) return "busy";
			throw error;
		}
		const entries: unknown = answer.entries;
		if (answer[".tag"] !== "complete" || !Array.isArray(entries)) throw malformed("delete the files");
		return entries as unknown[];
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
			return removedBy(error);
		}
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}
}
