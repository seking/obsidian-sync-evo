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
import type { UntrackableFile } from "../src/core/exclusion-settings";
import { translatorFor } from "../src/core/i18n";
import { noticeTexts, pullReport } from "../src/core/pull-report";
import type { PullResult } from "../src/core/pull";
import type { PushRunResult } from "../src/core/push";
import { pushReport } from "../src/core/push-report";
import type { UntrackRefusal, UntrackRunResult, UntrackSyncResult } from "../src/core/untrack";
import {
	type UntrackConfirmRequest,
	untrackConfirmRequest,
	untrackedSome,
	untrackStopped,
	untrackFailureText,
	untrackQuestion,
	untrackReport,
	untrackSubmodulesText,
	untrackSyncReport,
} from "../src/core/untrack-report";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";
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

const plain = (path: string): UntrackableFile => ({ path, symlink: false, ownFolder: false });

function request(overrides: Partial<UntrackConfirmRequest> = {}): UntrackConfirmRequest {
	return { files: [plain("drafts/a.md"), plain("drafts/b.md")], submodules: [], missing: [], recordCount: 100, ...overrides };
}

function ended(overrides: Partial<UntrackRunResult> = {}): UntrackRunResult {
	return { outcome: "untracked", revision: "a".repeat(40), untracked: ["drafts/a.md", "drafts/b.md"], recovered: null, ...overrides };
}

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
};

const pushed: PushRunResult = {
	outcome: "nothing-to-push",
	revision: null,
	counts: { added: 0, modified: 0, deleted: 0 },
	recovered: null,
	refused: [],
	heldRenames: [],
	held: [],
	leftOut: [],
	notices: [],
	storedOtherwise: [],
};

describe("the question before untracking", () => {
	test("the files, what becomes of them here and elsewhere, the sync that comes first, and the two buttons", () => {
		const question = untrackQuestion(t, request());
		expect(question.title).toBe("Remove files from GitHub");
		expect(question.proceed).toBe("Remove from GitHub");
		expect(question.cancel).toBe("Not now");
		expect(question.shown).toEqual(["drafts/a.md", "drafts/b.md"]);
		expect(question.parts).toEqual([
			{
				text: "2 excluded files are on GitHub. Removing them from GitHub stops syncing them:",
				paths: { shown: ["drafts/a.md", "drafts/b.md"], more: 0 },
			},
			{ text: "The files on this device are not deleted. They stay as they are." },
			{
				text: "On your other devices, the next download deletes these files, except files that were changed on that device.",
			},
			{
				text: "A download runs first. If the exclusions have not been uploaded yet, an upload runs too, and the other changes of this device go up with them.",
			},
			{
				text: "To keep the files where you use git on a computer, do not remove them here: run git rm --cached on that computer, and push from there. The next download then deletes these files from this device.",
			},
		]);
		expect(question.note).toBe(
			'If you choose "Not now", the exclusions stay, and these files stay synced. You can remove them later in the settings of Sync Evo.',
		);
	});

	test("one file", () => {
		const question = untrackQuestion(t, request({ files: [plain("drafts/a.md")] }));
		expect(question.parts[0]?.text).toBe(
			"1 excluded file is on GitHub. Removing it from GitHub stops syncing it:",
		);
	});

	test("a link, a file of Sync Evo's own folder, and a file this device does not hold are marked in the list", () => {
		const files: UntrackableFile[] = [
			{ path: ".obsidian/plugins/sync-evo/main.js", symlink: false, ownFolder: true },
			{ path: "drafts/big.bin", symlink: false, ownFolder: false },
			{ path: "drafts/link", symlink: true, ownFolder: false },
			plain("drafts/a.md"),
		];
		const question = untrackQuestion(t, request({ files, missing: ["drafts/link", "drafts/big.bin", "not/in/the/list.md"] }));
		expect(question.parts[0]?.paths?.shown).toEqual([
			".obsidian/plugins/sync-evo/main.js (Sync Evo's own folder)",
			"drafts/big.bin (not on this device)",
			"drafts/link (symbolic link, not on this device)",
			"drafts/a.md",
		]);
		// What is handed on is the paths, without the marks.
		expect(question.shown).toEqual(files.map((file) => file.path));
		// After what becomes of the files on this device and on the others.
		expect(question.parts[3]).toEqual({
			text: "2 of these files are not on this device. Those in the list are marked there. After they are removed, their content is only in the history on GitHub.",
		});
		expect(untrackQuestion(t, request({ missing: ["drafts/a.md"] })).parts[3]?.text).toBe(
			"1 of these files is not on this device. If it is in the list, it is marked there. After it is removed, its content is only in the history on GitHub.",
		);
	});

	test("a file that is not on the device is found by its key, whichever way the path is normalized", () => {
		const nfc = "drafts/ガイド.md";
		const question = untrackQuestion(t, request({ files: [plain(nfc.normalize("NFD"))], missing: [nfc] }));
		expect(question.parts[0]?.paths?.shown).toEqual([`${nfc.normalize("NFD")} (not on this device)`]);
	});

	test("submodules a rule matches are listed apart, for git on a computer", () => {
		const question = untrackQuestion(t, request({ submodules: ["knowledge", "lib"] }));
		expect(question.parts).toHaveLength(6);
		expect(question.parts[3]).toEqual({
			text: "2 submodules are excluded as well. They are not removed here. Remove them with git on a computer:",
			paths: { shown: ["knowledge", "lib"], more: 0 },
		});
		expect(question.shown).toEqual(["drafts/a.md", "drafts/b.md"]);
	});

	test("the list stops at fifty, and everything is handed on all the same", () => {
		const files = Array.from({ length: 53 }, (_, index) => plain(`drafts/${String(index).padStart(2, "0")}.md`));
		const question = untrackQuestion(t, request({ files, recordCount: 10_000 }));
		const list = question.parts[1]?.paths;
		expect(list?.shown).toHaveLength(50);
		expect(list?.more).toBe(3);
		expect(question.shown).toHaveLength(53);
	});

	test("past the threshold of deletions, the count is warned of first, in the same question", () => {
		const files = (count: number): UntrackableFile[] => Array.from({ length: count }, (_, index) => plain(`drafts/${index}.md`));
		const warning = (count: number, recordCount: number): string | undefined => {
			const question = untrackQuestion(t, request({ files: files(count), recordCount }));
			return question.parts.length === 6 ? question.parts[0]?.text : undefined;
		};
		expect(warning(51, 10_000)).toBe("This removes 51 files from GitHub at once. Check the list before you go on.");
		expect(warning(50, 10_000)).toBeUndefined();
		// More than five, and more than a tenth of everything.
		expect(warning(6, 59)).toBe("This removes 6 files from GitHub at once. Check the list before you go on.");
		expect(warning(6, 60)).toBeUndefined();
		expect(warning(5, 10)).toBeUndefined();
	});

	test("in Japanese", () => {
		const files: UntrackableFile[] = [{ path: "drafts/link", symlink: true, ownFolder: false }, plain("drafts/a.md")];
		const question = untrackQuestion(ja, request({ files, missing: ["drafts/link"], submodules: ["knowledge"] }));
		expect(question.title).toBe("GitHub から削除する確認");
		expect(question.proceed).toBe("GitHub から削除");
		expect(question.cancel).toBe("今は削除しない");
		expect(question.parts.map((part) => part.text)).toEqual([
			"GitHub に、除外しているファイルが 2 件あります。GitHub から削除すると、同期しなくなります：",
			"このデバイスのファイルは削除しません。そのまま残ります。",
			"ほかのデバイスでは、次のダウンロードで削除されます。そのデバイスで変更していたファイルは残ります。",
			"このうち 1 件は、このデバイスにありません。一覧に出した物には、印を付けています。GitHub から削除すると、中身は GitHub の履歴にだけ残ります。",
			"除外しているサブモジュールも 1 件あります。ここでは削除しません。パソコンの git で行ってください：",
			"先にダウンロードします。除外の設定をまだアップロードしていない時は、アップロードもするので、このデバイスのほかの変更も一緒にアップロードされます。",
			"パソコンの git の側にファイルを残したい時は、ここでは削除せず、そのパソコンで git rm --cached をして push してください。その時は、このデバイスのファイルが、次のダウンロードで削除されます。",
		]);
		expect(question.parts[0]?.paths?.shown).toEqual(["drafts/link（シンボリックリンク、このデバイスに無い）", "drafts/a.md"]);
		expect(question.note).toBe(
			"「今は削除しない」を選ぶと、除外の設定は残り、これらのファイルは同期を続けます。後から、Sync Evo の設定画面で削除できます。",
		);
	});
});

describe("how untracking ended", () => {
	test("untracked: the count, and that the files on this device are as they were", () => {
		expect(untrackReport(t, ended())).toEqual({
			summary: "Removed 2 files from GitHub. The files on this device are as they were.",
			details: [],
		});
		expect(untrackReport(t, ended({ untracked: ["a.md"] })).summary).toBe(
			"Removed 1 file from GitHub. The file on this device is as it was.",
		);
		expect(untrackReport(ja, ended()).summary).toBe(
			"GitHub から 2 件を削除しました。このデバイスのファイルは、そのままです。",
		);
	});

	test("nothing to untrack, a remote that moved, and a stop", () => {
		const said = (outcome: UntrackRunResult["outcome"]): string =>
			untrackReport(t, ended({ outcome, revision: null, untracked: [] })).summary;
		expect(said("nothing-to-untrack")).toBe(
			"There was nothing to remove from GitHub: none of the listed files is still there and excluded. Nothing was changed.",
		);
		expect(said("remote-moved")).toBe(
			"Nothing was removed from GitHub. Another device changed what is there meanwhile. Try again in the settings of Sync Evo.",
		);
		expect(said("cancelled")).toBe("The removal was stopped. Nothing was removed from GitHub.");
	});

	test("each reason a sync has to come first has a text of its own, in both languages", () => {
		const reasons: UntrackRefusal[] = [
			"remote-empty",
			"pull-unfinished",
			"gitignore-unsettled",
			"gitignore-unreadable",
			"no-section",
			"section-broken",
			"gitignore-not-sent",
		];
		for (const translate of [t, ja]) {
			const texts = reasons.map(
				(reason) => untrackReport(translate, ended({ outcome: "sync-first", reason, revision: null, untracked: [] })).summary,
			);
			expect(new Set(texts).size).toBe(reasons.length);
			for (const text of texts) expect(text).not.toContain("{");
		}
		const said = (reason: UntrackRefusal): string =>
			untrackReport(t, ended({ outcome: "sync-first", reason, revision: null, untracked: [] })).summary;
		expect(said("gitignore-not-sent")).toBe(
			"Nothing was removed from GitHub. The exclusions have not been uploaded yet. Sync, then try again in the settings of Sync Evo.",
		);
		expect(said("no-section")).toContain("has no lines managed by Sync Evo");
		for (const reason of reasons) expect(said(reason).startsWith("Nothing was removed from GitHub.")).toBe(true);
	});

	test("an earlier push or untracking it found to have gone through is a message of its own", () => {
		const push = untrackReport(t, ended({ recovered: { added: 1, modified: 0, deleted: 0 } }));
		expect(push.details).toEqual(["The previous upload had gone through: 1 file added. It is recorded on this device now."]);
		const untracking = untrackReport(t, ended({ outcome: "nothing-to-untrack", untracked: [], recoveredUntrack: 2 }));
		expect(untracking.details).toEqual([
			"An earlier removal from GitHub had gone through: 2 files removed. It is recorded on this device now. The files on this device are as they were.",
		]);
	});

	test("a failure, with its reason; a stop is told as a stop", () => {
		expect(untrackFailureText(t, settings, new BackendError("unreachable", "timed out"))).toBe(
			"Removing from GitHub failed. Could not reach GitHub. Check the network connection and try again.",
		);
		expect(untrackFailureText(ja, settings, new BackendError("not-as-listed", "x"))).toBe(
			"GitHub から削除できませんでした。GitHub では何も変更していません。GitHub の中身が、このデバイスが知っている内容と違っていました。もう一度同期してください。",
		);
		expect(untrackFailureText(t, settings, new BackendError("cancelled", "x"))).toBe(
			"The removal was stopped. Nothing was removed from GitHub.",
		);
		expect(untrackFailureText(t, settings, new BackendError("cancelled", "x"), true)).toBe(
			"The removal was stopped because the connection was changed. Nothing was removed from GitHub.",
		);
		// A failure is told as that, whatever became of the connection.
		expect(untrackFailureText(t, settings, new BackendError("not-as-listed", "x"), true)).toBe(
			untrackFailureText(t, settings, new BackendError("not-as-listed", "x")),
		);
	});
});

describe("how untracking after a sync ended", () => {
	const sync = (overrides: Partial<UntrackSyncResult>): UntrackSyncResult => ({ pull: pulled, push: null, untrack: null, ...overrides });

	test("got to, it is told as the untracking it was", () => {
		expect(untrackSyncReport(t, sync({ untrack: ended() }))).toEqual(untrackReport(t, ended()));
		const refused = ended({ outcome: "sync-first", reason: "pull-unfinished", revision: null, untracked: [] });
		expect(untrackSyncReport(t, sync({ push: pushed, untrack: refused }))).toEqual(untrackReport(t, refused));
	});

	test("not got to: why, and that the rules stay", () => {
		const said = (skipped: UntrackSyncResult["skipped"]): string => {
			const report = untrackSyncReport(t, sync({ ...(skipped === undefined ? {} : { skipped }) }));
			expect(report.details).toEqual([]);
			return report.summary;
		};
		expect(said("pull-declined")).toBe(
			"Nothing was removed from GitHub, because the download was cancelled. The exclusions stay. You can remove the files later in the settings of Sync Evo.",
		);
		expect(said("pull-cancelled")).toBe(
			"Nothing was removed from GitHub, because the download was stopped. The exclusions stay. You can remove the files later in the settings of Sync Evo.",
		);
		expect(said("push-not-done")).toBe(
			"Nothing was removed from GitHub, because the exclusions could not be uploaded. They stay on this device. You can remove the files later in the settings of Sync Evo.",
		);
		expect(said("cancelled")).toBe("The removal was stopped. Nothing was removed from GitHub.");
		expect(untrackSyncReport(ja, sync({ skipped: "push-not-done" })).summary).toBe(
			"除外の設定をアップロードできなかったため、GitHub から削除していません。除外の設定は、このデバイスに残っています。後から、Sync Evo の設定画面で削除できます。",
		);
	});

	test("stopped because the connection was changed: that, in whichever step it was stopped", () => {
		const options = { connectionChanged: true };
		const en = "The removal was stopped because the connection was changed. Nothing was removed from GitHub.";
		// A question that was open is closed as a "no" by the change.
		for (const skipped of ["cancelled", "pull-cancelled", "pull-declined", "push-not-done"] as const) {
			expect(untrackSyncReport(t, sync({ skipped }), options), skipped).toEqual({ summary: en, details: [] });
		}
		const stopped = ended({ outcome: "cancelled", untracked: [], revision: null });
		expect(untrackSyncReport(t, sync({ untrack: stopped }), options).summary).toBe(en);
		expect(untrackSyncReport(ja, sync({ untrack: stopped }), options).summary).toBe(
			"接続先が変わったため、GitHub からの削除を中止しました。何も削除していません。",
		);
		// What was untracked before the change is told as that.
		expect(untrackSyncReport(t, sync({ untrack: ended() }), options)).toEqual(untrackReport(t, ended()));
	});
});

describe("an untracking that a later sync found to have gone through", () => {
	test("is told by a pull and by a push as files untracked, not as files deleted", () => {
		const text =
			"An earlier removal from GitHub had gone through: 3 files removed. It is recorded on this device now. The files on this device are as they were.";
		const options = { sizeLimit: 50 * 1024 * 1024 };
		expect(pullReport(t, { ...pulled, recoveredUntrack: 3 }, { settings, ...options }).details).toEqual([text]);
		expect(pushReport(t, { ...pushed, recoveredUntrack: 3 }, options).details).toEqual([text]);
		expect(pushReport(t, { ...pushed, recoveredUntrack: 1 }, options).details).toEqual([
			"An earlier removal from GitHub had gone through: 1 file removed. It is recorded on this device now. The file on this device is as it was.",
		]);
		expect(pullReport(ja, { ...pulled, recoveredUntrack: 3 }, { settings, ...options }).details).toEqual([
			"前に行った GitHub からの削除は、できていました（3 件）。このデバイスに記録しました。このデバイスのファイルは、そのままです。",
		]);
	});
});

describe("what the question is drawn from", () => {
	test("the files this device holds no file for, and the number of records, as they are now", async () => {
		const vault = new MemoryPullVault({ caseSensitive: false, now: () => 0 });
		vault.put("drafts/a.md", "A");
		// A folder where the remote has a file is no file of it.
		vault.put("drafts/big.bin/inner.md", "I");
		const store = new MemoryStateStore();
		const files = [plain("drafts/a.md"), plain("drafts/big.bin"), { path: "drafts/link", symlink: true, ownFolder: false }];
		const asked = await untrackConfirmRequest({ store, vault }, { files, submodules: ["knowledge"] });
		expect(asked).toEqual({ files, submodules: ["knowledge"], missing: ["drafts/big.bin", "drafts/link"], recordCount: 0 });
		// Nothing was written for it.
		expect(vault.text("drafts/a.md")).toBe("A");
		expect(untrackQuestion(t, asked).parts.map((part) => part.text)).toContain(
			"2 of these files are not on this device. Those in the list are marked there. After they are removed, their content is only in the history on GitHub.",
		);
	});

	test("a path that cannot be looked at counts as not on this device", async () => {
		const vault = {
			stat: async (path: string) => {
				if (path === "drafts/odd.md") throw new Error("not a path of this device");
				return { type: "file" as const, mtime: 0, size: 1 };
			},
		};
		const store = { readRecords: async () => [] };
		const files = [plain("drafts/a.md"), plain("drafts/odd.md")];
		expect((await untrackConfirmRequest({ store, vault }, { files, submodules: [] })).missing).toEqual(["drafts/odd.md"]);
	});
});

describe("the submodules a rule matches", () => {
	test("one line for the screen, and with the paths for a message", () => {
		expect(untrackSubmodulesText(t, ["knowledge"])).toBe(
			"1 excluded submodule is on GitHub. Sync Evo does not remove submodules. Remove it with git on a computer.",
		);
		expect(untrackSubmodulesText(t, ["a", "b"], true)).toBe(
			"2 excluded submodules are on GitHub. Sync Evo does not remove submodules. Remove them with git on a computer.\na\nb",
		);
		expect(untrackSubmodulesText(ja, ["a", "b"])).toBe(
			"GitHub に、除外しているサブモジュールが 2 件あります。Sync Evo では、サブモジュールを削除できません。パソコンの git で行ってください。",
		);
	});
});

describe("whether anything was untracked", () => {
	test("only an untracking that took files out of the remote", () => {
		const sync = (untrack: UntrackRunResult | null, skipped?: UntrackSyncResult["skipped"]): UntrackSyncResult => ({
			pull: pulled,
			push: null,
			untrack,
			...(skipped === undefined ? {} : { skipped }),
		});
		expect(untrackedSome(sync(ended()))).toBe(true);
		for (const outcome of ["nothing-to-untrack", "sync-first", "remote-moved", "cancelled"] as const) {
			expect(untrackedSome(sync(ended({ outcome, untracked: [], revision: null }))), outcome).toBe(false);
		}
		expect(untrackedSome(sync(null, "pull-declined"))).toBe(false);
	});

	test("stopped is an untracking the user or a change of the connection stopped, and no other that untracked nothing", () => {
		const sync = (untrack: UntrackRunResult | null, skipped?: UntrackSyncResult["skipped"]): UntrackSyncResult => ({
			pull: pulled,
			push: null,
			untrack,
			...(skipped === undefined ? {} : { skipped }),
		});
		expect(untrackStopped(sync(ended({ outcome: "cancelled", untracked: [], revision: null })))).toBe(true);
		expect(untrackStopped(sync(null, "cancelled"))).toBe(true);
		expect(untrackStopped(sync(null, "pull-cancelled"))).toBe(true);
		// Each of these leaves something to do, and stays on the screen.
		expect(untrackStopped(sync(ended()))).toBe(false);
		for (const outcome of ["nothing-to-untrack", "sync-first", "remote-moved"] as const) {
			expect(untrackStopped(sync(ended({ outcome, untracked: [], revision: null }))), outcome).toBe(false);
		}
		expect(untrackStopped(sync(null, "pull-declined"))).toBe(false);
		expect(untrackStopped(sync(null, "push-not-done"))).toBe(false);
	});
});

describe("where untracking is pointed to", () => {
	test.each([
		["en", 'use "Remove from GitHub" in the settings of Sync Evo'],
		["ja", "Sync Evo の設定画面で「GitHub から削除」を行います"],
	])("in %s, the notice about Sync Evo's own folder on the remote says where it can be taken out", (language, words) => {
		const [text] = noticeTexts(translatorFor(language), [{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" }], 1);
		expect(text).toContain(words);
		expect(text).toContain(".obsidian/plugins/sync-evo");
	});
});
