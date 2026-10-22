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
import type { HttpRequest, HttpResponse } from "../../src/core/http";
import {
	activateKey,
	activationName,
	checkLicense,
	DODO_API,
	DODO_LIVE_API,
	DODO_TEST_API,
	deactivateKey,
	isSyncEvoKey,
	LICENSE_CHECK_MS,
	LICENSE_GRACE_MS,
	LICENSE_RETRY_MS,
	licenseCheckDue,
	licenseCounts,
	licenseStanding,
	parseLicense,
	type StoredLicense,
	validateKey,
} from "../src/core/license";

function response(status: number, body: unknown = {}): HttpResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return { status, headers: {}, body: new TextEncoder().encode(text).buffer };
}

/** An HTTP function that answers from a list, in order, and keeps the requests. */
function scripted(...answers: (HttpResponse | Error)[]) {
	const requests: HttpRequest[] = [];
	const http = async (request: HttpRequest): Promise<HttpResponse> => {
		requests.push(request);
		const answer = answers.shift();
		if (answer === undefined) throw new Error("no answer left");
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { http, requests };
}

const body = (request: HttpRequest | undefined): unknown => JSON.parse(String(request?.body));

const ACTIVATED = {
	id: "lki_1",
	business_id: "bus_syncevo",
	name: "iPhone",
	license_key_id: "lic_1",
	created_at: "2027-01-01T00:00:00Z",
	product: { product_id: "pdt_year", name: "Sync Evo, a year" },
	customer: { customer_id: "cus_1", name: "A", email: "a@example.com" },
};
const ours = (activation: { businessId: string; productId: string | null }): boolean =>
	isSyncEvoKey(activation, "bus_syncevo", ["pdt_month", "pdt_year", "pdt_once"]);

describe("the calls to Dodo", () => {
	test("this build asks the live mode; a test build asks the test mode", () => {
		expect(DODO_API).toBe(DODO_LIVE_API);
		expect(DODO_TEST_API).toBe("https://test.dodopayments.com");
	});

	test("an activation sends the key and the name of the device alone, and is answered with whose key it is", async () => {
		const { http, requests } = scripted(response(201, ACTIVATED));
		expect(await activateKey(http, DODO_TEST_API, "KEY", "iPhone")).toEqual({
			status: "activated",
			instanceId: "lki_1",
			businessId: "bus_syncevo",
			productId: "pdt_year",
		});
		expect(requests[0]?.url).toBe("https://test.dodopayments.com/licenses/activate");
		expect(requests[0]?.method).toBe("POST");
		expect(body(requests[0])).toEqual({ license_key: "KEY", name: "iPhone" });
		// No key of the seller's: the calls are public.
		expect(Object.keys(requests[0]?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("authorization");
	});

	test.each([
		[404, "NOT_FOUND", "refused"],
		[403, "INACTIVE_LICENSE_KEY", "refused"],
		[422, "LICENSE_KEY_LIMIT_REACHED", "refused"],
		// A request Dodo could not read is not about the key: a name too long, or none.
		[400, "INVALID_REQUEST_PARAMETERS", "unreachable"],
		[422, "INVALID_REQUEST_BODY", "unreachable"],
		[404, "X", "unreachable"],
		[429, "LICENSE_KEY_LIMIT_REACHED", "unreachable"],
		[429, "X", "unreachable"],
		[500, "X", "unreachable"],
		[503, "X", "unreachable"],
	])("an activation answered with %i %s is %s", async (status, code, expected) => {
		const { http } = scripted(response(status, { code, message: "m" }));
		expect((await activateKey(http, DODO_LIVE_API, "KEY", "Mac")).status).toBe(expected);
	});

	test("an activation answered with a 4xx without Dodo's code is unreachable: it comes from in front of Dodo", async () => {
		const blocked = await activateKey(scripted(response(403, "<html>Cloudflare</html>")).http, DODO_LIVE_API, "KEY", "Mac");
		expect(blocked).toEqual({ status: "unreachable", detail: "HTTP 403" });
		expect((await activateKey(scripted(response(404, { message: "m" })).http, DODO_LIVE_API, "KEY", "Mac")).status).toBe("unreachable");
	});

	test("the name of an activation is trimmed, cut to 255 characters by code point, and Sync Evo when empty", async () => {
		const { http, requests } = scripted(response(500), response(500), response(500));
		await activateKey(http, DODO_LIVE_API, "KEY", ` ${"a".repeat(254)}😀😀 `);
		await activateKey(http, DODO_LIVE_API, "KEY", "  ");
		await activateKey(http, DODO_LIVE_API, "KEY", "");
		const names = requests.map((request) => (body(request) as { name: string }).name);
		expect(names[0]).toBe(`${"a".repeat(254)}😀`);
		expect(Array.from(names[0] ?? "")).toHaveLength(255);
		expect(names.slice(1)).toEqual(["Sync Evo", "Sync Evo"]);
		expect(activationName(" iPhone ")).toBe("iPhone");
	});

	test("an activation that gets no answer is unreachable, and so is one in a form not expected", async () => {
		expect((await activateKey(scripted(new Error("offline")).http, DODO_LIVE_API, "KEY", "Mac")).status).toBe("unreachable");
		expect((await activateKey(scripted(response(201, { id: 1 })).http, DODO_LIVE_API, "KEY", "Mac")).status).toBe("unreachable");
	});

	test("a validation asks for the activation of this device", async () => {
		const { http, requests } = scripted(response(200, { valid: true }), response(200, { valid: false }), response(500), new Error("offline"));
		expect(await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toEqual({ status: "valid" });
		expect(requests[0]?.url).toBe("https://live.dodopayments.com/licenses/validate");
		expect(body(requests[0])).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
		expect((await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).status).toBe("invalid");
		expect((await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).status).toBe("unreachable");
		expect((await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).status).toBe("unreachable");
	});

	test("a validation answered with a 4xx is unreachable: only valid: false says the key is not valid", async () => {
		const { http } = scripted(
			response(404, { code: "NOT_FOUND" }),
			response(422, { code: "INVALID_REQUEST_BODY" }),
			response(403, "<html>Cloudflare</html>"),
			response(429),
		);
		expect(await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toEqual({ status: "unreachable", detail: "HTTP 404 NOT_FOUND" });
		expect(await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toEqual({ status: "unreachable", detail: "HTTP 422 INVALID_REQUEST_BODY" });
		expect(await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toEqual({ status: "unreachable", detail: "HTTP 403" });
		expect((await validateKey(http, DODO_LIVE_API, "KEY", "lki_1")).status).toBe("unreachable");
	});

	test("a deactivation names the activation, and tells whether Dodo heard of it", async () => {
		const { http, requests } = scripted(response(200, ""), new Error("offline"));
		expect(await deactivateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toBe(true);
		expect(requests[0]?.url).toBe("https://live.dodopayments.com/licenses/deactivate");
		expect(body(requests[0])).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
		expect(await deactivateKey(http, DODO_LIVE_API, "KEY", "lki_1")).toBe(false);
	});
});

describe("a key of Sync Evo", () => {
	test("is of its business and of one of its products", () => {
		expect(ours({ businessId: "bus_syncevo", productId: "pdt_once" })).toBe(true);
		expect(ours({ businessId: "bus_other", productId: "pdt_once" })).toBe(false);
		expect(ours({ businessId: "bus_syncevo", productId: "pdt_other" })).toBe(false);
		expect(ours({ businessId: "bus_syncevo", productId: null })).toBe(false);
	});

	test("is none while the business is not set, as in this version", () => {
		expect(isSyncEvoKey({ businessId: "", productId: "" }, "", [""])).toBe(false);
		expect(isSyncEvoKey({ businessId: "bus_syncevo", productId: "pdt_year" })).toBe(false);
	});
});

describe("asking Dodo about the key of this device", () => {
	const fresh: StoredLicense = { key: "KEY", instanceId: null, state: "unchecked", validAt: null, checkedAt: null };

	test("a key without an activation is activated, and counts from then", async () => {
		const { http } = scripted(response(201, ACTIVATED));
		const { license } = await checkLicense(http, DODO_LIVE_API, fresh, "iPhone", 1000, ours);
		expect(license).toEqual({ key: "KEY", instanceId: "lki_1", state: "valid", validAt: 1000, checkedAt: 1000 });
	});

	test("a key that another seller sold on Dodo is not taken, and its activation is let go of", async () => {
		const { http, requests } = scripted(response(201, { ...ACTIVATED, business_id: "bus_other" }), response(200, ""));
		const { license, detail } = await checkLicense(http, DODO_LIVE_API, fresh, "iPhone", 1000, ours);
		expect(license).toMatchObject({ state: "invalid", instanceId: null, validAt: null });
		expect(detail).toBe("not a key of Sync Evo");
		expect(requests[1]?.url).toBe("https://live.dodopayments.com/licenses/deactivate");
		expect(body(requests[1])).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
	});

	test("an activation Dodo refuses is invalid; one that gets no answer is tried again later", async () => {
		const refused = await checkLicense(scripted(response(422, { code: "LICENSE_KEY_LIMIT_REACHED" })).http, DODO_LIVE_API, fresh, "Mac", 5, ours);
		expect(refused.license).toMatchObject({ state: "invalid", checkedAt: 5 });
		expect(refused.detail).toBe("HTTP 422 LICENSE_KEY_LIMIT_REACHED");
		const away = await checkLicense(scripted(new Error("offline")).http, DODO_LIVE_API, fresh, "Mac", 5, ours);
		expect(away.license).toMatchObject({ state: "unreachable", instanceId: null, checkedAt: 5 });
	});

	test("a key with an activation is validated with it: valid, invalid, or not answered", async () => {
		const active: StoredLicense = { key: "KEY", instanceId: "lki_1", state: "valid", validAt: 0, checkedAt: 0 };
		const { http, requests } = scripted(response(200, { valid: true }), response(200, { valid: false }), response(502));
		expect((await checkLicense(http, DODO_LIVE_API, active, "Mac", 9, ours)).license).toEqual({ ...active, validAt: 9, checkedAt: 9 });
		expect(body(requests[0])).toEqual({ license_key: "KEY", license_key_instance_id: "lki_1" });
		expect((await checkLicense(http, DODO_LIVE_API, active, "Mac", 9, ours)).license).toEqual({ ...active, state: "invalid", checkedAt: 9 });
		// The last time it was valid stays: the time of grace runs from it.
		expect((await checkLicense(http, DODO_LIVE_API, active, "Mac", 9, ours)).license).toEqual({ ...active, state: "unreachable", checkedAt: 9 });
	});
});

describe("how the key stands", () => {
	const stored = (over: Partial<StoredLicense>): StoredLicense => ({
		key: "KEY",
		instanceId: "lki_1",
		state: "valid",
		validAt: 0,
		checkedAt: 0,
		...over,
	});

	test("no key, or one Dodo said is valid, or turned down", () => {
		expect(licenseStanding(null, 0)).toEqual({ status: "none" });
		expect(licenseStanding(stored({}), 10 * LICENSE_GRACE_MS)).toEqual({ status: "valid" });
		expect(licenseStanding(stored({ state: "invalid" }), 0)).toEqual({ status: "invalid" });
	});

	test("while Dodo cannot be reached, it counts for 14 days from the last time it was valid, and not after", () => {
		const away = stored({ state: "unreachable", validAt: 1000 });
		expect(licenseStanding(away, 1000 + LICENSE_GRACE_MS - 1)).toEqual({ status: "grace", since: 1000, until: 1000 + LICENSE_GRACE_MS });
		expect(licenseStanding(away, 1000 + LICENSE_GRACE_MS)).toEqual({ status: "unconfirmed" });
		// Never valid: nothing to run from.
		expect(licenseStanding(stored({ state: "unreachable", validAt: null, instanceId: null }), 0)).toEqual({ status: "unconfirmed" });
	});

	test("counts while valid and in its grace, and not otherwise", () => {
		expect(licenseCounts({ status: "valid" })).toBe(true);
		expect(licenseCounts({ status: "grace", since: 0, until: 1 })).toBe(true);
		expect(licenseCounts({ status: "unconfirmed" })).toBe(false);
		expect(licenseCounts({ status: "invalid" })).toBe(false);
		expect(licenseCounts({ status: "none" })).toBe(false);
	});

	test("is asked about once a day, and an hour after Dodo could not be reached", () => {
		expect(licenseCheckDue(null, 0)).toBe(false);
		expect(licenseCheckDue(stored({ checkedAt: null }), 0)).toBe(true);
		expect(licenseCheckDue(stored({ checkedAt: 0 }), LICENSE_CHECK_MS - 1)).toBe(false);
		expect(licenseCheckDue(stored({ checkedAt: 0 }), LICENSE_CHECK_MS)).toBe(true);
		// Dodo no longer validates the activation (refunded, cancelled, on hold): asked again daily.
		expect(licenseCheckDue(stored({ checkedAt: 0, state: "invalid" }), LICENSE_CHECK_MS)).toBe(true);
		// The activation was refused (another seller's, at its limit, not active): not until it is entered again.
		expect(licenseCheckDue(stored({ checkedAt: 0, state: "invalid", instanceId: null }), 100 * LICENSE_CHECK_MS)).toBe(false);
		expect(licenseCheckDue(stored({ checkedAt: 0, state: "unreachable" }), LICENSE_RETRY_MS)).toBe(true);
		expect(licenseCheckDue(stored({ checkedAt: 0, state: "unreachable" }), LICENSE_RETRY_MS - 1)).toBe(false);
	});

	test("what was stored is read back, and anything else is no key", () => {
		expect(parseLicense(stored({}))).toEqual(stored({}));
		expect(parseLicense({ key: "KEY", state: "odd", validAt: "x" })).toEqual({
			key: "KEY",
			instanceId: null,
			state: "unchecked",
			validAt: null,
			checkedAt: null,
		});
		expect(parseLicense({ key: "" })).toBeNull();
		expect(parseLicense("KEY")).toBeNull();
		expect(parseLicense(null)).toBeNull();
	});
});
