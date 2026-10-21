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

// What a pull does, decided before anything is touched. A pure function of
// the same three listings as the sync decision, which it is built on: it
// keeps the half of that decision that changes the vault, and adds what only
// a pull has to settle (symlinks, renames that change nothing but the case,
// files and folders that traded places, what counts as a deletion).
//
// The result is a list of steps in the order they are carried out. Whoever
// carries them out reads and writes files and decides nothing again, except
// for looking at a file once more right before it is changed.
//
// Whether the vault holds a path is always taken from the spellings the scan
// returned, compared in NFC and with the cases told apart. Asking the file
// system would answer "yes" for the old spelling of a file that was just
// renamed, on a device that does not tell the cases apart.

import type { RemoteEntry } from "./backend";
import { exceedsDeletionThreshold } from "./deletion-threshold";
import { knownPaths } from "./exclusion";
import { foldedKey, isPathFromRoot, pathKey } from "./paths";
import {
	type CaseCollision,
	caseCollisions,
	excludedRecordCount,
	type LocalEntry,
	type PlanInput,
	planSync,
	type SkippedPath,
	type SkipReason,
	type SyncAction,
	type SyncRecord,
} from "./plan";

/** The same input as the sync decision. Every record is given, of every kind. */
export type PullInput = PlanInput;

/**
 * A change to the records that touches no file. `local` is the vault file
 * the record is about, when there is one, for its time and size. A "mark"
 * sets or takes away the mark of an exclusion (`SyncPlan.marks`) and leaves
 * the rest of the record as it is, the time and the size included.
 */
export type RecordChange =
	| {
			readonly type: "set";
			readonly key: string;
			readonly record: SyncRecord;
			readonly local?: LocalEntry;
	  }
	| { readonly type: "drop"; readonly key: string; readonly record: SyncRecord }
	| { readonly type: "mark"; readonly key: string; readonly record: SyncRecord; readonly wasExcluded: boolean };

/**
 * A vault file to delete: the remote no longer holds it and the vault did
 * not change it.
 *
 * - "deleted": deleted on the remote. The only cause that always counts
 *   toward the threshold.
 * - "moved": deleted, while the same content is fetched to another path in
 *   this pull. Not counted.
 * - "swap": a file where the remote now has a folder, or a file of a folder
 *   where the remote now has a file. Deleted so that the new side can be
 *   written. Not counted.
 * - "became-symlink": the remote turned the file into a symlink, which is
 *   never written. Counted: nothing takes the place of the file.
 */
export interface PullDelete {
	readonly key: string;
	readonly local: LocalEntry;
	/** The record of the file, which goes with it. */
	readonly record: SyncRecord;
	readonly cause: "deleted" | "moved" | "swap" | "became-symlink";
	/** The record to store under the key once the file is gone; only for "became-symlink". */
	readonly recordAfter?: SyncRecord;
}

/**
 * A vault file that is in the way of what the remote now holds at its path
 * and has content the remote never got. It is moved, by a rename, to the
 * name of a conflict copy of `nameAfter`, so that nothing is deleted.
 *
 * - "became-symlink": the remote turned the file into a symlink and the
 *   vault had edited it.
 * - "became-folder": the remote has files below the path, and the vault file
 *   is new or edited.
 */
export interface PullAside {
	readonly key: string;
	readonly local: LocalEntry;
	readonly nameAfter: string;
	readonly cause: "became-symlink" | "became-folder";
	/** The record of the file, if it has one. It goes once the file is moved. */
	readonly record?: SyncRecord;
	/** The record to store under the key instead; only for "became-symlink". */
	readonly recordAfter?: SyncRecord;
}

/**
 * A folder whose name the pull changes in one call, taking along everything
 * in it. Listed from the top down: `from` is where the folder is once the
 * renames before it are done.
 */
export interface FolderRename {
	readonly from: string;
	readonly to: string;
}

/**
 * One file that the remote holds under a spelling that differs only in case
 * from the one in the vault.
 *
 * - "remote-rename": the remote deleted the recorded path and added this
 *   one. What looks like a deletion and an addition is carried out as a
 *   rename, because where the cases are not told apart the two are one file.
 * - "vault-spelling": the pull is about to write this path, the vault holds
 *   no file spelled so, and it holds one file under another case that the
 *   remote does not have. Where the cases are not told apart that file is
 *   this path, and writing would go over it unseen; so it is given the
 *   remote's spelling first and then compared like the file at this path.
 *
 * The steps, in order:
 *
 * 1. `occupant`, when it is not the same as the remote content, is moved to
 *    the name of a conflict copy of `to`, by a rename.
 * 2. `step`:
 *    - "rename": `from` gets the name `to`, in one call. When `viaFolder`
 *      is set the folder renames are expected to have done it; otherwise the
 *      file is at `fromNow`.
 *    - "already-renamed": nothing. The vault has no file under the old
 *      spelling and the one under the new spelling has the recorded content:
 *      a pull stopped right after renaming it.
 *    - "delete-old": the occupant already is the remote content, or still
 *      the recorded content, and `from` holds nothing else. `from` is
 *      deleted and the occupant is the file from here on.
 *    - "old-aside": the occupant is the remote content and `from` was
 *      edited. `from` is moved to the name of a conflict copy of `to`.
 * 3. The record `dropRecord` is removed and `recordAfter` stored.
 * 4. `then`: "write" and "conflict" are carried out by the entry of the
 *    same key in `writes`, with the other writes. A copy made there is named
 *    after `to` and made after the rename, so that two copies of one pair
 *    never differ only in case.
 */
export type PullRename = PullRenameBase &
	(
		| {
				readonly step: "rename";
				/** The file under the other spelling, as scanned. */
				readonly from: LocalEntry;
				/** Where `from` is once the folder renames are done. */
				readonly fromNow: string;
				/**
				 * Whether the folder renames alone bring the file to `to`.
				 * Decided from the scan, so it is checked, not assumed:
				 * whoever carries the plan out looks whether the file is in
				 * fact at `to`, and renames it from `fromNow` when it is not.
				 */
				readonly viaFolder: boolean;
				/** Another file the vault already holds at `to`, on a device that tells the cases apart. */
				readonly occupant?: RenameOccupant;
		  }
		| { readonly step: "already-renamed" }
		| {
				readonly step: "delete-old" | "old-aside";
				readonly from: LocalEntry;
				readonly fromNow: string;
				readonly occupant: RenameOccupant;
		  }
	);

export interface RenameOccupant {
	readonly local: LocalEntry;
	readonly sameAsRemote: boolean;
}

export interface PullRenameBase {
	/** `pathKey(to)`. */
	readonly key: string;
	readonly kind: "remote-rename" | "vault-spelling";
	readonly remote: RemoteEntry;
	/** The remote's spelling. */
	readonly to: string;
	/** The record under the old spelling. */
	readonly dropRecord?: SyncRecord;
	/**
	 * The record of `to` once the step is done. With the remote's hash when
	 * the file then is the remote content; with the old hash while a write
	 * or a conflict is still to come, so that a pull that stops in between
	 * comes to the same decision again. Absent when the path has no record
	 * and the file differs from the remote.
	 */
	readonly recordAfter?: SyncRecord;
	readonly then: "done" | "write" | "conflict";
}

/**
 * A file in a folder whose files are moved one by one, because the vault
 * already holds a folder under the new spelling. The remote does not have
 * this file; it follows the others so that the old folder does not stay
 * behind with it. When `aside` is set the name `to` is taken, by another
 * vault file or by a file or folder this pull writes, and this one goes to
 * the name of a conflict copy of `to` instead. A file that would land below
 * a file this pull writes is not moved at all.
 */
export interface StrayMove {
	readonly local: LocalEntry;
	readonly to: string;
	readonly aside: boolean;
}

/**
 * Remote content to write to the vault. `local` is the file as it will be
 * when the write is reached: for an entry with `afterRename` it is the
 * renamed file, spelled as the remote spells it.
 */
export type PullWrite =
	| {
			readonly type: "download";
			readonly key: string;
			readonly remote: RemoteEntry;
			/** The file to overwrite, unchanged since its record. Absent: the path is new to the vault. */
			readonly local?: LocalEntry;
			readonly record?: SyncRecord;
			readonly afterRename: boolean;
			/**
			 * The vault has a folder at this path, and the pull deletes every
			 * file the scan found in it. The folder is removed before the
			 * write. If it is not empty by then, the path cannot be written.
			 */
			readonly replacesFolder: boolean;
	  }
	/** Both sides changed. The vault content goes to a copy, the remote content to the path. */
	| {
			readonly type: "conflict";
			readonly key: string;
			readonly remote: RemoteEntry;
			readonly local: LocalEntry;
			readonly record?: SyncRecord;
			readonly afterRename: boolean;
	  };

/** A symlink on the remote. Never fetched or written; only its record is kept. */
export interface PullSymlink {
	readonly key: string;
	readonly remote: RemoteEntry;
	/** No record held it as a symlink before: to be told once. */
	readonly firstSeen: boolean;
	/**
	 * Vault files at the path that stay as they are and are never sent.
	 * Spelled as scanned, before the renames of this plan.
	 */
	readonly local: readonly LocalEntry[];
}

/**
 * "blocked": the remote file was not written because something in the vault
 * is in its way that the pull must not move. `local` lists it: files in a
 * folder of that name that the remote never got, or a file left alone for
 * another reason whose name differs only in case.
 */
export type PullSkipReason = SkipReason | "blocked";

export interface PullSkip extends Omit<SkippedPath, "reason"> {
	readonly reason: PullSkipReason;
}

/**
 * Carried out in this order: `records`, `deletes`, `asides`,
 * `folderRenames`, `renames`, `strays`, `writes`, and last the folders of
 * `emptiedFolders` that are in fact empty. Deletions come before renames
 * because a folder rename would take a file that is to be deleted along to a
 * path where the deletion no longer finds it; and everything that removes
 * comes before everything that writes.
 *
 * `folderRenames` go from the top folder down. `records` has the changes
 * that others depend on first (records of symlinks that are gone, then the
 * symlinks), then the rest by key. Every other list is sorted by key.
 */
export interface PullPlan {
	readonly input: PullInput;
	/**
	 * The number of records, of every kind, before the pull: what the share
	 * of deletions is taken of. Not those of paths a rule excludes, which
	 * the pull leaves alone.
	 */
	readonly recordCount: number;
	readonly records: readonly RecordChange[];
	readonly deletes: readonly PullDelete[];
	readonly asides: readonly PullAside[];
	readonly folderRenames: readonly FolderRename[];
	readonly renames: readonly PullRename[];
	readonly strays: readonly StrayMove[];
	readonly writes: readonly PullWrite[];
	/** The remote entries whose content the writes need, one per write and in their order. */
	readonly fetch: readonly RemoteEntry[];
	readonly symlinks: readonly PullSymlink[];
	/** Paths the pull leaves alone on every side. Symlinks are in `symlinks` instead. */
	readonly skipped: readonly PullSkip[];
	/** The names behind the "case-collision" skips, for telling the user. */
	readonly collisions: readonly CaseCollision[];
	/**
	 * What the sync decision leaves to a push. A pull keeps these files and
	 * their records as they are. The paths are the spellings from before the
	 * renames of this plan: a file in a folder the plan renames is listed
	 * under the old one.
	 */
	readonly pushOnly: readonly SyncAction[];
	/**
	 * Folders that may be empty once the steps are done, deepest first and
	 * spelled as they are by then. Only these are removed when empty; a
	 * folder that was empty before is the user's.
	 */
	readonly emptiedFolders: readonly string[];
}

export function planPull(input: PullInput): PullPlan {
	const remoteByKey = groupBy(input.remote, (entry) => pathKey(entry.path));

	// A record of a symlink the remote no longer holds as one is no record
	// as far as files go. It is dropped first, and the path and everything
	// below it is decided as if it had never been recorded: a file that took
	// the place of the symlink is fetched, or compared with a vault file
	// that is already there. Not where a rule excludes the path: its record
	// stays as it is, like every record of such a path.
	const known = knownPaths(input.remote, input.records);
	const stale: SyncRecord[] = [];
	const records: SyncRecord[] = [];
	for (const record of input.records) {
		const key = pathKey(record.path);
		const onRemote = remoteByKey.get(key) ?? [];
		const gone =
			record.kind === "symlink" &&
			!onRemote.some((entry) => entry.kind === "symlink") &&
			!(isPathFromRoot(key) && input.exclusion.excludes(key, "file", known));
		(gone ? stale : records).push(record);
	}

	const sync = planSync({ ...input, records });
	const state = new Draft(input, sync.skipped);
	for (const record of stale) {
		state.changes.push({ type: "drop", key: pathKey(record.path), record });
	}
	for (const { key, record, wasExcluded } of sync.marks) {
		state.changes.push({ type: "mark", key, record, wasExcluded });
	}

	const symlinkRecords = new Set<string>();
	for (const record of input.records) {
		if (record.kind === "symlink") symlinkRecords.add(foldedKey(record.path));
	}
	for (const skip of sync.skipped) planSymlink(state, skip, symlinkRecords);

	const actions = new Map<string, SyncAction>();
	for (const action of sync.actions) actions.set(action.key, action);
	pairRemoteRenames(state, actions);
	respellVaultFiles(state, actions);

	for (const action of actions.values()) {
		const { key, local, record } = action;
		switch (action.type) {
			case "download":
				state.writes.set(key, {
					type: "download",
					key,
					remote: action.remote,
					...(local === undefined ? {} : { local }),
					...(record === undefined ? {} : { record }),
					afterRename: false,
					replacesFolder: false,
				});
				break;
			case "conflict":
				state.writes.set(key, {
					type: "conflict",
					key,
					remote: action.remote,
					local: action.local,
					...(record === undefined ? {} : { record }),
					afterRename: false,
				});
				break;
			case "update-record":
				state.settled.set(key, { type: "set", key, record: recordOf(action.remote), local: action.local });
				break;
			case "delete-local":
				state.deletes.set(key, { key, local: action.local, record: action.record, cause: "deleted" });
				break;
			case "drop-record":
				state.settled.set(key, { type: "drop", key, record: action.record });
				break;
			case "upload":
			case "delete-remote":
				state.pushOnly.set(key, action);
				break;
		}
	}

	resolveSwaps(state);
	markMoves(state);
	const folders = planFolderRenames(state);
	return state.finish(folders, caseCollisions(input.remote));
}

// ---------------------------------------------------------------------------
// Symlinks

// The sync decision turns every path away that the remote holds as a
// symlink. Here the record is brought in line, and a file the remote turned
// into a symlink is taken out of the vault.
function planSymlink(state: Draft, skip: SkippedPath, symlinkRecords: ReadonlySet<string>): void {
	const remote = skip.remote[0];
	if (skip.reason !== "symlink" || remote === undefined || remote.kind !== "symlink") return;
	const { key } = skip;
	const record = skip.records[0];
	const file = skip.local[0];
	const link = recordOf(remote);
	state.touched.add(key);

	let left: readonly LocalEntry[] = skip.local;
	if (record === undefined || record.kind !== "file") {
		// A vault file at the path of a symlink is not compared and not sent.
		if (record === undefined || record.hash !== link.hash || record.path !== link.path) {
			state.changes.push({ type: "set", key, record: link });
		}
	} else if (file === undefined) {
		state.changes.push({ type: "set", key, record: link });
	} else if (file.hash === record.hash) {
		state.deletes.set(key, { key, local: file, record, cause: "became-symlink", recordAfter: link });
		left = [];
	} else {
		state.asides.set(key, {
			key,
			local: file,
			nameAfter: remote.path,
			cause: "became-symlink",
			record,
			recordAfter: link,
		});
		left = [];
	}
	// A symlink whose own name changed case is the one that was told before.
	state.symlinks.push({ key, remote, firstSeen: !symlinkRecords.has(foldedKey(key)), local: left });
}

// ---------------------------------------------------------------------------
// Spellings that differ only in case

// A path the remote deleted and a path it added that differ only in case
// are one rename. Paired file by file, and only where it is plain which two
// belong together: one recorded path gone and one unrecorded path new under
// the same folded key. Two spellings of one name in NFC and NFD share a key
// and never get here.
function pairRemoteRenames(state: Draft, actions: Map<string, SyncAction>): void {
	const gone = new Map<string, SyncAction[]>();
	const added = new Map<string, SyncAction[]>();
	for (const action of actions.values()) {
		const side =
			action.remote === undefined && action.record !== undefined
				? gone
				: action.remote !== undefined && action.record === undefined
					? added
					: undefined;
		if (side === undefined) continue;
		const folded = foldedKey(action.key);
		const group = side.get(folded);
		if (group === undefined) side.set(folded, [action]);
		else group.push(action);
	}

	for (const [folded, news] of added) {
		const olds = gone.get(folded) ?? [];
		const [oldSide, newSide] = [olds[0], news[0]];
		if (olds.length !== 1 || news.length !== 1 || oldSide === undefined || newSide === undefined) continue;
		const { record } = oldSide;
		const { remote } = newSide;
		if (record === undefined || remote === undefined) continue;

		const old = oldSide.local;
		const occupant = newSide.local;
		const key = newSide.key;
		const base = { key, kind: "remote-rename", remote, to: remote.path, dropRecord: record } as const;
		// What the record says of the file once it has the new name.
		const moved: SyncRecord = { path: remote.path, kind: "file", hash: record.hash };

		if (old === undefined) {
			// The vault has no file under the old spelling. One under the new
			// spelling with the recorded content is the renamed file, whoever
			// renamed it. Anything else is the plain decision: the old record
			// goes, and the new path is fetched or compared as a path
			// without a record.
			if (occupant === undefined || occupant.hash !== record.hash) continue;
			const rest = settle(key, remote, moved, occupant);
			state.addRename({ ...base, step: "already-renamed", ...rest.rename }, rest.write);
		} else if (
			occupant !== undefined &&
			occupant.hash !== remote.hash &&
			occupant.hash === record.hash &&
			old.hash === record.hash
		) {
			// Two files with the recorded content. One is enough: the old
			// one goes, and the one under the new spelling is the file from
			// here on, written like any unchanged file. A conflict copy of
			// it would only be a second copy of the same bytes.
			const rest = settle(key, remote, moved, occupant);
			state.addRename(
				{
					...base,
					from: old,
					fromNow: old.path,
					step: "delete-old",
					occupant: { local: occupant, sameAsRemote: false },
					...rest.rename,
				},
				rest.write,
			);
		} else if (occupant === undefined || occupant.hash !== remote.hash) {
			const rest = settle(key, remote, moved, { ...old, path: remote.path });
			state.addRename(
				{
					...base,
					from: old,
					fromNow: old.path,
					step: "rename",
					viaFolder: false,
					...(occupant === undefined ? {} : { occupant: { local: occupant, sameAsRemote: false } }),
					...rest.rename,
				},
				rest.write,
			);
		} else {
			// The vault already holds the remote content under the new
			// spelling. The old file is not needed, unless it holds an edit
			// that is nowhere else.
			const spare = old.hash === record.hash || old.hash === occupant.hash;
			state.addRename({
				...base,
				from: old,
				fromNow: old.path,
				step: spare ? "delete-old" : "old-aside",
				occupant: { local: occupant, sameAsRemote: true },
				recordAfter: recordOf(remote),
				then: "done",
			});
		}
		actions.delete(oldSide.key);
		actions.delete(newSide.key);
	}
}

// A file the pull is about to write, where the vault has nothing under that
// spelling but one file under another case. Whether the two are one file
// depends on the device, and is not asked: the file is given the remote's
// spelling, which is right where they are one and loses nothing where they
// are not, and is then compared like any file at that path.
//
// Only a write sets this off. A file whose record and remote agree while
// the vault spells it otherwise is a rename the vault made, and that is a
// push's to send.
function respellVaultFiles(state: Draft, actions: Map<string, SyncAction>): void {
	for (const action of [...actions.values()]) {
		if (action.type !== "download" || action.local !== undefined) continue;
		const { key, remote, record } = action;
		const variants = (state.localByFold.get(foldedKey(key)) ?? []).filter((entry) => pathKey(entry.path) !== key);
		// More than one: the device tells the cases apart, and the write
		// lands on none of them.
		const variant = variants[0];
		if (variants.length !== 1 || variant === undefined) continue;
		const variantKey = pathKey(variant.path);
		if (state.renamedFrom.has(variantKey) || state.deletes.has(variantKey) || state.asides.has(variantKey)) {
			continue;
		}
		const there = actions.get(variantKey);
		// Deleted before anything is written: nothing is in the way by then.
		if (there?.type === "delete-local") continue;

		// `there?.remote` cannot be set: a remote that held both spellings
		// would be a collision, and neither key would have an action. Kept
		// so that a file the remote holds is never renamed away.
		const reason = state.skipReasons.get(variantKey);
		if ((reason !== undefined && reason !== "excluded") || there?.remote !== undefined) {
			state.block(key, remote, [variant], record);
			actions.delete(key);
			continue;
		}

		const rest = settle(key, remote, record, { ...variant, path: remote.path });
		state.addRename(
			{
				key,
				kind: "vault-spelling",
				remote,
				to: remote.path,
				from: variant,
				fromNow: variant.path,
				step: "rename",
				viaFolder: false,
				...(there?.record === undefined ? {} : { dropRecord: there.record }),
				...rest.rename,
			},
			rest.write,
		);
		state.touched.add(variantKey);
		actions.delete(key);
		actions.delete(variantKey);
	}
}

// What is left to do once a file has the remote's spelling: the three-way
// decision again, with the record the path has by then, and only the half
// of it that a pull acts on.
function settle(
	key: string,
	remote: RemoteEntry,
	record: SyncRecord | undefined,
	file: LocalEntry,
): { rename: Pick<PullRenameBase, "recordAfter" | "then">; write?: PullWrite } {
	if (file.hash === remote.hash) return { rename: { recordAfter: recordOf(remote), then: "done" } };
	const kept = record === undefined ? {} : { recordAfter: record };
	if (record !== undefined && record.hash === file.hash) {
		return {
			rename: { ...kept, then: "write" },
			write: { type: "download", key, remote, local: file, record, afterRename: true, replacesFolder: false },
		};
	}
	// The remote only changed the name and the vault edited the file: the
	// edit is content a push has yet to send, not a conflict.
	if (record?.hash === remote.hash) return { rename: { ...kept, then: "done" } };
	return {
		rename: { ...kept, then: "conflict" },
		write: {
			type: "conflict",
			key,
			remote,
			local: file,
			...(record === undefined ? {} : { record }),
			afterRename: true,
		},
	};
}

// ---------------------------------------------------------------------------
// Files and folders that traded places

// Paths are compared as keys here too, with the cases told apart. A file
// `A` beside a new folder `a/` is in the way only on a device that does not
// tell them apart, and is not seen here. Nothing is lost by that: at worst
// one write fails there, and the next pull repairs it.
function resolveSwaps(state: Draft): void {
	for (const write of [...state.writes.values()]) {
		if (write.type !== "download" || write.afterRename || write.local !== undefined) continue;
		const { key, remote, record } = write;

		// A vault file where the remote now has a folder.
		let blocked = false;
		for (let slash = key.indexOf("/"); slash !== -1 && !blocked; slash = key.indexOf("/", slash + 1)) {
			const above = key.slice(0, slash);
			const files = state.localByKey.get(above);
			if (files === undefined) continue;
			const deletion = state.deletes.get(above);
			if (deletion !== undefined) {
				if (deletion.cause === "deleted") state.deletes.set(above, { ...deletion, cause: "swap" });
				continue;
			}
			if (state.asides.has(above)) continue;

			// Not deleted, so it holds something the remote never got: new,
			// edited, or matched by a rule. It is moved out of the way under
			// the name of a conflict copy. A file the pull has other plans
			// for, or must not touch, stays, and the write is given up.
			//
			// The last two tests cannot fail with a git remote: a write or a
			// record set at `above` means the remote holds a file there, and
			// it cannot hold a file and paths below it at once. Kept for
			// remotes whose names are not paths.
			const reason = state.skipReasons.get(above);
			const file = files[0];
			const movable =
				files.length === 1 &&
				file !== undefined &&
				(reason === undefined || reason === "excluded") &&
				!state.renamedFrom.has(above) &&
				!state.writes.has(above) &&
				state.settled.get(above)?.type !== "set";
			if (!movable) {
				state.block(key, remote, files, record);
				blocked = true;
				continue;
			}
			const held = state.settled.get(above) ?? state.pushOnly.get(above);
			state.asides.set(above, {
				key: above,
				local: file,
				nameAfter: file.path,
				cause: "became-folder",
				...(held?.record === undefined ? {} : { record: held.record }),
			});
			state.settled.delete(above);
			state.pushOnly.delete(above);
			state.touched.add(above);
		}
		if (blocked || !state.localFolders.has(key)) continue;

		// A vault folder where the remote now has a file. Files in it that
		// the pull deletes make way; any other file is content the remote
		// never got, and has nowhere else to go, so the remote file waits.
		const inside = state.localUnder(key);
		const staying = inside.filter((entry) => !state.deletes.has(pathKey(entry.path)));
		if (staying.length > 0) {
			state.block(key, remote, staying, record);
			continue;
		}
		for (const entry of inside) {
			const below = pathKey(entry.path);
			const deletion = state.deletes.get(below);
			if (deletion?.cause === "deleted") state.deletes.set(below, { ...deletion, cause: "swap" });
		}
		state.writes.set(key, { ...write, replacesFolder: true });
	}
}

// A deleted file whose content the same pull fetches to a path that is new
// to the vault was moved on the remote. Each fetched path stands for one
// deleted file only, so that many copies of one content (empty files, one
// image) are not all taken for moves.
function markMoves(state: Draft): void {
	const added = new Map<string, number>();
	for (const write of state.writes.values()) {
		if (write.type !== "download" || write.afterRename || write.local !== undefined) continue;
		added.set(write.remote.hash, (added.get(write.remote.hash) ?? 0) + 1);
	}
	if (added.size === 0) return;
	for (const key of [...state.deletes.keys()].sort()) {
		const deletion = state.deletes.get(key);
		if (deletion === undefined || deletion.cause !== "deleted") continue;
		const left = added.get(deletion.local.hash) ?? 0;
		if (left === 0) continue;
		added.set(deletion.local.hash, left - 1);
		state.deletes.set(key, { ...deletion, cause: "moved" });
	}
}

// ---------------------------------------------------------------------------
// Folders behind the file renames

interface FolderPlan {
	readonly renames: readonly FolderRename[];
	readonly strays: readonly StrayMove[];
	/** Where a vault path is once the folder renames are done. */
	respell(path: string): string;
}

// The renames are found file by file, but a folder whose name changed is
// renamed in one call where that is possible: when the scan found nothing
// under the new spelling. Where it did, the device tells the cases apart and
// holds both folders; the files are then moved one by one into the folder
// that is there, and the files of the old folder that the remote does not
// have follow them.
//
// Not in one call either when a file below it is held (`PlanInput.held`): it
// would go along, away from the path its write marker names. Where the cases
// are told apart, the next pull would find no file there, drop the marker,
// and take what may be half a file for the user's. The other files are moved
// one by one then, and the held one stays where it is.
function planFolderRenames(state: Draft): FolderPlan {
	// Folder as the vault spells it (as a key) → the same folder as the
	// remote spells it. Within one listing a folder has one spelling, or the
	// paths below it are a collision and never get here.
	const respelled = new Map<string, { readonly was: string; readonly to: string }>();
	for (const rename of state.renames.values()) {
		if (rename.step !== "rename") continue;
		const was = rename.from.path.split("/");
		const now = rename.to.split("/");
		if (was.length !== now.length) continue;
		for (let depth = 1; depth < was.length; depth++) {
			const before = was.slice(0, depth).join("/");
			const after = now.slice(0, depth).join("/");
			if (pathKey(before) !== pathKey(after)) respelled.set(pathKey(before), { was: before, to: after });
		}
	}

	// Whether the folder gets its new spelling from folder renames alone.
	const whole = new Map<string, boolean>();
	const renames: FolderRename[] = [];
	// New spellings an earlier folder rename of this plan already made. Two
	// vault folders (`notes` and `NOTES`) can lead to one remote folder; the
	// second finds it there, though the scan did not.
	const claimed = new Set<string>();
	const held = state.input.local.filter((entry) => state.skipReasons.get(pathKey(entry.path)) === "held");
	const holdsBelow = (folder: string): boolean =>
		held.some((entry) => pathKey(entry.path).startsWith(`${folder}/`));
	const byDepth = [...respelled].sort(([a], [b]) => depthOf(a) - depthOf(b) || compare(a, b));
	for (const [key, { was, to }] of byDepth) {
		const above = respelled.get(parentOf(key));
		if (above !== undefined && whole.get(parentOf(key)) !== true) {
			whole.set(key, false);
			continue;
		}
		const name = was.slice(was.lastIndexOf("/") + 1);
		if (pathKey(name) === pathKey(to.slice(to.lastIndexOf("/") + 1))) {
			whole.set(key, true);
			continue;
		}
		// The name must be free once the folders above have theirs. A folder
		// the vault has beside this one under the old spelling of the parent
		// (`notes/Sub` beside `notes/sub`) is carried along by the parent's
		// rename, and is in the way by then, though the scan found nothing
		// under the new spelling.
		const carried = `${parentOf(key)}/${pathKey(to.slice(to.lastIndexOf("/") + 1))}`;
		const free =
			!state.localFolders.has(pathKey(to)) &&
			!(above !== undefined && state.localFolders.has(carried)) &&
			!claimed.has(pathKey(to)) &&
			!holdsBelow(key);
		whole.set(key, free);
		if (!free) continue;
		claimed.add(pathKey(to));
		const parent = above === undefined ? parentOf(was) : above.to;
		renames.push({ from: parent === "" ? name : `${parent}/${name}`, to });
	}

	const deepest = (path: string, onlyWhole: boolean): { to: string; rest: string } | undefined => {
		if (respelled.size === 0) return undefined;
		for (let slash = path.lastIndexOf("/"); slash !== -1; slash = path.lastIndexOf("/", slash - 1)) {
			const folder = pathKey(path.slice(0, slash));
			const found = respelled.get(folder);
			if (found === undefined || (onlyWhole && whole.get(folder) !== true)) continue;
			return { to: found.to, rest: path.slice(slash + 1) };
		}
		return undefined;
	};
	const respell = (path: string): string => {
		const found = deepest(path, true);
		return found === undefined ? path : `${found.to}/${found.rest}`;
	};

	// Folders the writes need, and files they make. A stray must not take
	// the name of one, and cannot go below the other.
	const writeFolders = new Set<string>();
	for (const key of state.writes.keys()) {
		for (let slash = key.lastIndexOf("/"); slash !== -1; slash = key.lastIndexOf("/", slash - 1)) {
			const folder = key.slice(0, slash);
			if (writeFolders.has(folder)) break;
			writeFolders.add(folder);
		}
	}
	const belowWrite = (key: string): boolean => {
		for (let slash = key.lastIndexOf("/"); slash !== -1; slash = key.lastIndexOf("/", slash - 1)) {
			if (state.writes.has(key.slice(0, slash))) return true;
		}
		return false;
	};

	const strays: StrayMove[] = [];
	if (respelled.size > 0) {
		for (const local of state.input.local) {
			const found = deepest(local.path, false);
			if (found === undefined) continue;
			const key = pathKey(local.path);
			const reason = state.skipReasons.get(key);
			if (reason !== undefined && reason !== "excluded") continue;
			if (state.renamedFrom.has(key) || state.deletes.has(key) || state.asides.has(key)) continue;
			const to = `${found.to}/${found.rest}`;
			const toKey = pathKey(to);
			// Carried along by a folder rename.
			if (pathKey(respell(local.path)) === toKey) continue;
			// Below a file the pull writes there is no place for it, not
			// even for a copy. It stays where it is, and so does its folder.
			if (belowWrite(toKey)) continue;
			const taken = state.localByKey.has(toKey) || state.writes.has(toKey) || writeFolders.has(toKey);
			strays.push({ local, to, aside: taken });
			state.touched.add(key);
		}
	}
	return { renames, strays, respell };
}

// ---------------------------------------------------------------------------

class Draft {
	readonly localByKey: ReadonlyMap<string, LocalEntry[]>;
	readonly localByFold: ReadonlyMap<string, LocalEntry[]>;
	/** Every folder the scan found a file in, as a key. */
	readonly localFolders: ReadonlySet<string>;
	readonly skipReasons = new Map<string, SkipReason>();
	/** Keys the pull does something about although the sync decision turned them away. */
	readonly touched = new Set<string>();

	/** Record changes in the order they were decided, then those of `settled`. */
	readonly changes: RecordChange[] = [];
	readonly settled = new Map<string, RecordChange>();
	readonly deletes = new Map<string, PullDelete>();
	readonly asides = new Map<string, PullAside>();
	readonly renames = new Map<string, PullRename>();
	/** Keys of the vault files that renames take away from their spelling. */
	readonly renamedFrom = new Set<string>();
	readonly writes = new Map<string, PullWrite>();
	readonly pushOnly = new Map<string, SyncAction>();
	readonly symlinks: PullSymlink[] = [];
	private readonly blocked: PullSkip[] = [];

	constructor(
		readonly input: PullInput,
		private readonly skips: readonly SkippedPath[],
	) {
		this.localByKey = groupBy(input.local, (entry) => pathKey(entry.path));
		this.localByFold = groupBy(input.local, (entry) => foldedKey(entry.path));
		const folders = new Set<string>();
		for (const key of this.localByKey.keys()) {
			for (let slash = key.lastIndexOf("/"); slash !== -1; slash = key.lastIndexOf("/", slash - 1)) {
				const folder = key.slice(0, slash);
				if (folders.has(folder)) break;
				folders.add(folder);
			}
		}
		this.localFolders = folders;
		for (const skip of skips) this.skipReasons.set(skip.key, skip.reason);
	}

	localUnder(folder: string): LocalEntry[] {
		const prefix = `${folder}/`;
		return this.input.local.filter((entry) => pathKey(entry.path).startsWith(prefix));
	}

	addRename(rename: PullRename, write?: PullWrite): void {
		this.renames.set(rename.key, rename);
		if (rename.step !== "already-renamed") this.renamedFrom.add(pathKey(rename.from.path));
		if (write !== undefined) this.writes.set(write.key, write);
	}

	block(key: string, remote: RemoteEntry, local: readonly LocalEntry[], record: SyncRecord | undefined): void {
		this.writes.delete(key);
		this.blocked.push({
			key,
			reason: "blocked",
			remote: [remote],
			local,
			records: record === undefined ? [] : [record],
		});
	}

	finish(folders: FolderPlan, collisions: readonly CaseCollision[]): PullPlan {
		const renames = sorted(this.renames).map((rename): PullRename => {
			if (rename.step === "already-renamed") return rename;
			const fromNow = folders.respell(rename.from.path);
			if (rename.step !== "rename") return { ...rename, fromNow };
			return { ...rename, fromNow, viaFolder: pathKey(fromNow) === rename.key };
		});
		const deletes = sorted(this.deletes);
		const asides = sorted(this.asides);
		const writes = sorted(this.writes);

		// Every folder a file leaves, spelled as it is at the end.
		const emptied = new Set<string>();
		const leaves = (path: string): void => {
			for (let slash = path.lastIndexOf("/"); slash !== -1; slash = path.lastIndexOf("/", slash - 1)) {
				emptied.add(path.slice(0, slash));
			}
		};
		for (const entry of deletes) leaves(folders.respell(entry.local.path));
		// A file that is moved to the name of a copy leaves its folder too:
		// the copy is made in the folder of the copies.
		for (const entry of asides) leaves(folders.respell(entry.local.path));
		for (const rename of renames) {
			// A file that was renamed before the pull stopped left the folder
			// its record still names, which nothing else here would mention.
			const left =
				rename.step === "already-renamed"
					? rename.dropRecord?.path
					: rename.step === "rename" && rename.viaFolder
						? undefined
						: rename.fromNow;
			if (left !== undefined && parentOf(pathKey(left)) !== parentOf(rename.key)) leaves(folders.respell(left));
		}
		for (const stray of folders.strays) leaves(folders.respell(stray.local.path));

		const skipped: PullSkip[] = this.skips.filter((skip) => !this.touched.has(skip.key));
		skipped.push(...this.blocked);

		return {
			input: this.input,
			recordCount: this.input.records.length - excludedRecordCount(this.skips),
			records: [...this.changes, ...sorted(this.settled)],
			deletes,
			asides,
			folderRenames: folders.renames,
			renames,
			strays: folders.strays,
			writes,
			fetch: writes.map((write) => write.remote),
			symlinks: this.symlinks,
			skipped: skipped.sort((a, b) => compare(a.key, b.key)),
			collisions,
			pushOnly: sorted(this.pushOnly),
			emptiedFolders: [...emptied].sort((a, b) => depthOf(b) - depthOf(a) || compare(a, b)),
		};
	}
}

function recordOf(remote: RemoteEntry): SyncRecord {
	return { path: remote.path, kind: remote.kind, hash: remote.hash };
}

function groupBy<T>(entries: readonly T[], keyOf: (entry: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const entry of entries) {
		const key = keyOf(entry);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [entry]);
		else group.push(entry);
	}
	return groups;
}

function sorted<T>(byKey: ReadonlyMap<string, T>): T[] {
	return [...byKey]
		.sort(([a], [b]) => compare(a, b))
		.map(([, value]) => value);
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function depthOf(path: string): number {
	return path.split("/").length;
}

/** The folder a path is in; empty for a path at the root. */
function parentOf(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

// ---------------------------------------------------------------------------
// What a pull takes away, and asking before it does

/** A vault file, by its key and by the spelling to show. */
export interface PullLoss {
	readonly key: string;
	readonly path: string;
}

export interface PullLosses {
	readonly rewritten: boolean;
	/** Vault files the pull deletes. */
	readonly deletions: readonly PullLoss[];
	/** Vault files the pull overwrites. Only listed when the history was rewritten. */
	readonly overwrites: readonly PullLoss[];
}

/**
 * The vault files a pull takes away, as far as the user is asked about them.
 *
 * While the history of the remote goes on from the base, a deleted or
 * overwritten file is still in that history. Only the deletions are listed,
 * and of those only what counts toward the threshold: not the moves, not the
 * files deleted so that a folder or a file of the same name can be written,
 * and not the renames that only change the case.
 *
 * When the history was rewritten (`rewritten`), the content may be nowhere
 * but in the vault. Then every file the pull deletes is listed, except the
 * moves, whose content the pull itself fetches to another path; and so is
 * every file it overwrites. An overwrite is listed under the key it is
 * written to, which stays the same when a pull stops after a rename.
 */
export function pullLosses(plan: PullPlan, rewritten: boolean): PullLosses {
	const deletions: PullLoss[] = [];
	const overwrites: PullLoss[] = [];
	for (const entry of plan.deletes) {
		const counted = entry.cause === "deleted" || entry.cause === "became-symlink";
		if (counted || (rewritten && entry.cause === "swap")) deletions.push({ key: entry.key, path: entry.local.path });
	}
	if (rewritten) {
		for (const rename of plan.renames) {
			if (rename.step !== "delete-old") continue;
			deletions.push({ key: pathKey(rename.from.path), path: rename.from.path });
		}
		for (const write of plan.writes) {
			if (write.type !== "download" || write.local === undefined) continue;
			// A file that is renamed first is shown under the name it has now.
			const rename = write.afterRename ? plan.renames.find((entry) => entry.key === write.key) : undefined;
			overwrites.push({ key: write.key, path: (rename?.step === "rename" ? rename.from : write.local).path });
		}
	}
	return { rewritten, deletions, overwrites };
}

/**
 * Whether the pull has to stop and ask: past the threshold, or, when the
 * history was rewritten, as soon as one file is deleted or overwritten.
 */
export function needsConfirmation(losses: PullLosses, recordCount: number): boolean {
	if (losses.rewritten) return losses.deletions.length + losses.overwrites.length > 0;
	return exceedsDeletionThreshold(losses.deletions.length, recordCount);
}

/** What the user said yes to, as it is remembered: keys only. */
export interface PullConfirmation {
	readonly rewritten: boolean;
	readonly deletions: readonly string[];
	readonly overwrites: readonly string[];
}

export function confirmationOf(losses: PullLosses): PullConfirmation {
	return {
		rewritten: losses.rewritten,
		deletions: losses.deletions.map((loss) => loss.key),
		overwrites: losses.overwrites.map((loss) => loss.key),
	};
}

/**
 * Whether what is left to take away was all confirmed before, so that a pull
 * that resumes does not count or ask again. What is left of a pull that got
 * part of the way is a part of what was confirmed. One path more, or a
 * history that was not rewritten when the user was asked, and it is asked
 * again.
 */
export function isConfirmed(losses: PullLosses, confirmed: PullConfirmation | undefined): boolean {
	if (confirmed === undefined) return false;
	if (losses.rewritten && !confirmed.rewritten) return false;
	const deletions = new Set(confirmed.deletions);
	const overwrites = new Set(confirmed.overwrites);
	return (
		losses.deletions.every((loss) => deletions.has(loss.key)) &&
		losses.overwrites.every((loss) => overwrites.has(loss.key))
	);
}

/**
 * The plan for "keep mine": the files of `kept` (keys of `pullLosses`) stay
 * in the vault as they are, and everything else is pulled. A file that was
 * going to be deleted loses its record; one that was going to be overwritten
 * gets the record of what the remote holds now. Either way the next push
 * sends it as a change of this device.
 *
 * The rest is planned again from records changed that way, rather than cut
 * out of the plan, so that what depended on a kept file (a folder to be
 * written where it stays, the second half of a rename) is decided with it
 * in place. The record changes come first in `records`. A file that was
 * also to be renamed still is, whichever kind of rename it was: only its
 * content is kept, and the rename stores the record of the remote.
 */
export function keepLocal(plan: PullPlan, kept: ReadonlySet<string>): PullPlan {
	const dropped = new Set<string>();
	const replaced = new Map<string, SyncRecord>();
	// Records the next plan is given in a form that is not stored: what it
	// then says to drop is put back to what is stored.
	const stored = new Map<string, SyncRecord>();
	// Writes that follow a rename to the remote's spelling of a file the
	// vault spells otherwise: key → the record of what the remote holds.
	const unwritten = new Map<string, SyncRecord>();
	const changes: RecordChange[] = [];
	const drop = (record: SyncRecord): void => {
		const key = pathKey(record.path);
		dropped.add(key);
		changes.push({ type: "drop", key, record });
	};

	for (const entry of plan.deletes) {
		if (kept.has(entry.key)) drop(entry.record);
	}
	for (const rename of plan.renames) {
		if (rename.step !== "delete-old" || rename.dropRecord === undefined) continue;
		if (kept.has(pathKey(rename.from.path))) drop(rename.dropRecord);
	}
	for (const write of plan.writes) {
		if (write.type !== "download" || write.local === undefined || !kept.has(write.key)) continue;
		const now = recordOf(write.remote);
		const rename = write.afterRename ? plan.renames.find((entry) => entry.key === write.key) : undefined;
		const old = rename?.kind === "remote-rename" ? rename.dropRecord : undefined;
		if (old !== undefined && rename?.step === "rename") {
			// Still to be renamed. With the remote's hash in the old record,
			// the file reads as edited: it is renamed, not written, and the
			// rename stores the record of the remote.
			replaced.set(pathKey(old.path), { ...old, hash: now.hash });
			stored.set(pathKey(old.path), old);
			continue;
		}
		if (rename?.kind === "vault-spelling") {
			// That rename only exists because of the write. With the record
			// changed first there would be none: the file would keep its
			// spelling under a record spelled otherwise, and a push would
			// send that as a deletion. So the records stay, the rename is
			// planned again as it was, and the write is taken off it below.
			unwritten.set(write.key, now);
			continue;
		}
		if (old !== undefined) drop(old);
		replaced.set(write.key, now);
		changes.push({ type: "set", key: write.key, record: now, local: write.local });
	}

	const records = plan.input.records.filter((record) => {
		const key = pathKey(record.path);
		return !dropped.has(key) && !replaced.has(key);
	});
	records.push(...replaced.values());
	const next = planPull({ ...plan.input, records });
	// Nothing else in a plan depends on a write that follows a rename, so
	// taking it out leaves the rest as it is.
	const keptContent = (key: string): SyncRecord | undefined => {
		const rename = next.renames.find((entry) => entry.key === key);
		return rename?.kind === "vault-spelling" && rename.then === "write" ? unwritten.get(key) : undefined;
	};
	const writes = next.writes.filter((write) => !(write.afterRename && keptContent(write.key) !== undefined));
	return {
		...next,
		recordCount: plan.recordCount,
		records: [...changes, ...next.records],
		renames: next.renames.map((rename) => {
			const now = keptContent(rename.key);
			if (now !== undefined) return { ...rename, recordAfter: now, then: "done" };
			const was = rename.dropRecord === undefined ? undefined : stored.get(pathKey(rename.dropRecord.path));
			return was === undefined ? rename : { ...rename, dropRecord: was };
		}),
		writes,
		fetch: writes.map((write) => write.remote),
	};
}
