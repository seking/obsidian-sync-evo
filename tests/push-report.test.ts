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
import { BackendError } from "../src/core/backend";
import { translatorFor } from "../src/core/i18n";
import { type PartReport, pullReport } from "../src/core/pull-report";
import type { PullResult } from "../src/core/pull";
import type { PushRunResult } from "../src/core/push";
import {
	pushFailureReminderText,
	pushFailureText,
	pushProgressText,
	emptyVaultQuestion,
	pushDetails,
	pushPart,
	pushQuestion,
	pushReport,
	sectionAddedText,
} from "../src/core/push-report";
import type { RemotePlace } from "../src/core/remote-place";
import { DEFAULT_AUTO_SYNC } from "../src/core/settings";

const t = translatorFor("en");
const ja = translatorFor("ja");
const settings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "t",
	dropboxFolder: "",
	dropboxAccount: null,
	gdriveFolder: "",
	gdriveAccount: null,
	gdriveFolderId: null,
	deviceName: "iPhone",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
	deviceExclusion: NO_DEVICE_EXCLUSION,
	exclusionChangeTold: true,
} as const;
const target: RemotePlace = { backend: "github", repository: "octo/notes", branch: "main" };
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
		expect(line("listing")).toBe("Upload: checking GitHub…");
		expect(line("scanning")).toBe("Upload: looking through the vault…");
		expect(line("hashing", 3, 10)).toBe("Upload: comparing files (3/10)…");
		expect(line("sending", 0, 4)).toBe("Upload: sending files…");
		expect(line("sending", 2, 4)).toBe("Upload: sending files (2/4)…");
		expect(line("finishing")).toBe("Upload: finishing…");
	});

	test("a limit that is waited out is a second line, with the time rounded up", () => {
		const until = new Date(2026, 9, 9, 14, 4, 1).getTime();
		const text = pushProgressText(t, { phase: "sending", done: 2, total: 4 }, until);
		expect(text.split("\n")).toEqual([
			"Upload: sending files (2/4)…",
			"GitHub's limit on creating content was reached. The upload continues at 14:05. Keep Obsidian open and in the foreground until then: an upload that stops uploads nothing.",
		]);
	});

	test("in Japanese", () => {
		expect(pushProgressText(ja, { phase: "sending", done: 2, total: 4 })).toBe("アップロード：ファイルを転送中（2/4）…");
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
			title: "Confirm the first upload",
			parts: [
				{
					text: "This is the first upload from this device to octo/notes, branch main. It changes what is on GitHub as listed below. Once an upload has gone through, later uploads do not show this list.",
				},
				{ text: "2 files to add:", paths: { shown: [".obsidian/graph.json", "new.md"], more: 0 } },
				{ text: "1 file to modify:", paths: { shown: ["edit.md"], more: 0 } },
			],
			note: "If you cancel, nothing is uploaded and nothing is changed.",
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
					text: "2 files were deleted on this device. The upload deletes them on GitHub, and a download then deletes them on your other devices.",
					paths: { shown: ["a.md", "b.md"], more: 0 },
				},
			],
			note: "If you cancel, nothing is uploaded and nothing is changed.",
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
			{ text: "The same upload also includes the files below." },
			{ text: "2 files to modify:", paths: { shown: [".obsidian/app.json", ".obsidian/core-plugins.json"], more: 0 } },
			{ text: "1 file to add:", paths: { shown: ["new.md"], more: 0 } },
		]);
		const bare = pushQuestion(t, target, { firstPush: null, deletions: ["a.md"], remoteEmpty: false, recordCount: 3, alsoSent: { added: [], modified: [] } });
		expect(bare.parts).toHaveLength(1);
	});

	test("a vault without its files: how many, where they still are, and what each of the three answers does", () => {
		expect(emptyVaultQuestion(t, target, { missing: 14, deletions: 15 })).toEqual({
			title: "No files in the vault",
			body: "None of the 14 previously synced files are on this device. This happens when the vault was created again, or when its folders were deleted. They are still on GitHub (octo/notes, branch main).",
			choices: [
				{
					answer: "refetch",
					label: "Download again from GitHub",
					text: "The files on GitHub are downloaded to this device. Nothing is deleted on GitHub.",
				},
				{
					answer: "delete",
					label: "Delete on GitHub too",
					text: "15 files are deleted on GitHub too, and a download then deletes them on your other devices.",
				},
				{ answer: "cancel", label: "Cancel", text: "Nothing is uploaded and nothing is changed." },
			],
		});
		expect(emptyVaultQuestion(ja, target, { missing: 14, deletions: 14 })).toEqual({
			title: "保管庫にファイルがありません",
			body: "前に同期したファイル 14 件が、このデバイスに1つもありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。GitHub（octo/notes のブランチ main）には、まだあります。",
			choices: [
				{
					answer: "refetch",
					label: "GitHub からダウンロードし直す",
					text: "GitHub のファイルを、このデバイスにダウンロードします。GitHub からは、何も消しません。",
				},
				{
					answer: "delete",
					label: "GitHub からも削除する",
					text: "14 件を、GitHub からも削除します。ほかのデバイスでも、ダウンロードすると削除されます。",
				},
				{ answer: "cancel", label: "やめる", text: "何もアップロードせず、何も変更しません。" },
			],
		});
	});

	test("a vault without its one file: the words are of one file", () => {
		expect(emptyVaultQuestion(t, target, { missing: 1, deletions: 1 }).body).toBe(
			"The 1 file that was synced before is not on this device. This happens when the vault was created again, or when its folder was deleted. It is still on GitHub (octo/notes, branch main).",
		);
		expect(emptyVaultQuestion(ja, target, { missing: 1, deletions: 1 }).body).toBe(
			"前に同期したファイル 1 件が、このデバイスにありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。GitHub（octo/notes のブランチ main）には、まだあります。",
		);
	});

	test("both at once: one question, and the deleted files are listed once", () => {
		const question = pushQuestion(t, target, {
			firstPush: { added: [], modified: [], deleted: ["a.md", "b.md"] },
			deletions: ["a.md", "b.md"],
			remoteEmpty: false, recordCount: 3,
		});
		expect(question.title).toBe("Confirm the first upload");
		expect(question.parts.map((part) => part.paths?.shown)).toEqual([undefined, ["a.md", "b.md"], undefined]);
		expect(question.parts[2]?.text).toContain("2 files were deleted on this device");
	});

	test("in Japanese", () => {
		const question = pushQuestion(ja, target, {
			firstPush: { added: ["new.md"], modified: ["edit.md"], deleted: ["old.md"] },
			deletions: ["old.md"],
			remoteEmpty: false, recordCount: 3,
		});
		expect(question.title).toBe("最初のアップロードの確認");
		expect(question.parts.map((part) => part.text)).toEqual([
			"このデバイスから octo/notes のブランチ main へ、初めてアップロードします。GitHub を、下のとおりに変更します。アップロードが1回済むと、次からのアップロードでは、この一覧を出しません。",
			"追加するファイル：1 件",
			"変更するファイル：1 件",
			"削除するファイル：1 件",
			"このデバイスで削除したファイル 1 件を、GitHub からも削除します。ほかのデバイスでも、ダウンロードすると削除されます。",
		]);
		expect(question.note).toBe("やめた場合は、何もアップロードせず、何も変更しません。");
	});

	test("with Dropbox, the first push and a vault without its files name the folder in the app folder", () => {
		const place: RemotePlace = { backend: "dropbox", folder: "Vault" };
		const question = pushQuestion(t, place, { firstPush: { added: ["new.md"], modified: [], deleted: [] }, deletions: null, remoteEmpty: false, recordCount: 0 });
		expect(question.parts[0]?.text).toContain("Apps/Sync Evo/Vault");
		expect(question.parts[0]?.text).not.toContain("branch");
		expect(emptyVaultQuestion(t, place, { missing: 14, deletions: 14 }).body).toContain("Apps/Sync Evo/Vault");
		expect(emptyVaultQuestion(t, place, { missing: 1, deletions: 1 }).body).toContain("Apps/Sync Evo/Vault");
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
			"The repository is empty. If this vault has no .gitignore, an empty one is created and uploaded.",
		);
		expect(texts[2]).toBe("2 files to add:");
		expect(pushQuestion(ja, target, request).parts[1]?.text).toContain("リポジトリは空で");
		// Not when the remote has commits.
		expect(pushQuestion(t, target, { ...request, remoteEmpty: false }).parts).toHaveLength(2);
	});
});

describe("the section a push added to .gitignore", () => {
	const lines = ["# >>> Sync Evo: start >>>", "/.trash/", ".DS_Store", "# <<< Sync Evo: end <<<"];
	const added = { lines, created: false, tracked: [] };
	const outside = "Nothing else in .gitignore was changed.";
	const howTo =
		"You can change these lines in the Sync Evo settings. If you do not want them, delete the lines in between and keep the first and the last line (the two that start with #): if those two are deleted as well, the next sync adds the lines again.";
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
			{ text: "This upload includes the change." },
			{ text: howTo },
			{ text: "1 file to add:", paths: { shown: ["new.md"], more: 0 } },
			{ text: "1 file to modify:", paths: { shown: [".gitignore"], more: 0 } },
		]);
		expect(question.note).toBe(
			"If you cancel, nothing is uploaded. The lines added to .gitignore stay on this device, and the next upload includes them.",
		);
		// Without it, the question is the one it was.
		expect(pushQuestion(t, target, request).parts).toHaveLength(3);
		expect(question.parts).toHaveLength(7);
		expect(pushQuestion(t, target, request).note).toBe("If you cancel, nothing is uploaded and nothing is changed.");
	});

	test("the files of the remote the lines match are counted, with a few of them", () => {
		const tracked = Array.from({ length: 7 }, (_, index) => `.trash/${index}.md`);
		const question = pushQuestion(t, target, { ...request, sectionAdded: { ...added, tracked } });
		expect(question.parts[5]).toEqual({
			text: "7 files that these lines exclude are on GitHub. Sync Evo no longer syncs them on any device:",
			paths: { shown: tracked.slice(0, 5), more: 2 },
		});
		// With where they can be taken out of the remote.
		expect(question.parts[6]).toEqual({
			text: "To remove them from GitHub, use \"Remove from GitHub\" in the Sync Evo settings. The files on devices that use Sync Evo stay.",
		});
		expect(question.parts).toHaveLength(9);
		const one = pushQuestion(t, target, { ...request, sectionAdded: { ...added, tracked: [".DS_Store"] } });
		expect(one.parts[5]?.text).toBe("1 file that these lines exclude is on GitHub. Sync Evo no longer syncs it on any device:");
	});

	test("a .gitignore that was made says so, and nothing about the rest of the file; no empty one is promised for an empty remote", () => {
		const question = pushQuestion(t, target, { ...request, remoteEmpty: true, sectionAdded: { ...added, created: true } });
		expect(question.parts.slice(1, 5).map((part) => part.text)).toEqual([
			"The repository is empty.",
			"This vault had no .gitignore, so Sync Evo created one with the lines below. They are the lines Sync Evo manages, and say what is not synced:",
			"This upload includes the change.",
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
			{ text: "この変更は、今回のアップロードに入ります。" },
			{
				text: "これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
			},
			{ text: "これらの行で除外しているファイルが、GitHub に 1 件あります。どのデバイスの Sync Evo も、これらを同期しなくなります：", paths: { shown: tracked, more: 0 } },
		]);
		expect(question.note).toBe("やめた場合は、何もアップロードしません。.gitignore に足した行は、このデバイスに残り、次のアップロードに入ります。");
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
				"This upload included the change.",
				howTo,
			].join("\n"),
		);
	});

	test("with the files of the remote the lines match, a few of them", () => {
		const tracked = Array.from({ length: 6 }, (_, index) => `.trash/${index}.md`);
		const text = sectionAddedText(t, { ...added, tracked }, "sent");
		expect(
			text.endsWith(
				`\n6 files that these lines exclude are on GitHub. Sync Evo no longer syncs them on any device:\n${tracked.slice(0, 3).join("\n")}\n…and 3 more\nTo remove them from GitHub, use \"Remove from GitHub\" in the Sync Evo settings. The files on devices that use Sync Evo stay.`,
			),
		).toBe(true);
	});

	test("a push whose question showed it and that sent it does not tell it again", () => {
		expect(pushReport(t, result({ sectionAdded: { ...added, asked: true, sent: true } }), options).details).toEqual([]);
	});

	test("whether it was sent is the push's to say, not how the push ended: the first commit of a remote holds it though the rest was turned down", () => {
		const turnedDown = result({ outcome: "pull-first", reason: "remote-moved", revision: null, sectionAdded: { ...added, asked: false, sent: true } });
		expect(pushReport(t, turnedDown, options).details[0]).toContain("This upload included the change.");
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
				"This upload may not have included the change. The next sync checks, and uploads it if it is still needed.",
				howTo,
			].join("\n"),
		);
		expect(sectionAddedText(ja, added, "unknown")).toContain(
			"この変更は、今回アップロードできなかったかもしれません。次の同期で確かめて、まだならアップロードします。",
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
					"The change has not been uploaded yet. The next sync uploads it.",
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
				"この変更は、まだアップロードしていません。次の同期でアップロードします。",
				"これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
				"これらの行で除外しているファイルが、GitHub に 1 件あります。どのデバイスの Sync Evo も、これらを同期しなくなります：",
				".DS_Store",
				"GitHub から消すには、Sync Evo の設定画面で「GitHub から削除」を行います。Sync Evo のデバイスのファイルは残ります。",
			].join("\n"),
		);
		expect(sectionAddedText(ja, added, "sent")).toContain("この変更は、今回アップロードしました。");
	});

	test("a push that added none says nothing of it", () => {
		expect(pushReport(t, result(), options).details).toEqual([]);
	});
});

describe("how a push ended", () => {
	test("what was sent, by kind", () => {
		const report = pushReport(t, result({ counts: { added: 2, modified: 1, deleted: 3 } }), options);
		expect(report).toEqual({ summary: "Upload finished: 2 files added, 1 file modified, 3 files deleted.", details: [] });
		expect(pushReport(ja, result({ counts: { added: 2, modified: 1, deleted: 3 } }), options).summary).toBe(
			"アップロードが終わりました：追加 2 件、変更 1 件、削除 3 件",
		);
	});

	test("nothing to send", () => {
		expect(pushReport(t, result({ outcome: "nothing-to-push", revision: null }), options).summary).toBe(
			"Nothing to upload. GitHub is up to date.",
		);
	});

	test("nothing sent while files were left unsent is not called up to date", () => {
		const report = pushReport(t, result({ outcome: "nothing-to-push", revision: null, held: ["a.md"] }), options);
		expect(report.summary).toBe("Nothing was uploaded. Some files cannot be uploaded; the last sync results say why.");
		expect(report.details).toEqual([
			"1 file was not uploaded: a download has not finished with it, or it is open and could not be saved. Sync again:\na.md",
		]);
	});

	test("a pull has to come first, by the reason", () => {
		const summary = (reason: PushRunResult["reason"]): string =>
			pushReport(t, result({ outcome: "pull-first", revision: null, ...(reason === undefined ? {} : { reason }) }), options)
				.summary;
		expect(summary("no-base")).toContain("has not finished its first download");
		expect(summary("remote-empty")).toContain("the repository is empty now");
		expect(summary("not-default-branch")).toContain("The repository is empty");
		expect(summary("remote-moved")).toContain("Another device changed what is on GitHub after this upload began");
		expect(summary("gitignore-unsettled")).toContain(".gitignore");
		for (const reason of ["no-base", "remote-empty", "not-default-branch", "remote-moved", "gitignore-unsettled"] as const) {
			expect(summary(reason).startsWith("Nothing was uploaded. ")).toBe(true);
		}
	});

	test("declined, and stopped", () => {
		const said = (outcome: PushRunResult["outcome"], connectionChanged = false): string =>
			pushReport(t, result({ outcome, revision: null }), { ...options, connectionChanged }).summary;
		expect(said("declined")).toBe("The upload was cancelled. Nothing was uploaded.");
		expect(said("cancelled")).toBe("The upload was stopped. Nothing was uploaded.");
		expect(said("cancelled", true)).toBe("The upload was stopped because the connection was changed. Nothing was uploaded.");
	});

	test("a push that had gone through unknown to this device is told as a success, by a push and by a pull", () => {
		const text = "The previous upload had gone through: 1 file added, 2 files deleted. It is recorded on this device now.";
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
		expect(report.summary).toBe("Upload finished: 1 file added.");
		expect(report.details.length).toBe(5);
		expect(report.details[0]).toContain("there is a file or a folder in its place on GitHub");
		expect(report.details[0]?.endsWith("\na")).toBe(true);
		// The collision is told once, as what was not sent, and not again as its notice.
		expect(report.details[1]).toContain("differs only in upper and lower case");
		expect(report.details[1]?.endsWith("\ncase.md")).toBe(true);
		expect(report.details[2]).toContain("changed or could not be read while the upload ran");
		expect(report.details[3]).toBe("Files over 50 MB are not synced. They are skipped and left as they are, on GitHub and on this device:\nbig.mov");
		expect(report.details[4]).toContain("was therefore not deleted on GitHub either");
		expect(report.details[4]?.endsWith("\nDrafts/a.md")).toBe(true);
	});

	test("files the remote stored as other content than was sent, and what the next pull does", () => {
		const said = (translate: typeof t): readonly string[] =>
			pushReport(translate, result({ counts: { added: 1, modified: 0, deleted: 0 }, storedOtherwise: ["a.md"] }), options).details;
		expect(said(t)).toEqual([
			"GitHub stored 1 file with other content than this device uploaded. The next download replaces the file on this device with the version on GitHub:\na.md",
		]);
		expect(said(ja)).toEqual([
			"GitHub が、このデバイスがアップロードした内容と違う内容で保存したファイル：1 件。次のダウンロードで、このデバイスのファイルを GitHub の内容に置き換えます：\na.md",
		]);
	});

	test("the texts that say what to do about a .gitignore that could not be relied on, and about files left out", () => {
		const gitignore = pushReport(t, result({ outcome: "pull-first", revision: null, reason: "gitignore-unsettled" }), options).summary;
		expect(gitignore).toContain("Sync again; if .gitignore is open in another app, close it first.");
		const leftOut = pushReport(t, result({ leftOut: [{ path: "a.md", reason: "save-failed" }] }), options).details;
		expect(leftOut).toEqual([
			"1 file was left out: it changed or could not be read while the upload ran, or it is open and could not be saved. The next upload looks at it again:\na.md",
		]);
		expect(pushReport(ja, result({ outcome: "pull-first", revision: null, reason: "remote-moved" }), options).summary).toBe(
			"何もアップロードしていません。このアップロードを始めた後に、GitHub がほかのデバイスから変更されました。先にダウンロードを行ってから、もう一度アップロードしてください。",
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
			"1 file was not uploaded: it grew past 50 MB while the upload ran. Files over 50 MB are not synced:\ngrown.mov",
			"1 file was not uploaded: GitHub refused it as too large. Make this file smaller or move it out of the vault. Or exclude it: a file that is not on GitHub yet is simply left out of uploads once excluded. If it is a conflict file, check its content and then delete it:\nbig.mov",
			"1 file was not uploaded: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync uploads it. Otherwise, put this file back as it was and change it with git on a computer. If it is a conflict file that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n.github/workflows/ci.yml",
			"1 file was left out: it changed or could not be read while the upload ran, or it is open and could not be saved. The next upload looks at it again:\na.md",
		]);
		expect(said(ja)[2]).toBe(
			"1 件のファイルを、アップロードしていません。.github/workflows/ の下のファイルを足すか変えるには、トークンに Workflows の読み取りと書き込みの権限が要ります。トークンに権限を足すと、次の同期でアップロードします。足さない時は、このファイルを元の内容に戻して、変更はパソコンの git で行ってください。前の版の Sync Evo が残した競合ファイル（名前に .conflict-from- が入る物）なら、中身を確かめてから削除してください：\n.github/workflows/ci.yml",
		);
		expect(said(ja)[1]).toBe(
			"1 件のファイルを、アップロードしていません。GitHub が、大きすぎるとして受け付けませんでした。このファイルは、小さくするか、保管庫の外へ移してください。GitHub にまだ無いファイルは、除外してもアップロードしなくなります。競合ファイルなら、中身を確かめてから削除してください：\nbig.mov",
		);
	});

	test("a file another device changed first on the remote is told as a conflict to come", () => {
		const said = (translate: typeof t) =>
			pushReport(translate, result({ leftOut: [{ path: "a.md", reason: "remote-changed" }] }), options).details;
		expect(said(t)).toEqual([
			"1 file was neither uploaded nor deleted: another device changed it on GitHub first. The next sync handles it as a conflict:\na.md",
		]);
		expect(said(ja)).toEqual([
			"1 件のファイルを、アップロードも削除もしていません。ほかのデバイスが、先に GitHub で変えていました。次の同期で、競合として扱います：\na.md",
		]);
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
		expect(said(t).summary).toBe("Nothing was uploaded. Some files cannot be uploaded; the last sync results say why.");
		expect(said(t).details).toEqual([
			"1 new file was not uploaded: it is not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep it on this device, then sync again:\nnotes/new.md",
			"1 file was left out: it changed or could not be read while the upload ran, or it is open and could not be saved. The next upload looks at it again:\nbad.md",
		]);
		expect(said(ja).details[0]).toBe(
			"1 件の新しいファイルを、アップロードしていません。中身がこのデバイスに無いためです（クラウドドライブが仮のファイルだけを置いています）。クラウドドライブのアプリでこのデバイスに保存してから、もう一度同期してください：\nnotes/new.md",
		);
	});

	test("a collision is told by every push for as long as it lasts, with the files, and not only by its notice", () => {
		// The notice was told before and is remembered: the push has none
		// to tell. The summary still says that nothing was sent, and the
		// detail says why (2026-10-16, Android).
		const said = (translate: typeof t): PartReport =>
			pushPart(
				translate,
				result({
					outcome: "nothing-to-push",
					revision: null,
					refused: [
						{ path: "Case.md", reason: "case-collision" },
						{ path: "notes/x.md", reason: "case-collision" },
					],
				}),
				options,
			);
		const part = said(t);
		expect(part.summary).toBe("Nothing was uploaded. Some files cannot be uploaded; the last sync results say why.");
		expect(part.details).toHaveLength(1);
		expect(part.details[0]).toMatchObject({ level: "warn", standing: true });
		expect(part.details[0]?.text).toBe(
			"2 new files were not uploaded: their paths differ only in upper and lower case from another path on GitHub, or from another new file, and not every device can keep such paths apart. Rename them, and the next sync uploads them:\nCase.md\nnotes/x.md",
		);
		expect(said(ja).details[0]?.text).toBe(
			"2 件の新しいファイルを、アップロードしていません。GitHub のほかのパス、またはほかの新しいファイルと、大文字と小文字だけが違い、区別できないデバイスがあるためです。名前を変えると、次の同期でアップロードします：\nCase.md\nnotes/x.md",
		);
	});

	test("a collision whose notice is told by this push is told once", () => {
		const report = pushReport(
			t,
			result({
				refused: [{ path: "case.md", reason: "case-collision" }],
				notices: [{ kind: "local-path-collision", path: "case.md" }],
			}),
			options,
		);
		expect(report.details).toHaveLength(1);
		expect(report.details[0]).toContain("1 new file was not uploaded: its path differs only in upper and lower case");
	});
});

describe("how much each thing a push tells matters", () => {
	test("files it did not send are to be seen to, and told by every push; what the remote stored otherwise as well, once", () => {
		const details = pushDetails(
			t,
			result({
				recovered: { added: 1, modified: 0, deleted: 0 },
				held: ["half.md"],
				leftOut: [
					{ path: "big.bin", reason: "too-large" },
					{ path: "x.md", reason: "remote-changed" },
				],
				storedOtherwise: ["a.md"],
			}),
			options,
		);
		expect(details.map((detail) => [detail.level, detail.standing])).toEqual([
			["info", false],
			["warn", true],
			["warn", true],
			["info", false],
			["warn", false],
		]);
		expect(details[3]?.brief).toBe("1 file was changed on GitHub by another device first. The next sync picks it up.");
	});

	test("the section it added is only worth knowing, with a short line, and every file the lines match on the screen", () => {
		const tracked = Array.from({ length: 6 }, (_, index) => `.trash/${index}.md`);
		const section = { lines: ["# >>> Sync Evo", "/.trash/", "# <<< Sync Evo"], created: false, tracked, asked: false, sent: true };
		const [detail] = pushDetails(t, result({ sectionAdded: section }), options);
		expect(detail?.level).toBe("info");
		expect(detail?.brief).toBe("Sync Evo added the lines it manages to .gitignore.");
		expect(detail?.text).toBe(sectionAddedText(t, section, "sent"));
		expect(detail?.full).toBe(sectionAddedText(t, section, "sent", Number.POSITIVE_INFINITY));
		expect(detail?.full).toContain(tracked.join("\n"));
	});

	test("a notice lists the first files of a kind, the screen of the results all of them", () => {
		const held = Array.from({ length: 4 }, (_, index) => `${index}.md`);
		const [detail] = pushDetails(t, result({ held }), options);
		expect(detail?.text.split("\n").slice(1)).toEqual([...held.slice(0, 3), "…and 1 more"]);
		expect(detail?.full.split("\n").slice(1)).toEqual(held);
	});

	test("a push that sent nothing until the user does something ends with something to see to", () => {
		const level = (over: Partial<PushRunResult>) => pushPart(t, result(over), options).level;
		expect(level({})).toBe("info");
		expect(level({ outcome: "pull-first", reason: "no-base", revision: null })).toBe("warn");
		expect(level({ outcome: "pull-first", reason: "gitignore-unreadable", revision: null })).toBe("warn");
		// Not where another device only pushed in between: the next sync pulls first by itself.
		expect(level({ outcome: "pull-first", reason: "remote-moved", revision: null })).toBe("info");
		expect(level({ outcome: "nothing-to-push", revision: null })).toBe("info");
		// Files left unsent are seen to by their own details, which stay. A
		// rename told once already has none, and a summary that stays would
		// say "as told" on every push.
		const held = pushPart(t, result({ outcome: "nothing-to-push", revision: null, held: ["a.md"] }), options);
		expect(held.level).toBe("info");
		expect(held.details.map((detail) => detail.level)).toEqual(["warn"]);
		expect(level({ outcome: "nothing-to-push", revision: null, heldRenames: [{ from: "tools", to: "Tools" }] as never })).toBe("info");
	});
});

describe("a push that could not be carried out", () => {
	test("says why, in the words of the connection test", () => {
		expect(pushFailureText(t, settings, new BackendError("unreachable", "boom"))).toBe(
			"The upload failed. Could not reach GitHub. Check the network connection and try again.",
		);
		expect(pushFailureText(ja, settings, new BackendError("unreachable", "boom"))).toBe(
			"アップロードに失敗しました。GitHub に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
		);
	});

	test("a refusal over workflow files names the permission that is missing", () => {
		expect(pushFailureText(t, settings, new BackendError("workflows-permission", "boom"))).toContain(
			"the token also needs the Workflows read and write permission",
		);
	});

	test("a remote that was not as it was listed: nothing was sent, and the next sync lists it again", () => {
		expect(pushFailureText(t, settings, new BackendError("not-as-listed", "boom"))).toBe(
			"The upload failed. Nothing was changed on GitHub: what is there is not what this device knew of it. Sync again.",
		);
		expect(pushFailureText(ja, settings, new BackendError("not-as-listed", "boom"))).toBe(
			"アップロードに失敗しました。GitHub では何も変更していません。GitHub の中身が、このデバイスが知っている内容と違っていました。もう一度同期してください。",
		);
	});

	test("a stop is not a failure", () => {
		expect(pushFailureText(t, settings, new BackendError("cancelled", "boom"))).toBe(
			"The upload was stopped. Nothing was uploaded.",
		);
	});
});

describe("a push that did not get to its end, told again", () => {
	test("says when it began, on the clock of the device, and that a sync sends what is there now", () => {
		const at = new Date(2026, 9, 9, 3, 5, 40).getTime();
		expect(pushFailureReminderText(t, { at })).toBe(
			"The last sync (2026-10-09 03:05) did not finish its upload. Changes on this device may not have been uploaded. Nothing is uploaded again by itself: run a sync to upload what this device holds now.",
		);
		expect(pushFailureReminderText(ja, { at })).toBe(
			"前の同期（2026-10-09 03:05）では、アップロードが終わっていません。このデバイスの変更が、アップロードされていないことがあります。自動ではアップロードし直しません。同期を実行すると、今の内容でアップロードします。",
		);
	});
});
