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

// The memory of what the user has been told. Some things are worth saying
// once and are a nuisance on every sync after that: each is a pair of a kind
// and a path, shown the first time it applies and remembered for as long as
// it does. Once it no longer applies it is forgotten, so that it is shown
// again if it ever comes back.

import type { EntryKind, RemoteEntry } from "./backend";
import {
	type Exclusion,
	type ExclusionPaths,
	fixedExclusionsOff,
	nestedGitignores,
	unsyncedSubmodules,
} from "./exclusion";
import type { SkippedPath } from "./plan";
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
 * - "nested-gitignore": a `.gitignore` below the root, on the remote or in
 *   the vault. It is synced as a file, and its rules are not read, unlike in
 *   git on a Mac. The path is that file's. Not told for one a rule matches,
 *   or one below a submodule (`nestedGitignores`).
 * - "fixed-exclusion-off": a fixed exclusion of the section in the root
 *   `.gitignore` is not in effect (`fixedExclusionsOff`), so what it is
 *   there to leave out is synced. Its path is no path: it is the line, as
 *   the default section writes it.
 * - "submodule": the remote holds a submodule whose inside cannot be read
 *   at all: it points to another host, `.gitmodules` says nothing of it,
 *   it is inside another submodule, or it holds too much to be listed.
 *   What is on this device below it stays as it is. The path is the
 *   submodule's. Not told for one a rule matches (`unsyncedSubmodules`),
 *   like the two kinds that follow. Found by a pull alone, from the
 *   listing.
 * - "submodule-no-access": the repository a submodule points to is out of
 *   sight of the credentials. The path is the submodule's with the
 *   repository after it (`submoduleNotices`).
 * - "submodule-no-commit": the repository a submodule points to does not
 *   hold the commit it points to. The path is as for "submodule-no-access".
 * - "submodule-not-sent": a file below a submodule was edited, added, or
 *   deleted on this device. What is below a submodule is only read, so the
 *   change is not sent and stays on this device alone. The path is the
 *   file's. Told once for as long as that is so.
 * - "local-link": a link of the vault (a symbolic link, or a junction on
 *   Windows), which is not synced, nor what lies below it
 *   (`ScanResult.links`). The path is the link's. Found on a desktop
 *   alone, by a scan or a light check.
 * - "renaming-left": a rename of a change of case alone, made in two calls
 *   where the platform refuses it in one (`RoutedVault.rename`), stopped
 *   between the two, and the name it was left at could not be given back
 *   (`settleRenamings` in `pull.ts`): something else has the name, or the
 *   vault refused. Not synced under that name, and what the remote and the
 *   records have at the name waits. The path is the one it was left at.
 *   Found by a pull alone, which tries it again every time. Not told of a
 *   name of the user's that happens to end so.
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
	"nested-gitignore",
	"fixed-exclusion-off",
	"submodule",
	"submodule-no-access",
	"submodule-no-commit",
	"submodule-not-sent",
	"local-link",
	"renaming-left",
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * The kinds only a push finds out about. A push works out which of them
 * apply and leaves the others as they are remembered; a pull does the
 * reverse. Some are found by both (`SHARED_NOTICE_KINDS`).
 */
export const PUSH_NOTICE_KINDS: readonly NoticeKind[] = ["local-path-collision", "rename-not-sent"];

/**
 * The kinds a pull and a push both find out about, each from what it has
 * looked at itself: the listing of the remote, the scan of the vault, and
 * the rules. Whichever runs works them out anew, so that a device that only
 * ever pulls is told, and one that only ever pushes.
 */
export const SHARED_NOTICE_KINDS: readonly NoticeKind[] = [
	"too-large",
	"nested-gitignore",
	"fixed-exclusion-off",
	"submodule-not-sent",
	"local-link",
];

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

/**
 * The notices that follow from the rules: the `.gitignore` files below the
 * root, and the fixed exclusions that are not in effect. Made the same way
 * by a pull and by a push (`SHARED_NOTICE_KINDS`). `remote` is the listing
 * and `local` the paths the scan found.
 */
export function ruleNotices(
	exclusion: Exclusion,
	paths: ExclusionPaths,
	remote: readonly { readonly path: string; readonly kind: EntryKind }[],
	local: readonly string[],
): NoticeRef[] {
	return [
		...nestedGitignores(exclusion, remote, local).map((path): NoticeRef => ({ kind: "nested-gitignore", path })),
		...fixedExclusionsOff(exclusion, paths).map((line): NoticeRef => ({ kind: "fixed-exclusion-off", path: line })),
	];
}

/**
 * The notices of the submodules of a listing whose inside is not in it, each
 * by the reason. Not for one a rule matches (`unsyncedSubmodules`). Where
 * the repository is what the user has to look at, it follows the path.
 */
export function submoduleNotices(exclusion: Exclusion, remote: readonly RemoteEntry[]): NoticeRef[] {
	const told = new Set(unsyncedSubmodules(exclusion, remote));
	const notices: NoticeRef[] = [];
	for (const entry of remote) {
		if (entry.kind !== "submodule" || !told.has(entry.path)) continue;
		const { contents } = entry;
		if (contents?.listed === true) continue;
		const reason = contents?.reason;
		if (reason !== "no-access" && reason !== "no-commit") {
			notices.push({ kind: "submodule", path: entry.path });
			continue;
		}
		const path = contents?.repository === undefined ? entry.path : `${entry.path} (${contents.repository})`;
		notices.push({ kind: reason === "no-access" ? "submodule-no-access" : "submodule-no-commit", path });
	}
	return notices;
}

/**
 * The notices of what was changed below a submodule on this device and is
 * not sent (`SkipReason` "in-submodule"), named as the vault has the file,
 * or as the remote has it when the vault deleted it. Made the same way by a
 * pull and by a push.
 */
export function notSentNotices(
	skipped: readonly (Pick<SkippedPath, "key" | "remote" | "local" | "records"> & { readonly reason: string })[],
): NoticeRef[] {
	const notices: NoticeRef[] = [];
	for (const skip of skipped) {
		if (skip.reason !== "in-submodule") continue;
		const path = skip.local[0]?.path ?? skip.remote[0]?.path ?? skip.records[0]?.path ?? skip.key;
		notices.push({ kind: "submodule-not-sent", path });
	}
	return notices;
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
