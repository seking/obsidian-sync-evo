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

import { describe, expect, test } from "vitest";
import { translatorFor } from "../src/core/i18n";
import { dateTime, type NoticeLevel, type PartReport, type ReportDetail } from "../src/core/pull-report";
import {
	cut,
	keepResult,
	partNotices,
	partResults,
	readResults,
	RESULTS_KEPT,
	resultsText,
	type SyncResult,
} from "../src/core/sync-results";

const t = translatorFor("en");
const MORE = t("notice.seeResults");

/** A detail whose notice says `text`, and the screen `full`; "info" has `brief` as its short line. */
function detail(level: NoticeLevel, text: string, full = text, brief?: string): ReportDetail {
	return { text, full, ...(brief === undefined ? {} : { brief }), level, standing: false };
}

const part = (over: Partial<PartReport>): PartReport => ({ summary: "Download finished.", level: "info", details: [], ...over });

describe("the notices of a part of a sync the user started", () => {
	test("a summary with what is only worth knowing goes by itself, with a short line for each", () => {
		const notices = partNotices(
			t,
			part({ details: [detail("info", "2 files were moved to .trash/:\na.md\nb.md", undefined, "2 files were moved.")] }),
		);
		expect(notices).toEqual([{ text: `Download finished.\n2 files were moved.\n\n${MORE}`, level: "info", stays: false }]);
	});

	test("a summary alone goes by itself", () => {
		expect(partNotices(t, part({}))).toEqual([{ text: "Download finished.", level: "info", stays: false }]);
	});

	test("what there is to see to makes one notice that stays: the summary, the short lines, then what to see to", () => {
		const notices = partNotices(
			t,
			part({
				details: [
					detail("warn", "A conflict."),
					detail("info", "Moved to the trash:\na.md", undefined, "1 file was moved."),
					detail("warn", "Not downloaded."),
				],
			}),
		);
		expect(notices).toEqual([
			{
				text: `Download finished.\n1 file was moved.\n\nA conflict.\n\nNot downloaded.\n\n${MORE}`,
				level: "warn",
				stays: true,
			},
		]);
	});

	test("what went wrong is a notice of its own, before the rest", () => {
		const notices = partNotices(t, part({ details: [detail("warn", "A conflict."), detail("error", "It failed.")] }));
		expect(notices).toEqual([
			{ text: "It failed.", level: "error", stays: true },
			{ text: "Download finished.\n\nA conflict.", level: "warn", stays: true },
		]);
	});

	test("a summary that is to be seen to stays by itself", () => {
		expect(partNotices(t, part({ summary: "Nothing was uploaded.", level: "warn" }))).toEqual([
			{ text: "Nothing was uploaded.", level: "warn", stays: true },
		]);
	});

	test("the last line says where all of it is, only when something was left out", () => {
		const shortened = detail("warn", "Not sent:\na.md\n…and 1 more", "Not sent:\na.md\nb.md");
		expect(partNotices(t, part({ details: [shortened] }))[0]?.text.endsWith(`\n\n${MORE}`)).toBe(true);
		expect(partNotices(t, part({ details: [detail("warn", "A conflict.")] }))[0]?.text).not.toContain(MORE);
		// A short line in the place of what is only worth knowing leaves out the rest of it.
		const briefed = detail("info", "Moved:\na.md", undefined, "1 file was moved.");
		expect(partNotices(t, part({ details: [briefed] }))).toEqual([
			{ text: `Download finished.\n1 file was moved.\n\n${MORE}`, level: "info", stays: false },
		]);
	});

	test("without a summary, the details alone, and nothing where there are none", () => {
		expect(partNotices(t, part({ summary: "" }))).toEqual([]);
		expect(partNotices(t, part({ summary: "", details: [detail("warn", "A conflict.")] }))).toEqual([
			{ text: "A conflict.", level: "warn", stays: true },
		]);
		expect(partNotices(t, part({ summary: "", level: "warn" }))).toEqual([]);
	});

	test("the screen of the results gets every detail with every path", () => {
		const details = [detail("warn", "Not sent:\na.md\n…and 1 more", "Not sent:\na.md\nb.md"), detail("info", "Moved.")];
		expect(partResults(part({ details }))).toEqual([
			{ level: "warn", text: "Not sent:\na.md\nb.md" },
			{ level: "info", text: "Moved." },
		]);
	});
});

describe("what a notice leaves out", () => {
	test("paths past the first few", () => {
		expect(cut(detail("warn", "a\n…and 1 more", "a\nb"))).toBe(true);
		expect(cut(detail("warn", "a\nb"))).toBe(false);
	});

	test("of what is only worth knowing, all but its short line", () => {
		expect(cut(detail("info", "Moved:\na.md", undefined, "1 file was moved."))).toBe(true);
		expect(cut(detail("info", "Pushed.", undefined, "Pushed."))).toBe(false);
		expect(cut(detail("info", "Pushed."))).toBe(false);
	});
});

const result = (at: number, over: Partial<SyncResult> = {}): SyncResult => ({
	at,
	automatic: false,
	summaries: [],
	items: [{ level: "warn", text: "A conflict." }],
	...over,
});

describe("the syncs the screen keeps", () => {
	test("the newest first, and no more than the limit", () => {
		let kept: SyncResult[] = [];
		for (let at = 1; at <= RESULTS_KEPT + 5; at++) kept = keepResult(kept, result(at));
		expect(RESULTS_KEPT).toBe(20);
		expect(kept).toHaveLength(RESULTS_KEPT);
		expect(kept[0]?.at).toBe(RESULTS_KEPT + 5);
		expect(kept[RESULTS_KEPT - 1]?.at).toBe(6);
	});

	test("what was stored is read as far as it is syncs, and nothing else is a reason to fail", () => {
		const good = result(1, { automatic: true, summaries: ["Done."], items: [{ level: "info", text: "Moved." }] });
		expect(readResults([good])).toEqual([good]);
		for (const stored of [undefined, null, "x", 42, {}]) expect(readResults(stored)).toEqual([]);
		expect(
			readResults([
				null,
				"x",
				{ ...good, at: "1" },
				{ ...good, automatic: "no" },
				{ ...good, summaries: [1] },
				{ ...good, items: [{ level: "fatal", text: "x" }] },
				{ ...good, items: [{ level: "warn" }] },
				good,
			]),
		).toEqual([good]);
		expect(readResults(Array.from({ length: 30 }, (_, at) => result(at)))).toHaveLength(RESULTS_KEPT);
	});
});

describe("the syncs as text to copy", () => {
	test("each under the time it ended and who started it, its summaries, and its things by level", () => {
		const text = resultsText(t, [
			result(2, {
				automatic: true,
				items: [
					{ level: "info", text: "Moved:\na.md" },
					{ level: "warn", text: "A conflict." },
					{ level: "error", text: "It failed." },
					{ level: "warn", text: "Not sent." },
				],
			}),
			result(1, { summaries: ["Download finished.", "Upload finished."] }),
		]);
		expect(text).toBe(
			[
				`# ${dateTime(2)}: automatic sync`,
				"",
				"## Errors",
				"It failed.",
				"",
				"## Needs attention",
				"A conflict.",
				"",
				"Not sent.",
				"",
				"## Notes",
				"Moved:\na.md",
				"",
				`# ${dateTime(1)}: sync`,
				"Download finished.",
				"Upload finished.",
				"",
				"## Needs attention",
				"A conflict.",
			].join("\n"),
		);
	});

	test("nothing kept is no text", () => {
		expect(resultsText(t, [])).toBe("");
	});
});
