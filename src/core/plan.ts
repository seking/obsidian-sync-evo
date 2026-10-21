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

// The sync decision. A pure function of three listings: what the remote has,
// what the vault has, and what both had when they were last in sync. It does
// no I/O and knows nothing about any particular backend.

import type { EntryKind, RemoteEntry } from "./backend";
import { type Exclusion, type HardExclusion, knownPaths, ruleMatchesFolder } from "./exclusion";
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
	/**
	 * Set by a sync that found a rule excluding the path (`SyncPlan.marks`),
	 * or a link of the vault at it or above it: cut off either way.
	 * Apart from what the record says of the content, which an excluded path
	 * keeps as it was. Once no rule excludes the path any more, a side that
	 * no longer has it is no deletion to carry over: the record is dropped
	 * instead, and the side that has it sends it or fetches it again.
	 */
	readonly wasExcluded?: true;
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
	 * is gone on both sides, or a rule excluded it at the last sync
	 * (`SyncRecord.wasExcluded`), none does now, and one side no longer has
	 * it. Whatever happened to it while it was excluded is not carried over
	 * to the other side: without the record, the side that has it sends it
	 * or fetches it again.
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
	/**
	 * The path is a link of the vault (`ScanResult.links`), or lies below
	 * one: its content is that of another place, in the vault or outside it.
	 * Nothing is sent from it, written to it, or deleted, on either side,
	 * and the records stay as they are.
	 */
	| "local-link"
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
	 * A rule excludes the path (`Exclusion.excludes`): of the root
	 * `.gitignore`, or of this device's own exclusion. Turned away before the
	 * three sides are compared, whatever they hold: nothing is sent,
	 * fetched, or deleted, on either side, and the record stays as it is but
	 * for its mark (`SyncPlan.marks`). The vault side is mostly empty: the
	 * scan does not look below a folder a rule matches.
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
	/** The links of the vault the scan found (`ScanResult.links`). */
	readonly links?: readonly string[];
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
	/**
	 * Records whose mark of an exclusion (`SyncRecord.wasExcluded`) is to be
	 * set or taken away, sorted by key: set on the record of a path a rule
	 * excludes or a link of the vault cuts off, taken away from that of a
	 * path cut off no more that both sides still have. Nothing else of the record changes. Stored where
	 * a pull or a push stores its records, and not by one that stops before
	 * that: one that waits for an answer, one that is declined, one that
	 * fails.
	 *
	 * An action of the same key stores a record of its own afterwards,
	 * which has no mark.
	 */
	readonly marks: readonly RecordMark[];
}

export interface RecordMark {
	readonly key: string;
	/** As the records were given it. */
	readonly record: SyncRecord;
	/** What the mark is to be. */
	readonly wasExcluded: boolean;
}

/**
 * How many of the records are of paths a rule excludes now, or that are at
 * a link of the vault or below one. They are left out of what the share of
 * deletions is taken of (`recordCount` of a pull and of a push), as they
 * are left out of the sync: none of them can be deleted, and counted they
 * would make a share of deletions look smaller than it is.
 */
export function excludedRecordCount(skipped: readonly SkippedPath[]): number {
	let count = 0;
	for (const skip of skipped) {
		if (skip.reason === "excluded" || skip.reason === "local-link") count += skip.records.length;
	}
	return count;
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
	const links = new Set((input.links ?? []).map(foldedKey));
	const sizeLimit = input.sizeLimit ?? DEFAULT_SIZE_LIMIT;

	const known = knownPaths(input.remote, input.records);
	const keys = new Set([...remote.keys(), ...local.keys(), ...records.keys()]);
	const actions: SyncAction[] = [];
	const skipped: SkippedPath[] = [];
	const marks: RecordMark[] = [];

	for (const key of [...keys].sort()) {
		const onRemote = remote.get(key) ?? [];
		const onLocal = local.get(key) ?? [];
		const onRecords = records.get(key) ?? [];

		// Paths that must not be touched on either side, whatever the three
		// sides hold, are turned away here, before the three-way comparison:
		// the two fixed exclusions, and what a rule excludes. A path that is
		// not one comes first: the exclusion refuses it. A path that is held
		// comes before the rules, so that its record, whose write marker is
		// still there, is not stored again for a mark.
		//
		// The rules come before the comparison, and not after it, and not
		// only by the scan not going below a folder: a recorded file the scan
		// does not find would read as deleted in the vault, and a push would
		// delete it on the remote.
		const excluded = isPathFromRoot(key) && input.exclusion.excludes(key, "file", known);
		const reason: SkipReason | undefined = !isPathFromRoot(key)
			? "invalid-path"
			: (input.exclusion.hardExclusionOf(key) ??
				(input.held?.has(foldedKey(key)) === true ? "held" : undefined) ??
				(excluded ? "excluded" : undefined) ??
				(isAtOrUnderLink(key, links) ? "local-link" : undefined) ??
				skipReason(key, [onRemote, onLocal, onRecords], collided, nonFiles, closed) ??
				(isTooLarge(onRemote, sizeLimit) || isTooLarge(onLocal, sizeLimit) ? "too-large" : undefined));
		if (reason !== undefined) {
			skipped.push({ key, reason, remote: onRemote, local: onLocal, records: onRecords });
			// Its value stays as it is. The mark says that the path was cut
			// off, should no rule exclude it later. A path below a link of
			// the vault is cut off the same way: once the link is taken
			// away, what one side lost meanwhile is no deletion, and what
			// the remote has is fetched into the folder that is there now.
			const [record] = onRecords;
			const cutOff = reason === "excluded" || reason === "local-link";
			if (cutOff && onRecords.length === 1 && record !== undefined && record.wasExcluded !== true) {
				marks.push({ key, record, wasExcluded: true });
			}
			continue;
		}

		const record = onRecords[0];
		if (record?.wasExcluded === true) {
			// Excluded (or below a link) at the last sync, and not any more.
			// A side that does not have the path lost it while it was cut
			// off, which is no deletion to carry over. Both sides have it: compared as usual,
			// from the record as it was.
			//
			// The remote is taken not to have it only where its listing
			// covers the path; below a submodule it does not list, a path
			// is turned away above. A file a cloud drive took off the device
			// is held, and turned away above too.
			if (onLocal.length === 0 || onRemote.length === 0) {
				actions.push({ key, record, local: onLocal[0], remote: onRemote[0], type: "drop-record" });
				continue;
			}
			marks.push({ key, record, wasExcluded: false });
		}

		const action = decide({ key, record, local: onLocal[0], remote: onRemote[0] });
		if (action !== undefined && isPushOnly(action) && isUnderAnyOf(key, open)) {
			skipped.push({ key, reason: "in-submodule", remote: onRemote, local: onLocal, records: onRecords });
		} else if (action !== undefined) {
			actions.push(action);
		}
	}

	return { actions, skipped, marks };
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

// Without regard to case, like the disk the links are on.
function isAtOrUnderLink(key: string, links: ReadonlySet<string>): boolean {
	if (links.size === 0) return false;
	for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
		if (links.has(foldedKey(key.slice(0, slash)))) return true;
	}
	return links.has(foldedKey(key));
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
