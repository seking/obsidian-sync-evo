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

// That a push was begun and did not get to its end. The user is told when
// it fails; this is for telling it once more when the app starts, to
// someone who closed it thinking the push had gone through. Nothing is
// sent again because of it: the next sync the user starts sends what the
// vault holds then.
//
// Set when a push begins, and not only when one fails, so that a push the
// app was closed under leaves it too.

import type { StateStore } from "./state";

/** The key, among the other values of the sync state, of a push that did not get to its end. */
export const PUSH_FAILURE_KEY = "push-failure";

/** The value under `PUSH_FAILURE_KEY`. */
export interface PushFailure {
	/** When that push began, on the clock of the device. */
	readonly at: number;
}

export function markPushFailure(store: Pick<StateStore, "setMeta">, at: number): Promise<void> {
	return store.setMeta(PUSH_FAILURE_KEY, { at });
}

export function clearPushFailure(store: Pick<StateStore, "deleteMeta">): Promise<void> {
	return store.deleteMeta(PUSH_FAILURE_KEY);
}

/** `null` for nothing, and for anything that cannot be read. */
export async function readPushFailure(store: Pick<StateStore, "getMeta">): Promise<PushFailure | null> {
	const value = await store.getMeta(PUSH_FAILURE_KEY);
	if (typeof value !== "object" || value === null) return null;
	const { at } = value as Record<string, unknown>;
	return typeof at === "number" ? { at } : null;
}

/** Puts back what `readPushFailure` answered before a push that the user ended: that one is no failure. */
export function restorePushFailure(
	store: Pick<StateStore, "setMeta" | "deleteMeta">,
	before: PushFailure | null,
): Promise<void> {
	return before === null ? clearPushFailure(store) : markPushFailure(store, before.at);
}
