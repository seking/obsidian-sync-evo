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

// The vault of the app as a pull sees it. The app has two ways to a file:
// its own index, which tells the open editors and the link index of a change
// but leaves out every name that starts with a `.`, and the disk underneath,
// which reaches every path and tells no one. Which of the two a path goes
// through is decided here; the calls themselves are behind `VaultPorts`, so
// that the deciding runs in a test against a disk that is not there.
//
// The index looks a path up by its exact spelling, while most disks find a
// file whatever its case. Wherever the two can disagree, the disk is asked:
// `stat` for whether something is there, and the listing of the folder for
// how it is spelled.

import { foldedKey, pathKey } from "./paths";
import type { PullVault, SaveResult, TrashMode, VaultStat } from "./pull-io";
import { fromRoot } from "./scan";
import {
	differOnlyInSpelling,
	foldersTo,
	isDotPath,
	joinPath,
	lastOf,
	parentOf,
	pickSpelling,
	trashOptionOf,
	trashRoute,
} from "./vault-routes";

export interface FolderListing {
	readonly files: readonly string[];
	readonly folders: readonly string[];
}

/** What the app's index holds at a path. `handle` is the app's own object for it. */
export interface IndexedItem<Handle> {
	readonly type: "file" | "folder";
	/** The path as the index spells it. */
	readonly path: string;
	readonly handle: Handle;
}

export interface OpenEditor {
	/** The path of the file it shows, as the index spells it. */
	readonly path: string;
	/** Writes what was typed. Rejects when it could not. */
	save(): Promise<void>;
}

/**
 * The calls of the app, one for one. Nothing is decided behind this
 * interface.
 */
export interface VaultPorts<Handle> {
	/** The name of the configuration folder, which every vault has at its root. */
	readonly configDir: string;

	// The disk: every path, with the eyes of the file system.
	list(folder: string): Promise<FolderListing>;
	stat(path: string): Promise<VaultStat | null>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Removes an empty folder, and fails for one that is not. */
	rmdir(path: string): Promise<void>;
	renameOnDisk(from: string, to: string): Promise<void>;
	/** Answers `false` when there is no system trash for the path. */
	trashSystem(path: string): Promise<boolean>;
	/** Into the `.trash/` of the vault. */
	trashLocal(path: string): Promise<void>;
	/** For good. */
	remove(path: string): Promise<void>;
	/**
	 * The links right in the folder, and whether a path is one
	 * (`FolderLister.linksIn`, `LinkProbe`). Absent where links cannot be
	 * told.
	 */
	readonly linksIn?: (folder: string) => Promise<readonly string[]>;
	readonly isLink?: (path: string) => Promise<boolean>;
	/**
	 * What `list` returns, read from the disk another way, for a folder
	 * `list` fails at: the app's listing fails at a link whose target
	 * cannot be reached (seen on a Mac), and this leaves such a link out.
	 * Absent where links cannot be told.
	 */
	readonly listOnDisk?: (folder: string) => Promise<FolderListing>;

	// The index: looked up by the exact spelling.
	indexed(path: string): IndexedItem<Handle> | null;
	create(path: string, data: ArrayBuffer): Promise<void>;
	modify(file: Handle, data: ArrayBuffer): Promise<void>;
	createFolder(path: string): Promise<void>;
	/** Renames without touching the links in other files. */
	renameIndexed(item: Handle, to: string): Promise<void>;
	/** Where the app's setting for deleted files says. */
	trashBySetting(item: Handle): Promise<void>;
	/** Into the `.trash/` of the vault, whatever the setting. */
	trashToVault(item: Handle): Promise<void>;

	/** The app's setting for deleted files, unchecked. */
	trashOption(): unknown;
	/** Every view, in every window, that shows a file and can save. */
	openEditors(): readonly OpenEditor[];
}

/** The root, as the pull names it and as the app spells the path of its root folder. */
const ROOT = "/";

export class RoutedVault<Handle> implements PullVault {
	private readonly ports: VaultPorts<Handle>;
	readonly linksIn?: (folder: string) => Promise<readonly string[]>;
	readonly isLink?: (path: string) => Promise<boolean>;

	/**
	 * Whether each folder a write, a rename or a trash went through is a
	 * link, by folded path. Kept for the life of this vault, which is one
	 * sync: a folder is asked once, and only the path itself each time.
	 */
	private readonly linkFolders = new Map<string, Promise<boolean>>();

	/**
	 * The folders with a `.` name a write made or found, as the disk spells
	 * them, by the path asked for, spelled exactly: a parent spelled anew
	 * by another app in the meantime is no longer found here. Found once instead of on every write below them
	 * (`ensureFolder`): each look lists every folder from the root. Kept for
	 * the life of this vault, which is one sync, and forgotten on any rename,
	 * trash or removal, which may take such a folder away or spell it anew.
	 */
	private readonly dotFolders = new Map<string, string>();

	constructor(ports: VaultPorts<Handle>) {
		this.ports = ports;
		const { linksIn, isLink } = ports;
		if (linksIn !== undefined) {
			// A folder whose links cannot be read fails like one that
			// cannot be listed, with what the listing says: it is listed
			// again, and only when that goes through is the first failure
			// passed on. The scan fails either way; going on without the
			// links would follow them.
			this.linksIn = async (folder) => {
				let links: readonly string[];
				try {
					links = await linksIn(folder);
				} catch (error) {
					await this.list(folder);
					throw error;
				}
				return links.map(fromRoot);
			};
		}
		if (isLink !== undefined) this.isLink = isLink;
	}

	// -----------------------------------------------------------------------
	// Reading: always the disk, which sees every path

	/**
	 * The disk is given the root as `/`, the path the app's own root folder
	 * has. Whether every platform takes that spelling, and whether what
	 * comes back carries the root in front, is not documented; so the root
	 * in front is dropped, and a listing of the root that lacks the
	 * configuration folder is not believed. That folder is in every vault
	 * (the plugin runs from it), so a listing without it is a listing of
	 * something else, and an empty vault read from it would turn every
	 * record into a deletion. The other spelling a root could have, the
	 * empty one, is tried when `/` is refused or lists something else.
	 */
	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		if (folder !== ROOT && folder !== "") return this.listed(folder);

		const config = foldedKey(fromRoot(this.ports.configDir));
		const hasConfig = (listing: { folders: string[] }): boolean =>
			listing.folders.some((path) => foldedKey(path) === config);
		let refused: { readonly error: unknown } | undefined;
		try {
			const listing = await this.listed(ROOT);
			if (hasConfig(listing)) return listing;
		} catch (error) {
			refused = { error };
		}
		try {
			const again = await this.listed("");
			if (hasConfig(again)) return again;
		} catch (error) {
			// What the first spelling failed with says more than the second try.
			throw refused === undefined ? error : refused.error;
		}
		if (refused !== undefined) throw refused.error;
		throw new Error("The listing of the vault root does not hold the configuration folder.");
	}

	/**
	 * A folder the app cannot list is listed from the disk, where that can
	 * be done (`VaultPorts.listOnDisk`): one link whose target is gone would
	 * otherwise fail every sync. That listing leaves the link out, as the
	 * scan expects of a listing (`scanVault`), and tells it with the other
	 * links. Whole or not at all: when it fails too, what the app's listing
	 * failed with is passed on.
	 */
	private async listed(folder: string): Promise<{ files: string[]; folders: string[] }> {
		const { listOnDisk } = this.ports;
		let listing: FolderListing;
		try {
			listing = await this.ports.list(folder);
		} catch (error) {
			if (listOnDisk === undefined) throw error;
			try {
				listing = await listOnDisk(folder);
			} catch {
				throw error;
			}
		}
		return { files: listing.files.map(fromRoot), folders: listing.folders.map(fromRoot) };
	}

	async stat(path: string): Promise<VaultStat | null> {
		const stat = await this.ports.stat(path);
		return stat === null ? null : { type: stat.type, mtime: stat.mtime, size: stat.size };
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.ports.readBinary(path));
	}

	// -----------------------------------------------------------------------
	// Writing

	/**
	 * A path with a `.` name goes to the disk. Any other goes through the
	 * index, and whether that is a `modify` or a `create` is settled in
	 * three steps:
	 *
	 * 1. The index holds a file at this spelling: modify it.
	 * 2. The disk has nothing at the path, under any spelling it would take
	 *    for the same: create it, in the folder as the disk spells it.
	 * 3. The disk has a file the index does not hold at this spelling. On a
	 *    disk that does not tell the cases apart, that is the file under
	 *    another spelling (`Notes/A.md` for `notes/a.md`), and a `create`
	 *    would fail or leave the index with two files for one. The folders
	 *    are listed for how the disk spells it, and the file the index
	 *    holds at that spelling is modified. The name on disk stays as it
	 *    is; the pull never takes a write for a rename. When the index does
	 *    not hold that spelling either (it is behind), the disk is written:
	 *    the bytes are right, and the app picks the change up from there as
	 *    it does for a `.` path.
	 *
	 * On a disk that tells the cases apart, step 3 only finds the exact
	 * spelling, so a write to `notes.md` can never reach `Notes.md`.
	 */
	async write(path: string, content: Uint8Array): Promise<void> {
		const { ports } = this;
		await this.refuseLinks(path);
		const data = bufferOf(content);
		if (isDotPath(path)) {
			if ((await ports.stat(path))?.type === "folder") throw new Error(`a folder is at ${path}`);
			await this.ensureFolder(parentOf(path));
			await ports.writeBinary(path, data);
			return;
		}

		const indexed = this.indexed(path);
		if (indexed?.type === "file") {
			await ports.modify(indexed.handle, data);
			return;
		}
		if (indexed !== null) throw new Error(`a folder is at ${path}`);

		const stat = await ports.stat(path);
		if (stat === null) {
			const folder = await this.ensureFolder(parentOf(path));
			await ports.create(joinPath(folder, lastOf(path)), data);
			return;
		}
		if (stat.type !== "file") throw new Error(`a folder is at ${path}`);

		const spelled = (await this.spelledOnDisk(path)) ?? path;
		const file = this.indexed(spelled);
		if (file?.type === "file") await ports.modify(file.handle, data);
		else await ports.writeBinary(spelled, data);
	}

	/**
	 * The index's rename for what the index holds, the disk's for the rest.
	 *
	 * Something at `to` fails the rename before anything is called, since
	 * not every platform's rename refuses to replace it. The one exception
	 * is the file itself: on a disk that does not tell the cases apart,
	 * `stat("Notes.md")` finds `notes.md`. The two are told apart by the
	 * spelling the disk has for each: the folders are listed, and when
	 * `from` and `to` come out as one and the same name on disk, there is
	 * one file and the rename is a change of its spelling. On a disk that
	 * tells the cases apart, a `Notes.md` beside `notes.md` comes out as
	 * its own name, and the rename fails.
	 */
	async rename(from: string, to: string): Promise<void> {
		const { ports } = this;
		this.dotFolders.clear();
		await this.refuseLinks(from);
		await this.refuseLinks(to);
		// Asked of the disk first: the listing alone would take a name that
		// differs in case for this one, also where it is another file.
		const source = (await ports.stat(from)) === null ? null : await this.spelledOnDisk(from);
		if (source === null) throw new Error(`nothing at ${from}`);

		if ((await ports.stat(to)) !== null) {
			const taken = differOnlyInSpelling(from, to) ? await this.spelledOnDisk(to) : null;
			if (taken !== source) throw new Error(`something is at ${to}`);
		}

		// The folders on the way keep the spelling they have; the last name
		// is taken as it was given.
		const target = joinPath(await this.ensureFolder(parentOf(to)), lastOf(to));
		if (target === source) return;

		const indexed = isDotPath(source) || isDotPath(target) ? null : this.indexed(source);
		if (indexed !== null) await ports.renameIndexed(indexed.handle, target);
		else await ports.renameOnDisk(source, target);
	}

	async trash(path: string, mode: TrashMode): Promise<void> {
		const { ports } = this;
		this.dotFolders.clear();
		await this.refuseLinks(path);
		const item = await this.find(path);
		const route = trashRoute(mode, item !== null, trashOptionOf(ports.trashOption()));
		if (item !== null) {
			if (route === "vault-local") await ports.trashToVault(item.handle);
			else await ports.trashBySetting(item.handle);
			return;
		}

		// The disk's calls do not all say when there was nothing to take.
		if ((await ports.stat(path)) === null) throw new Error(`nothing at ${path}`);
		switch (route) {
			case "adapter-system":
				if (!(await ports.trashSystem(path))) await ports.trashLocal(path);
				return;
			case "adapter-remove":
				await ports.remove(path);
				return;
			// The last two are the routes of the index, which a path outside
			// it cannot take.
			case "adapter-local":
			case "file-manager":
			case "vault-local":
				await ports.trashLocal(path);
				return;
		}
	}

	/**
	 * Removed with the call that takes nothing along: if a file appears in
	 * the folder between the look and the removal, the removal fails and
	 * the file stays.
	 */
	async removeFolderIfEmpty(path: string): Promise<boolean> {
		const { ports } = this;
		this.dotFolders.clear();
		await this.refuseLinks(path);
		const stat = await ports.stat(path);
		if (stat === null) return true;
		if (stat.type !== "folder") throw new Error(`a file is at ${path}`);
		if (!(await this.isEmpty(path))) return false;
		try {
			await ports.rmdir(path);
		} catch (error) {
			if ((await ports.stat(path)) === null) return true;
			if (!(await this.isEmpty(path))) return false;
			throw error;
		}
		return true;
	}

	/**
	 * The file is matched without regard to case: where the disk does not
	 * tell the cases apart, the editor may have it open under another
	 * spelling, and an editor asked to save without need loses nothing.
	 */
	async saveOpenEditors(path: string): Promise<SaveResult> {
		const wanted = foldedKey(path);
		const editors = this.ports.openEditors().filter((editor) => foldedKey(editor.path) === wanted);
		if (editors.length === 0) return "not-open";

		let failed = false;
		for (const editor of editors) {
			try {
				await editor.save();
			} catch {
				failed = true;
			}
		}
		return failed ? "failed" : "saved";
	}

	// -----------------------------------------------------------------------

	/**
	 * Fails when the path, or a folder on the way to it, is a link of the
	 * vault (`VaultPorts.isLink`): what is written or deleted there would
	 * be the place it points to, which can be outside the vault. The sync
	 * decision turns such paths away before (`PlanInput.links`); this is
	 * for what a scan did not tell, such as a file the app's index holds
	 * that is a link. The caller takes the failure as the vault refusing
	 * the path. Nothing is asked where links cannot be told.
	 */
	private async refuseLinks(path: string): Promise<void> {
		const { isLink } = this.ports;
		if (isLink === undefined) return;
		for (const folder of foldersTo(path)) {
			const key = foldedKey(folder);
			let asked = this.linkFolders.get(key);
			if (asked === undefined) {
				asked = isLink(folder);
				this.linkFolders.set(key, asked);
			}
			if (await asked) throw new Error(`a link of the vault is at ${folder}`);
		}
		if (await isLink(path)) throw new Error(`a link of the vault is at ${path}`);
	}

	/** What the index holds at exactly this spelling, in the form given or in NFC, which is the form it keeps. */
	private indexed(path: string): IndexedItem<Handle> | null {
		return this.ports.indexed(path) ?? this.ports.indexed(pathKey(path));
	}

	/**
	 * What the index holds for the file the disk has at the path, or `null`
	 * when it holds nothing for it: a `.` path, or a file it has not seen.
	 */
	private async find(path: string): Promise<IndexedItem<Handle> | null> {
		if (isDotPath(path)) return null;
		const indexed = this.indexed(path);
		if (indexed !== null) return indexed;
		if ((await this.ports.stat(path)) === null) return null;
		const spelled = await this.spelledOnDisk(path);
		return spelled === null ? null : this.indexed(spelled);
	}

	/**
	 * The path as the disk spells it, name by name from the root, or `null`
	 * when a name on the way is not there. This is the only thing that
	 * tells a spelling on disk: `stat` answers for any spelling where the
	 * cases are not told apart.
	 *
	 * Only to be asked once `stat` has said that something is at the path.
	 * A name that differs in case is taken for the wanted one, which is
	 * right where the disk found it under that name and wrong where the
	 * cases are told apart and nothing is at the path.
	 */
	private async spelledOnDisk(path: string): Promise<string | null> {
		let spelled = "";
		for (const part of path.split("/")) {
			let listing: { files: string[]; folders: string[] };
			try {
				listing = await this.listed(spelled === "" ? ROOT : spelled);
			} catch {
				// Not a folder, or not there.
				return null;
			}
			const name = pickSpelling([...listing.files, ...listing.folders].map(lastOf), part);
			if (name === null) return null;
			spelled = joinPath(spelled, name);
		}
		return spelled;
	}

	/**
	 * Makes the folder and every folder on the way to it, and answers the
	 * path as the disk spells it: a folder that is there under another
	 * spelling is used as it is. A folder with a `.` name is made on the
	 * disk, any other through the index.
	 */
	private async ensureFolder(folder: string): Promise<string> {
		let spelled = "";
		if (folder === "") return spelled;
		for (const wanted of foldersTo(`${folder}/`)) {
			const path = joinPath(spelled, lastOf(wanted));
			const dot = isDotPath(path);
			const indexed = dot ? null : this.indexed(path);
			if (indexed?.type === "folder") {
				spelled = indexed.path;
				continue;
			}
			const known = dot ? this.dotFolders.get(path) : undefined;
			if (known !== undefined) {
				spelled = known;
				continue;
			}
			const stat = await this.ports.stat(path);
			if (stat === null) {
				await this.makeFolder(path);
				spelled = path;
			} else if (stat.type === "folder") {
				spelled = (await this.spelledOnDisk(path)) ?? path;
			} else {
				throw new Error(`a file is at ${path}`);
			}
			if (dot) this.dotFolders.set(path, spelled);
		}
		return spelled;
	}

	private async makeFolder(path: string): Promise<void> {
		try {
			if (isDotPath(path)) await this.ports.mkdir(path);
			else await this.ports.createFolder(path);
		} catch (error) {
			// Made by someone else in the meantime.
			if ((await this.ports.stat(path))?.type !== "folder") throw error;
		}
	}

	private async isEmpty(folder: string): Promise<boolean> {
		const listing = await this.ports.list(folder);
		return listing.files.length === 0 && listing.folders.length === 0;
	}
}

/** The bytes as a buffer of their own: a view can be a part of a larger one. */
function bufferOf(content: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(content.byteLength);
	copy.set(content);
	return copy.buffer;
}
