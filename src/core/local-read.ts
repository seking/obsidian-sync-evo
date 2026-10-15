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

// The vault side of the sync decision: the hash of every file a scan found.
// A pull and a push both plan from this, so that the two can never see the
// vault differently.

import type { Backend, RemoteListing } from "./backend";
import { HASH_CHUNK_BYTES } from "./hash";
import { foldedKey, pathKey } from "./paths";
import type { LocalEntry } from "./plan";
import { isLfsPointer, type Seen } from "./pull-apply";
import { type PullVault, readWhole, type SaveResult } from "./pull-io";
import type { ScanResult } from "./scan";
import {
	type FileStat,
	isUnchangedByStat,
	RecordBatcher,
	refreshStat,
	type StateStore,
	type StoredRecord,
} from "./state";

export interface LocalReadDeps {
	readonly vault: Pick<PullVault, "stat" | "read" | "saveOpenEditors" | "isLink">;
	readonly backend: Pick<Backend, "hashContent">;
	readonly store: Pick<StateStore, "updateStats">;
	readonly now: () => number;
	/** When the sync that reads began (`makeRecord`). */
	readonly startedAt: number;
	readonly sizeLimit: number;
	/** The paths that are not looked at (`PlanInput.held`), without the cases. */
	readonly held: ReadonlySet<string>;
	/** Looked at before every file: whether the sync was stopped. */
	readonly aborted: () => boolean;
	readonly onProgress: (done: number, total: number) => void;
	readonly yieldControl?: () => Promise<void>;
	/**
	 * Whether every editor that has a file open is made to save before the
	 * file is looked at. For a push: what was typed and not saved shows in
	 * neither the time nor the size of the file, and would be left behind. A
	 * pull saves where it writes instead (`pull-apply.ts`).
	 */
	readonly saveEditors?: boolean;
	/**
	 * Only with `saveEditors`, for a push that started by itself: whether
	 * the file at a path is being typed in right now (`editing.ts`). Such a
	 * file is not asked to save and not looked at; it is listed without a
	 * hash (`beingEdited`), for the caller to keep out of the plan.
	 */
	readonly beingEdited?: (path: string) => boolean;
	/**
	 * Only for the light check (`light-scan.ts`): what the app's index says
	 * of each file it lists, by key. A file whose time and size there are
	 * its record's is taken as unchanged without asking the disk, which is
	 * what makes that check light.
	 *
	 * The index is only ever a reason not to look. Whatever it says that is
	 * not the record's sends the file down the ordinary way, to the disk,
	 * and nothing of the index is written to a record or handed on: were
	 * the index to differ from the disk for good on some device, every
	 * file would be asked of the disk on every check, which is slow and not
	 * wrong, and no record would go back and forth between the two.
	 */
	readonly indexed?: ReadonlyMap<string, FileStat>;
}

export interface LocalRead {
	readonly entries: LocalEntry[];
	/** What each file that was looked at had, by key. */
	readonly seen: Map<string, Seen>;
	/** The paths of the remote whose file in the vault is a Git LFS pointer of the same content. */
	readonly lfsPointers: string[];
	/**
	 * Only with `saveEditors`: the files an editor could not save. What is
	 * on disk may be behind what the user sees. Each is listed in `entries`
	 * without a hash, for the caller to keep out of the plan (`PlanInput.held`).
	 */
	readonly unsaved: string[];
	/**
	 * Only with `LocalReadDeps.beingEdited`: the files that are being typed
	 * in right now. Listed in `entries` without a hash, like the unsaved
	 * ones. What their editors hold was not written to disk for this.
	 */
	readonly beingEdited: string[];
	/**
	 * The files that are there and could not be read. Each is listed in
	 * `entries` without a hash, for the caller to keep out of the plan
	 * (`PlanInput.held`): nothing is known of its content, so it is not
	 * sent, not deleted on the remote, and not written over or deleted
	 * here. One file that cannot be read is no reason to fail the sync of
	 * all the others.
	 */
	readonly unreadable: string[];
	/**
	 * The files a cloud drive has taken off the device (`ScannedPath`
	 * "placeholder"), also those among the paths that are held. Listed in
	 * `entries` and kept out of the plan like the unreadable ones, and told
	 * apart from them: nothing is wrong with such a file, and it can stay
	 * that way for good.
	 */
	readonly placeholders: string[];
	/**
	 * The files the scan listed that are links of the vault, found when
	 * the file was not there or could not be read: one whose target is
	 * gone, put in the place of a file the app's index still holds (the
	 * light check does not ask the disk of such a file). Not in `entries`,
	 * and told with the links of the scan (`withLinksRead`).
	 */
	readonly links: string[];
	/** How many files the disk was asked about: all that were looked at, but for the ones the index settled. */
	readonly statted: number;
	/** How many files were read and hashed. */
	readonly hashed: number;
}

/**
 * The hash of every file the scan found. A file whose time and size are
 * those of its record is not read; with `indexed`, one whose time and size
 * in the app's index are those of its record is not even asked of the disk
 * (`LocalReadDeps.indexed`). A file over the size limit is not read
 * either; it is listed with its size, which is what the plan turns it away
 * by. A file that cannot be read is listed without a hash (`unreadable`).
 * `null` when the sync was stopped.
 */
export async function readLocal(
	deps: LocalReadDeps,
	scan: ScanResult,
	records: readonly StoredRecord[],
	listing: RemoteListing,
): Promise<LocalRead | null> {
	const byKey = new Map(records.map((record) => [record.key, record]));
	const remoteByKey = new Map(listing.entries.map((entry) => [pathKey(entry.path), entry]));
	const batcher = new RecordBatcher(deps.store, { now: deps.now });
	const entries: LocalEntry[] = [];
	const seen = new Map<string, Seen>();
	const lfsPointers: string[] = [];
	const unsaved: string[] = [];
	const beingEdited: string[] = [];
	const unreadable: string[] = [];
	const placeholders: string[] = [];
	const links: string[] = [];
	const total = scan.paths.length;
	let hashedBytes = 0;
	let statted = 0;
	let hashed = 0;

	for (const [index, scanned] of scan.paths.entries()) {
		if (deps.aborted()) {
			await batcher.flush();
			return null;
		}
		const { path, key } = scanned;
		// Before the paths that are held: a placeholder is told apart also
		// when the caller was handed its path to leave alone (the push
		// after a pull that put it off), so that it is not told as a file
		// something is wrong with. Known from the scan, and not looked at.
		if (scanned.state === "placeholder") {
			entries.push({ path, hash: "" });
			placeholders.push(path);
			continue;
		}
		// Listed, so that the plan knows a file is there, and not looked
		// at: the plan turns the path away before it reads the hash, and
		// the file may be one that cannot be read.
		if (deps.held.has(foldedKey(path))) {
			entries.push({ path, hash: "" });
			continue;
		}
		// Whether an editor wrote the file just now. The index may not have
		// heard of that write yet, so it is not asked about this file.
		let justSaved = false;
		if (deps.saveEditors === true && deps.beingEdited?.(path) === true) {
			entries.push({ path, hash: "" });
			beingEdited.push(path);
			continue;
		}
		if (deps.saveEditors === true) {
			const result = await saveResult(deps.vault, path);
			if (result === "failed") {
				entries.push({ path, hash: "" });
				unsaved.push(path);
				continue;
			}
			justSaved = result === "saved";
		}
		const record = byKey.get(key);
		const inIndex = justSaved ? undefined : deps.indexed?.get(key);
		if (
			record !== undefined &&
			record.mtime !== undefined &&
			record.size !== undefined &&
			inIndex !== undefined &&
			record.size <= deps.sizeLimit &&
			isUnchangedByStat(record, inIndex)
		) {
			// Unchanged, by the index. What is handed on is the record's
			// time and size, which came from the disk: whoever writes over
			// the file looks at the disk first, and compares with these.
			entries.push({ path, hash: record.hash, size: record.size });
			seen.set(key, { hash: record.hash, stat: { mtime: record.mtime, size: record.size } });
			deps.onProgress(index + 1, total);
			continue;
		}
		// Asked only of a file that is not there or cannot be read, so that
		// the disk is asked nothing more of the others.
		const isLink = async (): Promise<boolean> => {
			if (deps.vault.isLink === undefined || !(await deps.vault.isLink(path))) return false;
			links.push(path);
			return true;
		};
		const leave = async (): Promise<void> => {
			if (await isLink()) return;
			entries.push({ path, hash: "" });
			unreadable.push(path);
		};
		let stat: Awaited<ReturnType<LocalReadDeps["vault"]["stat"]>>;
		statted += 1;
		try {
			stat = await deps.vault.stat(path);
		} catch {
			await leave();
			continue;
		}
		// Gone since it was listed, or a link whose target is gone, which
		// the disk has nothing to stat at.
		if (stat === null || stat.type !== "file") {
			await isLink();
			continue;
		}
		if (stat.size > deps.sizeLimit) {
			entries.push({ path, hash: "", size: stat.size });
			continue;
		}

		let hash: string;
		if (record !== undefined && isUnchangedByStat(record, stat)) {
			hash = record.hash;
		} else {
			let content: Uint8Array;
			try {
				({ content, stat } = await readWhole(deps.vault, path, stat));
			} catch {
				await leave();
				continue;
			}
			hash = await deps.backend.hashContent(content);
			hashed += 1;
			// Found here too, and not only when it is written: a pointer
			// that was already in the vault is one all the same.
			const remote = remoteByKey.get(key);
			if (remote?.kind === "file" && remote.hash === hash && isLfsPointer(content)) {
				lfsPointers.push(remote.path);
			}
			if (record !== undefined && record.kind === "file" && record.hash === hash) {
				const refreshed = refreshStat(record, stat, deps.startedAt);
				if (refreshed !== null) await batcher.add(refreshed);
			}
			hashedBytes += content.length;
			if (hashedBytes >= HASH_CHUNK_BYTES && deps.yieldControl !== undefined) {
				hashedBytes = 0;
				await deps.yieldControl();
			}
		}
		entries.push({ path, hash, size: stat.size });
		seen.set(key, { hash, stat: { mtime: stat.mtime, size: stat.size } });
		deps.onProgress(index + 1, total);
	}
	await batcher.flush();
	return { entries, seen, lfsPointers, unsaved, beingEdited, unreadable, placeholders, links, statted, hashed };
}

/**
 * The scan with the links that reading found (`LocalRead.links`) moved from
 * its files to its links, so that the sync decision and what is told go by
 * one list of links.
 */
export function withLinksRead<Scan extends ScanResult>(scan: Scan, local: Pick<LocalRead, "links">): Scan {
	if (local.links.length === 0) return scan;
	const linked = new Set(local.links.map(foldedKey));
	return {
		...scan,
		paths: scan.paths.filter((scanned) => !linked.has(foldedKey(scanned.path))),
		links: [...scan.links, ...local.links],
	};
}

/** Whether what the editors hold of the file is on disk: saved, or not open at all. */
export async function saved(vault: Pick<PullVault, "saveOpenEditors">, path: string): Promise<boolean> {
	return (await saveResult(vault, path)) !== "failed";
}

async function saveResult(vault: Pick<PullVault, "saveOpenEditors">, path: string): Promise<SaveResult> {
	try {
		return await vault.saveOpenEditors(path);
	} catch {
		return "failed";
	}
}
