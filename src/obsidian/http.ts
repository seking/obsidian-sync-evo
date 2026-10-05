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

import { requestUrl } from "obsidian";
import type { HttpFunction } from "../core/github/http";

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
