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
	failureReason,
	listText,
	pullFailureText,
	pullProgressText,
	pullReport,
	type StateProblem,
	stateProblemText,
} from "../src/core/pull-report";
import type { DeviceSettings } from "../src/core/settings";

const t = translatorFor("en");
const ja = translatorFor("ja");

const settings: DeviceSettings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	deviceName: "Mac",
};
const options = { settings, sizeLimit: 50 * 1024 * 1024 };

const result = (over: Partial<PullResult> = {}): PullResult => ({
	outcome: "completed",
	revision: "a".repeat(40),
	remoteEmpty: false,
	rewritten: false,
	counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
	conflicts: [],
	trashed: [],
	deferred: [],
	unwritable: [],
	keptLocal: [],
	newSymlinks: [],
	notices: [],
	closedViews: false,
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

	test("closed graph views are told for as long as they are closed", () => {
		const text = pullProgressText(t, { phase: "applying", done: 3, total: 10, closedViews: true });
		expect(text.split("\n")).toEqual([
			"Pull: updating files (3/10)…",
			"Graph views are closed while the files are written. They reopen when the pull ends.",
		]);
	});
});

describe("the summary", () => {
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

	test("cancelled, whatever was done before", () => {
		const counts = { fetched: 5, deleted: 0, renamed: 0, conflicts: 0 };
		expect(pullReport(t, result({ outcome: "cancelled", counts }), options).summary).toBe(
			"The pull was stopped. The next pull continues from there.",
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

	test("a file that could not be read", () => {
		const report = pullReport(
			t,
			result({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "unreadable" }] }),
			options,
		);
		expect(report.details[0]).toContain("A file on this device could not be read.");
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
					{ path: "a.md", copyPath: "a.conflict-from-Mac-20261003-221500.md", cause: "conflict" },
					{ path: "link", copyPath: "link.conflict-from-Mac-20261003-221500", cause: "became-symlink" },
					{ path: "dir", copyPath: "dir.conflict-from-Mac-20261003-221500", cause: "became-folder" },
					{ path: "Notes.md", copyPath: "Notes.conflict-from-Mac-20261003-221500.md", cause: "name-taken" },
				],
			}),
			options,
		);
		expect(report.details).toEqual([
			[
				"The content of 4 files on this device was kept under another name:",
				"a.conflict-from-Mac-20261003-221500.md (a conflict: a.md now has the content of the remote)",
				"link.conflict-from-Mac-20261003-221500 (link is a symbolic link on the remote now, which is not written to this device)",
				"dir.conflict-from-Mac-20261003-221500 (dir is a folder on the remote now)",
				"Notes.conflict-from-Mac-20261003-221500.md (the remote renamed another file to Notes.md)",
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

	test("files moved to .trash/ to protect them", () => {
		const report = pullReport(t, result({ trashed: ["a.md"] }), options);
		expect(report.details).toEqual([
			"1 file was moved to .trash/ in this vault before the pull replaced or removed it. You can get it back from there:\na.md",
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
				],
				unwritable: [
					{ path: "notes", reason: "blocked", inTheWay: ["notes/draft.md", "notes/sub/idea.md"], isNew: true },
				],
			}),
			options,
		);
		expect(report.details).toHaveLength(NOTICE_KINDS.length);
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
		["workflows-permission", "Details: boom"],
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
