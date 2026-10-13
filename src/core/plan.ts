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
import { type Exclusion, type HardExclusion, type KnownPaths, knownPaths, ruleMatchesFolder } from "./exclusion";
import { foldedKey, isPathFromRoot, pathKey } from "./paths";

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
	/**
	 * Another path of the remote differs from this one only in upper and
	 * lower case, in its own name or in the name of a folder on the way
	 * (`notes/a.md` beside `Notes/b.md`). On a file system that does not tell
	 * the cases apart the two are one file or one folder, so whichever was
	 * written last would look like the other one deleted. Everything at or
	 * below such a name is left alone.
	 */
	| "case-collision"
	/**
	 * The remote or a record holds the path as a symlink. It is never
	 * written, sent, or deleted here; what a pull does about it (the record
	 * it keeps, and a file the remote turned into a symlink) is decided from
	 * this entry.
	 */
	| "symlink"
	/** The remote or a record holds the path as a submodule. */
	| "submodule"
	/**
	 * Below a path that the remote or a record holds as a symlink, or as a
	 * submodule whose inside is not synced: one the listing does not hold
	 * the inside of (`RemoteEntry.contents`), or one a rule matches.
	 */
	| "under-non-file"
	/**
	 * Below a submodule whose inside is synced, and changed in the vault
	 * alone: edited, added, or deleted there. What is below a submodule is
	 * only ever read, so the change is not sent, and the record stays as
	 * the remote has the path. Should the remote change it too, that is a
	 * conflict, and the vault's content is not written over.
	 */
	| "in-submodule"
	/**
	 * A file larger than the limit, on the remote or in the vault. It is not
	 * fetched, sent, or deleted, and its record stays as it is. The side
	 * that is too large has not been read, so nothing is known about it that
	 * could justify overwriting the other.
	 */
	| "too-large"
	/**
	 * One of the two things that are never synced: a `.git` ("dot-git") or
	 * the plugin's own folder ("own-folder"). An "own-folder" skip that lists
	 * remote entries is how the caller learns that the remote holds that folder.
	 */
	| HardExclusion
	/**
	 * Named by `PlanInput.held`: what is at the path could not be looked at
	 * safely just now, so nothing is decided about it.
	 */
	| "held"
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
	/** The largest file that is synced, in bytes. `DEFAULT_SIZE_LIMIT` when absent. */
	readonly sizeLimit?: number;
	/**
	 * Paths to leave alone on every side, as `foldedKey` gives them: every
	 * path that could be the same file where the cases are not told apart is
	 * turned away with the reason "held". For a file that may be half
	 * written and could not be put right (`settleMarkers` in `pull.ts`): its
	 * content must not be compared, written over, sent, or kept as a copy.
	 * The hash of a vault entry at such a path is not looked at, and may be
	 * empty.
	 */
	readonly held?: ReadonlySet<string>;
}

/**
 * 38 MiB. One limit for fetching and for sending, so that no file can be
 * fetched and then not sent back. GitHub refuses to create a blob a little
 * under 40 MiB (`GitHubClient.createBlob`); this stays about 5% below what
 * was seen to pass. A phone also holds a whole file in memory to fetch or
 * send it.
 */
export const DEFAULT_SIZE_LIMIT = 38 * 1024 * 1024;

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
	// Where the two disagree, what the remote holds now is the reason given.
	const nonFiles = new Map<string, "symlink" | "submodule">();
	for (const index of [records, remote]) {
		for (const [key, entries] of index) {
			const kind = entries.find((entry) => entry.kind !== "file")?.kind;
			if (kind !== undefined && kind !== "file") nonFiles.set(key, kind);
		}
	}
	// The submodules whose inside the listing holds, and that no rule
	// matches: what is below one is compared like any file, and only what
	// would change the remote is turned away. Every other key of `nonFiles`
	// is closed: nothing below it is looked at.
	const open = new Set<string>();
	for (const [key, entries] of remote) {
		const [entry] = entries;
		if (entries.length !== 1 || entry === undefined || entry.kind !== "submodule") continue;
		if (entry.contents?.listed === true && !ruleMatchesFolder(input.exclusion, key)) open.add(key);
	}
	const closed = new Set([...nonFiles.keys()].filter((key) => !open.has(key)));

	const collided = new Set(caseCollisions(input.remote).map((collision) => collision.folded));
	const sizeLimit = input.sizeLimit ?? DEFAULT_SIZE_LIMIT;

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
		// Of the exclusion, only the two fixed ones are of that nature.
		// A path that is not one comes first: the exclusion refuses it.
		const reason: SkipReason | undefined = !isPathFromRoot(key)
			? "invalid-path"
			: (input.exclusion.hardExclusionOf(key) ??
				(input.held?.has(foldedKey(key)) === true ? "held" : undefined) ??
				skipReason(key, [onRemote, onLocal, onRecords], collided, nonFiles, closed) ??
				(isTooLarge(onRemote, sizeLimit) || isTooLarge(onLocal, sizeLimit) ? "too-large" : undefined));
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
		} else if (action !== undefined && isPushOnly(action) && isUnderAnyOf(key, open)) {
			skipped.push({ key, reason: "in-submodule", remote: onRemote, local: onLocal, records: onRecords });
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
	collided: ReadonlySet<string>,
	nonFiles: ReadonlyMap<string, "symlink" | "submodule">,
	closed: ReadonlySet<string>,
): SkipReason | undefined {
	if (sides.some((entries) => entries.length > 1)) return "duplicate-path";
	if (isAtOrUnderCollision(key, collided)) return "case-collision";
	const kind = nonFiles.get(key);
	if (kind !== undefined) return kind;
	if (isUnderAnyOf(key, closed)) return "under-non-file";
	return undefined;
}

// What a push does, and a pull leaves as it is.
function isPushOnly(action: SyncAction): boolean {
	return action.type === "upload" || action.type === "delete-remote";
}

function isTooLarge(entries: readonly { readonly size?: number }[], limit: number): boolean {
	return entries.some((entry) => entry.size !== undefined && entry.size > limit);
}

/**
 * Names the remote spells in more than one way that differ only in upper
 * and lower case. `spellings` are the paths down to that name, as the remote
 * has them, in NFC.
 */
export interface CaseCollision {
	/** The path down to the name, without the difference between the cases. */
	readonly folded: string;
	readonly spellings: readonly string[];
}

/**
 * Every name of a remote listing, of a file or of a folder on the way to
 * one, that the listing spells in more than one case. Only the topmost name
 * of each is given: below `notes` and `Notes` everything differs.
 *
 * Spellings that differ only in normalization are not listed here. Two
 * files of that kind share a key and are a "duplicate-path"; two spellings
 * of a folder lead to files with different keys, which are matched and
 * recorded each under its own, on any file system.
 */
export function caseCollisions(remote: readonly { readonly path: string }[]): CaseCollision[] {
	const spellings = new Map<string, Set<string>>();
	const seen = new Set<string>();
	for (const entry of remote) {
		const key = pathKey(entry.path);
		if (!isPathFromRoot(key)) continue;
		// From the whole path up. A name that was seen was seen with
		// everything above it.
		for (let end = key.length; end !== -1; end = key.lastIndexOf("/", end - 1)) {
			const name = key.slice(0, end);
			if (seen.has(name)) break;
			seen.add(name);
			const folded = name.toLowerCase();
			const group = spellings.get(folded);
			if (group === undefined) spellings.set(folded, new Set([name]));
			else group.add(name);
		}
	}

	const collisions: CaseCollision[] = [];
	for (const [folded, group] of spellings) {
		if (group.size < 2) continue;
		// Listed under the name above when that one collides too. The name
		// above is taken from a spelling, not from the folded form: folding
		// can change the length of a name.
		const [first = ""] = group;
		let below = false;
		for (let slash = first.lastIndexOf("/"); slash !== -1 && !below; slash = first.lastIndexOf("/", slash - 1)) {
			below = (spellings.get(first.slice(0, slash).toLowerCase())?.size ?? 0) > 1;
		}
		if (!below) collisions.push({ folded, spellings: [...group].sort() });
	}
	return collisions.sort((a, b) => (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
}

// The key is folded piece by piece, the way `caseCollisions` folded the
// names: folding can change the length of a name, so a prefix of the folded
// key is not always the folded prefix.
function isAtOrUnderCollision(key: string, collided: ReadonlySet<string>): boolean {
	if (collided.size === 0) return false;
	for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
		if (collided.has(key.slice(0, slash).toLowerCase())) return true;
	}
	return collided.has(key.toLowerCase());
}

// A symlink has no files of its own in the listing, and neither has a
// submodule whose inside is not listed, so a path below one on any side is a
// leftover or a mistake. Sending it would replace the symlink or submodule
// with a folder.
function isUnderAnyOf(key: string, parents: { readonly size: number; has(key: string): boolean }): boolean {
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
		copyOnRemote: known.copyOnRemote,
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
