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
		expect(question.title).toBe("Untrack files");
		expect(question.proceed).toBe("Untrack");
		expect(question.cancel).toBe("Not now");
		expect(question.shown).toEqual(["drafts/a.md", "drafts/b.md"]);
		expect(question.parts).toEqual([
			{
				text: "2 files on the remote match a rule of .gitignore. Untracking removes them from the remote, and they are no longer synced:",
				paths: { shown: ["drafts/a.md", "drafts/b.md"], more: 0 },
			},
			{ text: "The files on this device are not deleted. They stay as they are." },
			{
				text: "On your other devices, the next pull deletes these files, except files that were changed on that device.",
			},
			{
				text: "A pull runs first. If the rules are not on the remote yet, a push follows, and it also sends the other changes of this device.",
			},
			{
				text: "To keep the files on a computer that uses git, do not untrack them here: run git rm --cached on that computer, and push from there. The next pull then deletes these files from this device.",
			},
		]);
		expect(question.note).toBe(
			'If you choose "Not now", the rules stay, and these files stay synced. You can untrack them later in the settings of Sync Evo.',
		);
	});

	test("one file", () => {
		const question = untrackQuestion(t, request({ files: [plain("drafts/a.md")] }));
		expect(question.parts[0]?.text).toBe(
			"1 file on the remote matches a rule of .gitignore. Untracking removes it from the remote, and it is no longer synced:",
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
			text: "2 of these files are not on this device. Those in the list are marked there. After untracking, their content is only in the history of the remote.",
		});
		expect(untrackQuestion(t, request({ missing: ["drafts/a.md"] })).parts[3]?.text).toBe(
			"1 of these files is not on this device. If it is in the list, it is marked there. After untracking, its content is only in the history of the remote.",
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
			text: "2 submodules match a rule as well. They are not untracked here. Untrack them with git on a Mac or another computer:",
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
		expect(warning(51, 10_000)).toBe("This removes 51 files from the remote at once. Check the list before you go on.");
		expect(warning(50, 10_000)).toBeUndefined();
		// More than five, and more than a tenth of everything.
		expect(warning(6, 59)).toBe("This removes 6 files from the remote at once. Check the list before you go on.");
		expect(warning(6, 60)).toBeUndefined();
		expect(warning(5, 10)).toBeUndefined();
	});

	test("in Japanese", () => {
		const files: UntrackableFile[] = [{ path: "drafts/link", symlink: true, ownFolder: false }, plain("drafts/a.md")];
		const question = untrackQuestion(ja, request({ files, missing: ["drafts/link"], submodules: ["knowledge"] }));
		expect(question.title).toBe("追跡を外す確認");
		expect(question.proceed).toBe("追跡を外す");
		expect(question.cancel).toBe("今は外さない");
		expect(question.parts.map((part) => part.text)).toEqual([
			"保存先に、.gitignore の規則に当たるファイルが 2 件あります。追跡を外すと、保存先から削除し、同期しなくなります：",
			"このデバイスのファイルは削除しません。そのまま残ります。",
			"ほかのデバイスでは、次の取り込みで削除されます。そのデバイスで変更していたファイルは残ります。",
			"このうち 1 件は、このデバイスにありません。一覧に出した物には、印を付けています。追跡を外すと、中身は保存先の履歴にだけ残ります。",
			"規則に当たるサブモジュールも 1 件あります。ここでは追跡を外しません。Mac などの git で外してください：",
			"先に取り込みを行います。規則がまだ保存先に届いていなければ、送信も行い、このデバイスのほかの変更も送ります。",
			"git を使うパソコンにファイルを残したい時は、ここでは外さず、そのパソコンで git rm --cached をして push してください。その時は、このデバイスのファイルが、次の取り込みで削除されます。",
		]);
		expect(question.parts[0]?.paths?.shown).toEqual(["drafts/link（シンボリックリンク、このデバイスに無い）", "drafts/a.md"]);
		expect(question.note).toBe(
			"「今は外さない」を選ぶと、規則は残り、これらのファイルは同期を続けます。後から、Sync Evo の設定画面で外せます。",
		);
	});
});

describe("how untracking ended", () => {
	test("untracked: the count, and that the files on this device are as they were", () => {
		expect(untrackReport(t, ended())).toEqual({
			summary: "Untracked 2 files: they were removed from the remote. The files on this device are as they were.",
			details: [],
		});
		expect(untrackReport(t, ended({ untracked: ["a.md"] })).summary).toBe(
			"Untracked 1 file: it was removed from the remote. The file on this device is as it was.",
		);
		expect(untrackReport(ja, ended()).summary).toBe(
			"追跡を外しました：2 件。保存先から削除しました。このデバイスのファイルは、そのままです。",
		);
	});

	test("nothing to untrack, a remote that moved, and a stop", () => {
		const said = (outcome: UntrackRunResult["outcome"]): string =>
			untrackReport(t, ended({ outcome, revision: null, untracked: [] })).summary;
		expect(said("nothing-to-untrack")).toBe(
			"There was nothing to untrack: none of the listed files is still on the remote and matched by a rule. Nothing was changed.",
		);
		expect(said("remote-moved")).toBe(
			"Nothing was untracked. The remote was changed from another device meanwhile. Untrack again in the settings of Sync Evo.",
		);
		expect(said("cancelled")).toBe("Untracking was stopped. Nothing was removed from the remote.");
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
			"Nothing was untracked. The .gitignore of this device is not the one the remote holds, so the rules are not on the remote yet. Sync until .gitignore has been sent, then untrack again in the settings of Sync Evo.",
		);
		expect(said("no-section")).toContain("has no lines managed by Sync Evo");
		for (const reason of reasons) expect(said(reason).startsWith("Nothing was untracked.")).toBe(true);
	});

	test("an earlier push or untracking it found to have gone through is a message of its own", () => {
		const push = untrackReport(t, ended({ recovered: { added: 1, modified: 0, deleted: 0 } }));
		expect(push.details).toEqual(["The previous push had reached the remote: 1 file added. It is recorded on this device now."]);
		const untracking = untrackReport(t, ended({ outcome: "nothing-to-untrack", untracked: [], recoveredUntrack: 2 }));
		expect(untracking.details).toEqual([
			"An earlier untracking had reached the remote: 2 files untracked. It is recorded on this device now. The files on this device are as they were.",
		]);
	});

	test("a failure, with its reason; a stop is told as a stop", () => {
		expect(untrackFailureText(t, settings, new BackendError("unreachable", "timed out"))).toBe(
			"Untracking failed. Could not reach GitHub. Check the network connection and try again.",
		);
		expect(untrackFailureText(ja, settings, new BackendError("not-as-listed", "x"))).toBe(
			"追跡を外せませんでした。何も送信していません。保存先の中身が、このデバイスが持っている保存先の一覧と違っていました。次の同期で、一覧を取り直します。もう一度同期してください。",
		);
		expect(untrackFailureText(t, settings, new BackendError("cancelled", "x"))).toBe(
			"Untracking was stopped. Nothing was removed from the remote.",
		);
		expect(untrackFailureText(t, settings, new BackendError("cancelled", "x"), true)).toBe(
			"Untracking was stopped because the connection was changed. Nothing was removed from the remote.",
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
			"Nothing was untracked, because the pull was cancelled. The rules stay. You can untrack later in the settings of Sync Evo.",
		);
		expect(said("pull-cancelled")).toBe(
			"Nothing was untracked, because the pull was stopped. The rules stay. You can untrack later in the settings of Sync Evo.",
		);
		expect(said("push-not-done")).toBe(
			"Nothing was untracked, because the push that sends .gitignore to the remote did not go through. The rules stay. You can untrack later in the settings of Sync Evo.",
		);
		expect(said("cancelled")).toBe("Untracking was stopped. Nothing was removed from the remote.");
		expect(untrackSyncReport(ja, sync({ skipped: "push-not-done" })).summary).toBe(
			".gitignore を保存先に届ける送信が済まなかったため、追跡を外していません。規則は残っています。後から、Sync Evo の設定画面で追跡を外せます。",
		);
	});

	test("stopped because the connection was changed: that, in whichever step it was stopped", () => {
		const options = { connectionChanged: true };
		const en = "Untracking was stopped because the connection was changed. Nothing was removed from the remote.";
		// A question that was open is closed as a "no" by the change.
		for (const skipped of ["cancelled", "pull-cancelled", "pull-declined", "push-not-done"] as const) {
			expect(untrackSyncReport(t, sync({ skipped }), options), skipped).toEqual({ summary: en, details: [] });
		}
		const stopped = ended({ outcome: "cancelled", untracked: [], revision: null });
		expect(untrackSyncReport(t, sync({ untrack: stopped }), options).summary).toBe(en);
		expect(untrackSyncReport(ja, sync({ untrack: stopped }), options).summary).toBe(
			"接続先が変わったため、追跡を外す操作を中止しました。保存先からは、何も削除していません。",
		);
		// What was untracked before the change is told as that.
		expect(untrackSyncReport(t, sync({ untrack: ended() }), options)).toEqual(untrackReport(t, ended()));
	});
});

describe("an untracking that a later sync found to have gone through", () => {
	test("is told by a pull and by a push as files untracked, not as files deleted", () => {
		const text =
			"An earlier untracking had reached the remote: 3 files untracked. It is recorded on this device now. The files on this device are as they were.";
		const options = { sizeLimit: 50 * 1024 * 1024 };
		expect(pullReport(t, { ...pulled, recoveredUntrack: 3 }, { settings, ...options }).details).toEqual([text]);
		expect(pushReport(t, { ...pushed, recoveredUntrack: 3 }, options).details).toEqual([text]);
		expect(pushReport(t, { ...pushed, recoveredUntrack: 1 }, options).details).toEqual([
			"An earlier untracking had reached the remote: 1 file untracked. It is recorded on this device now. The file on this device is as it was.",
		]);
		expect(pullReport(ja, { ...pulled, recoveredUntrack: 3 }, { settings, ...options }).details).toEqual([
			"前に行った追跡を外す操作は、保存先に届いていました（3 件）。このデバイスに記録しました。このデバイスのファイルは、そのままです。",
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
			"2 of these files are not on this device. Those in the list are marked there. After untracking, their content is only in the history of the remote.",
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
			"1 submodule on the remote matches a rule of .gitignore. Sync Evo does not untrack submodules. Untrack it with git on a Mac or another computer.",
		);
		expect(untrackSubmodulesText(t, ["a", "b"], true)).toBe(
			"2 submodules on the remote match a rule of .gitignore. Sync Evo does not untrack submodules. Untrack them with git on a Mac or another computer.\na\nb",
		);
		expect(untrackSubmodulesText(ja, ["a", "b"])).toBe(
			"保存先に、.gitignore の規則に当たるサブモジュールが 2 件あります。Sync Evo では、サブモジュールの追跡を外せません。Mac などの git で外してください。",
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
		["en", "untrack its files in the settings of Sync Evo"],
		["ja", "Sync Evo の設定画面で追跡を外します"],
	])("in %s, the notice about Sync Evo's own folder on the remote says where it can be taken out", (language, words) => {
		const [text] = noticeTexts(translatorFor(language), [{ kind: "own-folder-on-remote", path: ".obsidian/plugins/sync-evo" }], 1);
		expect(text).toContain(words);
		expect(text).toContain(".obsidian/plugins/sync-evo");
	});
});
