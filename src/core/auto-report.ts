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

// What a sync that started by itself tells, and what it remembers of having
// told it. Nobody is looking when it runs, and it runs every few minutes:
// a sync that went well says nothing, and a device without a network is
// told so once, not on every try.
//
// What a sync has to tell is of two kinds (`ReportDetail`). What happened in
// it is always told, as by a sync the user starts. What stands in its way,
// which the next sync will meet again, is told once per cause: the cause is
// remembered, and nothing of this kind is told while a sync ends with the
// same one.
//
// Everything it tells starts with a line that says where it comes from:
// nobody pressed anything.

import type { AutoSyncMemory } from "./auto-sync";
import { BackendError } from "./backend";
import type { NotReadyReason } from "./connection-check";
import type { Translate } from "./i18n";
import type { DeferReason, PullResult } from "./pull-io";
import {
	pullDetails,
	type PullReportOptions,
	pullSummaryText,
	type StateProblem,
	stateProblemText,
} from "./pull-report";
import type { PushRunResult } from "./push";
import { pushDetails, type PushReportOptions, pushSummaryText } from "./push-report";

/**
 * How a sync ended, as far as the next one that starts by itself cares:
 *
 * - "success": it did what a sync does. The interval is the one that is set.
 * - "failure": it could not. The interval is doubled (`intervalMs`).
 * - "waiting": it came to a question, which it leaves for a sync the user
 *   starts. Nothing went wrong: the interval is the one that is set.
 * - "neither": nothing to go by. It was stopped, or it met something that
 *   the next sync puts right by itself: another device pushed in between,
 *   or a file was being typed in.
 */
export type SyncEnd = "success" | "failure" | "waiting" | "neither";

/** A sync, or a part of one, as a sync that starts by itself tells it. */
export interface AutoReport {
	/** What happened in this sync. Always shown. */
	readonly happened: readonly string[];
	/** What stands in the way. Shown when `cause` is not the one that was last told. */
	readonly standing: readonly string[];
	/**
	 * What `standing` is about: the same text for as long as the same thing
	 * is wrong. `null` when nothing is. Where it is about files of the
	 * vault that have to be seen to one by one (a file that cannot be read,
	 * or is not sent), it carries a digest of their paths (`filesDigest`),
	 * so that another file that joins them is told. Where it is about the
	 * sync as a whole (no network, a question that waits), it carries none.
	 */
	readonly cause: string | null;
	readonly end: SyncEnd;
}

const NOTHING: AutoReport = { happened: [], standing: [], cause: null, end: "neither" };

// The reasons a file is put off that are told (`pull-report.ts`). The others
// are an editor in the middle of typing: no text tells them, and the next
// sync takes the file.
const TOLD_DEFERRALS: readonly DeferReason[] = [
	"fetch-failed",
	"hash-mismatch",
	"trash-failed",
	"unreadable",
	"not-downloaded",
];

/** A text under the line that says it comes from a sync nobody started. */
function headed(t: Translate, text: string): string {
	return `${t("auto.heading")}\n${text}`;
}

/**
 * A short text that is the same for the same set of paths, in whatever
 * order, and another for another set (FNV-1a, 32 bits, over the sorted
 * paths). It only has to tell "the same files as last time" from "not the
 * same": two sets that collide cost one notice that is not shown.
 */
export function filesDigest(paths: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const path of [...new Set(paths)].sort()) {
		// The end of each path is part of what is hashed: "a", "b" is not "ab".
		for (const unit of `${path}\n`) {
			hash ^= unit.codePointAt(0) ?? 0;
			hash = Math.imul(hash, 0x01000193);
		}
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// The reasons a file is put off that are about that file, on this device.
const FILE_DEFERRALS: readonly DeferReason[] = ["unreadable", "not-downloaded"];

function kindOf(error: unknown): string {
	return error instanceof BackendError ? error.kind : "other";
}

function isCancellation(error: unknown): boolean {
	return error instanceof BackendError && error.kind === "cancelled";
}

/** A pull, as a sync that started by itself tells it. */
export function pullAutoReport(t: Translate, result: PullResult, options: PullReportOptions): AutoReport {
	const details = pullDetails(t, result, options);
	const happened = details.filter((detail) => !detail.standing).map((detail) => headed(t, detail.text));
	const standing = details.filter((detail) => detail.standing).map((detail) => headed(t, detail.text));

	switch (result.outcome) {
		case "completed":
		case "remote-empty":
			return { happened, standing: [], cause: null, end: "success" };
		case "waiting":
			return {
				happened,
				standing: [headed(t, pullSummaryText(t, result))],
				cause: `pull:waiting:${result.waitingFor ?? "deletions"}`,
				end: "waiting",
			};
		case "incomplete": {
			if (isCancellation(result.fetchError)) return { ...NOTHING, happened };
			const reasons = new Set<string>();
			if (result.fetchError !== undefined) reasons.add(`error:${kindOf(result.fetchError)}`);
			for (const reason of TOLD_DEFERRALS) {
				const paths = result.deferred.filter((file) => file.reason === reason).map((file) => file.path);
				if (paths.length === 0) continue;
				reasons.add(FILE_DEFERRALS.includes(reason) ? `${reason}#${filesDigest(paths)}` : reason);
			}
			// Files that were being typed in, and nothing else.
			if (reasons.size === 0) return { ...NOTHING, happened };
			return { happened, standing, cause: `pull:incomplete:${[...reasons].sort().join(",")}`, end: "failure" };
		}
		case "declined":
		case "cancelled":
			return { ...NOTHING, happened };
	}
}

/** A push, as a sync that started by itself tells it. */
export function pushAutoReport(t: Translate, result: PushRunResult, options: PushReportOptions): AutoReport {
	const details = pushDetails(t, result, options);
	const happened = details.filter((detail) => !detail.standing).map((detail) => headed(t, detail.text));
	const standing = details.filter((detail) => detail.standing).map((detail) => headed(t, detail.text));

	// What the texts of the files that were not sent are about, each with
	// which files.
	const causes: string[] = [];
	if (result.held.length > 0) causes.push(`push:held#${filesDigest(result.held)}`);
	const inTheWay = result.refused.filter((file) => file.reason === "remote-in-the-way").map((file) => file.path);
	if (inTheWay.length > 0) causes.push(`push:in-the-way#${filesDigest(inTheWay)}`);
	const leftOut = [...new Set(result.leftOut.map((file) => file.reason))].sort();
	if (leftOut.length > 0) {
		// With the reason of each: a file that is left out for another
		// reason now is news too.
		const files = result.leftOut.map((file) => `${file.reason} ${file.path}`);
		causes.push(`push:left-out:${leftOut.join(",")}#${filesDigest(files)}`);
	}

	let end: SyncEnd;
	switch (result.outcome) {
		case "pushed":
		case "nothing-to-push":
			end = "success";
			break;
		case "pull-first":
			// Another device pushed in between. The next sync pulls first,
			// which is all there is to do about it.
			if (result.reason === "remote-moved") {
				end = "neither";
				break;
			}
			end = "failure";
			causes.unshift(`push:pull-first:${result.reason ?? "no-base"}`);
			standing.unshift(headed(t, pushSummaryText(t, result)));
			break;
		case "waiting":
			end = "waiting";
			causes.unshift(`push:waiting:${result.waitingFor ?? "deletions"}`);
			standing.unshift(headed(t, pushSummaryText(t, result)));
			break;
		case "declined":
		case "cancelled":
			end = "neither";
			break;
	}
	return { happened, standing, cause: causes.length === 0 ? null : causes.join(" "), end };
}

/**
 * A sync that ended by throwing. `text` is what a sync the user started
 * shows for it (`pullFailureText`, `pushFailureText`). The cause is the kind
 * of the failure alone, whichever part of the sync met it: without a
 * network, it is the same one every time.
 */
export function failureAutoReport(t: Translate, error: unknown, text: string): AutoReport {
	if (isCancellation(error)) return NOTHING;
	return { happened: [], standing: [headed(t, text)], cause: `error:${kindOf(error)}`, end: "failure" };
}

/**
 * A sync that started by itself and found the settings lacking something a
 * request needs: the token, for one. `text` is what a sync the user started
 * shows for it (`connectionCheckText`). A failure like any other, so that
 * it is told once and tried again after the interval, and not at every look
 * at the clock.
 */
export function notReadyAutoReport(t: Translate, reason: NotReadyReason, text: string): AutoReport {
	return { happened: [], standing: [headed(t, text)], cause: `not-ready:${reason}`, end: "failure" };
}

/** A sync that had no sync state to run with. */
export function stateAutoReport(t: Translate, problem: StateProblem): AutoReport {
	return {
		happened: [],
		standing: [headed(t, stateProblemText(t, problem))],
		cause: `state:${problem}`,
		end: "failure",
	};
}

const END_ORDER: readonly SyncEnd[] = ["success", "neither", "waiting", "failure"];

/**
 * The parts of one sync as one: the pull, and then the push or the failure
 * that ended it. It ended as its worst part did, and its cause is all of
 * theirs.
 */
export function joinAutoReports(parts: readonly AutoReport[]): AutoReport {
	if (parts.length === 0) return NOTHING;
	const causes = parts.map((part) => part.cause).filter((cause): cause is string => cause !== null);
	return {
		happened: parts.flatMap((part) => part.happened),
		standing: parts.flatMap((part) => part.standing),
		cause: causes.length === 0 ? null : causes.join(" "),
		end: parts.reduce<SyncEnd>(
			(worst, part) => (END_ORDER.indexOf(part.end) > END_ORDER.indexOf(worst) ? part.end : worst),
			"success",
		),
	};
}

export interface AutoSettled {
	/** What is remembered from here on. `lastStartedAt` is as it was given. */
	readonly memory: AutoSyncMemory;
	/** Whether `AutoReport.standing` is shown by a sync that started by itself: its cause was not the one last told. */
	readonly tell: boolean;
}

/**
 * What a sync that has ended leaves remembered, and whether what stands in
 * its way is told. Not asked for a sync that was stopped: that is neither
 * a success nor a failure, and leaves everything as it was.
 *
 * `automatic`: whether the sync started by itself. One the user started
 * has shown everything itself, so its cause counts as told; and only the
 * automatic ones are counted as failures in a row, which a success of
 * either kind ends.
 */
export function settleAutoSync(memory: AutoSyncMemory, report: AutoReport, automatic: boolean): AutoSettled {
	const { cause, end } = report;
	const tell = cause !== null && cause !== memory.told;
	// Forgotten once a sync went well with nothing in its way, so that the
	// same cause is told again when it comes back.
	const told = cause !== null ? cause : end === "success" ? null : memory.told;
	let failures = memory.failures;
	if (end === "success" || (automatic && end === "waiting")) failures = 0;
	else if (automatic && end === "failure") failures += 1;
	return { memory: { lastStartedAt: memory.lastStartedAt, failures, told }, tell };
}

/** The texts a sync that started by itself shows, each until it is dismissed. */
export function autoTexts(report: AutoReport, tell: boolean): string[] {
	return [...report.happened, ...(tell ? report.standing : [])];
}
