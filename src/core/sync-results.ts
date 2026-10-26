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

// What a sync shows by how much each thing matters (E-2), and what it
// leaves on the screen of the results: the last syncs that had something
// to tell, each with every path, which a notice lists only the first of.

import {
	type CappedList,
	dateTime,
	type NoticeLevel,
	type PartReport,
	type QuestionPart,
	type ReportDetail,
} from "./pull-report";
import type { Translate } from "./i18n";

/** How many syncs the screen of the results keeps, the newest first. */
export const RESULTS_KEPT = 20;

/** One notice a sync shows: its text, how much it matters, and whether it stays until it is tapped. */
export interface ShownNotice {
	readonly text: string;
	readonly level: NoticeLevel;
	readonly stays: boolean;
	/** One of `AutoReport.questions`, which a sync the user starts takes down. */
	readonly question?: boolean;
}

/** One thing a sync told, with every path. */
export interface ResultItem {
	readonly level: NoticeLevel;
	/** What is copied, and what the screen shows without `parts`. */
	readonly text: string;
	/** What the screen shows in place of `text`, with what is long folded (`ReportDetail.parts`). */
	readonly parts?: readonly QuestionPart[];
}

/** A sync that had something to tell, as the screen of the results shows it. */
export interface SyncResult {
	/** When it ended. */
	readonly at: number;
	/** Whether it started by itself. */
	readonly automatic: boolean;
	/** How each of its parts ended, in a line or two each. */
	readonly summaries: readonly string[];
	readonly items: readonly ResultItem[];
}

export function resultItem(detail: ReportDetail): ResultItem {
	return { level: detail.level, text: detail.full, ...(detail.parts === undefined ? {} : { parts: detail.parts }) };
}

/** Whether a notice leaves out some of what a detail says: paths past the first few, or all of it but a line. */
export function cut(detail: ReportDetail): boolean {
	return (detail.level === "info" ? (detail.brief ?? detail.text) : detail.text) !== detail.full;
}

/** Texts as paragraphs of one notice. */
export function paragraphs(texts: readonly string[]): string {
	return texts.filter((text) => text !== "").join("\n\n");
}

/**
 * The notices a part of a sync the user started is told with:
 *
 * - What went wrong, in a notice of its own that stays.
 * - Where there is something to see to: one notice that stays, with the
 *   summary first, then a short line for each thing only worth knowing,
 *   then what there is to see to.
 * - Else the summary with those short lines, which goes by itself.
 *
 * Where a notice leaves out some of what there is, its last line says
 * where all of it is. `summary` may be empty: then the part tells only its
 * details, and nothing when it has none.
 */
export function partNotices(t: Translate, part: PartReport): ShownNotice[] {
	const notices: ShownNotice[] = [];
	const errors = part.details.filter((detail) => detail.level === "error");
	if (errors.length > 0) {
		notices.push({ text: paragraphs(errors.map((detail) => detail.text)), level: "error", stays: true });
	}
	const warns = part.details.filter((detail) => detail.level === "warn");
	const infos = part.details.filter((detail) => detail.level === "info");
	const head = [part.summary, ...infos.map((detail) => detail.brief ?? detail.text)]
		.filter((line) => line !== "")
		.join("\n");
	const more = [...warns, ...infos].some(cut) ? t("notice.seeResults") : "";
	if (warns.length > 0 || (part.level !== "info" && part.summary !== "")) {
		const text = paragraphs([head, ...warns.map((detail) => detail.text), more]);
		notices.push({ text, level: part.level === "error" ? "error" : "warn", stays: true });
	} else if (head !== "") {
		notices.push({ text: paragraphs([head, more]), level: "info", stays: false });
	}
	return notices;
}

/** The things a part of a sync the user started leaves on the screen of the results. */
export function partResults(part: PartReport): ResultItem[] {
	return part.details.map(resultItem);
}

/** The syncs the screen keeps, with one more that ended. */
export function keepResult(results: readonly SyncResult[], result: SyncResult): SyncResult[] {
	return [result, ...results].slice(0, RESULTS_KEPT);
}

const LEVELS: readonly NoticeLevel[] = ["error", "warn", "info"];

/** The heading of each level on the screen of the results. */
export function levelHeading(t: Translate, level: NoticeLevel): string {
	switch (level) {
		case "error":
			return t("results.error");
		case "warn":
			return t("results.warn");
		case "info":
			return t("results.info");
	}
}

/** The things of one sync, by level in the order the screen shows them, each with its heading. */
export function resultSections(
	t: Translate,
	result: SyncResult,
): { readonly heading: string; readonly items: readonly ResultItem[] }[] {
	return LEVELS.flatMap((level) => {
		const items = result.items.filter((item) => item.level === level);
		return items.length === 0 ? [] : [{ heading: levelHeading(t, level), items }];
	});
}

/** The line a sync is headed with: when it ended, and who started it. */
export function resultTitle(t: Translate, result: SyncResult): string {
	return t(result.automatic ? "results.automatic" : "results.manual", { time: dateTime(result.at) });
}

/** The syncs the screen keeps, as text to copy: the newest first. */
export function resultsText(t: Translate, results: readonly SyncResult[]): string {
	return results
		.map((result) => {
			const lines = [`# ${resultTitle(t, result)}`, ...result.summaries];
			for (const section of resultSections(t, result)) {
				lines.push("", `## ${section.heading}`, paragraphs(section.items.map((item) => item.text)));
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

/**
 * The syncs of what was stored, as far as they are syncs: what an older or
 * a newer version wrote, or a store that broke, is left out, and not a
 * reason to fail.
 */
export function readResults(stored: unknown): SyncResult[] {
	if (!Array.isArray(stored)) return [];
	return stored
		.filter(isSyncResult)
		.slice(0, RESULTS_KEPT)
		.map((result) => ({ ...result, items: result.items.map(drawable) }));
}

function isSyncResult(value: unknown): value is SyncResult {
	if (typeof value !== "object" || value === null) return false;
	const { at, automatic, summaries, items } = value as Record<string, unknown>;
	return (
		typeof at === "number" &&
		typeof automatic === "boolean" &&
		Array.isArray(summaries) &&
		summaries.every((line) => typeof line === "string") &&
		Array.isArray(items) &&
		items.every(isResultItem)
	);
}

function isResultItem(value: unknown): value is ResultItem {
	if (typeof value !== "object" || value === null) return false;
	const { level, text } = value as Record<string, unknown>;
	return typeof text === "string" && LEVELS.includes(level as NoticeLevel);
}

// Parts that another version stored and this one cannot draw are let go
// of: the item is then shown as its text, which says all of it.
function drawable(item: ResultItem): ResultItem {
	const parts: unknown = item.parts;
	if (parts === undefined || (Array.isArray(parts) && parts.every(isQuestionPart))) return item;
	return { level: item.level, text: item.text };
}

function isQuestionPart(value: unknown): value is QuestionPart {
	if (typeof value !== "object" || value === null) return false;
	const { text, paths, folded } = value as Record<string, unknown>;
	if (typeof text !== "string" || (paths !== undefined && !isPathList(paths))) return false;
	if (folded === undefined) return true;
	if (typeof folded !== "object" || folded === null) return false;
	const fold = folded as Record<string, unknown>;
	return isPathList(fold.paths) && Array.isArray(fold.notes) && fold.notes.every((note) => typeof note === "string");
}

function isPathList(value: unknown): value is CappedList<string> {
	if (typeof value !== "object" || value === null) return false;
	const { shown, more } = value as Record<string, unknown>;
	return Array.isArray(shown) && shown.every((path) => typeof path === "string") && typeof more === "number";
}
