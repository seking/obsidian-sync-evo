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

// The license key of the paid plan (T082), sold through Dodo Payments, and
// what this device remembers of it. Dodo's three calls for a key are public
// and take no key of the seller's (checked 2026-10-17 in its API reference):
//
// - `POST /licenses/activate` {license_key, name}: one activation of the
//   key, named after the device, answered with its id (`lki_…`), the
//   business and the product the key was sold for.
// - `POST /licenses/validate` {license_key, license_key_instance_id}:
//   answered with `{valid}` alone.
// - `POST /licenses/deactivate` {license_key, license_key_instance_id}.
//
// They are one place for every seller on Dodo, and say nothing of whose a
// key is: validated alone, a key another seller sold would pass. So a key
// is taken only once its activation names the business and a product of
// Sync Evo (`isSyncEvoKey`); after that it is validated together with the
// id of that activation, which no key of another seller has.
//
// What is sent is the key and the name of the device, nothing else.

import type { HttpFunction, HttpResponse } from "../../../src/core/http";

/** Where Dodo answers for the keys that were sold. */
export const DODO_LIVE_API = "https://live.dodopayments.com";
/** Where Dodo answers for the keys of its test mode, for a build made to try the plan out. */
export const DODO_TEST_API = "https://test.dodopayments.com";

/**
 * Put in by esbuild at build time (`define` in esbuild.config.mjs): true for
 * a build made with `SYNC_EVO_DODO_TEST=1`, which asks Dodo's test mode, for
 * keys bought with its test cards. A development build only: a production
 * build fails with it. Not defined in the tests.
 */
declare const SYNC_EVO_DODO_TEST: boolean | undefined;

/** Whether this build asks Dodo's test mode (`SYNC_EVO_DODO_TEST`). */
export const DODO_TEST_BUILD = typeof SYNC_EVO_DODO_TEST === "boolean" && SYNC_EVO_DODO_TEST;

/** Where this build asks Dodo. */
export const DODO_API = DODO_TEST_BUILD ? DODO_TEST_API : DODO_LIVE_API;

/**
 * The business of Sync Evo (GYAP) on Dodo, in its live mode, as Dodo's
 * business settings show it (2026-10-22). The same id as in the test mode.
 */
export const DODO_LIVE_BUSINESS_ID = "bus_0NpvnyuwMvGA62iaE3swK";
/**
 * The business of Sync Evo in Dodo's test mode, as the activation of a key
 * bought there named it (2026-10-18).
 */
export const DODO_TEST_BUSINESS_ID = "bus_0NpvnyuwMvGA62iaE3swK";
/**
 * The products a key of Sync Evo is sold with in the live mode, as the
 * text of Dodo's products page shows them (2026-10-22).
 */
export const DODO_LIVE_PRODUCT_IDS: readonly string[] = [
	// Once for good, $49.
	"pdt_0Npwfs17O6R4lOSY7Q87z",
	// A year, $24.
	"pdt_0NpwfisGtlvF694AZIydR",
	// A month, $3.
	"pdt_0NpwfWybRvpHYSN0loBu3",
];
/** The same products in Dodo's test mode, for keys bought with its test cards. */
export const DODO_TEST_PRODUCT_IDS: readonly string[] = [
	// A month, $3.
	"pdt_0Npwh87MDEp2ht2V7jhr0",
	// A year, $24.
	"pdt_0NpwhEUoEH4OTB9qkQ059",
	// Once for good, $49.
	"pdt_0Npwh30QNmPXpnekbEE6B",
];
/** The business of Sync Evo in the mode this build asks. */
export const DODO_BUSINESS_ID = DODO_TEST_BUILD ? DODO_TEST_BUSINESS_ID : DODO_LIVE_BUSINESS_ID;
/** The products of a key of Sync Evo: by the month, by the year, and once for good, in the mode this build asks. */
export const DODO_PRODUCT_IDS: readonly string[] = DODO_TEST_BUILD ? DODO_TEST_PRODUCT_IDS : DODO_LIVE_PRODUCT_IDS;
/**
 * The page a key is bought on, shown on a desktop only: the prices on
 * gyap.jp, which link to Dodo's checkout, so that a price or a link can
 * change without a release.
 */
export const PURCHASE_URL = "https://gyap.jp/sync-evo/#pricing";
/** Where the settings send the user for the details, on every device. */
export const README_URL = "https://github.com/seking/obsidian-sync-evo#readme";

/** How long a key counts after Dodo last said it is valid, while Dodo cannot be reached. */
export const LICENSE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/** How often a key that counts is asked about again. */
export const LICENSE_CHECK_MS = 24 * 60 * 60 * 1000;
/** How soon a key is asked about again after Dodo could not be reached. */
export const LICENSE_RETRY_MS = 60 * 60 * 1000;

/** What Dodo answered to an activation. */
export type Activation =
	| {
			readonly status: "activated";
			readonly instanceId: string;
			readonly businessId: string;
			readonly productId: string | null;
	  }
	/** The key is not one Dodo takes: unknown, not active, or at its limit of activations. */
	| { readonly status: "refused"; readonly detail: string }
	| { readonly status: "unreachable"; readonly detail: string };

/** What Dodo answered to a validation. */
export type Validation =
	| { readonly status: "valid" }
	| { readonly status: "invalid"; readonly detail: string }
	| { readonly status: "unreachable"; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonOf(response: HttpResponse): Record<string, unknown> {
	try {
		const json: unknown = JSON.parse(new TextDecoder().decode(response.body));
		return isRecord(json) ? json : {};
	} catch {
		return {};
	}
}

type Sent = { readonly response: HttpResponse } | { readonly unreachable: string };

async function post(http: HttpFunction, api: string, path: string, body: Record<string, string>): Promise<Sent> {
	try {
		const response = await http({
			url: `${api}${path}`,
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		return { response };
	} catch (error) {
		return { unreachable: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Whether Dodo turned the activation down, as against not answering for it:
 * a status of 4xx but 429, which asks for a wait, with Dodo's `code` in a
 * JSON body (NOT_FOUND, INACTIVE_LICENSE_KEY, LICENSE_KEY_LIMIT_REACHED). A
 * 4xx without it comes from in front of Dodo, such as Cloudflare's blocks,
 * and a 5xx is Dodo's own trouble: the key is not held against the user for
 * either.
 */
function refusal(response: HttpResponse): boolean {
	const { status } = response;
	return status >= 400 && status < 500 && status !== 429 && typeof jsonOf(response).code === "string";
}

/** The status and Dodo's `code`, for the log: never the key. */
function detailOf(response: HttpResponse): string {
	const code = jsonOf(response).code;
	return `HTTP ${response.status}${typeof code === "string" ? ` ${code}` : ""}`;
}

/** Activates the key for this device, under `name`. */
export async function activateKey(http: HttpFunction, api: string, key: string, name: string): Promise<Activation> {
	const sent = await post(http, api, "/licenses/activate", { license_key: key, name });
	if ("unreachable" in sent) return { status: "unreachable", detail: sent.unreachable };
	const { response } = sent;
	if (response.status === 200 || response.status === 201) {
		const json = jsonOf(response);
		const product = json.product;
		const productId = isRecord(product) && typeof product.product_id === "string" ? product.product_id : null;
		if (typeof json.id !== "string" || typeof json.business_id !== "string") {
			return { status: "unreachable", detail: "activate: the response is not in the expected form" };
		}
		return { status: "activated", instanceId: json.id, businessId: json.business_id, productId };
	}
	if (refusal(response)) return { status: "refused", detail: detailOf(response) };
	return { status: "unreachable", detail: detailOf(response) };
}

/**
 * Asks whether the key, in the activation of this device, is still valid.
 * Only `valid: false` makes it "invalid"; any other answer is "unreachable".
 */
export async function validateKey(http: HttpFunction, api: string, key: string, instanceId: string): Promise<Validation> {
	const sent = await post(http, api, "/licenses/validate", { license_key: key, license_key_instance_id: instanceId });
	if ("unreachable" in sent) return { status: "unreachable", detail: sent.unreachable };
	const { response } = sent;
	if (response.status === 200) {
		const valid = jsonOf(response).valid;
		if (valid === true) return { status: "valid" };
		if (valid === false) return { status: "invalid", detail: "valid: false" };
		return { status: "unreachable", detail: "validate: the response is not in the expected form" };
	}
	// Dodo answers 200 with `valid: false` for a key it does not validate,
	// and a 4xx only for a request it cannot read: no 4xx says the key is bad.
	return { status: "unreachable", detail: detailOf(response) };
}

/**
 * Ends the activation of this device, so that it no longer counts against
 * the activations the key allows. Whether Dodo heard of it is answered,
 * and only for the log: the key leaves the device either way.
 */
export async function deactivateKey(http: HttpFunction, api: string, key: string, instanceId: string): Promise<boolean> {
	const sent = await post(http, api, "/licenses/deactivate", { license_key: key, license_key_instance_id: instanceId });
	return "response" in sent && sent.response.status >= 200 && sent.response.status < 300;
}

/**
 * Whether an activation is of a key Sync Evo sold: of its business, and of
 * one of its products. Nothing is, while those are not set.
 */
export function isSyncEvoKey(
	activation: { readonly businessId: string; readonly productId: string | null },
	businessId: string = DODO_BUSINESS_ID,
	productIds: readonly string[] = DODO_PRODUCT_IDS,
): boolean {
	if (businessId === "" || activation.businessId !== businessId) return false;
	return activation.productId !== null && productIds.includes(activation.productId);
}

/**
 * What this device remembers of its key. Kept apart from the settings and
 * the vault: one for the device, whichever vault it is entered in, and
 * never in `data.json` (S-4).
 *
 * - `instanceId`: the activation of this device, or `null` while Dodo
 *   could not be reached to make one.
 * - `state`: what Dodo last answered. "unchecked" before it was asked.
 * - `validAt`: when Dodo last said the key is valid, or `null` for never.
 * - `checkedAt`: when Dodo was last asked, or `null` for never.
 */
export interface StoredLicense {
	readonly key: string;
	readonly instanceId: string | null;
	readonly state: "valid" | "invalid" | "unreachable" | "unchecked";
	readonly validAt: number | null;
	readonly checkedAt: number | null;
}

/** Reads what was stored, or `null` for nothing usable. */
export function parseLicense(raw: unknown): StoredLicense | null {
	if (!isRecord(raw) || typeof raw.key !== "string" || raw.key === "") return null;
	const state = raw.state === "valid" || raw.state === "invalid" || raw.state === "unreachable" ? raw.state : "unchecked";
	const time = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
	return {
		key: raw.key,
		instanceId: typeof raw.instanceId === "string" && raw.instanceId !== "" ? raw.instanceId : null,
		state,
		validAt: time(raw.validAt),
		checkedAt: time(raw.checkedAt),
	};
}

/**
 * How the key of this device stands, for the settings screen.
 *
 * - "none": no key is entered.
 * - "valid": Dodo said so the last time it was asked.
 * - "grace": Dodo could not be reached since it last said so, which was
 *   less than `LICENSE_GRACE_MS` ago: it counts until `until`.
 * - "unconfirmed": Dodo has not said so yet, or not within that time.
 * - "invalid": Dodo turned it down, or it is not a key of Sync Evo. Why is
 *   not told apart (expired, refunded, cancelled, another seller's).
 */
export type LicenseStanding =
	| { readonly status: "none" }
	| { readonly status: "valid" }
	| { readonly status: "grace"; readonly since: number; readonly until: number }
	| { readonly status: "unconfirmed" }
	| { readonly status: "invalid" };

export function licenseStanding(stored: StoredLicense | null, now: number): LicenseStanding {
	if (stored === null) return { status: "none" };
	if (stored.state === "invalid") return { status: "invalid" };
	if (stored.state === "valid") return { status: "valid" };
	if (stored.validAt !== null && now - stored.validAt < LICENSE_GRACE_MS) {
		return { status: "grace", since: stored.validAt, until: stored.validAt + LICENSE_GRACE_MS };
	}
	return { status: "unconfirmed" };
}

/** Whether the key lets this device sync with Dropbox and Google Drive after the free time. */
export function licenseCounts(standing: LicenseStanding): boolean {
	return standing.status === "valid" || standing.status === "grace";
}

/**
 * Whether Dodo is to be asked about the key now. Not a key whose activation
 * was refused (another seller's, at its limit, not active): it stays so
 * until it is entered again. A key Dodo no longer validates is asked about
 * once a day: a subscription that was on hold comes back.
 */
export function licenseCheckDue(stored: StoredLicense | null, now: number): boolean {
	if (stored === null) return false;
	if (stored.state === "invalid" && stored.instanceId === null) return false;
	if (stored.checkedAt === null) return true;
	const wait = stored.state === "unreachable" || stored.state === "unchecked" ? LICENSE_RETRY_MS : LICENSE_CHECK_MS;
	return now - stored.checkedAt >= wait;
}

/**
 * Asks Dodo about the key, and answers what to remember of it: an
 * activation for a key that has none yet, a validation of the one it has
 * otherwise. `name` names the device in an activation. Never rejects.
 */
export async function checkLicense(
	http: HttpFunction,
	api: string,
	stored: StoredLicense,
	name: string,
	now: number,
	sold: (activation: { readonly businessId: string; readonly productId: string | null }) => boolean = isSyncEvoKey,
): Promise<{ readonly license: StoredLicense; readonly detail: string | null }> {
	if (stored.instanceId === null) {
		const activation = await activateKey(http, api, stored.key, name);
		if (activation.status === "unreachable") {
			return { license: { ...stored, state: "unreachable", checkedAt: now }, detail: activation.detail };
		}
		if (activation.status === "refused") return { license: { ...stored, state: "invalid", checkedAt: now }, detail: activation.detail };
		if (!sold(activation)) {
			// A key Dodo sold for another seller. Its activation is let go
			// of again, so that it costs its owner none of theirs.
			await deactivateKey(http, api, stored.key, activation.instanceId);
			return { license: { ...stored, state: "invalid", checkedAt: now }, detail: "not a key of Sync Evo" };
		}
		return { license: { ...stored, instanceId: activation.instanceId, state: "valid", validAt: now, checkedAt: now }, detail: null };
	}
	const validation = await validateKey(http, api, stored.key, stored.instanceId);
	switch (validation.status) {
		case "valid":
			return { license: { ...stored, state: "valid", validAt: now, checkedAt: now }, detail: null };
		case "invalid":
			return { license: { ...stored, state: "invalid", checkedAt: now }, detail: validation.detail };
		case "unreachable":
			return { license: { ...stored, state: "unreachable", checkedAt: now }, detail: validation.detail };
	}
}
