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

// The words for a push: its progress, the question it stops to ask, how it
// ended, and what the user has to know of it. Like a pull, a push answers
// with what happened and no text.

import type { Translate } from "./i18n";
import type { PushFailure } from "./push-failure";
import {
	CONFIRM_LIST_LIMIT,
	capList,
	clockTime,
	dateTime,
	failureReason,
	listText,
	megabytes,
	noticeTexts,
	type PullReport,
	pushCountsText,
	type Question,
	type QuestionPart,
	recoveredPushText,
} from "./pull-report";
import { type LeftOutReason, type PushConfirmRequest, type PushProgress, type PushRunResult } from "./push";
import type { Connection, DeviceSettings } from "./settings";
import { BackendError } from "./backend";

/**
 * The one line of progress, with a line more while a request limit is
 * waited out: creating content on GitHub has a limit of its own, by the
 * minute and by the hour. `waitingUntil` is when that wait ends, or `null`.
 */
export function pushProgressText(t: Translate, progress: PushProgress, waitingUntil: number | null = null): string {
	const { done, total } = progress;
	let text: string;
	switch (progress.phase) {
		case "listing":
			text = t("push.progress.listing");
			break;
		case "scanning":
			text = t("push.progress.scanning");
			break;
		case "hashing":
			text = total > 0 ? t("push.progress.hashing", { done, total }) : t("push.progress.scanning");
			break;
		case "sending":
			text = total > 0 && done > 0 ? t("push.progress.sending", { done, total }) : t("push.progress.sendingStart");
			break;
		case "finishing":
			text = t("push.progress.finishing");
			break;
	}
	if (waitingUntil === null) return text;
	// Rounded up to the minute, so that the time shown is never before the
	// one that is waited for.
	const time = clockTime(Math.ceil(waitingUntil / 60_000) * 60_000);
	return `${text}\n${t("push.progress.rateLimited", { time })}`;
}

/**
 * The words of the question a push stops with: what the first push of a
 * sync state sends, and the deletions when there are too many. With both
 * reasons together, the files to delete are listed once, by the first.
 */
export function pushQuestion(
	t: Translate,
	connection: Pick<Connection, "repository" | "branch">,
	request: PushConfirmRequest,
): Question {
	const { firstPush, deletions } = request;
	const parts: QuestionPart[] = [];
	const listed = (text: string, paths: readonly string[]): void => {
		parts.push({ text, paths: capList(paths, CONFIRM_LIST_LIMIT) });
	};

	if (firstPush !== null) {
		const target = { repository: connection.repository, branch: connection.branch };
		parts.push({ text: t("confirm.firstPush.body", target) });
		if (request.remoteEmpty) parts.push({ text: t("confirm.firstPush.remoteEmpty") });
		const { added, modified, deleted } = firstPush;
		if (added.length > 0) listed(t("confirm.firstPush.added", { count: added.length }), added);
		if (modified.length > 0) listed(t("confirm.firstPush.modified", { count: modified.length }), modified);
		if (deleted.length > 0) listed(t("confirm.firstPush.deleted", { count: deleted.length }), deleted);
	}
	if (deletions !== null) {
		const text = t("confirm.pushDelete.body", { count: deletions.length });
		if (firstPush === null) listed(text, deletions);
		else parts.push({ text });
	}
	const title = firstPush !== null ? t("confirm.firstPush.title") : t("confirm.delete.title");
	return { title, parts, note: t("confirm.push.note") };
}

/** The text for a push that was stopped. Nothing of it shows on the remote. */
export function pushStoppedText(t: Translate, connectionChanged: boolean): string {
	return connectionChanged ? t("push.connectionChanged") : t("push.cancelled");
}

/** The text for a push that ended by throwing. */
export function pushFailureText(
	t: Translate,
	settings: DeviceSettings,
	error: unknown,
	connectionChanged = false,
): string {
	if (error instanceof BackendError && error.kind === "cancelled") return pushStoppedText(t, connectionChanged);
	return t("push.failed", { reason: failureReason(t, settings, error) });
}

/**
 * For when the app starts, and for the settings: a push did not get to its
 * end, and no sync has sent since.
 */
export function pushFailureReminderText(t: Translate, failure: PushFailure): string {
	return t("push.unfinished", { time: dateTime(failure.at) });
}

export interface PushReportOptions {
	/** The size limit the push ran with, in bytes. */
	readonly sizeLimit: number;
	/** Whether the push was stopped because the connection it ran with was changed. */
	readonly connectionChanged?: boolean;
}

/** Words what a push answered. */
export function pushReport(t: Translate, result: PushRunResult, options: PushReportOptions): PullReport {
	const details: string[] = [];
	if (result.recovered !== null) details.push(recoveredPushText(t, result.recovered));
	if (result.held.length > 0) {
		details.push(t("push.held", { count: result.held.length, list: listText(t, result.held) }));
	}
	const inTheWay = result.refused.filter((file) => file.reason === "remote-in-the-way").map((file) => file.path);
	if (inTheWay.length > 0) {
		details.push(t("push.remoteInTheWay", { count: inTheWay.length, list: listText(t, inTheWay) }));
	}
	// A new file a cloud drive keeps is told apart: it is the cloud drive
	// the user has to see to, and the next push alone changes nothing.
	const leftOut = (...reasons: LeftOutReason[]): string[] =>
		result.leftOut.filter((file) => reasons.includes(file.reason)).map((file) => file.path);
	const notDownloaded = leftOut("not-downloaded");
	if (notDownloaded.length > 0) {
		details.push(t("push.notDownloaded", { count: notDownloaded.length, list: listText(t, notDownloaded) }));
	}
	// Left out for its size: waiting for the next push changes nothing, so
	// these say what the user can do, apart from the ones that only need
	// another try.
	const grown = leftOut("too-large");
	if (grown.length > 0) {
		const limit = megabytes(options.sizeLimit);
		details.push(t("push.grownTooLarge", { count: grown.length, limit, list: listText(t, grown) }));
	}
	const refusedSize = leftOut("refused-size");
	if (refusedSize.length > 0) {
		details.push(t("push.refusedSize", { count: refusedSize.length, list: listText(t, refusedSize) }));
	}
	const workflows = leftOut("refused-workflows");
	if (workflows.length > 0) {
		details.push(t("push.refusedWorkflows", { count: workflows.length, list: listText(t, workflows) }));
	}
	const others = leftOut("save-failed", "gone", "unreadable");
	if (others.length > 0) {
		details.push(t("push.leftOut", { count: others.length, list: listText(t, others) }));
	}
	if (result.storedOtherwise.length > 0) {
		const paths = result.storedOtherwise;
		details.push(t("push.storedOtherwise", { count: paths.length, list: listText(t, paths) }));
	}
	details.push(...noticeTexts(t, result.notices, options.sizeLimit));
	return { summary: summaryText(t, result, options.connectionChanged === true), details };
}

function summaryText(t: Translate, result: PushRunResult, connectionChanged: boolean): string {
	switch (result.outcome) {
		case "pushed":
			return t("push.summary", { details: pushCountsText(t, result.counts) });
		case "nothing-to-push": {
			// "Up to date" would not be true of a push that left files unsent.
			const unsent =
				result.refused.length + result.heldRenames.length + result.held.length + result.leftOut.length > 0;
			return unsent ? t("push.nothingSent") : t("push.nothing");
		}
		case "pull-first":
			switch (result.reason) {
				case "remote-empty":
					return t("push.pullFirst.remoteEmpty");
				case "not-default-branch":
					return t("push.pullFirst.notDefaultBranch", { branch: result.defaultBranch ?? "" });
				case "remote-moved":
					return t("push.pullFirst.remoteMoved");
				case "gitignore-unsettled":
					return t("push.pullFirst.gitignore");
				case "gitignore-unreadable":
					return t("push.pullFirst.gitignoreUnreadable");
				default:
					return t("push.pullFirst.noBase");
			}
		case "declined":
			return t("push.declined");
		case "cancelled":
			return pushStoppedText(t, connectionChanged);
	}
}
