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

// The light check: the files of the vault without walking it. It answers
// what the scan answers (`scan.ts`), from what the app holds in memory, for
// a sync that starts by itself every few minutes. Listing every folder of a
// large vault takes seconds on a phone; this takes none of them.
//
// It is another source of the same list and decides nothing: what becomes
// of a file, and of a record that has no file, is decided from the list
// like after a scan, by the same code.
//
// What it cannot see: a path with a name that starts with a `.` which
// neither the remote nor a record knows. The app's index holds no such
// path, and finding one takes listing the folders. A new file like that
// waits for the next scan: a sync the user starts, or the one when the app
// comes back to the front. So does a name a rename was left at
// (`ScanResult.renaming`) that has no file of the index at or below it.

import type { RemoteEntry } from "./backend";
import { type Exclusion, knownPaths } from "./exclusion";
import { foldedKey, isPathFromRoot, pathKey } from "./paths";
import type { SyncRecord } from "./plan";
import type { PullVault } from "./pull-io";
import { fromRoot, type RenamingFound, type ScannedPath, type ScanResult } from "./scan";
import { foldersTo, lastOf, parentOf, renamingPathOf } from "./vault-routes";
import type { FileStat } from "./state";

/** A file as the app's index of the vault holds it. */
export interface IndexedFile {
	/** Path from the vault root. */
	readonly path: string;
	/** Milliseconds since the epoch, as the index has it: not asked of the disk. */
	readonly mtime: number;
	readonly size: number;
}

/**
 * The app's own index of the vault: every file whose path has no name that
 * starts with a `.`, with the time and the size the app last saw. Answered
 * from memory, without a look at the disk.
 */
export interface VaultIndex {
	indexedFiles(): readonly IndexedFile[];
}

export interface LightScanInput {
	readonly index: VaultIndex;
	/**
	 * The disk, for the few paths the index says nothing of, for which
	 * folders are links, and for how a path is spelled where the index has
	 * it in two cases.
	 */
	readonly vault: Pick<PullVault, "list" | "stat" | "isLink">;
	/** The same three the scan is given (`ScanInput`). */
	readonly exclusion: Exclusion;
	readonly remote: readonly RemoteEntry[];
	readonly records: readonly SyncRecord[];
}

export interface LightScanResult extends ScanResult {
	/**
	 * What the index says of each file it lists, by key. Whoever reads the
	 * files takes one whose time and size here are its record's as
	 * unchanged, without a look at the disk (`LocalReadDeps.indexed`).
	 */
	readonly indexed: ReadonlyMap<string, FileStat>;
	/** How many paths the index did not list and the disk was asked about. */
	readonly asked: number;
	/** How many files of the index were left out at a spelling the disk does not have (`onDisk`). */
	readonly notOnDisk: number;
}

/**
 * Lists the vault from the app's index, and from the disk only where the
 * index cannot answer.
 *
 * From the index: every file it holds, less what the scan would leave out
 * by the same rules, asked of the same exclusion: an excluded file, a file
 * below an excluded folder, and what lies below a path a record holds as a
 * symlink (on a desktop the index lists the content of the folder it
 * points to), and what lies below a link of the vault (`LinkProbe`). Every
 * folder the index holds a file in is asked whether it is a link, once;
 * a file the index holds is not, since the app leaves a link to a file out
 * of its index (seen on a Mac).
 *
 * From the disk: every path that is known, on the remote or in a record,
 * that the index does not list, and that the exclusion does not leave out. That is every known path with a `.`
 * name, and a file the index has lost or not found yet. Each is looked for
 * at its path, and when nothing is there, the placeholder a cloud drive
 * leaves is (`.<name>.icloud`), so that a file that was taken off the
 * device reads as that and not as deleted, as in the scan. Known on the
 * remote and not only by a record: a path the remote has got since the last
 * sync can have a file of the vault at it that no record knows, and a pull
 * that did not see it would write over it uncompared.
 *
 * A path the disk has nothing at is left out, like a file the scan does
 * not find. So is a path that is a link, or below one: the app leaves out
 * of its index what lies below a link to a folder of the vault itself, and
 * a link to a file, but the disk answers for them. A link whose target is
 * gone, which the disk does not stat, is told as a link too. What that means is the sync decision's to say.
 *
 * Such a path is listed as the record spells it, or the remote: the disk
 * is asked whether something is there, and not how it is spelled. A change
 * of case alone is found by the next scan. The one spelling that is tried
 * beside it is the other normalization: a record spells a path as the
 * remote does, usually in NFC, and a disk that tells NFC from NFD (Linux,
 * Android) can hold the file under the other. Asked for under one spelling
 * alone, such a file would read as deleted. It is listed as it was found.
 *
 * Where two paths of the index differ in case alone, or the folders on the
 * way to them do, the disk is asked which of the spellings it has
 * (`onDisk`).
 *
 * A failure of the disk to answer fails the whole check, like a folder
 * that cannot be listed: a list with a hole would read as deletions.
 */
export async function scanLightly(input: LightScanInput): Promise<LightScanResult> {
	const { exclusion, vault } = input;
	const known = knownPaths(input.remote, input.records);
	const symlinks = new Set<string>();
	for (const record of input.records) {
		if (record.kind === "symlink") symlinks.add(foldedKey(record.path));
	}

	// The links of the vault, as the scan tells them (`ScanResult.links`).
	const links: string[] = [];
	const isLink = async (path: string, kind: "file" | "folder"): Promise<boolean> => {
		if (vault.isLink === undefined || !(await vault.isLink(path))) return false;
		if (!exclusion.excludes(path, kind, known)) links.push(path);
		return true;
	};

	// Whether the scan would not have entered a folder: itself or one above
	// it is excluded, is a symlink, or is a link. Asked once per folder.
	const skipped = new Map<string, Promise<boolean>>();
	const folderSkipped = (folder: string): Promise<boolean> => {
		const before = skipped.get(folder);
		if (before !== undefined) return before;
		const skip = (async () => {
			const slash = folder.lastIndexOf("/");
			if (slash !== -1 && (await folderSkipped(folder.slice(0, slash)))) return true;
			if (exclusion.excludes(folder, "folder", known) || symlinks.has(foldedKey(folder))) return true;
			return isLink(folder, "folder");
		})();
		skipped.set(folder, skip);
		return skip;
	};
	const leftOut = async (path: string): Promise<boolean> => {
		const slash = path.lastIndexOf("/");
		return (slash !== -1 && (await folderSkipped(path.slice(0, slash)))) || exclusion.excludes(path, "file", known);
	};

	const paths: ScannedPath[] = [];
	const indexed = new Map<string, FileStat>();
	// Without the cases, like the folders of a disk that does not tell them
	// apart: a file the index spells otherwise than its record is that file.
	const listed = new Set<string>();
	// By folded path, each as the index spells it (`ScanResult.renaming`):
	// a file of the index itself, or a folder a file of it is below.
	const renaming = new Map<string, RenamingFound>();
	const there = await onDisk(input.index.indexedFiles(), vault);
	for (const file of there.files) {
		const path = fromRoot(file.path);
		if (!isPathFromRoot(path)) continue;
		listed.add(foldedKey(path));
		const between = renamingPathOf(path);
		if (between !== null) {
			renaming.set(foldedKey(between), { path: between, type: between === path ? "file" : "folder" });
			continue;
		}
		if (await leftOut(path)) continue;
		const key = pathKey(path);
		paths.push({ path, key, state: "present" });
		indexed.set(key, { mtime: file.mtime, size: file.size });
	}

	let asked = 0;
	// The records first: a record spells the path as this device has it.
	for (const { path } of [...input.records, ...input.remote]) {
		const folded = foldedKey(path);
		// A path that is none is the sync decision's to turn away.
		if (!isPathFromRoot(pathKey(path)) || listed.has(folded)) continue;
		listed.add(folded);
		if (await leftOut(path)) continue;
		asked += 1;
		const key = pathKey(path);
		const spellings = [...new Set([path, path.normalize("NFD"), key])];
		let found: ScannedPath | "folder" | "link" | null = null;
		for (const spelled of spellings) {
			const stat = await vault.stat(spelled);
			if (stat === null) {
				// A link whose target is gone: the disk has nothing to stat there.
				if (await isLink(spelled, "file")) {
					found = "link";
					break;
				}
				continue;
			}
			// A folder at the path is no file there, as for the scan.
			if (await isLink(spelled, stat.type)) found = "link";
			else found = stat.type === "file" ? { path: spelled, key, state: "present" } : "folder";
			break;
		}
		for (const spelled of found === null ? spellings : []) {
			const placeholder = await vault.stat(placeholderOf(spelled));
			if (placeholder === null || placeholder.type !== "file") continue;
			found = { path: spelled, key, state: "placeholder" };
			break;
		}
		if (found !== null && found !== "folder" && found !== "link") paths.push(found);
	}

	return {
		paths,
		rootHasGit: (await vault.stat(".git")) !== null,
		links,
		renaming: [...renaming.values()],
		indexed,
		asked,
		notOnDisk: there.notOnDisk,
	};
}

/**
 * The files of the index, less those at a spelling the disk does not have,
 * and how many those were. A path the index holds twice is kept once.
 *
 * After a change of case alone, the app can hold the old spelling beside
 * the new one, where its disk does not tell the cases apart: Android looks
 * at the old name of a rename it was told of, and when that is after the
 * second of the two renames (`RoutedVault.rename`), the disk finds the file
 * at it and the app puts the old name back. Listed, the old name would be a
 * new file that differs from another in case alone, which the push refuses
 * to send until the app starts again.
 *
 * Only where the index has one path, or one folder on the way, in two
 * cases is the folder above it listed, and a spelling the listing does not
 * hold left out, with everything below it. A disk that tells the cases
 * apart and has both keeps both. Elsewhere the disk is not asked, and the
 * check costs what it did.
 *
 * Twice, the app can hold a path as two of its objects: in NFC and in NFD,
 * or once the old spelling is left beside the new one and the remote
 * changes the case back. Listed twice, it would be two files at one key.
 * The first is kept: the two are the one file of the disk.
 */
async function onDisk(
	indexedFiles: readonly IndexedFile[],
	vault: Pick<PullVault, "list">,
): Promise<{ readonly files: readonly IndexedFile[]; readonly notOnDisk: number }> {
	const once = new Map<string, IndexedFile>();
	for (const file of indexedFiles) {
		const key = pathKey(fromRoot(file.path));
		if (!once.has(key)) once.set(key, file);
	}
	const files = [...once.values()];
	// The path itself and each folder on the way to it.
	const steps = (path: string): string[] => [...foldersTo(path), path];
	// The spellings the index has, by folded path.
	const spellings = new Map<string, Set<string>>();
	for (const file of files) {
		const path = pathKey(fromRoot(file.path));
		for (const step of isPathFromRoot(path) ? steps(path) : []) {
			const key = foldedKey(step);
			const known = spellings.get(key) ?? new Set<string>();
			known.add(step);
			spellings.set(key, known);
		}
	}
	if ([...spellings.values()].every((known) => known.size === 1)) return { files, notOnDisk: 0 };

	// The names right in each folder, as the disk spells them. Listed once.
	const listings = new Map<string, Promise<Set<string>>>();
	const namesIn = (folder: string): Promise<Set<string>> => {
		const before = listings.get(folder);
		if (before !== undefined) return before;
		const names = (async () => {
			const listing = await vault.list(folder === "" ? "/" : folder);
			// Only the last part is read: a lister builds the rest from the folder it was asked for.
			return new Set([...listing.files, ...listing.folders].map((path) => pathKey(lastOf(path))));
		})();
		listings.set(folder, names);
		return names;
	};

	const kept: IndexedFile[] = [];
	for (const file of files) {
		const path = pathKey(fromRoot(file.path));
		let there = true;
		// From the top down, so that a folder is listed as the disk spells it.
		for (const step of isPathFromRoot(path) ? steps(path) : []) {
			if ((spellings.get(foldedKey(step))?.size ?? 0) < 2) continue;
			if (!(await namesIn(parentOf(step))).has(lastOf(step))) {
				there = false;
				break;
			}
		}
		if (there) kept.push(file);
	}
	return { files: kept, notOnDisk: files.length - kept.length };
}

/** What iCloud Drive leaves in the place of the file at `path` (`placeholderTarget` reads it back). */
function placeholderOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.icloud`;
}

/**
 * The line a light check leaves in the log: how many files it listed, how
 * many known paths the index did not list, how many files the disk was asked
 * about because the index did not settle them (`LocalRead.statted`), how
 * many were read and hashed, and how long the vault's side of the sync took. It is how the check is
 * seen to be light on a device, and the index to agree with the disk.
 * Where the index held a spelling the disk does not have, how many such
 * files were left out (`onDisk`), and only there: it is seldom.
 */
export function lightCheckLine(
	scan: Pick<LightScanResult, "paths" | "asked" | "notOnDisk">,
	local: { readonly statted: number; readonly hashed: number },
	milliseconds: number,
): string {
	const notOnDisk = scan.notOnDisk === 0 ? "" : `, ${scan.notOnDisk} not on disk`;
	return `light check: ${scan.paths.length} files, ${scan.asked} not in the index${notOnDisk}, ${local.statted} asked of the disk, ${local.hashed} hashed, ${milliseconds} ms`;
}
