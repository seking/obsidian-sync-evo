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

// The quota of the Drive API, as this device keeps to it. Everyone who uses
// Sync Evo's Google client shares one project (R-1), and with it the limit
// of the project for a minute: 1,000,000 units, of which one user may use
// 325,000. A device that downloads a large vault for the first time, 16
// files at once, could use a third of the project's minute alone, and three
// of them at once would have every user of Sync Evo answered 403.

/**
 * The units this device uses in a minute at most, apart from the burst
 * below: a tenth of the project's minute, and under a third of what one
 * user may use. With the burst, a device uses up to 120,000 units in a
 * minute: eight devices fetching a vault for the first time at the same
 * moment stay within the project's minute (960,000), and a ninth does not.
 * 500 downloads a minute: a vault of 5,000 notes comes down in about ten
 * minutes.
 */
export const DRIVE_UNITS_PER_MINUTE = 100_000;

/**
 * What may be used at once on top of that, after a while without requests:
 * a hundred downloads. A sync that finds a few changes, or a small vault,
 * never waits. In any one minute this device uses no more than this and
 * `DRIVE_UNITS_PER_MINUTE` together.
 */
export const DRIVE_UNITS_BURST = 20_000;

/**
 * What a request costs, in the units of Google's table of 2026-09
 * (developers.google.com/workspace/drive/api/guides/limits): a download
 * 200, `files.get` 5, a listing of files or of changes 100, a creation or
 * an update 50. What the table does not name is taken at 100, the most a
 * call without content costs: a GET of something other than one file, and
 * the content sent to an upload session.
 */
export function driveUnits(method: string, url: string): number {
	if (url.includes("alt=media")) return 200;
	if (method === "GET") return /\/drive\/v3\/files\/[^/?]+(\?|$)/.test(url) ? 5 : 100;
	if (method === "POST" || method === "PATCH") return 50;
	return 100;
}

/**
 * The units this device has used, kept to `perMinute` with a burst of
 * `burst` (a leaky bucket, counted by the time at which the bucket would be
 * empty again). Requests that run at once each take their own place in the
 * line: the wait one is answered with already counts the ones before it.
 *
 * One of these per device, for every client of Drive on it: a new sync
 * does not start with a full burst again.
 */
export class DriveQuota {
	private readonly msPerUnit: number;
	private readonly toleranceMs: number;
	/** When the bucket would be empty again, in milliseconds since the epoch. */
	private emptyAt = Number.NEGATIVE_INFINITY;

	constructor(perMinute = DRIVE_UNITS_PER_MINUTE, burst = DRIVE_UNITS_BURST) {
		this.msPerUnit = 60_000 / perMinute;
		this.toleranceMs = burst * this.msPerUnit;
	}

	/** Takes `units` at `now`, and answers how long to wait before the request is sent, in milliseconds. */
	take(units: number, now: number): number {
		// A bucket that would be empty so much later than any line of
		// requests can make it was filled by a clock that has since been
		// set back. Waiting for that clock to come back would stop the sync.
		if (this.emptyAt - now > this.toleranceMs + 60_000) this.emptyAt = now;
		this.emptyAt = Math.max(this.emptyAt, now) + units * this.msPerUnit;
		return Math.max(0, Math.ceil(this.emptyAt - now - this.toleranceMs));
	}
}

/**
 * When the day of Google's quotas ends: midnight in the Pacific time
 * (America/Los_Angeles), the first after `now`, in milliseconds since the
 * epoch. By the rules of the United States since 2007, and not by the
 * time-zone data of the device, which a phone may lack: summer time from
 * the second Sunday of March to the first Sunday of November, both at 2:00,
 * so that midnight falls in summer time on the days after the first and up
 * to and with the second.
 */
export function nextPacificMidnight(now: number): number {
	const today = new Date(now);
	for (let days = -1; days <= 2; days++) {
		const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days);
		const midnight = base + pacificOffsetHours(new Date(base)) * 3_600_000;
		if (midnight > now) return midnight;
	}
	// Not reached: the midnight of the day after tomorrow is always later.
	return now + 24 * 3_600_000;
}

/** How many hours the Pacific time is behind UTC at midnight of `day` (a date at 00:00 UTC). */
function pacificOffsetHours(day: Date): number {
	const year = day.getUTCFullYear();
	const summerFrom = Date.UTC(year, 2, nthSunday(year, 2, 2));
	const summerTo = Date.UTC(year, 10, nthSunday(year, 10, 1));
	const at = day.getTime();
	return at > summerFrom && at <= summerTo ? 7 : 8;
}

/** The day of the month of the `n`th Sunday of a month (`month` from 0). */
function nthSunday(year: number, month: number, n: number): number {
	const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
	return 1 + ((7 - firstWeekday) % 7) + 7 * (n - 1);
}
