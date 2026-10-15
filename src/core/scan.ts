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

// The one scan of the vault: every file that takes part in the sync, found
// by listing folder after folder. It only lists. It reads no file, hashes
// nothing, and asks for no time or size; that is the work of whoever turns
// the result into the local side of the sync decision.

import type { RemoteEntry } from "./backend";
import { type Exclusion, knownPaths } from "./exclusion";
import { foldedKey, pathKey } from "./paths";
import type { SyncRecord } from "./plan";

/**
 * What lists one folder. The data adapter of the app is one; unlike the
 * app's own index of the vault, it also returns names that start with a `.`.
 * The folder is given as a path from the vault root, and the root itself as
 * `/`. The paths it returns are from the vault root too.
 */
export interface FolderLister {
	list(folder: string): Promise<{ readonly files: readonly string[]; readonly folders: readonly string[] }>;
	/**
	 * The links of the vault (symbolic links, and junctions on Windows) that
	 * are right in the folder, as paths from the vault root. Absent where
	 * links cannot be told (a phone), and there `list` is all there is.
	 */
	linksIn?(folder: string): Promise<readonly string[]>;
}

/**
 * Whether the path of the vault is a link (`FolderLister.linksIn`). Absent
 * where links cannot be told.
 */
export interface LinkProbe {
	isLink?(path: string): Promise<boolean>;
}

/**
 * One file the scan found.
 *
 * - "present": the folder lists it.
 * - "placeholder": the folder lists `.<name>.icloud` in its place. A cloud
 *   drive has taken the content off the device and left that behind. The
 *   file exists, and cannot be read here: it is neither deleted nor
 *   changed, and nothing may be written over it. Whoever makes the local
 *   side of the sync decision lists it without a hash and keeps it out of
 *   the plan (`PlanInput.held`); left out, it would read as deleted, and a
 *   push would delete it on the remote.
 */
export interface ScannedPath {
	/** Path from the vault root, spelled as the lister returned it. */
	readonly path: string;
	/** `pathKey(path)`. */
	readonly key: string;
	readonly state: "present" | "placeholder";
}

export interface ScanInput {
	readonly lister: FolderLister;
	/** The same object that is given to the sync decision. */
	readonly exclusion: Exclusion;
	/**
	 * The remote listing and the records, the same two the sync decision is
	 * given. The records say which paths are symlinks; and a copy of the
	 * earlier form inside the configuration folder is looked for when either
	 * knows it (`Exclusion.excludes`).
	 */
	readonly remote: readonly RemoteEntry[];
	readonly records: readonly SyncRecord[];
}

export interface ScanResult {
	/** In the order the folders were listed. */
	readonly paths: readonly ScannedPath[];
	/** Whether the vault root has a `.git`, as a folder or as a file. */
	readonly rootHasGit: boolean;
	/**
	 * The links of the vault that the scan did not go into, as the disk
	 * spells them, and not those a rule excludes. What is at and below
	 * each is left out of `paths`, and out of the sync (`PlanInput.links`).
	 */
	readonly links: readonly string[];
}

const ROOT = "/";

// What iCloud Drive leaves in the place of `name` when it takes the content
// off the device.
const PLACEHOLDER_NAME = /^\.(.+)\.icloud$/;

/**
 * The path of the file a placeholder stands for, or `null` for any other
 * name: one that only ends in `.icloud`, or only starts with a dot, is a
 * file like any other.
 */
export function placeholderTarget(path: string): string | null {
	const slash = path.lastIndexOf("/");
	const name = PLACEHOLDER_NAME.exec(path.slice(slash + 1))?.[1];
	if (name === undefined || name === "." || name === "..") return null;
	return path.slice(0, slash + 1) + name;
}

/**
 * Lists the vault. Left out, without being entered or listed:
 *
 * - `.git` and the plugin's own folder, at any cost;
 * - what lies below a path that a record holds as a symlink. On a desktop a
 *   symlink to a folder looks like a folder, and its content belongs to the
 *   path it points to;
 * - a link of the vault, to a folder or to a file, and what lies below it
 *   (`FolderLister.linksIn`). Its target can be outside the vault, or
 *   another path of it, or the folder it is in. It is returned in `links`,
 *   unless a rule excludes it;
 * - a folder and a file the exclusion leaves out (`Exclusion.excludes`),
 *   whatever the remote holds and whatever has a record. (The folder of the
 *   copies is entered whatever the rules say.) The sync decision turns each
 *   of them away as excluded before it compares anything, so the vault side
 *   of such a path is not needed; this only saves listing them, and a
 *   `.obsidian/plugins/` with thousands of files is the usual case.
 *
 * A placeholder of a cloud drive (`.<name>.icloud`) is listed as the file
 * it stands for, in the state "placeholder", unless the folder lists that
 * file too. The placeholder's own name is excluded by a rule as before.
 *
 * Whether a path is known is asked without regard to case (`knownPaths`).
 * Returning one file too many costs nothing, since the decision is taken
 * again from the result.
 *
 * A folder that cannot be listed fails the whole scan, for the same reason:
 * a partial result would read as deletions.
 */
export async function scanVault(input: ScanInput): Promise<ScanResult> {
	const { lister, exclusion } = input;

	const known = knownPaths(input.remote, input.records);
	// Without regard to case, like what is known: not going below a folder
	// by mistake leaves its files as they are on every side.
	const symlinks = new Set<string>();
	for (const record of input.records) {
		if (record.kind === "symlink") symlinks.add(foldedKey(record.path));
	}

	const paths: ScannedPath[] = [];
	const links: string[] = [];
	let rootHasGit = false;

	const pending: string[] = [ROOT];
	for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
		const listed = await lister.list(folder);
		const files = listed.files.map(fromRoot);
		const there = new Set(files.map(foldedKey));
		const linked = new Set((lister.linksIn === undefined ? [] : await lister.linksIn(folder)).map((path) => foldedKey(fromRoot(path))));
		// Told unless a rule excludes it, as a file or as a folder: which of
		// the two the listing took it for depends on what it points to.
		const isLink = (path: string, kind: "file" | "folder"): boolean => {
			if (!linked.has(foldedKey(path))) return false;
			if (!exclusion.excludes(path, kind, known)) links.push(path);
			return true;
		};

		for (const path of files) {
			if (folder === ROOT && foldedKey(path) === ".git") rootHasGit = true;
			if (isLink(path, "file")) continue;
			const evicted = placeholderTarget(path);
			if (evicted !== null && !there.has(foldedKey(evicted)) && !exclusion.excludes(evicted, "file", known)) {
				paths.push({ path: evicted, key: pathKey(evicted), state: "placeholder" });
			}
			if (exclusion.excludes(path, "file", known)) continue;
			paths.push({ path, key: pathKey(path), state: "present" });
		}

		for (const returned of listed.folders) {
			const path = fromRoot(returned);
			const folded = foldedKey(path);
			if (folder === ROOT && folded === ".git") rootHasGit = true;
			if (isLink(path, "folder")) continue;
			if (exclusion.excludes(path, "folder", known)) continue;
			if (symlinks.has(folded)) continue;
			pending.push(path);
		}
	}

	return { paths, rootHasGit, links };
}

// A lister may put the root in front of what it returns (`/a.md`, `./a.md`).
// The exclusion takes paths from the root and refuses anything else.
export function fromRoot(path: string): string {
	return path.replace(/^(?:\.?\/)+/, "");
}
