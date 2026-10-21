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

// How the links of the vault are told on a desktop, given Node's `fs` and
// the folder of the vault on disk. Kept apart from `pull-vault.ts` so that
// nothing here imports `obsidian`, and the tests can run it on a real disk.

import { fromRoot } from "../core/scan";
import type { VaultPorts } from "../core/vault-access";

/**
 * The little of Node's `fs` that tells a link (a symbolic link, or a
 * junction on Windows) from what it points to.
 */
export interface LinkFs {
	readonly promises: {
		readdir(path: string, options: { withFileTypes: true }): Promise<readonly LinkFsEntry[]>;
		lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
		stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
	};
}

/** One name a folder lists (`Dirent`). */
export interface LinkFsEntry {
	readonly name: string;
	isSymbolicLink(): boolean;
	isFile(): boolean;
	isDirectory(): boolean;
}

// How the app's listing spells a path it returns: its non-breaking spaces as
// spaces, in NFC.
function spelledAsListed(path: string): string {
	return path.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

/**
 * Listed entries that say they are links are asked again with `lstat`. On
 * Windows a listing also says so of other reparse points, such as a file a
 * cloud drive keeps online only; `lstat` says so of symbolic links and
 * junctions alone.
 *
 * `base` is the folder of the vault on disk; the root of the vault is
 * given as `/` or as the empty path.
 */
export function linkPorts(
	fs: LinkFs,
	base: string,
): Required<Pick<VaultPorts<unknown>, "linksIn" | "isLink" | "listOnDisk">> {
	const isRoot = (path: string): boolean => path === "/" || path === "";
	const inVault = (path: string): string => (isRoot(path) ? base : `${base}/${path}`);
	const isLink = async (path: string): Promise<boolean> => (await fs.promises.lstat(inVault(path))).isSymbolicLink();
	return {
		linksIn: async (folder) => {
			const links: string[] = [];
			for (const entry of await fs.promises.readdir(inVault(folder), { withFileTypes: true })) {
				if (!entry.isSymbolicLink()) continue;
				const path = isRoot(folder) ? entry.name : `${folder}/${entry.name}`;
				if (await isLink(path)) links.push(path);
			}
			return links;
		},
		// Nothing at the path is no link.
		isLink: (path) => isLink(path).catch(() => false),
		// What the app's listing returns (`FileSystemAdapter.list`), but for
		// a link whose target cannot be reached, which is left out: that
		// listing asks each name for what it points to, and fails at such a
		// link. Each name is taken as the folder lists it, and only a link is
		// asked what it points to; what is neither a file nor a folder is left
		// out, as the app's listing leaves it out.
		listOnDisk: async (folder) => {
			const files: string[] = [];
			const folders: string[] = [];
			const at = inVault(folder);
			for (const entry of await fs.promises.readdir(at, { withFileTypes: true })) {
				const path = spelledAsListed(isRoot(folder) ? entry.name : `${fromRoot(folder)}/${entry.name}`);
				let kind: { isFile(): boolean; isDirectory(): boolean } = entry;
				if (entry.isSymbolicLink()) {
					try {
						kind = await fs.promises.stat(`${at}/${entry.name}`);
					} catch (error) {
						// On Windows a listing says "link" of other reparse
						// points too, such as a file a cloud drive keeps
						// online only. Only a link is left out.
						const link = await fs.promises
							.lstat(`${at}/${entry.name}`)
							.then((stat) => stat.isSymbolicLink())
							.catch(() => false);
						if (link) continue;
						throw error;
					}
				}
				if (kind.isFile()) files.push(path);
				else if (kind.isDirectory()) folders.push(path);
			}
			return { files, folders };
		},
	};
}
