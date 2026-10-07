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

// The question before a first fetch: what the vault already holds that the
// remote does not hold in the same way, and whether the user has been asked.
//
// A device whose sync state has no base revision has never synced with the
// connection it has now to the end. Files that are in the vault then are not
// known to belong to that remote: the vault may be another one, or the
// connection may have been pointed elsewhere. So the user is shown what is
// there before the first sync goes on, once. Nothing here asks; it only
// counts and remembers, so that a pull and a push can ask the same question
// and share the one answer.

import type { PullPlan } from "./pull-plan";
import type { StateStore } from "./state";

/**
 * The key, among the other values of the sync state, of the answer "yes" to
 * the question before a first fetch. Also set by a first fetch that got to
 * the end without having had to ask: unset, it says that no first fetch has
 * finished. It goes with the sync state when that is discarded, and with
 * nothing else: a remote that became empty takes the base revision away,
 * and not this.
 */
export const FIRST_FETCH_CONFIRMED_KEY = "first-fetch-confirmed";

/** Vault files a first fetch is asked about, as they are spelled in the vault. Each list is sorted. */
export interface FirstFetchFiles {
	/**
	 * Files the remote does not hold. A pull leaves them as they are; a
	 * later push sends them.
	 */
	readonly localOnly: readonly string[];
	/**
	 * Files that are kept under the name of a conflict copy: the remote
	 * holds other content at the path, or files below it, or the name the
	 * file would get from a spelling of the remote is taken. No path here is
	 * also in `localOnly`.
	 */
	readonly different: readonly string[];
	/**
	 * Files at a path the remote holds as a symlink. They are not compared,
	 * not a conflict, and never sent. Shown, but no reason to ask.
	 */
	readonly atSymlinks: readonly string[];
}

/**
 * What a plan says about the files the vault already holds. A path that is
 * excluded (the plugin's own folder among them) is in none of the lists: the
 * sync decision turns it away before anything is planned for it.
 *
 * Meant for a plan made without a base revision. It reads any plan, so that
 * a first fetch that resumes, with the records of what it wrote, counts what
 * is left the same way.
 */
export function firstFetchFiles(plan: PullPlan): FirstFetchFiles {
	// A set: one file can be named by more than one step of the plan.
	const different = new Set<string>();
	for (const write of plan.writes) {
		if (write.type !== "conflict") continue;
		// A file that is renamed first is shown under the name it has now.
		const rename = write.afterRename ? plan.renames.find((entry) => entry.key === write.key) : undefined;
		different.add((rename?.step === "rename" ? rename.from : write.local).path);
	}
	// A file where the remote has a folder is moved to the name of a copy
	// too.
	for (const aside of plan.asides) different.add(aside.local.path);
	// So are the files that are in the way of a name the remote spells in
	// another case. The first two take a record, which only a first fetch
	// that resumes has; the third needs none.
	for (const rename of plan.renames) {
		// The file under the old spelling, edited, where the vault already
		// holds the remote content under the new one.
		if (rename.step === "old-aside") different.add(rename.from.path);
		// Another file at the new spelling, which makes way for the renamed one.
		if (rename.step === "rename" && rename.occupant?.sameAsRemote === false) {
			different.add(rename.occupant.local.path);
		}
	}
	// A file that follows its folder to the new spelling and finds its name
	// taken there.
	for (const stray of plan.strays) {
		if (stray.aside) different.add(stray.local.path);
	}

	const localOnly: string[] = [];
	for (const action of plan.pushOnly) {
		// An upload of a path the remote holds is an edit of a file that was
		// synced, not a file that is only here.
		if (action.type !== "upload" || action.remote !== undefined) continue;
		// The remote does not hold it, but it does not stay as it is either:
		// told once, as a file that is kept under another name.
		if (!different.has(action.local.path)) localOnly.push(action.local.path);
	}

	const atSymlinks = plan.symlinks.flatMap((link) => link.local.map((entry) => entry.path));
	return { localOnly: localOnly.sort(), different: [...different].sort(), atSymlinks: atSymlinks.sort() };
}

/**
 * Whether there is something to ask about. A vault that holds nothing of
 * its own (an empty one, or one whose files are all the remote's) is not
 * asked; files at the path of a symlink alone are no reason either.
 *
 * Files in the configuration folder alone are no reason: Obsidian writes
 * a few there when it creates a vault, so a vault that is new would always
 * be asked. They are still among the files shown when something else is.
 */
export function hasFirstFetchQuestion(files: FirstFetchFiles, configDir: string): boolean {
	const config = `${configDir.replace(/^\/+|\/+$/g, "")}/`;
	return [...files.localOnly, ...files.different].some((path) => !path.startsWith(config));
}

export async function isFirstFetchConfirmed(store: Pick<StateStore, "getMeta">): Promise<boolean> {
	return (await store.getMeta(FIRST_FETCH_CONFIRMED_KEY)) === true;
}

/**
 * Stored before anything is changed, so that a first fetch that stops halfway
 * goes on without asking again; and by a first fetch that had nothing to ask,
 * once it is done, so that a later sync without a base revision (the remote
 * was emptied) is not taken for a first one.
 */
export function markFirstFetchConfirmed(store: Pick<StateStore, "setMeta">): Promise<void> {
	return store.setMeta(FIRST_FETCH_CONFIRMED_KEY, true);
}
