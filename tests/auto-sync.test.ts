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
import {
	AUTO_SYNC_KEY,
	type AutoSyncClock,
	dueOnResume,
	dueOnTick,
	ForegroundClock,
	FullCheckDebt,
	intervalMs,
	MAX_BACKOFF_MS,
	MAX_PAUSE_MS,
	NO_AUTO_SYNC_MEMORY,
	readAutoSyncMemory,
	RESUME_GAP_MS,
	SUSPENDED_AFTER_MS,
	TICK_MS,
	writeAutoSyncMemory,
} from "../src/core/auto-sync";
import { type AutoSyncSettings, DEFAULT_AUTO_SYNC } from "../src/core/settings";
import { MemoryStateStore } from "./support/memory-state-store";

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

const auto = (over: Partial<AutoSyncSettings> = {}): AutoSyncSettings => ({ ...DEFAULT_AUTO_SYNC, ...over });
/** The clock, with the last sync started `ago` milliseconds before now; `null` for none ever. */
const clock = (ago: number | null, failures = 0, fullOwed = false): AutoSyncClock => ({
	now: NOW,
	lastStartedAt: ago === null ? null : NOW - ago,
	failures,
	fullOwed,
});

describe("the interval that is waited for", () => {
	test("is the one that is set while nothing failed", () => {
		expect(intervalMs(auto({ intervalMinutes: 15 }), 0)).toBe(15 * MINUTE);
		expect(intervalMs(auto({ intervalMinutes: 1 }), 0)).toBe(MINUTE);
	});

	test("doubles with each failure in a row, up to an hour", () => {
		const settings = auto({ intervalMinutes: 5 });
		expect(intervalMs(settings, 1)).toBe(10 * MINUTE);
		expect(intervalMs(settings, 2)).toBe(20 * MINUTE);
		expect(intervalMs(settings, 3)).toBe(40 * MINUTE);
		expect(intervalMs(settings, 4)).toBe(MAX_BACKOFF_MS);
		expect(intervalMs(settings, 5)).toBe(MAX_BACKOFF_MS);
		expect(intervalMs(settings, 5000)).toBe(MAX_BACKOFF_MS);
	});

	test("an interval set longer than an hour is not shortened by a failure, and not doubled", () => {
		const settings = auto({ intervalMinutes: 120 });
		expect(intervalMs(settings, 0)).toBe(120 * MINUTE);
		expect(intervalMs(settings, 3)).toBe(120 * MINUTE);
	});

	test("a count that is no count is none", () => {
		expect(intervalMs(auto({ intervalMinutes: 5 }), -2)).toBe(5 * MINUTE);
	});
});

describe("when the app starts or comes back to the front", () => {
	test("nothing starts while both switches are off", () => {
		expect(dueOnResume(auto(), clock(null))).toBeNull();
		expect(dueOnResume(auto(), clock(24 * 60 * MINUTE))).toBeNull();
	});

	test("with sync on startup: a full check once the last sync started 5 minutes ago", () => {
		const settings = auto({ onStartup: true });
		expect(dueOnResume(settings, clock(RESUME_GAP_MS - 1))).toBeNull();
		expect(dueOnResume(settings, clock(RESUME_GAP_MS))).toBe("full");
		expect(dueOnResume(settings, clock(RESUME_GAP_MS + 1))).toBe("full");
		expect(dueOnResume(settings, clock(0))).toBeNull();
	});

	test("with sync on startup: a full check when no sync ever started", () => {
		expect(dueOnResume(auto({ onStartup: true }), clock(null))).toBe("full");
	});

	test("with sync at an interval: a full check once the interval has passed", () => {
		const settings = auto({ atInterval: true, intervalMinutes: 15 });
		expect(dueOnResume(settings, clock(15 * MINUTE - 1))).toBeNull();
		expect(dueOnResume(settings, clock(15 * MINUTE))).toBe("full");
		expect(dueOnResume(settings, clock(null))).toBe("full");
	});

	test("an interval shorter than 5 minutes syncs on a return before the 5 minutes are over", () => {
		const settings = auto({ atInterval: true, intervalMinutes: 1 });
		expect(dueOnResume(settings, clock(MINUTE))).toBe("full");
		expect(dueOnResume(settings, clock(MINUTE - 1))).toBeNull();
	});

	test("with both: whichever comes first", () => {
		const settings = auto({ onStartup: true, atInterval: true, intervalMinutes: 30 });
		expect(dueOnResume(settings, clock(RESUME_GAP_MS))).toBe("full");
		expect(dueOnResume(settings, clock(RESUME_GAP_MS - 1))).toBeNull();
	});

	test("failures lengthen the interval, and not the 5 minutes", () => {
		const interval = auto({ atInterval: true, intervalMinutes: 5 });
		expect(dueOnResume(interval, clock(9 * MINUTE, 1))).toBeNull();
		expect(dueOnResume(interval, clock(10 * MINUTE, 1))).toBe("full");
		expect(dueOnResume(auto({ onStartup: true }), clock(RESUME_GAP_MS, 4))).toBe("full");
	});

	test("a last start in the future, after the clock was set back, counts as long ago", () => {
		const ahead: AutoSyncClock = { now: NOW, lastStartedAt: NOW + 60 * MINUTE, failures: 0, fullOwed: false };
		expect(dueOnResume(auto({ onStartup: true }), ahead)).toBe("full");
		expect(dueOnResume(auto({ atInterval: true }), ahead)).toBe("full");
		expect(dueOnResume(auto(), ahead)).toBeNull();
	});

	test("a return that is noticed twice syncs once: the second finds the start of the first", () => {
		const settings = auto({ onStartup: true, atInterval: true });
		expect(dueOnResume(settings, clock(60 * MINUTE))).toBe("full");
		// The sync of the first has started, and set the last start to now.
		expect(dueOnResume(settings, clock(0))).toBeNull();
		expect(dueOnResume(settings, clock(40))).toBeNull();
	});
});

describe("while the app stays in front", () => {
	test("nothing starts without sync at an interval, however long ago the last sync was", () => {
		expect(dueOnTick(auto({ onStartup: true }), clock(null))).toBeNull();
		expect(dueOnTick(auto({ onStartup: true }), clock(24 * 60 * MINUTE))).toBeNull();
	});

	test("a light check once the interval has passed since the last start", () => {
		const settings = auto({ atInterval: true, intervalMinutes: 15 });
		expect(dueOnTick(settings, clock(15 * MINUTE - 1))).toBeNull();
		expect(dueOnTick(settings, clock(15 * MINUTE))).toBe("light");
		expect(dueOnTick(settings, clock(null))).toBe("light");
	});

	test("the bounds of the interval: one minute, and a day", () => {
		expect(dueOnTick(auto({ atInterval: true, intervalMinutes: 1 }), clock(MINUTE - 1))).toBeNull();
		expect(dueOnTick(auto({ atInterval: true, intervalMinutes: 1 }), clock(MINUTE))).toBe("light");
		expect(dueOnTick(auto({ atInterval: true, intervalMinutes: 1440 }), clock(1440 * MINUTE - 1))).toBeNull();
		expect(dueOnTick(auto({ atInterval: true, intervalMinutes: 1440 }), clock(1440 * MINUTE))).toBe("light");
	});

	test("after a failure the next one waits twice as long, and after a success as long as set", () => {
		const settings = auto({ atInterval: true, intervalMinutes: 15 });
		expect(dueOnTick(settings, clock(15 * MINUTE, 1))).toBeNull();
		expect(dueOnTick(settings, clock(30 * MINUTE, 1))).toBe("light");
		expect(dueOnTick(settings, clock(59 * MINUTE, 2))).toBeNull();
		expect(dueOnTick(settings, clock(60 * MINUTE, 2))).toBe("light");
		expect(dueOnTick(settings, clock(60 * MINUTE, 9))).toBe("light");
		expect(dueOnTick(settings, clock(15 * MINUTE, 0))).toBe("light");
	});

	test("a sync that runs is not followed by one that was due meanwhile: counted from its start", () => {
		const settings = auto({ atInterval: true, intervalMinutes: 5 });
		// A sync started 4 minutes ago and took 3 of them.
		expect(dueOnTick(settings, clock(4 * MINUTE))).toBeNull();
		expect(dueOnTick(settings, clock(5 * MINUTE))).toBe("light");
	});

	test("a last start in the future counts as long ago", () => {
		const ahead: AutoSyncClock = { now: NOW, lastStartedAt: NOW + 1, failures: 0, fullOwed: false };
		expect(dueOnTick(auto({ atInterval: true }), ahead)).toBe("light");
	});
});

describe("the full check that is owed after the app came to the front", () => {
	const settings = auto({ onStartup: true, atInterval: true, intervalMinutes: 15 });

	test("while it is owed, the sync that comes with the interval is a full one", () => {
		expect(dueOnTick(settings, clock(15 * MINUTE, 0, true))).toBe("full");
		expect(dueOnTick(settings, clock(15 * MINUTE, 0, false))).toBe("light");
	});

	test("it makes no sync due that is not", () => {
		expect(dueOnTick(settings, clock(15 * MINUTE - 1, 0, true))).toBeNull();
		expect(dueOnTick(auto({ onStartup: true }), clock(60 * MINUTE, 0, true))).toBeNull();
		expect(dueOnResume(settings, clock(MINUTE, 0, true))).toBeNull();
	});

	test("a return is a full check whether or not one was owed before", () => {
		expect(dueOnResume(settings, clock(RESUME_GAP_MS, 0, false))).toBe("full");
		expect(dueOnResume(settings, clock(RESUME_GAP_MS, 0, true))).toBe("full");
	});

	test("it is owed from the start of the app", () => {
		expect(new FullCheckDebt().isOwed).toBe(true);
	});

	test("it is paid when a sync with a full check lists the vault, and not by a light one", () => {
		const debt = new FullCheckDebt();
		debt.syncReached("light", "scanning");
		expect(debt.isOwed).toBe(true);
		debt.syncReached("full", "scanning");
		expect(debt.isOwed).toBe(false);
		debt.syncReached("light", "scanning");
		expect(debt.isOwed).toBe(false);
	});

	test("a full sync that fails before it lists the vault still owes it", () => {
		const debt = new FullCheckDebt();
		// Without a network: it got as far as asking the remote.
		debt.syncReached("full", "listing");
		expect(debt.isOwed).toBe(true);
		expect(dueOnTick(settings, clock(15 * MINUTE, 1, debt.isOwed))).toBeNull();
		expect(dueOnTick(settings, clock(30 * MINUTE, 1, debt.isOwed))).toBe("full");
	});

	test("it is paid once the vault is listed, whatever the sync does after that", () => {
		for (const phase of ["hashing", "applying", "sending", "finishing"]) {
			const debt = new FullCheckDebt();
			debt.syncReached("full", phase);
			expect(debt.isOwed).toBe(true);
		}
		const debt = new FullCheckDebt();
		debt.syncReached("full", "listing");
		debt.syncReached("full", "scanning");
		debt.syncReached("full", "hashing");
		expect(debt.isOwed).toBe(false);
	});

	test("every return to the front owes it again", () => {
		const debt = new FullCheckDebt();
		debt.syncReached("full", "scanning");
		debt.resumed();
		expect(debt.isOwed).toBe(true);
	});

	test("a return inside the 5 minutes starts no sync, and the next one at the interval is full", () => {
		const debt = new FullCheckDebt();
		debt.syncReached("full", "scanning");
		// Two minutes later the app is left and come back to.
		debt.resumed();
		expect(dueOnResume(settings, clock(2 * MINUTE, 0, debt.isOwed))).toBeNull();
		const due = dueOnTick(settings, clock(15 * MINUTE, 0, debt.isOwed));
		expect(due).toBe("full");
		debt.syncReached("full", "scanning");
		// And the one after that is light again.
		expect(dueOnTick(settings, clock(15 * MINUTE, 0, debt.isOwed))).toBe("light");
	});
});

describe("telling a return from a look at the clock", () => {
	test("the looks of a timer that keeps running are ordinary ones", () => {
		const front = new ForegroundClock();
		expect(front.tick(NOW, true)).toBe("tick");
		expect(front.tick(NOW + TICK_MS, true)).toBe("tick");
		expect(front.tick(NOW + 2 * TICK_MS + 300, true)).toBe("tick");
	});

	test("a timer that is held up for less than three periods is not a return", () => {
		const front = new ForegroundClock();
		front.tick(NOW, true);
		expect(front.tick(NOW + SUSPENDED_AFTER_MS, true)).toBe("tick");
	});

	test("a look that comes much later than a period after the one before is a return", () => {
		const front = new ForegroundClock();
		front.tick(NOW, true);
		expect(front.tick(NOW + SUSPENDED_AFTER_MS + 1, true)).toBe("resume");
		// And only that one.
		expect(front.tick(NOW + SUSPENDED_AFTER_MS + 1 + TICK_MS, true)).toBe("tick");
	});

	test("nothing is done while the app is not in front, and the first look back in front is a return", () => {
		const front = new ForegroundClock();
		front.tick(NOW, true);
		// A desktop keeps the timer running behind another window.
		expect(front.tick(NOW + TICK_MS, false)).toBeNull();
		expect(front.tick(NOW + 2 * TICK_MS, false)).toBeNull();
		expect(front.tick(NOW + 3 * TICK_MS, false)).toBeNull();
		expect(front.tick(NOW + 4 * TICK_MS, true)).toBe("resume");
	});

	test("once the app has said that it is shown, the look that follows is an ordinary one", () => {
		const front = new ForegroundClock();
		front.tick(NOW, true);
		const back = NOW + 30 * MINUTE;
		front.shown(back);
		expect(front.tick(back + 2_000, true)).toBe("tick");
	});

	test("a clock that was set back is no return", () => {
		const front = new ForegroundClock();
		front.tick(NOW, true);
		expect(front.tick(NOW - 60 * MINUTE, true)).toBe("tick");
		expect(front.tick(NOW - 60 * MINUTE + TICK_MS, true)).toBe("tick");
	});
});

describe("while a remote's limit holds automatic sync back", () => {
	const settings = auto({ onStartup: true, atInterval: true, intervalMinutes: 15 });
	const paused = (ms: number): AutoSyncClock => ({ ...clock(null), pausedUntil: NOW + ms });

	test("no sync starts, on a return or at the interval, until the time comes", () => {
		expect(dueOnResume(settings, paused(1))).toBeNull();
		expect(dueOnTick(settings, paused(1))).toBeNull();
		expect(dueOnResume(settings, paused(0))).toBe("full");
		expect(dueOnTick(settings, paused(-1))).toBe("light");
	});

	test("a time further ahead than a day of Google's quotas was set by a clock set back since, and holds nothing back", () => {
		expect(dueOnTick(settings, paused(MAX_PAUSE_MS))).toBeNull();
		expect(dueOnTick(settings, paused(MAX_PAUSE_MS + 1))).toBe("light");
	});
});

describe("what automatic sync remembers", () => {
	test("nothing, in a sync state that holds nothing of it", async () => {
		expect(await readAutoSyncMemory(new MemoryStateStore())).toEqual(NO_AUTO_SYNC_MEMORY);
	});

	test("what was written is read back", async () => {
		const store = new MemoryStateStore();
		const memory = { lastStartedAt: NOW, failures: 2, told: "error:unreachable" };
		await writeAutoSyncMemory(store, memory);
		expect(await readAutoSyncMemory(store)).toEqual(memory);
	});

	test("until when a remote's limit holds it back is read back too", async () => {
		const store = new MemoryStateStore();
		const memory = { lastStartedAt: NOW, failures: 1, told: "error:rate-limited", pausedUntil: NOW + MINUTE };
		await writeAutoSyncMemory(store, memory);
		expect(await readAutoSyncMemory(store)).toEqual(memory);
		await store.setMeta(AUTO_SYNC_KEY, { ...memory, pausedUntil: "soon" });
		expect(await readAutoSyncMemory(store)).not.toHaveProperty("pausedUntil");
	});

	test("only the known fields are stored", async () => {
		const store = new MemoryStateStore();
		await writeAutoSyncMemory(store, { ...NO_AUTO_SYNC_MEMORY, extra: 1 } as typeof NO_AUTO_SYNC_MEMORY);
		expect(await store.getMeta(AUTO_SYNC_KEY)).toEqual({ lastStartedAt: null, failures: 0, told: null });
	});

	test.each<[string, unknown]>([
		["text", "yesterday"],
		["a list", [1, 2]],
		["null", null],
		["fields of the wrong kind", { lastStartedAt: "now", failures: "2", told: 7 }],
		["a count below none, and one that is no whole number", { failures: -1 }],
		["a time that is no number", { lastStartedAt: Number.NaN, failures: 1.5 }],
	])("%s is read as nothing remembered", async (_name, value) => {
		const store = new MemoryStateStore();
		await store.setMeta(AUTO_SYNC_KEY, value);
		expect(await readAutoSyncMemory(store)).toEqual(NO_AUTO_SYNC_MEMORY);
	});

	test("a field that can be read is kept beside one that cannot", async () => {
		const store = new MemoryStateStore();
		await store.setMeta(AUTO_SYNC_KEY, { lastStartedAt: NOW, failures: {}, told: "x" });
		expect(await readAutoSyncMemory(store)).toEqual({ lastStartedAt: NOW, failures: 0, told: "x" });
	});
});
