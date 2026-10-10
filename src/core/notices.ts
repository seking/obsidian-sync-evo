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
 * - "remote-path-collision": the remote holds this path beside another that
 *   differs only in upper and lower case, or only in normalization. Neither
 *   is written. One notice per spelling.
 * - "too-large": a file over the size limit, which is not fetched or sent.
 * - "lfs-pointer": the file is a Git LFS pointer. It is synced as it is;
 *   what it points to is not fetched.
 * - "invalid-path": a path of the remote that is not a path below the root.
 * - "plugin-not-listed": the `community-plugins.json` a pull just wrote
 *   does not list this plugin, so the app will not load it the next time it
 *   starts. The one kind that is never remembered: it is about a write,
 *   not about a state, and is told every time such a file is written.
 * - "unwritable-path": the vault refuses to write a path of the remote (a
 *   name the device does not allow, for one), or to take away a file the
 *   remote deleted, or to move a file that is in the way of the remote's;
 *   the path is then the vault's where no path of the remote stands for
 *   it. It is tried again by every pull, and told once for as long as it
 *   keeps failing.
 * - "blocked-path": a file of the remote is not written because files that
 *   are only in the vault are in its place. Told once for as long as that
 *   is so.
 * - "archive-given-up": this device remembers not to fetch many files at
 *   once (`archive-fetch.ts`), and fetches them one at a time from now on.
 *   About the device and no path: its path is empty. Told once, by the pull
 *   that finds it so, and not again for as long as the sync state lasts.
 * - "archive-limited": this device remembers an estimate from which on it
 *   does not fetch many files at once (`archive-fetch.ts`). Its path is that
 *   estimate, in bytes, so that it is told again when it comes down. Not
 *   told beside "archive-given-up".
 * - "local-path-collision": a file that is new on this device was not sent,
 *   because its path differs only in upper and lower case from another
 *   path the remote holds or the same push sends. Told once for as long as
 *   that is so. Found by a push alone (`PUSH_NOTICE_KINDS`).
 * - "rename-not-sent": a file was renamed on this device in upper and lower
 *   case alone, and the new spelling is not sent, so the old one was not
 *   deleted on the remote either. The path is the new one. Found by a push
 *   alone.
 *
 * A new kind is a new name here and a text in the catalog.
 */
export const NOTICE_KINDS = [
	"own-folder-on-remote",
	"git-at-root",
	"remote-path-collision",
	"too-large",
	"lfs-pointer",
	"invalid-path",
	"plugin-not-listed",
	"unwritable-path",
	"blocked-path",
	"archive-given-up",
	"archive-limited",
	"local-path-collision",
	"rename-not-sent",
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * The kinds only a push finds out about. A push works out which of them
 * apply and leaves the others as they are remembered; a pull does the
 * reverse. "too-large" is found by both, from the same plan.
 */
export const PUSH_NOTICE_KINDS: readonly NoticeKind[] = ["local-path-collision", "rename-not-sent"];

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
