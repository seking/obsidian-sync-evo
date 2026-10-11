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

// Graph views are closed while a first fetch writes: an open one is redrawn
// for every file that appears, which made 6,600 files take a quarter of an
// hour instead of a minute on a Mac. They are closed without asking and
// opened again when the pull ends, where they were as far as that place is
// still there.

import type { App, ViewState, WorkspaceItem, WorkspaceLeaf } from "obsidian";
import type { BeginBulkWrite, BulkWriteSession } from "../core/pull-io";

/**
 * The types of view that are closed. The graph of the whole vault only.
 *
 * TO BE MEASURED ON A MAC: whether an open local graph ("localgraph") slows
 * the writing in the same way. If it does, it is added here, and nothing
 * else changes.
 */
const CLOSED_VIEW_TYPES: readonly string[] = ["graph"];

interface ClosedView {
	readonly state: ViewState;
	readonly ephemeral: unknown;
	/** The group of tabs it was in. */
	readonly parent: WorkspaceItem | null;
	/** Its place among the tabs of that group; -1 when that could not be told. */
	readonly index: number;
}

/**
 * The items a group of tabs holds, in their order. `children` is not part
 * of the public API, so anything else than a list counts as not known.
 */
function childrenOf(parent: WorkspaceItem): readonly unknown[] | null {
	const children = (parent as { children?: unknown }).children;
	return Array.isArray(children) ? (children as unknown[]) : null;
}

/** For `BeginBulkWrite`. Never rejects: writing with the views open is slow, not wrong. */
export function graphViewPause(app: App): BeginBulkWrite {
	return async () => closeGraphViews(app);
}

function closeGraphViews(app: App): BulkWriteSession {
	const closed: ClosedView[] = [];
	try {
		// Every window: a view moved out to a window of its own is listed too.
		const leaves = CLOSED_VIEW_TYPES.flatMap((type) => app.workspace.getLeavesOfType(type));
		for (const leaf of leaves) {
			try {
				const parent: WorkspaceItem | null = leaf.parent ?? null;
				closed.push({
					state: leaf.getViewState(),
					ephemeral: leaf.getEphemeralState() as unknown,
					parent,
					index: parent === null ? -1 : (childrenOf(parent)?.indexOf(leaf) ?? -1),
				});
				leaf.detach();
			} catch {
				// One view that does not close leaves the others to be closed.
			}
		}
	} catch {
		// Nothing was closed, or only some. What was is still reopened.
	}

	let restored = false;
	return {
		closedViews: closed.length > 0,
		// Only what was closed here is opened again. A graph view the user
		// opened in the meantime is not touched, at the start or at the end.
		restore: async () => {
			if (restored) return;
			restored = true;
			for (const view of closed) {
				try {
					await reopen(app, view);
				} catch {
					// A view that does not reopen is in the menu, and holds nothing.
				}
			}
		},
	};
}

async function reopen(app: App, view: ClosedView): Promise<void> {
	const leaf = leafAtOldPlace(app, view) ?? app.workspace.getLeaf("split");
	// Not made the active tab: the user is somewhere else by now.
	await leaf.setViewState({ ...view.state, active: false }, view.ephemeral);
}

/**
 * A new tab where the view was, or `null` when its group of tabs is gone:
 * a group is removed with its last tab, and a window with its last group.
 */
function leafAtOldPlace(app: App, view: ClosedView): WorkspaceLeaf | null {
	const parent = view.parent;
	if (parent === null || view.index < 0) return null;
	let attached = false;
	app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.parent === parent) attached = true;
	});
	if (!attached) return null;
	try {
		const count = childrenOf(parent)?.length ?? view.index;
		// Typed for a split, but it is a group of tabs that takes a leaf.
		return app.workspace.createLeafInParent(parent, Math.min(view.index, count));
	} catch {
		return null;
	}
}
