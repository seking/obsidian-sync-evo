/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test } from "vitest";
import { DRIVE_API, DRIVE_UPLOAD } from "../src/core/gdrive/client";
import { DRIVE_UNITS_BURST, DRIVE_UNITS_PER_MINUTE, DriveQuota, driveUnits, nextPacificMidnight } from "../src/core/gdrive/quota";

describe("the units of a request", () => {
	test.each<[string, "GET" | "POST" | "PATCH" | "PUT", string, number]>([
		["a download", "GET", `${DRIVE_API}/files/abc?alt=media`, 200],
		["files.get", "GET", `${DRIVE_API}/files/abc?fields=id%2Cname`, 5],
		["files.get without a query", "GET", `${DRIVE_API}/files/abc`, 5],
		["files.list", "GET", `${DRIVE_API}/files?q=x&fields=files`, 100],
		["changes.list", "GET", `${DRIVE_API}/changes?pageToken=1`, 100],
		["the start of the changes", "GET", `${DRIVE_API}/changes/startPageToken?fields=startPageToken`, 100],
		["a folder made", "POST", `${DRIVE_API}/files?fields=id`, 50],
		["a file put in the trash", "PATCH", `${DRIVE_API}/files/abc?fields=id`, 50],
		["an upload", "POST", `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, 50],
		["the content sent to an upload session", "PUT", `${DRIVE_UPLOAD}/files?uploadType=resumable&upload_id=x`, 100],
	])("%s costs its units", (_name, method, url, units) => {
		expect(driveUnits(method, url)).toBe(units);
	});
});

describe("the quota of the device", () => {
	test("the burst goes at once, and the rest at the rate of a minute", () => {
		const quota = new DriveQuota();
		const downloads = DRIVE_UNITS_BURST / 200;
		for (let i = 0; i < downloads; i++) expect(quota.take(200, 0)).toBe(0);
		// One more waits for its own units at the rate.
		expect(quota.take(200, 0)).toBe(Math.ceil((200 * 60_000) / DRIVE_UNITS_PER_MINUTE));
	});

	test("no minute uses more than the rate and the burst together", () => {
		const quota = new DriveQuota();
		// As many downloads as are let through, sent the moment they may be.
		let now = 0;
		let used = 0;
		while (now < 60_000) {
			now += quota.take(200, now);
			if (now < 60_000) used += 200;
		}
		expect(used).toBeLessThanOrEqual(DRIVE_UNITS_PER_MINUTE + DRIVE_UNITS_BURST);
		expect(used).toBeGreaterThan(DRIVE_UNITS_PER_MINUTE);
	});

	test("after a while without requests the burst is there again", () => {
		const quota = new DriveQuota(600, 400);
		quota.take(400, 0);
		expect(quota.take(100, 0)).toBe(10_000);
		expect(quota.take(400, 200_000)).toBe(0);
	});

	test("a clock set back does not hold the requests back", () => {
		const quota = new DriveQuota(600, 400);
		quota.take(400, 10_000_000);
		expect(quota.take(100, 0)).toBe(0);
	});
});

describe("the end of the day of Google's quotas", () => {
	const hour = 3_600_000;

	test.each<[string, number, number]>([
		["in summer time, 16:00 in Japan", Date.UTC(2026, 9, 17, 1, 0), Date.UTC(2026, 9, 17, 7, 0)],
		["in winter time, 17:00 in Japan", Date.UTC(2026, 11, 1, 1, 0), Date.UTC(2026, 11, 1, 8, 0)],
		["at midnight itself, the next one", Date.UTC(2026, 9, 17, 7, 0), Date.UTC(2026, 9, 18, 7, 0)],
		["the night before summer time ends", Date.UTC(2026, 10, 1, 5, 0), Date.UTC(2026, 10, 1, 7, 0)],
		["the day summer time ends", Date.UTC(2026, 10, 1, 8, 0), Date.UTC(2026, 10, 2, 8, 0)],
		["the night before summer time starts", Date.UTC(2026, 2, 8, 7, 0), Date.UTC(2026, 2, 8, 8, 0)],
		["the day summer time starts", Date.UTC(2026, 2, 8, 9, 0), Date.UTC(2026, 2, 9, 7, 0)],
		["across the end of a year", Date.UTC(2026, 11, 31, 20, 0), Date.UTC(2027, 0, 1, 8, 0)],
	])("%s", (_name, now, midnight) => {
		expect(nextPacificMidnight(now)).toBe(midnight);
	});

	test("is midnight in Los Angeles by the time-zone data, within a day, through two years", () => {
		const format = new Intl.DateTimeFormat("en-US", {
			timeZone: "America/Los_Angeles",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		for (let now = Date.UTC(2026, 0, 1); now < Date.UTC(2028, 0, 1); now += 7 * hour + 13 * 60_000) {
			const midnight = nextPacificMidnight(now);
			expect(format.format(midnight)).toBe("00:00");
			expect(midnight).toBeGreaterThan(now);
			expect(midnight - now).toBeLessThanOrEqual(25 * hour);
		}
	});
});
