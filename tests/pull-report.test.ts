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

import { describe, expect, test } from "vitest";
import { BackendError, type BackendErrorKind, RateLimitedError } from "../src/core/backend";
import { translatorFor } from "../src/core/i18n";
import { NOTICE_KINDS } from "../src/core/notices";
import type { PullResult } from "../src/core/pull-io";
import {
	capList,
	clockTime,
	failureReason,
	firstFetchQuestion,
	listText,
	pullFailureText,
	pullProgressText,
	pullReport,
	type StateProblem,
	stateProblemText,
} from "../src/core/pull-report";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

const t = translatorFor("en");
const ja = translatorFor("ja");

const settings: DeviceSettings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	deviceName: "Mac",
	autoSync: DEFAULT_AUTO_SYNC,
};
const options = { settings, sizeLimit: 50 * 1024 * 1024 };

const result = (over: Partial<PullResult> = {}): PullResult => ({
	outcome: "completed",
	revision: "a".repeat(40),
	remoteEmpty: false,
	rewritten: false,
	counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
	conflicts: [],
	replacedSettings: [],
	trashed: [],
	halfWritten: [],
	halfCopies: [],
	deferred: [],
	unwritable: [],
	keptLocal: [],
	tidiedCopies: [],
	keptUnsent: [],
	newSymlinks: [],
	notices: [],
	closedViews: false,
	refetched: 0,
	...over,
});

describe("lists", () => {
	test("capList keeps the first items and counts the rest", () => {
		expect(capList(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], more: 1 });
		expect(capList(["a", "b"], 2)).toEqual({ shown: ["a", "b"], more: 0 });
		expect(capList([], 2)).toEqual({ shown: [], more: 0 });
	});

	test("listText puts the count of what was left out last", () => {
		expect(listText(t, ["a", "b", "c"], 2)).toBe("a\nb\n…and 1 more");
		expect(listText(t, ["a", "b"], 2)).toBe("a\nb");
	});
});

describe("pullProgressText", () => {
	test("a phase with a count shows it", () => {
		expect(pullProgressText(t, { phase: "applying", done: 3, total: 10, closedViews: false })).toBe(
			"Pull: updating files (3/10)…",
		);
		expect(pullProgressText(t, { phase: "hashing", done: 3, total: 10, closedViews: false })).toBe(
			"Pull: comparing files (3/10)…",
		);
	});

	test("a phase whose count is not known shows none", () => {
		expect(pullProgressText(t, { phase: "applying", done: 0, total: 0, closedViews: false })).toBe(
			"Pull: updating files…",
		);
		expect(pullProgressText(t, { phase: "listing", done: 0, total: 0, closedViews: false })).toBe(
			"Pull: checking the remote…",
		);
	});

	test("while everything is downloaded at once, that is told in place of a count", () => {
		const downloading = { phase: "applying", done: 2, total: 6655, closedViews: false, archive: "downloading" } as const;
		expect(pullProgressText(t, downloading)).toBe("Pull: downloading all files at once…");
		const waiting = { ...downloading, archive: "waiting" } as const;
		expect(pullProgressText(t, waiting)).toBe("Pull: waiting for the download of the stopped pull to end…");
		expect(pullProgressText(ja, waiting)).toBe("取り込み：中止した取り込みの取得が終わるのを待っています…");
		expect(pullProgressText(ja, downloading)).toBe("取り込み：全ファイルをまとめて取得中…");
	});

	test("a download that is tried again tells to keep the app in front", () => {
		const retrying = { phase: "applying", done: 0, total: 6655, closedViews: false, archive: "retrying" } as const;
		expect(pullProgressText(t, retrying).split("\n")).toEqual([
			"Pull: downloading all files at once…",
			"The last download did not finish. Keep Obsidian in front and wait until this one is done.",
		]);
		expect(pullProgressText(ja, retrying).split("\n")).toEqual([
			"取り込み：全ファイルをまとめて取得中…",
			"前回は、取得が終わりませんでした。終わるまで、Obsidian を前に出したまま待ってください。",
		]);
	});

	test("once the download is over, nothing of it is told any more, also after one that was tried again", () => {
		const retrying = { phase: "applying", done: 0, total: 6655, closedViews: false, archive: "retrying" } as const;
		expect(pullProgressText(t, retrying).split("\n")).toHaveLength(2);
		// The same pull, with the download behind it.
		const { archive: _over, ...counting } = retrying;
		expect(pullProgressText(t, counting)).toBe("Pull: updating files (0/6655)…");
		expect(pullProgressText(t, { ...counting, done: 12 })).toBe("Pull: updating files (12/6655)…");
		expect(pullProgressText(ja, { ...counting, done: 12 })).toBe("取り込み：ファイルを更新中（12/6655）…");
	});

	test("closed graph views are told for as long as they are closed", () => {
		const text = pullProgressText(t, { phase: "applying", done: 3, total: 10, closedViews: true });
		expect(text.split("\n")).toEqual([
			"Pull: updating files (3/10)…",
			"Graph views are closed while the files are written. They reopen when the pull ends.",
		]);
	});

	// Times of this device's own time zone, so that the texts read the same wherever the tests run.
	const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 9, 7, hours, minutes, seconds).getTime();
	const applying = { phase: "applying", done: 3, total: 10, closedViews: false } as const;

	test("a wait for the request limit is told with the time it ends", () => {
		const text = pullProgressText(t, applying, { waitingUntil: at(14, 5), quota: null });
		expect(text.split("\n")).toEqual([
			"Pull: updating files (3/10)…",
			"GitHub's request limit was reached. The pull continues at 14:05. You can close the app: the next sync continues from where it stopped.",
		]);
		expect(pullProgressText(ja, applying, { waitingUntil: at(14, 5), quota: null }).split("\n")[1]).toBe(
			"GitHub のリクエスト数の上限に達しました。14:05 に続きを取り込みます。アプリを閉じても、次の同期で続きから進みます。",
		);
	});

	test("the time shown is never before the one that is waited for", () => {
		const text = pullProgressText(t, applying, { waitingUntil: at(9, 59, 1), quota: null });
		expect(text).toContain("continues at 10:00.");
	});

	test("a fetch that does not fit in the quota is told with what fits and when the rest continues", () => {
		const quota = { fetchable: 4990, resumesAt: at(8, 30) };
		expect(pullProgressText(t, applying, { waitingUntil: null, quota }).split("\n")).toEqual([
			"Pull: updating files (3/10)…",
			"About 4990 files can be fetched before GitHub's request limit is reached. The rest continues after 08:30.",
		]);
		expect(pullProgressText(ja, applying, { waitingUntil: null, quota }).split("\n")[1]).toBe(
			"GitHub のリクエスト数の上限までに取得できるのは、約 4990 件です。残りは 08:30 以降に取り込みます。",
		);
		expect(pullProgressText(t, applying, { waitingUntil: null, quota: { ...quota, fetchable: 1 } })).toContain(
			"About 1 file can be fetched",
		);
	});

	test("while it waits, the wait is told and not the quota", () => {
		const quota = { fetchable: 4990, resumesAt: at(8, 30) };
		const lines = pullProgressText(t, applying, { waitingUntil: at(8, 31), quota }).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("continues at 08:31");
	});

	test("the request limit comes before the graph views, and any phase can show it", () => {
		const text = pullProgressText(
			t,
			{ phase: "listing", done: 0, total: 0, closedViews: true },
			{ waitingUntil: at(14, 5), quota: null },
		);
		expect(text.split("\n").map((line) => line.slice(0, 12))).toEqual(["Pull: checki", "GitHub's req", "Graph views "]);
	});

	test("clockTime is the time of day on the device, to the minute", () => {
		expect(clockTime(at(0, 0))).toBe("00:00");
		expect(clockTime(at(7, 5, 59))).toBe("07:05");
		expect(clockTime(at(23, 59))).toBe("23:59");
	});
});

describe("the summary", () => {
	test("files that were not taken from the download of all files are counted on a line of their own", () => {
		const counts = { fetched: 6655, deleted: 0, renamed: 0, conflicts: 0 };
		const report = pullReport(t, result({ counts, refetched: 12 }), options);
		expect(report.summary.split("\n")).toEqual([
			"Pull finished: 6655 files fetched.",
			"12 files were missing from the download of all files, or differed from GitHub's listing there. They were fetched one by one.",
		]);
		expect(report.details).toEqual([]);
		expect(pullReport(t, result({ counts, refetched: 1 }), options).summary.split("\n")[1]).toBe(
			"1 file was missing from the download of all files, or differed from GitHub's listing there. It was fetched on its own.",
		);
		expect(pullReport(ja, result({ counts, refetched: 12 }), options).summary.split("\n")[1]).toBe(
			"12 件のファイルは、まとめて取得した中に無いか、中身が GitHub の一覧と合わなかったため、1件ずつ取得しました。",
		);
		expect(pullReport(t, result({ counts }), options).summary).toBe("Pull finished: 6655 files fetched.");
	});

	test("nothing changed", () => {
		expect(pullReport(t, result(), options)).toEqual({
			summary: "Nothing to pull. This device is up to date.",
			details: [],
		});
	});

	test("only what happened is counted, each in its own number", () => {
		const report = pullReport(t, result({ counts: { fetched: 1, deleted: 2, renamed: 0, conflicts: 0 } }), options);
		expect(report.summary).toBe("Pull finished: 1 file fetched, 2 files deleted.");
	});

	test("all four counts", () => {
		const counts = { fetched: 12, deleted: 1, renamed: 3, conflicts: 1 };
		expect(pullReport(t, result({ counts }), options).summary).toBe(
			"Pull finished: 12 files fetched, 1 file deleted, 3 files renamed, 1 conflict.",
		);
		expect(pullReport(ja, result({ counts }), options).summary).toBe(
			"取り込みが終わりました：取得 12 件、削除 1 件、名前の変更 3 件、競合 1 件",
		);
	});

	test("an empty remote", () => {
		const report = pullReport(t, result({ outcome: "remote-empty", revision: null, remoteEmpty: true }), options);
		expect(report.summary).toBe("The remote is empty: it has no commits yet. There is nothing to pull.");
	});

	test("declined", () => {
		expect(pullReport(t, result({ outcome: "declined" }), options).summary).toBe(
			"The pull was cancelled. Nothing was changed.",
		);
	});

	test("cancelled: what was done before is counted on a second line", () => {
		expect(pullReport(t, result({ outcome: "cancelled" }), options).summary).toBe(
			"The pull was stopped. The next pull continues from there.",
		);
		const counts = { fetched: 5, deleted: 1, renamed: 0, conflicts: 0 };
		expect(pullReport(t, result({ outcome: "cancelled", counts }), options).summary).toBe(
			"The pull was stopped. The next pull continues from there.\nDone before it stopped: 5 files fetched, 1 file deleted.",
		);
		expect(pullReport(ja, result({ outcome: "cancelled", counts }), options).summary).toBe(
			"取り込みを中止しました。次の取り込みで、続きから進みます。\n中止するまでに済んだ分：取得 5 件、削除 1 件",
		);
		// Nothing goes on from a pull that a change of the connection stopped.
		const changed = { ...options, connectionChanged: true };
		expect(pullReport(t, result({ outcome: "cancelled", counts }), changed).summary).toBe(
			"The pull was stopped because the connection was changed. The next pull starts with the new connection.",
		);
	});

	test("files a resuming pull moved to the trash are listed, whatever the outcome", () => {
		for (const outcome of ["completed", "cancelled", "declined", "incomplete"] as const) {
			const report = pullReport(t, result({ outcome, halfWritten: ["notes/a.md"] }), options);
			// Nothing in it says that this pull fetched the file: one that
			// was declined or stopped did not.
			expect(report.details).toEqual([
				"An earlier pull stopped while it was writing 1 file. What was left of it was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited the file since, you can get your edit back from there:\nnotes/a.md",
			]);
		}
		expect(pullReport(t, result({ halfWritten: ["a.md", "b.md"] }), options).details).toEqual([
			"An earlier pull stopped while it was writing 2 files. What was left of them was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited them since, you can get your edits back from there:\na.md\nb.md",
		]);
		expect(pullReport(ja, result({ halfWritten: ["a.md", "b.md"] }), options).details).toEqual([
			"前の取り込みが、2 件のファイルを書いている途中で止まっていました。残っていた内容は、この保管庫の .trash/ へ移しました。保存先の内容は、取り込みで取得します。その後に編集していた時は、そこから戻せます：\na.md\nb.md",
		]);
	});

	test("conflict copies that were tidied are counted, with how one is kept, and not listed", () => {
		const copies = ["_conflicts/20260901-120100 a (iPhone).md", "_conflicts/20260902-120100 b (Mac).md"];
		expect(pullReport(t, result({ tidiedCopies: copies.slice(0, 1) }), options).details).toEqual([
			"1 conflict copy in _conflicts/ was made 30 days ago or more, and was moved to .trash/ in this vault. To keep a copy, move it out of _conflicts/ or rename it.",
		]);
		expect(pullReport(t, result({ outcome: "incomplete", tidiedCopies: copies }), options).details).toEqual([
			"2 conflict copies in _conflicts/ were made 30 days ago or more, and were moved to .trash/ in this vault. To keep a copy, move it out of _conflicts/ or rename it.",
		]);
		expect(pullReport(ja, result({ tidiedCopies: copies }), options).details).toEqual([
			"作ってから30日たった競合の別名 2 件を、_conflicts/ からこの保管庫の .trash/ へ移しました。残したい別名は、_conflicts/ の外へ移すか、名前を変えてください。",
		]);
		expect(pullReport(t, result({ tidiedCopies: [] }), options).details).toEqual([]);
	});

	test("a half copy of a conflict that was moved to the trash has a text of its own", () => {
		const copy = "_conflicts/20261003-120100 a (iPhone).md";
		for (const outcome of ["completed", "cancelled", "declined", "incomplete"] as const) {
			expect(pullReport(t, result({ outcome, halfCopies: [copy] }), options).details).toEqual([
				`1 conflict copy that an earlier pull left unfinished was moved to .trash/ in this vault. A complete copy is made again. If you had edited the copy, your edit is there:\n${copy}`,
			]);
		}
		expect(pullReport(t, result({ halfCopies: [copy, "b.md"] }), options).details).toEqual([
			`2 conflict copies that an earlier pull left unfinished were moved to .trash/ in this vault. Complete copies are made again. If you had edited the copies, your edits are there:\n${copy}\nb.md`,
		]);
		expect(pullReport(ja, result({ halfCopies: [copy] }), options).details).toEqual([
			`前の取り込みが作りかけていた競合の別名 1 件を、この保管庫の .trash/ へ移しました。別名は作り直します。別名を編集していた時は、編集した内容がそこにあります：\n${copy}`,
		]);
		// Each list under its own text, the files first.
		const both = pullReport(t, result({ halfWritten: ["a.md"], halfCopies: [copy] }), options).details;
		expect(both).toHaveLength(2);
		expect(both[0]).toContain("while it was writing 1 file");
		expect(both[1]).toContain("1 conflict copy");
	});

	test("declined after a resuming pull moved files to the trash: not called unchanged", () => {
		const copy = "_conflicts/20261003-120100 a (iPhone).md";
		for (const moved of [{ halfWritten: ["a.md"] }, { halfCopies: [copy] }]) {
			expect(pullReport(t, result({ outcome: "declined", ...moved }), options).summary).toBe(
				"The pull was cancelled. Only the files listed below were moved to .trash/ in this vault. Nothing else was changed.",
			);
			expect(pullReport(ja, result({ outcome: "declined", ...moved }), options).summary).toBe(
				"取り込みをやめました。下に示すファイルだけを、この保管庫の .trash/ へ移しました。ほかは何も変更していません。",
			);
		}
		expect(pullReport(t, result({ outcome: "declined" }), options).summary).toBe(
			"The pull was cancelled. Nothing was changed.",
		);
	});

	test("a pull that kept files which differ from the remote is not called up to date", () => {
		expect(pullReport(t, result({ keptLocal: ["a.md"] }), options).summary).toBe("Pull finished.");
		expect(pullReport(ja, result({ keptLocal: ["a.md"] }), options).summary).toBe("取り込みが終わりました。");
		const counts = { fetched: 1, deleted: 0, renamed: 0, conflicts: 0 };
		expect(pullReport(t, result({ keptLocal: ["a.md"], counts }), options).summary).toBe(
			"Pull finished: 1 file fetched.",
		);
	});

	test("a pull that left files for later is not called up to date", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "changed-during-pull" }] }),
			options,
		);
		expect(report).toEqual({ summary: "Pull finished.", details: [] });
	});
});

describe("files left for the next sync", () => {
	test("typing is not a failure and is not told", () => {
		const report = pullReport(
			t,
			result({
				outcome: "incomplete",
				deferred: [
					{ path: "a.md", reason: "save-failed" },
					{ path: "b.md", reason: "changed-during-pull" },
					{ path: "c.md", reason: "depends-on-deferred" },
				],
			}),
			options,
		);
		expect(report.details).toEqual([]);
	});

	test("a fetch that failed is told with its reason and the number of files", () => {
		const report = pullReport(
			t,
			result({
				outcome: "incomplete",
				counts: { fetched: 2, deleted: 0, renamed: 0, conflicts: 0 },
				deferred: [
					{ path: "a.md", reason: "fetch-failed" },
					{ path: "b.md", reason: "fetch-failed" },
					{ path: "c.md", reason: "depends-on-deferred" },
					{ path: "d.md", reason: "changed-during-pull" },
				],
				fetchError: new BackendError("unreachable", "get blob: no response within 60000 ms"),
			}),
			options,
		);
		expect(report.summary).toBe("Pull finished: 2 files fetched.");
		expect(report.details).toEqual([
			"3 files could not be pulled and are left for the next sync. Could not reach GitHub. Check the network connection and try again.",
		]);
	});

	test("a half-written file that could not be moved away", () => {
		const deferred = [{ path: "a.md", reason: "trash-failed" }] as const;
		expect(pullReport(t, result({ outcome: "incomplete", deferred }), options).details).toEqual([
			"1 file could not be pulled and is left for the next sync. A file on this device could not be moved to .trash/ in this vault.",
		]);
		expect(pullReport(ja, result({ outcome: "incomplete", deferred }), options).details).toEqual([
			"1 件のファイルを取り込めませんでした。次の同期で、もう一度試します。このデバイスのファイルを、この保管庫の .trash/ へ移せませんでした。",
		]);
	});

	test("a failure with no file to count", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", fetchError: new RateLimitedError(0, "get blob: rate limited") }),
			options,
		);
		expect(report.details).toEqual([
			"Some files could not be pulled and are left for the next sync. GitHub's request limit has been reached. Try again later.",
		]);
	});

	test("content that did not match", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "hash-mismatch" }] }),
			options,
		);
		expect(report.details).toEqual([
			"1 file could not be pulled and is left for the next sync. The content GitHub sent did not match its own listing.",
		]);
	});

	test("a file that could not be read is told with its path", () => {
		const one = result({ outcome: "incomplete", deferred: [{ path: "notes/a.md", reason: "unreadable" }] });
		expect(pullReport(t, one, options).details).toEqual([
			"1 file on this device could not be read and was left as it is. Check it, then sync again:\nnotes/a.md",
		]);
		const two = result({
			outcome: "incomplete",
			deferred: [
				{ path: "a.md", reason: "unreadable" },
				{ path: "b.md", reason: "unreadable" },
			],
		});
		expect(pullReport(t, two, options).details).toEqual([
			"2 files on this device could not be read and were left as they are. Check them, then sync again:\na.md\nb.md",
		]);
		expect(pullReport(ja, two, options).details).toEqual([
			"このデバイスのファイル 2 件を読めませんでした。そのままにしてあります。ファイルを確かめてから、もう一度同期してください：\na.md\nb.md",
		]);
	});

	test("a file a cloud drive has not downloaded is told as that, with its path", () => {
		const one = result({ outcome: "incomplete", deferred: [{ path: "notes/big.md", reason: "not-downloaded" }] });
		expect(pullReport(t, one, options).details).toEqual([
			"1 file is not downloaded to this device (a cloud drive keeps only a placeholder). Download it, then sync again:\nnotes/big.md",
		]);
		const two = result({
			outcome: "incomplete",
			deferred: [
				{ path: "a.md", reason: "not-downloaded" },
				{ path: "b.md", reason: "not-downloaded" },
			],
		});
		expect(pullReport(t, two, options).details).toEqual([
			"2 files are not downloaded to this device (a cloud drive keeps only a placeholder). Download them, then sync again:\na.md\nb.md",
		]);
		expect(pullReport(ja, two, options).details).toEqual([
			"2 件のファイルが、このデバイスにダウンロードされていません（クラウドドライブが仮のファイルだけを置いています）。ダウンロードしてから、もう一度同期してください：\na.md\nb.md",
		]);
	});

	test("the paths of such files are listed up to a limit, and then counted", () => {
		for (const reason of ["not-downloaded", "unreadable"] as const) {
			const deferred = Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.md`, reason }));
			const [text] = pullReport(t, result({ outcome: "incomplete", deferred }), options).details;
			expect(text?.startsWith("8 files ")).toBe(true);
			expect(text?.split("\n").slice(1)).toEqual(["f0.md", "f1.md", "f2.md", "f3.md", "f4.md", "…and 3 more"]);
		}
	});

	test("each kind has a text of its own, beside the one for what failed otherwise", () => {
		const report = pullReport(
			t,
			result({
				outcome: "incomplete",
				deferred: [
					{ path: "bad.md", reason: "unreadable" },
					{ path: "big.md", reason: "not-downloaded" },
					{ path: "odd.md", reason: "hash-mismatch" },
				],
			}),
			options,
		);
		expect(report.details).toHaveLength(3);
		expect(report.details[0]).toBe(
			"1 file could not be pulled and is left for the next sync. The content GitHub sent did not match its own listing.",
		);
		expect(report.details[1]).toContain("not downloaded to this device");
		expect(report.details[1]).toContain("big.md");
		expect(report.details[2]).toContain("could not be read");
		expect(report.details[2]).toContain("bad.md");
	});

	test("the files that only wait for such a file are counted after it, when nothing else counts them", () => {
		const waiting = result({
			outcome: "incomplete",
			deferred: [
				{ path: "bad.md", reason: "unreadable" },
				{ path: "big.md", reason: "not-downloaded" },
				{ path: "c.md", reason: "depends-on-deferred" },
				{ path: "d.md", reason: "depends-on-deferred" },
			],
		});
		const details = pullReport(t, waiting, options).details;
		expect(details).toHaveLength(3);
		expect(details[0]).toContain("big.md");
		expect(details[1]).toContain("bad.md");
		expect(details[2]).toBe(
			"2 other files were not pulled either: they wait for a file that is left for the next sync. A later sync pulls them.",
		);
		expect(pullReport(ja, waiting, options).details[2]).toBe(
			"ほかに 2 件のファイルも、取り込んでいません。次の同期に残したファイルを待っています。後の同期で、取り込みます。",
		);

		// Counted by the text for what failed otherwise, and not a second time.
		const failed = result({
			outcome: "incomplete",
			deferred: [...waiting.deferred, { path: "odd.md", reason: "hash-mismatch" }],
		});
		const both = pullReport(t, failed, options).details;
		expect(both).toHaveLength(3);
		expect(both[0]).toBe(
			"3 files could not be pulled and are left for the next sync. The content GitHub sent did not match its own listing.",
		);
	});

	test("a pull that was declined left nothing for later, and says nothing of that", () => {
		const report = pullReport(
			t,
			result({
				outcome: "declined",
				deferred: [
					{ path: "bad.md", reason: "unreadable" },
					{ path: "big.md", reason: "not-downloaded" },
					{ path: "half.md", reason: "trash-failed" },
				],
			}),
			options,
		);
		expect(report.summary).toBe("The pull was cancelled. Nothing was changed.");
		expect(report.details).toEqual([]);
	});

	test("a fetch stopped by the signal is a stop, not a failure", () => {
		const report = pullReport(
			t,
			result({
				outcome: "incomplete",
				deferred: [{ path: "a.md", reason: "fetch-failed" }],
				fetchError: new BackendError("cancelled", "get blob: cancelled"),
			}),
			options,
		);
		expect(report).toEqual({ summary: "The pull was stopped. The next pull continues from there.", details: [] });
	});
});

describe("what the user has to know", () => {
	test("each conflict names its copy and says what is at the path now", () => {
		const report = pullReport(
			t,
			result({
				counts: { fetched: 1, deleted: 0, renamed: 0, conflicts: 4 },
				conflicts: [
					{ path: "a.md", copyPath: "_conflicts/20261003-221500 a (Mac).md", cause: "conflict" },
					{ path: "link", copyPath: "_conflicts/20261003-221500 link (Mac)", cause: "became-symlink" },
					{ path: "dir", copyPath: "_conflicts/20261003-221500 dir (Mac)", cause: "became-folder" },
					{ path: "Notes.md", copyPath: "_conflicts/20261003-221500 Notes (Mac).md", cause: "name-taken" },
				],
			}),
			options,
		);
		expect(report.details).toEqual([
			[
				"The content of 4 files on this device was kept under another name:",
				"_conflicts/20261003-221500 a (Mac).md (a conflict: a.md now has the content of the remote)",
				"_conflicts/20261003-221500 link (Mac) (link is a symbolic link on the remote now, which is not written to this device)",
				"_conflicts/20261003-221500 dir (Mac) (dir is a folder on the remote now)",
				"_conflicts/20261003-221500 Notes (Mac).md (the remote renamed another file to Notes.md)",
			].join("\n"),
		]);
	});

	test("many conflicts are counted in full and listed in part", () => {
		const conflicts = Array.from({ length: 12 }, (_, i) => ({
			path: `${i}.md`,
			copyPath: `${i}.copy.md`,
			cause: "conflict" as const,
		}));
		const [text = ""] = pullReport(t, result({ conflicts }), options).details;
		const lines = text.split("\n");
		expect(lines[0]).toContain("12 files");
		expect(lines).toHaveLength(12);
		expect(lines[11]).toBe("…and 2 more");
	});

	test("files in the configuration folder that got the content of the remote, apart from the conflicts", () => {
		const replaced = result({
			counts: { fetched: 3, deleted: 0, renamed: 0, conflicts: 0 },
			replacedSettings: [".obsidian/app.json", ".obsidian/appearance.json"],
		});
		expect(pullReport(t, replaced, options)).toEqual({
			summary: "Pull finished: 3 files fetched.",
			details: [
				"2 files in the configuration folder now have the content of the remote. What they held on this device before is in .trash/ in this vault:\n.obsidian/app.json\n.obsidian/appearance.json",
			],
		});
		expect(pullReport(ja, replaced, options)).toEqual({
			summary: "取り込みが終わりました：取得 3 件",
			details: [
				"設定フォルダのファイル 2 件を、保存先の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：\n.obsidian/app.json\n.obsidian/appearance.json",
			],
		});
		expect(pullReport(t, result({ replacedSettings: [".obsidian/app.json"] }), options).details).toEqual([
			"1 file in the configuration folder now has the content of the remote. What it held on this device before is in .trash/ in this vault:\n.obsidian/app.json",
		]);
		// Many are counted in full and listed in part.
		const many = Array.from({ length: 7 }, (_, index) => `.obsidian/f${index}.json`);
		const [text = ""] = pullReport(t, result({ replacedSettings: many }), options).details;
		expect(text).toContain("7 files in the configuration folder");
		expect(text.split("\n")).toHaveLength(7);

		// After the conflicts, which are counted by themselves.
		const both = result({
			counts: { fetched: 2, deleted: 0, renamed: 0, conflicts: 1 },
			conflicts: [{ path: "a.md", copyPath: "_conflicts/20261003-221500 a (Mac).md", cause: "conflict" }],
			replacedSettings: [".obsidian/app.json"],
		});
		const report = pullReport(ja, both, options);
		expect(report.summary).toBe("取り込みが終わりました：取得 2 件、競合 1 件");
		expect(report.details.map((detail) => detail.split("\n")[0])).toEqual([
			"このデバイスのファイル 1 件の内容を、別名で残しました：",
			"設定フォルダのファイル 1 件を、保存先の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：",
		]);
	});

	test("files moved to .trash/ to protect them", () => {
		const report = pullReport(t, result({ trashed: ["a.md"] }), options);
		expect(report.details).toEqual([
			"1 file was moved to .trash/ in this vault by the pull, so that its content is not lost. You can get it back from there:\na.md",
		]);
	});

	test("files the user chose to keep are listed, in part when they are many", () => {
		expect(pullReport(t, result({ keptLocal: ["c.md"] }), options).details).toEqual([
			"1 file was left as it is on this device, as you chose. It differs from the remote:\nc.md",
		]);
		expect(pullReport(ja, result({ keptLocal: ["c.md", "a.md"] }), options).details).toEqual([
			"選んだとおり、このデバイスのファイル 2 件をそのまま残しました。保存先の内容とは異なります：\nc.md\na.md",
		]);

		const kept = Array.from({ length: 8 }, (_, i) => `kept/${i}.md`);
		const [text = ""] = pullReport(t, result({ keptLocal: kept }), options).details;
		expect(text.split("\n")).toEqual([
			"8 files were left as they are on this device, as you chose. They differ from the remote:",
			...kept.slice(0, 5),
			"…and 3 more",
		]);
	});

	test("the kept files that a rule keeps from being sent back are listed apart", () => {
		const kept = result({ keptLocal: ["a.md", "drafts/c.md"], keptUnsent: ["drafts/c.md"] });
		expect(pullReport(t, kept, options).details).toEqual([
			"2 files were left as they are on this device, as you chose. They differ from the remote:\na.md\ndrafts/c.md",
			"1 of the files you chose to keep on this device is not sent back to the remote, because a rule in .gitignore excludes it. It stays on this device only:\ndrafts/c.md",
		]);
		expect(pullReport(ja, kept, options).details[1]).toBe(
			"選んだとおりに残したファイルのうち 1 件は、.gitignore の規則に当たるため、保存先へは送信しません。このデバイスにだけ残ります：\ndrafts/c.md",
		);
	});

	test("symlinks seen for the first time", () => {
		const [text = ""] = pullReport(t, result({ newSymlinks: [".claude/skills", "b"] }), options).details;
		expect(text).toContain("2 symbolic links");
		expect(text.endsWith("\n.claude/skills\nb")).toBe(true);
	});

	test("the one-time notices, one text per kind", () => {
		const report = pullReport(
			t,
			result({
				notices: [
					{ kind: "too-large", path: "big.mov" },
					{ kind: "remote-path-collision", path: "a.md" },
					{ kind: "remote-path-collision", path: "A.md" },
					{ kind: "git-at-root", path: ".git" },
					{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" },
					{ kind: "plugin-not-listed", path: ".obsidian/community-plugins.json" },
					{ kind: "unwritable-path", path: "a:b.md" },
					{ kind: "lfs-pointer", path: "img.png" },
					{ kind: "invalid-path", path: "a//b" },
					{ kind: "blocked-path", path: "notes" },
					{ kind: "archive-given-up", path: "" },
					{ kind: "archive-limited", path: String(140 * 1024 * 1024 + 5) },
					{ kind: "local-path-collision", path: "case.md" },
					{ kind: "rename-not-sent", path: "Drafts/a.md" },
					{ kind: "nested-gitignore", path: "notes/.gitignore" },
					{ kind: "nested-gitignore", path: "src/lib/.gitignore" },
					{ kind: "fixed-exclusion-off", path: "/.trash/" },
					{ kind: "fixed-exclusion-off", path: "*.icloud" },
					{ kind: "submodule", path: "knowledge" },
					{ kind: "submodule", path: "vendor/lib" },
				],
				unwritable: [
					{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md", "notes/sub/idea.md"], isNew: true },
				],
			}),
			options,
		);
		expect(report.details).toHaveLength(NOTICE_KINDS.length);
		expect(report.details[13]).toBe(
			"There are .gitignore files in subfolders. Sync Evo syncs them as ordinary files and does not read them as rules: only the .gitignore at the root of the vault decides what is synced. Git on a computer does apply them, so the same vault is treated differently there. Put the rules you need into the .gitignore at the root:\nnotes/.gitignore\nsrc/lib/.gitignore",
		);
		expect(report.details[14]).toBe(
			"Some of the lines Sync Evo manages in .gitignore are not in effect: they were deleted, or a later line undoes them. What they left out is synced now (the trash, the layout of the workspace, files an operating system leaves behind). Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it. Deleted lines can be restored in the settings of Sync Evo; where a later line that starts with ! undoes one, change that line:\n/.trash/\n*.icloud",
		);
		expect(report.details[15]).toBe(
			"The remote has submodules. Sync Evo does not sync what is inside a submodule yet: its folder is not created on this device, and nothing in it is fetched or sent. Everything else is synced as usual:\nknowledge\nvendor/lib",
		);
		expect(report.details[9]).toBe(
			"Downloading all files at once did not work on this device, so Sync Evo no longer tries it here. When there are many files to fetch, they are now fetched one by one, which takes longer.",
		);
		expect(report.details[10]).toBe(
			"Downloading all files at once did not work on this device. From now on Sync Evo does not try it here when the download is expected to be about 140 MB or more. Many files are then fetched one by one, which takes longer.",
		);
		expect(report.details[0]).toContain(".obsidian/plugins/sync-evo");
		expect(report.details[1]).toContain(".git");
		expect(report.details[2]?.endsWith("\na.md\nA.md")).toBe(true);
		expect(report.details[3]).toBe(
			"Files over 50 MB are not synced. They are skipped and left as they are:\nbig.mov",
		);
		expect(report.details[4]?.endsWith("\nimg.png")).toBe(true);
		expect(report.details[5]?.endsWith("\na//b")).toBe(true);
		expect(report.details[6]).toContain(".obsidian/community-plugins.json");
		expect(report.details[7]?.endsWith("\na:b.md")).toBe(true);
		expect(report.details[8]).toBe(
			"The file notes of the remote could not be written: files that are only on this device are in its place. Move or rename them, and the next pull writes it:\nnotes/draft.md\nnotes/sub/idea.md",
		);
	});

	test("the notices that follow from the rules, in Japanese: one text per kind, and every line that is off", () => {
		const off = ["/.obsidian/workspace.json", "/.trash/", ".DS_Store", "._*", "Thumbs.db", "ehthumbs.db", "*.icloud"];
		const report = pullReport(
			ja,
			result({
				notices: [
					...off.map((path) => ({ kind: "fixed-exclusion-off", path }) as const),
					{ kind: "nested-gitignore", path: "notes/.gitignore" },
				],
			}),
			options,
		);
		expect(report.details).toEqual([
			"下位のフォルダに .gitignore があります。Sync Evo は、これらを通常のファイルとして同期しますが、規則としては読みません。何を同期するかは、保管庫のルートの .gitignore だけで決まります。Mac などの git はこれらの規則も使うため、同じ保管庫でも効き方が違います。要る規則は、ルートの .gitignore に書いてください：\nnotes/.gitignore",
			// Not cut off at five, like a list of paths: which lines are off is what there is to tell.
			`Sync Evo が管理する .gitignore の行のうち、次の行が効いていません。行が消されたか、後ろの行で打ち消されています。これらの行で除いていた物（ゴミ箱、画面の配置のファイル、OS が残すファイル）も、同期されます。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、Mac などの git ではコミットされます。消した行は、Sync Evo の設定画面で元に戻せます。! で始まる行で打ち消している時は、その行を直してください：\n${off.join("\n")}`,
		]);
	});

	test("a device that no longer downloads all files at once from some size on is told the size", () => {
		const limited = (bytes: number) => pullReport(ja, result({ notices: [{ kind: "archive-limited", path: String(bytes) }] }), options).details;
		expect(limited(133_537_570)).toEqual([
			"このデバイスでは、全ファイルをまとめて取得できませんでした。今後このデバイスでは、まとめた大きさの見込みが約 127MB 以上のときは、まとめて取得しません。ファイルが多いときも1件ずつ取得するため、時間が長くかかります。",
		]);
		expect(limited(147_371)[0]).toContain("約 0.1MB 以上");
		// Never "0.0": a ceiling that small is as good as none, and is said as the smallest size there is a text for.
		expect(limited(1500)[0]).toContain("約 0.1MB 以上");
		expect(limited(0)[0]).toContain("約 0.1MB 以上");
	});

	test("a device that stopped downloading all files at once is told so, apart from the summary", () => {
		const given = result({ notices: [{ kind: "archive-given-up", path: "" }] });
		expect(pullReport(ja, given, options)).toEqual({
			summary: "取り込むものはありません。このデバイスは最新です。",
			details: [
				"このデバイスでは、全ファイルをまとめて取得できませんでした。今後このデバイスでは、まとめて取得しません。ファイルが多いときも1件ずつ取得するため、時間が長くかかります。",
			],
		});
		expect(pullReport(t, given, options).details).toHaveLength(1);
	});

	test("each blocked file has a text of its own, and many files in the way are listed in part", async () => {
		const inTheWay = Array.from({ length: 8 }, (_, i) => `notes/${i}.md`);
		const report = pullReport(
			t,
			result({
				notices: [
					{ kind: "blocked-path", path: "notes" },
					{ kind: "blocked-path", path: "todo" },
				],
				unwritable: [
					{ path: "notes", reason: "blocked", inTheWay, isNew: true },
					{ path: "todo", reason: "blocked", inTheWay: ["todo/x.md"], isNew: true },
				],
			}),
			options,
		);
		expect(report.details).toHaveLength(2);
		expect(report.details[0]?.split("\n").slice(1)).toEqual([...inTheWay.slice(0, 5), "…and 3 more"]);
		expect(report.details[1]?.endsWith("\ntodo/x.md")).toBe(true);
	});

	test("a blocked file that was told before is not told again", () => {
		const report = pullReport(
			t,
			result({ unwritable: [{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md"], isNew: false }] }),
			options,
		);
		expect(report.details).toEqual([]);
	});

	test("every kind of notice has a text in both languages", () => {
		for (const kind of NOTICE_KINDS) {
			for (const translate of [t, ja]) {
				const report = pullReport(translate, result({ notices: [{ kind, path: "some/path" }] }), options);
				expect(report.details).toHaveLength(1);
				expect(report.details[0]?.trim()).not.toBe("");
			}
		}
	});

	test("a path that fails again is not told again", () => {
		const report = pullReport(
			t,
			result({ unwritable: [{ path: "a:b.md", reason: "write-failed", isNew: false }] }),
			options,
		);
		expect(report.details).toEqual([]);
	});

	test("declined shows the notices that came up, and nothing else", () => {
		const report = pullReport(
			t,
			result({ outcome: "declined", notices: [{ kind: "git-at-root", path: ".git" }] }),
			options,
		);
		expect(report.details).toHaveLength(1);
	});
});

describe("a pull that could not be carried out", () => {
	const cases: [BackendErrorKind, string][] = [
		["unauthorized", "GitHub did not accept the token"],
		["forbidden", "octo/notes"],
		["not-found", "octo/notes does not exist"],
		["branch-not-found", "no branch named main"],
		["unreachable", "Could not reach GitHub"],
		["incomplete-listing", "more files than GitHub lists"],
		["workflows-permission", "the Workflows read and write permission"],
		["other", "Details: boom"],
	];
	test.each(cases)("%s", (kind, expected) => {
		const text = pullFailureText(t, settings, new BackendError(kind, "boom"));
		expect(text.startsWith("The pull failed. ")).toBe(true);
		expect(text).toContain(expected);
	});

	test("a rate limit", () => {
		expect(failureReason(t, settings, new RateLimitedError(0, "x"))).toBe(
			"GitHub's request limit has been reached. Try again later.",
		);
	});

	test("cancelled is not a failure", () => {
		expect(pullFailureText(t, settings, new BackendError("cancelled", "x"))).toBe(
			"The pull was stopped. The next pull continues from there.",
		);
	});

	test("anything else that was thrown shows its message", () => {
		expect(pullFailureText(t, settings, new Error("no such folder: notes"))).toBe(
			"The pull failed. Details: no such folder: notes",
		);
		expect(pullFailureText(t, settings, "odd")).toBe("The pull failed. Details: odd");
	});
});

describe("stateProblemText", () => {
	const problems: StateProblem[] = ["newer-version", "no-app-id", "no-indexeddb", "open-failed", "discard-failed"];

	test("each problem has a text of its own, in both languages", () => {
		for (const translate of [t, ja]) {
			const texts = problems.map((problem) => stateProblemText(translate, problem));
			expect(new Set(texts).size).toBe(problems.length);
			for (const text of texts) expect(text.trim()).not.toBe("");
		}
	});
});

describe("the question before a first fetch", () => {
	const target = { repository: "octo/notes", branch: "main" };
	const none = { localOnly: [], different: [], differentSettings: [], atSymlinks: [] };

	test("names the repository and the branch, and says what becomes of each kind of file", () => {
		const question = firstFetchQuestion(t, target, {
			files: { localOnly: ["mine.md", "notes/too.md"], different: ["a.md"], differentSettings: [], atSymlinks: ["link"] },
			discardsState: false,
		});
		expect(question).toEqual({
			title: "Confirm the first fetch",
			parts: [
				{ text: "This is the first pull from octo/notes, branch main, and this vault already has files." },
				{
					text: "1 file has other content than the remote. It gets the content of the remote, and the content on this device is kept in the folder _conflicts/ under another name:",
					paths: { shown: ["a.md"], more: 0 },
				},
				{
					text: "2 files are only on this device. They stay on this device as they are. The next push sends them to the remote, except files that are excluded; before it sends, it shows the list of the files to send and asks once more:",
					paths: { shown: ["mine.md", "notes/too.md"], more: 0 },
				},
				{
					text: "1 file is at a path that is a symbolic link on the remote. It is not compared and stays as it is:",
					paths: { shown: ["link"], more: 0 },
				},
			],
			note: "If you cancel, nothing is pulled and nothing is changed.",
		});
	});

	test("files in the configuration folder have a line of their own, which says where the content goes", () => {
		const files = {
			localOnly: ["mine.md"],
			different: ["a.md"],
			differentSettings: [".obsidian/app.json", ".obsidian/appearance.json"],
			atSymlinks: [],
		};
		const question = firstFetchQuestion(t, target, { files, discardsState: false });
		expect(question.parts.slice(1)).toEqual([
			{
				text: "1 file has other content than the remote. It gets the content of the remote, and the content on this device is kept in the folder _conflicts/ under another name:",
				paths: { shown: ["a.md"], more: 0 },
			},
			{
				text: "2 files in the configuration folder have other content than the remote. They get the content of the remote, and the content on this device is moved to .trash/ in this vault:",
				paths: { shown: [".obsidian/app.json", ".obsidian/appearance.json"], more: 0 },
			},
			{
				text: "1 file is only on this device. It stays on this device as it is. The next push sends it to the remote, unless it is excluded; before it sends, it shows the list of the files to send and asks once more:",
				paths: { shown: ["mine.md"], more: 0 },
			},
		]);
		const one = firstFetchQuestion(t, target, {
			files: { ...none, localOnly: ["mine.md"], differentSettings: [".obsidian/app.json"] },
			discardsState: false,
		});
		expect(one.parts[1]?.text).toBe(
			"1 file in the configuration folder has other content than the remote. It gets the content of the remote, and the content on this device is moved to .trash/ in this vault:",
		);

		expect(firstFetchQuestion(ja, target, { files, discardsState: false }).parts.slice(1)).toEqual([
			{
				text: "保存先と中身が違うファイル：1 件。保存先の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに別名で残します。",
				paths: { shown: ["a.md"], more: 0 },
			},
			{
				text: "保存先と中身が違う設定フォルダのファイル：2 件。保存先の内容に書き換えます。このデバイスの内容は、この保管庫の .trash/ へ移します。",
				paths: { shown: [".obsidian/app.json", ".obsidian/appearance.json"], more: 0 },
			},
			{
				text: "このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次の送信（push）で、保存先に送ります。送信の前に、送るファイルの一覧を示して、もう一度確認を求めます。除外するファイルは、送りません。",
				paths: { shown: ["mine.md"], more: 0 },
			},
		]);
	});

	test("when the sync state is discarded and only files in the configuration folder differ, they are listed", () => {
		const question = firstFetchQuestion(t, target, {
			files: { ...none, differentSettings: [".obsidian/app.json"] },
			discardsState: true,
		});
		expect(question.parts).toHaveLength(2);
		expect(question.parts[1]?.paths?.shown).toEqual([".obsidian/app.json"]);
	});

	test("a kind without files is left out", () => {
		const question = firstFetchQuestion(t, target, {
			files: { ...none, localOnly: ["mine.md"] },
			discardsState: false,
		});
		expect(question.parts.map((part) => part.paths?.shown)).toEqual([undefined, ["mine.md"]]);
	});

	test("lists fifty paths, and counts the rest", () => {
		const paths = Array.from({ length: 53 }, (_, index) => `f${index}.md`);
		const question = firstFetchQuestion(t, target, { files: { ...none, localOnly: paths }, discardsState: false });
		expect(question.parts[1]?.text).toContain("53 files are only on this device");
		expect(question.parts[1]?.paths?.shown).toHaveLength(50);
		expect(question.parts[1]?.paths?.more).toBe(3);
	});

	test("when the sync state is discarded, that is said first, and what is lost with it", () => {
		const question = firstFetchQuestion(t, target, {
			files: { ...none, different: ["a.md"] },
			discardsState: true,
		});
		expect(question.title).toBe("Discard the sync state and start over");
		expect(question.parts[0]?.text).toBe(
			"This discards the sync state of this device and builds it again by pulling from octo/notes, branch main. The sync state is only Sync Evo's own record of what has been synced: no file is deleted, on this device or on the remote.",
		);
		expect(question.parts[1]?.paths?.shown).toEqual(["a.md"]);
		expect(question.note).toBe("If you cancel, the sync state is kept and nothing is changed.");
	});

	test("when the sync state is discarded and no file is counted, it says so", () => {
		const question = firstFetchQuestion(t, target, { files: none, discardsState: true });
		expect(question.parts.map((part) => part.text)).toEqual([
			expect.stringContaining("octo/notes, branch main"),
			"No file on this device has other content than the remote, and none is only on this device.",
		]);
	});

	test("in Japanese", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: ["mine.md"], different: ["a.md"], differentSettings: [], atSymlinks: [] },
			discardsState: false,
		});
		expect(question.title).toBe("初回取得の確認");
		expect(question.parts.map((part) => part.text)).toEqual([
			"octo/notes のブランチ main から、この保管庫に初めて取り込みます。この保管庫には、すでにファイルがあります。",
			"保存先と中身が違うファイル：1 件。保存先の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに別名で残します。",
			"このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次の送信（push）で、保存先に送ります。送信の前に、送るファイルの一覧を示して、もう一度確認を求めます。除外するファイルは、送りません。",
		]);
	});
});

describe("the question before starting over, in Japanese", () => {
	const target = { repository: "octo/notes", branch: "main" };

	test("says that the sync state is discarded, and that no file is deleted", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: ["mine.md"], different: ["a.md"], differentSettings: [], atSymlinks: ["link"] },
			discardsState: true,
		});
		expect(question).toEqual({
			title: "同期の状態を捨ててやり直す",
			parts: [
				{
					text: "このデバイスの同期の状態を捨てて、octo/notes のブランチ main から取り込み直して作り直します。同期の状態は、何を同期したかを Sync Evo が覚えておくための記録です。ファイルは、このデバイスでも保存先でも削除しません。",
				},
				{
					text: "保存先と中身が違うファイル：1 件。保存先の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに別名で残します。",
					paths: { shown: ["a.md"], more: 0 },
				},
				{
					text: "このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次の送信（push）で、保存先に送ります。送信の前に、送るファイルの一覧を示して、もう一度確認を求めます。除外するファイルは、送りません。",
					paths: { shown: ["mine.md"], more: 0 },
				},
				{
					text: "保存先でシンボリックリンクになっているパスにあるファイル：1 件。比べずに、そのまま残します。",
					paths: { shown: ["link"], more: 0 },
				},
			],
			note: "やめた場合は、同期の状態を捨てず、何も変更しません。",
		});
	});

	test("when no file is counted, it says so", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: [], different: [], differentSettings: [], atSymlinks: [] },
			discardsState: true,
		});
		expect(question.parts.map((part) => part.text)).toEqual([
			expect.stringContaining("octo/notes のブランチ main"),
			"保存先と中身が違うファイルも、このデバイスにだけあるファイルも、ありません。",
		]);
	});
});

describe("a pull stopped by a change of the connection", () => {
	test("says why, in place of the text for a pull that goes on later", () => {
		const stopped = "The pull was stopped because the connection was changed. The next pull starts with the new connection.";
		expect(pullReport(t, result({ outcome: "cancelled" }), { ...options, connectionChanged: true }).summary).toBe(
			stopped,
		);
		expect(pullFailureText(t, settings, new BackendError("cancelled", "x"), true)).toBe(stopped);
	});

	test("a pull that ended otherwise is reported as it ended", () => {
		expect(pullReport(t, result(), { ...options, connectionChanged: true }).summary).toBe(
			"Nothing to pull. This device is up to date.",
		);
		expect(pullFailureText(t, settings, new BackendError("unauthorized", "x"), true)).toBe(
			pullFailureText(t, settings, new BackendError("unauthorized", "x")),
		);
	});
});
