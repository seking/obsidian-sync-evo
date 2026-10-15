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

// How the links of the vault are told on a desktop, given Node's `fs` and
// the folder of the vault on disk. Kept apart from `pull-vault.ts` so that
// nothing here imports `obsidian`, and the tests can run it on a real disk.

import type { VaultPorts } from "../core/vault-access";

/**
 * The little of Node's `fs` that tells a link (a symbolic link, or a
 * junction on Windows) from what it points to.
 */
export interface LinkFs {
	readonly promises: {
		readdir(
			path: string,
			options: { withFileTypes: true },
		): Promise<readonly { readonly name: string; isSymbolicLink(): boolean }[]>;
		lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
	};
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
export function linkPorts(fs: LinkFs, base: string): Required<Pick<VaultPorts<unknown>, "linksIn" | "isLink">> {
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
	};
}
