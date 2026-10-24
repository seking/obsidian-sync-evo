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

// The words for a pull: its progress, how it ended, and what the user has to
// know of it. A pull answers with what happened and no text; whoever shows
// it only puts these texts on the screen.

import { BackendError, type BackendErrorKind } from "./backend";
import { type FetchLimitState, NO_FETCH_LIMIT } from "./fetch-quota";
import type { Translate } from "./i18n";
import { NOTICE_KINDS, type NoticeKind, type NoticeRef } from "./notices";
import type {
	DeferReason,
	FirstFetchRequest,
	PullConflict,
	PullProgress,
	PullResult,
	PullWaitReason,
} from "./pull-io";
import type { PushCounts } from "./push-pending";
import { placeWords, type RemotePlace } from "./remote-place";
import { type DeviceSettings, parseRepository } from "./settings";

/** How many paths a confirmation lists before it only counts them. */
export const CONFIRM_LIST_LIMIT = 50;

/**
 * How many paths a notice lists, per kind. A notice is small, and on a phone
 * it covers the note; every path is on the screen of the results
 * (`ReportDetail.full`).
 */
export const NOTICE_LIST_LIMIT = 3;

/** Every path: what the screen of the results lists (`ReportDetail.full`). */
export const NO_LIST_LIMIT = Number.POSITIVE_INFINITY;

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

/** The words of a question a sync stops to ask. */
export interface Question {
	readonly title: string;
	readonly parts: readonly QuestionPart[];
	/** What "cancel" does. The last thing a question says. */
	readonly note: string;
}

export type FirstFetchQuestion = Question;

/**
 * The words of the question before a first fetch: where it fetches from,
 * and what becomes of the files the vault already holds. When going on
 * discards the sync state, that is said first, and the question is worded
 * also when no file is listed.
 */
export function firstFetchQuestion(
	t: Translate,
	connection: RemotePlace,
	request: FirstFetchRequest,
): FirstFetchQuestion {
	const { files, discardsState } = request;
	const words = placeWords(t, connection);
	const parts: QuestionPart[] = [
		{ text: discardsState ? t("confirm.startOver.body", words) : t("confirm.firstFetch.body", words) },
	];
	const listed = (text: string, paths: readonly string[]): void => {
		parts.push({ text, paths: capList(paths, CONFIRM_LIST_LIMIT) });
	};

	if (files.different.length > 0) {
		listed(t("confirm.firstFetch.different", { count: files.different.length }), files.different);
	}
	if (files.differentSettings.length > 0) {
		const { differentSettings } = files;
		listed(t("confirm.firstFetch.differentSettings", { count: differentSettings.length }), differentSettings);
	}
	if (files.localOnly.length > 0) {
		listed(t("confirm.firstFetch.localOnly", { count: files.localOnly.length }), files.localOnly);
	}
	if (files.different.length + files.differentSettings.length + files.localOnly.length === 0) parts.push({ text: t("confirm.startOver.nothing") });
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
export function nextMinute(time: number): number {
	return Math.ceil(time / 60_000) * 60_000;
}

/** The day and the time of day on the device, to the minute, as "2026-10-09 14:05". */
export function dateTime(time: number): string {
	const at = new Date(time);
	const two = (value: number): string => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${clockTime(time)}`;
}

/**
 * A time to come, as seen at `now`: the time of day alone on the same day,
 * and with its date on another, or "16:00" said at 20:00 reads as a time
 * already past.
 */
export function timeFrom(now: number, time: number): string {
	return new Date(now).toDateString() === new Date(time).toDateString() ? clockTime(time) : dateTime(time);
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
 * A failure that words its reason itself: one that only a single service
 * fails with, and that its kind does not tell apart (the errors of Google
 * Drive, in `pro/`).
 */
export interface WordedFailure {
	failureText(t: Translate, settings: DeviceSettings): string;
}

function isWorded(error: unknown): error is WordedFailure {
	return error instanceof BackendError && typeof (error as Partial<WordedFailure>).failureText === "function";
}

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

	if (settings.backend === "gdrive") {
		// The folder, the client secret, and the cap of the day, which is
		// not the connection: a 403 like the others.
		if (isWorded(error)) return error.failureText(t, settings);
		if (kind === "unauthorized") return t("check.gdrive.unauthorized");
		if (kind === "forbidden") return t("check.gdrive.forbidden");
		if (kind === "not-found" || kind === "branch-not-found") return t("pull.error.other", { detail });
	}
	if (settings.backend === "dropbox") {
		// No token, repository or branch of the user's to name: what is
		// wrong is the connection, or the network.
		if (kind === "unauthorized") return t("check.dropbox.unauthorized");
		if (kind === "forbidden") return t("check.dropbox.forbidden");
		if (kind === "not-found" || kind === "branch-not-found") return t("pull.error.other", { detail });
	}
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
		case "workflows-permission":
			return t("push.error.workflows");
		case "not-as-listed":
			return t("push.error.notAsListed");
		case "paid-plan":
			return t("paid.refused");
		// The detail is in English and for developers, but it is all there
		// is to go on. No `default`: a kind added later fails the type
		// check here. "too-large" does not come this far from a push,
		// which leaves the one file out (`PushFile.refused`).
		case "too-large":
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

// The reasons a file is put off that say something went wrong, and are told
// in one text with the reason. Two more are told in texts of their own,
// which list the paths: "unreadable" and "not-downloaded" are about files
// the user has to find and see to (`unreadTexts`). The others are an editor
// in the middle of typing: the next sync takes the file, and there is
// nothing for the user to do or to know.
const FAILURES: readonly DeferReason[] = ["fetch-failed", "hash-mismatch", "trash-failed"];

/**
 * How much a thing a sync tells matters, which is how it is shown (E-2):
 *
 * - "error": the sync could not be carried out, or stopped. A notice of its
 *   own that stays, and looks apart from the others.
 * - "warn": the sync went on, and something is left that the user has to see
 *   to, or may lose content by not knowing of. One notice that stays, per
 *   part of the sync.
 * - "info": done, and only worth knowing. A short line in the summary,
 *   which goes by itself; nothing at all from a sync that started by itself.
 *
 * All of them are on the screen of the results, in full.
 */
export type NoticeLevel = "error" | "warn" | "info";

/**
 * One thing a sync has to tell beside how it ended.
 *
 * `standing` tells the two kinds apart that a sync which starts by itself
 * treats differently (`auto-report.ts`):
 *
 * - `false`: it happened in this sync, and no later sync says it again: a
 *   copy that was made of a conflict, a file that was moved to the trash, a
 *   notice that is remembered as told from here on. Always told.
 * - `true`: it is how things stand, and every sync says it again for as
 *   long as it is so: files that could not be fetched, or read, or sent.
 *   Told every time by a sync the user starts, who is looking; a sync that
 *   starts every few minutes tells it once.
 *
 * `level` is the other way to look at it: how it is shown (`NoticeLevel`).
 */
export interface ReportDetail {
	/** As a notice shows it: its lists cut to `NOTICE_LIST_LIMIT`. */
	readonly text: string;
	/** With every path, for the screen of the results. */
	readonly full: string;
	/** For "info": the short line the summary gets in its place, with the count alone. */
	readonly brief?: string;
	readonly level: NoticeLevel;
	readonly standing: boolean;
}

/**
 * A `ReportDetail` from what words it: `words` is called with how many
 * paths a list shows, once for the notice and once for the screen.
 */
export function reportDetail(
	level: NoticeLevel,
	standing: boolean,
	words: (limit: number) => string,
	brief?: string,
): ReportDetail {
	return {
		text: words(NOTICE_LIST_LIMIT),
		full: words(NO_LIST_LIMIT),
		...(brief === undefined ? {} : { brief }),
		level,
		standing,
	};
}

/**
 * A part of a sync (a pull, a push, an untracking), worded: how it ended,
 * how much that matters, and what else it has to tell.
 */
export interface PartReport {
	readonly summary: string;
	/** Of `summary`: "info" but for a part that ended with something to see to. */
	readonly level: NoticeLevel;
	readonly details: readonly ReportDetail[];
}

/** Words what a pull answered, as the texts of the notices of each matter. */
export function pullReport(t: Translate, result: PullResult, options: PullReportOptions): PullReport {
	const part = pullPart(t, result, options);
	return { summary: part.summary, details: part.details.map((detail) => detail.text) };
}

/** Words what a pull answered, with how much each matters. */
export function pullPart(t: Translate, result: PullResult, options: PullReportOptions): PartReport {
	// With the summary and not a message of its own: it is nothing to act on.
	const summary = [summaryText(t, result, options.connectionChanged === true)];
	if (result.refetched > 0) summary.push(t("pull.refetched", { count: result.refetched }));
	return { summary: summary.join("\n"), level: "info", details: pullDetails(t, result, options) };
}

/** How a pull ended, in a line: the first line of `PullReport.summary`. */
export function pullSummaryText(t: Translate, result: PullResult, connectionChanged = false): string {
	return summaryText(t, result, connectionChanged);
}

/** `PullReport.details`, each with whether it is told by every pull while it is so. */
export function pullDetails(t: Translate, result: PullResult, options: PullReportOptions): ReportDetail[] {
	const details: ReportDetail[] = [];
	// What happened in this pull, and has to be seen to.
	const warn = (words: (limit: number) => string): void => {
		details.push(reportDetail("warn", false, words));
	};
	// What happened in this pull, and is only worth knowing.
	const info = (brief: string, words: (limit: number) => string): void => {
		details.push(reportDetail("info", false, words, brief));
	};

	if (result.conflicts.length > 0) {
		const lines = result.conflicts.map((conflict) => conflictLine(t, conflict));
		warn((limit) => t("pull.conflicts", { count: lines.length, list: listText(t, lines, limit) }));
	}
	// Seen to as well: a merge can break the text (S-5).
	if (result.merged.length > 0) {
		const lines = result.merged.map((merge) => t("pull.merged.item", { path: merge.path, kept: merge.keptAt }));
		warn((limit) => t("pull.merged", { count: lines.length, list: listText(t, lines, limit) }));
	}
	if (result.replacedSettings.length > 0) {
		const { replacedSettings } = result;
		const count = replacedSettings.length;
		info(t("pull.replacedSettings.brief", { count }), (limit) =>
			t("pull.replacedSettings", { count, list: listText(t, replacedSettings, limit) }),
		);
	}
	if (result.trashed.length > 0) {
		const { trashed } = result;
		info(t("pull.trashed.brief", { count: trashed.length }), (limit) =>
			t("pull.trashed", { count: trashed.length, list: listText(t, trashed, limit) }),
		);
	}
	// Listed until a pull has answered with them, and by none after that.
	// What was typed after the stop is in the trash alone.
	if (result.halfWritten.length > 0) {
		const { halfWritten } = result;
		warn((limit) => t("pull.halfWritten", { count: halfWritten.length, list: listText(t, halfWritten, limit) }));
	}
	// The ones of them a merge was writing: what the vault had is not in the
	// file that was moved away, and the path gets the remote's content.
	if (result.halfMerged.length > 0) {
		const lines = result.halfMerged.map((merge) => t("pull.merged.item", { path: merge.path, kept: merge.keptAt }));
		warn((limit) => t("pull.halfMerged", { count: lines.length, list: listText(t, lines, limit) }));
	}
	if (result.halfCopies.length > 0) {
		const { halfCopies } = result;
		info(t("pull.halfCopies.brief", { count: halfCopies.length }), (limit) =>
			t("pull.halfCopies", { count: halfCopies.length, list: listText(t, halfCopies, limit) }),
		);
	}
	// The count alone: they are in the `.trash/`, and nothing is to be done.
	if (result.tidiedCopies.length > 0) {
		const count = result.tidiedCopies.length;
		info(t("pull.tidiedCopies.brief", { count }), () => t("pull.tidiedCopies", { count }));
	}
	if (result.keptLocal.length > 0) {
		const { keptLocal } = result;
		info(t("pull.keptLocal.brief", { count: keptLocal.length }), (limit) =>
			t("pull.keptLocal", { count: keptLocal.length, list: listText(t, keptLocal, limit) }),
		);
	}
	if (result.recoveredPush !== undefined) {
		const text = recoveredPushText(t, result.recoveredPush);
		info(text, () => text);
	}
	if (result.recoveredUntrack !== undefined) {
		const text = recoveredUntrackText(t, result.recoveredUntrack);
		info(text, () => text);
	}
	// Not after a "no": that pull left nothing for later, it did not begin.
	// What it put off before it asked (a file left half written that could
	// not be looked at) is found again by the next pull, which tells it.
	// Nor after a question that was left for later, for the same reason.
	if (result.outcome !== "declined" && result.outcome !== "waiting") {
		const failed = incompleteText(t, result, options.settings);
		if (failed !== null) details.push(reportDetail("warn", true, () => failed));
		// The files that only wait are counted once: by the text above
		// when there is one.
		for (const words of unreadTexts(t, result, failed === null)) details.push(reportDetail("warn", true, words));
	}
	// They have a record now, and are told by no later pull.
	if (result.newSymlinks.length > 0) {
		const { newSymlinks } = result;
		info(t("pull.symlinks.brief", { count: newSymlinks.length }), (limit) =>
			t("pull.symlinks", { count: newSymlinks.length, list: listText(t, newSymlinks, limit) }),
		);
	}
	// Remembered as told by the pull that answers with them.
	details.push(
		...noticeDetails(t, result.notices, options.sizeLimit, (path) => {
			const blocked = result.unwritable.find((entry) => entry.reason === "blocked" && entry.path === path);
			return blocked?.inTheWay ?? [];
		}),
	);
	return details;
}

function summaryText(t: Translate, result: PullResult, connectionChanged: boolean): string {
	if (result.outcome === "remote-empty") return t("pull.remoteEmpty");
	if (result.outcome === "declined") {
		// What a pull that stopped left half written is moved away before
		// the question, so a "no" does not mean that nothing was changed.
		const moved = result.halfWritten.length + result.halfCopies.length > 0;
		return t(moved ? "pull.declinedAfterTrash" : "pull.declined");
	}
	if (result.outcome === "waiting") return pullWaitingText(t, result.waitingFor ?? "deletions");
	const { fetched, deleted, renamed, conflicts } = result.counts;
	const parts: string[] = [];
	if (fetched > 0) parts.push(t("pull.count.fetched", { count: fetched }));
	if (deleted > 0) parts.push(t("pull.count.deleted", { count: deleted }));
	if (renamed > 0) parts.push(t("pull.count.renamed", { count: renamed }));
	if (conflicts > 0) parts.push(t("pull.count.conflicts", { count: conflicts }));
	if (result.merged.length > 0) parts.push(t("pull.count.merged", { count: result.merged.length }));
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

/**
 * The text for a pull of a sync that started by itself and came to a
 * question, or to a first fetch: what there is to confirm, that nothing
 * was changed, and that a sync the user starts asks. Shown under the line
 * that says it comes from automatic sync (`auto-report.ts`), which it does
 * not name itself.
 */
export function pullWaitingText(t: Translate, reason: PullWaitReason): string {
	switch (reason) {
		case "rewritten":
			return t("auto.waiting.rewritten");
		case "deletions":
			return t("auto.waiting.deletions");
		case "first-fetch":
			return t("auto.waiting.firstFetch");
	}
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
	else reason = t("pull.reason.trashFailed");

	// With the files that only wait for one of these, which no step of
	// theirs failed for.
	const count = failures.length + result.deferred.filter((file) => file.reason === "depends-on-deferred").length;
	return count > 0 ? t("pull.incomplete", { count, reason }) : t("pull.incompleteSome", { reason });
}

/**
 * The texts for the files of this device a pull could not know the content
 * of and left as they are: the ones a cloud drive has not downloaded, and
 * the ones that could not be read. With the paths, since the user has to
 * see to each file. Told by every pull while it is so, and not once: the
 * pull does not get to its end until it is seen to.
 *
 * `countWaiting`: whether the files that only wait for one of these are
 * counted here, in a text of their own after them. They are when no other
 * text counts them (`incompleteText`), so that they are told at all. So
 * are files that wait where nothing else was put off: what they wait for
 * is told by a notice, once (a name a rename was left at, "renaming-left"),
 * and the pull is not done until it is seen to. Not where a file is being
 * edited: the next sync takes it, and there is nothing to know.
 */
function unreadTexts(t: Translate, result: PullResult, countWaiting: boolean): ((limit: number) => string)[] {
	const texts: ((limit: number) => string)[] = [];
	const pathsOf = (reason: DeferReason): string[] =>
		result.deferred.filter((file) => file.reason === reason).map((file) => file.path);
	const notDownloaded = pathsOf("not-downloaded");
	if (notDownloaded.length > 0) {
		texts.push((limit) => t("pull.notDownloaded", { count: notDownloaded.length, list: listText(t, notDownloaded, limit) }));
	}
	const unreadable = pathsOf("unreadable");
	if (unreadable.length > 0) {
		texts.push((limit) => t("pull.unreadable", { count: unreadable.length, list: listText(t, unreadable, limit) }));
	}
	const waiting = pathsOf("depends-on-deferred").length;
	if (countWaiting && waiting > 0) {
		if (texts.length > 0) texts.push(() => t("pull.waitingForUnread", { count: waiting }));
		else if (result.deferred.length === waiting) texts.push(() => t("pull.waitingAlone", { count: waiting }));
	}
	return texts;
}

/** What a push changed on the remote, as a list of counts. Empty when it changed nothing. */
export function pushCountsText(t: Translate, counts: PushCounts): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(t("push.count.added", { count: counts.added }));
	if (counts.modified > 0) parts.push(t("push.count.modified", { count: counts.modified }));
	if (counts.deleted > 0) parts.push(t("push.count.deleted", { count: counts.deleted }));
	return parts.join(t("list.separator"));
}

/** The text for a push that had gone through unknown to this device, and is recorded now. Told by a pull or a push. */
export function recoveredPushText(t: Translate, counts: PushCounts): string {
	return t("push.recovered", { details: pushCountsText(t, counts) });
}

/**
 * The text for an untracking that had gone through unknown to this device,
 * and is recorded now. Told by whoever found out: a pull, a push, or the
 * next untracking. Not as files deleted: they are still on this device.
 */
export function recoveredUntrackText(t: Translate, count: number): string {
	return t("push.recoveredUntrack", { count });
}

/**
 * The texts of the one-time notices, as a notice shows them: per kind, in
 * the order of `NOTICE_KINDS`. `inTheWay` answers the vault files that are
 * in the place of a blocked file of the remote.
 */
export function noticeTexts(
	t: Translate,
	notices: readonly NoticeRef[],
	sizeLimit: number,
	inTheWay: (path: string) => readonly string[] = () => [],
): string[] {
	return noticeDetails(t, notices, sizeLimit, inTheWay).map((detail) => detail.text);
}

/** `noticeTexts`, with how much each matters (`NOTICE_LEVELS`) and every path. */
export function noticeDetails(
	t: Translate,
	notices: readonly NoticeRef[],
	sizeLimit: number,
	inTheWay: (path: string) => readonly string[] = () => [],
): ReportDetail[] {
	return NOTICE_KINDS.flatMap((kind) => {
		const paths = notices.filter((notice) => notice.kind === kind).map((notice) => notice.path);
		if (paths.length === 0) return [];
		const level = NOTICE_LEVELS[kind];
		const brief = level === "info" ? noticeBrief(t, kind, paths) : undefined;
		return [reportDetail(level, false, (limit) => noticeText(t, kind, paths, sizeLimit, inTheWay, limit), brief)];
	});
}

/**
 * How much each kind of one-time notice matters. "warn": what is not
 * written, read or sent until the user does something, and what stops
 * syncing if left as it is (the plugin that the next start of the app turns
 * off; a fixed exclusion that is off, which git on a computer then commits
 * the trash with). "info": what is so, and needs nothing done.
 */
const NOTICE_LEVELS: { readonly [Kind in NoticeKind]: NoticeLevel } = {
	"own-folder-on-remote": "warn",
	"git-at-root": "warn",
	"remote-path-collision": "warn",
	"too-large": "warn",
	"lfs-pointer": "warn",
	"invalid-path": "warn",
	"plugin-not-listed": "warn",
	"unwritable-path": "warn",
	"blocked-path": "warn",
	"archive-given-up": "info",
	"archive-limited": "info",
	"local-path-collision": "warn",
	"rename-not-sent": "warn",
	"nested-gitignore": "info",
	"fixed-exclusion-off": "warn",
	submodule: "info",
	"submodule-no-access": "warn",
	"submodule-no-commit": "warn",
	"submodule-not-sent": "warn",
	"local-link": "info",
	"renaming-left": "warn",
	"case-renamed-folder": "warn",
};

// One text per kind, which lists its paths. No `default`: a kind added
// later fails the type check here until it is given a text.
function noticeText(
	t: Translate,
	kind: NoticeKind,
	paths: readonly string[],
	sizeLimit: number,
	inTheWay: (path: string) => readonly string[],
	limit: number,
): string {
	const list = listText(t, paths, limit);
	switch (kind) {
		case "own-folder-on-remote":
			return t("notice.ownFolderOnRemote", { list });
		case "git-at-root":
			return t("notice.gitAtRoot");
		case "remote-path-collision":
			return t("notice.remotePathCollision", { list });
		case "too-large":
			return t("notice.tooLarge", { limit: megabytes(sizeLimit), list });
		case "lfs-pointer":
			return t("notice.lfsPointer", { list });
		case "invalid-path":
			return t("notice.invalidPath", { list });
		case "plugin-not-listed":
			return t("notice.pluginNotListed", { list });
		case "unwritable-path":
			return t("notice.unwritablePath", { list });
		case "blocked-path": {
			// Each remote file has its own files in its place: those are
			// named on the screen of the results, where every path is.
			if (limit !== NO_LIST_LIMIT) return t("notice.blockedPath", { list });
			const lines = paths.map((path) => {
				const local = inTheWay(path);
				return local.length === 0
					? path
					: t("notice.blockedPath.item", { path, local: local.join(t("list.separator")) });
			});
			return t("notice.blockedPath", { list: listText(t, lines, limit) });
		}
		case "archive-given-up":
			return t("notice.archiveGivenUp");
		case "archive-limited":
			// The "path" is the estimate, in bytes. The last is the one the
			// device goes by now.
			return t("notice.archiveLimited", { size: archiveSize(paths) });
		case "local-path-collision":
			return t("notice.localPathCollision", { list });
		case "rename-not-sent":
			return t("notice.renameNotSent", { list });
		case "nested-gitignore":
			return t("notice.nestedGitignore", { list });
		case "fixed-exclusion-off":
			// The "paths" are lines of `.gitignore`, and all of them are shown:
			// which ones are off is the whole of the notice.
			return t("notice.fixedExclusionOff", { list: listText(t, paths, NO_LIST_LIMIT) });
		case "submodule":
			return t("notice.submodule", { list });
		case "submodule-no-access":
			return t("notice.submoduleNoAccess", { list });
		case "submodule-no-commit":
			return t("notice.submoduleNoCommit", { list });
		case "submodule-not-sent":
			return t("notice.submoduleNotSent", { list });
		case "local-link":
			return t("notice.localLink", { list });
		case "renaming-left":
			return t("notice.renamingLeft", { list });
		case "case-renamed-folder":
			return t("notice.caseRenamedFolder", { list });
	}
}

/** The short line of a one-time notice of the kind "info", for the summary. */
function noticeBrief(t: Translate, kind: NoticeKind, paths: readonly string[]): string | undefined {
	const count = paths.length;
	switch (kind) {
		case "archive-given-up":
			return t("notice.archiveGivenUp.brief");
		case "archive-limited":
			return t("notice.archiveLimited.brief", { size: archiveSize(paths) });
		case "nested-gitignore":
			return t("notice.nestedGitignore.brief", { count });
		case "submodule":
			return t("notice.submodule.brief", { count });
		case "local-link":
			return t("notice.localLink.brief", { count });
		default:
			return undefined;
	}
}

function archiveSize(paths: readonly string[]): string {
	const size = Number(paths[paths.length - 1] ?? 0) / (1024 * 1024);
	return size >= 10 ? String(Math.floor(size)) : Math.max(size, 0.1).toFixed(1);
}

export function megabytes(bytes: number): string {
	const value = bytes / (1024 * 1024);
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
