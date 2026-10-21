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

// What a push sends, decided before anything is sent. A pure function of
// the same three listings as the sync decision, which it is built on: it
// keeps the half of that decision that changes the remote, and adds what
// only a push has to settle (how a new path is spelled, new paths that
// differ from others only in case, what counts as a deletion).
//
// Everything the sync decision turns away stays turned away here: a symlink
// or a submodule and what lies below one, a file over the size limit on
// either side, what is excluded, and a path that is held.

import type { RemoteEntry } from "./backend";
import { isCopyInConflictFolder } from "./conflict-name";
import { exceedsDeletionThreshold } from "./deletion-threshold";
import { isInConfigDir } from "./exclusion";
import { foldedKey, pathKey } from "./paths";
import {
	excludedRecordCount,
	type LocalEntry,
	type PlanInput,
	planSync,
	type RecordMark,
	type SkippedPath,
	type SyncRecord,
} from "./plan";

/** A vault file to send. */
export interface PushSend {
	readonly key: string;
	readonly local: LocalEntry;
	/** The path it is sent under: the remote's for a path it holds, `remoteSpelling` for a new one. */
	readonly path: string;
	/** The entry of the remote it takes the place of. Absent: the path is new to the remote. */
	readonly replaces?: RemoteEntry;
}

/** A file of the remote to delete: the vault deleted it and the remote did not touch it. */
export interface PushDelete {
	readonly key: string;
	readonly remote: RemoteEntry;
}

/**
 * Why a file that is new to the remote is not sent.
 *
 * - "case-collision": its path differs only in upper and lower case, in its
 *   own name or in the name of a folder on the way, from a path the remote
 *   holds once the push is done, or from another new path of the same push.
 *   A remote that held both would be written by no device that cannot tell
 *   them apart (`SkipReason` "case-collision"), so the pair is stopped
 *   here, on the device that made it.
 * - "remote-in-the-way": the remote has a folder at the path, or a file
 *   where the path has a folder. Sending it would take away what the remote
 *   holds there, which this device has not pulled yet.
 */
export type PushRefusalReason = "case-collision" | "remote-in-the-way";

export interface PushRefusal {
	/** As the vault spells it. */
	readonly path: string;
	readonly reason: PushRefusalReason;
}

/**
 * A file of the remote that the vault holds under another case, where the
 * new spelling is not sent: a rule excludes it, or it was refused. The
 * deletion of the old spelling is not sent either. Sent alone, it would
 * take the file away from the remote, and from every other device, while
 * it is still in this vault.
 */
export interface HeldRename {
	/** The path on the remote, which stays. */
	readonly from: string;
	/** The path in the vault. */
	readonly to: string;
}

export interface PushPlan {
	readonly input: PlanInput;
	/**
	 * The number of records, of every kind, before the push: what the share
	 * of deletions is taken of. Not those of paths a rule excludes, which
	 * the push leaves alone.
	 */
	readonly recordCount: number;
	/** Sorted by key. */
	readonly sends: readonly PushSend[];
	/** Sorted by key. */
	readonly deletes: readonly PushDelete[];
	/**
	 * The deletions that count toward the threshold, as the remote spells
	 * them. Not the moves: a deleted file whose content the same push sends
	 * to a path that is new, one deleted file per new path. And not the
	 * renames that only change the case. Nor, once the push has looked
	 * (`withoutTidiedCopies`), the conflict copies that were tidied.
	 */
	readonly countedDeletions: readonly string[];
	readonly refused: readonly PushRefusal[];
	readonly heldRenames: readonly HeldRename[];
	/** What the sync decision turned away, on every side. */
	readonly skipped: readonly SkippedPath[];
	/**
	 * The marks of an exclusion to set or take away (`SyncPlan.marks`), and
	 * the records of paths no rule excludes any more that one side lost
	 * while one did, or below a link that is gone (`SyncRecord.wasExcluded`),
	 * which go. Both are stored with the records of a push that went
	 * through, or that found nothing to send, and by no other: they change
	 * no file, on either side.
	 */
	readonly marks: readonly RecordMark[];
	readonly drops: readonly SyncRecord[];
}

export function planPush(input: PlanInput): PushPlan {
	const sync = planSync(input);
	const spell = remoteSpelling(input.remote);

	const candidates: PushSend[] = [];
	let deletes: PushDelete[] = [];
	const drops: SyncRecord[] = [];
	for (const action of sync.actions) {
		if (action.type === "drop-record" && action.record.wasExcluded === true) {
			drops.push(action.record);
		} else if (action.type === "upload") {
			const { key, local, remote } = action;
			candidates.push(
				remote === undefined ? { key, local, path: spell(local.path) } : { key, local, path: remote.path, replaces: remote },
			);
		} else if (action.type === "delete-remote") {
			deletes.push({ key: action.key, remote: action.remote });
		}
	}

	const localByFold = new Map<string, LocalEntry[]>();
	for (const entry of input.local) {
		const folded = foldedKey(entry.path);
		const group = localByFold.get(folded);
		if (group === undefined) localByFold.set(folded, [entry]);
		else group.push(entry);
	}
	// The vault files that are a deleted path under another case.
	const respelled = (entry: PushDelete): LocalEntry[] => localByFold.get(foldedKey(entry.key)) ?? [];

	// A deletion that is held back stays on the remote, where it can be in
	// the way of another new path; so the two are decided together, until
	// nothing changes. Each round can only hold back more.
	let refused = new Map<string, PushRefusalReason>();
	const heldRenames: HeldRename[] = [];
	for (;;) {
		refused = refusals(input.remote, candidates, deletes);
		const sent = new Set(candidates.filter((send) => !refused.has(send.key)).map((send) => send.key));
		const kept: PushDelete[] = [];
		for (const entry of deletes) {
			const variants = respelled(entry);
			if (variants.length === 0 || variants.some((variant) => sent.has(pathKey(variant.path)))) {
				kept.push(entry);
				continue;
			}
			for (const variant of variants) heldRenames.push({ from: entry.remote.path, to: variant.path });
		}
		if (kept.length === deletes.length) break;
		deletes = kept;
	}

	const sends = candidates.filter((send) => !refused.has(send.key));
	const sentKeys = new Set(sends.map((send) => send.key));

	// What counts as a deletion. A new path stands for one deleted file of
	// the same content only, so that many copies of one content (empty
	// files, one image) are not all taken for moves.
	const renamed = new Set<string>();
	const counted: string[] = [];
	const plain: PushDelete[] = [];
	for (const entry of deletes) {
		const pair = respelled(entry).find((variant) => sentKeys.has(pathKey(variant.path)));
		if (pair === undefined) plain.push(entry);
		else renamed.add(pathKey(pair.path));
	}
	const added = new Map<string, number>();
	for (const send of sends) {
		if (send.replaces !== undefined || renamed.has(send.key)) continue;
		added.set(send.local.hash, (added.get(send.local.hash) ?? 0) + 1);
	}
	for (const entry of plain) {
		const left = added.get(entry.remote.hash) ?? 0;
		if (left === 0) counted.push(entry.remote.path);
		else added.set(entry.remote.hash, left - 1);
	}

	return {
		input,
		recordCount: input.records.length - excludedRecordCount(sync.skipped),
		sends,
		deletes,
		countedDeletions: counted,
		refused: candidates.flatMap((send) => {
			const reason = refused.get(send.key);
			return reason === undefined ? [] : [{ path: send.local.path, reason }];
		}),
		heldRenames: heldRenames.sort((a, b) => compare(a.to, b.to)),
		skipped: sync.skipped,
		marks: sync.marks,
		drops,
	};
}

/**
 * The plan without its deletions: they wait for the next push. Everything
 * else is sent as planned.
 *
 * For a push that started by itself and holds a new file back because it is
 * being typed in (`holdsDeletions`). A note that was renamed is, to a push,
 * a file that is gone and a file that is new; with the new one held back,
 * the deletion alone would take the note away from every other device
 * until the typing stops. Which deletion belongs to which new file is not
 * known without the content of the file that is held, so all of them wait.
 * Their records stay, and the next push plans them again.
 */
export function withoutDeletions(plan: PushPlan): PushPlan {
	return plan.deletes.length === 0 ? plan : { ...plan, deletes: [], countedDeletions: [] };
}

/**
 * The plan with the conflict copies that were tidied (`conflict-tidy.ts`) not
 * counted among its deletions. They are deleted on the remote like any other
 * file the vault deleted; only the question about many deletions passes them
 * over. The copies a first fetch made in one go are all tidied on one day,
 * and a push that stopped to ask about them would ask about nothing the
 * user did.
 *
 * `tidied` is what is remembered of them, as the vault spelled them. Only a
 * path that is a copy in the folder of the copies is passed over, whatever
 * is remembered.
 */
export function withoutTidiedCopies(plan: PushPlan, tidied: readonly string[]): PushPlan {
	if (tidied.length === 0 || plan.countedDeletions.length === 0) return plan;
	const keys = new Set(tidied.map(foldedKey));
	const counted = plan.countedDeletions.filter((path) => !(isCopyInConflictFolder(path) && keys.has(foldedKey(path))));
	return counted.length === plan.countedDeletions.length ? plan : { ...plan, countedDeletions: counted };
}

/**
 * Whether the deletions of a push wait (`withoutDeletions`): one of the
 * files it holds back because they are being typed in is new, with no
 * record and nothing at its path on the remote. `known` answers whether a
 * path has either. A file that is known and held is no rename: its
 * deletion is not planned, and the other deletions are sent as ever.
 */
export function holdsDeletions(beingEdited: readonly string[], known: (path: string) => boolean): boolean {
	return beingEdited.some((path) => !known(path));
}

/** Whether the push has to stop and ask before it deletes. Counted again by every push. */
export function needsPushConfirmation(plan: PushPlan): boolean {
	return exceedsDeletionThreshold(plan.countedDeletions.length, plan.recordCount);
}

/**
 * The files with a record that are all gone from the vault, as the records
 * spell them, when the push would delete on the remote for it; `null` in
 * every other case. The push then stops and asks, however few they are
 * (`PushDeps.askEmptyVault`): a vault folder that was deleted outside the
 * app and made again at the same place keeps its settings and its sync
 * state, and reads as a vault whose every file the user deleted. With five
 * records or fewer, the threshold would let that through.
 *
 * Looked at are the records of files outside the configuration folder,
 * but for the root `.gitignore`: a vault that was made again has both, made
 * by the app and by Sync Evo. At least one such record, and no file at any
 * of their paths:
 *
 * - A file a cloud drive has taken off the device is there, and so is
 *   every other file the plan is told of without a hash (`LocalRead`).
 * - A file under another case is there.
 * - The record of a path a rule excludes is not looked at: the vault side
 *   of such a path is not looked at either. Nor is one of a path that a
 *   rule excluded at the last sync and that the vault does not have
 *   (`PushPlan.drops`): it is no deletion.
 *
 * A file the push takes for moved (`PushPlan.countedDeletions`) is not
 * among the files that are gone: the one note of a vault that was renamed
 * is no vault without files. It does not stand for the others, though: a
 * new note with the content of one record, an empty one as the app makes
 * it, is no sign that the rest was deleted by the user. To be asked of the
 * plan before the conflict copies that were tidied are taken out of what it
 * counts (`withoutTidiedCopies`): those are gone, and not moved.
 *
 * With some of the files gone and some there, this says nothing: that is
 * what deleting notes looks like, and the threshold decides.
 */
export function missingRecordedFiles(plan: PushPlan, configDir: string): readonly string[] | null {
	if (plan.deletes.length === 0) return null;
	const inVault = new Set(plan.input.local.map((entry) => foldedKey(entry.path)));
	const counted = new Set(plan.countedDeletions.map(pathKey));
	const moved = new Set(plan.deletes.filter((entry) => !counted.has(pathKey(entry.remote.path))).map((entry) => entry.key));
	// Not in the vault's scan, and not missing: a link of the vault stands
	// there, or a rule excludes the path, or one of the two cut it off
	// until now.
	const passed = new Set([
		...plan.skipped.filter((skip) => skip.reason === "local-link" || skip.reason === "excluded").map((skip) => skip.key),
		...plan.drops.map((record) => pathKey(record.path)),
	]);
	const missing: string[] = [];
	for (const record of plan.input.records) {
		if (record.kind !== "file" || isInConfigDir(record.path, configDir) || foldedKey(record.path) === ".gitignore") continue;
		if (passed.has(pathKey(record.path))) continue;
		if (inVault.has(foldedKey(record.path))) return null;
		if (moved.has(pathKey(record.path))) continue;
		missing.push(record.path);
	}
	return missing.length === 0 ? null : missing;
}

/**
 * The new paths that are not sent, by key, given what the push deletes.
 * Only a path that is new to the remote is looked at: one the remote holds
 * is there already, whatever it is spelled like.
 */
function refusals(
	remote: readonly RemoteEntry[],
	candidates: readonly PushSend[],
	deletes: readonly PushDelete[],
): Map<string, PushRefusalReason> {
	const deleted = new Set(deletes.map((entry) => entry.key));
	// What the remote holds once the push is done, but for the new paths.
	const files = new Set<string>();
	const folders = new Set<string>();
	// Every name down every path, without the cases → how it is spelled.
	const spellings = new Map<string, Set<string>>();
	const spelled = (key: string): void => {
		for (const name of namesOf(key)) {
			const folded = name.toLowerCase();
			const group = spellings.get(folded);
			if (group === undefined) spellings.set(folded, new Set([name]));
			else group.add(name);
		}
	};
	for (const entry of remote) {
		const key = pathKey(entry.path);
		if (deleted.has(key)) continue;
		files.add(key);
		for (const name of namesOf(key)) {
			if (name !== key) folders.add(name);
		}
		spelled(key);
	}
	// Every new path, also one that is refused: two new paths that collide
	// are both left, whatever else is wrong with either.
	const fresh = candidates.filter((send) => send.replaces === undefined);
	for (const send of fresh) spelled(send.key);

	const refused = new Map<string, PushRefusalReason>();
	for (const send of fresh) {
		const names = namesOf(send.key);
		if (names.some((name) => (spellings.get(name.toLowerCase())?.size ?? 0) > 1)) {
			refused.set(send.key, "case-collision");
		} else if (folders.has(send.key) || names.some((name) => name !== send.key && files.has(name))) {
			refused.set(send.key, "remote-in-the-way");
		}
	}
	return refused;
}

/** The path and every folder on the way to it. */
function namesOf(key: string): string[] {
	const names: string[] = [];
	for (let slash = key.indexOf("/"); slash !== -1; slash = key.indexOf("/", slash + 1)) {
		names.push(key.slice(0, slash));
	}
	names.push(key);
	return names;
}

/**
 * How a path that is new to the remote is spelled there. The folders the
 * remote already has keep the spelling it gives them: a folder it holds in
 * NFD would otherwise get a second folder of the same name in NFC beside
 * it. Everything below the deepest such folder, the name of the file
 * included, is in NFC, which is what git on a Mac writes.
 *
 * Folders are matched in NFC and with the cases told apart. A folder that
 * differs in case is not the same folder here; a path below it is refused
 * (`PushRefusalReason`).
 */
export function remoteSpelling(remote: readonly { readonly path: string }[]): (path: string) => string {
	const folders = new Map<string, string>();
	for (const entry of remote) {
		const { path } = entry;
		for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
			const folder = path.slice(0, slash);
			const key = pathKey(folder);
			const known = folders.get(key);
			// Where the remote spells one folder in two ways, the NFC one,
			// or else the first in order: the same one every time.
			if (known === undefined || (known !== key && (folder === key || folder < known))) folders.set(key, folder);
		}
	}
	return (path) => {
		const key = pathKey(path);
		for (let slash = key.lastIndexOf("/"); slash !== -1; slash = key.lastIndexOf("/", slash - 1)) {
			const folder = folders.get(key.slice(0, slash));
			if (folder !== undefined) return folder + key.slice(slash);
		}
		return key;
	};
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
