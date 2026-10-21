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

import type { VaultStat } from "../../src/core/pull-io";
import type { FolderListing, IndexedItem, OpenEditor, VaultPorts } from "../../src/core/vault-access";

export interface FakeTrashed {
	readonly path: string;
	readonly where: "system" | "vault" | "gone";
}

/**
 * The app as far as `VaultPorts` goes: a disk, and an index on top of it.
 * As the real ones behave, where that was measured:
 *
 * - With `caseSensitive: false` (a Mac) the disk finds a file or a folder
 *   whatever its case and keeps the spelling it has. With `true` (an
 *   iPhone) two names that differ in case are two files. NFC and NFD of one
 *   name are one file on both, and are listed in NFC.
 * - The index holds every path without a `.` name, under the spelling the
 *   disk has, and finds it by that exact spelling only. It follows every
 *   change of the disk, unless `indexFollows` is turned off.
 * - `create` fails when the disk already has something at the path, and so
 *   does `createFolder`.
 * - The renames replace what is at the new name without a word, as the
 *   worst of the platforms would.
 *
 * Every call that changes something is noted in `calls`.
 */
export class FakeVaultPorts implements VaultPorts<string> {
	configDir = ".obsidian";
	readonly caseSensitive: boolean;
	readonly calls: string[] = [];
	readonly trashed: FakeTrashed[] = [];
	/** What `trashOption` answers. */
	trashSetting: unknown = "local";
	hasSystemTrash = true;
	/** Put in front of every listed path, as a platform might. */
	listPrefix = "";
	/** The spelling of the root that `list` takes; any other lists nothing. */
	rootSpellings: readonly string[] = ["/", ""];
	indexFollows = true;
	editors: OpenEditor[] = [];
	/** Called before a disk or index call, with its name; throw from it to fail the call. */
	before: ((call: string, path: string) => void) | undefined;

	private readonly files = new Map<string, Uint8Array>();
	private readonly folders = new Set<string>();
	private readonly index = new Map<string, "file" | "folder">();
	private clock = 1000;

	constructor(options: { caseSensitive: boolean }) {
		this.caseSensitive = options.caseSensitive;
		this.folders.add(".obsidian");
	}

	// -----------------------------------------------------------------------
	// For the tests

	put(path: string, content: string): void {
		const actual = this.resolve(path);
		this.makeParents(actual);
		this.files.set(actual, new TextEncoder().encode(content));
		this.follow();
	}

	putFolder(path: string): void {
		const actual = this.resolve(path);
		this.makeParents(`${actual}/x`);
		this.follow();
	}

	text(path: string): string | undefined {
		const file = this.files.get(this.resolve(path));
		return file === undefined ? undefined : new TextDecoder().decode(file);
	}

	/** Every file as the disk spells it, sorted. */
	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	folderPaths(): string[] {
		return [...this.folders].sort();
	}

	indexedPaths(): string[] {
		return [...this.index.keys()].sort();
	}

	/** Makes the index what the disk is, as the app does a moment after a change. */
	follow(): void {
		this.index.clear();
		const visible = (path: string): boolean => !path.split("/").some((part) => part.startsWith("."));
		for (const path of this.folders) if (visible(path)) this.index.set(path, "folder");
		for (const path of this.files.keys()) if (visible(path)) this.index.set(path, "file");
	}

	// -----------------------------------------------------------------------
	// The disk

	async list(folder: string): Promise<FolderListing> {
		let actual: string;
		if (folder === "/" || folder === "") {
			if (!this.rootSpellings.includes(folder)) return { files: [], folders: [] };
			actual = "";
		} else {
			actual = this.resolve(folder);
			if (!this.folders.has(actual)) throw new Error(`ENOTDIR: ${folder}`);
		}
		const inside = (path: string): boolean => parentOf(path) === actual;
		const out = (path: string): string => this.listPrefix + path;
		return {
			files: [...this.files.keys()].filter(inside).map(out),
			folders: [...this.folders].filter(inside).map(out),
		};
	}

	async stat(path: string): Promise<VaultStat | null> {
		const actual = this.resolve(path);
		const file = this.files.get(actual);
		if (file !== undefined) return { type: "file", mtime: this.clock, size: file.length };
		return this.folders.has(actual) ? { type: "folder", mtime: 0, size: 0 } : null;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const file = this.files.get(this.resolve(path));
		if (file === undefined) throw new Error(`ENOENT: ${path}`);
		return bufferOf(file);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.note("writeBinary", path);
		this.store(path, data);
	}

	async mkdir(path: string): Promise<void> {
		this.note("mkdir", path);
		this.addFolder(path);
	}

	async rmdir(path: string): Promise<void> {
		this.note("rmdir", path);
		const actual = this.resolve(path);
		if (!this.folders.has(actual)) throw new Error(`ENOENT: ${path}`);
		const inside = (other: string): boolean => other.startsWith(`${actual}/`);
		if ([...this.files.keys()].some(inside) || [...this.folders].some(inside)) throw new Error(`ENOTEMPTY: ${path}`);
		this.folders.delete(actual);
		this.changed();
	}

	async renameOnDisk(from: string, to: string): Promise<void> {
		this.note("renameOnDisk", `${from} -> ${to}`);
		this.move(from, to);
	}

	async trashSystem(path: string): Promise<boolean> {
		this.note("trashSystem", path);
		if (!this.hasSystemTrash) return false;
		this.take(path, "system");
		return true;
	}

	async trashLocal(path: string): Promise<void> {
		this.note("trashLocal", path);
		this.take(path, "vault");
	}

	async remove(path: string): Promise<void> {
		this.note("remove", path);
		this.take(path, "gone");
	}

	// -----------------------------------------------------------------------
	// The index

	indexed(path: string): IndexedItem<string> | null {
		const type = this.index.get(path);
		return type === undefined ? null : { type, path, handle: path };
	}

	async create(path: string, data: ArrayBuffer): Promise<void> {
		this.note("create", path);
		const actual = this.resolve(path);
		if (this.files.has(actual) || this.folders.has(actual)) throw new Error("File already exists.");
		this.store(path, data);
	}

	async modify(file: string, data: ArrayBuffer): Promise<void> {
		this.note("modify", file);
		if (!this.files.has(this.resolve(file))) throw new Error(`ENOENT: ${file}`);
		this.store(file, data);
	}

	async createFolder(path: string): Promise<void> {
		this.note("createFolder", path);
		const actual = this.resolve(path);
		if (this.files.has(actual) || this.folders.has(actual)) throw new Error("Folder already exists.");
		this.addFolder(path);
	}

	async renameIndexed(item: string, to: string): Promise<void> {
		this.note("renameIndexed", `${item} -> ${to}`);
		this.move(item, to);
	}

	async trashBySetting(item: string): Promise<void> {
		this.note("trashBySetting", item);
		const setting = this.trashSetting;
		this.take(item, setting === "none" ? "gone" : setting === "system" ? "system" : "vault");
	}

	async trashToVault(item: string): Promise<void> {
		this.note("trashToVault", item);
		this.take(item, "vault");
	}

	trashOption(): unknown {
		return this.trashSetting;
	}

	openEditors(): readonly OpenEditor[] {
		return this.editors;
	}

	// -----------------------------------------------------------------------

	private note(call: string, path: string): void {
		this.before?.(call, path);
		this.calls.push(`${call} ${path}`);
	}

	private changed(): void {
		this.clock += 1;
		if (this.indexFollows) this.follow();
	}

	private fold(path: string): string {
		const nfc = path.normalize("NFC");
		return this.caseSensitive ? nfc : nfc.toLowerCase();
	}

	/** The path as the disk spells it, as far down as something is there; the rest in NFC. */
	private resolve(path: string): string {
		let actual = "";
		for (const part of path.split("/")) {
			const wanted = actual === "" ? part : `${actual}/${part}`;
			const folded = this.fold(wanted);
			let found: string | undefined;
			for (const existing of [...this.folders, ...this.files.keys()]) {
				if (this.fold(existing) === folded) {
					found = existing;
					break;
				}
			}
			actual = found ?? wanted.normalize("NFC");
		}
		return actual;
	}

	private makeParents(actual: string): void {
		for (let slash = actual.indexOf("/"); slash !== -1; slash = actual.indexOf("/", slash + 1)) {
			this.folders.add(actual.slice(0, slash));
		}
	}

	/** Writes a file. Like a disk, it makes no folder for it. */
	private store(path: string, data: ArrayBuffer): void {
		const actual = this.resolve(path);
		if (this.folders.has(actual)) throw new Error(`EISDIR: ${path}`);
		const parent = parentOf(actual);
		if (parent !== "" && !this.folders.has(parent)) throw new Error(`ENOENT: ${path}`);
		this.files.set(actual, new Uint8Array(data.slice(0)));
		this.changed();
	}

	private addFolder(path: string): void {
		const actual = this.resolve(path);
		if (this.files.has(actual)) throw new Error(`EEXIST: ${path}`);
		const parent = parentOf(actual);
		if (parent !== "" && !this.folders.has(parent)) throw new Error(`ENOENT: ${path}`);
		this.folders.add(actual);
		this.changed();
	}

	private take(path: string, where: FakeTrashed["where"]): void {
		const actual = this.resolve(path);
		if (!this.files.delete(actual)) throw new Error(`ENOENT: ${path}`);
		this.trashed.push({ path: actual, where });
		this.changed();
	}

	private move(from: string, to: string): void {
		const source = this.resolve(from);
		const isFile = this.files.has(source);
		if (!isFile && !this.folders.has(source)) throw new Error(`ENOENT: ${from}`);
		const parent = parentOf(to);
		const resolvedParent = parent === "" ? "" : this.resolve(parent);
		if (resolvedParent !== "" && !this.folders.has(resolvedParent)) throw new Error(`ENOENT: ${to}`);
		const target = (resolvedParent === "" ? "" : `${resolvedParent}/`) + lastOf(to).normalize("NFC");
		// What is at the new name is replaced, unless it is the thing itself.
		const found = this.resolve(to);
		if (found !== source) {
			this.files.delete(found);
			for (const path of [...this.files.keys()]) if (path.startsWith(`${found}/`)) this.files.delete(path);
			for (const path of [...this.folders]) {
				if (path === found || path.startsWith(`${found}/`)) this.folders.delete(path);
			}
		}

		if (isFile) {
			const file = this.files.get(source);
			this.files.delete(source);
			if (file !== undefined) this.files.set(target, file);
		} else {
			const moved = (path: string): string => target + path.slice(source.length);
			for (const [path, file] of [...this.files]) {
				if (!path.startsWith(`${source}/`)) continue;
				this.files.delete(path);
				this.files.set(moved(path), file);
			}
			for (const path of [...this.folders]) {
				if (path !== source && !path.startsWith(`${source}/`)) continue;
				this.folders.delete(path);
				this.folders.add(moved(path));
			}
		}
		this.changed();
	}
}

function parentOf(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

function lastOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function bufferOf(content: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(content.byteLength);
	copy.set(content);
	return copy.buffer;
}
