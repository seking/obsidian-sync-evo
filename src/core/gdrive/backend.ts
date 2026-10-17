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

// A folder on Google Drive as a remote (R-1, R-2, R-3): `Sync Evo/<name>` at
// the top of the user's Drive, made by Sync Evo, which sees nothing else
// (`drive.file`). Drive has no commit and no path: a file is an id with a
// name and a parent folder. The revision of a listing is a page token of the
// changes, kept with the folders of the vault, so that the next listing is
// the changes since, laid on top. A push writes and trashes file by file,
// each only while no change since the listing was made to it.

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
import { DRIVE_API, type DriveClient, DriveApiError } from "./client";
import { DriveDuplicateFolderError, DriveFolderGoneError } from "./errors";

/** The calls of the client a backend is built from. */
export type DriveBackendClient = Pick<DriveClient, "getJson" | "sendJson" | "upload" | "download">;

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** The folder at the top of Drive that holds the folder of each vault (R-1). */
export const SYNC_EVO_FOLDER = "Sync Evo";

export interface DriveBackendOptions {
	/** The name of the folder of the vault, in `Sync Evo` at the top of Drive. */
	readonly folder: string;
	/**
	 * The id of that folder this device keeps, or `null` while it has none:
	 * it is then looked for by its name, and made by the first upload.
	 */
	readonly folderId: string | null;
	/** Told the id of the folder of the vault once it was found by its name, or made. */
	readonly onFolderFound?: (id: string) => void;
	/**
	 * Told when the folder `Sync Evo` at the top of Drive was made, each
	 * time a sync looks it up: the start of the free time of the account
	 * (`paid.ts`). Asked for with the lookups a sync makes anyway.
	 */
	readonly onSince?: (createdAt: number) => void;
	/** Once aborted, a fetch starts nothing more, and a push sends nothing more. */
	readonly signal?: AbortSignal;
	/** How many files are fetched at once. */
	readonly maxConcurrentFetches?: number;
	/** The most the files fetched at once, and the contents sent at once, may add up to, in bytes. */
	readonly maxConcurrentFetchBytes?: number;
}

/** What is asked of a file in a listing, in the changes, and of a file written. */
const FILE_FIELDS = "id,name,mimeType,parents,size,sha256Checksum,trashed";
/** What is asked of the folders that are looked up by their names: also when each was made (`onSince`). */
const FOLDER_FIELDS = `${FILE_FIELDS},createdTime`;
/** The most entries a page of a listing or of the changes holds. Google's own limit. */
const PAGE_SIZE = 1000;
/** How many files are written, or trashed, at once. */
const MAX_CONCURRENT_WRITES = 4;
/** The types of Google's own documents, which have no content to download, and of shortcuts. */
const GOOGLE_APPS = "application/vnd.google-apps.";
/** In front of a revision of this backend, and of the version of its form. */
const REVISION_PREFIX = "gdrive1:";

/** A file or a folder of Drive, as far as it is read. */
interface DriveItem {
	readonly id: string;
	readonly name: string;
	readonly folder: boolean;
	/** The one parent: Drive has given every file a single one since 2020. */
	readonly parent: string | null;
	readonly trashed: boolean;
	/** A document of Google's own, or a shortcut: nothing to sync. */
	readonly skip: boolean;
	readonly hash?: string;
	readonly size?: number;
	/** When it was made, where that was asked for (`FOLDER_FIELDS`). */
	readonly createdAt?: number;
}

/** A change since a page token: the file as it is now, or the id of one that is no longer to be seen. */
type Change = { readonly removed: true; readonly id: string } | { readonly removed: false; readonly id: string; readonly item: DriveItem };

interface Folder {
	readonly parent: string;
	readonly name: string;
}

/** What a revision holds: where the changes go on from, and the folders of the vault then. */
interface DriveState {
	readonly token: string;
	readonly root: string;
	readonly folders: ReadonlyMap<string, Folder>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): BackendError {
	return new BackendError("other", `${what}: the response is not in the expected form`);
}

function itemOf(what: string, value: unknown): DriveItem {
	if (!isRecord(value)) throw malformed(what);
	const { id, name, mimeType, parents, trashed, sha256Checksum, size, createdTime } = value;
	if (typeof id !== "string" || typeof name !== "string" || typeof mimeType !== "string") throw malformed(what);
	const parent = Array.isArray(parents) && typeof parents[0] === "string" ? parents[0] : null;
	const folder = mimeType === DRIVE_FOLDER_MIME;
	const bytes = typeof size === "string" ? Number(size) : typeof size === "number" ? size : undefined;
	const created = typeof createdTime === "string" ? Date.parse(createdTime) : Number.NaN;
	return {
		id,
		name,
		folder,
		parent,
		trashed: trashed === true,
		skip: !folder && mimeType.startsWith(GOOGLE_APPS),
		...(typeof sha256Checksum === "string" ? { hash: sha256Checksum.toLowerCase() } : {}),
		...(bytes !== undefined && Number.isFinite(bytes) ? { size: bytes } : {}),
		...(Number.isFinite(created) ? { createdAt: created } : {}),
	};
}

/** A name that can be one segment of a path. A name Drive allows with a slash in it cannot. */
function isSegment(name: string): boolean {
	return name !== "" && name !== "." && name !== ".." && !name.includes("/");
}

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function byPath(a: RemoteEntry, b: RemoteEntry): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function encodeRevision(state: DriveState): string {
	const folders = [...state.folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, folder]) => [id, folder.parent, folder.name]);
	return `${REVISION_PREFIX}${JSON.stringify({ t: state.token, r: state.root, f: folders })}`;
}

export function decodeRevision(revision: string): DriveState | null {
	if (!revision.startsWith(REVISION_PREFIX)) return null;
	let json: unknown;
	try {
		json = JSON.parse(revision.slice(REVISION_PREFIX.length));
	} catch {
		return null;
	}
	if (!isRecord(json) || typeof json.t !== "string" || typeof json.r !== "string" || !Array.isArray(json.f)) return null;
	const folders = new Map<string, Folder>();
	for (const value of json.f as unknown[]) {
		if (!Array.isArray(value) || value.length !== 3) return null;
		const [id, parent, name] = value as unknown[];
		if (typeof id !== "string" || typeof parent !== "string" || typeof name !== "string") return null;
		folders.set(id, { parent, name });
	}
	return { token: json.t, root: json.r, folders };
}

/** The path of the folder `id` below `root`, `""` for the root, or `null` when it is not below it. */
function folderPath(folders: ReadonlyMap<string, Folder>, root: string, id: string): string | null {
	const names: string[] = [];
	for (let at = id, steps = 0; at !== root; steps++) {
		const folder = folders.get(at);
		// A loop of parents is no path.
		if (folder === undefined || steps > folders.size) return null;
		names.push(folder.name);
		at = folder.parent;
	}
	return names.reverse().join("/");
}

/** The path of a file of that name in the folder `parent`, or `null` when it is not below `root`. */
function pathIn(folders: ReadonlyMap<string, Folder>, root: string, parent: string | null, name: string): string | null {
	if (parent === null || !isSegment(name)) return null;
	const folder = folderPath(folders, root, parent);
	if (folder === null) return null;
	return folder === "" ? name : `${folder}/${name}`;
}

/** The entry of a file below the root, at `path`. Fails for a file Drive gave no hash of. */
function entryOf(item: DriveItem, path: string): RemoteEntry {
	if (item.hash === undefined) throw new BackendError("incomplete-listing", `list: Google Drive gave no SHA-256 of ${path}`);
	return { path, kind: "file", hash: item.hash, ...(item.size === undefined ? {} : { size: item.size }), id: item.id };
}

/**
 * The files and the folders below `root`, of every file and folder Sync Evo
 * can see. Folders of the same name in one folder are all walked: what is
 * in them shows under the same path, where the files of the same name are
 * two entries of one path, which a sync writes neither of (D-3).
 */
function treeOf(
	root: string,
	items: Iterable<DriveItem>,
): { readonly entries: RemoteEntry[]; readonly folders: Map<string, Folder>; readonly missing: string[] } {
	const children = new Map<string, DriveItem[]>();
	for (const item of items) {
		if (item.trashed || item.parent === null) continue;
		const siblings = children.get(item.parent);
		if (siblings === undefined) children.set(item.parent, [item]);
		else siblings.push(item);
	}
	const folders = new Map<string, Folder>();
	const entries: RemoteEntry[] = [];
	// The files below the root Drive gave no hash of in the listing.
	const missing: string[] = [];
	const queue: [string, string][] = [[root, ""]];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const [id, path] = next;
		for (const child of children.get(id) ?? []) {
			if (!isSegment(child.name)) continue;
			const childPath = path === "" ? child.name : `${path}/${child.name}`;
			if (child.folder) {
				if (child.id === root || folders.has(child.id)) continue;
				folders.set(child.id, { parent: id, name: child.name });
				queue.push([child.id, childPath]);
			} else if (!child.skip) {
				if (child.hash === undefined) missing.push(child.id);
				else entries.push(entryOf(child, childPath));
			}
		}
	}
	return { entries: entries.sort(byPath), folders, missing };
}

/**
 * How a file of a listing has fared since, by the change Drive gives of it:
 * the same, changed (another content, or another name or folder), or gone
 * (deleted, trashed, or moved out of the folder of the vault).
 */
function fateOf(entry: RemoteEntry, change: Change, state: DriveState): "same" | "changed" | "gone" {
	if (change.removed || change.item.trashed) return "gone";
	const path = pathIn(state.folders, state.root, change.item.parent, change.item.name);
	if (path === null) return "gone";
	return path === entry.path && change.item.hash === entry.hash ? "same" : "changed";
}

/** What the writes of a push come to. */
interface Writes {
	readonly written: RemoteEntry[];
	readonly refused: { readonly file: PushFile; readonly reason: Extract<PushRefusal, "changed" | "no-space"> }[];
}

/** What the changes since the listing of a push say: by id, and the names taken in each folder. */
interface Guard {
	readonly state: DriveState;
	readonly byId: ReadonlyMap<string, Change>;
	/** `parent id` and `name`, joined by a line break, of every file now in a folder. */
	readonly taken: ReadonlySet<string>;
}

/** Quotes a value for the query of a listing. */
function quoted(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Runs `work` on each of `items`, a few at a time, within `maxBytes` held at once. Fails as the first that failed. */
async function fewAtATime<T>(
	items: readonly T[],
	bytesOf: (item: T) => number,
	maxBytes: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	const running = new Set<Promise<void>>();
	let held = 0;
	const state: { failure: { readonly error: unknown } | null } = { failure: null };
	for (const item of items) {
		const bytes = bytesOf(item);
		while (running.size > 0 && (running.size >= MAX_CONCURRENT_WRITES || held + bytes > maxBytes)) await Promise.race(running);
		if (state.failure !== null) break;
		held += bytes;
		const on: Promise<void> = work(item)
			.catch((error: unknown) => {
				state.failure ??= { error };
			})
			.finally(() => {
				held -= bytes;
				running.delete(on);
			});
		running.add(on);
	}
	await Promise.all(running);
	if (state.failure !== null) throw state.failure.error;
}

export class GDriveBackend implements Backend {
	private readonly client: DriveBackendClient;
	private readonly options: DriveBackendOptions;
	/** The id of the folder of the vault, once looked up: `null` when there is none yet. */
	private rootId: string | null | undefined = undefined;
	/** The id of the folder the one of the vault kept by its id is in: `Sync Evo`, once looked up. */
	private topId: string | null = null;
	/** The listing this backend last answered or built, which a push lays its changes on. */
	private last: RemoteListing | null = null;

	constructor(client: DriveBackendClient, options: DriveBackendOptions) {
		this.client = client;
		this.options = options;
	}

	/** The SHA-256 of the content in hex: what Drive gives as `sha256Checksum` (R-2). */
	async hashContent(content: Uint8Array): Promise<string> {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content as Uint8Array<ArrayBuffer>));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	checkBase(_base: string, _head: string): Promise<BaseRelation> {
		// No history to rewrite: a page token only ever moves on.
		return Promise.resolve("continues");
	}

	/**
	 * With a listing whose page token Drive still takes, the changes since
	 * are laid on its entries; with none, or when a folder of the vault
	 * changed, everything is listed again. A folder of the vault that is not
	 * there yet is an empty remote without a revision. No page left unread:
	 * a failure on the way fails it all.
	 */
	async list(known: RemoteListing | null): Promise<ListResult> {
		const root = await this.root();
		if (root === null) {
			const empty = { revision: null, entries: [] };
			this.last = empty;
			return { changed: true, listing: empty };
		}
		const state = known?.revision === null || known === null ? null : decodeRevision(known.revision);
		if (known !== null && state !== null && state.root === root && known.entries.every((entry) => entry.id !== undefined)) {
			const changes = await this.changesSince(state.token);
			if (changes !== null) {
				if (changes.items.length === 0) {
					this.last = known;
					return { changed: false };
				}
				const laid = await this.lay(state, known.entries, changes);
				if (laid !== null) {
					this.last = laid;
					return { changed: true, listing: laid };
				}
			}
		}
		const listing = await this.listAll(root);
		this.last = listing;
		return { changed: true, listing };
	}

	/**
	 * The changes laid on the entries of a listing, or `null` when a folder
	 * of the vault was changed (made, renamed, moved, trashed): what is in
	 * a folder that came in from elsewhere is not among the changes, so the
	 * folder is listed again whole.
	 */
	private async lay(
		state: DriveState,
		entries: readonly RemoteEntry[],
		changes: { readonly items: readonly Change[]; readonly token: string },
	): Promise<RemoteListing | null> {
		const { root, folders } = state;
		const files = new Map(entries.map((entry) => [entry.id as string, entry]));
		for (const change of changes.items) {
			if (change.removed) {
				if (folders.has(change.id) || change.id === root) return null;
				continue;
			}
			const { item } = change;
			if (!item.folder) continue;
			const was = folders.get(item.id);
			if (was !== undefined) {
				if (item.trashed || was.parent !== item.parent || was.name !== item.name) return null;
			} else if (!item.trashed && item.parent !== null && (item.parent === root || folders.has(item.parent))) {
				return null;
			}
		}
		for (const change of changes.items) {
			if (change.removed) {
				files.delete(change.id);
				continue;
			}
			const { item } = change;
			if (item.folder) continue;
			const path = item.trashed || item.skip ? null : pathIn(folders, root, item.parent, item.name);
			if (path === null) files.delete(item.id);
			else files.set(item.id, entryOf(item.hash === undefined ? await this.item(item.id) : item, path));
		}
		return { revision: encodeRevision({ token: changes.token, root, folders }), entries: [...files.values()].sort(byPath) };
	}

	/** Every page of the changes since `token`, or `null` when Drive will not go on from it. */
	private async changesSince(token: string): Promise<{ readonly items: Change[]; readonly token: string } | null> {
		const what = "list the changes";
		const items: Change[] = [];
		let page = token;
		for (;;) {
			const url =
				`${DRIVE_API}/changes?pageToken=${encodeURIComponent(page)}&pageSize=${PAGE_SIZE}&spaces=drive&includeRemoved=true` +
				`&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`)}`;
			let json: unknown;
			try {
				json = await this.client.getJson(url);
			} catch (error) {
				// A page token Drive does not take (any more).
				if (error instanceof DriveApiError && (error.status === 400 || error.status === 404)) return null;
				throw error;
			}
			if (!isRecord(json) || !Array.isArray(json.changes)) throw malformed(what);
			for (const value of json.changes as unknown[]) {
				if (!isRecord(value) || typeof value.fileId !== "string") continue;
				if (value.removed === true || value.file === undefined) items.push({ removed: true, id: value.fileId });
				else items.push({ removed: false, id: value.fileId, item: itemOf(what, value.file) });
			}
			if (typeof json.nextPageToken === "string") {
				page = json.nextPageToken;
				continue;
			}
			if (typeof json.newStartPageToken !== "string") throw malformed(what);
			return { items, token: json.newStartPageToken };
		}
	}

	/**
	 * Lists every file and folder Sync Evo can see, which is only what it
	 * made (`drive.file`), page by page, and keeps what is below the folder
	 * of the vault. One listing of everything takes fewer requests than one
	 * of each folder. The page token is taken first, so that nothing that
	 * changes while the pages are read is missed.
	 */
	private async listAll(root: string): Promise<RemoteListing> {
		const token = await this.startToken();
		const items = await this.query("trashed = false", "list the files");
		let tree = treeOf(root, items);
		if (tree.missing.length > 0) {
			// Drive may not have the hash of a file in a listing yet, and
			// gives it when the file is asked for alone. Still without one,
			// the listing fails: a file left out would read as deleted.
			const again = new Map<string, DriveItem>();
			for (const id of tree.missing) again.set(id, await this.item(id));
			tree = treeOf(
				root,
				items.map((item) => again.get(item.id) ?? item),
			);
			const [first] = tree.missing;
			if (first !== undefined) throw new BackendError("incomplete-listing", `list: Google Drive gave no SHA-256 of the file ${first}`);
		}
		return { revision: encodeRevision({ token, root, folders: tree.folders }), entries: tree.entries };
	}

	/** One file, asked for alone (`files.get`). */
	private async item(id: string): Promise<DriveItem> {
		return itemOf("get a file", await this.client.getJson(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`));
	}

	/**
	 * What an upload answered of the file. The answer to the last request of
	 * a resumable upload holds only the fields Drive gives by default,
	 * whatever was asked for (measured 2026-10-17): without a hash, the file
	 * is asked for once more.
	 */
	private async uploaded(json: unknown): Promise<DriveItem> {
		const item = itemOf("upload", json);
		return item.hash === undefined ? this.item(item.id) : item;
	}

	private async startToken(): Promise<string> {
		const json = await this.client.getJson(`${DRIVE_API}/changes/startPageToken?fields=startPageToken`);
		if (!isRecord(json) || typeof json.startPageToken !== "string") throw malformed("get the page token");
		return json.startPageToken;
	}

	/** Every file a query finds, page by page. Fails rather than answer part of them. */
	private async query(q: string, what: string, fields: string = FILE_FIELDS): Promise<DriveItem[]> {
		const items: DriveItem[] = [];
		let page: string | null = null;
		do {
			const url: string =
				`${DRIVE_API}/files?q=${encodeURIComponent(q)}&pageSize=${PAGE_SIZE}&spaces=drive&corpora=user` +
				`&fields=${encodeURIComponent(`nextPageToken,incompleteSearch,files(${fields})`)}` +
				(page === null ? "" : `&pageToken=${encodeURIComponent(page)}`);
			const json = await this.client.getJson(url);
			if (!isRecord(json) || !Array.isArray(json.files)) throw malformed(what);
			if (json.incompleteSearch === true) throw new BackendError("incomplete-listing", `${what}: Google Drive could not search everything`);
			for (const value of json.files as unknown[]) items.push(itemOf(what, value));
			page = typeof json.nextPageToken === "string" ? json.nextPageToken : null;
		} while (page !== null);
		return items;
	}

	/**
	 * The id of the folder of the vault: the one kept, while Drive still
	 * shows it, or the one of its name, or `null` when there is none. Looked
	 * up once for the backend, which is made for each sync. A folder kept by
	 * its id that is gone fails the sync: the sync state is discarded then
	 * (`DriveFolderGoneError`).
	 */
	private async root(): Promise<string | null> {
		if (this.rootId !== undefined) return this.rootId;
		const kept = this.options.folderId;
		if (kept !== null) {
			let json: unknown;
			try {
				json = await this.client.getJson(`${DRIVE_API}/files/${encodeURIComponent(kept)}?fields=id%2CmimeType%2Ctrashed%2Cparents`);
			} catch (error) {
				if (error instanceof DriveApiError && error.status === 404) throw new DriveFolderGoneError(kept, "not found");
				throw error;
			}
			if (!isRecord(json) || json.mimeType !== DRIVE_FOLDER_MIME) throw new DriveFolderGoneError(kept, "not a folder");
			if (json.trashed === true) throw new DriveFolderGoneError(kept, "in the trash");
			const parents = json.parents;
			if (Array.isArray(parents) && typeof parents[0] === "string") {
				this.topId = parents[0];
				await this.checkAlone(kept, parents[0]);
			}
			this.rootId = kept;
			return kept;
		}
		const found = await this.findRoot();
		if (found !== null) this.options.onFolderFound?.(found);
		this.rootId = found;
		return found;
	}

	/**
	 * The id of the folder of the vault, as a sync finds it, or `null` when
	 * there is none yet: for the test of the connection. Fails as a sync
	 * would, when the folder kept is gone or there are two of its name.
	 */
	locate(): Promise<string | null> {
		return this.root();
	}

	/**
	 * When the folder `Sync Evo` that the folder of the vault kept by its id
	 * is in was made, asked of that folder by its id: the start of the free
	 * time of the account (`paid.ts`), for a sync that does not know it yet.
	 * By the id, so that a folder renamed on the web is no other. `null`
	 * without a folder kept: the lookup by the name tells it then
	 * (`onSince`). Fails as the lookup of the folder of the vault does.
	 */
	async topCreatedAt(): Promise<number | null> {
		if (this.options.folderId === null) return null;
		await this.root();
		if (this.topId === null) return null;
		const json = await this.client.getJson(`${DRIVE_API}/files/${encodeURIComponent(this.topId)}?fields=createdTime`);
		const created = isRecord(json) && typeof json.createdTime === "string" ? Date.parse(json.createdTime) : Number.NaN;
		return Number.isFinite(created) ? created : null;
	}

	/**
	 * Fails when the folder kept by its id is not the only one of its kind,
	 * in one listing: another folder of the name in the settings beside it,
	 * or another folder `Sync Evo` at the top of Drive beside the one it is
	 * in. Two devices that each keep one of them would each sync with their
	 * own, and never tell (R-3). A folder renamed on Drive is still followed
	 * by its id: only another one of the name in the settings stops it.
	 */
	private async checkAlone(id: string, parent: string): Promise<void> {
		const { folder } = this.options;
		const items = await this.query(
			`mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false and ` +
				`((name = ${quoted(folder)} and ${quoted(parent)} in parents) or (name = ${quoted(SYNC_EVO_FOLDER)} and 'root' in parents))`,
			"look for folders of the same name",
			FOLDER_FIELDS,
		);
		this.toldSince(items.find((item) => item.id === parent && item.name === SYNC_EVO_FOLDER));
		if (items.some((item) => item.parent === parent && item.name === folder && item.id !== id)) {
			throw new DriveDuplicateFolderError(`${SYNC_EVO_FOLDER}/${folder}`);
		}
		const tops = items.filter((item) => item.name === SYNC_EVO_FOLDER && item.parent !== parent);
		if (tops.some((item) => item.id === parent) && tops.length > 1) throw new DriveDuplicateFolderError(SYNC_EVO_FOLDER);
	}

	/** Tells when the folder `Sync Evo` at the top was made, where it was found and Drive said (`onSince`). */
	private toldSince(top: DriveItem | undefined): void {
		if (top?.createdAt !== undefined) this.options.onSince?.(top.createdAt);
	}

	/** The folder of the vault by its name, in the folder of Sync Evo at the top of Drive. */
	private async findRoot(): Promise<string | null> {
		const top = await this.findFolder(SYNC_EVO_FOLDER, "root", SYNC_EVO_FOLDER);
		if (top === null) return null;
		return this.findFolder(this.options.folder, top, `${SYNC_EVO_FOLDER}/${this.options.folder}`);
	}

	/** The one folder of that name in `parent`, or `null`. More than one stops the sync (R-3). */
	private async findFolder(name: string, parent: string, shown: string): Promise<string | null> {
		const found = await this.foldersNamed(name, parent);
		if (found.length > 1) throw new DriveDuplicateFolderError(shown);
		return found[0] ?? null;
	}

	/** The ids of the folders of that name in `parent`, in order. */
	private async foldersNamed(name: string, parent: string): Promise<string[]> {
		const items = await this.query(
			`name = ${quoted(name)} and ${quoted(parent)} in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
			"look for a folder",
			FOLDER_FIELDS,
		);
		// The one folder of Sync Evo; of two or more, none is told, and the sync stops on them.
		if (parent === "root" && name === SYNC_EVO_FOLDER && items.length === 1) this.toldSince(items[0]);
		return items.map((item) => item.id).sort();
	}

	/**
	 * Makes a folder, and answers the id to use for it. Another device may
	 * have made one of the name in the same moment: the folders of the name
	 * are looked up again, and of two or more, the one with the least id is
	 * the one every device keeps. One this device made that is not that one
	 * goes to the trash at once, before anything is put in it. `made` tells
	 * whether the folder kept is the one made here.
	 */
	private async createFolder(name: string, parent: string): Promise<{ readonly id: string; readonly made: boolean }> {
		const json = await this.client.sendJson("POST", `${DRIVE_API}/files?fields=id`, { name, mimeType: DRIVE_FOLDER_MIME, parents: [parent] });
		if (!isRecord(json) || typeof json.id !== "string") throw malformed("make a folder");
		const mine = json.id;
		const least = (await this.foldersNamed(name, parent))[0] ?? mine;
		if (least >= mine) return { id: mine, made: true };
		await this.client.sendJson("PATCH", `${DRIVE_API}/files/${encodeURIComponent(mine)}?fields=id`, { trashed: true });
		return { id: least, made: false };
	}

	/**
	 * Each file by its id, several at a time. What comes is the file as it is
	 * now, which the caller checks against the hash of the listing.
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
		if (entry.kind !== "file" || entry.id === undefined) throw new BackendError("other", `fetch: not a file of Google Drive: ${entry.path}`);
		return await this.client.download(entry.id, entry.size ?? 0);
	}

	/**
	 * The first file of a folder that is not there yet: the folder of Sync
	 * Evo is made where there is none, and the folder of the vault in it.
	 * When another device made the folder of the vault in the meantime,
	 * nothing is made ("stale"), and the next sync goes on with that one.
	 */
	async start(request: StartRequest): Promise<StartResult> {
		const found = await this.findRoot();
		if (found !== null) {
			this.options.onFolderFound?.(found);
			this.rootId = found;
			return { status: "stale" };
		}
		const top = (await this.findFolder(SYNC_EVO_FOLDER, "root", SYNC_EVO_FOLDER)) ?? (await this.createFolder(SYNC_EVO_FOLDER, "root")).id;
		const vault = await this.createFolder(this.options.folder, top);
		const root = vault.id;
		this.options.onFolderFound?.(root);
		this.rootId = root;
		// Another device made it in the same moment, and puts its first file in it.
		if (!vault.made) return { status: "stale" };
		const places = new Map<string, string>([["", root]]);
		let json: unknown;
		try {
			const parent = await this.ensureFolder(places, parentOf(request.path));
			json = await this.client.upload(null, { name: nameOf(request.path), parents: [parent] }, request.content, FILE_FIELDS);
		} catch (error) {
			if (error instanceof DriveApiError && error.reason === "storageQuotaExceeded") {
				throw new BackendError("other", "start: there is no room left on Google Drive");
			}
			throw error;
		}
		const { id } = itemOf("upload", json);
		// The listing asks Drive for the hash of a file it lacks one of.
		const listing = await this.listAll(root);
		this.last = listing;
		const entry = listing.entries.find((one) => one.id === id);
		if (listing.revision === null || entry === undefined) throw new BackendError("other", "start: the first file is not in the listing after it was written");
		return { status: "started", revision: listing.revision, entry, listing };
	}

	/**
	 * Writes, then trashes, each file by itself, a few at a time. First the
	 * changes since the listing are asked for, once: a file another device
	 * changed, moved or trashed since is neither written over nor trashed,
	 * and a new file is not written where another device put one of its
	 * name (`PushFile.refused`, `kept`). The rest goes on.
	 *
	 * Drive cannot be told to write only over the version that was listed,
	 * so what another device writes between that question and the write is
	 * written over. Its content stays among the versions of the file on Drive.
	 *
	 * A push that untracks writes the `.gitignore` first and trashes only
	 * once it is through, as with Dropbox.
	 */
	async push(request: PushRequest): Promise<PushResult> {
		if (request.baseRevision === null) return { status: "stale" };
		const state = decodeRevision(request.baseRevision);
		const root = await this.root();
		if (state === null || root === null || state.root !== root) return { status: "stale" };
		const guard = await this.guard(state);
		if (guard === null) return { status: "stale" };

		const { written, refused } = await this.writeAll(request.writes, guard);
		if (refused.length > 0 && request.untrack === true) return { status: "stale" };
		for (const { file, reason } of refused) file.refused?.(reason);
		const { deleted, kept } = await this.trashAll(request.deletes, guard);

		const keptPart = kept.length === 0 ? {} : { kept };
		if (written.length === 0 && deleted === 0) return { status: "unchanged", ...keptPart };
		const listing = await this.after(request.baseRevision);
		if (listing === null) return { status: "pushed", revision: request.baseRevision, written, ...keptPart };
		// A file another device wrote over in the moment since: the listing
		// holds its content, and the next pull takes it up as changed there.
		const listed = new Map(listing.entries.map((entry) => [entry.id, entry.hash]));
		const still = written.filter((entry) => listed.get(entry.id) === entry.hash);
		return { status: "pushed", revision: listing.revision ?? request.baseRevision, written: still, listing, ...keptPart };
	}

	/** The changes since the listing a push was planned from, or `null` when Drive will not go on from it. */
	private async guard(state: DriveState): Promise<Guard | null> {
		const changes = await this.changesSince(state.token);
		if (changes === null) return null;
		const byId = new Map<string, Change>();
		const taken = new Set<string>();
		for (const change of changes.items) {
			byId.set(change.id, change);
			if (!change.removed && !change.item.trashed && !change.item.folder && change.item.parent !== null) {
				taken.add(`${change.item.parent}\n${change.item.name}`);
			}
		}
		return { state, byId, taken };
	}

	/**
	 * The listing after a push: the changes since `base` laid on the listing
	 * of `base`, which this backend answered before the push. `null` when it
	 * has no such listing, or Drive could not be asked.
	 */
	private async after(base: string): Promise<RemoteListing | null> {
		const last = this.last;
		if (last === null || last.revision !== base) return null;
		// With the folders it made itself, which are empty but for what the
		// push wrote: that comes among the changes.
		const state = decodeRevision(base);
		const known =
			state === null || this.made.size === 0
				? last
				: { revision: encodeRevision({ ...state, folders: new Map([...state.folders, ...this.made]) }), entries: last.entries };
		try {
			const listed = await this.list(known);
			return listed.changed ? listed.listing : last;
		} catch (error) {
			if (error instanceof BackendError && error.kind === "cancelled") throw error;
			return null;
		}
	}

	private async writeAll(files: readonly PushFile[], guard: Guard): Promise<Writes> {
		const written: RemoteEntry[] = [];
		const refused: Writes["refused"] = [];
		const { root, folders } = guard.state;
		// The folders of the vault by their path, as far as they are known:
		// of two of one name, always the same one.
		const places = new Map<string, string>([["", root]]);
		for (const [id] of [...folders].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))) {
			const path = folderPath(folders, root, id);
			if (path !== null) places.set(path, id);
		}
		const maxBytes = this.options.maxConcurrentFetchBytes ?? MAX_CONCURRENT_FETCH_BYTES;
		await fewAtATime(files, (file) => file.size, maxBytes, async (file) => {
			this.throwIfCancelled("push");
			const content = await file.read();
			if (content === null) return;
			const hash = await this.hashContent(content);
			const { replaces } = file;
			if (replaces !== undefined && replaces.hash === hash) {
				written.push({ ...replaces, path: file.path, hash });
				return;
			}
			let json: unknown;
			try {
				if (replaces !== undefined) {
					if (replaces.id === undefined) throw new BackendError("other", `push: no id of ${replaces.path}`);
					const change = guard.byId.get(replaces.id);
					if (change !== undefined && fateOf(replaces, change, guard.state) !== "same") {
						refused.push({ file, reason: "changed" });
						return;
					}
					json = await this.client.upload(replaces.id, {}, content, FILE_FIELDS);
				} else {
					const parent = await this.ensureFolder(places, parentOf(file.path));
					const name = nameOf(file.path);
					if (guard.taken.has(`${parent}\n${name}`)) {
						refused.push({ file, reason: "changed" });
						return;
					}
					json = await this.client.upload(null, { name, parents: [parent] }, content, FILE_FIELDS);
				}
			} catch (error) {
				if (error instanceof DriveApiError && error.reason === "storageQuotaExceeded") {
					refused.push({ file, reason: "no-space" });
					return;
				}
				// Deleted for good since, by another device or by hand.
				if (error instanceof DriveApiError && error.status === 404 && replaces !== undefined) {
					refused.push({ file, reason: "changed" });
					return;
				}
				throw error;
			}
			const item = await this.uploaded(json);
			written.push({ path: file.path, kind: "file", hash: item.hash ?? hash, size: item.size ?? content.byteLength, id: item.id });
		});
		// In the order asked for, whatever order they ended in.
		const order = new Map(files.map((file, index) => [file.path, index]));
		written.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
		return { written, refused };
	}

	/**
	 * The id of the folder at `path` below the root, made where there is
	 * none. Each folder is made once for a push, also when files in it are
	 * written at once; one another device has made since is taken, so that
	 * two devices do not each make one.
	 */
	private readonly making = new Map<string, Promise<string>>();
	/**
	 * The folders this backend made, by id: laid on the listing after a
	 * push (`after`), so that a folder of its own is not taken for one that
	 * came in from elsewhere, which would have everything listed again.
	 */
	private readonly made = new Map<string, Folder>();

	private ensureFolder(places: Map<string, string>, path: string): Promise<string> {
		const known = places.get(path);
		if (known !== undefined) return Promise.resolve(known);
		let made = this.making.get(path);
		if (made === undefined) {
			made = (async () => {
				const parent = await this.ensureFolder(places, parentOf(path));
				const name = nameOf(path);
				let id = (await this.foldersNamed(name, parent))[0];
				if (id === undefined) {
					const created = await this.createFolder(name, parent);
					id = created.id;
					if (created.made) this.made.set(id, { parent, name });
				}
				places.set(path, id);
				return id;
			})();
			this.making.set(path, made);
			// A failure is not kept: the next push asks again.
			made.catch(() => this.making.delete(path));
		}
		return made;
	}

	/**
	 * Puts each file in the trash, a few at a time, where the user can get it
	 * back (R-3). One that another device changed since the listing is kept;
	 * one that is gone already counts as deleted.
	 */
	private async trashAll(entries: readonly RemoteEntry[], guard: Guard): Promise<{ readonly deleted: number; readonly kept: RemoteEntry[] }> {
		let deleted = 0;
		const kept: RemoteEntry[] = [];
		await fewAtATime(entries, () => 0, Number.POSITIVE_INFINITY, async (entry) => {
			this.throwIfCancelled("push");
			if (entry.id === undefined) throw new BackendError("other", `push: no id of ${entry.path}`);
			const change = guard.byId.get(entry.id);
			const fate = change === undefined ? "same" : fateOf(entry, change, guard.state);
			if (fate === "gone") {
				deleted += 1;
				return;
			}
			if (fate === "changed") {
				kept.push(entry);
				return;
			}
			try {
				await this.client.sendJson("PATCH", `${DRIVE_API}/files/${encodeURIComponent(entry.id)}?fields=id`, { trashed: true });
			} catch (error) {
				if (!(error instanceof DriveApiError && error.status === 404)) throw error;
			}
			deleted += 1;
		});
		// In the order asked for, whatever order they ended in.
		const order = new Map(entries.map((entry, index) => [entry, index]));
		kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
		return { deleted, kept };
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}
}
