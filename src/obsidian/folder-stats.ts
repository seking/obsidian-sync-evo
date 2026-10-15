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

// The time and the size of the files of a folder, from the listing the app's
// adapter makes on Android (`ListedStats`). There the adapter asks the disk
// about one file at a time, in a queue, and a stat of every file of a vault of
// 15,000 took 13 to 44 seconds; its listing of a folder holds the time and the
// size of each file, and keeps only the names.
//
// The listing is not a part of the app's API: what is used of it is looked
// for, and where anything is missing or other than expected, nothing is told,
// and every file is asked of the disk as before. One file of each folder is
// also asked of the disk, and where the two do not agree, the listing is not
// used again in this sync. Nothing it says is written anywhere
// (`listed-stats.ts`).

import { type App, Platform } from "obsidian";
import type { ListedStats } from "../core/listed-stats";
import type { FileStat } from "../core/state";

/** What is used of the adapter on Android, none of it in the API. */
interface ListingAdapter {
	readonly fs?: { readdir?: unknown };
	readonly getFullPath?: unknown;
}

/** One entry of the listing, as far as it is used. */
interface ListedFile {
	readonly type: "file";
	readonly name: string;
	readonly mtime: number;
	readonly size: number;
}

// How the app's listing spells a path it returns: its non-breaking spaces as
// spaces, in NFC (as in `vault-links.ts`).
function spelledAsListed(path: string): string {
	return path.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

function isListedFile(entry: unknown): entry is ListedFile {
	if (typeof entry !== "object" || entry === null) return false;
	const { type, name, mtime, size } = entry as Record<string, unknown>;
	return type === "file" && typeof name === "string" && Number.isInteger(mtime) && Number.isInteger(size);
}

function isListedFolder(entry: unknown): boolean {
	return typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === "directory";
}

/** For a sync on Android, or `undefined` where the listing cannot be read. */
export function folderStatsOf(app: App): ListedStats | undefined {
	if (!Platform.isAndroidApp) return undefined;
	const { adapter } = app.vault;
	const listing = adapter as unknown as ListingAdapter;
	const readdir = listing.fs?.readdir;
	const fullPath = listing.getFullPath;
	if (typeof readdir !== "function" || typeof fullPath !== "function") return undefined;
	let trusted = true;
	return async (folder) => {
		if (!trusted) return null;
		const relative = folder === "/" ? "" : folder;
		let entries: unknown;
		try {
			entries = await (readdir as (path: string) => Promise<unknown>).call(
				listing.fs,
				(fullPath as (path: string) => string).call(adapter, relative),
			);
		} catch {
			return null;
		}
		if (!Array.isArray(entries)) return null;
		const held = new Map<string, FileStat>();
		const twice = new Set<string>();
		for (const entry of entries) {
			if (isListedFolder(entry)) continue;
			// A listing in another form than expected: none of it is used.
			if (!isListedFile(entry)) return null;
			const path = spelledAsListed(relative === "" ? entry.name : `${relative}/${entry.name}`);
			if (held.has(path)) twice.add(path);
			held.set(path, { mtime: entry.mtime, size: entry.size });
		}
		// Two names that the app spells alike: which one is which is not known.
		for (const path of twice) held.delete(path);
		const [first] = held;
		if (first !== undefined) {
			const [path, listed] = first;
			let stat: Awaited<ReturnType<typeof adapter.stat>>;
			try {
				stat = await adapter.stat(path);
			} catch {
				stat = null;
			}
			if (stat === null || stat.mtime !== listed.mtime || stat.size !== listed.size) {
				trusted = false;
				return null;
			}
		}
		return held;
	};
}
