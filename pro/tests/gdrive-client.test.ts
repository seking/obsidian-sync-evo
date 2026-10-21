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
import { RateLimitedError } from "../../src/core/backend";
import type { AccessTokens } from "../src/core/dropbox/client";
import {
	currentDriveAccount,
	DEVICE_VERIFICATION_URL,
	DRIVE_SCOPE,
	GoogleTokens,
	googleClientOf,
	isOwnClient,
	requestDeviceCode,
	SYNC_EVO_GOOGLE_CLIENT,
	waitForDeviceGrant,
} from "../src/core/gdrive/auth";
import { DriveApiError, DriveClient, MULTIPART_MAX_BYTES } from "../src/core/gdrive/client";
import { DriveDailyLimitError, GoogleClientSecretMissingError } from "../src/core/gdrive/errors";
import { DriveQuota } from "../src/core/gdrive/quota";
import type { HttpRequest, HttpResponse } from "../../src/core/http";

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return { status, headers, body: new TextEncoder().encode(text).buffer };
}

function googleError(status: number, reason: string): HttpResponse {
	return response(status, { error: { code: status, message: reason, errors: [{ reason }] } });
}

/** An HTTP function that answers from a list, in order, and keeps the requests. */
function scripted(...answers: (HttpResponse | Error)[]): { http: (request: HttpRequest) => Promise<HttpResponse>; requests: HttpRequest[] } {
	const requests: HttpRequest[] = [];
	return {
		requests,
		http: (request) => {
			requests.push(request);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
		},
	};
}

class Tokens implements AccessTokens {
	count = 0;
	get(): Promise<string> {
		return Promise.resolve(`token${this.count}`);
	}
	refused(): void {
		this.count += 1;
	}
}

function client(
	http: (request: HttpRequest) => Promise<HttpResponse>,
	slept: number[] = [],
	over: Partial<ConstructorParameters<typeof DriveClient>[0]> = {},
): DriveClient {
	return new DriveClient({
		http,
		now: () => 0,
		sleep: (ms) => {
			slept.push(ms);
			return Promise.resolve();
		},
		tokens: new Tokens(),
		random: () => 0,
		...over,
	});
}

function textOf(body: string | ArrayBuffer | undefined): string {
	return typeof body === "string" ? body : body === undefined ? "" : new TextDecoder().decode(body);
}

function form(request: HttpRequest | undefined): Record<string, string> {
	return Object.fromEntries(new URLSearchParams(textOf(request?.body)));
}

describe("calls of the Drive API", () => {
	test("a GET sends the token and answers the JSON", async () => {
		const { http, requests } = scripted(response(200, { ok: 1 }));
		expect(await client(http).getJson("https://www.googleapis.com/drive/v3/files?q=x")).toEqual({ ok: 1 });
		expect(requests[0]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer token0" } });
	});

	test("an expired token is taken again once", async () => {
		const { http, requests } = scripted(response(401), response(200, { ok: 1 }));
		expect(await client(http).getJson("https://www.googleapis.com/drive/v3/about")).toEqual({ ok: 1 });
		expect(requests.map((request) => request.headers.Authorization)).toEqual(["Bearer token0", "Bearer token1"]);
	});

	test("a rate limit and a failure on Google's side are waited out, longer each time", async () => {
		const slept: number[] = [];
		const { http } = scripted(googleError(403, "userRateLimitExceeded"), response(429), response(503), response(200, { ok: 1 }));
		expect(await client(http, slept).getJson("https://www.googleapis.com/drive/v3/files")).toEqual({ ok: 1 });
		// The race of each request against its timeout sleeps too: only the waits are looked at.
		expect(slept.filter((ms) => ms < 60_000)).toEqual([1000, 2000, 4000]);
	});

	test("each wait gets up to a second more at random", async () => {
		const slept: number[] = [];
		const { http } = scripted(response(429), response(503, {}, { "retry-after": "3" }), response(200, { ok: 1 }));
		await client(http, slept, { random: () => 0.5 }).getJson("https://www.googleapis.com/drive/v3/files");
		expect(slept.filter((ms) => ms < 60_000)).toEqual([1500, 3500]);
	});

	test("each wait is logged with the status, the reason, the wait and the retry, and without the token", async () => {
		const lines: string[] = [];
		const { http } = scripted(googleError(403, "userRateLimitExceeded"), response(503, {}, { "retry-after": "3" }), response(200, { ok: 1 }));
		await client(http, [], { random: () => 0.5, log: (line) => lines.push(line) }).getJson("https://www.googleapis.com/drive/v3/files?q=x");
		expect(lines).toEqual([
			"gdrive: GET /drive/v3/files: HTTP 403 userRateLimitExceeded, waiting 1000 ms and 500 ms at random (retry 1 of 5)",
			"gdrive: GET /drive/v3/files: HTTP 503, waiting 3000 ms and 500 ms at random (retry 2 of 5)",
		]);
		expect(lines.join("\n")).not.toContain("token");
	});

	test("the id of a file is not in a line of the log", async () => {
		const lines: string[] = [];
		const { http } = scripted(response(429), response(200, { ok: 1 }));
		await client(http, [], { log: (line) => lines.push(line) }).getJson("https://www.googleapis.com/drive/v3/files/1AbC-secretId?fields=id");
		expect(lines).toEqual(["gdrive: GET /drive/v3/files/{id}: HTTP 429, waiting 1000 ms and 0 ms at random (retry 1 of 5)"]);
	});

	test("a request that answers with a limit after the sync was stopped writes no line, and ends as cancelled", async () => {
		const lines: string[] = [];
		const controller = new AbortController();
		const http = (): Promise<HttpResponse> => {
			controller.abort();
			return Promise.resolve(response(429));
		};
		const stopped = client(http, [], { signal: controller.signal, log: (line) => lines.push(line) });
		await expect(stopped.getJson("https://www.googleapis.com/drive/v3/files")).rejects.toMatchObject({ kind: "cancelled" });
		expect(lines).toEqual([]);
	});

	test("a wait of five minutes that Google asks for is waited out, with the second at random on top", async () => {
		const slept: number[] = [];
		const { http } = scripted(response(429, {}, { "retry-after": "300" }), response(200, { ok: 1 }));
		expect(await client(http, slept, { random: () => 0.999 }).getJson("https://www.googleapis.com/drive/v3/files")).toEqual({ ok: 1 });
		expect(slept).toContain(300_999);
	});

	test("a wait longer than five minutes is not waited out", async () => {
		const { http, requests } = scripted(response(429, {}, { "retry-after": "301" }));
		await expect(client(http).getJson("https://www.googleapis.com/drive/v3/files")).rejects.toBeInstanceOf(RateLimitedError);
		expect(requests).toHaveLength(1);
	});

	test("the requests of the day having run out is not sent again, and waits until midnight in the Pacific time", async () => {
		const { http, requests } = scripted(googleError(403, "dailyLimitExceeded"));
		// 2026-10-17 10:00 in Japan: 2026-10-16 18:00 in the Pacific summer time.
		const now = Date.UTC(2026, 9, 17, 1, 0);
		const error = await client(http, [], { now: () => now })
			.getJson("https://www.googleapis.com/drive/v3/files")
			.catch((e: unknown) => e);
		expect(requests).toHaveLength(1);
		expect(error).toBeInstanceOf(DriveDailyLimitError);
		expect(error).toBeInstanceOf(RateLimitedError);
		// 16:00 in Japan.
		expect(error).toMatchObject({ kind: "rate-limited", waitUntil: Date.UTC(2026, 9, 17, 7, 0), at: now });
	});

	test("every request waits for its units of the quota of the device, which clients share", async () => {
		const slept: number[] = [];
		// 600 units a minute, 400 at once: 0.1 s a unit.
		const quota = new DriveQuota(600, 400);
		const answers = Array.from({ length: 4 }, () => response(200));
		const { http } = scripted(...answers);
		await client(http, slept, { quota }).download("a");
		await client(http, slept, { quota }).download("b");
		// The third download is 200 units over the burst: 20 s.
		await client(http, slept, { quota }).download("c");
		await client(http, slept, { quota }).getJson("https://www.googleapis.com/drive/v3/files/x?fields=id");
		expect(slept.filter((ms) => ms < 60_000)).toEqual([20_000, 20_500]);
	});

	test("a rate limit that does not end fails as rate limited; another 403 at once, as forbidden", async () => {
		const limited = scripted(...Array.from({ length: 6 }, () => response(429)));
		await expect(client(limited.http).getJson("https://www.googleapis.com/drive/v3/files")).rejects.toBeInstanceOf(RateLimitedError);
		const forbidden = scripted(googleError(403, "insufficientFilePermissions"));
		await expect(client(forbidden.http).getJson("https://www.googleapis.com/drive/v3/files")).rejects.toMatchObject({
			kind: "forbidden",
			reason: "insufficientFilePermissions",
		});
		const missing = scripted(googleError(404, "notFound"));
		const error = await client(missing.http).getJson("https://www.googleapis.com/drive/v3/files/x").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DriveApiError);
		expect(error).toMatchObject({ kind: "not-found", status: 404 });
	});

	test("no answer is unreachable, and the token does not reach the message", async () => {
		const { http } = scripted(new Error("failed: Bearer ya29.secret"));
		await expect(client(http).getJson("https://www.googleapis.com/drive/v3/files")).rejects.toMatchObject({
			kind: "unreachable",
			message: expect.not.stringContaining("ya29.secret") as unknown,
		});
	});

	test("a small file goes in one request with its metadata", async () => {
		const { http, requests } = scripted(response(200, { id: "f1" }));
		const content = new TextEncoder().encode("hello");
		expect(await client(http).upload(null, { name: "a.md", parents: ["p"] }, content, "id")).toEqual({ id: "f1" });
		const request = requests[0];
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id");
		const type = request?.headers["Content-Type"] ?? "";
		const boundary = /boundary=(.+)$/.exec(type)?.[1] ?? "";
		expect(boundary).not.toBe("");
		const body = textOf(request?.body);
		expect(body).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.md","parents":["p"]}`);
		expect(body).toContain("\r\n\r\nhello\r\n");
		expect(body.endsWith(`--${boundary}--`)).toBe(true);
	});

	test("a large file opens an upload session and is sent to it; a file of an id is replaced", async () => {
		const { http, requests } = scripted(
			response(200, {}, { Location: "https://www.googleapis.com/upload/drive/v3/files/f1?upload_id=s" }),
			response(200, { id: "f1" }),
		);
		const content = new Uint8Array(MULTIPART_MAX_BYTES + 1);
		expect(await client(http).upload("f1", {}, content, "id")).toEqual({ id: "f1" });
		expect(requests[0]).toMatchObject({
			method: "PATCH",
			url: "https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=resumable&fields=id",
			headers: { "X-Upload-Content-Length": String(content.byteLength) },
		});
		expect(requests[1]).toMatchObject({ method: "PUT", url: "https://www.googleapis.com/upload/drive/v3/files/f1?upload_id=s" });
		expect((requests[1]?.body as ArrayBuffer).byteLength).toBe(content.byteLength);
	});

	test("what makes a file, and the content of an upload session, is not sent again after a failure on Google's side", async () => {
		const content = new TextEncoder().encode("x");
		const created = scripted(response(503), response(200, { id: "f1" }));
		await expect(client(created.http).upload(null, { name: "a" }, content, "id")).rejects.toMatchObject({ kind: "unreachable" });
		expect(created.requests).toHaveLength(1);
		const folder = scripted(response(500), response(200, { id: "f1" }));
		await expect(client(folder.http).sendJson("POST", "https://www.googleapis.com/drive/v3/files", {})).rejects.toMatchObject({ status: 500 });
		const large = new Uint8Array(MULTIPART_MAX_BYTES + 1);
		const put = scripted(response(200, {}, { location: "https://www.googleapis.com/upload/s" }), response(502), response(200, { id: "f1" }));
		await expect(client(put.http).upload("f1", {}, large, "id")).rejects.toMatchObject({ status: 502 });
		expect(put.requests).toHaveLength(2);
		// Replacing the content of a file by its id is sent again.
		const replaced = scripted(response(503), response(200, { id: "f1" }));
		expect(await client(replaced.http).upload("f1", {}, content, "id")).toEqual({ id: "f1" });
		// A rate limit is no failure to make anything: sent again.
		const limited = scripted(response(429), response(200, { id: "f1" }));
		expect(await client(limited.http).upload(null, { name: "a" }, content, "id")).toEqual({ id: "f1" });
	});

	test("a download asks for the content, with the size it expects", async () => {
		const { http, requests } = scripted(response(200, "content"));
		expect(new TextDecoder().decode(await client(http).download("f 1", 7))).toBe("content");
		expect(requests[0]).toMatchObject({ url: "https://www.googleapis.com/drive/v3/files/f%201?alt=media", method: "GET", expectedBytes: 7 });
	});

	test("the account is the permission id and the e-mail address", async () => {
		const { http } = scripted(response(200, { user: { permissionId: "p1", emailAddress: "a@example.com" } }));
		expect(await currentDriveAccount(client(http))).toEqual({ accountId: "p1", email: "a@example.com" });
	});
});

describe("connecting to Google Drive by the device flow", () => {
	test("the client of Sync Evo, unless the settings name another", () => {
		expect(googleClientOf(undefined)).toBe(SYNC_EVO_GOOGLE_CLIENT);
		expect(googleClientOf(SYNC_EVO_GOOGLE_CLIENT.id)).toBe(SYNC_EVO_GOOGLE_CLIENT);
		expect(googleClientOf(SYNC_EVO_GOOGLE_CLIENT.id, "ignored")).toBe(SYNC_EVO_GOOGLE_CLIENT);
		expect(googleClientOf("own", "own-secret")).toEqual({ id: "own", secret: "own-secret", own: true });
		// The secret is put in when main.js is built, and the tests are not.
		expect(SYNC_EVO_GOOGLE_CLIENT.secret).toBe("");
		// A client of the user's own whose secret was not entered.
		expect(googleClientOf("own")).toEqual({ id: "own", secret: "", own: true });
		expect(isOwnClient(undefined)).toBe(false);
		expect(isOwnClient(SYNC_EVO_GOOGLE_CLIENT.id)).toBe(false);
		expect(isOwnClient("own")).toBe(true);
	});

	// Sync Evo's client as a release has it, with a secret made up here.
	const CLIENT = { id: SYNC_EVO_GOOGLE_CLIENT.id, secret: "test-client-secret" };

	test("a build without the secret asks Google for nothing", async () => {
		const { http, requests } = scripted();
		const code = { deviceCode: "dc", userCode: "U", verificationUrl: DEVICE_VERIFICATION_URL, expiresAt: 1_000_000, intervalMs: 5000 };
		await expect(requestDeviceCode(http, () => 0, SYNC_EVO_GOOGLE_CLIENT)).rejects.toBeInstanceOf(GoogleClientSecretMissingError);
		await expect(waitForDeviceGrant(http, () => 0, () => Promise.resolve(), SYNC_EVO_GOOGLE_CLIENT, code)).rejects.toBeInstanceOf(
			GoogleClientSecretMissingError,
		);
		await expect(new GoogleTokens(http, () => 0, SYNC_EVO_GOOGLE_CLIENT, "rt").get()).rejects.toBeInstanceOf(GoogleClientSecretMissingError);
		expect(requests).toEqual([]);
	});

	test("a client of the user's own is asked with its own secret", async () => {
		const { http, requests } = scripted(
			response(200, { device_code: "dc", user_code: "U", expires_in: 1800 }),
			response(200, { access_token: "a1", refresh_token: "rt", expires_in: 3600 }),
			response(200, { access_token: "a2", expires_in: 3600 }),
		);
		const own = googleClientOf("own", "own-secret");
		const asked = await requestDeviceCode(http, () => 0, own);
		// The code is asked for without the secret, as with the client of Sync Evo.
		expect(form(requests[0])).toEqual({ client_id: "own", scope: DRIVE_SCOPE });
		await waitForDeviceGrant(http, () => 0, () => Promise.resolve(), own, asked);
		expect(form(requests[1])).toMatchObject({ client_id: "own", client_secret: "own-secret" });
		expect(await new GoogleTokens(http, () => 0, own, "rt").get()).toBe("a2");
		expect(form(requests[2])).toEqual({ client_id: "own", client_secret: "own-secret", grant_type: "refresh_token", refresh_token: "rt" });
	});

	test("a client of the user's own without its secret asks Google for nothing, and says whose secret is missing", async () => {
		const { http, requests } = scripted();
		const own = googleClientOf("own", null);
		await expect(requestDeviceCode(http, () => 0, own)).rejects.toMatchObject({ own: true });
		await expect(new GoogleTokens(http, () => 0, own, "rt").get()).rejects.toBeInstanceOf(GoogleClientSecretMissingError);
		await expect(new GoogleTokens(http, () => 0, SYNC_EVO_GOOGLE_CLIENT, "rt").get()).rejects.toMatchObject({ own: false });
		expect(requests).toEqual([]);
	});

	test("a code is asked for with the client and the one scope", async () => {
		const { http, requests } = scripted(
			response(200, { device_code: "dc", user_code: "ABC-DEF", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 }),
		);
		const code = await requestDeviceCode(http, () => 1000, CLIENT);
		expect(code).toEqual({
			deviceCode: "dc",
			userCode: "ABC-DEF",
			verificationUrl: DEVICE_VERIFICATION_URL,
			expiresAt: 1000 + 1_800_000,
			intervalMs: 5000,
		});
		expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/device/code");
		expect(form(requests[0])).toEqual({ client_id: CLIENT.id, scope: DRIVE_SCOPE });
	});

	const code = { deviceCode: "dc", userCode: "U", verificationUrl: DEVICE_VERIFICATION_URL, expiresAt: 1_000_000, intervalMs: 5000 };

	test("Google is asked at its interval until the user allows, slower when it says so, through a dropped network", async () => {
		const { http, requests } = scripted(
			response(428, { error: "authorization_pending" }),
			new Error("offline"),
			response(403, { error: "slow_down" }),
			response(200, { access_token: "at", refresh_token: "rt", expires_in: 3599 }),
		);
		const slept: number[] = [];
		const waited = await waitForDeviceGrant(
			http,
			() => 0,
			(ms) => {
				slept.push(ms);
				return Promise.resolve();
			},
			CLIENT,
			code,
		);
		expect(waited).toEqual({ status: "connected", grant: { refreshToken: "rt", accessToken: "at", expiresAt: 3_599_000 } });
		expect(slept).toEqual([5000, 5000, 5000, 10000]);
		expect(form(requests[0])).toEqual({
			client_id: CLIENT.id,
			client_secret: CLIENT.secret,
			device_code: "dc",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
	});

	test("a refusal, a code that ran out, and a wait that was stopped end the wait", async () => {
		const sleep = (): Promise<void> => Promise.resolve();
		const denied = scripted(response(403, { error: "access_denied" }));
		expect(await waitForDeviceGrant(denied.http, () => 0, sleep, CLIENT, code)).toEqual({ status: "denied" });
		const expired = scripted(response(400, { error: "expired_token" }));
		expect(await waitForDeviceGrant(expired.http, () => 0, sleep, CLIENT, code)).toEqual({ status: "expired" });
		const late = scripted();
		expect(await waitForDeviceGrant(late.http, () => 2_000_000, sleep, CLIENT, code)).toEqual({ status: "expired" });
		const stopped = new AbortController();
		stopped.abort();
		expect(await waitForDeviceGrant(late.http, () => 0, sleep, CLIENT, code, stopped.signal)).toEqual({ status: "cancelled" });
		// A sleep that never ends once aborted does not keep the wait.
		const never = new AbortController();
		const waiting = waitForDeviceGrant(late.http, () => 0, () => new Promise(() => undefined), CLIENT, code, never.signal);
		never.abort();
		expect(await waiting).toEqual({ status: "cancelled" });
	});

	test("an access token is taken from the refresh token with the secret, and kept while it lasts", async () => {
		const { http, requests } = scripted(response(200, { access_token: "a1", expires_in: 3600 }), response(200, { access_token: "a2", expires_in: 3600 }));
		let time = 0;
		const tokens = new GoogleTokens(http, () => time, CLIENT, "rt");
		expect(await tokens.get()).toBe("a1");
		expect(await tokens.get()).toBe("a1");
		expect(form(requests[0])).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt", client_secret: CLIENT.secret });
		time = 3_400_000;
		expect(await tokens.get()).toBe("a2");
	});

	test("a refresh token Google no longer takes is unauthorized", async () => {
		const { http } = scripted(response(400, { error: "invalid_grant" }));
		await expect(new GoogleTokens(http, () => 0, CLIENT, "rt").get()).rejects.toMatchObject({ kind: "unauthorized" });
	});
});
