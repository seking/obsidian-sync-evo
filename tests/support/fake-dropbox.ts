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

// Dropbox in memory, as far as the backend asks of it: the calls of
// `DropboxBackendClient`, answered the way the API documents them. Paths are
// matched without case, a file keeps its versions, and every change goes to
// a log that cursors point into.

import { DropboxApiError } from "../../src/core/dropbox/client";
import { dropboxContentHash } from "../../src/core/dropbox/content-hash";
import type { DropboxBackendClient } from "../../src/core/dropbox/backend";

interface Version {
	readonly rev: string;
	readonly content: Uint8Array;
	readonly hash: string;
}

interface StoredFile {
	/** As the last write spelled it, parents and all (`path_display`). */
	display: string;
	versions: Version[];
	deleted: boolean;
}

type Item = Record<string, unknown>;

function bytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash <= 0 ? "" : path.slice(0, slash);
}

export class FakeDropbox implements DropboxBackendClient {
	private readonly files = new Map<string, StoredFile>();
	private readonly folders = new Map<string, string>();
	private readonly log: Item[] = [];
	private revs = 0;
	/** Entries per page of a listing. */
	pageSize = 2000;
	/** Cursors Dropbox will not go on from. */
	readonly expired = new Set<string>();
	/** The calls, by endpoint, in order. */
	readonly calls: string[] = [];
	/** Called with each call before it is answered: a test throws from here to make it fail. */
	beforeCall: ((endpoint: string, arg: Record<string, unknown>) => void | Promise<void>) | undefined;

	private fail(endpoint: string, summary: string): never {
		throw new DropboxApiError(endpoint, summary);
	}

	private fileItem(lower: string, file: StoredFile): Item {
		const version = file.versions[file.versions.length - 1];
		if (version === undefined) throw new Error("a file without a version");
		return {
			".tag": "file",
			name: file.display.slice(file.display.lastIndexOf("/") + 1),
			path_lower: lower,
			path_display: file.display,
			rev: version.rev,
			size: version.content.length,
			content_hash: version.hash,
		};
	}

	private ensureFolders(display: string): void {
		for (let parent = parentOf(display); parent !== ""; parent = parentOf(parent)) {
			const lower = parent.toLowerCase();
			if (this.folders.has(lower)) continue;
			this.folders.set(lower, parent);
			this.log.push({ ".tag": "folder", name: parent.slice(parent.lastIndexOf("/") + 1), path_lower: lower, path_display: parent });
		}
	}

	/** Writes a file as another device or the Dropbox app would. Answers its rev. */
	async put(path: string, content: string | Uint8Array): Promise<string> {
		const data = bytes(content);
		const lower = path.toLowerCase();
		const rev = `r${(++this.revs).toString(16).padStart(9, "0")}`;
		const version = { rev, content: data, hash: await dropboxContentHash(data) };
		const file = this.files.get(lower);
		if (file === undefined || file.deleted) {
			const versions = file?.versions ?? [];
			versions.push(version);
			this.files.set(lower, { display: path, versions, deleted: false });
		} else {
			file.versions.push(version);
		}
		this.ensureFolders(path);
		const stored = this.files.get(lower);
		if (stored !== undefined) this.log.push(this.fileItem(lower, stored));
		return rev;
	}

	/** Deletes a file or a folder with all below it, as another device would. */
	delete(path: string): void {
		const lower = path.toLowerCase();
		const prefix = `${lower}/`;
		for (const [key, file] of this.files) if (key === lower || key.startsWith(prefix)) file.deleted = true;
		for (const key of [...this.folders.keys()]) if (key === lower || key.startsWith(prefix)) this.folders.delete(key);
		this.log.push({ ".tag": "deleted", name: path.slice(path.lastIndexOf("/") + 1), path_lower: lower, path_display: path });
	}

	/** What a path holds now, or `undefined`. */
	text(path: string): string | undefined {
		const file = this.files.get(path.toLowerCase());
		if (file === undefined || file.deleted) return undefined;
		const version = file.versions[file.versions.length - 1];
		return version === undefined ? undefined : new TextDecoder().decode(version.content);
	}

	/** Every file below `root`, by the path as it is spelled, with its text. */
	tree(root: string): Record<string, string> {
		const out: Record<string, string> = {};
		const prefix = `${root.toLowerCase()}/`;
		for (const [lower, file] of this.files) {
			if (file.deleted || !lower.startsWith(prefix)) continue;
			out[file.display.slice(prefix.length)] = this.text(lower) ?? "";
		}
		return out;
	}

	private snapshot(path: string): Item[] {
		const lower = path.toLowerCase();
		const prefix = `${lower}/`;
		const items: Item[] = [];
		const folder = this.folders.get(lower);
		if (folder !== undefined) items.push({ ".tag": "folder", name: folder.slice(folder.lastIndexOf("/") + 1), path_lower: lower, path_display: folder });
		const folders = [...this.folders.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.length - b.length);
		for (const [key, display] of folders) items.push({ ".tag": "folder", name: display.slice(display.lastIndexOf("/") + 1), path_lower: key, path_display: display });
		for (const [key, file] of this.files) if (!file.deleted && key.startsWith(prefix)) items.push(this.fileItem(key, file));
		return items;
	}

	private snapshots = new Map<string, { items: Item[]; at: number }>();

	private page(items: Item[], offset: number, at: number): Record<string, unknown> {
		const end = offset + this.pageSize;
		if (end >= items.length) return { entries: items.slice(offset), cursor: `c${at}`, has_more: false };
		const id = `p${this.snapshots.size}`;
		this.snapshots.set(id, { items, at });
		return { entries: items.slice(offset, end), cursor: `${id}:${end}`, has_more: true };
	}

	async rpc(endpoint: string, arg: unknown): Promise<unknown> {
		this.calls.push(endpoint);
		const a = (arg ?? {}) as Record<string, unknown>;
		await this.beforeCall?.(endpoint, a);
		switch (endpoint) {
			case "files/list_folder": {
				const path = String(a.path);
				if (!this.folders.has(path.toLowerCase())) this.fail(endpoint, "path/not_found/..");
				return this.page(this.snapshot(path), 0, this.log.length);
			}
			case "files/list_folder/continue": {
				const cursor = String(a.cursor);
				if (this.expired.has(cursor)) this.fail(endpoint, "reset/..");
				if (cursor.startsWith("p")) {
					const [id, offset] = cursor.split(":");
					const snapshot = this.snapshots.get(id ?? "");
					if (snapshot === undefined) this.fail(endpoint, "other/..");
					return this.page(snapshot.items, Number(offset), snapshot.at);
				}
				const from = Number(cursor.slice(1));
				return this.page(this.log.slice(from), 0, this.log.length);
			}
			case "files/delete_v2": {
				const path = String(a.path);
				const file = this.files.get(path.toLowerCase());
				if (file === undefined || file.deleted) this.fail(endpoint, "path_lookup/not_found/..");
				const latest = file.versions[file.versions.length - 1];
				if (a.parent_rev !== undefined && a.parent_rev !== latest?.rev) this.fail(endpoint, "path_write/conflict/file/..");
				this.delete(file.display);
				return { metadata: { ".tag": "file" } };
			}
			case "files/list_revisions": {
				const file = this.files.get(String(a.path).toLowerCase());
				if (file === undefined) this.fail(endpoint, "path/not_found/..");
				const entries = [...file.versions].reverse().slice(0, Number(a.limit ?? 10)).map((version) => ({
					rev: version.rev,
					content_hash: version.hash,
					size: version.content.length,
				}));
				return { is_deleted: file.deleted, entries };
			}
			default:
				throw new Error(`not faked: ${endpoint}`);
		}
	}

	async upload(arg: unknown, content: Uint8Array): Promise<unknown> {
		this.calls.push("files/upload");
		const a = arg as Record<string, unknown>;
		await this.beforeCall?.("files/upload", a);
		const path = String(a.path);
		const lower = path.toLowerCase();
		const file = this.files.get(lower);
		const present = file !== undefined && !file.deleted;
		const latest = file?.versions[file.versions.length - 1];
		const mode = a.mode as string | { ".tag": string; update: string };
		if (mode === "add" && present) {
			if (latest !== undefined && latest.hash === (await dropboxContentHash(content))) return this.fileItem(lower, file);
			this.fail("files/upload", "path/conflict/file/..");
		}
		if (typeof mode === "object" && present && latest?.rev !== mode.update) this.fail("files/upload", "path/conflict/file/..");
		// Kept as it was spelled, when there.
		await this.put(present ? file.display : path, content);
		const stored = this.files.get(lower);
		if (stored === undefined) throw new Error("not written");
		return this.fileItem(lower, stored);
	}

	async download(arg: unknown): Promise<{ readonly content: Uint8Array; readonly result: unknown }> {
		this.calls.push("files/download");
		const a = arg as Record<string, unknown>;
		await this.beforeCall?.("files/download", a);
		const path = String(a.path);
		if (path.startsWith("rev:")) {
			const rev = path.slice(4);
			for (const file of this.files.values()) {
				const version = file.versions.find((v) => v.rev === rev);
				if (version !== undefined) return { content: version.content, result: {} };
			}
			this.fail("files/download", "path/not_found/..");
		}
		const file = this.files.get(path.toLowerCase());
		const latest = file?.versions[file.versions.length - 1];
		if (file === undefined || file.deleted || latest === undefined) this.fail("files/download", "path/not_found/..");
		return { content: latest.content, result: {} };
	}
}
