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
import type { HttpRequest, HttpResponse } from "../src/core/github/http";
import { DODO_LIVE_API } from "../src/core/license";
import { DAY_MS, freeUntil, type PaidSyncMode } from "../src/core/paid";
import { LICENSE_KEY, PaidGate, type PaidStorage, SINCE_KEY, TOLD_KEY } from "../src/core/paid-gate";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

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

function gate(options: { enabledAt?: number | null; now?: number; answers?: HttpResponse[] } = {}) {
	const storage = memoryStorage();
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
		enabledAt: options.enabledAt === undefined ? ENABLED : options.enabledAt,
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
			expect(paid.check(settings(), mode)).toEqual({ standing: { status: "free" }, verdict: { mode, note: null }, warning: null });
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
