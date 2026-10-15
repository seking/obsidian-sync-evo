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

import { Platform, requestUrl } from "obsidian";
import type { HttpFunction } from "../core/github/http";
import { archiveAllowedFor, concurrentFetchBytesFor, fetchHttp, type HttpPlatform, transportFor } from "./http-transport";

/**
 * `requestUrl` as the core's HTTP function. It is used instead of `fetch`
 * because it is not subject to CORS and works the same on mobile.
 */
export const obsidianHttp: HttpFunction = async (request) => {
	// The request carries the token.
	if (!request.url.startsWith("https://")) throw new Error("refusing a URL that is not https");

	// `requestUrl` takes the content type as its own parameter, so it is
	// moved there rather than sent as a header as well.
	const headers: Record<string, string> = {};
	let contentType: string | undefined;
	for (const [name, value] of Object.entries(request.headers)) {
		if (name.toLowerCase() === "content-type") contentType = value;
		else headers[name] = value;
	}

	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers,
		...(contentType === undefined ? {} : { contentType }),
		...(request.body === undefined ? {} : { body: request.body }),
		// Without this a 4xx rejects with an error that has lost the headers,
		// and the headers are where a rate limit says how long to wait.
		throw: false,
	});
	return { status: response.status, headers: response.headers ?? {}, body: response.arrayBuffer };
};

/**
 * The HTTP function of a platform: `requestUrl`, and on Android `fetch` for
 * the requests `transportFor` names. A large response crashes the app there
 * when it comes through `requestUrl`.
 */
export function httpFor(platform: HttpPlatform): HttpFunction {
	if (!platform.isAndroidApp) return timed(obsidianHttp);
	return timed((request) => (transportFor(request, platform) === "fetch" ? fetchHttp(request) : obsidianHttp(request)));
}

/**
 * Writes how long each request took to the console, and to nothing else: a
 * pull asks for a file at a time and would push every other line out of the
 * log that is kept (`log.ts`). Only the method, the host and the path, not
 * the query: the token is in a header, and what Dropbox is asked about is
 * in a header too. The path names the repository on GitHub, and the first
 * file of an empty one (`createFile`).
 * Read on a phone through the WebView's debugger, to see where a sync spends
 * its time.
 */
function timed(http: HttpFunction): HttpFunction {
	return async (request) => {
		const started = Date.now();
		const where = request.url.split("?")[0];
		try {
			const response = await http(request);
			console.debug(`Sync Evo: http ${request.method} ${where} ${response.status} in ${Date.now() - started}ms`);
			return response;
		} catch (error) {
			console.debug(`Sync Evo: http ${request.method} ${where} failed in ${Date.now() - started}ms`);
			throw error;
		}
	};
}

/** How this device reaches GitHub: what its client and its backend are built with. */
export interface DeviceNetwork {
	readonly http: HttpFunction;
	/** For `GitHubBackendOptions.maxConcurrentFetchBytes`. */
	readonly maxConcurrentFetchBytes: number;
	/** For `PullDeps.archiveAllowed`. */
	readonly archiveAllowed: boolean;
}

export function deviceNetwork(): DeviceNetwork {
	return {
		http: httpFor(Platform),
		maxConcurrentFetchBytes: concurrentFetchBytesFor(Platform),
		archiveAllowed: archiveAllowedFor(Platform),
	};
}
