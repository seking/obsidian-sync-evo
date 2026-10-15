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

/** What the check of the listing against the disk found on a device where the listing is not used yet. */
interface ProbeTally {
	folders: number;
	/** Folders whose listing could not be read, or came in another form. */
	unread: number;
	/** Files the app's listing has that the read one does not, by name as spelled. */
	unmatched: number;
	compared: number;
	differ: number;
	listMs: number;
	readdirMs: number;
	/** The first files that differ, for the log. */
	readonly samples: string[];
}

/** How many files of each folder are compared with the disk. */
const PROBE_FILES_PER_FOLDER = 20;

/**
 * For a sync on iOS: the listing is read and compared with the disk, and
 * not used (`stats` always tells nothing). `finish` writes what was found to
 * the log, so that whether the listing may be used there can be read from a
 * phone. `undefined` on other platforms and where the listing cannot be read.
 */
export function folderStatsProbeOf(
	app: App,
	log: (line: string) => void,
): { readonly stats: ListedStats; finish(): void } | undefined {
	if (!Platform.isIosApp) return undefined;
	const { adapter } = app.vault;
	const listing = adapter as unknown as ListingAdapter;
	const readdir = listing.fs?.readdir;
	const fullPath = listing.getFullPath;
	if (typeof readdir !== "function" || typeof fullPath !== "function") {
		log("listing probe: the listing cannot be read on this device");
		return undefined;
	}
	const tally: ProbeTally = {
		folders: 0,
		unread: 0,
		unmatched: 0,
		compared: 0,
		differ: 0,
		listMs: 0,
		readdirMs: 0,
		samples: [],
	};
	const stats: ListedStats = async (folder) => {
		tally.folders += 1;
		const relative = folder === "/" ? "" : folder;
		try {
			let began = performance.now();
			const listed = await adapter.list(relative === "" ? "/" : relative);
			tally.listMs += performance.now() - began;
			began = performance.now();
			const entries: unknown = await (readdir as (path: string) => Promise<unknown>).call(
				listing.fs,
				(fullPath as (path: string) => string).call(adapter, relative),
			);
			tally.readdirMs += performance.now() - began;
			if (!Array.isArray(entries) || entries.some((entry) => !isListedFolder(entry) && !isListedFile(entry))) {
				tally.unread += 1;
				if (tally.samples.length < 5) tally.samples.push(`form in ${folder}: ${JSON.stringify(entries).slice(0, 200)}`);
				return null;
			}
			const held = new Map<string, FileStat>();
			for (const entry of entries) {
				if (!isListedFile(entry)) continue;
				held.set(spelledAsListed(relative === "" ? entry.name : `${relative}/${entry.name}`), entry);
			}
			let compared = 0;
			for (const path of listed.files) {
				const fromListing = held.get(path);
				if (fromListing === undefined) {
					tally.unmatched += 1;
					if (tally.samples.length < 5) tally.samples.push(`not in the listing: ${path}`);
					continue;
				}
				if (compared >= PROBE_FILES_PER_FOLDER) continue;
				compared += 1;
				tally.compared += 1;
				const stat = await adapter.stat(path);
				if (stat === null || stat.mtime !== fromListing.mtime || stat.size !== fromListing.size) {
					tally.differ += 1;
					if (tally.samples.length < 5) {
						tally.samples.push(
							`${path}: listing ${fromListing.mtime}/${fromListing.size}, disk ${stat?.mtime}/${stat?.size}`,
						);
					}
				}
			}
		} catch (error) {
			tally.unread += 1;
			if (tally.samples.length < 5) tally.samples.push(`failed in ${folder}: ${String(error)}`);
		}
		return null;
	};
	return {
		stats,
		finish() {
			if (tally.folders === 0) return;
			log(
				`listing probe: ${tally.folders} folders, ${tally.unread} not read, ${tally.unmatched} files not in the listing, ${tally.compared} compared, ${tally.differ} differ, list ${Math.round(tally.listMs)} ms, readdir ${Math.round(tally.readdirMs)} ms`,
			);
			for (const sample of tally.samples) log(`listing probe: ${sample}`);
		},
	};
}
