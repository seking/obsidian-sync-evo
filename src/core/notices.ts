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

// The memory of what the user has been told. Some things are worth saying
// once and are a nuisance on every sync after that: each is a pair of a kind
// and a path, shown the first time it applies and remembered for as long as
// it does. Once it no longer applies it is forgotten, so that it is shown
// again if it ever comes back.

import type { StateStore } from "./state";

/**
 * - "own-folder-on-remote": the remote holds the plugin's own folder, which
 *   is never synced.
 * - "git-at-root": the vault root has a `.git`, so this device should be
 *   synced with git instead.
 *
 * A new kind is a new name here and a text in the catalog.
 */
export const NOTICE_KINDS = ["own-folder-on-remote", "git-at-root"] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export interface NoticeRef {
	readonly kind: NoticeKind;
	/** The path the notice is about, from the vault root. */
	readonly path: string;
}

export interface NoticeUpdate {
	/** What applies now and was not remembered: to be shown, once. */
	readonly show: readonly NoticeRef[];
	/** Everything that applies now: what to remember from here on. */
	readonly remember: readonly NoticeRef[];
}

/**
 * Compares what applies now with what was remembered. The same pair given
 * twice counts once. `remember` is also the list a settings screen shows,
 * which is always everything that applies.
 */
export function reconcileNotices(remembered: readonly NoticeRef[], current: readonly NoticeRef[]): NoticeUpdate {
	const before = new Set(remembered.map(pairId));
	const seen = new Set<string>();
	const show: NoticeRef[] = [];
	const remember: NoticeRef[] = [];
	for (const notice of current) {
		const id = pairId(notice);
		if (seen.has(id)) continue;
		seen.add(id);
		remember.push({ kind: notice.kind, path: notice.path });
		if (!before.has(id)) show.push({ kind: notice.kind, path: notice.path });
	}
	return { show, remember };
}

// No kind has a line break in it, so two different pairs never share an id.
function pairId(notice: NoticeRef): string {
	return `${notice.kind}\n${notice.path}`;
}

/** The key of the remembered notices among the other values (`getMeta`). */
export const NOTICES_KEY = "notices";

/**
 * The remembered notices. Anything stored that is not a pair of a known kind
 * and a path is left out: the worst that follows is one notice shown a
 * second time. A kind remembered by a newer version is such a thing.
 */
export async function readNotices(store: Pick<StateStore, "getMeta">): Promise<NoticeRef[]> {
	const value = await store.getMeta(NOTICES_KEY);
	if (!Array.isArray(value)) return [];
	const notices: NoticeRef[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const { kind, path } = item as { kind?: unknown; path?: unknown };
		const known = NOTICE_KINDS.find((name) => name === kind);
		if (known !== undefined && typeof path === "string") notices.push({ kind: known, path });
	}
	return notices;
}

/** Stores `remember` of a `NoticeUpdate`. Field by field, so that nothing else an object carries is stored. */
export function writeNotices(store: Pick<StateStore, "setMeta">, notices: readonly NoticeRef[]): Promise<void> {
	return store.setMeta(
		NOTICES_KEY,
		notices.map(({ kind, path }) => ({ kind, path })),
	);
}
