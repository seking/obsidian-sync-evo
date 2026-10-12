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
	emptyVaultQuestion,
	pushQuestion,
	pushReport,
	sectionAddedText,
} from "../src/core/push-report";
import { DEFAULT_AUTO_SYNC } from "../src/core/settings";

const t = translatorFor("en");
const ja = translatorFor("ja");
const settings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "t",
	deviceName: "iPhone",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
} as const;
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
			remoteEmpty: false, recordCount: 3,
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
		const question = pushQuestion(t, target, { firstPush: { added, modified: [], deleted: [] }, deletions: null, remoteEmpty: false, recordCount: 0 });
		expect(question.parts[1]?.paths?.shown.length).toBe(50);
		expect(question.parts[1]?.paths?.more).toBe(3);
	});

	test("too many deletions: how many, which, and what follows on the other devices", () => {
		const question = pushQuestion(t, target, { firstPush: null, deletions: ["a.md", "b.md"], remoteEmpty: false, recordCount: 3 });
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

	test("the deletions after the answer to delete on the remote too: what else the push sends is listed under them", () => {
		const question = pushQuestion(t, target, {
			firstPush: null,
			deletions: ["a.md"],
			remoteEmpty: false,
			recordCount: 3,
			alsoSent: { added: ["new.md"], modified: [".obsidian/app.json", ".obsidian/core-plugins.json"] },
		});
		expect(question.title).toBe("Confirm deletions");
		expect(question.parts.slice(1)).toEqual([
			{ text: "The same push also sends the files below to the remote." },
			{ text: "2 files to modify:", paths: { shown: [".obsidian/app.json", ".obsidian/core-plugins.json"], more: 0 } },
			{ text: "1 file to add:", paths: { shown: ["new.md"], more: 0 } },
		]);
		const bare = pushQuestion(t, target, { firstPush: null, deletions: ["a.md"], remoteEmpty: false, recordCount: 3, alsoSent: { added: [], modified: [] } });
		expect(bare.parts).toHaveLength(1);
	});

	test("a vault without its files: how many, where they still are, and what each of the three answers does", () => {
		expect(emptyVaultQuestion(t, target, { missing: 14, deletions: 15 })).toEqual({
			title: "No files in the vault",
			body: "None of the 14 files that were synced before is on this device. This happens when the vault was created again, or when its folders were deleted. The remote (octo/notes, branch main) still has them.",
			choices: [
				{
					answer: "refetch",
					label: "Fetch again from the remote",
					text: "The files of the remote are fetched to this device. Nothing is deleted on the remote.",
				},
				{
					answer: "delete",
					label: "Delete on the remote too",
					text: "15 files are deleted on the remote too, and a pull then deletes them on your other devices.",
				},
				{ answer: "cancel", label: "Cancel", text: "Nothing is sent and nothing is changed." },
			],
		});
		expect(emptyVaultQuestion(ja, target, { missing: 14, deletions: 14 })).toEqual({
			title: "保管庫にファイルがありません",
			body: "前に同期したファイル 14 件が、このデバイスに1つもありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。保存先（octo/notes のブランチ main）には、まだあります。",
			choices: [
				{
					answer: "refetch",
					label: "保存先から取り込み直す",
					text: "保存先のファイルを、このデバイスに取り込みます。保存先からは、何も消しません。",
				},
				{
					answer: "delete",
					label: "保存先からも削除する",
					text: "14 件を、保存先からも削除します。ほかのデバイスでも、取り込むと削除されます。",
				},
				{ answer: "cancel", label: "やめる", text: "何も送信せず、何も変更しません。" },
			],
		});
	});

	test("a vault without its one file: the words are of one file", () => {
		expect(emptyVaultQuestion(t, target, { missing: 1, deletions: 1 }).body).toBe(
			"The 1 file that was synced before is not on this device. This happens when the vault was created again, or when its folder was deleted. The remote (octo/notes, branch main) still has it.",
		);
		expect(emptyVaultQuestion(ja, target, { missing: 1, deletions: 1 }).body).toBe(
			"前に同期したファイル 1 件が、このデバイスにありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。保存先（octo/notes のブランチ main）には、まだあります。",
		);
	});

	test("both at once: one question, and the deleted files are listed once", () => {
		const question = pushQuestion(t, target, {
			firstPush: { added: [], modified: [], deleted: ["a.md", "b.md"] },
			deletions: ["a.md", "b.md"],
			remoteEmpty: false, recordCount: 3,
		});
		expect(question.title).toBe("Confirm the first push");
		expect(question.parts.map((part) => part.paths?.shown)).toEqual([undefined, ["a.md", "b.md"], undefined]);
		expect(question.parts[2]?.text).toContain("2 files were deleted on this device");
	});

	test("in Japanese", () => {
		const question = pushQuestion(ja, target, {
			firstPush: { added: ["new.md"], modified: ["edit.md"], deleted: ["old.md"] },
			deletions: ["old.md"],
			remoteEmpty: false, recordCount: 3,
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

describe("the question before the first push to a remote without commits", () => {
	test("says that the remote is empty, and that two commits are made", () => {
		const request = {
			firstPush: { added: [".gitignore", "a.md"], modified: [], deleted: [] },
			remoteEmpty: true,
			deletions: null,
			recordCount: 0,
		};
		const texts = pushQuestion(t, target, request).parts.map((part) => part.text);
		expect(texts[0]).toContain("octo/notes");
		expect(texts[1]).toBe(
			"The remote is empty: it has no commits yet. A first commit with the .gitignore alone is made, and the rest is sent after it. If this vault has no .gitignore, an empty one is created.",
		);
		expect(texts[2]).toBe("2 files to add:");
		expect(pushQuestion(ja, target, request).parts[1]?.text).toContain("保存先は空で");
		// Not when the remote has commits.
		expect(pushQuestion(t, target, { ...request, remoteEmpty: false }).parts).toHaveLength(2);
	});
});

describe("the section a push added to .gitignore", () => {
	const lines = ["# >>> Sync Evo: start >>>", "/.trash/", ".DS_Store", "# <<< Sync Evo: end <<<"];
	const added = { lines, created: false, tracked: [] };
	const outside = "Nothing else in .gitignore was changed.";
	const howTo =
		"You can change these lines in the settings of Sync Evo. If you do not want them, delete the lines in between and keep the first and the last line (the two that start with #): if those two are deleted as well, the next sync adds the lines again.";
	const request = {
		firstPush: { added: ["new.md"], modified: [".gitignore"], deleted: [] },
		remoteEmpty: false,
		deletions: null,
		recordCount: 2,
	};

	test("the question before the first push shows the lines, before the lists, and what a no leaves behind", () => {
		const question = pushQuestion(t, target, { ...request, sectionAdded: added });
		expect(question.parts.slice(1)).toEqual([
			{
				text: "Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
				paths: { shown: lines, more: 0 },
			},
			{ text: outside },
			{ text: "This push sends the change to the remote." },
			{ text: howTo },
			{ text: "1 file to add:", paths: { shown: ["new.md"], more: 0 } },
			{ text: "1 file to modify:", paths: { shown: [".gitignore"], more: 0 } },
		]);
		expect(question.note).toBe(
			"If you cancel, nothing is sent. The lines added to .gitignore stay on this device, and the next push sends them.",
		);
		// Without it, the question is the one it was.
		expect(pushQuestion(t, target, request).parts).toHaveLength(3);
		expect(question.parts).toHaveLength(7);
		expect(pushQuestion(t, target, request).note).toBe("If you cancel, nothing is sent and nothing is changed.");
	});

	test("the files of the remote the lines match are counted, with a few of them", () => {
		const tracked = Array.from({ length: 7 }, (_, index) => `.trash/${index}.md`);
		const question = pushQuestion(t, target, { ...request, sectionAdded: { ...added, tracked } });
		expect(question.parts[5]).toEqual({
			text: "7 files that these lines match are already on the remote, so they stay synced:",
			paths: { shown: tracked.slice(0, 5), more: 2 },
		});
		// With where they can be taken out of the remote.
		expect(question.parts[6]).toEqual({
			text: "To stop syncing them, untrack them in the settings of Sync Evo. That removes them from the remote and leaves them on this device.",
		});
		expect(question.parts).toHaveLength(9);
		const one = pushQuestion(t, target, { ...request, sectionAdded: { ...added, tracked: [".DS_Store"] } });
		expect(one.parts[5]?.text).toBe("1 file that these lines match is already on the remote, so it stays synced:");
	});

	test("a .gitignore that was made says so, and nothing about the rest of the file; no empty one is promised for an empty remote", () => {
		const question = pushQuestion(t, target, { ...request, remoteEmpty: true, sectionAdded: { ...added, created: true } });
		expect(question.parts.slice(1, 5).map((part) => part.text)).toEqual([
			"The remote is empty: it has no commits yet. A first commit with the .gitignore alone is made, and the rest is sent after it.",
			"This vault had no .gitignore, so Sync Evo created one with the lines below. They are the lines Sync Evo manages, and say what is not synced:",
			"This push sends the change to the remote.",
			howTo,
		]);
	});

	test("the question in Japanese", () => {
		const tracked = [".trash/old.md"];
		const question = pushQuestion(ja, target, { ...request, sectionAdded: { ...added, tracked } });
		expect(question.parts.slice(1, 6)).toEqual([
			{
				text: "この保管庫の .gitignore の先頭に、下の行を足しました。Sync Evo が管理する行で、同期しない物を決めます：",
				paths: { shown: lines, more: 0 },
			},
			{ text: ".gitignore のほかの部分は、変えていません。" },
			{ text: "この変更は、この送信で保存先に届きます。" },
			{
				text: "これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
			},
			{ text: "これらの行に当たるファイルが、保存先に 1 件あります。これらは同期を続けます：", paths: { shown: tracked, more: 0 } },
		]);
		expect(question.note).toBe("やめた場合は、何も送信しません。.gitignore に足した行は、このデバイスに残り、次の送信で届きます。");
		const created = pushQuestion(ja, target, { ...request, sectionAdded: { ...added, created: true } });
		expect(created.parts[1]?.text).toBe(
			"この保管庫に .gitignore が無かったので、下の行で作りました。Sync Evo が管理する行で、同期しない物を決めます：",
		);
	});

	test("a push that asked nothing tells it with its result, first, with every line", () => {
		const many = { ...added, lines: Array.from({ length: 15 }, (_, index) => `line ${index}`) };
		const report = pushReport(
			t,
			result({ counts: { added: 0, modified: 1, deleted: 0 }, held: ["a.md"], sectionAdded: { ...many, asked: false, sent: true } }),
			options,
		);
		expect(report.details).toHaveLength(2);
		expect(report.details[0]).toBe(
			[
				"Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
				...many.lines,
				outside,
				"This push sent the change to the remote.",
				howTo,
			].join("\n"),
		);
	});

	test("with the files of the remote the lines match, a few of them", () => {
		const tracked = Array.from({ length: 6 }, (_, index) => `.trash/${index}.md`);
		const text = sectionAddedText(t, { ...added, tracked }, "sent");
		expect(
			text.endsWith(
				`\n6 files that these lines match are already on the remote, so they stay synced:\n${tracked.slice(0, 5).join("\n")}\n…and 1 more\nTo stop syncing them, untrack them in the settings of Sync Evo. That removes them from the remote and leaves them on this device.`,
			),
		).toBe(true);
	});

	test("a push whose question showed it and that sent it does not tell it again", () => {
		expect(pushReport(t, result({ sectionAdded: { ...added, asked: true, sent: true } }), options).details).toEqual([]);
	});

	test("whether it was sent is the push's to say, not how the push ended: the first commit of a remote holds it though the rest was turned down", () => {
		const turnedDown = result({ outcome: "pull-first", reason: "remote-moved", revision: null, sectionAdded: { ...added, asked: false, sent: true } });
		expect(pushReport(t, turnedDown, options).details[0]).toContain("This push sent the change to the remote.");
		// And then it is not told again after a question that showed it.
		const asked = result({ outcome: "pull-first", reason: "remote-moved", revision: null, sectionAdded: { ...added, asked: true, sent: true } });
		expect(pushReport(t, asked, options).details).toEqual([]);
	});

	test("a push that failed does not know whether it was sent, and says so", () => {
		expect(sectionAddedText(t, added, "unknown")).toBe(
			[
				"Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
				...lines,
				outside,
				"Whether this push sent the change to the remote is not known. If it did not, the next push sends it.",
				howTo,
			].join("\n"),
		);
		expect(sectionAddedText(ja, added, "unknown")).toContain(
			"この変更が、この送信で保存先に届いたかは、分かりません。届いていなければ、次の送信で届きます。",
		);
	});

	test.each<[string, Partial<PushRunResult>]>([
		["declined", { outcome: "declined", revision: null }],
		["stopped", { outcome: "cancelled", revision: null }],
		["turned down by the remote", { outcome: "pull-first", reason: "remote-moved", revision: null }],
		["left without anything sent", { outcome: "nothing-to-push", revision: null }],
		["sent without the .gitignore", { leftOut: [{ path: ".gitignore", reason: "save-failed" }] }],
	])("a push that was %s tells it all the same, as not sent yet, also after a question that showed it", (_name, ended) => {
		for (const asked of [true, false]) {
			const [first] = pushReport(t, result({ ...ended, sectionAdded: { ...added, asked, sent: false } }), options).details;
			expect(first).toBe(
				[
					"Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
					...lines,
					outside,
					"The change has not been sent to the remote yet. The next push sends it.",
					howTo,
				].join("\n"),
			);
		}
	});

	test("the result in Japanese", () => {
		expect(sectionAddedText(ja, { ...added, created: true, tracked: [".DS_Store"] }, "unsent")).toBe(
			[
				"この保管庫に .gitignore が無かったので、下の行で作りました。Sync Evo が管理する行で、同期しない物を決めます：",
				...lines,
				"この変更は、まだ保存先に届いていません。次の送信で届きます。",
				"これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
				"これらの行に当たるファイルが、保存先に 1 件あります。これらは同期を続けます：",
				".DS_Store",
				"同期をやめるには、Sync Evo の設定画面で追跡を外します。保存先からは消え、このデバイスのファイルは残ります。",
			].join("\n"),
		);
		expect(sectionAddedText(ja, added, "sent")).toContain("この変更は、この送信で保存先に届きました。");
	});

	test("a push that added none says nothing of it", () => {
		expect(pushReport(t, result(), options).details).toEqual([]);
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
		expect(summary("remote-empty")).toContain("The remote has no commits");
		expect(summary("not-default-branch")).toContain("The remote is empty");
		expect(summary("remote-moved")).toContain("changed from another device after this push began");
		expect(summary("gitignore-unsettled")).toContain(".gitignore");
		for (const reason of ["no-base", "remote-empty", "not-default-branch", "remote-moved", "gitignore-unsettled"] as const) {
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

	test("a file left out for its size says what to do about it, apart from the ones that only need another push", () => {
		const said = (translate: typeof t) =>
			pushReport(
				translate,
				result({
					leftOut: [
						{ path: "grown.mov", reason: "too-large" },
						{ path: "big.mov", reason: "refused-size" },
						{ path: ".github/workflows/ci.yml", reason: "refused-workflows" },
						{ path: "a.md", reason: "gone" },
					],
				}),
				options,
			).details;
		expect(said(t)).toEqual([
			"1 file was not sent: it grew past 50 MB while the push ran. Files over 50 MB are not synced:\ngrown.mov",
			"1 file was not sent: GitHub refused it as too large. Make this file smaller or move it out of the vault. A file the remote does not hold yet is also left alone once it is in .gitignore. If it is a conflict copy, check its content and then delete it:\nbig.mov",
			"1 file was not sent: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync sends it. Otherwise, put this file back as it was and change it on a device that has git. If it is a conflict copy that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n.github/workflows/ci.yml",
			"1 file was left out: it changed or could not be read while the push ran, or an editor could not save it. The next push looks at it again:\na.md",
		]);
		expect(said(ja)[2]).toBe(
			"1 件のファイルを、送信していません。.github/workflows/ の下のファイルを足すか変えるには、トークンに Workflows の読み取りと書き込みの権限が要ります。トークンに権限を足すと、次の同期で送信します。足さない時は、このファイルを元の内容に戻して、変更は git が使えるデバイスで行ってください。前の版の Sync Evo が残した競合の別名（名前に .conflict-from- が入る物）なら、中身を確かめてから削除してください：\n.github/workflows/ci.yml",
		);
		expect(said(ja)[1]).toBe(
			"1 件のファイルを、送信していません。GitHub が、大きすぎるとして受け付けませんでした。このファイルは、小さくするか、保管庫の外へ移してください。保存先にまだ無いファイルは、.gitignore に足しても送らなくなります。競合で残した別名のファイルなら、中身を確かめてから削除してください：\nbig.mov",
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
