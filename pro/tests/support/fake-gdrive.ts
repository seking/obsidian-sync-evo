/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

// Google Drive in memory, as far as the backend asks of it: the calls of
// `DriveBackendClient`, answered the way the API documents them. A file is
// an id with a name and a parent; names are not unique; every change goes to
// a log that page tokens point into.

import { DriveApiError } from "../../src/core/gdrive/client";
import type { DriveBackendClient } from "../../src/core/gdrive/backend";

const FOLDER = "application/vnd.google-apps.folder";

interface Stored {
	readonly id: string;
	name: string;
	mimeType: string;
	parent: string;
	trashed: boolean;
	content?: Uint8Array;
	hash?: string;
}

function bytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

async function sha256(content: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content as Uint8Array<ArrayBuffer>));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class FakeDrive implements DriveBackendClient {
	/** The id Drive gives the top of My Drive, which `'root'` names. */
	readonly rootId = "my-drive";
	private readonly items = new Map<string, Stored>();
	/** The id of every change, in order. A page token is a place in it. */
	private readonly log: string[] = [];
	private ids = 0;
	/** Entries per page of a listing and of the changes. */
	pageSize = 1000;
	/** The calls, as `METHOD what`, in order. */
	readonly calls: string[] = [];
	/** Page tokens Drive will not go on from. */
	readonly expired = new Set<string>();
	/** Called with each call before it is answered: a test throws from here to make it fail, or acts as another device. */
	beforeCall: ((call: string) => void | Promise<void>) | undefined;
	/** Whether the listing of the files says that it could not search everything. */
	incomplete = false;
	/** Whether the files keep no SHA-256, as Drive might for one it has not worked out yet. */
	noHash = false;
	/**
	 * Whether the SHA-256 is given only when a file is asked for alone: not in
	 * a listing, the changes, or the answer to an upload (as the last request
	 * of a resumable upload answers).
	 */
	hashOnlyAlone = false;
	/** The time Drive gives what is made from here on (`createdTime`), in milliseconds since the epoch. */
	now = Date.parse("2027-01-10T00:00:00Z");
	/** When each file and folder was made. */
	private readonly created = new Map<string, number>();

	private fail(what: string, status: number, reason: string): never {
		throw new DriveApiError(what, status, reason, "");
	}

	private newId(): string {
		this.ids += 1;
		const id = `id${String(this.ids).padStart(4, "0")}`;
		this.created.set(id, this.now);
		return id;
	}

	private changed(id: string): void {
		this.log.push(id);
	}

	private meta(item: Stored, alone = false, withCreated = false): Record<string, unknown> {
		const created = this.created.get(item.id);
		return {
			// Only where it was asked for, as Drive answers the fields asked.
			...(withCreated && created !== undefined ? { createdTime: new Date(created).toISOString() } : {}),
			id: item.id,
			name: item.name,
			mimeType: item.mimeType,
			parents: [item.parent],
			trashed: item.trashed || this.inTrash(item.parent),
			...(item.content === undefined ? {} : { size: String(item.content.byteLength) }),
			...(item.hash === undefined || this.noHash || (this.hashOnlyAlone && !alone) ? {} : { sha256Checksum: item.hash }),
		};
	}

	/** Whether a folder is in the trash, or below one that is. */
	private inTrash(id: string): boolean {
		for (let at = this.items.get(id); at !== undefined; at = this.items.get(at.parent)) if (at.trashed) return true;
		return false;
	}

	private async before(call: string): Promise<void> {
		this.calls.push(call);
		await this.beforeCall?.(call);
	}

	async getJson(url: string): Promise<unknown> {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/^\/drive\/v3\//, "");
		const params = parsed.searchParams;
		if (path === "changes/startPageToken") {
			await this.before("GET startPageToken");
			return { startPageToken: String(this.log.length) };
		}
		if (path === "changes") {
			await this.before("GET changes");
			const token = params.get("pageToken") ?? "";
			if (this.expired.has(token) || !/^\d+$/.test(token) || Number(token) > this.log.length) this.fail("changes", 400, "invalid");
			const from = Number(token);
			const to = Math.min(this.log.length, from + this.pageSize);
			const seen = new Set<string>();
			const changes: Record<string, unknown>[] = [];
			for (const id of this.log.slice(from, to)) {
				if (seen.has(id)) continue;
				seen.add(id);
				const item = this.items.get(id);
				changes.push(item === undefined ? { fileId: id, removed: true } : { fileId: id, removed: false, file: this.meta(item) });
			}
			return to < this.log.length ? { changes, nextPageToken: String(to) } : { changes, newStartPageToken: String(this.log.length) };
		}
		if (path === "files") {
			await this.before("GET files");
			const matches = this.query(params.get("q") ?? "");
			const start = Number(params.get("pageToken") ?? "0");
			const withCreated = (params.get("fields") ?? "").includes("createdTime");
			const page = matches.slice(start, start + this.pageSize).map((item) => this.meta(item, false, withCreated));
			return {
				files: page,
				...(start + this.pageSize < matches.length ? { nextPageToken: String(start + this.pageSize) } : {}),
				...(this.incomplete ? { incompleteSearch: true } : {}),
			};
		}
		if (path === "about") {
			await this.before("GET about");
			return { user: { permissionId: "perm1", emailAddress: "a@example.com" } };
		}
		const id = decodeURIComponent(path.replace(/^files\//, ""));
		await this.before("GET file");
		const item = this.items.get(id);
		if (item === undefined) this.fail("get", 404, "notFound");
		return this.meta(item, true, (params.get("fields") ?? "").includes("createdTime"));
	}

	/** What a query of the backend finds. Only the forms it asks in. */
	private query(q: string): Stored[] {
		const all = [...this.items.values()].filter((item) => !item.trashed && !this.inTrash(item.parent));
		if (q === "trashed = false") return all.sort((a, b) => (a.id < b.id ? -1 : 1));
		const unquoted = (text: string): string => text.replace(/\\(.)/g, "$1");
		const pair = /^mimeType = '([^']*)' and trashed = false and \(\(name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents\) or \(name = '((?:[^'\\]|\\.)*)' and 'root' in parents\)\)$/.exec(q);
		if (pair !== null) {
			const [, mime, name, parent, top] = pair;
			return all.filter(
				(item) =>
					item.mimeType === mime &&
					((item.name === unquoted(name ?? "") && item.parent === unquoted(parent ?? "")) ||
						(item.name === unquoted(top ?? "") && item.parent === this.rootId)),
			);
		}
		const match = /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and mimeType = '([^']*)' and trashed = false$/.exec(q);
		if (match === null) throw new Error(`a query the fake does not know: ${q}`);
		const unquote = (text: string): string => text.replace(/\\(.)/g, "$1");
		const name = unquote(match[1] ?? "");
		const parent = unquote(match[2] ?? "") === "root" ? this.rootId : unquote(match[2] ?? "");
		return all.filter((item) => item.name === name && item.parent === parent && item.mimeType === match[3]);
	}

	async sendJson(method: "POST" | "PATCH", url: string, body: unknown): Promise<unknown> {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/^\/drive\/v3\//, "");
		const json = body as Record<string, unknown>;
		if (method === "POST" && path === "files") {
			await this.before("POST folder");
			const parents = json.parents as string[];
			const parent = parents[0] === "root" ? this.rootId : (parents[0] ?? this.rootId);
			if (!this.items.has(parent) && parent !== this.rootId) this.fail("create", 404, "notFound");
			const id = this.newId();
			this.items.set(id, { id, name: String(json.name), mimeType: String(json.mimeType), parent, trashed: false });
			this.changed(id);
			return { id };
		}
		const id = decodeURIComponent(path.replace(/^files\//, ""));
		await this.before("PATCH trash");
		const item = this.items.get(id);
		if (item === undefined) this.fail("update", 404, "notFound");
		if (json.trashed === true) item.trashed = true;
		this.changed(id);
		return { id };
	}

	async upload(id: string | null, metadata: Record<string, unknown>, content: Uint8Array, _fields: string): Promise<unknown> {
		await this.before(id === null ? "POST upload" : "PATCH upload");
		const hash = await sha256(content);
		if (id === null) {
			const parents = metadata.parents as string[];
			const parent = parents[0] ?? this.rootId;
			if (!this.items.has(parent)) this.fail("create", 404, "notFound");
			const made = this.newId();
			const item: Stored = { id: made, name: String(metadata.name), mimeType: "text/plain", parent, trashed: false, content, hash };
			this.items.set(made, item);
			this.changed(made);
			return this.meta(item);
		}
		const item = this.items.get(id);
		if (item === undefined) this.fail("update", 404, "notFound");
		item.content = content;
		item.hash = hash;
		this.changed(id);
		return this.meta(item);
	}

	async download(id: string): Promise<Uint8Array> {
		await this.before("GET media");
		const item = this.items.get(id);
		if (item?.content === undefined) this.fail("download", 404, "notFound");
		return item.content;
	}

	// What a test does on Drive itself, as a user would on the web or another client.

	/** The id at a path from the top of My Drive (`Sync Evo/Vault/a.md`), of what is not in the trash; the first of several. */
	idOf(path: string): string | undefined {
		let at = this.rootId;
		for (const name of path.split("/")) {
			const found = [...this.items.values()]
				.filter((item) => item.parent === at && item.name === name && !item.trashed)
				.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
			if (found === undefined) return undefined;
			at = found.id;
		}
		return at;
	}

	/** Every file below a folder, by its path below it, with its text. */
	tree(folder: string): Record<string, string> {
		const top = this.idOf(folder);
		const out: Record<string, string> = {};
		const walk = (id: string, prefix: string): void => {
			for (const item of this.items.values()) {
				if (item.parent !== id || item.trashed) continue;
				const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
				if (item.mimeType === FOLDER) walk(item.id, path);
				else out[path] = new TextDecoder().decode(item.content);
			}
		};
		if (top !== undefined) walk(top, "");
		return out;
	}

	text(path: string): string | undefined {
		const id = this.idOf(path);
		const content = id === undefined ? undefined : this.items.get(id)?.content;
		return content === undefined ? undefined : new TextDecoder().decode(content);
	}

	/** Makes a folder, as another client would, also where one of its name is. */
	/** Renames what is at `path`, as the user does on the web. */
	rename(path: string, name: string): void {
		const item = this.items.get(this.idOf(path) ?? "");
		if (item === undefined) throw new Error(`nothing at ${path}`);
		item.name = name;
		this.changed(item.id);
	}

		makeFolder(parentPath: string, name: string): string {
		const parent = parentPath === "" ? this.rootId : this.idOf(parentPath);
		if (parent === undefined) throw new Error(`no folder ${parentPath}`);
		const id = this.newId();
		this.items.set(id, { id, name, mimeType: FOLDER, parent, trashed: false });
		this.changed(id);
		return id;
	}

	/** Writes a file, as another client would: over the one at the path, or new. */
	async put(path: string, text: string | Uint8Array, options: { readonly asNew?: boolean; readonly parent?: string } = {}): Promise<string> {
		const content = bytes(text);
		const slash = path.lastIndexOf("/");
		const parent = options.parent ?? this.idOf(path.slice(0, slash));
		if (parent === undefined) throw new Error(`no folder for ${path}`);
		const existing = options.asNew === true || options.parent !== undefined ? undefined : this.idOf(path);
		const hash = await sha256(content);
		if (existing !== undefined) {
			const item = this.items.get(existing) as Stored;
			item.content = content;
			item.hash = hash;
			this.changed(existing);
			return existing;
		}
		const id = this.newId();
		this.items.set(id, { id, name: path.slice(slash + 1), mimeType: "text/plain", parent, trashed: false, content, hash });
		this.changed(id);
		return id;
	}

	/** Puts what is at the path in the trash. */
	trash(path: string): void {
		const id = this.idOf(path);
		const item = id === undefined ? undefined : this.items.get(id);
		if (item === undefined) throw new Error(`nothing at ${path}`);
		item.trashed = true;
		this.changed(item.id);
	}

	/** Deletes what is at the path for good, with what is below it. */
	remove(path: string): void {
		const id = this.idOf(path);
		if (id === undefined) throw new Error(`nothing at ${path}`);
		const gone = [id];
		for (let i = 0; i < gone.length; i++) {
			for (const item of this.items.values()) if (item.parent === gone[i]) gone.push(item.id);
		}
		for (const one of gone) {
			this.items.delete(one);
			this.changed(one);
		}
	}

	/** Moves what is at the path into another folder, with another name if given. */
	move(path: string, toFolder: string, name?: string): void {
		const id = this.idOf(path);
		const to = toFolder === "" ? this.rootId : this.idOf(toFolder);
		const item = id === undefined ? undefined : this.items.get(id);
		if (item === undefined || to === undefined) throw new Error(`cannot move ${path}`);
		item.parent = to;
		if (name !== undefined) item.name = name;
		this.changed(item.id);
	}

	/** Makes a document of Google's own in the folder: no content to download. */
	putDocument(folder: string, name: string): void {
		const parent = this.idOf(folder);
		if (parent === undefined) throw new Error(`no folder ${folder}`);
		const id = this.newId();
		this.items.set(id, { id, name, mimeType: "application/vnd.google-apps.document", parent, trashed: false });
		this.changed(id);
	}

	/** Takes the item of that id back out of the trash. */
	untrash(id: string): void {
		const item = this.items.get(id);
		if (item === undefined) throw new Error(`nothing of id ${id}`);
		item.trashed = false;
		this.changed(id);
	}

	/** Whether the item of that id is in the trash. */
	isTrashed(id: string): boolean {
		return this.items.get(id)?.trashed === true;
	}
}
