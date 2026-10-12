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

// Which way a request leaves the device. Kept apart from `http.ts` so that
// nothing here imports `obsidian`, and the tests can load it.

import { MAX_CONCURRENT_FETCH_BYTES } from "../core/concurrent-fetch";
import type { HttpFunction, HttpRequest } from "../core/github/http";

/** The field of the app's `Platform` the choice hangs on. */
export interface HttpPlatform {
	readonly isAndroidApp: boolean;
}

export type HttpTransport = "requestUrl" | "fetch";

/**
 * From how many expected bytes on a response is taken with `fetch` on
 * Android. There `requestUrl` encodes the whole response as Base64 on the
 * Java side, whose heap is capped: a response of 30MB came through with a
 * warning and one of 37MB crashed the app every time (measured on a Pixel
 * 6a, heap of 256MB). The WebView's own `fetch` does not pass through Java,
 * and took 64MB without trouble. A large response must therefore not reach
 * Java. A small one stays on `requestUrl`: each `fetch` of a URL not asked
 * for before costs a CORS preflight, a second request, and every blob has
 * a URL of its own.
 */
export const FETCH_MIN_BYTES = 2 * 1024 * 1024;

/**
 * The most the blobs fetched at once may add up to on Android, in bytes. A
 * blob below `FETCH_MIN_BYTES` still goes through Java, where the memory a
 * response needs is several times its size (one of 30MB took the heap to
 * 239MB), and three of 20MB at once crashed the app. So little is on its
 * way at a time. A blob larger than this is still fetched, alone
 * (`fetchConcurrently`), and such a blob is taken with `fetch`. The blobs
 * taken with `fetch` are counted too, though they do not touch Java, so the
 * limit is more cautious than it needs to be: a blob of 2MB or more mostly
 * travels alone on Android.
 */
export const ANDROID_CONCURRENT_FETCH_BYTES = 8 * 1024 * 1024;

// The one host known to allow a call from another origin with the headers
// the client sends. Every request of the client goes here; a redirect to
// another host (the zip) is followed by `requestUrl`.
const CROSS_ORIGIN_HOST = "https://api.github.com/";

// The request headers `fetch` sends, in lower case. GitHub's answer to the
// preflight allows only a fixed set of request headers (looked at
// 2026-10-12), and one header outside it makes the whole `fetch` fail, which
// reads as "unreachable". So only these are sent and every other is left
// out: a header added to the client later must not silently break the large
// downloads on Android.
const CROSS_ORIGIN_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"accept",
	"x-github-api-version",
	"if-none-match",
]);

/**
 * How a request is sent on a platform. `fetch` only on Android, and only
 * for what it is needed for and known to work for: a GET without a body
 * that is expected to be large, to GitHub's API.
 */
export function transportFor(request: HttpRequest, platform: HttpPlatform): HttpTransport {
	if (!platform.isAndroidApp) return "requestUrl";
	if (request.method !== "GET" || request.body !== undefined) return "requestUrl";
	if (request.expectedBytes === undefined || request.expectedBytes < FETCH_MIN_BYTES) return "requestUrl";
	return request.url.startsWith(CROSS_ORIGIN_HOST) ? "fetch" : "requestUrl";
}

/** The limit on the bytes fetched at once that a platform's backend is given. */
export function concurrentFetchBytesFor(platform: HttpPlatform): number {
	return platform.isAndroidApp ? ANDROID_CONCURRENT_FETCH_BYTES : MAX_CONCURRENT_FETCH_BYTES;
}

/**
 * The WebView's `fetch` as the core's HTTP function. Subject to CORS, so it
 * is only for a request `transportFor` gives it.
 */
export const fetchHttp: HttpFunction = async (request) => {
	// The request carries the token.
	if (!request.url.startsWith("https://")) throw new Error("refusing a URL that is not https");

	// Only what the preflight allows (`CROSS_ORIGIN_HEADERS`), spelled as the
	// caller spelled it. `Cache-Control` is not among it: what that header
	// asks for, `cache` below does.
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		if (CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) headers[name] = value;
	}

	// Rejects with a `TypeError` when no response was obtained; any status resolves.
	const response = await fetch(request.url, {
		method: request.method,
		headers,
		...(request.body === undefined ? {} : { body: request.body }),
		cache: "no-store",
	});
	// From another origin only the headers GitHub exposes can be read.
	// `Retry-After` and `X-RateLimit-*` are among them; `Date` is not, so the
	// client's correction of a rate limit's reset for the difference between
	// the clocks (`clockSkew` in `core/github/rate-limit.ts`) does not apply
	// to a response that came this way, and the device's own clock is used.
	const answered: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		answered[name] = value;
	});
	return { status: response.status, headers: answered, body: await response.arrayBuffer() };
};
