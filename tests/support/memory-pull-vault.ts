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

import type { PullVault, SaveResult, TrashMode, VaultStat } from "../../src/core/pull-io";
import { bytes, type FileContent } from "./memory-backend";

export type VaultOp = "list" | "stat" | "read" | "write" | "rename" | "trash" | "remove-folder" | "save";

export interface TrashedFile {
	readonly path: string;
	readonly mode: TrashMode;
	readonly content: string;
}

interface StoredFile {
	content: Uint8Array;
	mtime: number;
}

/**
 * A vault a pull can read and write, in memory. Like a real one where a
 * test can tell:
 *
 * - With `caseSensitive: false` (a Mac) a name finds a file or a folder
 *   whatever its case, a write keeps the spelling that is there, and a
 *   rename that only changes the case changes the spelling. With `true` (an
 *   iPhone) two names that differ in case are two files.
 * - NFC and NFD of one name are one file on both.
 * - A rename onto another file or folder fails and changes nothing.
 * - A file an editor has open can hold text that is not on disk yet;
 *   `saveOpenEditors` writes it.
 *
 * `before` is called ahead of every operation with what it is and the path
 * it is given. A test throws from it to make the operation fail, or changes
 * the vault from it to stand in for the user.
 */
export class MemoryPullVault implements PullVault {
	readonly caseSensitive: boolean;
	/** Every operation that changed the vault or asked an editor to save, in order. */
	readonly log: string[] = [];
	readonly trashed: TrashedFile[] = [];
	before: ((op: VaultOp, path: string) => void | Promise<void>) | undefined;
	/** Renames are accepted and not made: the call resolves and the vault is as it was. */
	ignoreRenames = false;

	private readonly files = new Map<string, StoredFile>();
	private readonly folders = new Set<string>();
	private readonly editors = new Map<string, string[] | "fail">();
	private readonly now: () => number;

	constructor(options: { caseSensitive: boolean; now: () => number }) {
		this.caseSensitive = options.caseSensitive;
		this.now = options.now;
	}

	// -----------------------------------------------------------------------
	// For the tests

	/** Puts a file in the vault, as the user would. `mtime` defaults to now. */
	put(path: string, content: FileContent, mtime = this.now()): void {
		const actual = this.resolve(path);
		this.makeFolders(actual);
		this.files.set(actual, { content: bytes(content), mtime });
	}

	putAll(files: Record<string, FileContent>, mtime = this.now()): void {
		for (const [path, content] of Object.entries(files)) this.put(path, content, mtime);
	}

	remove(path: string): void {
		this.files.delete(this.resolve(path));
	}

	makeFolder(path: string): void {
		this.makeFolders(`${this.resolve(path)}/x`);
	}

	/** The content of a file as text, or `undefined`. Found like the file system finds it. */
	text(path: string): string | undefined {
		const file = this.files.get(this.resolve(path));
		return file === undefined ? undefined : new TextDecoder().decode(file.content);
	}

	/** Every file, as it is spelled, sorted. */
	paths(): string[] {
		return [...this.files.keys()].sort();
	}

	/** Every file with its content as text. */
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const path of this.paths()) out[path] = this.text(path) ?? "";
		return out;
	}

	/** Every file as the disk has it: its spelling, time and size. */
	stats(): { path: string; mtime: number; size: number }[] {
		return [...this.files].map(([path, file]) => ({ path, mtime: file.mtime, size: file.content.length }));
	}

	folderPaths(): string[] {
		return [...this.folders].sort();
	}

	/**
	 * An editor has the file open. Each text is what the user has typed by
	 * the time of one more save: the first save writes the first text, the
	 * next save the next. A save with no text left writes nothing.
	 */
	open(path: string, ...unsaved: string[]): void {
		this.editors.set(this.fold(path), [...unsaved]);
	}

	/** An editor has the file open and cannot save. */
	openFailing(path: string): void {
		this.editors.set(this.fold(path), "fail");
	}

	close(path: string): void {
		this.editors.delete(this.fold(path));
	}

	// -----------------------------------------------------------------------
	// PullVault

	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		await this.before?.("list", folder);
		const actual = folder === "/" ? "" : this.resolve(folder);
		if (actual !== "" && !this.folders.has(actual)) throw new Error(`no such folder: ${folder}`);
		const inside = (path: string): boolean => parentOf(path) === actual;
		return {
			files: [...this.files.keys()].filter(inside),
			folders: [...this.folders].filter(inside),
		};
	}

	async stat(path: string): Promise<VaultStat | null> {
		await this.before?.("stat", path);
		const actual = this.resolve(path);
		const file = this.files.get(actual);
		if (file !== undefined) return { type: "file", mtime: file.mtime, size: file.content.length };
		return this.folders.has(actual) ? { type: "folder", mtime: 0, size: 0 } : null;
	}

	async read(path: string): Promise<Uint8Array> {
		await this.before?.("read", path);
		const file = this.files.get(this.resolve(path));
		if (file === undefined) throw new Error(`no such file: ${path}`);
		return file.content;
	}

	async write(path: string, content: Uint8Array): Promise<void> {
		await this.before?.("write", path);
		const actual = this.resolve(path);
		if (this.folders.has(actual)) throw new Error(`a folder is at ${path}`);
		this.makeFolders(actual);
		this.files.set(actual, { content, mtime: this.now() });
		this.log.push(`write ${path}`);
	}

	async rename(from: string, to: string): Promise<void> {
		await this.before?.("rename", from);
		if (this.ignoreRenames) return;
		const source = this.resolve(from);
		const isFile = this.files.has(source);
		if (!isFile && !this.folders.has(source)) throw new Error(`nothing at ${from}`);
		const found = this.resolve(to);
		const taken = this.files.has(found) || this.folders.has(found);
		if (taken && found !== source) throw new Error(`something is at ${to}`);
		// The folders on the way keep the spelling they have; the last name
		// is taken as it was given.
		const parent = parentOf(to);
		const target = (parent === "" ? "" : `${this.resolve(parent)}/`) + lastOf(to);
		this.makeFolders(target);

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
		this.log.push(`rename ${from} -> ${to}`);
	}

	async trash(path: string, mode: TrashMode): Promise<void> {
		await this.before?.("trash", path);
		const actual = this.resolve(path);
		const file = this.files.get(actual);
		if (file === undefined) throw new Error(`no such file: ${path}`);
		this.files.delete(actual);
		this.trashed.push({ path: actual, mode, content: new TextDecoder().decode(file.content) });
		this.log.push(`trash ${path} (${mode})`);
	}

	async removeFolderIfEmpty(path: string): Promise<boolean> {
		await this.before?.("remove-folder", path);
		const actual = this.resolve(path);
		if (this.files.has(actual)) throw new Error(`a file is at ${path}`);
		if (!this.folders.has(actual)) return true;
		const inside = (other: string): boolean => other.startsWith(`${actual}/`);
		if ([...this.files.keys()].some(inside) || [...this.folders].some(inside)) return false;
		this.folders.delete(actual);
		this.log.push(`remove-folder ${path}`);
		return true;
	}

	async saveOpenEditors(path: string): Promise<SaveResult> {
		await this.before?.("save", path);
		const editor = this.editors.get(this.fold(path));
		if (editor === undefined) return "not-open";
		this.log.push(`save ${path}`);
		if (editor === "fail") return "failed";
		const text = editor.shift();
		if (text !== undefined) {
			const actual = this.resolve(path);
			this.makeFolders(actual);
			this.files.set(actual, { content: bytes(text), mtime: this.now() });
		}
		return "saved";
	}

	// -----------------------------------------------------------------------

	private fold(path: string): string {
		const nfc = path.normalize("NFC");
		return this.caseSensitive ? nfc : nfc.toLowerCase();
	}

	/** The path as the vault spells it, as far down as something is there. */
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
			actual = found ?? wanted;
		}
		return actual;
	}

	private makeFolders(actualPath: string): void {
		for (let slash = actualPath.indexOf("/"); slash !== -1; slash = actualPath.indexOf("/", slash + 1)) {
			const folder = actualPath.slice(0, slash);
			if (this.files.has(folder)) throw new Error(`a file is at ${folder}`);
			this.folders.add(folder);
		}
	}
}

function parentOf(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

function lastOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
