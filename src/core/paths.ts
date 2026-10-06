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

/**
 * The key under which one file is matched across the remote listing, the
 * vault scan, and the records. Always NFC, whatever form either side returns,
 * so that the same name in NFC and NFD is one file and not a delete plus an add.
 */
export function pathKey(path: string): string {
	return path.normalize("NFC");
}

/**
 * `pathKey` without the difference between upper and lower case. Only for
 * asking whether two paths could be the same file on a file system that does
 * not tell the cases apart (most vaults are on one), where answering "yes"
 * too often is the safe side. Nothing is stored or matched across the three
 * sides under it.
 */
export function foldedKey(path: string): string {
	return pathKey(path).toLowerCase();
}

/**
 * Whether `path` names something below the root: not empty, no `/` at
 * either end, and no part that is empty, `.`, or `..`. A listing can hold a
 * path that is not one (a remote that is not git, a damaged record), and
 * nothing can be decided about such a path.
 */
export function isPathFromRoot(path: string): boolean {
	return path !== "" && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
