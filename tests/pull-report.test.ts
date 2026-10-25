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
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import { BackendError, type BackendErrorKind, RateLimitedError } from "../src/core/backend";
import { DriveDailyLimitError } from "../pro/src/core/gdrive/errors";
import { translatorFor } from "../src/core/i18n";
import { NOTICE_KINDS } from "../src/core/notices";
import type { PullResult } from "../src/core/pull-io";
import {
	capList,
	clockTime,
	failureReason,
	firstFetchQuestion,
	listText,
	NOTICE_LIST_LIMIT,
	noticeDetails,
	pullDetails,
	pullFailureText,
	pullPart,
	pullProgressText,
	pullReport,
	type StateProblem,
	stateProblemText,
} from "../src/core/pull-report";
import type { RemotePlace } from "../src/core/remote-place";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

const t = translatorFor("en");
const ja = translatorFor("ja");

const settings: DeviceSettings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	dropboxFolder: "",
	dropboxAccount: null,
	gdriveFolder: "",
	gdriveAccount: null,
	gdriveFolderId: null,
	deviceName: "Mac",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
	deviceExclusion: NO_DEVICE_EXCLUSION,
	exclusionChangeTold: true,
};
const options = { settings, sizeLimit: 50 * 1024 * 1024 };

const result = (over: Partial<PullResult> = {}): PullResult => ({
	outcome: "completed",
	revision: "a".repeat(40),
	remoteEmpty: false,
	rewritten: false,
	counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
	conflicts: [],
	merged: [],
	replacedSettings: [],
	trashed: [],
	halfWritten: [],
	halfMerged: [],
	halfCopies: [],
	deferred: [],
	unwritable: [],
	keptLocal: [],
	tidiedCopies: [],
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
			"Download: updating files (3/10)…",
		);
		expect(pullProgressText(t, { phase: "hashing", done: 3, total: 10, closedViews: false })).toBe(
			"Download: comparing files (3/10)…",
		);
	});

	test("a phase whose count is not known shows none", () => {
		expect(pullProgressText(t, { phase: "applying", done: 0, total: 0, closedViews: false })).toBe(
			"Download: updating files…",
		);
		expect(pullProgressText(t, { phase: "listing", done: 0, total: 0, closedViews: false })).toBe(
			"Download: checking GitHub…",
		);
	});

	test("while everything is downloaded at once, that is told in place of a count", () => {
		const downloading = { phase: "applying", done: 2, total: 6655, closedViews: false, archive: "downloading" } as const;
		expect(pullProgressText(t, downloading)).toBe("Download: getting all files at once…");
		const waiting = { ...downloading, archive: "waiting" } as const;
		expect(pullProgressText(t, waiting)).toBe("Download: waiting for the stopped download to end…");
		expect(pullProgressText(ja, waiting)).toBe("ダウンロード：中止したダウンロードが止まるのを待っています…");
		expect(pullProgressText(ja, downloading)).toBe("ダウンロード：全ファイルをまとめて転送中…");
	});

	test("a download that is tried again tells to keep the app in front", () => {
		const retrying = { phase: "applying", done: 0, total: 6655, closedViews: false, archive: "retrying" } as const;
		expect(pullProgressText(t, retrying).split("\n")).toEqual([
			"Download: getting all files at once…",
			"The last download did not finish. Keep Obsidian open and in the foreground until this one is done.",
		]);
		expect(pullProgressText(ja, retrying).split("\n")).toEqual([
			"ダウンロード：全ファイルをまとめて転送中…",
			"前回は、ダウンロードが終わりませんでした。終わるまで、Obsidian を前に出したまま待ってください。",
		]);
	});

	test("once the download is over, nothing of it is told any more, also after one that was tried again", () => {
		const retrying = { phase: "applying", done: 0, total: 6655, closedViews: false, archive: "retrying" } as const;
		expect(pullProgressText(t, retrying).split("\n")).toHaveLength(2);
		// The same pull, with the download behind it.
		const { archive: _over, ...counting } = retrying;
		expect(pullProgressText(t, counting)).toBe("Download: updating files (0/6655)…");
		expect(pullProgressText(t, { ...counting, done: 12 })).toBe("Download: updating files (12/6655)…");
		expect(pullProgressText(ja, { ...counting, done: 12 })).toBe("ダウンロード：ファイルを更新中（12/6655）…");
	});

	test("closed graph views are told for as long as they are closed", () => {
		const text = pullProgressText(t, { phase: "applying", done: 3, total: 10, closedViews: true });
		expect(text.split("\n")).toEqual([
			"Download: updating files (3/10)…",
			"Graph views are closed while the files are written. They reopen when the download ends.",
		]);
	});

	// Times of this device's own time zone, so that the texts read the same wherever the tests run.
	const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 9, 7, hours, minutes, seconds).getTime();
	const applying = { phase: "applying", done: 3, total: 10, closedViews: false } as const;

	test("a wait for the request limit is told with the time it ends", () => {
		const text = pullProgressText(t, applying, { waitingUntil: at(14, 5), quota: null });
		expect(text.split("\n")).toEqual([
			"Download: updating files (3/10)…",
			"GitHub's request limit was reached. The download continues at 14:05. You can close the app: the next sync continues from where it stopped.",
		]);
		expect(pullProgressText(ja, applying, { waitingUntil: at(14, 5), quota: null }).split("\n")[1]).toBe(
			"GitHub のリクエスト数の上限に達しました。14:05 に続きをダウンロードします。アプリを閉じても、次の同期で続きから進みます。",
		);
	});

	test("the time shown is never before the one that is waited for", () => {
		const text = pullProgressText(t, applying, { waitingUntil: at(9, 59, 1), quota: null });
		expect(text).toContain("continues at 10:00.");
	});

	test("a fetch that does not fit in the quota is told with what fits and when the rest continues", () => {
		const quota = { fetchable: 4990, resumesAt: at(8, 30) };
		expect(pullProgressText(t, applying, { waitingUntil: null, quota }).split("\n")).toEqual([
			"Download: updating files (3/10)…",
			"About 4990 files can be downloaded before GitHub's request limit is reached. The rest continues after 08:30.",
		]);
		expect(pullProgressText(ja, applying, { waitingUntil: null, quota }).split("\n")[1]).toBe(
			"GitHub のリクエスト数の上限までにダウンロードできるのは、約 4990 件です。残りは 08:30 以降にダウンロードします。",
		);
		expect(pullProgressText(t, applying, { waitingUntil: null, quota: { ...quota, fetchable: 1 } })).toContain(
			"About 1 file can be downloaded",
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
		expect(text.split("\n").map((line) => line.slice(0, 12))).toEqual(["Download: ch", "GitHub's req", "Graph views "]);
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
			"Download finished: 6655 files updated.",
			"12 files were missing from the download of all files, or differed from GitHub's listing there. They were downloaded one by one.",
		]);
		expect(report.details).toEqual([]);
		expect(pullReport(t, result({ counts, refetched: 1 }), options).summary.split("\n")[1]).toBe(
			"1 file was missing from the download of all files, or differed from GitHub's listing there. It was downloaded on its own.",
		);
		expect(pullReport(ja, result({ counts, refetched: 12 }), options).summary.split("\n")[1]).toBe(
			"12 件のファイルは、まとめてダウンロードした中に無いか、中身が GitHub の一覧と合わなかったため、1件ずつダウンロードしました。",
		);
		expect(pullReport(t, result({ counts }), options).summary).toBe("Download finished: 6655 files updated.");
	});

	test("nothing changed", () => {
		expect(pullReport(t, result(), options)).toEqual({
			summary: "Nothing to download. This device is up to date.",
			details: [],
		});
	});

	test("only what happened is counted, each in its own number", () => {
		const report = pullReport(t, result({ counts: { fetched: 1, deleted: 2, renamed: 0, conflicts: 0 } }), options);
		expect(report.summary).toBe("Download finished: 1 file updated, 2 files deleted.");
	});

	test("all four counts", () => {
		const counts = { fetched: 12, deleted: 1, renamed: 3, conflicts: 1 };
		expect(pullReport(t, result({ counts }), options).summary).toBe(
			"Download finished: 12 files updated, 1 file deleted, 3 files renamed, 1 conflict.",
		);
		expect(pullReport(ja, result({ counts }), options).summary).toBe(
			"ダウンロードが終わりました：更新 12 件、削除 1 件、名前の変更 3 件、競合 1 件",
		);
	});

	test("an empty remote", () => {
		const report = pullReport(t, result({ outcome: "remote-empty", revision: null, remoteEmpty: true }), options);
		expect(report.summary).toBe("The repository is empty. There is nothing to download.");
	});

	test("declined", () => {
		expect(pullReport(t, result({ outcome: "declined" }), options).summary).toBe(
			"The download was cancelled. Nothing was changed.",
		);
	});

	test("cancelled: what was done before is counted on a second line", () => {
		expect(pullReport(t, result({ outcome: "cancelled" }), options).summary).toBe(
			"The download was stopped. The next download continues from there.",
		);
		const counts = { fetched: 5, deleted: 1, renamed: 0, conflicts: 0 };
		expect(pullReport(t, result({ outcome: "cancelled", counts }), options).summary).toBe(
			"The download was stopped. The next download continues from there.\nCompleted before stopping: 5 files updated, 1 file deleted.",
		);
		expect(pullReport(ja, result({ outcome: "cancelled", counts }), options).summary).toBe(
			"ダウンロードを中止しました。次のダウンロードで、続きから進みます。\n中止するまでに済んだ分：更新 5 件、削除 1 件",
		);
		// Nothing goes on from a pull that a change of the connection stopped.
		const changed = { ...options, connectionChanged: true };
		expect(pullReport(t, result({ outcome: "cancelled", counts }), changed).summary).toBe(
			"The download was stopped because the connection was changed. The next download starts with the new connection.",
		);
	});

	test("files a resuming pull moved to the trash are listed, whatever the outcome", () => {
		for (const outcome of ["completed", "cancelled", "declined", "incomplete"] as const) {
			const report = pullReport(t, result({ outcome, halfWritten: ["notes/a.md"] }), options);
			// Nothing in it says that this pull fetched the file: one that
			// was declined or stopped did not.
			expect(report.details).toEqual([
				"An earlier download stopped while it was writing 1 file. What was left of it was moved to the .trash folder of this vault. The content from GitHub is downloaded again. If you had edited the file since, you can get your edit back from there:\nnotes/a.md",
			]);
		}
		expect(pullReport(t, result({ halfWritten: ["a.md", "b.md"] }), options).details).toEqual([
			"An earlier download stopped while it was writing 2 files. What was left of them was moved to the .trash folder of this vault. The content from GitHub is downloaded again. If you had edited them since, you can get your edits back from there:\na.md\nb.md",
		]);
		expect(pullReport(ja, result({ halfWritten: ["a.md", "b.md"] }), options).details).toEqual([
			"前のダウンロードが、2 件のファイルを書いている途中で止まっていました。残っていた内容は、この保管庫の .trash/ へ移しました。GitHub の内容を、ダウンロードし直します。その後に編集していた時は、そこから戻せます：\na.md\nb.md",
		]);
	});

	test("a file a merge was writing is told once more, with where the content from before the merge is", () => {
		const moved = { halfWritten: ["notes/a.md", "b.md"], halfMerged: [{ path: "notes/a.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 a.md" }] };
		for (const outcome of ["completed", "cancelled", "declined", "incomplete"] as const) {
			const details = pullReport(t, result({ outcome, ...moved }), options).details;
			expect(details).toHaveLength(2);
			expect(details[0]).toContain("while it was writing 2 files");
			expect(details[1]).toBe(
				"An earlier download stopped while it was writing the merged content of 1 file. The content from GitHub is downloaded again, without the changes of this device. What the file held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\nnotes/a.md (before: .trash/.sync-evo-merged/2026-10-13 a.md)",
			);
		}
		const two = [...moved.halfMerged, { path: "b.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 b.md" }];
		expect(pullReport(t, result({ ...moved, halfMerged: two }), options).details[1]).toBe(
			"An earlier download stopped while it was writing the merged content of 2 files. The content from GitHub is downloaded again, without the changes of this device. What the files held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\nnotes/a.md (before: .trash/.sync-evo-merged/2026-10-13 a.md)\nb.md (before: .trash/.sync-evo-merged/2026-10-13 b.md)",
		);
		expect(pullReport(ja, result(moved), options).details[1]).toBe(
			"前のダウンロードが、統合した内容を 1 件のファイルに書いている途中で止まっていました。ダウンロードし直すのは GitHub の内容で、このデバイスの変更は入りません。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ にあります：\nnotes/a.md（前の内容：.trash/.sync-evo-merged/2026-10-13 a.md）",
		);
	});

	test("conflict copies that were tidied are counted, with how one is kept, and not listed", () => {
		const copies = ["_conflicts/2026-09-01 a (iPhone).md", "_conflicts/2026-09-02 b (Mac).md"];
		expect(pullReport(t, result({ tidiedCopies: copies.slice(0, 1) }), options).details).toEqual([
			"1 conflict file in _conflicts/ was made 30 days ago or more, and was moved to the .trash folder of this vault. To keep a conflict file, move it out of _conflicts/ or rename it.",
		]);
		expect(pullReport(t, result({ outcome: "incomplete", tidiedCopies: copies }), options).details).toEqual([
			"2 conflict files in _conflicts/ were made 30 days ago or more, and were moved to the .trash folder of this vault. To keep a conflict file, move it out of _conflicts/ or rename it.",
		]);
		expect(pullReport(ja, result({ tidiedCopies: copies }), options).details).toEqual([
			"作ってから30日たった競合ファイル 2 件を、_conflicts/ からこの保管庫の .trash/ へ移しました。残したい競合ファイルは、_conflicts/ の外へ移すか、名前を変えてください。",
		]);
		expect(pullReport(t, result({ tidiedCopies: [] }), options).details).toEqual([]);
	});

	test("a half copy of a conflict that was moved to the trash has a text of its own", () => {
		const copy = "_conflicts/2026-10-03 a (iPhone).md";
		for (const outcome of ["completed", "cancelled", "declined", "incomplete"] as const) {
			expect(pullReport(t, result({ outcome, halfCopies: [copy] }), options).details).toEqual([
				`1 conflict file that an earlier download left unfinished was moved to the .trash folder of this vault. A complete one is made again. If you had edited it, your edit is there:\n${copy}`,
			]);
		}
		expect(pullReport(t, result({ halfCopies: [copy, "b.md"] }), options).details).toEqual([
			`2 conflict files that an earlier download left unfinished were moved to the .trash folder of this vault. Complete ones are made again. If you had edited them, your edits are there:\n${copy}\nb.md`,
		]);
		expect(pullReport(ja, result({ halfCopies: [copy] }), options).details).toEqual([
			`前のダウンロードが作りかけていた競合ファイル 1 件を、この保管庫の .trash/ へ移しました。競合ファイルは作り直します。競合ファイルを編集していた時は、編集した内容がそこにあります：\n${copy}`,
		]);
		// Each list under its own text, the files first.
		const both = pullReport(t, result({ halfWritten: ["a.md"], halfCopies: [copy] }), options).details;
		expect(both).toHaveLength(2);
		expect(both[0]).toContain("while it was writing 1 file");
		expect(both[1]).toContain("1 conflict file");
	});

	test("declined after a resuming pull moved files to the trash: not called unchanged", () => {
		const copy = "_conflicts/2026-10-03 a (iPhone).md";
		for (const moved of [{ halfWritten: ["a.md"] }, { halfCopies: [copy] }]) {
			expect(pullReport(t, result({ outcome: "declined", ...moved }), options).summary).toBe(
				"The download was cancelled. Only the files listed below were moved to the .trash folder of this vault. Nothing else was changed.",
			);
			expect(pullReport(ja, result({ outcome: "declined", ...moved }), options).summary).toBe(
				"ダウンロードをやめました。下に示すファイルだけを、この保管庫の .trash/ へ移しました。ほかは何も変更していません。",
			);
		}
		expect(pullReport(t, result({ outcome: "declined" }), options).summary).toBe(
			"The download was cancelled. Nothing was changed.",
		);
	});

	test("a pull that kept files which differ from the remote is not called up to date", () => {
		expect(pullReport(t, result({ keptLocal: ["a.md"] }), options).summary).toBe("Download finished.");
		expect(pullReport(ja, result({ keptLocal: ["a.md"] }), options).summary).toBe("ダウンロードが終わりました。");
		const counts = { fetched: 1, deleted: 0, renamed: 0, conflicts: 0 };
		expect(pullReport(t, result({ keptLocal: ["a.md"], counts }), options).summary).toBe(
			"Download finished: 1 file updated.",
		);
	});

	test("a pull that left files for later is not called up to date", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "changed-during-pull" }] }),
			options,
		);
		expect(report).toEqual({ summary: "Download finished.", details: [] });
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
		expect(report.summary).toBe("Download finished: 2 files updated.");
		expect(report.details).toEqual([
			"3 files could not be downloaded and are left for the next sync. Could not reach GitHub. Check the network connection and try again.",
		]);
	});

	test("a half-written file that could not be moved away", () => {
		const deferred = [{ path: "a.md", reason: "trash-failed" }] as const;
		expect(pullReport(t, result({ outcome: "incomplete", deferred }), options).details).toEqual([
			"1 file could not be downloaded and is left for the next sync. A file on this device could not be moved to the .trash folder of this vault.",
		]);
		expect(pullReport(ja, result({ outcome: "incomplete", deferred }), options).details).toEqual([
			"1 件のファイルをダウンロードできませんでした。次の同期で、もう一度試します。このデバイスのファイルを、この保管庫の .trash/ へ移せませんでした。",
		]);
	});

	test("a failure with no file to count", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", fetchError: new RateLimitedError(0, "get blob: rate limited") }),
			options,
		);
		expect(report.details).toEqual([
			"Some files could not be downloaded and are left for the next sync. GitHub's request limit has been reached. Try again later.",
		]);
	});

	test("content that did not match", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "hash-mismatch" }] }),
			options,
		);
		expect(report.details).toEqual([
			"1 file could not be downloaded and is left for the next sync. The content GitHub sent did not match its own listing.",
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
			"1 file is not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep it on this device, then sync again:\nnotes/big.md",
		]);
		const two = result({
			outcome: "incomplete",
			deferred: [
				{ path: "a.md", reason: "not-downloaded" },
				{ path: "b.md", reason: "not-downloaded" },
			],
		});
		expect(pullReport(t, two, options).details).toEqual([
			"2 files are not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep them on this device, then sync again:\na.md\nb.md",
		]);
		expect(pullReport(ja, two, options).details).toEqual([
			"2 件のファイルの中身が、このデバイスにありません（クラウドドライブが仮のファイルだけを置いています）。クラウドドライブのアプリでこのデバイスに保存してから、もう一度同期してください：\na.md\nb.md",
		]);
	});

	test("the paths of such files are listed up to a limit, and then counted", () => {
		for (const reason of ["not-downloaded", "unreadable"] as const) {
			const deferred = Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.md`, reason }));
			const [text] = pullReport(t, result({ outcome: "incomplete", deferred }), options).details;
			expect(text?.startsWith("8 files ")).toBe(true);
			expect(text?.split("\n").slice(1)).toEqual(["f0.md", "f1.md", "f2.md", "…and 5 more"]);
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
			"1 file could not be downloaded and is left for the next sync. The content GitHub sent did not match its own listing.",
		);
		expect(report.details[1]).toContain("not on this device yet");
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
			"2 other files were not downloaded either, because they are queued behind the files above. Once those are fixed, the next sync downloads them.",
		);
		expect(pullReport(ja, waiting, options).details[2]).toBe(
			"ほかに 2 件のファイルも、上のファイルの後に回したため、ダウンロードしていません。上のファイルが片付くと、次の同期でダウンロードします。",
		);

		// Counted by the text for what failed otherwise, and not a second time.
		const failed = result({
			outcome: "incomplete",
			deferred: [...waiting.deferred, { path: "odd.md", reason: "hash-mismatch" }],
		});
		const both = pullReport(t, failed, options).details;
		expect(both).toHaveLength(3);
		expect(both[0]).toBe(
			"3 files could not be downloaded and are left for the next sync. The content GitHub sent did not match its own listing.",
		);
	});

	// What they wait for is told by a notice, once ("renaming-left"), and
	// the pulls after it are not done either.
	test("files that wait where nothing else was put off are counted on their own", () => {
		const waiting = result({
			outcome: "incomplete",
			deferred: [
				{ path: "Notes/a.md", reason: "depends-on-deferred" },
				{ path: "Notes/b.md", reason: "depends-on-deferred" },
			],
		});
		expect(pullReport(t, waiting, options).details).toEqual([
			"2 files were not downloaded or deleted, and are left for the next sync. They wait until a problem Sync Evo reported on this device is fixed.",
		]);
		expect(pullReport(ja, waiting, options).details).toEqual([
			"2 件のファイルを、ダウンロードも削除もせず、次の同期に回しました。Sync Evo が知らせた、このデバイスの物が片付くのを待っています。",
		]);
		const one = result({ outcome: "incomplete", deferred: [{ path: "Notes/a.md", reason: "depends-on-deferred" }] });
		expect(pullReport(t, one, options).details).toEqual([
			"1 file was not downloaded or deleted, and is left for the next sync. It waits until a problem Sync Evo reported on this device is fixed.",
		]);
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
		expect(report.summary).toBe("The download was cancelled. Nothing was changed.");
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
		expect(report).toEqual({ summary: "The download was stopped. The next download continues from there.", details: [] });
	});
});

describe("what the user has to know", () => {
	test("each conflict names its copy and says what is at the path now", () => {
		const conflicted = result({
			counts: { fetched: 1, deleted: 0, renamed: 0, conflicts: 4 },
			conflicts: [
				{ path: "a.md", copyPath: "_conflicts/2026-10-03 a (Mac).md", cause: "conflict" },
				{ path: "link", copyPath: "_conflicts/2026-10-03 link (Mac)", cause: "became-symlink" },
				{ path: "dir", copyPath: "_conflicts/2026-10-03 dir (Mac)", cause: "became-folder" },
				{ path: "Notes.md", copyPath: "_conflicts/2026-10-03 Notes (Mac).md", cause: "name-taken" },
			],
		});
		const report = pullReport(t, conflicted, options);
		const lines = [
			"_conflicts/2026-10-03 a (Mac).md (a.md now has the version from GitHub)",
			"_conflicts/2026-10-03 link (Mac) (link is a symbolic link on GitHub now, which is not written to this device)",
			"_conflicts/2026-10-03 dir (Mac) (dir is a folder on GitHub now)",
			"_conflicts/2026-10-03 Notes (Mac).md (another file was renamed to Notes.md on GitHub)",
		];
		const heading = "The content of 4 files on this device was kept as conflict files:";
		// The notice lists the first three; the screen of the results all of them.
		expect(report.details).toEqual([[heading, ...lines.slice(0, 3), "…and 1 more"].join("\n")]);
		const [detail] = pullDetails(t, conflicted, options);
		expect(detail?.full).toBe([heading, ...lines].join("\n"));
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
		expect(lines).toHaveLength(5);
		expect(lines[4]).toBe("…and 9 more");
	});

	test("files that were merged, with where the content from before is, apart from the conflicts and the fetched", () => {
		const merged = result({
			merged: [
				{ path: "notes/a.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 a.md" },
				{ path: "b.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 b (1).md" },
			],
		});
		expect(pullReport(t, merged, options)).toEqual({
			summary: "Download finished: 2 files merged.",
			details: [
				"2 files were changed both on this device and on GitHub, and now hold the changes of both. What they held on this device before is in .trash/.sync-evo-merged/ in this vault:\nnotes/a.md (before: .trash/.sync-evo-merged/2026-10-13 a.md)\nb.md (before: .trash/.sync-evo-merged/2026-10-13 b (1).md)",
			],
		});
		expect(pullReport(ja, merged, options)).toEqual({
			summary: "ダウンロードが終わりました：統合 2 件",
			details: [
				"このデバイスと GitHub の両方で変更していたファイル 2 件を、両方の変更を入れた内容にしました。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ にあります：\nnotes/a.md（前の内容：.trash/.sync-evo-merged/2026-10-13 a.md）\nb.md（前の内容：.trash/.sync-evo-merged/2026-10-13 b (1).md）",
			],
		});
		const one = result({ merged: [{ path: "a.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 a.md" }] });
		expect(pullReport(t, one, options)).toEqual({
			summary: "Download finished: 1 file merged.",
			details: [
				"1 file was changed both on this device and on GitHub, and now holds the changes of both. What it held on this device before is in .trash/.sync-evo-merged/ in this vault:\na.md (before: .trash/.sync-evo-merged/2026-10-13 a.md)",
			],
		});

		// After the conflicts, and counted after them.
		const both = result({
			counts: { fetched: 2, deleted: 0, renamed: 0, conflicts: 1 },
			conflicts: [{ path: "c.md", copyPath: "_conflicts/2026-10-03 c (Mac).md", cause: "conflict" }],
			merged: [{ path: "a.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 a.md" }],
		});
		const report = pullReport(ja, both, options);
		expect(report.summary).toBe("ダウンロードが終わりました：更新 2 件、競合 1 件、統合 1 件");
		expect(report.details.map((detail) => detail.split("\n")[0])).toEqual([
			"このデバイスのファイル 1 件の内容を、競合ファイルとして残しました：",
			"このデバイスと GitHub の両方で変更していたファイル 1 件を、両方の変更を入れた内容にしました。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ にあります：",
		]);
	});

	test("files in the configuration folder that got the content of the remote, apart from the conflicts", () => {
		const replaced = result({
			counts: { fetched: 3, deleted: 0, renamed: 0, conflicts: 0 },
			replacedSettings: [".obsidian/app.json", ".obsidian/appearance.json"],
		});
		expect(pullReport(t, replaced, options)).toEqual({
			summary: "Download finished: 3 files updated.",
			details: [
				"2 files in the config folder now have the content from GitHub. What they held on this device before is in the .trash folder of this vault:\n.obsidian/app.json\n.obsidian/appearance.json",
			],
		});
		expect(pullReport(ja, replaced, options)).toEqual({
			summary: "ダウンロードが終わりました：更新 3 件",
			details: [
				"設定フォルダのファイル 2 件を、GitHub の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：\n.obsidian/app.json\n.obsidian/appearance.json",
			],
		});
		expect(pullReport(t, result({ replacedSettings: [".obsidian/app.json"] }), options).details).toEqual([
			"1 file in the config folder now has the content from GitHub. What it held on this device before is in the .trash folder of this vault:\n.obsidian/app.json",
		]);
		// Many are counted in full and listed in part.
		const many = Array.from({ length: 7 }, (_, index) => `.obsidian/f${index}.json`);
		const [text = ""] = pullReport(t, result({ replacedSettings: many }), options).details;
		expect(text).toContain("7 files in the config folder");
		expect(text.split("\n")).toHaveLength(5);

		// After the conflicts, which are counted by themselves.
		const both = result({
			counts: { fetched: 2, deleted: 0, renamed: 0, conflicts: 1 },
			conflicts: [{ path: "a.md", copyPath: "_conflicts/2026-10-03 a (Mac).md", cause: "conflict" }],
			replacedSettings: [".obsidian/app.json"],
		});
		const report = pullReport(ja, both, options);
		expect(report.summary).toBe("ダウンロードが終わりました：更新 2 件、競合 1 件");
		expect(report.details.map((detail) => detail.split("\n")[0])).toEqual([
			"このデバイスのファイル 1 件の内容を、競合ファイルとして残しました：",
			"設定フォルダのファイル 1 件を、GitHub の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：",
		]);
	});

	test("files moved to .trash/ to protect them", () => {
		const report = pullReport(t, result({ trashed: ["a.md"] }), options);
		expect(report.details).toEqual([
			"1 file was moved to the .trash folder of this vault by the download, so that its content is not lost. You can get it back from there:\na.md",
		]);
	});

	test("files the user chose to keep are listed, in part when they are many", () => {
		expect(pullReport(t, result({ keptLocal: ["c.md"] }), options).details).toEqual([
			"1 file was left as it is on this device, as you chose. It differs from what is on GitHub:\nc.md",
		]);
		expect(pullReport(ja, result({ keptLocal: ["c.md", "a.md"] }), options).details).toEqual([
			"選んだとおり、このデバイスのファイル 2 件をそのまま残しました。GitHub の内容とは異なります：\nc.md\na.md",
		]);

		const kept = Array.from({ length: 8 }, (_, i) => `kept/${i}.md`);
		const [text = ""] = pullReport(t, result({ keptLocal: kept }), options).details;
		expect(text.split("\n")).toEqual([
			"8 files were left as they are on this device, as you chose. They differ from what is on GitHub:",
			...kept.slice(0, 3),
			"…and 5 more",
		]);
	});

	test("the links of the vault name Dropbox where it is the remote", () => {
		const dropbox = translatorFor("en", "Dropbox");
		const [text = ""] = pullReport(dropbox, result({ notices: [{ kind: "local-link", path: "Projects" }] }), options).details;
		expect(text).toContain("leaves the link as it is, on Dropbox and on this device");
		expect(text).not.toContain("GitHub");
		const [japanese = ""] = pullReport(
			translatorFor("ja", "Dropbox"),
			result({ notices: [{ kind: "local-link", path: "Projects" }] }),
			options,
		).details;
		expect(japanese).toContain("Dropbox でも、このデバイス（リンクの先）でも");
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
					{ kind: "submodule-no-access", path: "private (octo/private)" },
					{ kind: "submodule-no-commit", path: "wip (octo/wip)" },
					{ kind: "submodule-not-sent", path: "knowledge/a.md" },
					{ kind: "submodule-not-sent", path: "knowledge/sub/b.md" },
					{ kind: "local-link", path: "Projects" },
					{ kind: "renaming-left", path: "Tools.sync-evo-renaming" },
					{ kind: "case-renamed-folder", path: "Tools" },
					{ kind: "case-renamed-folder", path: "Tools/Sub" },
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
			"What was excluded is synced now (the .trash folder, the layout of the workspace, files an operating system leaves behind, and so on): the lines of .gitignore below, which Sync Evo manages, were deleted, or a later line undoes them. Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it. Deleted lines can be restored in the Sync Evo settings; where a later line that starts with ! undoes one, change that line:\n/.trash/\n*.icloud",
		);
		expect(report.details[15]).toBe(
			"What is inside these submodules cannot be downloaded. Sync Evo downloads a submodule that points to a repository on GitHub and is listed in the .gitmodules of the repository. A submodule inside a submodule, and one with too many files to be listed, are not downloaded. What this device has in those folders is left as it is. Everything else is synced as usual:\nknowledge\nvendor/lib",
		);
		expect(report.details[16]).toBe(
			"The repository a submodule points to cannot be read. Check that the token has read access to the Contents of that repository. Once it has, the next sync downloads it. Until then, what this device has in that folder is left as it is. Everything else is synced as usual:\nprivate (octo/private)",
		);
		expect(report.details[17]).toBe(
			"The repository a submodule points to does not have the commit the submodule points to. With git on a computer, check that the changes inside the submodule were pushed. Once they are, the next sync downloads them. Until then, what this device has in that folder is left as it is. Everything else is synced as usual:\nwip (octo/wip)",
		);
		expect(report.details[18]).toBe(
			"What is inside a submodule is only read. These files were changed, added or deleted on this device; that is not uploaded, and stays on this device alone. Make changes inside a submodule with git on a computer:\nknowledge/a.md\nknowledge/sub/b.md",
		);
		expect(report.details[9]).toBe(
			"Downloading all files at once did not work on this device, so Sync Evo no longer tries it here. When there are many files to download, they are now downloaded one by one, which takes longer.",
		);
		expect(report.details[10]).toBe(
			"Downloading all files at once did not work on this device. From now on Sync Evo does not try it here when the download is expected to be about 140 MB or more. Many files are then downloaded one by one, which takes longer.",
		);
		expect(report.details[0]).toContain(".obsidian/plugins/sync-evo");
		expect(report.details[1]).toContain(".git");
		expect(report.details[2]?.endsWith("\na.md\nA.md")).toBe(true);
		expect(report.details[3]).toBe(
			"Files over 50 MB are not synced. They are skipped and left as they are, on GitHub and on this device:\nbig.mov",
		);
		expect(report.details[4]?.endsWith("\nimg.png")).toBe(true);
		expect(report.details[5]?.endsWith("\na//b")).toBe(true);
		expect(report.details[6]).toContain(".obsidian/community-plugins.json");
		expect(report.details[7]?.endsWith("\na:b.md")).toBe(true);
		// The files in its place are named on the screen of the results alone.
		expect(report.details[8]).toBe(
			"These files on GitHub could not be written: files that are only on this device are in their place. Move or rename those, and the next download writes these:\nnotes",
		);
		expect(report.details[20]).toBe(
			'Sync Evo changed the upper and lower case of these names in two steps, and stopped in between. The name without ".sync-evo-renaming" at the end is taken by something else, or this device refused the rename, so they keep this name for now and are not synced. Nor is anything at or below the name without it, until they have their name back. Move or rename what has that name, and the next sync gives them their name back:\nTools.sync-evo-renaming',
		);
		expect(report.details[21]).toBe(
			"Sync Evo changed the upper and lower case of the names of these folders. On Android, until Obsidian is restarted, each may also show in the file list under its old spelling. Do not delete the one with the old spelling: that deletes the real folder, with everything in it. Once Obsidian is restarted, the old spelling is gone:\nTools\nTools/Sub",
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
			"下位のフォルダに .gitignore があります。Sync Evo は、これらを通常のファイルとして同期しますが、規則としては読みません。何を同期するかは、保管庫のルートの .gitignore だけで決まります。パソコンの git はこれらの規則も使うため、同じ保管庫でも効き方が違います。要る規則は、ルートの .gitignore に書いてください：\nnotes/.gitignore",
			// Not cut off at five, like a list of paths: which lines are off is what there is to tell.
			`ゴミ箱、画面の配置のファイル、OS が残すファイルなど、除外していた物が、今は同期されます。下に示す .gitignore の行（Sync Evo が管理する行）で除外していましたが、その行が消されたか、後ろの行で打ち消されています。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、パソコンの git ではコミットされます。消した行は、Sync Evo の設定画面で元に戻せます。! で始まる行で打ち消している時は、その行を直してください：\n${off.join("\n")}`,
		]);
	});

	test("a folder whose case was changed in two calls, in Japanese", () => {
		const report = pullReport(ja, result({ notices: [{ kind: "case-renamed-folder", path: "Tools" }] }), options);
		expect(report.details).toEqual([
			"Sync Evo は、次のフォルダの名前の大文字と小文字を変えました。Android の Obsidian では、再起動するまで、それぞれが古い綴りでも一覧に見えることがあります。古い綴りの方を消さないでください。中身ごと、本物のフォルダが消えます。再起動すると、古い綴りは見えなくなります：\nTools",
		]);
	});

	test("a device that no longer downloads all files at once from some size on is told the size", () => {
		const limited = (bytes: number) => pullReport(ja, result({ notices: [{ kind: "archive-limited", path: String(bytes) }] }), options).details;
		expect(limited(133_537_570)).toEqual([
			"このデバイスでは、全ファイルをまとめてダウンロードできませんでした。今後このデバイスでは、まとめた大きさの見込みが約 127MB 以上のときは、まとめてダウンロードしません。ファイルが多いときも1件ずつダウンロードするため、時間が長くかかります。",
		]);
		expect(limited(147_371)[0]).toContain("約 0.1MB 以上");
		// Never "0.0": a ceiling that small is as good as none, and is said as the smallest size there is a text for.
		expect(limited(1500)[0]).toContain("約 0.1MB 以上");
		expect(limited(0)[0]).toContain("約 0.1MB 以上");
	});

	test("a device that stopped downloading all files at once is told so, apart from the summary", () => {
		const given = result({ notices: [{ kind: "archive-given-up", path: "" }] });
		expect(pullReport(ja, given, options)).toEqual({
			summary: "ダウンロードするものはありません。このデバイスは最新です。",
			details: [
				"このデバイスでは、全ファイルをまとめてダウンロードできませんでした。今後このデバイスでは、まとめてダウンロードしません。ファイルが多いときも1件ずつダウンロードするため、時間が長くかかります。",
			],
		});
		expect(pullReport(t, given, options).details).toHaveLength(1);
	});

	test("blocked files are one text, and the screen of the results names what is in the place of each", () => {
		const inTheWay = Array.from({ length: 8 }, (_, i) => `notes/${i}.md`);
		const blocked = result({
			notices: [
				{ kind: "blocked-path", path: "notes" },
				{ kind: "blocked-path", path: "todo" },
			],
			unwritable: [
				{ path: "notes", reason: "blocked", inTheWay, isNew: true },
				{ path: "todo", reason: "blocked", inTheWay: ["todo/x.md"], isNew: true },
			],
		});
		const report = pullReport(t, blocked, options);
		expect(report.details).toHaveLength(1);
		expect(report.details[0]?.split("\n").slice(1)).toEqual(["notes", "todo"]);
		const [detail] = pullDetails(t, blocked, options);
		expect(detail?.level).toBe("warn");
		expect(detail?.full.split("\n").slice(1)).toEqual([
			`notes (in its place: ${inTheWay.join(", ")})`,
			"todo (in its place: todo/x.md)",
		]);
		expect(pullDetails(ja, blocked, options)[0]?.full).toContain("todo/x.md");
	});

	test("a kind that was told of one path at a time is one text that lists them", () => {
		const report = pullReport(
			t,
			result({
				notices: [
					{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" },
					{ kind: "own-folder-on-remote", path: "Settings/plugins/sync-evo" },
					{ kind: "plugin-not-listed", path: ".obsidian/community-plugins.json" },
					{ kind: "plugin-not-listed", path: "Settings/community-plugins.json" },
					{ kind: "archive-limited", path: String(200 * 1024 * 1024) },
					{ kind: "archive-limited", path: String(140 * 1024 * 1024) },
				],
			}),
			options,
		);
		expect(report.details).toHaveLength(3);
		expect(report.details[0]?.endsWith("\n.obsidian/plugins/sync-evo\nSettings/plugins/sync-evo")).toBe(true);
		expect(report.details[1]?.endsWith("\n.obsidian/community-plugins.json\nSettings/community-plugins.json")).toBe(true);
		// The size the device goes by now: the last.
		expect(report.details[2]).toContain("about 140 MB or more");
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

describe("how much each thing a pull tells matters", () => {
	test("a notice lists three paths of a kind", () => {
		expect(NOTICE_LIST_LIMIT).toBe(3);
	});

	test("conflicts, merges and what is not downloaded are to be seen to; the trash and kept files only worth knowing", () => {
		const details = pullDetails(
			t,
			result({
				outcome: "incomplete",
				conflicts: [{ path: "a.md", copyPath: "a (conflict).md", cause: "conflict" }],
				merged: [{ path: "m.md", keptAt: ".trash/.sync-evo-merged/m.md" }],
				trashed: ["b.md"],
				keptLocal: ["c.md"],
				tidiedCopies: ["_conflicts/old.md"],
				deferred: [{ path: "d.md", reason: "unreadable" }],
			}),
			options,
		);
		expect(details.map((detail) => [detail.level, detail.standing])).toEqual([
			["warn", false],
			["warn", false],
			["info", false],
			["info", false],
			["info", false],
			["warn", true],
		]);
	});

	test("the screen of the results lists every path, where a notice lists the first few", () => {
		const trashed = Array.from({ length: 5 }, (_, i) => `${i}.md`);
		const [detail] = pullDetails(t, result({ trashed }), options);
		expect(detail?.text.split("\n").slice(1)).toEqual([...trashed.slice(0, 3), "…and 2 more"]);
		expect(detail?.full.split("\n").slice(1)).toEqual(trashed);
	});

	test("what is only worth knowing has a short line with the count alone, for the summary", () => {
		const details = pullDetails(
			t,
			result({ trashed: ["a.md", "b.md"], keptLocal: ["c.md"], tidiedCopies: ["_conflicts/x.md"], newSymlinks: ["l"] }),
			options,
		);
		expect(details.map((detail) => detail.brief)).toEqual([
			"2 files were moved to .trash/.",
			"1 conflict file 30 days old was moved to .trash/.",
			"1 file was left as it is, as you chose.",
			"1 symbolic link on GitHub is skipped.",
		]);
		// Nothing to see to has one.
		const [conflict] = pullDetails(t, result({ conflicts: [{ path: "a.md", copyPath: "b.md", cause: "conflict" }] }), options);
		expect(conflict?.brief).toBeUndefined();
	});

	test("a pull is told as only worth knowing, however it ended: what there is to see to is in its details", () => {
		expect(pullPart(t, result({}), options).level).toBe("info");
		expect(pullPart(t, result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "unreadable" }] }), options).level).toBe(
			"info",
		);
	});

	test("one-time notices: what needs nothing done is only worth knowing, with a short line; the rest is to be seen to", () => {
		const details = noticeDetails(
			t,
			[
				{ kind: "too-large", path: "big.mov" },
				{ kind: "plugin-not-listed", path: ".obsidian/community-plugins.json" },
				{ kind: "nested-gitignore", path: "a/.gitignore" },
				{ kind: "nested-gitignore", path: "b/.gitignore" },
				{ kind: "local-link", path: "Projects" },
			],
			50 * 1024 * 1024,
		);
		expect(details.map((detail) => [detail.level, detail.brief])).toEqual([
			["warn", undefined],
			["warn", undefined],
			["info", "2 .gitignore files in subfolders are not read as rules."],
			["info", "1 link in the vault is not synced."],
		]);
	});

	test("every one-time notice of the kind only worth knowing has a short line in both languages", () => {
		for (const kind of NOTICE_KINDS) {
			for (const translate of [t, ja]) {
				const [detail] = noticeDetails(translate, [{ kind, path: "1024" }], 50 * 1024 * 1024);
				if (detail?.level === "info") expect(detail.brief?.trim()).not.toBe("");
				else expect(detail?.brief).toBeUndefined();
			}
		}
	});
});

describe("a pull that could not be carried out", () => {
	const cases: [BackendErrorKind, string][] = [
		["unauthorized", "GitHub rejected the token"],
		["forbidden", "octo/notes"],
		["not-found", "GitHub found no repository octo/notes"],
		["branch-not-found", "no branch named main"],
		["unreachable", "Could not reach GitHub"],
		["incomplete-listing", "more files than GitHub lists"],
		["workflows-permission", "the Workflows read and write permission"],
		["other", "Details: boom"],
	];
	test.each(cases)("%s", (kind, expected) => {
		const text = pullFailureText(t, settings, new BackendError(kind, "boom"));
		expect(text.startsWith("The download failed. ")).toBe(true);
		expect(text).toContain(expected);
	});

	test("a rate limit", () => {
		expect(failureReason(t, settings, new RateLimitedError(0, "x"))).toBe(
			"GitHub's request limit has been reached. Try again later.",
		);
	});

	test("with Google Drive, the requests of the day having run out says until when, and not to connect again", () => {
		const drive: DeviceSettings = { ...settings, backend: "gdrive", gdriveFolder: "Vault", gdriveAccount: { id: "1", email: "a@example.com" } };
		const reset = new Date(2026, 9, 17, 16, 0).getTime();
		const error = new DriveDailyLimitError(reset, new Date(2026, 9, 17, 10, 0).getTime(), "x");
		expect(failureReason(t, drive, error)).toBe(t("gdrive.dailyLimit", { time: "16:00" }));
		expect(failureReason(ja, drive, error)).toContain("16:00");
		expect(failureReason(t, drive, error)).not.toBe(t("check.gdrive.forbidden"));
	});

	test("with Google Drive, an end of the day's requests that is on the next day is told with its date", () => {
		const drive: DeviceSettings = { ...settings, backend: "gdrive", gdriveFolder: "Vault", gdriveAccount: { id: "1", email: "a@example.com" } };
		const reset = new Date(2026, 9, 18, 16, 0).getTime();
		const error = new DriveDailyLimitError(reset, new Date(2026, 9, 17, 20, 0).getTime(), "x");
		expect(failureReason(t, drive, error)).toBe(t("gdrive.dailyLimit", { time: "2026-10-18 16:00" }));
		expect(failureReason(ja, drive, error)).toContain("2026-10-18 16:00");
	});

	test("with Dropbox, a connection Dropbox refuses or does not allow reads as Dropbox's, and names no repository", () => {
		const dropbox: DeviceSettings = { ...settings, backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: { id: "dbid:1", email: "a@example.com" } };
		expect(failureReason(t, dropbox, new BackendError("unauthorized", "x"))).toBe(t("check.dropbox.unauthorized"));
		expect(failureReason(t, dropbox, new BackendError("forbidden", "x"))).toBe(t("check.dropbox.forbidden"));
		expect(failureReason(t, dropbox, new BackendError("not-found", "boom"))).toBe("Details: boom");
		expect(failureReason(t, dropbox, new BackendError("forbidden", "x"))).not.toContain("octo/notes");
	});

	test("the paid plan refusing tells of the license key, in the words of the service", () => {
		const dropbox: DeviceSettings = { ...settings, backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: { id: "dbid:1", email: "a@example.com" } };
		const error = new BackendError("paid-plan", "x");
		expect(failureReason(translatorFor("en", "Dropbox"), dropbox, error)).toBe(
			"The free time of Sync Evo with Dropbox is over. To sync again, enter a license key in the Sync Evo settings.",
		);
		expect(failureReason(translatorFor("ja", "Dropbox"), dropbox, error)).toContain("Dropbox");
	});

	test("cancelled is not a failure", () => {
		expect(pullFailureText(t, settings, new BackendError("cancelled", "x"))).toBe(
			"The download was stopped. The next download continues from there.",
		);
	});

	test("anything else that was thrown shows its message", () => {
		expect(pullFailureText(t, settings, new Error("no such folder: notes"))).toBe(
			"The download failed. Details: no such folder: notes",
		);
		expect(pullFailureText(t, settings, "odd")).toBe("The download failed. Details: odd");
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
	const target: RemotePlace = { backend: "github", repository: "octo/notes", branch: "main" };
	const none = { localOnly: [], different: [], differentSettings: [], atSymlinks: [] };

	test("names the repository and the branch, and says what becomes of each kind of file", () => {
		const question = firstFetchQuestion(t, target, {
			files: { localOnly: ["mine.md", "notes/too.md"], different: ["a.md"], differentSettings: [], atSymlinks: ["link"] },
			discardsState: false,
		});
		expect(question).toEqual({
			title: "Confirm the first download",
			parts: [
				{ text: "This is the first download from octo/notes, branch main, and this vault already has files." },
				{
					text: "1 file has other content than on GitHub. It gets the content from GitHub, and the content on this device is kept in the folder _conflicts/ as a conflict file:",
					paths: { shown: ["a.md"], more: 0 },
				},
				{
					text: "2 files are only on this device. They stay on this device as they are. The next upload includes them, except files that are excluded; before anything is uploaded, the list of the files is shown and you are asked once more:",
					paths: { shown: ["mine.md", "notes/too.md"], more: 0 },
				},
				{
					text: "1 file is at a path that is a symbolic link on GitHub. It is not compared and stays as it is:",
					paths: { shown: ["link"], more: 0 },
				},
			],
			note: "If you cancel, nothing is downloaded and nothing is changed.",
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
				text: "1 file has other content than on GitHub. It gets the content from GitHub, and the content on this device is kept in the folder _conflicts/ as a conflict file:",
				paths: { shown: ["a.md"], more: 0 },
			},
			{
				text: "2 files in the config folder have other content than on GitHub. They get the content from GitHub, and the content on this device is moved to the .trash folder of this vault:",
				paths: { shown: [".obsidian/app.json", ".obsidian/appearance.json"], more: 0 },
			},
			{
				text: "1 file is only on this device. It stays on this device as it is. The next upload includes it, unless it is excluded; before anything is uploaded, the list of the files is shown and you are asked once more:",
				paths: { shown: ["mine.md"], more: 0 },
			},
		]);
		const one = firstFetchQuestion(t, target, {
			files: { ...none, localOnly: ["mine.md"], differentSettings: [".obsidian/app.json"] },
			discardsState: false,
		});
		expect(one.parts[1]?.text).toBe(
			"1 file in the config folder has other content than on GitHub. It gets the content from GitHub, and the content on this device is moved to the .trash folder of this vault:",
		);

		expect(firstFetchQuestion(ja, target, { files, discardsState: false }).parts.slice(1)).toEqual([
			{
				text: "GitHub と中身が違うファイル：1 件。GitHub の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに競合ファイルとして残します。",
				paths: { shown: ["a.md"], more: 0 },
			},
			{
				text: "GitHub と中身が違う設定フォルダのファイル：2 件。GitHub の内容に書き換えます。このデバイスの内容は、この保管庫の .trash/ へ移します。",
				paths: { shown: [".obsidian/app.json", ".obsidian/appearance.json"], more: 0 },
			},
			{
				text: "このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次のアップロードに入ります。アップロードの前に、ファイルの一覧を示して、もう一度確認を求めます。除外しているファイルは、アップロードしません。",
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
		expect(question.title).toBe("Start over");
		expect(question.parts[0]?.text).toBe(
			"This compares this device with GitHub (octo/notes, branch main) again. No file is deleted, on this device or on GitHub.",
		);
		expect(question.parts[1]?.paths?.shown).toEqual(["a.md"]);
		expect(question.note).toBe("If you cancel, nothing is changed.");
	});

	test("when the sync state is discarded and no file is counted, it says so", () => {
		const question = firstFetchQuestion(t, target, { files: none, discardsState: true });
		expect(question.parts.map((part) => part.text)).toEqual([
			expect.stringContaining("octo/notes, branch main"),
			"No file on this device has other content than on GitHub, and none is only on this device.",
		]);
	});

	test("in Japanese", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: ["mine.md"], different: ["a.md"], differentSettings: [], atSymlinks: [] },
			discardsState: false,
		});
		expect(question.title).toBe("最初のダウンロードの確認");
		expect(question.parts.map((part) => part.text)).toEqual([
			"octo/notes のブランチ main から、この保管庫に初めてダウンロードします。この保管庫には、すでにファイルがあります。",
			"GitHub と中身が違うファイル：1 件。GitHub の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに競合ファイルとして残します。",
			"このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次のアップロードに入ります。アップロードの前に、ファイルの一覧を示して、もう一度確認を求めます。除外しているファイルは、アップロードしません。",
		]);
	});

	test("with Dropbox, names the folder in the app folder", () => {
		const question = firstFetchQuestion(t, { backend: "dropbox", folder: "Vault" }, { files: { ...none, localOnly: ["mine.md"] }, discardsState: false });
		expect(question.parts[0]?.text).toContain("Apps/Sync Evo/Vault");
		expect(question.parts[0]?.text).not.toContain("branch");
		const over = firstFetchQuestion(t, { backend: "dropbox", folder: "Vault" }, { files: none, discardsState: true });
		expect(over.parts[0]?.text).toContain("Apps/Sync Evo/Vault");
	});
});

describe("the question before starting over, in Japanese", () => {
	const target: RemotePlace = { backend: "github", repository: "octo/notes", branch: "main" };

	test("says that the sync state is discarded, and that no file is deleted", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: ["mine.md"], different: ["a.md"], differentSettings: [], atSymlinks: ["link"] },
			discardsState: true,
		});
		expect(question).toEqual({
			title: "最初からやり直す",
			parts: [
				{
					text: "GitHub（octo/notes のブランチ main）と比べ直します。ファイルは、このデバイスでも GitHub でも削除しません。",
				},
				{
					text: "GitHub と中身が違うファイル：1 件。GitHub の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに競合ファイルとして残します。",
					paths: { shown: ["a.md"], more: 0 },
				},
				{
					text: "このデバイスにだけあるファイル：1 件。このデバイスに、そのまま残します。次のアップロードに入ります。アップロードの前に、ファイルの一覧を示して、もう一度確認を求めます。除外しているファイルは、アップロードしません。",
					paths: { shown: ["mine.md"], more: 0 },
				},
				{
					text: "GitHub でシンボリックリンクになっているパスにあるファイル：1 件。比べずに、そのまま残します。",
					paths: { shown: ["link"], more: 0 },
				},
			],
			note: "やめた場合は、何も変更しません。",
		});
	});

	test("when no file is counted, it says so", () => {
		const question = firstFetchQuestion(ja, target, {
			files: { localOnly: [], different: [], differentSettings: [], atSymlinks: [] },
			discardsState: true,
		});
		expect(question.parts.map((part) => part.text)).toEqual([
			expect.stringContaining("octo/notes のブランチ main"),
			"GitHub と中身が違うファイルも、このデバイスにだけあるファイルも、ありません。",
		]);
	});
});

describe("a pull stopped by a change of the connection", () => {
	test("says why, in place of the text for a pull that goes on later", () => {
		const stopped = "The download was stopped because the connection was changed. The next download starts with the new connection.";
		expect(pullReport(t, result({ outcome: "cancelled" }), { ...options, connectionChanged: true }).summary).toBe(
			stopped,
		);
		expect(pullFailureText(t, settings, new BackendError("cancelled", "x"), true)).toBe(stopped);
	});

	test("a pull that ended otherwise is reported as it ended", () => {
		expect(pullReport(t, result(), { ...options, connectionChanged: true }).summary).toBe(
			"Nothing to download. This device is up to date.",
		);
		expect(pullFailureText(t, settings, new BackendError("unauthorized", "x"), true)).toBe(
			pullFailureText(t, settings, new BackendError("unauthorized", "x")),
		);
	});
});
