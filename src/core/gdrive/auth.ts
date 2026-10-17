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

// Connecting to Google Drive by the OAuth device flow (R-1): no server of
// the developer's, and no way back to Obsidian is needed. Sync Evo asks
// Google for a code, the user types it at google.com/device and allows, and
// Sync Evo asks Google, every few seconds, whether that was done.

import { BackendError } from "../backend";
import type { AccessTokens } from "../dropbox/client";
import type { HttpFunction, HttpResponse, Sleep } from "../github/http";
import { GoogleClientSecretMissingError } from "./errors";

/** An OAuth client of Google: the author's, which every user shares (R-1). */
export interface GoogleClient {
	readonly id: string;
	/**
	 * Google does not treat the secret of an installed app as a secret. A
	 * client of the kind "TVs and limited input devices" gets no token
	 * without it (checked 2026-10-17). Empty when the build left it out
	 * (`SYNC_EVO_GOOGLE_CLIENT`): nothing is asked of Google then. None for
	 * a client of the user's own, which is asked without one.
	 */
	readonly secret?: string;
}

/**
 * Put in by esbuild at build time (`define` in esbuild.config.mjs), from the
 * environment or a file outside the repository. Not defined in the tests.
 */
declare const SYNC_EVO_GOOGLE_CLIENT_SECRET: string | undefined;

/**
 * The client of Sync Evo, registered by the author with Google and used by
 * every user. Never to be changed: what a client made on Drive is seen by
 * that client alone (`drive.file`), so another one would see none of it (R-1).
 *
 * The id is in the source; the secret is not. Google's OAuth 2.0 Policies
 * ask that client credentials not be committed to a public repository, while
 * the secret of an installed app ships inside the app, where it is no secret
 * (Google's guide to installed apps says as much). So it is put into main.js
 * when the release is built, and a build without it fails before asking
 * Google (`GoogleClientSecretMissingError`).
 */
export const SYNC_EVO_GOOGLE_CLIENT: GoogleClient = {
	id: "257282127930-2itpbl1oi6n2954l4j5hhhp0jgnm57h1.apps.googleusercontent.com",
	secret: typeof SYNC_EVO_GOOGLE_CLIENT_SECRET === "string" ? SYNC_EVO_GOOGLE_CLIENT_SECRET : "",
};

/**
 * The client to use for the client id the settings hold: the one of Sync
 * Evo when they hold none, which is always for now. The settings keep room
 * for a client of the user's own (R-1); such a client brings no secret here.
 */
export function googleClientOf(clientId: string | undefined): GoogleClient {
	return clientId === undefined || clientId === SYNC_EVO_GOOGLE_CLIENT.id ? SYNC_EVO_GOOGLE_CLIENT : { id: clientId };
}

/** Throws when the client needs a secret this build does not have. */
export function assertClientSecret(client: GoogleClient): void {
	if (client.secret === "") throw new GoogleClientSecretMissingError();
}

/** The one scope Sync Evo asks for: the files it made itself (R-1). */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Where the user types the code. Opened right at the press, before the code is known (R-1). */
export const DEVICE_VERIFICATION_URL = "https://www.google.com/device";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** An access token is taken again when it has less than this left. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** What Google asks for when it names no interval. */
const DEFAULT_INTERVAL_MS = 5000;
/** How much longer to wait between two asks when Google says to slow down. */
const SLOW_DOWN_MS = 5000;

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

function detailOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function postForm(http: HttpFunction, url: string, what: string, fields: Record<string, string>): Promise<HttpResponse> {
	try {
		return await http({
			url,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
	} catch (error) {
		throw new BackendError("unreachable", `${what}: the request failed: ${detailOf(error)}`);
	}
}

function clientFields(client: GoogleClient): Record<string, string> {
	return client.secret === undefined ? { client_id: client.id } : { client_id: client.id, client_secret: client.secret };
}

/** A failure of the token endpoint, by its status and its `error`. */
function tokenFailure(what: string, response: HttpResponse, json: Record<string, unknown>): BackendError {
	const error = typeof json.error === "string" ? json.error : "";
	// A refresh token Google no longer takes: revoked, or ended (seven days
	// while the consent screen is in testing).
	if (error === "invalid_grant") return new BackendError("unauthorized", `${what}: invalid_grant`, response.status);
	const kind = response.status >= 500 ? "unreachable" : response.status === 401 ? "unauthorized" : "other";
	return new BackendError(kind, `${what}: HTTP ${response.status} ${error}`.trim(), response.status);
}

/** The code the user types at google.com/device, and what Sync Evo asks with. */
export interface DeviceCode {
	/** What Sync Evo asks Google with. Never shown. */
	readonly deviceCode: string;
	/** What the user types. */
	readonly userCode: string;
	/** Where the user types it, as Google names it. */
	readonly verificationUrl: string;
	/** When the code ends, in milliseconds since the epoch. */
	readonly expiresAt: number;
	/** How long to wait between two asks, in milliseconds. */
	readonly intervalMs: number;
}

/** Asks Google for a code for the user to type. */
export async function requestDeviceCode(http: HttpFunction, now: () => number, client: GoogleClient): Promise<DeviceCode> {
	const what = "ask for a code";
	// Before the code: without the secret, the code could never be used.
	assertClientSecret(client);
	const response = await postForm(http, DEVICE_CODE_URL, what, { client_id: client.id, scope: DRIVE_SCOPE });
	const json = jsonOf(response);
	if (response.status !== 200) throw tokenFailure(what, response, json);
	const { device_code, user_code, verification_url, expires_in, interval } = json;
	if (typeof device_code !== "string" || typeof user_code !== "string" || typeof expires_in !== "number") {
		throw new BackendError("other", `${what}: the response is not in the expected form`);
	}
	return {
		deviceCode: device_code,
		userCode: user_code,
		verificationUrl: typeof verification_url === "string" ? verification_url : DEVICE_VERIFICATION_URL,
		expiresAt: now() + expires_in * 1000,
		intervalMs: typeof interval === "number" && interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_MS,
	};
}

/** What a finished sign-in gives. */
export interface GoogleGrant {
	readonly refreshToken: string;
	readonly accessToken: string;
	/** When the access token ends, in milliseconds since the epoch. */
	readonly expiresAt: number;
}

/**
 * How the wait for the user ended.
 *
 * - "connected": the user allowed, and the tokens are here.
 * - "denied": the user pressed "Cancel" at Google.
 * - "expired": the code ended before the user allowed.
 * - "cancelled": the wait was stopped on this device.
 */
export type DeviceWait =
	| { readonly status: "connected"; readonly grant: GoogleGrant }
	| { readonly status: "denied" }
	| { readonly status: "expired" }
	| { readonly status: "cancelled" };

/**
 * Asks Google, at the interval it named, whether the user has allowed, until
 * that is answered or the code ends. A request that gets no answer is asked
 * again at the next turn: a phone drops the network while the user is in
 * the browser. Any other failure is thrown.
 */
export async function waitForDeviceGrant(
	http: HttpFunction,
	now: () => number,
	sleep: Sleep,
	client: GoogleClient,
	code: DeviceCode,
	signal?: AbortSignal,
): Promise<DeviceWait> {
	const what = "wait for the user to allow";
	assertClientSecret(client);
	let interval = code.intervalMs;
	const stopped = (): boolean => signal?.aborted === true;
	for (;;) {
		if (stopped()) return { status: "cancelled" };
		await sleepUnlessAborted(sleep, interval, signal);
		if (stopped()) return { status: "cancelled" };
		if (now() >= code.expiresAt) return { status: "expired" };
		let response: HttpResponse;
		try {
			response = await postForm(http, TOKEN_URL, what, {
				...clientFields(client),
				device_code: code.deviceCode,
				grant_type: DEVICE_GRANT,
			});
		} catch {
			continue;
		}
		const json = jsonOf(response);
		if (response.status === 200) return { status: "connected", grant: grantOf(what, now, json) };
		switch (json.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				interval += SLOW_DOWN_MS;
				continue;
			case "access_denied":
				return { status: "denied" };
			case "expired_token":
				return { status: "expired" };
			default:
				if (response.status >= 500) continue;
				throw tokenFailure(what, response, json);
		}
	}
}

/** Sleeps, and comes back at once when `signal` aborts: a sleep that was aborted may never end. */
async function sleepUnlessAborted(sleep: Sleep, ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return sleep(ms);
	const timer = new AbortController();
	let onAbort = (): void => {};
	const aborted = new Promise<void>((resolve) => {
		onAbort = resolve;
		signal.addEventListener("abort", onAbort);
	});
	try {
		await Promise.race([sleep(ms, timer.signal), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		timer.abort();
	}
}

function grantOf(what: string, now: () => number, json: Record<string, unknown>): GoogleGrant {
	const { access_token, refresh_token, expires_in } = json;
	if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number") {
		throw new BackendError("other", `${what}: the response is not in the expected form`);
	}
	return { refreshToken: refresh_token, accessToken: access_token, expiresAt: now() + expires_in * 1000 };
}

/**
 * Access tokens taken from a refresh token, kept in memory while they last
 * (an hour). A refresh token Google no longer takes fails with
 * "unauthorized": the user connects again.
 */
export class GoogleTokens implements AccessTokens {
	private current: { readonly token: string; readonly expiresAt: number } | null;
	private pending: Promise<string> | null = null;

	constructor(
		private readonly http: HttpFunction,
		private readonly now: () => number,
		private readonly client: GoogleClient,
		private readonly refreshToken: string,
		initial?: { readonly accessToken: string; readonly expiresAt: number },
	) {
		this.current = initial === undefined ? null : { token: initial.accessToken, expiresAt: initial.expiresAt };
	}

	get(): Promise<string> {
		const current = this.current;
		if (current !== null && current.expiresAt - this.now() > RENEW_BEFORE_MS) return Promise.resolve(current.token);
		// Requests that need a token at the same moment share one renewal.
		this.pending ??= this.renew().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	refused(token: string): void {
		if (this.current?.token === token) this.current = null;
	}

	private async renew(): Promise<string> {
		const what = "renew the access token";
		assertClientSecret(this.client);
		const response = await postForm(this.http, TOKEN_URL, what, {
			...clientFields(this.client),
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
		});
		const json = jsonOf(response);
		if (response.status !== 200) throw tokenFailure(what, response, json);
		const { access_token, expires_in } = json;
		if (typeof access_token !== "string" || typeof expires_in !== "number") {
			throw new BackendError("other", `${what}: the response is not in the expected form`);
		}
		this.current = { token: access_token, expiresAt: this.now() + expires_in * 1000 };
		return access_token;
	}
}

/**
 * Ends the grant on Google's side, with the refresh token: the access
 * tokens taken from it end with it. A token Google no longer knows is ended
 * already, which is no failure.
 */
export async function revokeGoogleToken(http: HttpFunction, refreshToken: string): Promise<void> {
	const what = "revoke the token";
	const response = await postForm(http, REVOKE_URL, what, { token: refreshToken });
	if (response.status === 200) return;
	const json = jsonOf(response);
	if (response.status === 400 && json.error === "invalid_token") return;
	throw new BackendError(response.status >= 500 ? "unreachable" : "other", `${what}: HTTP ${response.status} ${typeof json.error === "string" ? json.error : ""}`.trim(), response.status);
}

/** The account the tokens are of, for the settings to show and to tell accounts apart. */
export interface DriveAccount {
	/** Google's `permissionId` of the user: the same for the account on every device. */
	readonly accountId: string;
	readonly email: string;
}

/** Asks Drive whose the tokens are (`about.get`). `drive.file` is enough for it (checked 2026-10-17). */
export async function currentDriveAccount(client: { getJson(url: string): Promise<unknown> }): Promise<DriveAccount> {
	const json = await client.getJson("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress%2CpermissionId)");
	const user = isRecord(json) ? json.user : undefined;
	if (!isRecord(user) || typeof user.permissionId !== "string" || typeof user.emailAddress !== "string") {
		throw new BackendError("other", "get the account: the response is not in the expected form");
	}
	return { accountId: user.permissionId, email: user.emailAddress };
}
