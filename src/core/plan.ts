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
import { type Exclusion, type HardExclusion, type KnownPaths, knownPaths } from "./exclusion";
import { isPathFromRoot, pathKey } from "./paths";

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
	/**
	 * Only the record is left to remove; no file is touched. Either the path
	 * is gone on both sides, or the remote deleted it while the vault edited
	 * it and a rule now excludes it. The action carries `local` in the second
	 * case: the vault file stays, and is not sent back.
	 */
	| (Sides & { readonly type: "drop-record"; readonly record: SyncRecord })
	/** Both sides hold different content and neither may be overwritten. */
	| (Sides & { readonly type: "conflict"; readonly local: LocalEntry; readonly remote: RemoteEntry });

export type SkipReason =
	/**
	 * Not a path below the root: empty, a `/` at either end, or a part that
	 * is empty, `.`, or `..`. Nothing can be decided about it, and nothing is
	 * done to it; the rest of the plan is made as usual.
	 */
	| "invalid-path"
	/** More than one path on one side maps to the same key. */
	| "duplicate-path"
	/** A symlink or a submodule; only regular files are handled so far. */
	| "not-a-file"
	/** Below a path that the remote or a record holds as a symlink or a submodule. */
	| "under-non-file"
	/**
	 * One of the two things that are never synced: a `.git` ("dot-git") or
	 * the plugin's own folder ("own-folder"). An "own-folder" skip that lists
	 * remote entries is how the caller learns that the remote holds that folder.
	 */
	| HardExclusion
	/**
	 * Only in the vault, never synced, and matched by a rule of `.gitignore`.
	 * Not every such file is listed: the scan already leaves most of them out.
	 */
	| "excluded";

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
	/**
	 * What is left out of the sync. The same object the scan that produced
	 * `local` was given. Required, so that the two things that are never
	 * synced cannot be forgotten.
	 */
	readonly exclusion: Exclusion;
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

	const known = knownPaths(input.remote, input.records);
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
		// step. Of the exclusion, only the two fixed ones are of that nature.
		// A path that is not one comes first: the exclusion refuses it.
		const reason = !isPathFromRoot(key)
			? "invalid-path"
			: (input.exclusion.hardExclusionOf(key) ?? skipReason(key, [onRemote, onLocal, onRecords], nonFiles));
		if (reason !== undefined) {
			skipped.push({ key, reason, remote: onRemote, local: onLocal, records: onRecords });
			continue;
		}

		// The rules of `.gitignore` come after the comparison. They change
		// nothing for a path the remote holds, and what they change for the
		// others depends on what the comparison found.
		const decided = decide({ key, record: onRecords[0], local: onLocal[0], remote: onRemote[0] });
		const action = decided === undefined ? decided : applyRules(decided, input.exclusion, known);
		if (action === "excluded") {
			skipped.push({ key, reason: "excluded", remote: onRemote, local: onLocal, records: onRecords });
		} else if (action !== undefined) {
			actions.push(action);
		}
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

// A rule only ever stops a file from being sent to a remote that does not
// hold it. Everything else goes on as decided: a path on the remote is synced
// whatever the rules say, and a recorded path the remote deleted is deleted
// in the vault like any other.
function applyRules(action: SyncAction, exclusion: Exclusion, known: KnownPaths): SyncAction | "excluded" {
	if (action.type !== "upload" || action.remote !== undefined) return action;

	// Asked as if the path had no record: the remote does not hold it, so a
	// record is all that could make it known, and the question is what the
	// path would be without one. Whether the remote holds some other path is
	// answered as it is; the exclusion asks that when this is a copy kept
	// from a conflict, which is sent while the file it is a copy of is there.
	const { key, record } = action;
	const withoutItself: KnownPaths = {
		has: (other, type) => other !== key && known.has(other, type),
		onRemote: known.onRemote,
	};
	if (!exclusion.excludes(key, "file", withoutItself)) return action;
	if (record === undefined) return "excluded";

	// Recorded, deleted on the remote, edited in the vault, and matched by a
	// rule: the edit is kept but not sent back, as git does after a
	// `git rm --cached`. The record goes. If it stayed, every later plan
	// would come to this same decision again; without it the path is simply
	// excluded. Should the remote ever hold the path again with other
	// content, that is a conflict, which loses nothing.
	return { ...action, type: "drop-record", record };
}
