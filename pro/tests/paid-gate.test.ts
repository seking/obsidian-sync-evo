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
import { NO_DEVICE_EXCLUSION } from "../../src/core/device-exclusion";
import type { HttpRequest, HttpResponse } from "../../src/core/http";
import { DODO_LIVE_API } from "../src/core/license";
import { DAY_MS, freeUntil, type PaidSyncMode } from "../src/core/paid";
import { FIRST_SEEN_KEY, LICENSE_KEY, PaidGate, type PaidStorage, SINCE_KEY, TOLD_KEY } from "../src/core/paid-gate";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../../src/core/settings";

function response(status: number, body: unknown = {}): HttpResponse {
	return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)).buffer };
}

/** A storage in memory, which counts its writes. */
function memoryStorage(): PaidStorage & { values: Map<string, unknown>; writes: number } {
	const values = new Map<string, unknown>();
	const storage = {
		values,
		writes: 0,
		read: (key: string) => values.get(key) ?? null,
		write: (key: string, value: unknown) => {
			storage.writes += 1;
			if (value === null) values.delete(key);
			else values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
		},
	};
	return storage;
}

const ENABLED = Date.parse("2027-01-01T00:00:00Z");
const SINCE = Date.parse("2027-01-10T00:00:00Z");
const END = freeUntil(SINCE, ENABLED);

function settings(over: Partial<DeviceSettings> = {}): DeviceSettings {
	return {
		backend: "dropbox",
		repository: "",
		branch: "main",
		tokenSecret: "",
		dropboxFolder: "Vault",
		dropboxAccount: { id: "dbid:1", email: "a@example.com" },
		gdriveFolder: "",
		gdriveAccount: null,
		gdriveFolderId: null,
		deviceName: "iPhone",
		autoSync: DEFAULT_AUTO_SYNC,
		onConflict: "merge",
		deviceExclusion: NO_DEVICE_EXCLUSION,
		exclusionChangeTold: true,
		...over,
	};
}

/**
 * A gate on a device in memory. `firstSeen`: when the device first ran the
 * plan, the day of the switch unless given, or `null` for a device that never did.
 */
function gate(options: { enabledAt?: number | null; now?: number; answers?: HttpResponse[]; firstSeen?: number | null } = {}) {
	const storage = memoryStorage();
	const enabledAt = options.enabledAt === undefined ? ENABLED : options.enabledAt;
	const firstSeen = options.firstSeen === undefined ? ENABLED : options.firstSeen;
	if (enabledAt !== null && firstSeen !== null) storage.values.set(FIRST_SEEN_KEY, { enabledAt, at: firstSeen });
	const requests: HttpRequest[] = [];
	const answers = [...(options.answers ?? [])];
	const clock = { now: options.now ?? SINCE };
	const made = new PaidGate({
		storage,
		http: async (request) => {
			requests.push(request);
			const answer = answers.shift();
			if (answer === undefined) throw new Error("offline");
			return answer;
		},
		now: () => clock.now,
		enabledAt,
		api: DODO_LIVE_API,
		sold: (activation) => activation.businessId === "bus_syncevo",
	});
	return { gate: made, storage, requests, clock };
}

describe("while the plan is switched off", () => {
	test("every sync does what it was asked, nothing is stored, nothing is asked of Dodo, and nothing is told", () => {
		const { gate: paid, storage, requests } = gate({ enabledAt: null, now: END + 100 * DAY_MS });
		storage.values.set(LICENSE_KEY, { key: "KEY", instanceId: "lki_1", state: "valid", validAt: 0, checkedAt: 0 });
		storage.writes = 0;
		for (const mode of ["sync", "pull", "push", "first-fetch", "untrack"] as PaidSyncMode[]) {
			expect(paid.check(settings(), mode)).toMatchObject({ standing: { status: "free" }, verdict: { mode, note: null }, warning: null });
			expect(paid.check(settings({ backend: "gdrive", gdriveAccount: { id: "p1", email: "a" } }), mode).verdict).toEqual({ mode, note: null });
		}
		expect(paid.sinceWanted(settings())).toBe(false);
		paid.sinceLearned(settings(), SINCE);
		expect(paid.enabled).toBe(false);
		expect(storage.writes).toBe(0);
		expect(requests).toEqual([]);
	});
});

describe("the start of the count", () => {
	test("is wanted until it is known for the account, and is kept per account", () => {
		const { gate: paid, storage } = gate();
		expect(paid.sinceWanted(settings())).toBe(true);
		paid.sinceLearned(settings(), SINCE);
		expect(paid.sinceWanted(settings())).toBe(false);
		expect(paid.sinceWanted(settings({ dropboxAccount: { id: "dbid:2", email: "b" } }))).toBe(true);
		expect(storage.values.get(SINCE_KEY)).toEqual({ "dropbox:dbid:1": SINCE });
	});

	test("keeps the earliest that was said: a folder made again later starts nothing again", () => {
		const { gate: paid, storage } = gate();
		paid.sinceLearned(settings(), SINCE);
		paid.sinceLearned(settings(), SINCE + 50 * DAY_MS);
		expect(storage.values.get(SINCE_KEY)).toEqual({ "dropbox:dbid:1": SINCE });
		paid.sinceLearned(settings(), SINCE - DAY_MS);
		expect(storage.values.get(SINCE_KEY)).toEqual({ "dropbox:dbid:1": SINCE - DAY_MS });
	});

	test("is nothing to learn without an account, nor with GitHub", () => {
		const { gate: paid } = gate();
		expect(paid.sinceWanted(settings({ dropboxAccount: null }))).toBe(false);
		expect(paid.sinceWanted(settings({ backend: "github" }))).toBe(false);
	});
});

describe("a sync", () => {
	test("goes ahead while the start of the count is not known, and while free", () => {
		const { gate: paid, clock } = gate({ now: END + 100 * DAY_MS });
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: "push", note: null });
		paid.sinceLearned(settings(), SINCE);
		clock.now = END - 1;
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: "push", note: null });
	});

	test("only downloads after the free time, and does nothing 30 days later", () => {
		const { gate: paid, clock } = gate();
		paid.sinceLearned(settings(), SINCE);
		clock.now = END;
		expect(paid.check(settings(), "sync").verdict).toEqual({ mode: "pull", note: "read-only" });
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: null, note: "read-only" });
		clock.now = END + 30 * DAY_MS;
		expect(paid.check(settings(), "pull").verdict).toEqual({ mode: null, note: "stopped" });
	});

	test("with Google Drive through a client of the user's own, is never held back", () => {
		const drive = settings({ backend: "gdrive", gdriveAccount: { id: "p1", email: "a" }, gdriveClientId: "own.apps.googleusercontent.com" });
		const { gate: paid, clock } = gate();
		paid.sinceLearned(drive, SINCE);
		clock.now = END + 100 * DAY_MS;
		expect(paid.check(drive, "push").verdict).toEqual({ mode: "push", note: null });
	});

	test("tells of the end 14 and 7 days before, each once, and again for a new start of the count", () => {
		const { gate: paid, clock } = gate();
		paid.sinceLearned(settings(), SINCE);
		clock.now = END - 14 * DAY_MS;
		expect(paid.check(settings(), "sync").warning).toBe(14);
		expect(paid.check(settings(), "sync").warning).toBeNull();
		clock.now = END - 7 * DAY_MS;
		expect(paid.check(settings(), "pull").warning).toBe(7);
		expect(paid.check(settings(), "pull").warning).toBeNull();
		paid.sinceLearned(settings(), SINCE - 2 * DAY_MS);
		expect(paid.check(settings(), "pull").warning).toBe(7);
	});
});

describe("a clock of the plan ahead of the clock (a build to try it out)", () => {
	test("decides the plan, and leaves the key's checks and days of grace to the clock", async () => {
		const storage = memoryStorage();
		const requests: HttpRequest[] = [];
		const now = END - 10 * DAY_MS;
		const paid = new PaidGate({
			storage,
			http: async (request) => {
				requests.push(request);
				throw new Error("offline");
			},
			now: () => now,
			planNow: () => now + 20 * DAY_MS,
			enabledAt: ENABLED,
			api: DODO_LIVE_API,
		});
		paid.sinceLearned(settings(), SINCE);
		expect(paid.check(settings(), "sync").verdict).toEqual({ mode: "pull", note: "read-only" });
		// A key last valid 13 days ago by the clock still counts, though 33 by the plan's.
		storage.values.set(LICENSE_KEY, { key: "KEY", instanceId: "lki_1", state: "unreachable", validAt: now - 13 * DAY_MS, checkedAt: now });
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: "push", note: null });
		expect(paid.licenseStanding()).toMatchObject({ status: "grace", until: now + DAY_MS });
		// Checked an hour ago or not, by the clock: not due.
		expect(requests).toEqual([]);
	});
});

describe("a device that first runs the plan late", () => {
	// Four months after the free time of the account ended.
	const LATE = END + 120 * DAY_MS;

	test("is free for 14 days from that day, told of the end at once, and then downloads only", () => {
		const { gate: paid, storage, clock } = gate({ firstSeen: null, now: LATE });
		paid.sinceLearned(settings(), SINCE);
		const first = paid.check(settings(), "push");
		expect(first).toMatchObject({ standing: { status: "trial", endsAt: LATE + 14 * DAY_MS }, verdict: { mode: "push", note: null }, warning: 14 });
		expect(storage.values.get(FIRST_SEEN_KEY)).toEqual({ enabledAt: ENABLED, at: LATE });
		// The settings show the same end.
		expect(paid.standing(settings())).toEqual({ status: "trial", endsAt: LATE + 14 * DAY_MS });
		clock.now = LATE + 7 * DAY_MS;
		expect(paid.check(settings(), "sync").warning).toBe(7);
		clock.now = LATE + 14 * DAY_MS;
		expect(paid.check(settings(), "sync").verdict).toEqual({ mode: "pull", note: "read-only" });
		clock.now = LATE + 44 * DAY_MS;
		expect(paid.check(settings(), "pull").verdict).toEqual({ mode: null, note: "stopped" });
		expect(storage.values.get(FIRST_SEEN_KEY)).toEqual({ enabledAt: ENABLED, at: LATE });
	});

	test("in time, changes nothing: the end is the account's", () => {
		const { gate: paid, clock } = gate({ firstSeen: null, now: SINCE });
		paid.sinceLearned(settings(), SINCE);
		expect(paid.check(settings(), "sync").standing).toEqual({ status: "trial", endsAt: END });
		clock.now = END;
		expect(paid.check(settings(), "sync").verdict).toEqual({ mode: "pull", note: "read-only" });
	});

	test("goes by a day kept under another day of the switch as by none", () => {
		const { gate: paid, storage } = gate({ firstSeen: null, now: LATE });
		storage.values.set(FIRST_SEEN_KEY, { enabledAt: ENABLED - 30 * DAY_MS, at: ENABLED });
		paid.sinceLearned(settings(), SINCE);
		expect(paid.check(settings(), "sync").standing).toEqual({ status: "trial", endsAt: LATE + 14 * DAY_MS });
		expect(storage.values.get(FIRST_SEEN_KEY)).toEqual({ enabledAt: ENABLED, at: LATE });
	});

	test("keeps the day with a key that counts, so that a key that lapses later gives no new days", () => {
		const { gate: paid, storage, clock } = gate({ firstSeen: null, now: SINCE });
		storage.values.set(LICENSE_KEY, { key: "KEY", instanceId: "lki_1", state: "valid", validAt: SINCE, checkedAt: SINCE });
		paid.sinceLearned(settings(), SINCE);
		expect(paid.check(settings(), "push").standing).toEqual({ status: "free" });
		expect(storage.values.get(FIRST_SEEN_KEY)).toEqual({ enabledAt: ENABLED, at: SINCE });
		storage.values.delete(LICENSE_KEY);
		clock.now = LATE;
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: null, note: "stopped" });
	});

	test("keeps nothing before an account is connected: the settings shown before the login use none of the days", () => {
		const { gate: paid, storage, clock } = gate({ firstSeen: null, now: LATE });
		expect(paid.standing(settings({ dropboxAccount: null }))).toEqual({ status: "trial", endsAt: null });
		expect(paid.check(settings({ dropboxAccount: null }), "sync").standing).toEqual({ status: "trial", endsAt: null });
		expect(storage.values.has(FIRST_SEEN_KEY)).toBe(false);
		clock.now = LATE + 20 * DAY_MS;
		paid.sinceLearned(settings(), SINCE);
		expect(paid.check(settings(), "sync")).toMatchObject({ standing: { status: "trial", endsAt: LATE + 34 * DAY_MS }, warning: 14 });
	});

	test("keeps nothing for GitHub, nor for Google Drive through a client of the user's own", () => {
		const { gate: paid, storage } = gate({ firstSeen: null, now: LATE });
		paid.check(settings({ backend: "github" }), "sync");
		paid.check(settings({ backend: "gdrive", gdriveAccount: { id: "p1", email: "a" }, gdriveClientId: "own.apps.googleusercontent.com" }), "sync");
		expect(storage.values.has(FIRST_SEEN_KEY)).toBe(false);
	});

	test("where nothing can be kept, has no days of its own: a day taken anew at each sync would never end", () => {
		const { gate: paid, storage } = gate({ firstSeen: null, now: LATE });
		paid.sinceLearned(settings(), SINCE);
		// The start of the count is kept, and then nothing more can be written: the day of the device cannot.
		storage.write = () => {};
		expect(paid.check(settings(), "sync").verdict).toEqual({ mode: null, note: "stopped" });
	});

	test("in a build to try the plan out, the clock ahead goes past the 14 days too", () => {
		const tried = (days: number) => {
			const storage = memoryStorage();
			const paid = new PaidGate({
				storage,
				http: () => Promise.reject(new Error("offline")),
				now: () => LATE,
				planNow: () => LATE + days * DAY_MS,
				enabledAt: ENABLED,
				api: DODO_LIVE_API,
			});
			paid.sinceLearned(settings(), SINCE);
			return paid.check(settings(), "sync");
		};
		expect(tried(0)).toMatchObject({ standing: { status: "trial", endsAt: LATE + 14 * DAY_MS }, warning: 14 });
		expect(tried(10)).toMatchObject({ standing: { status: "trial", endsAt: LATE + 14 * DAY_MS }, warning: 7 });
		expect(tried(20).verdict).toEqual({ mode: "pull", note: "read-only" });
		expect(tried(50).verdict).toEqual({ mode: null, note: "stopped" });
	});
});

describe("the license key", () => {
	const ACTIVATED = { id: "lki_1", business_id: "bus_syncevo", product: { product_id: "pdt" } };

	test("is activated as it is entered, under the name of the device, and lets every sync run", async () => {
		const { gate: paid, storage, requests, clock } = gate({ answers: [response(201, ACTIVATED)] });
		paid.sinceLearned(settings(), SINCE);
		clock.now = END + 100 * DAY_MS;
		expect(await paid.setKey("  KEY \n", "iPhone")).toEqual({ status: "valid" });
		expect(JSON.parse(String(requests[0]?.body))).toEqual({ license_key: "KEY", name: "iPhone" });
		expect(storage.values.get(LICENSE_KEY)).toMatchObject({ key: "KEY", instanceId: "lki_1", state: "valid" });
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: "push", note: null });
	});

	test("of another seller is not taken", async () => {
		const { gate: paid } = gate({ answers: [response(201, { ...ACTIVATED, business_id: "bus_other" }), response(200)] });
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "invalid" });
	});

	test("refused on activation, is not asked about again until it is entered again, which asks at once", async () => {
		const { gate: paid, requests, clock } = gate({
			answers: [response(422, { code: "LICENSE_KEY_LIMIT_REACHED" }), response(201, ACTIVATED)],
		});
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "invalid" });
		clock.now += 30 * DAY_MS;
		paid.check(settings(), "sync");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(requests).toHaveLength(1);
		// An activation freed on Dodo, and the same key entered again.
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "valid" });
		expect(requests[1]?.url).toBe("https://live.dodopayments.com/licenses/activate");
	});

	test("entered again while Dodo could not be reached, or no longer validated it, is asked about at once", async () => {
		const { gate: paid, requests } = gate({
			answers: [response(503), response(201, ACTIVATED), response(200, { valid: false }), response(200, { valid: true })],
		});
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "unconfirmed" });
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "valid" });
		// Valid: entering it again asks nothing.
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "valid" });
		expect(requests).toHaveLength(2);
		await paid.checkKey("Mac");
		expect(paid.licenseStanding()).toEqual({ status: "invalid" });
		expect(await paid.setKey(" KEY ", "Mac")).toEqual({ status: "valid" });
		expect(requests[3]?.url).toBe("https://live.dodopayments.com/licenses/validate");
	});

	test("entered again while its validation got no answer, is asked about at once", async () => {
		const { gate: paid, requests } = gate({
			answers: [response(201, ACTIVATED), response(403, "<html>blocked</html>"), response(200, { valid: true })],
		});
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "valid" });
		await paid.checkKey("Mac");
		expect(paid.licenseStanding()).toMatchObject({ status: "grace" });
		expect(await paid.setKey("KEY", "Mac")).toEqual({ status: "valid" });
		expect(requests).toHaveLength(3);
		expect(requests[2]?.url).toBe("https://live.dodopayments.com/licenses/validate");
	});

	test("emptied, ends the activation of this device, and leaves the device", async () => {
		const { gate: paid, storage, requests } = gate({ answers: [response(201, ACTIVATED), response(200)] });
		await paid.setKey("KEY", "Mac");
		expect(await paid.setKey("", "Mac")).toEqual({ status: "none" });
		expect(requests[1]?.url).toBe("https://live.dodopayments.com/licenses/deactivate");
		expect(JSON.parse(String(requests[1]?.body))).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
		expect(storage.values.has(LICENSE_KEY)).toBe(false);
	});

	test("leaves the device also when Dodo cannot be told", async () => {
		const { gate: paid, storage } = gate({ answers: [response(201, ACTIVATED)] });
		await paid.setKey("KEY", "Mac");
		expect(await paid.setKey("", "Mac")).toEqual({ status: "none" });
		expect(storage.values.has(LICENSE_KEY)).toBe(false);
	});

	test("is checked again once a day, behind the sync, which goes by what was known before", async () => {
		const { gate: paid, requests, clock } = gate({ answers: [response(201, ACTIVATED), response(200, { valid: false })] });
		paid.sinceLearned(settings(), SINCE);
		await paid.setKey("KEY", "Mac");
		clock.now = END + 100 * DAY_MS;
		expect(paid.check(settings(), "push").verdict.mode).toBe("push");
		await paid.checkKey("Mac");
		expect(requests).toHaveLength(2);
		expect(JSON.parse(String(requests[1]?.body))).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
		expect(paid.licenseStanding()).toEqual({ status: "invalid" });
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: null, note: "stopped" });
	});

	test("counts for 14 days without an answer from Dodo, from the last time it was valid", async () => {
		const { gate: paid, clock } = gate({ answers: [response(201, ACTIVATED)] });
		paid.sinceLearned(settings(), SINCE);
		clock.now = END + 40 * DAY_MS;
		await paid.setKey("KEY", "Mac");
		const validAt = clock.now;
		clock.now = validAt + 2 * DAY_MS;
		paid.check(settings(), "push");
		await paid.checkKey("Mac");
		expect(paid.licenseStanding()).toEqual({ status: "grace", since: validAt, until: validAt + 14 * DAY_MS });
		expect(paid.check(settings(), "push").verdict.mode).toBe("push");
		clock.now = validAt + 14 * DAY_MS;
		expect(paid.check(settings(), "push").verdict).toEqual({ mode: null, note: "stopped" });
	});

	test("is not asked about for GitHub", () => {
		const { gate: paid, storage, requests } = gate();
		storage.values.set(LICENSE_KEY, { key: "KEY", instanceId: "lki_1", state: "valid", validAt: 0, checkedAt: 0 });
		paid.check(settings({ backend: "github" }), "sync");
		expect(requests).toEqual([]);
		expect(storage.values.has(TOLD_KEY)).toBe(false);
	});
});
