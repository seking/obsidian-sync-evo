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
import { translatorFor } from "../../src/core/i18n";
import {
	DODO_BUSINESS_ID,
	DODO_LIVE_BUSINESS_ID,
	DODO_LIVE_PRODUCT_IDS,
	DODO_PRODUCT_IDS,
	DODO_TEST_BUILD,
	DODO_TEST_PRODUCT_IDS,
	PURCHASE_URL,
} from "../src/core/license";
import {
	addMonths,
	DAY_MS,
	dueWarning,
	type PaidFacts,
	countStart,
	freeUntil,
	PAID_ENABLED_AT,
	RELEASE_PAID_ENABLED_AT,
	PAID_CLOCK_OFFSET_DAYS,
	paidNoteText,
	paidStanding,
	paidStatusLines,
	type PaidStanding,
	type PaidSyncMode,
	paidVerdict,
	paidWarningText,
} from "../src/core/paid";

const at = (iso: string): number => Date.parse(iso);

describe("the switch", () => {
	test("is off in this version: nothing of the plan is decided or shown", () => {
		expect(RELEASE_PAID_ENABLED_AT).toBeNull();
		// The tests are no build to try the plan out: the release's day, and the live mode.
		expect(PAID_ENABLED_AT).toBe(RELEASE_PAID_ENABLED_AT);
		expect(DODO_TEST_BUILD).toBe(false);
		expect(DODO_PRODUCT_IDS).toBe(DODO_LIVE_PRODUCT_IDS);
		expect(DODO_BUSINESS_ID).toBe(DODO_LIVE_BUSINESS_ID);
		expect(PAID_CLOCK_OFFSET_DAYS).toBe(0);
	});

	test("is switched on for a release only with the live business, products and page of the key in place", () => {
		// Fails the version that sets the day while these are placeholders:
		// no key would be taken, and no page to buy one would be shown. The
		// values of the test mode do not count.
		if (RELEASE_PAID_ENABLED_AT === null) return;
		expect(DODO_LIVE_BUSINESS_ID).not.toBe("");
		expect(DODO_LIVE_PRODUCT_IDS.length).toBeGreaterThan(0);
		expect(PURCHASE_URL).toMatch(/^https:\/\//);
	});

	test("the products of the two modes are ids of Dodo's form, and none of them is in both", () => {
		for (const id of [...DODO_LIVE_PRODUCT_IDS, ...DODO_TEST_PRODUCT_IDS]) expect(id).toMatch(/^pdt_[A-Za-z0-9]{21}$/);
		expect(DODO_LIVE_PRODUCT_IDS.filter((id) => DODO_TEST_PRODUCT_IDS.includes(id))).toEqual([]);
		expect(new Set(DODO_LIVE_PRODUCT_IDS).size).toBe(3);
		expect(new Set(DODO_TEST_PRODUCT_IDS).size).toBe(3);
	});
});

describe("three months", () => {
	test("end on the same day of the month, at the same time", () => {
		expect(addMonths(at("2026-10-17T05:00:00Z"), 3)).toBe(at("2027-01-17T05:00:00Z"));
	});

	test("end on the last day of a month that has no such day", () => {
		expect(addMonths(at("2026-11-30T00:00:00Z"), 3)).toBe(at("2027-02-28T00:00:00Z"));
		expect(addMonths(at("2027-11-30T00:00:00Z"), 3)).toBe(at("2028-02-29T00:00:00Z"));
	});
});

describe("the end of the free time", () => {
	const enabledAt = at("2027-03-01T00:00:00Z");

	test("is three months after the account began to sync, when that was after the switch", () => {
		expect(countStart(at("2027-04-01T00:00:00Z"), enabledAt)).toBe(at("2027-04-01T00:00:00Z"));
		expect(freeUntil(at("2027-04-01T00:00:00Z"), enabledAt)).toBe(at("2027-07-01T00:00:00Z"));
	});

	test("is three months after the switch, for an account that began to sync before it, however long before", () => {
		for (const since of ["2026-10-17T00:00:00Z", "2027-02-28T23:59:59Z", "2027-03-01T00:00:00Z"]) {
			expect(countStart(at(since), enabledAt)).toBe(enabledAt);
			expect(freeUntil(at(since), enabledAt)).toBe(at("2027-06-01T00:00:00Z"));
		}
	});
});

describe("where a device stands", () => {
	const enabledAt = at("2027-01-01T00:00:00Z");
	const since = at("2027-01-10T00:00:00Z");
	const end = at("2027-04-10T00:00:00Z");
	const facts = (over: Partial<PaidFacts>): PaidFacts => ({
		enabledAt,
		backend: "dropbox",
		ownClient: false,
		licensed: false,
		since,
		now: since,
		...over,
	});

	test("nothing applies while the switch is off, whatever else", () => {
		expect(paidStanding(facts({ enabledAt: null, now: end + 100 * DAY_MS }))).toEqual({ status: "free" });
	});

	test("nothing applies to GitHub, to a key that counts, nor to Google Drive through a client of the user's own", () => {
		const late = end + 100 * DAY_MS;
		expect(paidStanding(facts({ backend: "github", now: late }))).toEqual({ status: "free" });
		expect(paidStanding(facts({ licensed: true, now: late }))).toEqual({ status: "free" });
		expect(paidStanding(facts({ backend: "gdrive", ownClient: true, now: late }))).toEqual({ status: "free" });
		// The client is Google's alone: with Dropbox it changes nothing.
		expect(paidStanding(facts({ backend: "dropbox", ownClient: true, now: late })).status).toBe("stopped");
	});

	test("free until the end, with the end unknown while the start of the count is", () => {
		expect(paidStanding(facts({ since: null, now: end + 100 * DAY_MS }))).toEqual({ status: "trial", endsAt: null });
		expect(paidStanding(facts({ now: end - 1 }))).toEqual({ status: "trial", endsAt: end });
	});

	test("downloads only from the end, for 30 days, and then nothing", () => {
		const stopsAt = end + 30 * DAY_MS;
		expect(paidStanding(facts({ now: end }))).toEqual({ status: "read-only", endedAt: end, stopsAt });
		expect(paidStanding(facts({ now: stopsAt - 1 }))).toEqual({ status: "read-only", endedAt: end, stopsAt });
		expect(paidStanding(facts({ now: stopsAt }))).toEqual({ status: "stopped", endedAt: end });
	});
});

describe("what a sync is let do", () => {
	const modes: PaidSyncMode[] = ["sync", "pull", "push", "first-fetch", "untrack"];
	const readOnly: PaidStanding = { status: "read-only", endedAt: 0, stopsAt: 1 };

	test("everything, while free", () => {
		for (const mode of modes) {
			expect(paidVerdict(mode, { status: "free" })).toEqual({ mode, note: null });
			expect(paidVerdict(mode, { status: "trial", endsAt: null })).toEqual({ mode, note: null });
		}
	});

	test("after the free time: a sync is a download, a download stays one, and what sends does not start", () => {
		expect(paidVerdict("sync", readOnly)).toEqual({ mode: "pull", note: "read-only" });
		expect(paidVerdict("pull", readOnly)).toEqual({ mode: "pull", note: "read-only" });
		expect(paidVerdict("first-fetch", readOnly)).toEqual({ mode: "first-fetch", note: "read-only" });
		expect(paidVerdict("push", readOnly)).toEqual({ mode: null, note: "read-only" });
		expect(paidVerdict("untrack", readOnly)).toEqual({ mode: null, note: "read-only" });
	});

	test("nothing, once the time for downloads is over too", () => {
		for (const mode of modes) expect(paidVerdict(mode, { status: "stopped", endedAt: 0 })).toEqual({ mode: null, note: "stopped" });
	});
});

describe("the warnings before the end", () => {
	const endsAt = at("2027-04-10T00:00:00Z");
	const trial: PaidStanding = { status: "trial", endsAt };

	test("14 days before, and then 7, each once", () => {
		expect(dueWarning(trial, null, endsAt - 15 * DAY_MS)).toBeNull();
		expect(dueWarning(trial, null, endsAt - 14 * DAY_MS)).toBe(14);
		expect(dueWarning(trial, 14, endsAt - 10 * DAY_MS)).toBeNull();
		expect(dueWarning(trial, 14, endsAt - 7 * DAY_MS)).toBe(7);
		expect(dueWarning(trial, 7, endsAt - 1)).toBeNull();
	});

	test("only the nearest, for a device that was not used through the first", () => {
		expect(dueWarning(trial, null, endsAt - 3 * DAY_MS)).toBe(7);
	});

	test("none without a known end, after it, or while free", () => {
		expect(dueWarning({ status: "trial", endsAt: null }, null, 0)).toBeNull();
		expect(dueWarning({ status: "read-only", endedAt: endsAt, stopsAt: endsAt + 1 }, null, endsAt)).toBeNull();
		expect(dueWarning({ status: "free" }, null, endsAt)).toBeNull();
	});
});

describe.each(["en", "ja"])("the texts in %s", (language) => {
	const t = translatorFor(language, "Dropbox");
	const endedAt = new Date(2027, 3, 10).getTime();
	const readOnly: PaidStanding = { status: "read-only", endedAt, stopsAt: new Date(2027, 4, 10).getTime() };

	test("the warning counts the days that are left, and not the time it belongs to", () => {
		const trial: PaidStanding = { status: "trial", endsAt: endedAt };
		expect(paidWarningText(t, trial, endedAt - 11.4 * DAY_MS)).toContain("12");
		expect(paidWarningText(t, trial, endedAt - 11.4 * DAY_MS)).not.toContain("14");
		expect(paidWarningText(t, trial, endedAt - 7 * DAY_MS)).toContain("7");
		expect(paidWarningText(t, trial, endedAt - 60 * 60 * 1000)).toContain("1");
	});

	test("each case has its own, with its dates and no placeholder left", () => {
		const texts = [
			paidNoteText(t, { mode: "pull", note: "read-only" }, readOnly),
			paidNoteText(t, { mode: null, note: "read-only" }, readOnly),
			paidNoteText(t, { mode: null, note: "stopped" }, { status: "stopped", endedAt }),
			paidWarningText(t, { status: "trial", endsAt: endedAt }, endedAt - 7 * DAY_MS),
		];
		expect(new Set(texts).size).toBe(texts.length);
		for (const text of texts) {
			expect(text).not.toBeNull();
			expect(text).not.toMatch(/[{}]/);
			expect(text).toContain("2027-04-10");
			expect(text).toContain("Dropbox");
		}
		expect(texts[0]).toContain("2027-05-10");
	});

	test("nothing is said while free", () => {
		expect(paidNoteText(t, { mode: "sync", note: null }, { status: "free" })).toBeNull();
		expect(paidNoteText(t, { mode: "sync", note: null }, { status: "trial", endsAt: endedAt })).toBeNull();
	});

	test("the settings say where the device stands, and of the key", () => {
		const lines = (over: Partial<Parameters<typeof paidStatusLines>[1]>): string[] =>
			paidStatusLines(t, { standing: { status: "free" }, license: { status: "none" }, key: "", ownClient: false, ...over });
		expect(lines({ ownClient: true, standing: readOnly })).toEqual([t("settings.license.ownClient")]);
		expect(lines({ license: { status: "valid" } })).toEqual([t("settings.license.valid")]);
		expect(lines({ standing: { status: "trial", endsAt: null } })).toEqual([t("settings.license.trialUnknown")]);
		const invalid = lines({ license: { status: "invalid" }, standing: readOnly });
		expect(invalid).toEqual([t("settings.license.invalid"), t("settings.license.readOnly", { ended: "2027-04-10", stops: "2027-05-10" })]);
		const grace = lines({ license: { status: "grace", since: endedAt, until: endedAt + 14 * DAY_MS } });
		expect(grace[0]).toContain("2027-04-10");
		expect(grace[0]).toContain("2027-04-24");
		for (const line of [...invalid, ...grace]) expect(line).not.toMatch(/[{}]/);
		// A build to try the plan out says that its clock is ahead.
		const ahead = lines({ clockOffsetDays: 130 });
		expect(ahead).toHaveLength(1);
		expect(ahead[0]).toContain("+130");
		expect(lines({ clockOffsetDays: 0 })).toEqual([]);
	});
});
