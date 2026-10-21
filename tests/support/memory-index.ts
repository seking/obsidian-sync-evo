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

import type { IndexedFile, VaultIndex } from "../../src/core/light-scan";
import type { MemoryPullVault } from "./memory-pull-vault";

/**
 * The app's index of a vault, in memory. Like the real one it holds no path
 * with a name that starts with a `.`, and it is only as fresh as the last
 * time it looked: `follow` makes it look at every call, which is the app
 * hearing of every change, and a test that wants it behind the disk turns
 * that off or bends single files with `set` and `drop`.
 */
export class MemoryIndex implements VaultIndex {
	/** How many times the index was asked for its files. */
	asked = 0;
	follow = true;
	private files = new Map<string, IndexedFile>();

	constructor(private readonly vault: MemoryPullVault) {
		this.refresh();
	}

	/** Looks at the vault, as the app does when it hears of a change. */
	refresh(): void {
		this.files = new Map();
		for (const file of this.vault.stats()) {
			if (file.path.split("/").some((name) => name.startsWith("."))) continue;
			this.files.set(file.path, file);
		}
	}

	/** What the index says of a file, whatever the disk holds. */
	set(path: string, mtime: number, size: number): void {
		this.follow = false;
		this.files.set(path, { path, mtime, size });
	}

	/** The index no longer lists the file, whatever the disk holds. */
	drop(path: string): void {
		this.follow = false;
		this.files.delete(path);
	}

	indexedFiles(): IndexedFile[] {
		this.asked += 1;
		if (this.follow) this.refresh();
		return [...this.files.values()];
	}
}
