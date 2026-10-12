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

import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_CONCURRENT_FETCH_BYTES } from "../src/core/concurrent-fetch";
import type { HttpRequest } from "../src/core/github/http";
import {
	ANDROID_CONCURRENT_FETCH_BYTES,
	concurrentFetchBytesFor,
	FETCH_MIN_BYTES,
	fetchHttp,
	transportFor,
} from "../src/obsidian/http-transport";

// `requestUrl` is stood in for, so that which way a request went can be told.
const app = vi.hoisted(() => ({ requests: [] as { url: string }[] }));

vi.mock("obsidian", () => ({
	Platform: { isAndroidApp: false },
	requestUrl: async (request: { url: string }) => {
		app.requests.push(request);
		return { status: 200, headers: { via: "requestUrl" }, arrayBuffer: new ArrayBuffer(0) };
	},
}));

const { httpFor, obsidianHttp } = await import("../src/obsidian/http");

const ANDROID = { isAndroidApp: true };
const OTHER = { isAndroidApp: false };
const BLOB = `https://api.github.com/repos/o/r/git/blobs/${"a".repeat(40)}`;

/** A request for a large blob, with the fields a test names in place of its own. */
function request(fields: Partial<HttpRequest> = {}): HttpRequest {
	return {
		url: BLOB,
		method: "GET",
		headers: { Authorization: "Bearer t", Accept: "application/vnd.github.raw+json", "Cache-Control": "no-cache" },
		expectedBytes: FETCH_MIN_BYTES,
		...fields,
	};
}

/** Stands in for the page's `fetch`: notes what it was called with, and answers as the test says. */
function stubFetch(answer: () => Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return answer();
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	app.requests.length = 0;
});

describe("which way a request goes", () => {
	test("on Android a large blob goes by fetch", () => {
		expect(transportFor(request(), ANDROID)).toBe("fetch");
		expect(transportFor(request({ expectedBytes: 37_000_000 }), ANDROID)).toBe("fetch");
	});

	test.each<[string, HttpRequest]>([
		["below the threshold", request({ expectedBytes: FETCH_MIN_BYTES - 1 })],
		["of a size that is not known", { url: BLOB, method: "GET", headers: {} }],
		["that is not a GET", request({ method: "POST" })],
		["with a body", request({ body: "{}" })],
		["to another host", request({ url: "https://codeload.github.com/o/r/legacy.zip/abc" })],
		["to a host that only starts like GitHub's", request({ url: "https://api.github.com.example.org/x" })],
		["that is not https", request({ url: "http://api.github.com/repos/o/r/git/blobs/abc" })],
	])("on Android a request %s goes by requestUrl", (_name, sent) => {
		expect(transportFor(sent, ANDROID)).toBe("requestUrl");
	});

	test("anywhere else every request goes by requestUrl", () => {
		expect(transportFor(request(), OTHER)).toBe("requestUrl");
		expect(transportFor(request({ expectedBytes: 64 * 1024 * 1024 }), OTHER)).toBe("requestUrl");
	});

	test("only Android is given a smaller limit on the bytes fetched at once", () => {
		expect(concurrentFetchBytesFor(ANDROID)).toBe(ANDROID_CONCURRENT_FETCH_BYTES);
		expect(concurrentFetchBytesFor(OTHER)).toBe(MAX_CONCURRENT_FETCH_BYTES);
		// A blob that goes through Java never fills the limit by itself.
		expect(FETCH_MIN_BYTES).toBeLessThan(ANDROID_CONCURRENT_FETCH_BYTES);
	});
});

describe("fetch as the HTTP function", () => {
	test("answers with the status, the headers, and the bytes", async () => {
		const content = new Uint8Array([0, 255, 10, 13, 128]);
		const calls = stubFetch(async () => new Response(content, { status: 200, headers: { "X-RateLimit-Remaining": "7" } }));
		const response = await fetchHttp(request());
		expect(response.status).toBe(200);
		expect(response.headers["x-ratelimit-remaining"]).toBe("7");
		expect(new Uint8Array(response.body)).toEqual(content);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(BLOB);
		expect(calls[0]?.init.method).toBe("GET");
		expect(calls[0]?.init.cache).toBe("no-store");
		expect("body" in (calls[0]?.init ?? {})).toBe(false);
	});

	test("sends only the headers GitHub allows from another origin, spelled as they came", async () => {
		const calls = stubFetch(async () => new Response("x"));
		const allowed = {
			Authorization: "Bearer t",
			accept: "application/vnd.github.raw+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"IF-NONE-MATCH": '"abc"',
		};
		await fetchHttp(request({ headers: { ...allowed, "Cache-Control": "no-cache", "X-Added-Later": "1" } }));
		expect(calls[0]?.init.headers).toEqual(allowed);
	});

	test("a status that is a failure is answered, not thrown", async () => {
		stubFetch(async () => new Response('{"message":"Not Found"}', { status: 404, headers: { "Retry-After": "3" } }));
		const response = await fetchHttp(request());
		expect(response.status).toBe(404);
		expect(response.headers["retry-after"]).toBe("3");
		expect(new TextDecoder().decode(response.body)).toBe('{"message":"Not Found"}');
	});

	test("rejects when no response was obtained", async () => {
		stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
		await expect(fetchHttp(request())).rejects.toThrow("Failed to fetch");
	});

	test("refuses a URL that is not https, without a request", async () => {
		const calls = stubFetch(async () => new Response("x"));
		await expect(fetchHttp(request({ url: "http://api.github.com/x" }))).rejects.toThrow("not https");
		expect(calls).toHaveLength(0);
	});
});

describe("the HTTP function of a platform", () => {
	test("on Android sends a large blob by fetch and the rest by requestUrl", async () => {
		const calls = stubFetch(async () => new Response("x", { headers: { via: "fetch" } }));
		const http = httpFor(ANDROID);
		expect((await http(request())).headers.via).toBe("fetch");
		expect((await http(request({ expectedBytes: 100 }))).headers.via).toBe("requestUrl");
		expect(calls).toHaveLength(1);
		expect(app.requests).toHaveLength(1);
	});

	test("anywhere else is requestUrl as it was", () => {
		expect(httpFor(OTHER)).toBe(obsidianHttp);
	});
});
