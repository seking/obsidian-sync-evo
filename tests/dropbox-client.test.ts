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
import {
	currentAccount,
	DROPBOX_APP_KEY,
	DROPBOX_REDIRECT_URI,
	exchangeCode,
	finishSignIn,
	newSignIn,
	RefreshingTokens,
	revokeToken,
} from "../src/core/dropbox/auth";
import { type AccessTokens, DropboxApiError, DropboxClient, headerJson } from "../src/core/dropbox/client";
import type { HttpRequest, HttpResponse } from "../src/core/github/http";

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return { status, headers, body: new TextEncoder().encode(text).buffer };
}

/** An HTTP function that answers from a list, in order, and keeps the requests. */
function scripted(...answers: HttpResponse[]): { http: (request: HttpRequest) => Promise<HttpResponse>; requests: HttpRequest[] } {
	const requests: HttpRequest[] = [];
	return {
		requests,
		http: (request) => {
			requests.push(request);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return Promise.resolve(next);
		},
	};
}

class Tokens implements AccessTokens {
	count = 0;
	readonly refusedTokens: string[] = [];
	get(): Promise<string> {
		return Promise.resolve(`token${this.count}`);
	}
	refused(token: string): void {
		this.refusedTokens.push(token);
		this.count += 1;
	}
}

function client(http: (request: HttpRequest) => Promise<HttpResponse>, tokens = new Tokens(), slept: number[] = []): DropboxClient {
	return new DropboxClient({
		http,
		now: () => 0,
		sleep: (ms) => {
			slept.push(ms);
			return Promise.resolve();
		},
		tokens,
	});
}

function textOf(body: string | ArrayBuffer | undefined): string {
	return typeof body === "string" ? body : body === undefined ? "" : new TextDecoder().decode(body);
}

describe("calls of the Dropbox API", () => {
	test("an RPC call sends JSON with the token and answers the JSON", async () => {
		const { http, requests } = scripted(response(200, { ok: 1 }));
		expect(await client(http).rpc("files/list_folder", { path: "/a" })).toEqual({ ok: 1 });
		expect(requests[0]).toMatchObject({
			url: "https://api.dropboxapi.com/2/files/list_folder",
			method: "POST",
			headers: { Authorization: "Bearer token0", "Content-Type": "application/json" },
			body: '{"path":"/a"}',
		});
	});

	test("an upload sends the bytes, with the argument in a header that holds only ASCII", async () => {
		const { http, requests } = scripted(response(200, { rev: "1" }));
		await client(http).upload({ path: "/日本語.md" }, new TextEncoder().encode("本文"));
		const request = requests[0];
		expect(request?.url).toBe("https://content.dropboxapi.com/2/files/upload");
		expect(request?.headers["Dropbox-API-Arg"]).toBe('{"path":"/\\u65e5\\u672c\\u8a9e.md"}');
		expect(textOf(request?.body)).toBe("本文");
		expect(JSON.parse(request?.headers["Dropbox-API-Arg"] ?? "")).toEqual({ path: "/日本語.md" });
	});

	test("a download answers the bytes and what the header says of them", async () => {
		const { http } = scripted({ ...response(200, "content"), headers: { "Dropbox-API-Result": '{"rev":"r1"}' } });
		const { content, result } = await client(http).download({ path: "rev:r1" }, 7);
		expect(new TextDecoder().decode(content)).toBe("content");
		expect(result).toEqual({ rev: "r1" });
	});

	test("a 409 is an error of the endpoint, by its summary", async () => {
		const { http } = scripted(response(409, { error_summary: "path/conflict/file/..", error: {} }));
		const error = await client(http).rpc("files/upload", {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DropboxApiError);
		expect((error as DropboxApiError).is("path", "conflict")).toBe(true);
		expect((error as DropboxApiError).is("path", "not_found")).toBe(false);
	});

	test("a path that is not there is not-found", async () => {
		const { http } = scripted(response(409, { error_summary: "path/not_found/.." }));
		await expect(client(http).rpc("files/list_folder", {})).rejects.toMatchObject({ kind: "not-found" });
	});

	test("an expired token is taken again once, and the request sent again", async () => {
		const tokens = new Tokens();
		const { http, requests } = scripted(response(401, { error_summary: "expired_access_token/" }), response(200, {}));
		await client(http, tokens).rpc("files/list_folder", {});
		expect(tokens.refusedTokens).toEqual(["token0"]);
		expect(requests[1]?.headers.Authorization).toBe("Bearer token1");
	});

	test("a token refused twice is unauthorized", async () => {
		const { http } = scripted(response(401), response(401));
		await expect(client(http).rpc("files/list_folder", {})).rejects.toMatchObject({ kind: "unauthorized" });
	});

	test("a wait Dropbox asks for is waited out, by its time, and the same request sent again", async () => {
		const slept: number[] = [];
		const { http, requests } = scripted(
			response(429, {}, { "Retry-After": "3" }),
			response(409, { error_summary: "too_many_write_operations/.." }),
			response(200, {}),
		);
		await client(http, new Tokens(), slept).rpc("files/delete_v2", { path: "/a" });
		expect(requests).toHaveLength(3);
		// The second named no time: a second, doubled for the second retry.
		expect(slept.filter((ms) => ms < 60_000)).toEqual([3000, 2000]);
	});

	test("a wait that does not end is rate limited", async () => {
		const answers = Array.from({ length: 10 }, () => response(429, {}, { "Retry-After": "1" }));
		const { http } = scripted(...answers);
		await expect(client(http).rpc("files/delete_v2", {})).rejects.toMatchObject({ kind: "rate-limited" });
	});

	test("a request that fails, or a server error, is unreachable", async () => {
		await expect(client(() => Promise.reject(new Error("offline"))).rpc("x", {})).rejects.toMatchObject({ kind: "unreachable" });
		await expect(client(scripted(response(500)).http).rpc("x", {})).rejects.toMatchObject({ kind: "unreachable" });
	});

	test("nothing is sent once stopped", async () => {
		const controller = new AbortController();
		controller.abort();
		const { http, requests } = scripted(response(200, {}));
		const stopped = new DropboxClient({ http, now: () => 0, sleep: () => Promise.resolve(), tokens: new Tokens(), signal: controller.signal });
		await expect(stopped.rpc("x", {})).rejects.toMatchObject({ kind: "cancelled" });
		expect(requests).toEqual([]);
	});

	test("the JSON of a header escapes all but ASCII", () => {
		expect(headerJson({ path: "/é\u007f~" })).toBe('{"path":"/\\u00e9\\u007f~"}');
	});
});

describe("connecting to Dropbox", () => {
	test("a sign-in opens the page of Dropbox with the PKCE challenge of its verifier, its state and the way back", async () => {
		let n = 0;
		const sign = await newSignIn((length) => new Uint8Array(length).fill(++n));
		const url = new URL(sign.url);
		expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
		const params = Object.fromEntries(url.searchParams);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sign.verifier));
		const challenge = Buffer.from(digest).toString("base64url");
		expect(params).toEqual({
			client_id: DROPBOX_APP_KEY,
			response_type: "code",
			code_challenge: challenge,
			code_challenge_method: "S256",
			token_access_type: "offline",
			redirect_uri: DROPBOX_REDIRECT_URI,
			state: sign.state,
		});
		expect(sign.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sign.state).not.toBe(sign.verifier);
	});

	test("the code is exchanged without a secret, for a refresh token and the account", async () => {
		const { http, requests } = scripted(
			response(200, { access_token: "sl.a", refresh_token: "r", expires_in: 14400, account_id: "dbid:1" }),
		);
		expect(await exchangeCode(http, () => 1000, { code: "c", verifier: "v" })).toEqual({
			refreshToken: "r",
			accessToken: "sl.a",
			expiresAt: 1000 + 14400 * 1000,
			accountId: "dbid:1",
		});
		const fields = Object.fromEntries(new URLSearchParams(textOf(requests[0]?.body)));
		expect(fields).toEqual({
			code: "c",
			grant_type: "authorization_code",
			client_id: DROPBOX_APP_KEY,
			code_verifier: "v",
			redirect_uri: DROPBOX_REDIRECT_URI,
		});
	});

	test("a code Dropbox no longer takes is unauthorized", async () => {
		const { http } = scripted(response(400, { error: "invalid_grant" }));
		await expect(exchangeCode(http, () => 0, { code: "c", verifier: "v" })).rejects.toMatchObject({ kind: "unauthorized" });
	});

	test("access tokens are taken from the refresh token while they last, once for requests at the same moment", async () => {
		let now = 0;
		const { http, requests } = scripted(
			response(200, { access_token: "sl.1", expires_in: 14400 }),
			response(200, { access_token: "sl.2", expires_in: 14400 }),
		);
		const tokens = new RefreshingTokens(http, () => now, "refresh");
		expect(await Promise.all([tokens.get(), tokens.get()])).toEqual(["sl.1", "sl.1"]);
		now = 14400 * 1000 - 60_000;
		expect(await tokens.get()).toBe("sl.2");
		tokens.refused("sl.2");
		await expect(tokens.get()).rejects.toThrow("no more answers");
		expect(Object.fromEntries(new URLSearchParams(textOf(requests[0]?.body)))).toEqual({
			grant_type: "refresh_token",
			refresh_token: "refresh",
			client_id: DROPBOX_APP_KEY,
		});
	});

	test("a refresh token Dropbox no longer takes is unauthorized", async () => {
		const { http } = scripted(response(400, { error: "invalid_grant" }));
		await expect(new RefreshingTokens(http, () => 0, "refresh").get()).rejects.toMatchObject({ kind: "unauthorized" });
	});

	test("a revoked token is ended, also when it was ended already", async () => {
		const { http, requests } = scripted(response(200, "null"), response(401));
		await revokeToken(http, "sl.a");
		await revokeToken(http, "sl.a");
		expect(requests[0]).toMatchObject({ headers: { Authorization: "Bearer sl.a", "Content-Type": "application/json" }, body: "null" });
		await expect(revokeToken(scripted(response(500)).http, "sl.a")).rejects.toMatchObject({ kind: "unreachable" });
	});
});

describe("coming back from Dropbox", () => {
	const pending = { verifier: "v", state: "s", at: 0 };
	const grant = { refreshToken: "r", accessToken: "sl.a", expiresAt: 1, accountId: "dbid:1" };
	const account = { accountId: "dbid:1", email: "a@example.com" };
	const exchanged: { code: string; verifier: string }[] = [];
	const exchange = (sign: { readonly code: string; readonly verifier: string }) => {
		exchanged.push({ ...sign });
		return Promise.resolve(grant);
	};

	test("the sign-in that waits is finished, with the account", async () => {
		exchanged.length = 0;
		expect(await finishSignIn({ code: "c", state: "s" }, pending, exchange, () => Promise.resolve(account))).toEqual({
			status: "connected",
			grant,
			account,
		});
		expect(exchanged).toEqual([{ code: "c", verifier: "v" }]);
	});

	test("a return no sign-in waits for, or another one than waits, exchanges nothing", async () => {
		exchanged.length = 0;
		expect(await finishSignIn({ code: "c", state: "s" }, null, exchange, () => Promise.resolve(account))).toEqual({ status: "not-waited" });
		expect(await finishSignIn({ code: "c", state: "other" }, pending, exchange, () => Promise.resolve(account))).toEqual({ status: "not-waited" });
		expect(exchanged).toEqual([]);
	});

	test("a cancel on Dropbox is told as such; no code, or a failed exchange, fails", async () => {
		const ask = () => Promise.resolve(account);
		expect(await finishSignIn({ error: "access_denied", state: "s" }, pending, exchange, ask)).toEqual({ status: "denied" });
		expect((await finishSignIn({ state: "s" }, pending, exchange, ask)).status).toBe("failed");
		const refused = () => Promise.reject(new Error("invalid_grant"));
		expect((await finishSignIn({ code: "c", state: "s" }, pending, refused, ask)).status).toBe("failed");
	});

	test("the account is asked of Dropbox", async () => {
		const { http, requests } = scripted(response(200, { account_id: "dbid:1", email: "a@example.com" }));
		expect(await currentAccount(client(http))).toEqual(account);
		expect(requests[0]?.url).toBe("https://api.dropboxapi.com/2/users/get_current_account");
		expect(requests[0]?.body).toBe("null");
	});
});
