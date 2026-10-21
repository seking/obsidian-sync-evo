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

import type { RemoteEntry, SubmoduleSkip } from "../../src/core/backend";

/** A submodule of a remote in memory: where it points to, or why what is inside it is not listed. */
export type TestSubmodule =
	| { readonly repository: string; readonly revision: string }
	| { readonly repository?: string; readonly revision: string; readonly skipped: SubmoduleSkip };

/**
 * The entries of a remote in memory as a remote that lists its submodules
 * gives them. The files the remote holds below the path of a submodule
 * stand in for what the place it points to holds: they are listed with
 * that place as their source, or left out when the submodule is skipped.
 * Each submodule is an entry of its own, with the commit it points to.
 */
export function listSubmodules(
	entries: readonly RemoteEntry[],
	submodules: ReadonlyMap<string, TestSubmodule>,
): RemoteEntry[] {
	const listed: RemoteEntry[] = [];
	for (const entry of entries) {
		const above = [...submodules.keys()].find((path) => entry.path.startsWith(`${path}/`));
		const submodule = above === undefined ? undefined : submodules.get(above);
		if (above === undefined || submodule === undefined) listed.push(entry);
		else if (!("skipped" in submodule)) {
			listed.push({ ...entry, source: { submodule: above, repository: submodule.repository, revision: submodule.revision } });
		}
	}
	for (const [path, submodule] of submodules) {
		const { repository, revision } = submodule;
		listed.push({
			path,
			kind: "submodule",
			hash: revision,
			contents:
				"skipped" in submodule
					? { listed: false, reason: submodule.skipped, ...(repository === undefined ? {} : { repository }) }
					: { listed: true, repository: submodule.repository },
		});
	}
	return listed;
}
