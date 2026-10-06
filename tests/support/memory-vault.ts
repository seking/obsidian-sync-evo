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

import type { FolderLister } from "../../src/core/scan";

/**
 * The files of a vault, in memory, listed the way the data adapter of the
 * app lists them: one folder at a time, names that start with a `.`
 * included, every path from the vault root. It can only list. `listed`
 * holds every folder that was asked for, in order.
 */
export class MemoryVault implements FolderLister {
	readonly listed: string[] = [];
	private readonly files: readonly string[];
	private readonly prefix: string;

	/** `prefix` is put in front of every path returned, for a lister that names the root. */
	constructor(files: readonly string[], prefix = "") {
		this.files = files;
		this.prefix = prefix;
	}

	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		this.listed.push(folder);
		const inside = folder === "/" ? "" : `${folder}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const file of this.files) {
			if (!file.startsWith(inside)) continue;
			const slash = file.indexOf("/", inside.length);
			if (slash === -1) files.push(this.prefix + file);
			else folders.add(this.prefix + file.slice(0, slash));
		}
		return { files, folders: [...folders] };
	}
}
