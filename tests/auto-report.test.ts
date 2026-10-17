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
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import {
	type AutoReport,
	autoNotices,
	autoResults,
	failureAutoReport,
	filesDigest,
	joinAutoReports,
	notReadyAutoReport,
	paidAutoReport,
	pullAutoReport,
	pushAutoReport,
	settleAutoSync,
	stateAutoReport,
} from "../src/core/auto-report";
import { type AutoSyncMemory, NO_AUTO_SYNC_MEMORY } from "../src/core/auto-sync";
import { BackendError, RateLimitedError } from "../src/core/backend";
import { translatorFor } from "../src/core/i18n";
import type { PullResult } from "../src/core/pull";
import { pullDetails, pullFailureText, type ReportDetail } from "../src/core/pull-report";
import type { PushRunResult } from "../src/core/push";
import { pushDetails, pushReport } from "../src/core/push-report";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

const t = translatorFor("en");
const HEADING = "Automatic sync:\n";

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
	deviceName: "iPhone",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
	deviceExclusion: NO_DEVICE_EXCLUSION,
	exclusionChangeTold: true,
};
const options = { settings, sizeLimit: 50 * 1024 * 1024 };

const pulled = (over: Partial<PullResult> = {}): PullResult => ({
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

const pushed = (over: Partial<PushRunResult> = {}): PushRunResult => ({
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
	...over,
});

const pull = (over: Partial<PullResult> = {}): AutoReport => pullAutoReport(t, pulled(over), options);
const push = (over: Partial<PushRunResult> = {}): AutoReport => pushAutoReport(t, pushed(over), options);
const offline = new BackendError("unreachable", "resolve head: the request failed");
const texts = (details: readonly ReportDetail[]): string[] => details.map((detail) => detail.text);

describe("a pull that started by itself", () => {
	test("that went well tells nothing, whatever it fetched", () => {
		const report = pull({ counts: { fetched: 12, deleted: 3, renamed: 1, conflicts: 0 }, refetched: 2 });
		expect(report).toEqual({ happened: [], standing: [], questions: [], cause: null, end: "success" });
		expect(pull({ outcome: "remote-empty", revision: null, remoteEmpty: true })).toEqual(report);
	});

	test("tells what happened in it, as a pull the user started does, and still went well", () => {
		const result: Partial<PullResult> = {
			counts: { fetched: 1, deleted: 0, renamed: 0, conflicts: 1 },
			conflicts: [{ path: "a.md", copyPath: "a (conflict).md", cause: "conflict" }],
			replacedSettings: [".obsidian/app.json"],
			trashed: ["b.md"],
			halfWritten: ["c.md"],
			halfCopies: ["c (conflict).md"],
			tidiedCopies: ["_conflicts/2026-09-01 d (iPhone).md"],
			recoveredPush: { added: 1, modified: 0, deleted: 0 },
			newSymlinks: ["link"],
			notices: [{ kind: "git-at-root", path: ".git" }],
		};

		const report = pull(result);

		expect(report.happened).toEqual(pullDetails(t, pulled(result), options));
		expect(report.happened).toHaveLength(9);
		// What is to be seen to in one notice, under the line that says
		// nobody pressed anything: the conflict, the file left half written,
		// and the .git. What is only worth knowing is not shown.
		const notices = autoNotices(t, report, false);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "warn", stays: true });
		expect(notices[0]?.text.startsWith(HEADING)).toBe(true);
		expect(notices[0]?.text).toContain("a (conflict).md");
		expect(notices[0]?.text).toContain("c.md");
		expect(notices[0]?.text).toContain("has a .git at its root");
		expect(notices[0]?.text).not.toContain("_conflicts/2026-09-01");
		// The copies that were tidied are on the screen of the results, also of a sync nobody started.
		const results = autoResults(report, false);
		expect(results).toHaveLength(9);
		expect(results.some((item) => item.level === "info" && item.text.includes("1 conflict file in _conflicts/ was made 30 days ago"))).toBe(
			true,
		);
		expect(report).toMatchObject({ standing: [], cause: null, end: "success" });
	});

	test("tells a merge, with the file and where the content from before is, and still went well", () => {
		const result: Partial<PullResult> = { merged: [{ path: "notes/a.md", keptAt: ".trash/.sync-evo-merged/2026-10-13 a.md" }] };

		const report = pull(result);

		expect(report.happened).toEqual(pullDetails(t, pulled(result), options));
		expect(report.happened).toHaveLength(1);
		expect(report.happened[0]?.level).toBe("warn");
		expect(report.happened[0]?.text).toContain("notes/a.md (before: .trash/.sync-evo-merged/2026-10-13 a.md)");
		expect(report).toMatchObject({ standing: [], cause: null, end: "success" });
	});

	test("what it could not fetch stands in its way, by its reason and not by its files", () => {
		const one = pull({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "fetch-failed" }], fetchError: offline });
		const three = pull({
			outcome: "incomplete",
			deferred: ["a.md", "b.md", "c.md"].map((path) => ({ path, reason: "fetch-failed" as const })),
			fetchError: offline,
		});

		expect(one).toMatchObject({ happened: [], cause: "pull:incomplete:error:unreachable,fetch-failed", end: "failure" });
		expect(texts(one.standing)).toEqual([
			"1 file could not be downloaded and is left for the next sync. Could not reach GitHub. Check the network connection and try again.",
		]);
		expect(autoNotices(t, one, true).map((notice) => notice.text)).toEqual([HEADING + one.standing[0]?.text]);
		expect(three.cause).toBe(one.cause);
	});

	test("files that cannot be read, or are not downloaded, are a cause of their own", () => {
		const report = pull({
			outcome: "incomplete",
			deferred: [
				{ path: "a.md", reason: "unreadable" },
				{ path: "b.pdf", reason: "not-downloaded" },
				{ path: "c.md", reason: "depends-on-deferred" },
			],
		});
		expect(report).toMatchObject({
			cause: `pull:incomplete:not-downloaded#${filesDigest(["b.pdf"])},unreadable#${filesDigest(["a.md"])}`,
			end: "failure",
		});
		expect(report.standing).toHaveLength(3);
		expect(report.standing.every((detail) => detail.level === "warn")).toBe(true);
		// In one notice, under the heading.
		const notices = autoNotices(t, report, true);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.text).toBe(HEADING + texts(report.standing).join("\n\n"));
	});

	test("a conflict copy is told beside what stands in the way", () => {
		const report = pull({
			outcome: "incomplete",
			conflicts: [{ path: "a.md", copyPath: "a (conflict).md", cause: "conflict" }],
			deferred: [{ path: "b.md", reason: "hash-mismatch" }],
		});
		expect(report.happened).toHaveLength(1);
		expect(report.standing).toHaveLength(1);
		expect(report.cause).toBe("pull:incomplete:hash-mismatch");
		// Both in the one notice of what there is to see to.
		const notices = autoNotices(t, report, true);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.text).toBe(HEADING + texts([...report.happened, ...report.standing]).join("\n\n"));
	});

	test("another file that cannot be read is another cause, and the same files in another order are the same", () => {
		const unreadable = (...paths: string[]): string | null =>
			pull({ outcome: "incomplete", deferred: paths.map((path) => ({ path, reason: "unreadable" as const })) }).cause;
		expect(unreadable("a.md", "b.md")).toBe(unreadable("b.md", "a.md"));
		expect(unreadable("a.md", "b.md")).not.toBe(unreadable("a.md"));
		expect(unreadable("a.md")).not.toBe(unreadable("b.md"));
		const waiting = (...paths: string[]): string | null =>
			pull({ outcome: "incomplete", deferred: paths.map((path) => ({ path, reason: "not-downloaded" as const })) }).cause;
		expect(waiting("a.pdf", "b.pdf")).toBe(waiting("b.pdf", "a.pdf"));
		expect(waiting("a.pdf", "b.pdf")).not.toBe(waiting("a.pdf"));
	});

	test("a failure to fetch is the same cause however many files it left, and whichever", () => {
		const failed = (...paths: string[]): string | null =>
			pull({ outcome: "incomplete", deferred: paths.map((path) => ({ path, reason: "hash-mismatch" as const })) }).cause;
		expect(failed("a.md", "b.md")).toBe(failed("c.md"));
	});

	test.each<[string, Partial<PullResult>]>([
		["a file that was being typed in", { outcome: "incomplete", deferred: [{ path: "a.md", reason: "changed-during-pull" }] }],
		["an editor that could not save", { outcome: "incomplete", deferred: [{ path: "a.md", reason: "save-failed" }] }],
		["a file that is being typed in right now", { outcome: "incomplete", deferred: [{ path: "a.md", reason: "being-edited" }] }],
		["a stop while it fetched", { outcome: "incomplete", fetchError: new BackendError("cancelled", "stopped") }],
		["a stop", { outcome: "cancelled" }],
		["a no", { outcome: "declined" }],
	])("%s is neither a success nor a failure, and has nothing to tell", (_name, result) => {
		expect(pull(result)).toEqual({ happened: [], standing: [], questions: [], cause: null, end: "neither" });
	});

	test("a file that is being typed in beside one that cannot be read: only the second is told, and is the cause", () => {
		const report = pull({
			outcome: "incomplete",
			deferred: [
				{ path: "typing.md", reason: "being-edited" },
				{ path: "broken.md", reason: "unreadable" },
			],
		});
		expect(report).toMatchObject({ cause: `pull:incomplete:unreadable#${filesDigest(["broken.md"])}`, end: "failure" });
		expect(report.standing).toHaveLength(1);
		expect(report.standing[0]?.full).toContain("broken.md");
		expect(report.standing[0]?.full).not.toContain("typing.md");
		// The same cause as without the typing: it is not told again for it.
		expect(report.cause).toBe(pull({ outcome: "incomplete", deferred: [{ path: "broken.md", reason: "unreadable" }] }).cause);
	});

	test("a file that is being typed in beside others that only wait is still neither", () => {
		const report = pull({
			outcome: "incomplete",
			deferred: [
				{ path: "typing.md", reason: "being-edited" },
				{ path: "other.md", reason: "save-failed" },
				{ path: "after.md", reason: "depends-on-deferred" },
			],
		});
		expect(report).toEqual({ happened: [], standing: [], questions: [], cause: null, end: "neither" });
	});

	test.each<[NonNullable<PullResult["waitingFor"]>, string]>([
		["deletions", "Downloading would delete many files on this device"],
		["rewritten", "The history of the repository was rewritten"],
		["first-fetch", "The first download into this vault is not done yet"],
	])("a wait for %s says under the heading that nothing was changed, and to sync manually", (waitingFor, start) => {
		const report = pull({ outcome: "waiting", waitingFor });
		expect(report).toMatchObject({ happened: [], standing: [], cause: `pull:waiting:${waitingFor}`, end: "waiting" });
		expect(report.questions).toHaveLength(1);
		// The one notice that is taken down when the user starts a sync.
		const notices = autoNotices(t, report, true);
		expect(notices).toEqual([{ text: HEADING + report.questions[0], level: "warn", stays: true, question: true }]);
		expect(notices[0]?.text.startsWith(HEADING + start)).toBe(true);
		expect(notices[0]?.text).toContain("Nothing was changed. Sync manually to ");
		// Named once, by the heading.
		expect(notices[0]?.text.match(/utomatic sync/g)).toHaveLength(1);
	});

	test("the wait for a first fetch is worded so that it is true with and without something to confirm", () => {
		// Not begun at all, or begun and stopped, with a file that differs since.
		expect(pull({ outcome: "waiting", waitingFor: "first-fetch" }).questions).toEqual([
			"The first download into this vault is not done yet. Nothing was changed. Sync manually to start it or carry on with it.",
		]);
		const ja = translatorFor("ja");
		const report = pullAutoReport(ja, pulled({ outcome: "waiting", waitingFor: "first-fetch" }), options);
		const text = autoNotices(ja, report, true)[0]?.text;
		expect(text?.startsWith("自動同期：\nこの保管庫の最初のダウンロードが、まだ済んでいません。")).toBe(true);
		expect(text?.match(/自動同期/g)).toHaveLength(1);
	});

	test("what was moved away before the question is told with the wait", () => {
		const report = pull({ outcome: "waiting", waitingFor: "deletions", halfWritten: ["a.md"] });
		expect(report.happened).toHaveLength(1);
		expect(report.end).toBe("waiting");
	});
});

describe("a push that started by itself", () => {
	test("that went well tells nothing, whatever it sent", () => {
		expect(push({ counts: { added: 2, modified: 1, deleted: 1 } })).toEqual({
			happened: [],
			standing: [],
			questions: [],
			cause: null,
			end: "success",
		});
		expect(push({ outcome: "nothing-to-push", revision: null }).end).toBe("success");
	});

	test("tells what happened in it: the section it wrote, a push it found to have gone through, what the remote stored otherwise, notices", () => {
		const result: Partial<PushRunResult> = {
			sectionAdded: { lines: ["# >>> Sync Evo", ".trash/", "# <<< Sync Evo"], created: true, tracked: [], asked: false, sent: true },
			recovered: { added: 1, modified: 0, deleted: 0 },
			storedOtherwise: ["a.md"],
			notices: [{ kind: "rename-not-sent", path: "A.md" }],
		};

		const report = push(result);

		expect(report.happened).toEqual(pushDetails(t, pushed(result), options));
		expect(report.happened).toHaveLength(4);
		// Shown: what the remote stored otherwise, and the rename that was
		// not sent. The section and the push that went through are only
		// worth knowing, and on the screen of the results alone.
		expect(report.happened.map((detail) => detail.level)).toEqual(["info", "info", "warn", "warn"]);
		const notices = autoNotices(t, report, false);
		expect(notices.map((notice) => notice.text)).toEqual([
			HEADING + texts(report.happened.slice(2)).join("\n\n"),
		]);
		expect(autoResults(report, false)).toHaveLength(4);
		expect(report).toMatchObject({ standing: [], cause: null, end: "success" });
	});

	test("files it does not send stand, by the kind of reason, while the push itself went well", () => {
		const report = push({
			held: ["half.md"],
			refused: [{ path: "x.md", reason: "remote-in-the-way" } as PushRunResult["refused"][number]],
			leftOut: [
				{ path: "big.bin", reason: "too-large" },
				{ path: "b.bin", reason: "too-large" },
				{ path: "c.md", reason: "unreadable" },
			],
		});

		expect(report.end).toBe("success");
		expect(report.cause).toBe(
			[
				`push:held#${filesDigest(["half.md"])}`,
				`push:in-the-way#${filesDigest(["x.md"])}`,
				`push:left-out:too-large,unreadable#${filesDigest(["too-large big.bin", "too-large b.bin", "unreadable c.md"])}`,
			].join(" "),
		);
		expect(report.standing).toHaveLength(4);
		expect(report.standing.every((detail) => detail.level === "warn")).toBe(true);
		expect(autoNotices(t, report, true)).toHaveLength(1);
		expect(report.happened).toEqual([]);
	});

	test("another file that is not sent is another cause, and the same files in another order are the same", () => {
		const leftOut = (...paths: string[]): string | null =>
			push({ leftOut: paths.map((path) => ({ path, reason: "too-large" as const })) }).cause;
		expect(leftOut("a.bin", "b.bin")).toBe(leftOut("b.bin", "a.bin"));
		expect(leftOut("a.bin", "b.bin")).not.toBe(leftOut("a.bin"));
		expect(push({ held: ["a.md", "b.md"] }).cause).toBe(push({ held: ["b.md", "a.md"] }).cause);
		expect(push({ held: ["a.md", "b.md"] }).cause).not.toBe(push({ held: ["a.md"] }).cause);
		const refused = (...paths: string[]): string | null =>
			push({ refused: paths.map((path) => ({ path, reason: "remote-in-the-way" }) as PushRunResult["refused"][number]) }).cause;
		expect(refused("x", "y")).toBe(refused("y", "x"));
		expect(refused("x", "y")).not.toBe(refused("x"));
	});

	test("a file that is left out for another reason now is another cause", () => {
		const cause = (reason: "too-large" | "unreadable"): string | null => push({ leftOut: [{ path: "a.bin", reason }] }).cause;
		expect(cause("too-large")).not.toBe(cause("unreadable"));
	});

	test("another device that pushed in between is neither told nor a failure: the next sync pulls first", () => {
		const report = push({ outcome: "pull-first", reason: "remote-moved", revision: null });
		expect(report).toEqual({ happened: [], standing: [], questions: [], cause: null, end: "neither" });
	});

	test.each<NonNullable<PushRunResult["reason"]>>([
		"no-base",
		"remote-empty",
		"not-default-branch",
		"gitignore-unsettled",
		"gitignore-unreadable",
	])("a push that has to wait for something else (%s) could not send, and says why", (reason) => {
		const result = { outcome: "pull-first", reason, revision: null, defaultBranch: "trunk" } as const;
		const report = push(result);
		expect(report).toMatchObject({ happened: [], cause: `push:pull-first:${reason}`, end: "failure" });
		expect(texts(report.standing)).toEqual([pushReport(t, pushed(result), options).summary]);
		expect(report.standing[0]?.level).toBe("warn");
	});

	test.each<[NonNullable<PushRunResult["waitingFor"]>, string]>([
		["empty-vault", "None of the files synced before is on this device"],
		["first-push", "The first upload from this device needs your confirmation"],
		["deletions", "Uploading would delete many files on GitHub"],
	])("a question about %s waits, and says that nothing was sent and how to be asked", (waitingFor, start) => {
		const report = push({ outcome: "waiting", waitingFor, revision: null });
		expect(report).toMatchObject({ happened: [], standing: [], cause: `push:waiting:${waitingFor}`, end: "waiting" });
		expect(report.questions).toHaveLength(1);
		// The one notice that is taken down when the user starts a sync.
		const notices = autoNotices(t, report, true);
		expect(notices).toEqual([{ text: HEADING + report.questions[0], level: "warn", stays: true, question: true }]);
		expect(notices[0]?.text.startsWith(HEADING + start)).toBe(true);
		expect(notices[0]?.text).toContain("Nothing was uploaded. Sync manually to be asked.");
		expect(notices[0]?.text.match(/utomatic sync/g)).toHaveLength(1);
	});

	test("a stop and a no are neither", () => {
		expect(push({ outcome: "cancelled", revision: null }).end).toBe("neither");
		expect(push({ outcome: "declined", revision: null }).end).toBe("neither");
	});
});

describe("a sync that ended by throwing", () => {
	test("is a failure whose cause is the kind of it, whichever part met it", () => {
		const text = pullFailureText(t, settings, offline);
		const report = failureAutoReport(t, offline, text);
		const failure = "The download failed. Could not reach GitHub. Check the network connection and try again.";
		expect(report).toEqual({
			happened: [],
			standing: [{ text: failure, full: failure, level: "error", standing: true }],
			questions: [],
			cause: "error:unreachable",
			end: "failure",
		});
		expect(failureAutoReport(t, new BackendError("unreachable", "update ref: no response"), "x").cause).toBe(report.cause);
	});

	test.each<[unknown, string]>([
		[new BackendError("unauthorized", "HTTP 401"), "error:unauthorized"],
		[new BackendError("rate-limited", "rate limited"), "error:rate-limited"],
		[new Error("the sync state failed"), "error:other"],
		["text", "error:other"],
	])("%s has the cause %s", (error, cause) => {
		expect(failureAutoReport(t, error, "x").cause).toBe(cause);
	});

	test("a stop is no failure, and is not told here", () => {
		expect(failureAutoReport(t, new BackendError("cancelled", "stopped"), "x")).toEqual({
			happened: [],
			standing: [],
			questions: [],
			cause: null,
			end: "neither",
		});
	});

	test("settings that lack what a request needs are a failure by what they lack, with no file in the cause", () => {
		const report = notReadyAutoReport(t, "token-value", "The secret holds no token.");
		const text = "The secret holds no token.";
		expect(report).toEqual({
			happened: [],
			standing: [{ text, full: text, level: "error", standing: true }],
			questions: [],
			cause: "not-ready:token-value",
			end: "failure",
		});
	});

	test("the paid plan is told once while it stays so: a download that ran is no failure, a sync kept from starting is", () => {
		const ran = paidAutoReport(t, "read-only", true, "Only downloads.");
		expect(ran).toMatchObject({ cause: "paid:read-only", end: "success", standing: [{ text: "Only downloads.", level: "warn" }] });
		const kept = paidAutoReport(t, "stopped", false, "Stopped.");
		expect(kept).toMatchObject({ cause: "paid:stopped", end: "failure", standing: [{ text: "Stopped.", level: "error" }] });
		const first = settleAutoSync(NO_AUTO_SYNC_MEMORY, joinAutoReports([ran]), true);
		expect(first.tell).toBe(true);
		expect(first.memory.failures).toBe(0);
		expect(settleAutoSync(first.memory, joinAutoReports([ran]), true).tell).toBe(false);
		// The time for downloads is over too: news again.
		expect(settleAutoSync(first.memory, kept, true).tell).toBe(true);
	});

	test("no sync state to run with is a failure by what is wrong with it", () => {
		const report = stateAutoReport(t, "no-indexeddb");
		expect(report).toMatchObject({ cause: "state:no-indexeddb", end: "failure" });
		expect(report.standing[0]?.level).toBe("error");
		expect(autoNotices(t, report, true)[0]?.text.startsWith(HEADING)).toBe(true);
	});
});

describe("the parts of one sync as one", () => {
	const good: AutoReport = { happened: [], standing: [], questions: [], cause: null, end: "success" };

	test("a pull and a push that went well went well", () => {
		expect(joinAutoReports([good, good])).toEqual(good);
	});

	test("it ended as its worst part did", () => {
		const failed = failureAutoReport(t, offline, "x");
		const waiting = push({ outcome: "waiting", waitingFor: "first-push", revision: null });
		const moved = push({ outcome: "pull-first", reason: "remote-moved", revision: null });
		expect(joinAutoReports([good, failed]).end).toBe("failure");
		expect(joinAutoReports([good, waiting]).end).toBe("waiting");
		expect(joinAutoReports([good, moved]).end).toBe("neither");
		expect(joinAutoReports([waiting, failed]).end).toBe("failure");
		expect(joinAutoReports([pull({ outcome: "incomplete", deferred: [{ path: "a", reason: "unreadable" }] }), good]).end).toBe("failure");
	});

	test("what it tells is all of theirs, in order, and its cause is all of their causes", () => {
		const first = pull({
			outcome: "incomplete",
			conflicts: [{ path: "a.md", copyPath: "a (conflict).md", cause: "conflict" }],
			deferred: [{ path: "b.md", reason: "unreadable" }],
		});
		const second = push({ outcome: "waiting", waitingFor: "deletions", revision: null, storedOtherwise: ["x"] });

		const whole = joinAutoReports([first, second]);

		expect(whole.happened).toEqual([...first.happened, ...second.happened]);
		expect(whole.standing).toEqual([...first.standing, ...second.standing]);
		// Only the question: a file that could not be read stays told.
		expect(whole.questions).toEqual(second.questions);
		expect(whole.questions).toHaveLength(1);
		expect(whole.cause).toBe(`pull:incomplete:unreadable#${filesDigest(["b.md"])} push:waiting:deletions`);
	});

	test("no part at all is nothing to go by", () => {
		expect(joinAutoReports([])).toEqual({ happened: [], standing: [], questions: [], cause: null, end: "neither" });
	});
});

describe("what is told, and what is remembered of it", () => {
	const START = 1_700_000_000_000;
	const memory = (over: Partial<AutoSyncMemory> = {}): AutoSyncMemory => ({ ...NO_AUTO_SYNC_MEMORY, lastStartedAt: START, ...over });
	const failed = failureAutoReport(t, offline, "The pull failed.");
	const good: AutoReport = { happened: [], standing: [], questions: [], cause: null, end: "success" };

	/**
	 * Automatic syncs one after the other: how many things each told
	 * (`autoResults`, which holds what the notices show and the questions),
	 * and what is remembered at the end.
	 */
	function run(reports: readonly AutoReport[], from = memory()): { shown: number[]; memory: AutoSyncMemory } {
		let now = from;
		const shown: number[] = [];
		for (const report of reports) {
			const settled = settleAutoSync(now, report, true);
			shown.push(autoResults(report, settled.tell).length);
			now = settled.memory;
		}
		return { shown, memory: now };
	}

	test("without a network, the failure is told once, and not once per try", () => {
		const { shown, memory: after } = run([failed, failed, failed, failed]);
		expect(shown).toEqual([1, 0, 0, 0]);
		expect(after).toEqual({ lastStartedAt: START, failures: 4, told: "error:unreachable" });
	});

	test("nor once per start of the app: what was told is in what is remembered", () => {
		const first = run([failed]);
		// The app is closed and opened, and the memory is read from the sync state.
		const restored = JSON.parse(JSON.stringify(first.memory)) as AutoSyncMemory;
		expect(run([failed], restored).shown).toEqual([0]);
	});

	test("a success forgets it, so that the same cause is told again when it comes back", () => {
		const { shown, memory: after } = run([failed, failed, good, failed]);
		expect(shown).toEqual([1, 0, 0, 1]);
		expect(after.failures).toBe(1);
	});

	test("a success puts the count of failures back to none", () => {
		expect(run([failed, failed, good]).memory).toEqual({ lastStartedAt: START, failures: 0, told: null });
	});

	test("another cause is told, though one was told before", () => {
		const unauthorized = failureAutoReport(t, new BackendError("unauthorized", "HTTP 401"), "The pull failed.");
		expect(run([failed, unauthorized, unauthorized, failed]).shown).toEqual([1, 1, 0, 1]);
	});

	test("a wait for a confirmation is told once, and is not counted as a failure", () => {
		const waiting = pull({ outcome: "waiting", waitingFor: "deletions" });
		const { shown, memory: after } = run([waiting, waiting, waiting]);
		expect(shown).toEqual([1, 0, 0]);
		expect(after).toEqual({ lastStartedAt: START, failures: 0, told: "pull:waiting:deletions" });
	});

	test("a wait after failures ends the failures in a row: the remote was reached", () => {
		const waiting = pull({ outcome: "waiting", waitingFor: "rewritten" });
		expect(run([failed, failed, waiting]).memory.failures).toBe(0);
	});

	test("what happened in a sync is told every time, also while its cause is not", () => {
		const conflict = { path: "a.md", copyPath: "a (conflict).md", cause: "conflict" } as const;
		const report = pull({ outcome: "incomplete", conflicts: [conflict], deferred: [{ path: "b.md", reason: "unreadable" }] });
		expect(run([report, report]).shown).toEqual([2, 1]);
	});

	test("files that are not sent are told once, though every push that leaves them out goes well", () => {
		const leaving = push({ leftOut: [{ path: "big.bin", reason: "too-large" }] });
		const { shown, memory: after } = run([leaving, leaving, good, leaving]);
		expect(shown).toEqual([1, 0, 0, 1]);
		expect(after.failures).toBe(0);
	});

	test("a sync that is neither leaves everything as it was", () => {
		const moved = push({ outcome: "pull-first", reason: "remote-moved", revision: null });
		const before = memory({ failures: 2, told: "error:unreachable" });
		expect(settleAutoSync(before, moved, true)).toEqual({ memory: before, tell: false });
		expect(settleAutoSync(before, pull({ outcome: "cancelled" }), true)).toEqual({ memory: before, tell: false });
	});

	test("pulls that only met a file being typed in leave what was told as told, however many", () => {
		const typing = pull({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "changed-during-pull" }] });
		const { shown, memory: after } = run([failed, typing, typing, typing, failed]);
		// Not told a second time: no sync in between went well.
		expect(shown).toEqual([1, 0, 0, 0, 0]);
		expect(after).toEqual({ lastStartedAt: START, failures: 2, told: "error:unreachable" });
	});

	test("pulls that left a file alone because it is being typed in change nothing that is remembered", () => {
		const typing = pull({ outcome: "incomplete", deferred: [{ path: "a.md", reason: "being-edited" }] });
		const { shown, memory: after } = run([failed, typing, typing, good, typing, typing]);
		expect(shown).toEqual([1, 0, 0, 0, 0, 0]);
		// No failure in a row, so the interval stays as it is set.
		expect(after).toEqual({ lastStartedAt: START, failures: 0, told: null });
	});

	test("one more file that cannot be read is told once more", () => {
		const unreadable = (...paths: string[]): AutoReport =>
			pull({ outcome: "incomplete", deferred: paths.map((path) => ({ path, reason: "unreadable" as const })) });
		const { shown } = run([unreadable("a.md"), unreadable("a.md"), unreadable("a.md", "b.md"), unreadable("b.md", "a.md")]);
		expect(shown).toEqual([1, 0, 1, 0]);
	});

	test("settings that are not ready are told once, and counted, so that the interval grows", () => {
		const notReady = notReadyAutoReport(t, "token-value", "x");
		const { shown, memory: after } = run([notReady, notReady, notReady]);
		expect(shown).toEqual([1, 0, 0]);
		expect(after).toEqual({ lastStartedAt: START, failures: 3, told: "not-ready:token-value" });
	});

	test("a sync the user started counts as having told its cause, and is no failure in a row", () => {
		const settled = settleAutoSync(memory({ failures: 1 }), failed, false);
		expect(settled.memory).toEqual({ lastStartedAt: START, failures: 1, told: "error:unreachable" });
		// The automatic one after it does not say it again.
		expect(settleAutoSync(settled.memory, failed, true).tell).toBe(false);
	});

	test("a sync the user started that went well forgets the cause and ends the failures", () => {
		const before = memory({ failures: 3, told: "error:unreachable" });
		expect(settleAutoSync(before, good, false).memory).toEqual({ lastStartedAt: START, failures: 0, told: null });
	});

	test("a remote's limit is remembered until a sync goes well, from a sync of either kind", () => {
		const limited = failureAutoReport(t, new RateLimitedError(START + 3_600_000, "the day's requests"), "x");
		expect(limited.pausedUntil).toBe(START + 3_600_000);
		const paused = settleAutoSync(memory(), limited, false).memory;
		expect(paused.pausedUntil).toBe(START + 3_600_000);
		expect(settleAutoSync(paused, failed, true).memory.pausedUntil).toBe(START + 3_600_000);
		expect(settleAutoSync(paused, good, true).memory).not.toHaveProperty("pausedUntil");
		// Another failure says nothing of a limit.
		expect(failed).not.toHaveProperty("pausedUntil");
	});

	test("a pull that a remote's limit stopped remembers it, and so does the sync it was part of", () => {
		const report = pull({ outcome: "incomplete", fetchError: new RateLimitedError(START + 60_000, "x"), deferred: [{ path: "a.md", reason: "fetch-failed" }] });
		expect(report).toMatchObject({ end: "failure", pausedUntil: START + 60_000 });
		expect(joinAutoReports([report, good]).pausedUntil).toBe(START + 60_000);
		expect(joinAutoReports([good, good])).not.toHaveProperty("pausedUntil");
	});

	test("the time the last sync started is never changed here", () => {
		for (const report of [good, failed, pull({ outcome: "waiting", waitingFor: "deletions" })]) {
			expect(settleAutoSync(memory(), report, true).memory.lastStartedAt).toBe(START);
		}
	});
});

describe("the notices of a sync that started by itself, and its results", () => {
	const detail = (level: ReportDetail["level"], text: string, full = text): ReportDetail => ({
		text,
		full,
		...(level === "info" ? { brief: text } : {}),
		level,
		standing: false,
	});
	const report = (over: Partial<AutoReport>): AutoReport => ({
		happened: [],
		standing: [],
		questions: [],
		cause: "x",
		end: "failure",
		...over,
	});

	test("what went wrong is in one notice, what there is to see to in another, each under the heading", () => {
		const notices = autoNotices(
			t,
			report({
				happened: [detail("warn", "A conflict."), detail("info", "Moved to the trash.")],
				standing: [detail("error", "The download failed."), detail("error", "No token."), detail("warn", "Not sent.")],
			}),
			true,
		);
		expect(notices).toEqual([
			{ text: `${HEADING}The download failed.\n\nNo token.`, level: "error", stays: true },
			{ text: `${HEADING}A conflict.\n\nNot sent.`, level: "warn", stays: true },
		]);
	});

	test("what is only worth knowing is never shown", () => {
		expect(autoNotices(t, report({ happened: [detail("info", "Moved to the trash.")] }), true)).toEqual([]);
	});

	test("what stands in the way is shown only when it is told", () => {
		const standing = report({ happened: [detail("warn", "A conflict.")], standing: [detail("error", "The download failed.")] });
		expect(autoNotices(t, standing, false)).toEqual([{ text: `${HEADING}A conflict.`, level: "warn", stays: true }]);
		expect(autoNotices(t, report({ standing: [detail("warn", "Not sent.")] }), false)).toEqual([]);
	});

	test("each question is a notice of its own, after the rest, and only when it is told", () => {
		const waiting = report({ happened: [detail("warn", "A conflict.")], questions: ["Sync manually.", "And again."] });
		expect(autoNotices(t, waiting, true)).toEqual([
			{ text: `${HEADING}A conflict.`, level: "warn", stays: true },
			{ text: `${HEADING}Sync manually.`, level: "warn", stays: true, question: true },
			{ text: `${HEADING}And again.`, level: "warn", stays: true, question: true },
		]);
		expect(autoNotices(t, waiting, false)).toHaveLength(1);
	});

	test("a notice that leaves paths out says where all of them are, in its last line", () => {
		const cutShort = detail("warn", "Not sent:\na.md\n…and 1 more", "Not sent:\na.md\nb.md");
		const [notice] = autoNotices(t, report({ standing: [detail("warn", "A conflict."), cutShort] }), true);
		expect(notice?.text.endsWith(`\n\n${t("notice.seeResults")}`)).toBe(true);
		expect(autoNotices(t, report({ standing: [detail("warn", "A conflict.")] }), true)[0]?.text).not.toContain(
			t("notice.seeResults"),
		);
	});

	test("the results hold all that happened with every path, and what stands in the way and the questions when told", () => {
		const whole = report({
			happened: [detail("info", "Moved to the trash.", "Moved to the trash:\na.md")],
			standing: [detail("error", "The download failed.")],
			questions: ["Sync manually."],
		});
		expect(autoResults(whole, true)).toEqual([
			{ level: "info", text: "Moved to the trash:\na.md" },
			{ level: "error", text: "The download failed." },
			{ level: "warn", text: "Sync manually." },
		]);
		// Not each time it is not told: a device without a network would fill the screen with it.
		expect(autoResults(whole, false)).toEqual([{ level: "info", text: "Moved to the trash:\na.md" }]);
	});
});

describe("the digest of a set of files", () => {
	test("is the same for the same paths in any order, and given twice", () => {
		expect(filesDigest(["b.md", "a.md"])).toBe(filesDigest(["a.md", "b.md"]));
		expect(filesDigest(["a.md", "a.md"])).toBe(filesDigest(["a.md"]));
	});

	test("differs for another set, also where the paths run together to the same text", () => {
		expect(filesDigest(["a.md"])).not.toBe(filesDigest(["a.md", "b.md"]));
		expect(filesDigest(["ab", "c"])).not.toBe(filesDigest(["a", "bc"]));
		expect(filesDigest([])).not.toBe(filesDigest([""]));
		expect(filesDigest(["ノート/あ.md"])).not.toBe(filesDigest(["ノート/い.md"]));
	});

	test("is short, and plain text", () => {
		expect(filesDigest(["a.md", "notes/b.md"])).toMatch(/^[0-9a-f]{8}$/);
	});
});
