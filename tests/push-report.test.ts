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
import { BackendError } from "../src/core/backend";
import { translatorFor } from "../src/core/i18n";
import { pullReport } from "../src/core/pull-report";
import type { PullResult } from "../src/core/pull";
import type { PushRunResult } from "../src/core/push";
import {
	pushFailureReminderText,
	pushFailureText,
	pushProgressText,
	pushQuestion,
	pushReport,
} from "../src/core/push-report";

const t = translatorFor("en");
const ja = translatorFor("ja");
const settings = { backend: "github", repository: "octo/notes", branch: "main", tokenSecret: "t", deviceName: "iPhone" } as const;
const target = { repository: "octo/notes", branch: "main" };
const options = { sizeLimit: 50 * 1024 * 1024 };

function result(overrides: Partial<PushRunResult> = {}): PushRunResult {
	return {
		outcome: "pushed",
		revision: "a".repeat(40),
		counts: { added: 0, modified: 0, deleted: 0 },
		recovered: null,
		refused: [],
		heldRenames: [],
		held: [],
		leftOut: [],
		notices: [],
		storedOtherwise: [],
		...overrides,
	};
}

describe("the line of progress of a push", () => {
	test("each phase, with the count where there is one", () => {
		const line = (phase: Parameters<typeof pushProgressText>[1]["phase"], done = 0, total = 0): string =>
			pushProgressText(t, { phase, done, total });
		expect(line("listing")).toBe("Push: checking the remote…");
		expect(line("scanning")).toBe("Push: looking through the vault…");
		expect(line("hashing", 3, 10)).toBe("Push: comparing files (3/10)…");
		expect(line("sending", 0, 4)).toBe("Push: sending files…");
		expect(line("sending", 2, 4)).toBe("Push: sending files (2/4)…");
		expect(line("finishing")).toBe("Push: finishing…");
	});

	test("a limit that is waited out is a second line, with the time rounded up", () => {
		const until = new Date(2026, 9, 9, 14, 4, 1).getTime();
		const text = pushProgressText(t, { phase: "sending", done: 2, total: 4 }, until);
		expect(text.split("\n")).toEqual([
			"Push: sending files (2/4)…",
			"GitHub's limit on creating content was reached. The push continues at 14:05. Keep Obsidian in front until then: a push that stops sends nothing.",
		]);
	});

	test("in Japanese", () => {
		expect(pushProgressText(ja, { phase: "sending", done: 2, total: 4 })).toBe("送信：ファイルを送信中（2/4）…");
	});
});

describe("the question a push stops with", () => {
	test("before the first push: where it goes, and every file by what happens to it", () => {
		const question = pushQuestion(t, target, {
			firstPush: { added: [".obsidian/graph.json", "new.md"], modified: ["edit.md"], deleted: [] },
			deletions: null,
			largeFiles: null,
			recordCount: 3,
		});
		expect(question).toEqual({
			title: "Confirm the first push",
			parts: [
				{
					text: "This is the first push from this device to octo/notes, branch main. It changes the remote as listed below. Once a push has gone through, later pushes do not show this list.",
				},
				{ text: "2 files to add:", paths: { shown: [".obsidian/graph.json", "new.md"], more: 0 } },
				{ text: "1 file to modify:", paths: { shown: ["edit.md"], more: 0 } },
			],
			note: "If you cancel, nothing is sent and nothing is changed.",
		});
	});

	test("the lists stop at fifty paths", () => {
		const added = Array.from({ length: 53 }, (_, i) => `n${i}.md`);
		const question = pushQuestion(t, target, { firstPush: { added, modified: [], deleted: [] }, deletions: null, largeFiles: null, recordCount: 0 });
		expect(question.parts[1]?.paths?.shown.length).toBe(50);
		expect(question.parts[1]?.paths?.more).toBe(3);
	});

	test("too many deletions: how many, which, and what follows on the other devices", () => {
		const question = pushQuestion(t, target, { firstPush: null, deletions: ["a.md", "b.md"], largeFiles: null, recordCount: 3 });
		expect(question).toEqual({
			title: "Confirm deletions",
			parts: [
				{
					text: "2 files were deleted on this device. The push deletes them on the remote, and a pull then deletes them on your other devices.",
					paths: { shown: ["a.md", "b.md"], more: 0 },
				},
			],
			note: "If you cancel, nothing is sent and nothing is changed.",
		});
	});

	test("both at once: one question, and the deleted files are listed once", () => {
		const question = pushQuestion(t, target, {
			firstPush: { added: [], modified: [], deleted: ["a.md", "b.md"] },
			deletions: ["a.md", "b.md"],
			largeFiles: null,
			recordCount: 3,
		});
		expect(question.title).toBe("Confirm the first push");
		expect(question.parts.map((part) => part.paths?.shown)).toEqual([undefined, ["a.md", "b.md"], undefined]);
		expect(question.parts[2]?.text).toContain("2 files were deleted on this device");
	});

	test("in Japanese", () => {
		const question = pushQuestion(ja, target, {
			firstPush: { added: ["new.md"], modified: ["edit.md"], deleted: ["old.md"] },
			deletions: ["old.md"],
			largeFiles: null,
			recordCount: 3,
		});
		expect(question.title).toBe("最初の送信の確認");
		expect(question.parts.map((part) => part.text)).toEqual([
			"このデバイスから octo/notes のブランチ main へ、初めて送信します。保存先を、下のとおりに変更します。送信が1回済むと、次からの送信では、この一覧を出しません。",
			"追加するファイル：1 件",
			"変更するファイル：1 件",
			"削除するファイル：1 件",
			"このデバイスで削除したファイル 1 件を、保存先からも削除します。ほかのデバイスでも、取り込むと削除されます。",
		]);
		expect(question.note).toBe("やめた場合は、何も送信せず、何も変更しません。");
	});
});

describe("how a push ended", () => {
	test("what was sent, by kind", () => {
		const report = pushReport(t, result({ counts: { added: 2, modified: 1, deleted: 3 } }), options);
		expect(report).toEqual({ summary: "Push finished: 2 files added, 1 file modified, 3 files deleted.", details: [] });
		expect(pushReport(ja, result({ counts: { added: 2, modified: 1, deleted: 3 } }), options).summary).toBe(
			"送信が終わりました：追加 2 件、変更 1 件、削除 3 件",
		);
	});

	test("nothing to send", () => {
		expect(pushReport(t, result({ outcome: "nothing-to-push", revision: null }), options).summary).toBe(
			"Nothing to push. The remote is up to date.",
		);
	});

	test("nothing sent while files were left unsent is not called up to date", () => {
		const report = pushReport(t, result({ outcome: "nothing-to-push", revision: null, held: ["a.md"] }), options);
		expect(report.summary).toBe("Nothing was sent.");
		expect(report.details).toEqual([
			"1 file was not sent: a pull has not finished with it, or an editor could not save it. Sync again:\na.md",
		]);
	});

	test("a pull has to come first, by the reason", () => {
		const summary = (reason: PushRunResult["reason"]): string =>
			pushReport(t, result({ outcome: "pull-first", revision: null, ...(reason === undefined ? {} : { reason }) }), options)
				.summary;
		expect(summary("no-base")).toContain("has not finished its first pull");
		expect(summary("remote-empty")).toContain("The remote is empty");
		expect(summary("remote-moved")).toContain("changed from another device after this push began");
		expect(summary("gitignore-unsettled")).toContain(".gitignore");
		for (const reason of ["no-base", "remote-empty", "remote-moved", "gitignore-unsettled"] as const) {
			expect(summary(reason).startsWith("Nothing was sent. ")).toBe(true);
		}
	});

	test("declined, and stopped", () => {
		const said = (outcome: PushRunResult["outcome"], connectionChanged = false): string =>
			pushReport(t, result({ outcome, revision: null }), { ...options, connectionChanged }).summary;
		expect(said("declined")).toBe("The push was cancelled. Nothing was sent.");
		expect(said("cancelled")).toBe("The push was stopped. Nothing was sent.");
		expect(said("cancelled", true)).toBe("The push was stopped because the connection was changed. Nothing was sent.");
	});

	test("a push that had gone through unknown to this device is told as a success, by a push and by a pull", () => {
		const text = "The previous push had reached the remote: 1 file added, 2 files deleted. It is recorded on this device now.";
		const counts = { added: 1, modified: 0, deleted: 2 };
		const pushed = pushReport(t, result({ outcome: "nothing-to-push", revision: null, recovered: counts }), options);
		expect(pushed.details).toEqual([text]);

		const pulled: PullResult = {
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
			keptUnsent: [],
			newSymlinks: [],
			notices: [],
			closedViews: false,
			refetched: 0,
			recoveredPush: counts,
		};
		expect(pullReport(t, pulled, { settings, sizeLimit: options.sizeLimit }).details).toEqual([text]);
	});

	test("what was not sent, each matter in a message of its own", () => {
		const report = pushReport(
			t,
			result({
				counts: { added: 1, modified: 0, deleted: 0 },
				refused: [
					{ path: "case.md", reason: "case-collision" },
					{ path: "a", reason: "remote-in-the-way" },
				],
				heldRenames: [{ from: "drafts/a.md", to: "Drafts/a.md" }],
				leftOut: [{ path: "gone.md", reason: "gone" }],
				notices: [
					{ kind: "local-path-collision", path: "case.md" },
					{ kind: "rename-not-sent", path: "Drafts/a.md" },
					{ kind: "too-large", path: "big.mov" },
				],
			}),
			options,
		);
		expect(report.summary).toBe("Push finished: 1 file added.");
		expect(report.details.length).toBe(5);
		expect(report.details[0]).toContain("has a file or a folder in its place");
		expect(report.details[0]?.endsWith("\na")).toBe(true);
		expect(report.details[1]).toContain("changed or could not be read while the push ran");
		expect(report.details[2]).toBe("Files over 50 MB are not synced. They are skipped and left as they are:\nbig.mov");
		expect(report.details[3]).toContain("differ only in upper and lower case");
		expect(report.details[3]?.endsWith("\ncase.md")).toBe(true);
		expect(report.details[4]).toContain("was therefore not deleted on the remote either");
		expect(report.details[4]?.endsWith("\nDrafts/a.md")).toBe(true);
	});

	test("files the remote stored as other content than was sent, and what the next pull does", () => {
		const said = (translate: typeof t): readonly string[] =>
			pushReport(translate, result({ counts: { added: 1, modified: 0, deleted: 0 }, storedOtherwise: ["a.md"] }), options).details;
		expect(said(t)).toEqual([
			"GitHub stored 1 file with other content than this device sent. The next pull replaces the file on this device with GitHub's version:\na.md",
		]);
		expect(said(ja)).toEqual([
			"GitHub が、このデバイスが送信した内容と違う内容で保存したファイル：1 件。次の取り込み（pull）で、このデバイスのファイルを GitHub の内容に置き換えます：\na.md",
		]);
	});

	test("the texts that say what to do about a .gitignore that could not be relied on, and about files left out", () => {
		const gitignore = pushReport(t, result({ outcome: "pull-first", revision: null, reason: "gitignore-unsettled" }), options).summary;
		expect(gitignore).toContain("If .gitignore is open in an editor, save or close it, then push again.");
		const leftOut = pushReport(t, result({ leftOut: [{ path: "a.md", reason: "save-failed" }] }), options).details;
		expect(leftOut).toEqual([
			"1 file was left out: it changed or could not be read while the push ran, or an editor could not save it. The next push looks at it again:\na.md",
		]);
		expect(pushReport(ja, result({ outcome: "pull-first", revision: null, reason: "remote-moved" }), options).summary).toBe(
			"何も送信していません。この送信を始めた後に、保存先がほかのデバイスから変更されました。先に取り込み（pull）を行ってから、もう一度送信してください。",
		);
	});

	test("a new file a cloud drive keeps is told apart from the others left out, and the push is not up to date", () => {
		const said = (translate: typeof t) =>
			pushReport(
				translate,
				result({
					outcome: "nothing-to-push",
					revision: null,
					leftOut: [
						{ path: "notes/new.md", reason: "not-downloaded" },
						{ path: "bad.md", reason: "unreadable" },
					],
				}),
				options,
			);
		expect(said(t).summary).toBe("Nothing was sent.");
		expect(said(t).details).toEqual([
			"1 new file was not sent: it is not downloaded to this device (a cloud drive keeps only a placeholder). Download it, then sync again:\nnotes/new.md",
			"1 file was left out: it changed or could not be read while the push ran, or an editor could not save it. The next push looks at it again:\nbad.md",
		]);
		expect(said(ja).details[0]).toBe(
			"1 件の新しいファイルを、送信していません。このデバイスにダウンロードされていないためです（クラウドドライブが仮のファイルだけを置いています）。ダウンロードしてから、もう一度同期してください：\nnotes/new.md",
		);
	});

	test("a collision that was told before is not told again", () => {
		const report = pushReport(t, result({ refused: [{ path: "case.md", reason: "case-collision" }] }), options);
		expect(report.details).toEqual([]);
	});
});

describe("the question before large files are sent", () => {
	const MB = 1024 * 1024;
	const video = { path: "media/video.mov", size: 12 * MB, conflictCopy: false };

	test("alone: the files with their sizes, and buttons that say what they do", () => {
		const question = pushQuestion(t, target, {
			firstPush: null,
			deletions: null,
			largeFiles: [video, { path: "scan.pdf", size: 10 * MB + 1, conflictCopy: false }],
			recordCount: 3,
		});
		expect(question).toEqual({
			title: "Confirm large files",
			parts: [
				{
					text: "2 files to send are larger than 10 MB. A file that was sent stays in the history of the repository, also after it is deleted:",
					paths: { shown: ["media/video.mov (12.0 MB)", "scan.pdf (10.1 MB)"], more: 0 },
				},
			],
			note: "If you cancel, nothing is sent and nothing is changed.",
			buttons: { proceed: "Send", cancel: "Cancel the push" },
		});
	});

	test("a copy kept from a conflict among them: what keeps it from being sent", () => {
		const question = pushQuestion(t, target, {
			firstPush: null,
			deletions: null,
			largeFiles: [{ path: "video.conflict-iPhone-20261003-120000.mov", size: 11 * MB, conflictCopy: true }],
			recordCount: 3,
		});
		expect(question.parts.map((part) => part.text)).toEqual([
			"1 file to send is larger than 10 MB. A file that was sent stays in the history of the repository, also after it is deleted:",
			"A copy kept from a conflict is among them. A rule in .gitignore does not keep such a copy from being sent. To keep it from being sent, cancel the push, then delete the copy or move it out of the vault.",
		]);
	});

	test("with the first push and too many deletions: one question, under the title of the first", () => {
		const question = pushQuestion(t, target, {
			firstPush: { added: ["media/video.mov"], modified: [], deleted: ["a.md"] },
			deletions: ["a.md"],
			largeFiles: [video],
			recordCount: 3,
		});
		expect(question.title).toBe("Confirm the first push");
		expect(question.parts.length).toBe(5);
		expect(question.parts[4]?.paths?.shown).toEqual(["media/video.mov (12.0 MB)"]);
		expect(question.buttons).toEqual({ proceed: "Send", cancel: "Cancel the push" });
		// Without large files, the usual buttons.
		const usual = pushQuestion(t, target, { firstPush: null, deletions: ["a.md"], largeFiles: null, recordCount: 3 });
		expect(usual.buttons).toBeUndefined();
	});

	test("in Japanese", () => {
		const question = pushQuestion(ja, target, {
			firstPush: null,
			deletions: null,
			largeFiles: [{ ...video, conflictCopy: true }],
			recordCount: 3,
		});
		expect(question.title).toBe("大きなファイルの確認");
		expect(question.parts.map((part) => part.text)).toEqual([
			"10MB を超えるファイルを送信します：1 件。送信したファイルは、後で削除しても、リポジトリの履歴に残ります。",
			"この中に、競合で残した別名のファイルがあります。別名のファイルは、.gitignore に書いても送信されます。送信しない時は、送信をやめてから、そのファイルを削除するか、保管庫の外へ移してください。",
		]);
		expect(question.parts[0]?.paths?.shown).toEqual(["media/video.mov（12.0MB）"]);
		expect(question.buttons).toEqual({ proceed: "送る", cancel: "送信をやめる" });
	});
});

describe("a push that could not be carried out", () => {
	test("says why, in the words of the connection test", () => {
		expect(pushFailureText(t, settings, new BackendError("unreachable", "boom"))).toBe(
			"The push failed. Could not reach GitHub. Check the network connection and try again.",
		);
		expect(pushFailureText(ja, settings, new BackendError("unreachable", "boom"))).toBe(
			"送信に失敗しました。GitHub に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
		);
	});

	test("a refusal over workflow files names the permission that is missing", () => {
		expect(pushFailureText(t, settings, new BackendError("workflows-permission", "boom"))).toContain(
			"the token also needs the Workflows read and write permission",
		);
	});

	test("a remote that was not as it was listed: nothing was sent, and the next sync lists it again", () => {
		expect(pushFailureText(t, settings, new BackendError("not-as-listed", "boom"))).toBe(
			"The push failed. Nothing was sent. The remote does not hold what this device had listed for it. The next sync lists the remote again. Sync again.",
		);
		expect(pushFailureText(ja, settings, new BackendError("not-as-listed", "boom"))).toBe(
			"送信に失敗しました。何も送信していません。保存先の中身が、このデバイスが持っている保存先の一覧と違っていました。次の同期で、一覧を取り直します。もう一度同期してください。",
		);
	});

	test("a stop is not a failure", () => {
		expect(pushFailureText(t, settings, new BackendError("cancelled", "boom"))).toBe(
			"The push was stopped. Nothing was sent.",
		);
	});
});

describe("a push that did not get to its end, told again", () => {
	test("says when it began, on the clock of the device, and that a sync sends what is there now", () => {
		const at = new Date(2026, 9, 9, 3, 5, 40).getTime();
		expect(pushFailureReminderText(t, { at })).toBe(
			"The last sync (2026-10-09 03:05) did not finish its push. Changes on this device may not have reached the remote. Nothing is sent again by itself: run a sync to send what this device holds now.",
		);
		expect(pushFailureReminderText(ja, { at })).toBe(
			"前の同期（2026-10-09 03:05）では、送信が終わっていません。このデバイスの変更が、保存先に届いていないことがあります。自動では送り直しません。同期を実行すると、今の内容で送信します。",
		);
	});
});
