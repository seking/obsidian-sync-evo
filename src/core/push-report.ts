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

// The words for a push: its progress, the question it stops to ask, how it
// ended, and what the user has to know of it. Like a pull, a push answers
// with what happened and no text.

import type { Translate } from "./i18n";
import type { PushFailure } from "./push-failure";
import {
	CONFIRM_LIST_LIMIT,
	NOTICE_LIST_LIMIT,
	capList,
	clockTime,
	dateTime,
	failureReason,
	listText,
	megabytes,
	NO_LIST_LIMIT,
	noticeDetails,
	type NoticeLevel,
	type PartReport,
	type PullReport,
	pushCountsText,
	type ReportDetail,
	reportDetail,
	type Question,
	type QuestionPart,
	recoveredPushText,
	recoveredUntrackText,
} from "./pull-report";
import {
	type EmptyVaultAnswer,
	type EmptyVaultRequest,
	type LeftOutReason,
	type PushConfirmRequest,
	type PushProgress,
	type PushRunResult,
	type PushWaitReason,
	type SectionAdded,
} from "./push";
import { placeWords, type RemotePlace } from "./remote-place";
import type { DeviceSettings } from "./settings";
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
 * How many of the files of the remote the added lines match the question
 * before a first push lists. A dialog, and not a notice: it has the room,
 * and nothing else lists them.
 */
const QUESTION_TRACKED_LIMIT = 5;

/**
 * The words of the question a push stops with: what the first push of a
 * sync state sends, and the deletions when there are too many. With both
 * reasons together, the files to delete are listed once, by the first.
 */
export function pushQuestion(
	t: Translate,
	connection: RemotePlace,
	request: PushConfirmRequest,
): Question {
	const { firstPush, deletions } = request;
	const parts: QuestionPart[] = [];
	const listed = (text: string, paths: readonly string[]): void => {
		parts.push({ text, paths: capList(paths, CONFIRM_LIST_LIMIT) });
	};

	if (firstPush !== null) {
		parts.push({ text: t("confirm.firstPush.body", placeWords(t, connection)) });
		// The vault has a `.gitignore` once the section was added to it: no
		// empty one is made for the first commit.
		if (request.remoteEmpty) {
			const text =
				request.sectionAdded === undefined
					? t("confirm.firstPush.remoteEmpty")
					: t("confirm.firstPush.remoteEmptyWithGitignore");
			parts.push({ text });
		}
		// Before the lists: the `.gitignore` is in one of them because of this.
		if (request.sectionAdded !== undefined) {
			const section = request.sectionAdded;
			parts.push({ text: sectionIntro(t, section), paths: capList(section.lines, CONFIRM_LIST_LIMIT) });
			for (const text of sectionNotes(t, section, "sends")) parts.push({ text });
			if (section.tracked.length > 0) {
				const text = t("section.added.tracked", { count: section.tracked.length });
				parts.push({ text, paths: capList(section.tracked, QUESTION_TRACKED_LIMIT) });
				parts.push({ text: t("section.added.untrackHint") });
			}
		}
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
	// Under the deletions, in the words of the first push. What is written
	// over on the remote comes before what is new to it.
	const also = request.alsoSent;
	if (also !== undefined && also.added.length + also.modified.length > 0) {
		parts.push({ text: t("confirm.pushDelete.alsoSent") });
		if (also.modified.length > 0) listed(t("confirm.firstPush.modified", { count: also.modified.length }), also.modified);
		if (also.added.length > 0) listed(t("confirm.firstPush.added", { count: also.added.length }), also.added);
	}
	const title = firstPush !== null ? t("confirm.firstPush.title") : t("confirm.delete.title");
	// "Nothing is changed" would not be true of a file that was written.
	const note = request.sectionAdded === undefined ? t("confirm.push.note") : t("confirm.push.noteSection");
	return { title, parts, note };
}

/** One answer to the question about a vault without its files: the words on its button, and what it does. */
export interface EmptyVaultChoice {
	readonly answer: Exclude<EmptyVaultAnswer, "later">;
	readonly label: string;
	readonly text: string;
}

export interface EmptyVaultQuestion {
	readonly title: string;
	readonly body: string;
	/** In the order they are shown: the one that loses nothing first, the "no" last. */
	readonly choices: readonly EmptyVaultChoice[];
}

/**
 * The words of the question a push stops with when every file with a record
 * is gone from the vault: how many, that the remote still has them, and
 * what each of the three answers does.
 */
export function emptyVaultQuestion(
	t: Translate,
	connection: RemotePlace,
	request: EmptyVaultRequest,
): EmptyVaultQuestion {
	return {
		title: t("confirm.emptyVault.title"),
		body: t(request.missing === 1 ? "confirm.emptyVault.bodyOne" : "confirm.emptyVault.body", {
			count: request.missing,
			remotePlace: placeWords(t, connection).remotePlace,
		}),
		choices: [
			{ answer: "refetch", label: t("confirm.emptyVault.refetch"), text: t("confirm.emptyVault.refetchNote") },
			{
				answer: "delete",
				label: t("confirm.emptyVault.delete"),
				text: t("confirm.emptyVault.deleteNote", { count: request.deletions }),
			},
			{ answer: "cancel", label: t("confirm.cancel"), text: t("confirm.emptyVault.cancelNote") },
		],
	};
}

/**
 * Whether the section a push added is on the remote:
 *
 * - "sends": the push is about to send it. For the question.
 * - "sent": the push sent it.
 * - "unsent": the push ended without sending it. The file on this device
 *   has it all the same, and the next push sends it.
 * - "unknown": the push failed, and no result says how far it got. The
 *   first commit of a remote without commits may have been made with it,
 *   or the branch moved before the failure.
 */
export type SectionDelivery = "sends" | "sent" | "unsent" | "unknown";

/**
 * The text for the section a push added to `.gitignore` without asking: the
 * lines, that nothing else in the file changed, whether they are on the
 * remote, where to change them, and how to say that they are not wanted.
 * With the files of the remote the lines match, which no device syncs from
 * now on and which stay on the remote, and where they can be untracked. Every added line is shown, however many: they are
 * what was written. `limit`: how many of those files are listed.
 */
export function sectionAddedText(
	t: Translate,
	section: SectionAdded,
	delivery: SectionDelivery,
	limit = NOTICE_LIST_LIMIT,
): string {
	const lines = [
		sectionIntro(t, section),
		listText(t, section.lines, NO_LIST_LIMIT),
		...sectionNotes(t, section, delivery),
	];
	if (section.tracked.length > 0) {
		lines.push(
			t("section.added.tracked", { count: section.tracked.length }),
			listText(t, section.tracked, limit),
			t("section.added.untrackHint"),
		);
	}
	return lines.join("\n");
}

function sectionIntro(t: Translate, section: SectionAdded): string {
	return section.created ? t("section.added.created") : t("section.added.intro");
}

// One paragraph each: no language joins two sentences the way another does.
function sectionNotes(t: Translate, section: SectionAdded, delivery: SectionDelivery): string[] {
	const delivered = t(
		(
			{
				sends: "section.added.sends",
				sent: "section.added.sent",
				unsent: "section.added.unsent",
				unknown: "section.added.unknown",
			} as const
		)[delivery],
	);
	// A file that was made had nothing else in it to leave alone.
	return [...(section.created ? [] : [t("section.added.outside")]), delivered, t("section.added.howTo")];
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

/**
 * The text for a push of a sync that started by itself and came to a
 * question: what there is to confirm, that nothing was sent, and that a
 * sync the user starts asks. Shown under the line that names automatic
 * sync, like the pull's.
 */
export function pushWaitingText(t: Translate, reason: PushWaitReason): string {
	if (reason === "empty-vault") return t("auto.waiting.emptyVault");
	return t(reason === "first-push" ? "auto.waiting.firstPush" : "auto.waiting.pushDeletions");
}

export interface PushReportOptions {
	/** The size limit the push ran with, in bytes. */
	readonly sizeLimit: number;
	/** Whether the push was stopped because the connection it ran with was changed. */
	readonly connectionChanged?: boolean;
}

/** Words what a push answered, as the texts of the notices of each matter. */
export function pushReport(t: Translate, result: PushRunResult, options: PushReportOptions): PullReport {
	const part = pushPart(t, result, options);
	return { summary: part.summary, details: part.details.map((detail) => detail.text) };
}

/** Words what a push answered, with how much each matters. */
export function pushPart(t: Translate, result: PushRunResult, options: PushReportOptions): PartReport {
	return {
		summary: summaryText(t, result, options.connectionChanged === true),
		level: summaryLevel(result),
		details: pushDetails(t, result, options),
	};
}

/**
 * How much the way a push ended matters: "warn" where nothing was sent and
 * the user has something to do first. Not where the remote only moved on in
 * between, which the next sync pulls first for by itself. Nor where files
 * were left unsent: what is to be done about them is told by their own
 * details, which stay; where none is (a rename told once already), a
 * summary that stays would only say "as told" every time.
 */
function summaryLevel(result: PushRunResult): NoticeLevel {
	return result.outcome === "pull-first" && result.reason !== "remote-moved" ? "warn" : "info";
}

/** Whether a push left files unsent. */
function pushUnsent(result: PushRunResult): boolean {
	return result.refused.length + result.heldRenames.length + result.held.length + result.leftOut.length > 0;
}

/** How a push ended, in a line: `PullReport.summary` of `pushReport`. */
export function pushSummaryText(t: Translate, result: PushRunResult, connectionChanged = false): string {
	return summaryText(t, result, connectionChanged);
}

/** The details of `pushReport`, each with whether it is told by every push while it is so (`ReportDetail`). */
export function pushDetails(t: Translate, result: PushRunResult, options: PushReportOptions): ReportDetail[] {
	const details: ReportDetail[] = [];
	// What happened in this push, and is only worth knowing.
	const info = (brief: string, words: (limit: number) => string): void => {
		details.push(reportDetail("info", false, words, brief));
	};
	// What is not sent, by every push for as long as that is so.
	const standing = (words: (limit: number) => string): void => {
		details.push(reportDetail("warn", true, words));
	};
	// First: it is what this push wrote to the vault. Not a second time when
	// the question showed it and the push then sent it. A push that was
	// declined or turned down after the question is told again, since the
	// file on this device is changed and the remote's is not. Whether it was
	// sent is the push's to say, and not read from how it ended.
	const section = result.sectionAdded;
	if (section !== undefined && !(section.asked && section.sent)) {
		const delivery = section.sent ? "sent" : "unsent";
		info(t("section.added.brief"), (limit) => sectionAddedText(t, section, delivery, limit));
	}
	if (result.recovered !== null) {
		const text = recoveredPushText(t, result.recovered);
		info(text, () => text);
	}
	if (result.recoveredUntrack !== undefined) {
		const text = recoveredUntrackText(t, result.recoveredUntrack);
		info(text, () => text);
	}
	if (result.held.length > 0) {
		const { held } = result;
		standing((limit) => t("push.held", { count: held.length, list: listText(t, held, limit) }));
	}
	const inTheWay = result.refused.filter((file) => file.reason === "remote-in-the-way").map((file) => file.path);
	if (inTheWay.length > 0) {
		standing((limit) => t("push.remoteInTheWay", { count: inTheWay.length, list: listText(t, inTheWay, limit) }));
	}
	// A new file a cloud drive keeps is told apart: it is the cloud drive
	// the user has to see to, and the next push alone changes nothing.
	const leftOut = (...reasons: LeftOutReason[]): string[] =>
		result.leftOut.filter((file) => reasons.includes(file.reason)).map((file) => file.path);
	const notDownloaded = leftOut("not-downloaded");
	if (notDownloaded.length > 0) {
		standing((limit) =>
			t("push.notDownloaded", { count: notDownloaded.length, list: listText(t, notDownloaded, limit) }),
		);
	}
	// Left out for its size: waiting for the next push changes nothing, so
	// these say what the user can do, apart from the ones that only need
	// another try.
	const grown = leftOut("too-large");
	if (grown.length > 0) {
		const sizeLimit = megabytes(options.sizeLimit);
		standing((limit) =>
			t("push.grownTooLarge", { count: grown.length, limit: sizeLimit, list: listText(t, grown, limit) }),
		);
	}
	const refusedSize = leftOut("refused-size");
	if (refusedSize.length > 0) {
		standing((limit) => t("push.refusedSize", { count: refusedSize.length, list: listText(t, refusedSize, limit) }));
	}
	const space = leftOut("refused-space");
	if (space.length > 0) {
		standing((limit) => t("push.refusedSpace", { count: space.length, list: listText(t, space, limit) }));
	}
	const workflows = leftOut("refused-workflows");
	if (workflows.length > 0) {
		standing((limit) =>
			t("push.refusedWorkflows", { count: workflows.length, list: listText(t, workflows, limit) }),
		);
	}
	const others = leftOut("save-failed", "gone", "unreadable");
	if (others.length > 0) {
		standing((limit) => t("push.leftOut", { count: others.length, list: listText(t, others, limit) }));
	}
	// Once: the next pull takes them up.
	const changed = leftOut("remote-changed");
	if (changed.length > 0) {
		info(t("push.remoteChanged.brief", { count: changed.length }), (limit) =>
			t("push.remoteChanged", { count: changed.length, list: listText(t, changed, limit) }),
		);
	}
	// Of the commit this push made. Seen to: the next pull writes the
	// remote's content over the file of this device.
	if (result.storedOtherwise.length > 0) {
		const paths = result.storedOtherwise;
		details.push(
			reportDetail("warn", false, (limit) =>
				t("push.storedOtherwise", { count: paths.length, list: listText(t, paths, limit) }),
			),
		);
	}
	details.push(...noticeDetails(t, result.notices, options.sizeLimit));
	return details;
}

function summaryText(t: Translate, result: PushRunResult, connectionChanged: boolean): string {
	switch (result.outcome) {
		case "pushed":
			return t("push.summary", { details: pushCountsText(t, result.counts) });
		case "nothing-to-push": {
			// "Up to date" would not be true of a push that left files unsent.
			return pushUnsent(result) ? t("push.nothingSent") : t("push.nothing");
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
		case "waiting":
			return pushWaitingText(t, result.waitingFor ?? "deletions");
		case "cancelled":
			return pushStoppedText(t, connectionChanged);
	}
}
