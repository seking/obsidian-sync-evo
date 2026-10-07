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

// The words for a pull: its progress, how it ended, and what the user has to
// know of it. A pull answers with what happened and no text; whoever shows
// it only puts these texts on the screen.

import { BackendError, type BackendErrorKind } from "./backend";
import type { Translate } from "./i18n";
import { NOTICE_KINDS, type NoticeKind, type NoticeRef } from "./notices";
import type { DeferReason, PullConflict, PullProgress, PullResult } from "./pull-io";
import { type DeviceSettings, parseRepository } from "./settings";

/** How many paths a confirmation lists before it only counts them. */
export const CONFIRM_LIST_LIMIT = 50;

/** How many paths a notice lists. A notice is small, and on a phone it covers the note. */
export const NOTICE_LIST_LIMIT = 5;

export interface CappedList<T> {
	readonly shown: readonly T[];
	/** How many were left out. */
	readonly more: number;
}

export function capList<T>(items: readonly T[], limit: number): CappedList<T> {
	const shown = items.slice(0, Math.max(limit, 0));
	return { shown, more: items.length - shown.length };
}

/** Lines of text, one per item, with the count of what was left out as the last one. */
export function listText(t: Translate, lines: readonly string[], limit = NOTICE_LIST_LIMIT): string {
	const { shown, more } = capList(lines, limit);
	return [...shown, ...(more > 0 ? [t("list.more", { count: more })] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// While it runs

/** The one line of progress, with a second one while views are closed. */
export function pullProgressText(t: Translate, progress: PullProgress): string {
	const { done, total } = progress;
	let text: string;
	switch (progress.phase) {
		case "listing":
			text = t("pull.progress.listing");
			break;
		case "scanning":
			text = t("pull.progress.scanning");
			break;
		case "hashing":
			text = total > 0 ? t("pull.progress.hashing", { done, total }) : t("pull.progress.scanning");
			break;
		case "applying":
			text = total > 0 ? t("pull.progress.applying", { done, total }) : t("pull.progress.applyingStart");
			break;
	}
	return progress.closedViews ? `${text}\n${t("pull.progress.graphClosed")}` : text;
}

// ---------------------------------------------------------------------------
// When it could not be carried out

/**
 * The reason for a failure, by its kind. What the token, the repository, or
 * the network can have wrong reads the same as in the test of the
 * connection, so those texts are the same ones.
 */
export function failureReason(t: Translate, settings: DeviceSettings, error: unknown): string {
	const parsed = parseRepository(settings.repository);
	const repository = parsed === null ? settings.repository.trim() : `${parsed.owner}/${parsed.repo}`;
	const branch = settings.branch.trim();
	const detail = error instanceof Error ? error.message : String(error);
	const kind: BackendErrorKind = error instanceof BackendError ? error.kind : "other";

	switch (kind) {
		case "unauthorized":
			return t("check.unauthorized");
		case "forbidden":
			return t("check.forbidden", { repository });
		case "not-found":
			return t("check.notFound", { repository });
		case "branch-not-found":
			return t("check.branchNotFound", { repository, branch });
		case "unreachable":
			return t("check.unreachable");
		case "rate-limited":
			return t("check.rateLimited");
		case "incomplete-listing":
			return t("pull.error.incompleteListing");
		// A pull sends nothing, so the first is not expected. The detail is
		// in English and for developers, but it is all there is to go on.
		// No `default`: a kind added later fails the type check here.
		case "workflows-permission":
		case "cancelled":
		case "other":
			return t("pull.error.other", { detail });
	}
}

function isCancellation(error: unknown): boolean {
	return error instanceof BackendError && error.kind === "cancelled";
}

/** The text for a pull that ended by throwing. */
export function pullFailureText(t: Translate, settings: DeviceSettings, error: unknown): string {
	if (isCancellation(error)) return t("pull.cancelled");
	return t("pull.failed", { reason: failureReason(t, settings, error) });
}

/** Why there is no sync state to pull with: what `SyncState.open` answers instead of a store. */
export type StateProblem = "newer-version" | "no-app-id" | "no-indexeddb" | "open-failed" | "discard-failed";

export function stateProblemText(t: Translate, problem: StateProblem): string {
	switch (problem) {
		case "newer-version":
			return t("state.newerVersion");
		case "no-app-id":
			return t("state.noAppId");
		case "no-indexeddb":
			return t("state.noIndexedDb");
		case "open-failed":
			return t("state.openFailed");
		case "discard-failed":
			return t("state.discardFailed");
	}
}

// ---------------------------------------------------------------------------
// When it ended

export interface PullReport {
	/** How the pull ended, in a line. Shown like any passing message. */
	readonly summary: string;
	/**
	 * What the user has to know or act on, one message per matter. Meant to
	 * stay on the screen until it is dismissed.
	 */
	readonly details: readonly string[];
}

export interface PullReportOptions {
	/** The settings the pull ran with, for the names in the text of a failure. */
	readonly settings: DeviceSettings;
	/** The size limit the pull ran with, in bytes. */
	readonly sizeLimit: number;
}

// The reasons a file is put off that say something went wrong. The others
// are an editor in the middle of typing: the next sync takes the file, and
// there is nothing for the user to do or to know.
const FAILURES: readonly DeferReason[] = ["fetch-failed", "hash-mismatch", "unreadable"];

/** Words what a pull answered. */
export function pullReport(t: Translate, result: PullResult, options: PullReportOptions): PullReport {
	const details: string[] = [];

	if (result.conflicts.length > 0) {
		const lines = result.conflicts.map((conflict) => conflictLine(t, conflict));
		details.push(t("pull.conflicts", { count: lines.length, list: listText(t, lines, 10) }));
	}
	if (result.trashed.length > 0) {
		details.push(t("pull.trashed", { count: result.trashed.length, list: listText(t, result.trashed) }));
	}
	if (result.keptLocal.length > 0) {
		details.push(t("pull.keptLocal", { count: result.keptLocal.length, list: listText(t, result.keptLocal) }));
	}
	const failed = incompleteText(t, result, options.settings);
	if (failed !== null) details.push(failed);
	if (result.newSymlinks.length > 0) {
		details.push(t("pull.symlinks", { count: result.newSymlinks.length, list: listText(t, result.newSymlinks) }));
	}
	details.push(...noticeTexts(t, result, options.sizeLimit));

	return { summary: summaryText(t, result), details };
}

function summaryText(t: Translate, result: PullResult): string {
	if (result.outcome === "remote-empty") return t("pull.remoteEmpty");
	if (result.outcome === "declined") return t("pull.declined");
	if (result.outcome === "cancelled" || isCancellation(result.fetchError)) return t("pull.cancelled");

	const { fetched, deleted, renamed, conflicts } = result.counts;
	const parts: string[] = [];
	if (fetched > 0) parts.push(t("pull.count.fetched", { count: fetched }));
	if (deleted > 0) parts.push(t("pull.count.deleted", { count: deleted }));
	if (renamed > 0) parts.push(t("pull.count.renamed", { count: renamed }));
	if (conflicts > 0) parts.push(t("pull.count.conflicts", { count: conflicts }));
	if (parts.length > 0) return t("pull.summary", { details: parts.join(t("list.separator")) });
	// "Up to date" would not be true of a pull that left files for later,
	// or of one that kept files which differ from the remote.
	return result.outcome === "completed" && result.keptLocal.length === 0 ? t("pull.upToDate") : t("pull.done");
}

function conflictLine(t: Translate, conflict: PullConflict): string {
	const values = { copy: conflict.copyPath, path: conflict.path };
	switch (conflict.cause) {
		case "conflict":
			return t("pull.conflict.conflict", values);
		case "became-symlink":
			return t("pull.conflict.becameSymlink", values);
		case "became-folder":
			return t("pull.conflict.becameFolder", values);
		case "name-taken":
			return t("pull.conflict.nameTaken", values);
	}
}

/** The text for files left to the next sync because something failed, or `null` when nothing did. */
function incompleteText(t: Translate, result: PullResult, settings: DeviceSettings): string | null {
	if (isCancellation(result.fetchError)) return null;
	const failures = result.deferred.filter((file) => FAILURES.includes(file.reason));
	if (failures.length === 0 && result.fetchError === undefined) return null;

	let reason: string;
	if (result.fetchError !== undefined) reason = failureReason(t, settings, result.fetchError);
	else if (failures.some((file) => file.reason === "hash-mismatch")) reason = t("pull.reason.hashMismatch");
	else reason = t("pull.reason.unreadable");

	// With the files that only wait for one of these, which no step of
	// theirs failed for.
	const count = failures.length + result.deferred.filter((file) => file.reason === "depends-on-deferred").length;
	return count > 0 ? t("pull.incomplete", { count, reason }) : t("pull.incompleteSome", { reason });
}

/** The texts of the one-time notices: per kind, in the order of `NOTICE_KINDS`. */
function noticeTexts(t: Translate, result: PullResult, sizeLimit: number): string[] {
	const notices: readonly NoticeRef[] = result.notices;
	return NOTICE_KINDS.flatMap((kind) => {
		const paths = notices.filter((notice) => notice.kind === kind).map((notice) => notice.path);
		return paths.length === 0 ? [] : noticeText(t, kind, paths, sizeLimit, result);
	});
}

// A kind about one thing gets a text per path; a kind that can hold many
// paths gets one text that lists them. No `default`: a kind added later
// fails the type check here until it is given a text.
function noticeText(
	t: Translate,
	kind: NoticeKind,
	paths: readonly string[],
	sizeLimit: number,
	result: PullResult,
): string[] {
	const list = listText(t, paths);
	switch (kind) {
		case "own-folder-on-remote":
			return paths.map((path) => t("notice.ownFolderOnRemote", { path }));
		case "git-at-root":
			return [t("notice.gitAtRoot")];
		case "remote-path-collision":
			return [t("notice.remotePathCollision", { list })];
		case "too-large":
			return [t("notice.tooLarge", { limit: megabytes(sizeLimit), list })];
		case "lfs-pointer":
			return [t("notice.lfsPointer", { list })];
		case "invalid-path":
			return [t("notice.invalidPath", { list })];
		case "plugin-not-listed":
			return paths.map((path) => t("notice.pluginNotListed", { path }));
		case "unwritable-path":
			return [t("notice.unwritablePath", { list })];
		case "blocked-path":
			// One text per remote file: each has its own files in its place.
			return paths.map((path) => {
				const blocked = result.unwritable.find((entry) => entry.reason === "blocked" && entry.path === path);
				return t("notice.blockedPath", { path, list: listText(t, blocked?.inTheWay ?? []) });
			});
	}
}

function megabytes(bytes: number): string {
	const value = bytes / (1024 * 1024);
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
