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

// The time and the size of the files of a folder, from the listing the app's
// adapter makes on a phone (`ListedStats`). There the adapter asks the disk
// about one file at a time, in a queue: a stat of every file of a vault of
// 15,000 took 13 to 44 seconds on Android, and 7.5 seconds on an iPhone. Its
// listing of a folder holds the time and the size of each file, and keeps
// only the names. On both, the two agreed for every file compared.
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

/** What is used of the adapter on a phone, none of it in the API. */
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

interface ListedFolder {
	readonly type: "directory";
	readonly name: string;
}

function isListedFolder(entry: unknown): entry is ListedFolder {
	if (typeof entry !== "object" || entry === null) return false;
	const { type, name } = entry as Record<string, unknown>;
	return type === "directory" && typeof name === "string";
}

/**
 * A name the app's listing spells as it is: printable ASCII but `\`, which
 * the app may take for a separator of the path, with no space at either
 * end. Where every name of a folder is one, the folder is listed from the
 * same read that tells the times, and not asked of the app's listing again.
 * A folder with any other name is: how the app spells it is the app's to
 * say.
 */
const PLAIN_NAME = /^[\x21-\x5B\x5D-\x7E](?:[\x20-\x5B\x5D-\x7E]*[\x21-\x5B\x5D-\x7E])?$/;

/**
 * What a phone's adapter is read for: the listing of a folder
 * (`VaultPorts.list`), where it can be told without the app, and the time and
 * the size of its files (`ListedStats`).
 */
export interface PhoneListing {
	/** The files and folders of a folder as the app lists them, or `null` where the app is to be asked. */
	list(folder: string): Promise<{ files: string[]; folders: string[] } | null>;
	readonly stats: ListedStats;
}

/** For a sync on a phone, or `undefined` where the listing cannot be read. */
export function phoneListingOf(app: App): PhoneListing | undefined {
	if (!Platform.isMobileApp) return undefined;
	const { adapter } = app.vault;
	const listing = adapter as unknown as ListingAdapter;
	const readdir = listing.fs?.readdir;
	const fullPath = listing.getFullPath;
	if (typeof readdir !== "function" || typeof fullPath !== "function") return undefined;
	let trusted = true;
	// What `list` read of each folder, for the `stats` of it that comes right
	// after (`withListedStats`): one read of the folder for both.
	const lastRead = new Map<string, readonly (ListedFile | ListedFolder)[]>();

	/** The entries of a folder, or `null` where it cannot be read or holds anything else than files and folders. */
	const read = async (relative: string): Promise<readonly (ListedFile | ListedFolder)[] | null> => {
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
		const known: (ListedFile | ListedFolder)[] = [];
		for (const entry of entries) {
			// A listing in another form than expected: none of it is used.
			if (!isListedFile(entry) && !isListedFolder(entry)) return null;
			known.push(entry);
		}
		return known;
	};
	const relativeOf = (folder: string): string => (folder === "/" ? "" : folder);
	const pathOf = (relative: string, name: string): string => (relative === "" ? name : `${relative}/${name}`);

	return {
		async list(folder) {
			const relative = relativeOf(folder);
			lastRead.delete(relative);
			const entries = await read(relative);
			if (entries === null) return null;
			// Also for a folder the app is asked to list: its stats need not read it again.
			if (trusted) lastRead.set(relative, entries);
			if (entries.some((entry) => !PLAIN_NAME.test(entry.name))) return null;
			const files: string[] = [];
			const folders: string[] = [];
			for (const entry of entries) {
				(entry.type === "file" ? files : folders).push(pathOf(relative, entry.name));
			}
			return { files, folders };
		},
		stats: async (folder) => {
			const relative = relativeOf(folder);
			const before = lastRead.get(relative);
			lastRead.delete(relative);
			if (!trusted) return null;
			const entries = before ?? (await read(relative));
			if (entries === null) return null;
			const held = new Map<string, FileStat>();
			const twice = new Set<string>();
			for (const entry of entries) {
				if (entry.type !== "file") continue;
				const path = spelledAsListed(pathOf(relative, entry.name));
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
		},
	};
}

/** The time and the size of the files of a folder, on a phone (`PhoneListing.stats`). */
export function folderStatsOf(app: App): ListedStats | undefined {
	return phoneListingOf(app)?.stats;
}
