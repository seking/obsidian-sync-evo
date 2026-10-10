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

// The words for untracking: the question before it, and how it ended. Like a
// pull and a push, untracking answers with what happened and no text
// (`untrack.ts`).

import { BackendError } from "./backend";
import { exceedsDeletionThreshold } from "./deletion-threshold";
import type { UntrackableFile, UntrackList } from "./exclusion-settings";
import type { Translate } from "./i18n";
import { pathKey } from "./paths";
import type { PullVault } from "./pull-io";
import {
	CONFIRM_LIST_LIMIT,
	capList,
	failureReason,
	listText,
	type PullReport,
	type Question,
	type QuestionPart,
	recoveredPushText,
	recoveredUntrackText,
} from "./pull-report";
import type { DeviceSettings } from "./settings";
import type { StateStore } from "./state";
import type { UntrackRefusal, UntrackRunResult, UntrackSyncResult } from "./untrack";

/** What the user is shown before anything is untracked. */
export interface UntrackConfirmRequest {
	/** The files that would be untracked (`UntrackList.files`). */
	readonly files: readonly UntrackableFile[];
	/** The submodules a rule matches, which are not untracked here (`UntrackList.submodules`). */
	readonly submodules: readonly string[];
	/**
	 * The paths among `files` this device holds no file for, as whoever
	 * draws the question found them: over the size limit, at a path the
	 * device cannot write, a symbolic link. "The files on this device stay"
	 * says nothing of these.
	 */
	readonly missing: readonly string[];
	/** The number of records when the question is drawn, of every kind: what the deletions are a share of. */
	readonly recordCount: number;
}

/** What drawing the question reads: nothing is written, and the remote is not asked. */
export interface UntrackConfirmDeps {
	readonly store: Pick<StateStore, "readRecords">;
	readonly vault: Pick<PullVault, "stat">;
}

/**
 * What the question is drawn from, for a list of the screen: with the files
 * of it this device holds no file for, and the number of records, as they
 * are now. A path that cannot be looked at counts as not held: the user is
 * then told that its content may be left in the history of the remote alone,
 * which is the more careful of the two. A failure of the sync state is thrown.
 */
export async function untrackConfirmRequest(deps: UntrackConfirmDeps, list: UntrackList): Promise<UntrackConfirmRequest> {
	const missing: string[] = [];
	for (const file of list.files) {
		let held = false;
		try {
			held = (await deps.vault.stat(file.path))?.type === "file";
		} catch {
			// Not a path of this device.
		}
		if (!held) missing.push(file.path);
	}
	const recordCount = (await deps.store.readRecords()).length;
	return { files: list.files, submodules: list.submodules, missing, recordCount };
}

/**
 * The line for the submodules a rule matches, which are not untracked here.
 * With `list`, each of them on a line after it: for a message, where the
 * screen that says it does not list them itself.
 */
export function untrackSubmodulesText(t: Translate, submodules: readonly string[], list = false): string {
	const text = t("untrack.submodules", { count: submodules.length });
	return list ? `${text}\n${listText(t, submodules)}` : text;
}

/** The words of the question before untracking. Closing it without an answer counts as `cancel`. */
export interface UntrackQuestion extends Question {
	/** The button that untracks. */
	readonly proceed: string;
	/** The button that does not untrack: the rules stay, and the files stay synced. */
	readonly cancel: string;
	/** The paths to hand to `runUntrackSync` when the answer is yes: every file of the question, also past the ones listed. */
	readonly shown: readonly string[];
}

/**
 * The words of the question before untracking: asked once, before the sync
 * that comes first. The files are listed up to `CONFIRM_LIST_LIMIT`, each
 * with what is to be known of it: a symbolic link, in Sync Evo's own folder,
 * not on this device. Past the threshold of deletions the count is warned
 * of, first, in the same question (`exceedsDeletionThreshold`).
 */
export function untrackQuestion(t: Translate, request: UntrackConfirmRequest): UntrackQuestion {
	const { files, submodules } = request;
	const missing = new Set(request.missing.map((path) => pathKey(path)));
	const absent = new Set(files.filter((file) => missing.has(pathKey(file.path))));
	const line = (file: UntrackableFile): string => {
		const tags: string[] = [];
		if (file.symlink) tags.push(t("untrack.tag.symlink"));
		if (file.ownFolder) tags.push(t("untrack.tag.ownFolder"));
		if (absent.has(file)) tags.push(t("untrack.tag.missing"));
		if (tags.length === 0) return file.path;
		return t("untrack.item.tagged", { path: file.path, tags: tags.join(t("list.separator")) });
	};

	const parts: QuestionPart[] = [];
	if (exceedsDeletionThreshold(files.length, request.recordCount)) {
		parts.push({ text: t("untrack.confirm.threshold", { count: files.length }) });
	}
	parts.push({
		text: t("untrack.confirm.body", { count: files.length }),
		paths: capList(files.map(line), CONFIRM_LIST_LIMIT),
	});
	parts.push({ text: t("untrack.confirm.keeps") });
	parts.push({ text: t("untrack.confirm.otherDevices") });
	if (absent.size > 0) parts.push({ text: t("untrack.confirm.missing", { count: absent.size }) });
	if (submodules.length > 0) {
		parts.push({
			text: t("untrack.confirm.submodules", { count: submodules.length }),
			paths: capList(submodules, CONFIRM_LIST_LIMIT),
		});
	}
	parts.push({ text: t("untrack.confirm.syncFirst") });
	// Last of these: few keep the files on a computer with git as well.
	parts.push({ text: t("untrack.confirm.mac") });
	return {
		title: t("untrack.confirm.title"),
		parts,
		note: t("untrack.confirm.note"),
		proceed: t("untrack.confirm.proceed"),
		cancel: t("untrack.confirm.cancel"),
		shown: files.map((file) => file.path),
	};
}

function refusalText(t: Translate, reason: UntrackRefusal | undefined): string {
	switch (reason) {
		case "remote-empty":
			return t("untrack.syncFirst.remoteEmpty");
		case "gitignore-unsettled":
			return t("untrack.syncFirst.gitignoreUnsettled");
		case "gitignore-unreadable":
			return t("untrack.syncFirst.gitignoreUnreadable");
		case "no-section":
			return t("untrack.syncFirst.noSection");
		case "section-broken":
			return t("untrack.syncFirst.sectionBroken");
		case "gitignore-not-sent":
			return t("untrack.syncFirst.gitignoreNotSent");
		case "pull-unfinished":
		case undefined:
			return t("untrack.syncFirst.pullUnfinished");
	}
}

/** What the report of an untracking is worded with, beside how it ended. */
export interface UntrackReportOptions {
	/** Whether it was stopped because the connection it ran with was changed. */
	readonly connectionChanged?: boolean;
}

/** The text for an untracking that was stopped before anything was taken out of the remote. */
export function untrackStoppedText(t: Translate, connectionChanged: boolean): string {
	return connectionChanged ? t("untrack.connectionChanged") : t("untrack.cancelled");
}

/**
 * Words what untracking answered: how it ended as the summary, and an
 * earlier push it found to have gone through as a message of its own.
 */
export function untrackReport(t: Translate, result: UntrackRunResult, options: UntrackReportOptions = {}): PullReport {
	const details: string[] = [];
	if (result.recovered !== null) details.push(recoveredPushText(t, result.recovered));
	if (result.recoveredUntrack !== undefined) details.push(recoveredUntrackText(t, result.recoveredUntrack));
	return { summary: summaryText(t, result, options.connectionChanged === true), details };
}

function summaryText(t: Translate, result: UntrackRunResult, connectionChanged: boolean): string {
	switch (result.outcome) {
		case "untracked":
			return t("untrack.done", { count: result.untracked.length });
		case "nothing-to-untrack":
			return t("untrack.nothing");
		case "sync-first":
			return refusalText(t, result.reason);
		case "remote-moved":
			return t("untrack.remoteMoved");
		case "cancelled":
			return untrackStoppedText(t, connectionChanged);
	}
}

/**
 * Words the untracking of `runUntrackSync`, also where it was not got to.
 * The pull and the push before it are worded by their own reports
 * (`pullReport`, `pushReport`), as they come in.
 *
 * Stopped because the connection was changed, it says that and nothing of
 * the step it was stopped in: a question that was open then is closed as a
 * "no", and it was not the user who said no.
 */
export function untrackSyncReport(
	t: Translate,
	result: UntrackSyncResult,
	options: UntrackReportOptions = {},
): PullReport {
	if (result.untrack !== null) return untrackReport(t, result.untrack, options);
	const connectionChanged = options.connectionChanged === true;
	if (connectionChanged) return { summary: untrackStoppedText(t, true), details: [] };
	switch (result.skipped) {
		case "pull-declined":
			return { summary: t("untrack.skipped.pullDeclined"), details: [] };
		case "pull-cancelled":
			return { summary: t("untrack.skipped.pullCancelled"), details: [] };
		case "push-not-done":
			return { summary: t("untrack.skipped.pushNotDone"), details: [] };
		case "cancelled":
		case undefined:
			return { summary: untrackStoppedText(t, false), details: [] };
	}
}

/**
 * Whether the untracking was stopped (`requestStop`, or a change of the
 * connection) before anything was taken out of the remote: itself, between
 * the steps, or in the pull before it. That is told like a pull or a push
 * that was stopped, and leaves nothing to act on.
 */
export function untrackStopped(result: UntrackSyncResult): boolean {
	if (result.untrack !== null) return result.untrack.outcome === "cancelled";
	return result.skipped === "cancelled" || result.skipped === "pull-cancelled" || result.skipped === undefined;
}

/**
 * Whether files were taken out of the remote. Anything else is a reason why
 * not, which stays on the screen until it is dismissed, unless it is only
 * that the untracking was stopped (`untrackStopped`).
 */
export function untrackedSome(result: UntrackSyncResult): boolean {
	return result.untrack?.outcome === "untracked";
}

/**
 * The text for an untracking that ended by throwing: of `runUntrack` itself.
 * A pull or a push before it that threw is told as that
 * (`pullFailureText`, `pushFailureText`).
 */
export function untrackFailureText(
	t: Translate,
	settings: DeviceSettings,
	error: unknown,
	connectionChanged = false,
): string {
	if (error instanceof BackendError && error.kind === "cancelled") return untrackStoppedText(t, connectionChanged);
	return t("untrack.failed", { reason: failureReason(t, settings, error) });
}
