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

// The sync decision. A pure function of three listings: what the remote has,
// what the vault has, and what both had when they were last in sync. It does
// no I/O and knows nothing about any particular backend.

import type { EntryKind, RemoteEntry } from "./backend";
import { pathKey } from "./paths";

export interface LocalEntry {
	/** Path from the vault root, spelled as the scan returned it. */
	readonly path: string;
	/** Hash of the content, in the scheme of the backend in use. */
	readonly hash: string;
	readonly size?: number;
}

/** What one path looked like the last time it was in sync. */
export interface SyncRecord {
	/** Path as the remote spelled it. */
	readonly path: string;
	readonly kind: EntryKind;
	readonly hash: string;
}

interface Sides {
	/** The NFC key shared by the three sides. */
	readonly key: string;
	readonly record?: SyncRecord;
	readonly local?: LocalEntry;
	readonly remote?: RemoteEntry;
}

/**
 * One action per path. "download", "delete-local", "conflict", and the two
 * record actions belong to a pull; "upload" and "delete-remote" to a push.
 */
export type SyncAction =
	/** Write the remote content to the vault. */
	| (Sides & { readonly type: "download"; readonly remote: RemoteEntry })
	/** Send the vault content to the remote. */
	| (Sides & { readonly type: "upload"; readonly local: LocalEntry })
	/** The remote deleted it and the vault did not touch it. */
	| (Sides & { readonly type: "delete-local"; readonly local: LocalEntry; readonly record: SyncRecord })
	/** The vault deleted it and the remote did not touch it. */
	| (Sides & {
			readonly type: "delete-remote";
			readonly remote: RemoteEntry;
			readonly record: SyncRecord;
	  })
	/** Both sides already agree; only the record has to be set to the remote entry. */
	| (Sides & {
			readonly type: "update-record";
			readonly local: LocalEntry;
			readonly remote: RemoteEntry;
	  })
	/** Gone on both sides; only the record is left to remove. */
	| (Sides & { readonly type: "drop-record"; readonly record: SyncRecord })
	/** Both sides hold different content and neither may be overwritten. */
	| (Sides & { readonly type: "conflict"; readonly local: LocalEntry; readonly remote: RemoteEntry });

export type SkipReason =
	/** More than one path on one side maps to the same key. */
	| "duplicate-path"
	/** A symlink or a submodule; only regular files are handled so far. */
	| "not-a-file"
	/** Below a path that the remote or a record holds as a symlink or a submodule. */
	| "under-non-file";

/**
 * A path that was left alone on every side, and why. Each side lists every
 * entry it has under the key, spelled as that side has it, so that the user
 * can be told which names are involved.
 */
export interface SkippedPath {
	readonly key: string;
	readonly reason: SkipReason;
	readonly remote: readonly RemoteEntry[];
	readonly local: readonly LocalEntry[];
	readonly records: readonly SyncRecord[];
}

export interface PlanInput {
	readonly remote: readonly RemoteEntry[];
	readonly local: readonly LocalEntry[];
	readonly records: readonly SyncRecord[];
}

export interface SyncPlan {
	/** Sorted by key. Paths that need nothing are not listed. */
	readonly actions: readonly SyncAction[];
	readonly skipped: readonly SkippedPath[];
}

export function planSync(input: PlanInput): SyncPlan {
	const remote = indexByKey(input.remote);
	const local = indexByKey(input.local);
	const records = indexByKey(input.records);

	// Keys that the remote or a record holds as something other than a file.
	const nonFiles = new Set<string>();
	for (const index of [remote, records]) {
		for (const [key, entries] of index) {
			if (entries.some((entry) => entry.kind !== "file")) nonFiles.add(key);
		}
	}

	const keys = new Set([...remote.keys(), ...local.keys(), ...records.keys()]);
	const actions: SyncAction[] = [];
	const skipped: SkippedPath[] = [];

	for (const key of [...keys].sort()) {
		const onRemote = remote.get(key) ?? [];
		const onLocal = local.get(key) ?? [];
		const onRecords = records.get(key) ?? [];

		// Paths that must not be touched on either side, whatever the three
		// sides hold, are turned away here, before the three-way comparison.
		// Reasons of the same nature (unwritable paths, size limits) join this
		// step. Exclusion rules do not fit here: a path that has a record keeps
		// syncing even when a rule matches it, and the one thing a rule changes
		// for it (deleted on the remote, edited in the vault: not sent back)
		// is only known once the sides are compared. They belong after the
		// decision, or in it.
		const reason = skipReason(key, [onRemote, onLocal, onRecords], nonFiles);
		if (reason !== undefined) {
			skipped.push({ key, reason, remote: onRemote, local: onLocal, records: onRecords });
			continue;
		}

		const action = decide({ key, record: onRecords[0], local: onLocal[0], remote: onRemote[0] });
		if (action !== undefined) actions.push(action);
	}

	return { actions, skipped };
}

/** Every entry of one side, grouped by key. More than one under a key is a duplicate. */
function indexByKey<T extends { readonly path: string }>(entries: readonly T[]): Map<string, T[]> {
	const byKey = new Map<string, T[]>();
	for (const entry of entries) {
		const key = pathKey(entry.path);
		const group = byKey.get(key);
		if (group === undefined) byKey.set(key, [entry]);
		else group.push(entry);
	}
	return byKey;
}

function skipReason(
	key: string,
	sides: readonly (readonly unknown[])[],
	nonFiles: ReadonlySet<string>,
): SkipReason | undefined {
	if (sides.some((entries) => entries.length > 1)) return "duplicate-path";
	if (nonFiles.has(key)) return "not-a-file";
	if (isUnderAnyOf(key, nonFiles)) return "under-non-file";
	return undefined;
}

// A symlink or a submodule has no files of its own in the listing, so a path
// below one on any side is a leftover or a mistake. Sending it would replace
// the symlink or submodule with a folder.
function isUnderAnyOf(key: string, parents: ReadonlySet<string>): boolean {
	if (parents.size === 0) return false;
	for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
		if (parents.has(key.slice(0, slash))) return true;
	}
	return false;
}

// A deletion is a change like any other. A side "changed" when it differs from
// the record; with no record, nothing is known to be unchanged, so nothing is
// ever deleted or overwritten on the strength of a missing file alone.
function decide(sides: Sides): SyncAction | undefined {
	const { record, local, remote } = sides;

	if (local !== undefined && remote !== undefined) {
		if (local.hash === remote.hash) {
			const recordIsCurrent =
				record !== undefined && record.hash === remote.hash && record.path === remote.path;
			return recordIsCurrent ? undefined : { ...sides, type: "update-record", local, remote };
		}
		if (record?.hash === local.hash) return { ...sides, type: "download", remote };
		if (record?.hash === remote.hash) return { ...sides, type: "upload", local };
		return { ...sides, type: "conflict", local, remote };
	}

	if (remote !== undefined) {
		// Missing from the vault. Only a record that matches the remote proves
		// the vault deleted it; otherwise the remote content is what survives.
		if (record?.hash === remote.hash) return { ...sides, type: "delete-remote", remote, record };
		return { ...sides, type: "download", remote };
	}

	if (local !== undefined) {
		// Missing from the remote; the mirror image of the case above.
		if (record?.hash === local.hash) return { ...sides, type: "delete-local", local, record };
		return { ...sides, type: "upload", local };
	}

	return record === undefined ? undefined : { ...sides, type: "drop-record", record };
}
