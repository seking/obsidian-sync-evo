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

// Who may be at the root `.gitignore`: a sync, or the settings screen, and
// never both. A pull writes the file and a push reads it as rules and adds
// the section to it; the settings read it, change one thing, and write it
// back. Between that reading and that writing no sync may begin, and under
// a sync nothing of the settings may write.

export type GitignoreEdit<T> =
	| { readonly status: "done"; readonly value: T }
	/** A sync is running. The work was not begun. */
	| { readonly status: "syncing" };

/**
 * The one mark of it. Whoever starts the syncs holds it (`SyncRunner`), so
 * that there is no second place that could say otherwise.
 */
export class GitignoreGate {
	private syncing = false;
	// Resolves when every piece of work taken so far has ended, one way or
	// the other. Never rejects.
	private last: Promise<void> = Promise.resolve();

	/**
	 * A sync begins: from here on no work of the settings is taken. Resolves
	 * when the work taken before has ended, which the sync waits for before
	 * it touches anything. That work is a read and a write of one small file,
	 * so the wait is short, and the sync is not turned away for it.
	 */
	beginSync(): Promise<void> {
		this.syncing = true;
		return this.last;
	}

	/** The sync has ended, however it ended. */
	endSync(): void {
		this.syncing = false;
	}

	/** Resolves when the work taken so far has ended. */
	idle(): Promise<void> {
		return this.last;
	}

	/**
	 * Runs work of the settings on the file, unless a sync is running. One
	 * piece of work at a time, in the order they were asked for: two switches
	 * flipped one right after the other each read what the other wrote. What
	 * the work throws is thrown from here.
	 */
	edit<T>(work: () => Promise<T>): Promise<GitignoreEdit<T>> {
		if (this.syncing) return Promise.resolve({ status: "syncing" });
		const ran = this.last.then(work);
		this.last = ran.then(
			() => undefined,
			() => undefined,
		);
		return ran.then((value) => ({ status: "done", value }));
	}
}
