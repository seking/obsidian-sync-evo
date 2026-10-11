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
import {
	type AutoReport,
	autoTexts,
	failureAutoReport,
	filesDigest,
	joinAutoReports,
	notReadyAutoReport,
	pullAutoReport,
	pushAutoReport,
	settleAutoSync,
	stateAutoReport,
} from "../src/core/auto-report";
import { type AutoSyncMemory, NO_AUTO_SYNC_MEMORY } from "../src/core/auto-sync";
import { BackendError } from "../src/core/backend";
import { translatorFor } from "../src/core/i18n";
import type { PullResult } from "../src/core/pull";
import { pullFailureText, pullReport } from "../src/core/pull-report";
import type { PushRunResult } from "../src/core/push";
import { pushReport } from "../src/core/push-report";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

const t = translatorFor("en");
const HEADING = "Automatic sync:\n";

const settings: DeviceSettings = {
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	deviceName: "iPhone",
	autoSync: DEFAULT_AUTO_SYNC,
};
const options = { settings, sizeLimit: 50 * 1024 * 1024 };

const pulled = (over: Partial<PullResult> = {}): PullResult => ({
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

describe("a pull that started by itself", () => {
	test("that went well tells nothing, whatever it fetched", () => {
		const report = pull({ counts: { fetched: 12, deleted: 3, renamed: 1, conflicts: 0 }, refetched: 2 });
		expect(report).toEqual({ happened: [], standing: [], cause: null, end: "success" });
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
			recoveredPush: { added: 1, modified: 0, deleted: 0 },
			newSymlinks: ["link"],
			notices: [{ kind: "git-at-root", path: ".git" }],
		};

		const report = pull(result);

		// Each under the line that says nobody pressed anything.
		expect(report.happened).toEqual(pullReport(t, pulled(result), options).details.map((text) => HEADING + text));
		expect(report.happened).toHaveLength(8);
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
		expect(one.standing).toEqual([
			`${HEADING}1 file could not be pulled and is left for the next sync. Could not reach GitHub. Check the network connection and try again.`,
		]);
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
		expect(report.standing.every((text) => text.startsWith(HEADING))).toBe(true);
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
		expect(report.happened[0]?.startsWith(HEADING)).toBe(true);
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
		["a stop while it fetched", { outcome: "incomplete", fetchError: new BackendError("cancelled", "stopped") }],
		["a stop", { outcome: "cancelled" }],
		["a no", { outcome: "declined" }],
	])("%s is neither a success nor a failure, and has nothing to tell", (_name, result) => {
		expect(pull(result)).toEqual({ happened: [], standing: [], cause: null, end: "neither" });
	});

	test.each<[NonNullable<PullResult["waitingFor"]>, string]>([
		["deletions", "Pulling would delete many files on this device"],
		["rewritten", "The history of the remote was rewritten"],
		["first-fetch", "The first fetch into this vault is not finished"],
	])("a wait for %s says under the heading that nothing was changed, and to sync manually", (waitingFor, start) => {
		const report = pull({ outcome: "waiting", waitingFor });
		expect(report).toMatchObject({ happened: [], cause: `pull:waiting:${waitingFor}`, end: "waiting" });
		expect(report.standing).toHaveLength(1);
		expect(report.standing[0]?.startsWith(HEADING + start)).toBe(true);
		expect(report.standing[0]).toContain("Nothing was changed. Sync manually to ");
		// Named once, by the heading.
		expect(report.standing[0]?.match(/utomatic sync/g)).toHaveLength(1);
	});

	test("the wait for a first fetch is worded so that it is true with and without something to confirm", () => {
		// Not begun at all, or begun and stopped, with a file that differs since.
		expect(pull({ outcome: "waiting", waitingFor: "first-fetch" }).standing).toEqual([
			`${HEADING}The first fetch into this vault is not finished. It is not started without you, and not continued while files in the vault differ from the remote's. Nothing was changed. Sync manually to start or continue it.`,
		]);
		const ja = pullAutoReport(translatorFor("ja"), pulled({ outcome: "waiting", waitingFor: "first-fetch" }), options);
		expect(ja.standing[0]?.startsWith("自動同期：\nこの保管庫の初回取得が終わっていません。")).toBe(true);
		expect(ja.standing[0]?.match(/自動同期/g)).toHaveLength(1);
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

		expect(report.happened).toEqual(pushReport(t, pushed(result), options).details.map((text) => HEADING + text));
		expect(report.happened).toHaveLength(4);
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
		expect(report.standing.every((text) => text.startsWith(HEADING))).toBe(true);
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
		expect(report).toEqual({ happened: [], standing: [], cause: null, end: "neither" });
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
		expect(report.standing).toEqual([HEADING + pushReport(t, pushed(result), options).summary]);
	});

	test.each<[NonNullable<PushRunResult["waitingFor"]>, string]>([
		["first-push", "The first push from this device needs your confirmation"],
		["deletions", "Pushing would delete many files on the remote"],
	])("a question about %s waits, and says that nothing was sent and how to be asked", (waitingFor, start) => {
		const report = push({ outcome: "waiting", waitingFor, revision: null });
		expect(report).toMatchObject({ happened: [], cause: `push:waiting:${waitingFor}`, end: "waiting" });
		expect(report.standing).toHaveLength(1);
		expect(report.standing[0]?.startsWith(HEADING + start)).toBe(true);
		expect(report.standing[0]).toContain("Nothing was sent. Sync manually to be asked.");
		expect(report.standing[0]?.match(/utomatic sync/g)).toHaveLength(1);
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
		expect(report).toEqual({
			happened: [],
			standing: [`${HEADING}The pull failed. Could not reach GitHub. Check the network connection and try again.`],
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
			cause: null,
			end: "neither",
		});
	});

	test("settings that lack what a request needs are a failure by what they lack, with no file in the cause", () => {
		const report = notReadyAutoReport(t, "token-value", "The secret holds no token.");
		expect(report).toEqual({
			happened: [],
			standing: [`${HEADING}The secret holds no token.`],
			cause: "not-ready:token-value",
			end: "failure",
		});
	});

	test("no sync state to run with is a failure by what is wrong with it", () => {
		const report = stateAutoReport(t, "no-indexeddb");
		expect(report).toMatchObject({ cause: "state:no-indexeddb", end: "failure" });
		expect(report.standing[0]?.startsWith(HEADING)).toBe(true);
	});
});

describe("the parts of one sync as one", () => {
	const good: AutoReport = { happened: [], standing: [], cause: null, end: "success" };

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
		expect(whole.cause).toBe(`pull:incomplete:unreadable#${filesDigest(["b.md"])} push:waiting:deletions`);
	});

	test("no part at all is nothing to go by", () => {
		expect(joinAutoReports([])).toEqual({ happened: [], standing: [], cause: null, end: "neither" });
	});
});

describe("what is told, and what is remembered of it", () => {
	const START = 1_700_000_000_000;
	const memory = (over: Partial<AutoSyncMemory> = {}): AutoSyncMemory => ({ ...NO_AUTO_SYNC_MEMORY, lastStartedAt: START, ...over });
	const failed = failureAutoReport(t, offline, "The pull failed.");
	const good: AutoReport = { happened: [], standing: [], cause: null, end: "success" };

	/** Automatic syncs one after the other: how many notices each showed, and what is remembered at the end. */
	function run(reports: readonly AutoReport[], from = memory()): { shown: number[]; memory: AutoSyncMemory } {
		let now = from;
		const shown: number[] = [];
		for (const report of reports) {
			const settled = settleAutoSync(now, report, true);
			shown.push(autoTexts(report, settled.tell).length);
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

	test("the time the last sync started is never changed here", () => {
		for (const report of [good, failed, pull({ outcome: "waiting", waitingFor: "deletions" })]) {
			expect(settleAutoSync(memory(), report, true).memory.lastStartedAt).toBe(START);
		}
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
