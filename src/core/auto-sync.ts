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

// When a sync starts by itself: the rules, and nothing that keeps time. The
// clock is the app's (`obsidian/auto-scheduler.ts`), which asks here on
// every look at it.
//
// Everything is measured from the start of the last sync, whoever started
// it and however it ended. A sync that runs is therefore never followed by
// one that was due meanwhile: the next is counted from its start.

import type { AutoSyncSettings } from "./settings";
import type { StateStore } from "./state";

/**
 * How the vault is looked at by a sync that starts by itself.
 *
 * - "full": every folder is listed, like in a sync the user starts. When the
 *   app starts and when it comes back to the front: another app may have
 *   changed anything meanwhile.
 * - "light": the files are told apart from what the app holds in memory
 *   (`light-scan.ts`). At an interval, while the app stays in front, once
 *   a sync has looked at everything since the app last came there.
 */
export type AutoCheck = "full" | "light";

/**
 * How long after the start of a sync the app starting, or coming back to
 * the front, does not sync again. On a phone the app is left and come back
 * to all the time.
 */
export const RESUME_GAP_MS = 5 * 60_000;

/** The longest the interval gets by doubling after failures. An interval set longer than this stays as set. */
export const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * The longest a remote's limit holds automatic sync back (`pausedUntil`):
 * a day of Google's quotas, and the hour it gains or loses with summer
 * time. Further ahead, the clock of the device was set back since.
 */
export const MAX_PAUSE_MS = 25 * 60 * 60_000;

/** How often the clock is looked at while the app is in front. */
export const TICK_MS = 10_000;

/**
 * A look at the clock that comes later than this after the one before means
 * the app stood still in between: on a phone, timers stop in the background.
 * Three periods, so that a timer held up by a busy app is not taken for it.
 */
export const SUSPENDED_AFTER_MS = 3 * TICK_MS;

/** What the decision goes by, apart from the settings. */
export interface AutoSyncClock {
	/** Milliseconds since the epoch, on the clock `lastStartedAt` was read from. */
	readonly now: number;
	/** When the last sync started, of whatever kind; `null` when none ever did. */
	readonly lastStartedAt: number | null;
	/** How many automatic syncs failed in a row. */
	readonly failures: number;
	/**
	 * Whether a full check is owed: the app has started or come back to the
	 * front, and no sync has listed every folder since (`FullCheckDebt`).
	 */
	readonly fullOwed: boolean;
	/** Until when the remote said it takes no requests (`AutoSyncMemory.pausedUntil`). */
	readonly pausedUntil?: number;
}

/**
 * Whether the next automatic sync has to look at every folder. What the app
 * holds in memory may not know what another app wrote while this one was in
 * the background, and a return to the front does not always start a sync:
 * within five minutes of the last one it starts none. The sync that then
 * comes with the interval must not be a light one.
 *
 * Owed from the start of the app, and from every return to the front,
 * until a sync with a full check gets as far as listing the vault: an
 * automatic one, or any sync the user starts, which are all full. Not paid
 * by one that only started: without a network it fails before it has
 * looked at a single folder, and the next would be a light one. Nor does it
 * wait for the sync to end well: once the vault was listed, what another
 * app wrote has been seen.
 */
export class FullCheckDebt {
	private owed = true;

	get isOwed(): boolean {
		return this.owed;
	}

	/** The app has started, or has come back to the front. */
	resumed(): void {
		this.owed = true;
	}

	/**
	 * A sync reports where it is. `check` is how it looks at the vault,
	 * "full" for every sync the user starts; `phase` is what the pull or the
	 * push says it is doing (`PullPhase`, `PushPhase`). Both say "scanning"
	 * when they begin to list the vault.
	 */
	syncReached(check: AutoCheck, phase: string): void {
		if (check === "full" && phase === "scanning") this.owed = false;
	}
}

/**
 * The interval that is waited for now, in milliseconds: the one that is set,
 * doubled for each automatic sync that failed in a row, up to an hour. A
 * device without a network does not ask every minute.
 */
export function intervalMs(settings: AutoSyncSettings, failures: number): number {
	const set = settings.intervalMinutes * 60_000;
	// Past twenty doublings nothing changes, and a shift would overflow.
	const doubled = set * 2 ** Math.min(Math.max(failures, 0), 20);
	return Math.min(doubled, Math.max(set, MAX_BACKOFF_MS));
}

/**
 * How long ago the last sync started. No sync yet is "long ago". So is a
 * start that lies in the future: the clock of the device was set back, and
 * waiting for it to catch up could mean never syncing again.
 */
function sinceLastStart(clock: AutoSyncClock): number {
	if (clock.lastStartedAt === null || clock.now < clock.lastStartedAt) return Number.POSITIVE_INFINITY;
	return clock.now - clock.lastStartedAt;
}

/**
 * Whether the remote's limit holds automatic sync back now: it said until
 * when it takes no requests, and that time has not come. A sync would only
 * fail again, and use up requests of the others who share the limit.
 */
function paused(clock: AutoSyncClock): boolean {
	const until = clock.pausedUntil;
	return until !== undefined && clock.now < until && until - clock.now <= MAX_PAUSE_MS;
}

/**
 * Whether a sync starts when the app has started or has come back to the
 * front. Asked as often as either is noticed: a return that is seen twice
 * finds the sync of the first running, or just started.
 */
export function dueOnResume(settings: AutoSyncSettings, clock: AutoSyncClock): AutoCheck | null {
	if (paused(clock)) return null;
	const since = sinceLastStart(clock);
	if (settings.onStartup && since >= RESUME_GAP_MS) return "full";
	if (settings.atInterval && since >= intervalMs(settings, clock.failures)) return "full";
	return null;
}

/**
 * Whether a sync starts at a look at the clock while the app stays in
 * front. With the light check, unless a full one is owed.
 */
export function dueOnTick(settings: AutoSyncSettings, clock: AutoSyncClock): AutoCheck | null {
	if (!settings.atInterval || paused(clock) || sinceLastStart(clock) < intervalMs(settings, clock.failures)) return null;
	return clock.fullOwed ? "full" : "light";
}

/**
 * Tells a look at the clock after the app stood still from one while it
 * stayed in front. The event that says the app is shown again is not relied
 * on alone: on an iPhone it came twice in a row once, with no "hidden" in
 * between, and the events of a page being hidden and shown never came.
 */
export class ForegroundClock {
	/** When the clock was last looked at with the app in front. */
	private lastSeenAt: number | null = null;

	/**
	 * A look at the clock from the timer. `null` while the app is not in
	 * front: nothing is done then, and the look is not remembered, so that
	 * the first one back in front reads as a return.
	 */
	tick(now: number, visible: boolean): "resume" | "tick" | null {
		if (!visible) return null;
		const before = this.lastSeenAt;
		this.lastSeenAt = now;
		// The first look is the start of the app, which is asked about apart.
		if (before === null) return "tick";
		return now - before > SUSPENDED_AFTER_MS ? "resume" : "tick";
	}

	/** The app says it is shown: a return, at once. The look of the timer that follows is an ordinary one. */
	shown(now: number): void {
		this.lastSeenAt = now;
	}
}

// ---------------------------------------------------------------------------
// What is remembered

/** The key, among the other values of the sync state, of what automatic sync remembers. */
export const AUTO_SYNC_KEY = "auto-sync";

/**
 * What is remembered between syncs, and with the sync state: a change of
 * the connection discards it with everything else.
 */
export interface AutoSyncMemory {
	/** When the last sync started, automatic or not; `null` when none did. */
	readonly lastStartedAt: number | null;
	/** How many automatic syncs failed in a row. */
	readonly failures: number;
	/**
	 * What stands in the way of the sync and the user was last told
	 * (`AutoReport.cause`), or `null`. While a sync ends with the same, it is
	 * not told again.
	 */
	readonly told: string | null;
	/**
	 * Until when the remote said it takes no requests, in milliseconds since
	 * the epoch (`RateLimitedError.waitUntil`): Google Drive, when the
	 * requests of the day have run out. No sync starts by itself before.
	 * Absent when it said nothing of the kind.
	 */
	readonly pausedUntil?: number;
}

export const NO_AUTO_SYNC_MEMORY: AutoSyncMemory = { lastStartedAt: null, failures: 0, told: null };

/** What is stored, or nothing remembered for anything that cannot be read as it. */
export async function readAutoSyncMemory(store: Pick<StateStore, "getMeta">): Promise<AutoSyncMemory> {
	const value = await store.getMeta(AUTO_SYNC_KEY);
	if (typeof value !== "object" || value === null) return NO_AUTO_SYNC_MEMORY;
	const { lastStartedAt, failures, told, pausedUntil } = value as Record<string, unknown>;
	return {
		lastStartedAt: typeof lastStartedAt === "number" && Number.isFinite(lastStartedAt) ? lastStartedAt : null,
		failures: typeof failures === "number" && Number.isInteger(failures) && failures > 0 ? failures : 0,
		told: typeof told === "string" ? told : null,
		...(typeof pausedUntil === "number" && Number.isFinite(pausedUntil) ? { pausedUntil } : {}),
	};
}

/** Field by field, so that nothing else an object happens to carry is stored. */
export function writeAutoSyncMemory(store: Pick<StateStore, "setMeta">, memory: AutoSyncMemory): Promise<void> {
	return store.setMeta(AUTO_SYNC_KEY, {
		lastStartedAt: memory.lastStartedAt,
		failures: memory.failures,
		told: memory.told,
		...(memory.pausedUntil === undefined ? {} : { pausedUntil: memory.pausedUntil }),
	});
}
