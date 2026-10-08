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
import { type FetchLimitState, NO_FETCH_LIMIT } from "./fetch-quota";
import type { Translate } from "./i18n";
import { NOTICE_KINDS, type NoticeKind, type NoticeRef } from "./notices";
import type { DeferReason, FirstFetchRequest, PullConflict, PullProgress, PullResult } from "./pull-io";
import { type Connection, type DeviceSettings, parseRepository } from "./settings";

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
// Before a first fetch

/** A paragraph of a question, and the paths it is about. */
export interface QuestionPart {
	readonly text: string;
	/** Listed below the text, up to `CONFIRM_LIST_LIMIT`. */
	readonly paths?: CappedList<string>;
}

export interface FirstFetchQuestion {
	readonly title: string;
	readonly parts: readonly QuestionPart[];
	/** What "cancel" does. The last thing a question says. */
	readonly note: string;
}

/**
 * The words of the question before a first fetch: where it fetches from,
 * and what becomes of the files the vault already holds. When going on
 * discards the sync state, that is said first, and the question is worded
 * also when no file is listed.
 */
export function firstFetchQuestion(
	t: Translate,
	connection: Pick<Connection, "repository" | "branch">,
	request: FirstFetchRequest,
): FirstFetchQuestion {
	const { files, discardsState } = request;
	const target = { repository: connection.repository, branch: connection.branch };
	const parts: QuestionPart[] = [
		{ text: discardsState ? t("confirm.startOver.body", target) : t("confirm.firstFetch.body", target) },
	];
	const listed = (text: string, paths: readonly string[]): void => {
		parts.push({ text, paths: capList(paths, CONFIRM_LIST_LIMIT) });
	};

	if (files.different.length > 0) {
		listed(t("confirm.firstFetch.different", { count: files.different.length }), files.different);
	}
	if (files.localOnly.length > 0) {
		// T028: with a push, this is where the user is told that these
		// files are sent to the repository named above by the next push.
		listed(t("confirm.firstFetch.localOnly", { count: files.localOnly.length }), files.localOnly);
	}
	if (files.different.length + files.localOnly.length === 0) parts.push({ text: t("confirm.startOver.nothing") });
	if (files.atSymlinks.length > 0) {
		listed(t("confirm.firstFetch.atSymlinks", { count: files.atSymlinks.length }), files.atSymlinks);
	}

	return {
		title: discardsState ? t("confirm.startOver.title") : t("confirm.firstFetch.title"),
		parts,
		note: discardsState ? t("confirm.startOver.note") : t("confirm.delete.note"),
	};
}

// ---------------------------------------------------------------------------
// While it runs

/**
 * The one line of progress, with a line more while views are closed, and one
 * about the request limit while there is something to tell of it.
 */
export function pullProgressText(
	t: Translate,
	progress: PullProgress,
	limit: FetchLimitState = NO_FETCH_LIMIT,
): string {
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
			if (progress.archive === "waiting") text = t("pull.progress.archiveWaiting");
			else if (progress.archive !== undefined) text = t("pull.progress.downloadingArchive");
			else text = total > 0 ? t("pull.progress.applying", { done, total }) : t("pull.progress.applyingStart");
			break;
	}
	const lines = [text];
	if (progress.archive === "retrying") lines.push(t("pull.progress.archiveRetry"));
	if (limit.waitingUntil !== null) {
		lines.push(t("pull.progress.rateLimited", { time: clockTime(nextMinute(limit.waitingUntil)) }));
	} else if (limit.quota !== null) {
		const { fetchable, resumesAt } = limit.quota;
		lines.push(t("pull.progress.overQuota", { count: fetchable, time: clockTime(nextMinute(resumesAt)) }));
	}
	if (progress.closedViews) lines.push(t("pull.progress.graphClosed"));
	return lines.join("\n");
}

// A time is shown without its seconds. Rounded up, so that the time shown is
// never before the one that is waited for.
function nextMinute(time: number): number {
	return Math.ceil(time / 60_000) * 60_000;
}

/** The time of day on the device, to the minute, as "14:05". */
export function clockTime(time: number): string {
	const at = new Date(time);
	const two = (value: number): string => String(value).padStart(2, "0");
	return `${two(at.getHours())}:${two(at.getMinutes())}`;
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

/**
 * The text for a pull that ended by throwing. `connectionChanged`: whether
 * it was stopped because the connection it ran with was changed.
 */
export function pullFailureText(
	t: Translate,
	settings: DeviceSettings,
	error: unknown,
	connectionChanged = false,
): string {
	if (isCancellation(error)) return stoppedText(t, connectionChanged);
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

/** The text for a pull that was stopped. One stopped by a change of the connection has nothing to go on with. */
export function stoppedText(t: Translate, connectionChanged: boolean): string {
	return connectionChanged ? t("pull.connectionChanged") : t("pull.cancelled");
}

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
	/** Whether the pull was stopped because the connection it ran with was changed. */
	readonly connectionChanged?: boolean;
}

// The reasons a file is put off that say something went wrong. The others
// are an editor in the middle of typing: the next sync takes the file, and
// there is nothing for the user to do or to know.
const FAILURES: readonly DeferReason[] = ["fetch-failed", "hash-mismatch", "unreadable", "trash-failed"];

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
	if (result.halfWritten.length > 0) {
		const { halfWritten } = result;
		details.push(t("pull.halfWritten", { count: halfWritten.length, list: listText(t, halfWritten) }));
	}
	if (result.halfCopies.length > 0) {
		const { halfCopies } = result;
		details.push(t("pull.halfCopies", { count: halfCopies.length, list: listText(t, halfCopies) }));
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

	// With the summary and not a message of its own: it is nothing to act on.
	const summary = [summaryText(t, result, options.connectionChanged === true)];
	if (result.refetched > 0) summary.push(t("pull.refetched", { count: result.refetched }));
	return { summary: summary.join("\n"), details };
}

function summaryText(t: Translate, result: PullResult, connectionChanged: boolean): string {
	if (result.outcome === "remote-empty") return t("pull.remoteEmpty");
	if (result.outcome === "declined") {
		// What a pull that stopped left half written is moved away before
		// the question, so a "no" does not mean that nothing was changed.
		const moved = result.halfWritten.length + result.halfCopies.length > 0;
		return t(moved ? "pull.declinedAfterTrash" : "pull.declined");
	}
	const { fetched, deleted, renamed, conflicts } = result.counts;
	const parts: string[] = [];
	if (fetched > 0) parts.push(t("pull.count.fetched", { count: fetched }));
	if (deleted > 0) parts.push(t("pull.count.deleted", { count: deleted }));
	if (renamed > 0) parts.push(t("pull.count.renamed", { count: renamed }));
	if (conflicts > 0) parts.push(t("pull.count.conflicts", { count: conflicts }));
	const details = parts.join(t("list.separator"));

	if (result.outcome === "cancelled" || isCancellation(result.fetchError)) {
		const stopped = stoppedText(t, connectionChanged);
		// How far it got, for a pull the next one goes on from. After a
		// change of the connection there is nothing to go on from.
		if (connectionChanged || parts.length === 0) return stopped;
		return `${stopped}\n${t("pull.cancelledAfter", { details })}`;
	}
	if (parts.length > 0) return t("pull.summary", { details });
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
	else if (failures.some((file) => file.reason === "unreadable")) reason = t("pull.reason.unreadable");
	else reason = t("pull.reason.trashFailed");

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
		case "archive-given-up":
			return [t("notice.archiveGivenUp")];
	}
}

function megabytes(bytes: number): string {
	const value = bytes / (1024 * 1024);
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
