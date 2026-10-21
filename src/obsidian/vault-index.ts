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

import type { App } from "obsidian";
import type { VaultIndex } from "../core/light-scan";

/**
 * The app's own index of the vault, for the light check: every file it
 * holds in memory, with the time and the size it last saw. Nothing is asked
 * of the disk. What is done with it is decided in `core/light-scan.ts`.
 */
export function vaultIndexOf(app: App): VaultIndex {
	return {
		indexedFiles: () =>
			app.vault.getFiles().map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size })),
	};
}
