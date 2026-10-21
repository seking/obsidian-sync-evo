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

// The time and the size of each file, as the listing of its folder holds
// them, for a check that walks the vault. On a phone the disk is asked about
// one file at a time, in a queue of the app's, and asking it about every file
// of a large vault takes most of a sync. Where the listing of a folder holds
// the time and the size of what is in it, a file whose time and size there
// are its record's is taken as unchanged without asking the disk again.
//
// It is used as the light check uses the app's index (`LocalReadDeps.indexed`)
// and nothing more: a reason not to look. A file the listing says otherwise
// of is looked at as before, and what is written to a record is always what
// the disk said of the file itself. The names are those of the lister, and
// the listing is only matched to them.

import { pathKey } from "./paths";
import type { FolderLister } from "./scan";
import type { FileStat } from "./state";

/**
 * The time and the size of the files right in a folder (given as the lister
 * is: a path from the vault root, the root as `/`), by their paths from the
 * vault root spelled as the lister spells them. `null` where they cannot be
 * told: then every file of the folder is asked of the disk.
 */
export type ListedStats = (folder: string) => Promise<ReadonlyMap<string, FileStat> | null>;

/** The lister, keeping what `stats` says of each folder it lists. */
export function withListedStats(
	lister: FolderLister,
	stats: ListedStats,
): FolderLister & { readonly indexed: () => ReadonlyMap<string, FileStat> } {
	const indexed = new Map<string, FileStat>();
	return {
		list: async (folder) => {
			const listed = await lister.list(folder);
			const held = await stats(folder);
			if (held !== null) {
				for (const path of listed.files) {
					const stat = held.get(path);
					if (stat !== undefined) indexed.set(pathKey(path), stat);
				}
			}
			return listed;
		},
		...(lister.linksIn === undefined ? {} : { linksIn: async (folder: string) => (await lister.linksIn?.(folder)) ?? [] }),
		indexed: () => indexed,
	};
}
