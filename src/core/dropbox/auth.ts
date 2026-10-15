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

// Connecting to Dropbox by OAuth 2 with PKCE (R-4): no secret, no server of
// the developer's. The browser opens Dropbox, the user allows, and Dropbox
// sends the browser back to `obsidian://sync-evo-dropbox`, with a code that
// is exchanged here for a refresh token.

import { BackendError } from "../backend";
import type { HttpFunction, HttpResponse } from "../github/http";
import type { AccessTokens, DropboxClient } from "./client";

/** The key of the Dropbox app of Sync Evo. Not a secret: PKCE needs none. */
export const DROPBOX_APP_KEY = "7b2xy2rvu78tuq1";
/** The action of `obsidian://<action>` that Dropbox sends the browser back to. Registered with the app. */
export const DROPBOX_REDIRECT_ACTION = "sync-evo-dropbox";
export const DROPBOX_REDIRECT_URI = `obsidian://${DROPBOX_REDIRECT_ACTION}`;

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";
/** An access token is taken again when it has less than this left. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * What a sign-in is checked and finished with. Made before the user presses
 * "Connect", since iOS opens the browser only right after a tap, and made
 * anew for each press.
 */
export interface SignIn {
	/** The PKCE verifier, sent with the code. */
	readonly verifier: string;
	/** Sent to Dropbox and back, to tell this sign-in from any other. */
	readonly state: string;
	/** The page of Dropbox the browser opens. */
	readonly url: string;
}

/** `random(n)` answers `n` random bytes (`crypto.getRandomValues`). */
export async function newSignIn(random: (length: number) => Uint8Array): Promise<SignIn> {
	const verifier = base64Url(random(32));
	const state = base64Url(random(16));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const params = new URLSearchParams({
		client_id: DROPBOX_APP_KEY,
		response_type: "code",
		code_challenge: base64Url(new Uint8Array(digest)),
		code_challenge_method: "S256",
		token_access_type: "offline",
		redirect_uri: DROPBOX_REDIRECT_URI,
		state,
	});
	return { verifier, state, url: `${AUTHORIZE_URL}?${params.toString()}` };
}

/** What a sign-in is finished with, kept on the device while the browser is out. */
export interface PendingSignIn {
	readonly verifier: string;
	readonly state: string;
	/** When the browser was opened, in milliseconds since the epoch. */
	readonly at: number;
}

/**
 * How a return from the browser (`obsidian://sync-evo-dropbox?…`) ended.
 *
 * - "connected": the code was exchanged, and the account is known.
 * - "denied": the user pressed "Cancel" on Dropbox.
 * - "not-waited": no sign-in waits, or another one than this return is of:
 *   an older press of "Connect", or one made in another vault, which the
 *   return came to since `obsidian://` without a vault goes to the vault
 *   that is open. Nothing was exchanged.
 * - "failed": Dropbox or the network would not finish it.
 */
export type SignInResult =
	| { readonly status: "connected"; readonly grant: Grant; readonly account: DropboxAccount }
	| { readonly status: "denied" }
	| { readonly status: "not-waited" }
	| { readonly status: "failed"; readonly error: unknown };

/**
 * Finishes a sign-in with what the browser brought back, if it is the one
 * that waits. `account` asks Dropbox whose the tokens are.
 */
export async function finishSignIn(
	params: { readonly [key: string]: string | undefined },
	pending: PendingSignIn | null,
	exchange: (sign: { readonly code: string; readonly verifier: string }) => Promise<Grant>,
	account: (grant: Grant) => Promise<DropboxAccount>,
): Promise<SignInResult> {
	if (pending === null || params.state !== pending.state) return { status: "not-waited" };
	if (params.error === "access_denied") return { status: "denied" };
	const code = params.code;
	if (code === undefined || code === "") {
		return { status: "failed", error: new BackendError("other", `sign in: ${params.error ?? "no code"}`) };
	}
	try {
		const grant = await exchange({ code, verifier: pending.verifier });
		return { status: "connected", grant, account: await account(grant) };
	} catch (error) {
		return { status: "failed", error };
	}
}

/** What a finished sign-in gives. */
export interface Grant {
	readonly refreshToken: string;
	readonly accessToken: string;
	/** When the access token ends, in milliseconds since the epoch. */
	readonly expiresAt: number;
	readonly accountId: string;
}

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

async function post(http: HttpFunction, what: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
	let response: HttpResponse;
	try {
		response = await http({
			url: TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
	} catch (error) {
		throw new BackendError("unreachable", `${what}: the request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const json = jsonOf(response);
	if (response.status === 200) return json;
	// A code or a refresh token Dropbox no longer takes: expired, used, or revoked.
	if (response.status === 400 && json.error === "invalid_grant") {
		throw new BackendError("unauthorized", `${what}: invalid_grant`, 400);
	}
	const kind = response.status >= 500 ? "unreachable" : response.status === 401 ? "unauthorized" : "other";
	throw new BackendError(kind, `${what}: HTTP ${response.status} ${typeof json.error === "string" ? json.error : ""}`.trim(), response.status);
}

/** Exchanges the code Dropbox sent back for the tokens. */
export async function exchangeCode(
	http: HttpFunction,
	now: () => number,
	sign: { readonly code: string; readonly verifier: string },
): Promise<Grant> {
	const what = "exchange the code";
	const json = await post(http, what, {
		code: sign.code,
		grant_type: "authorization_code",
		client_id: DROPBOX_APP_KEY,
		code_verifier: sign.verifier,
		redirect_uri: DROPBOX_REDIRECT_URI,
	});
	const { access_token, refresh_token, expires_in, account_id } = json;
	if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number" || typeof account_id !== "string") {
		throw new BackendError("other", `${what}: the response is not in the expected form`);
	}
	return { refreshToken: refresh_token, accessToken: access_token, expiresAt: now() + expires_in * 1000, accountId: account_id };
}

/**
 * Access tokens taken from a refresh token, kept in memory while they last.
 * A refresh token Dropbox no longer takes (the app was disconnected on
 * Dropbox's side) fails with "unauthorized": the user connects again.
 */
export class RefreshingTokens implements AccessTokens {
	private current: { readonly token: string; readonly expiresAt: number } | null;
	private pending: Promise<string> | null = null;

	constructor(
		private readonly http: HttpFunction,
		private readonly now: () => number,
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
		const json = await post(this.http, what, {
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
			client_id: DROPBOX_APP_KEY,
		});
		const { access_token, expires_in } = json;
		if (typeof access_token !== "string" || typeof expires_in !== "number") {
			throw new BackendError("other", `${what}: the response is not in the expected form`);
		}
		this.current = { token: access_token, expiresAt: this.now() + expires_in * 1000 };
		return access_token;
	}
}

/**
 * Ends the tokens on Dropbox's side (`auth/token/revoke`): the refresh token
 * with the access token it gave. A token Dropbox no longer takes is ended
 * already, which is no failure: so the token given has to be one just taken
 * from the refresh token (`RefreshingTokens` without an initial token), or
 * one that expired would read as ended and leave the refresh token alive.
 */
export async function revokeToken(http: HttpFunction, accessToken: string): Promise<void> {
	const what = "revoke the token";
	let response: HttpResponse;
	try {
		// A call that takes no argument is sent one of JSON `null`: a POST
		// without a body goes out with a type of content Dropbox turns down.
		response = await http({
			url: REVOKE_URL,
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body: "null",
		});
	} catch (error) {
		throw new BackendError("unreachable", `${what}: the request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (response.status === 200 || response.status === 401) return;
	const detail = new TextDecoder().decode(response.body).slice(0, 200);
	throw new BackendError(response.status >= 500 ? "unreachable" : "other", `${what}: HTTP ${response.status} ${detail}`.trim(), response.status);
}

/** The account the tokens are of, for the settings to show. */
export interface DropboxAccount {
	readonly accountId: string;
	readonly email: string;
}

export async function currentAccount(client: Pick<DropboxClient, "rpc">): Promise<DropboxAccount> {
	const json = await client.rpc("users/get_current_account", null);
	if (!isRecord(json) || typeof json.account_id !== "string" || typeof json.email !== "string") {
		throw new BackendError("other", "get the account: the response is not in the expected form");
	}
	return { accountId: json.account_id, email: json.email };
}
