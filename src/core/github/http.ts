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

// What the GitHub client needs from the outside world. The core cannot reach
// the network or a timer by itself, so the plugin hands these in, and tests
// hand in fakes.

export interface HttpRequest {
	readonly url: string;
	readonly method: "GET" | "POST" | "PATCH" | "PUT";
	readonly headers: Readonly<Record<string, string>>;
	/** Already serialised. The matching `Content-Type` is among the headers. */
	readonly body?: string;
}

export interface HttpResponse {
	readonly status: number;
	/** Names in whatever case the platform gives them. Read them with `headerOf`. */
	readonly headers: Readonly<Record<string, string>>;
	/** The raw body. Kept as bytes so that a zip and a JSON answer travel the same way. */
	readonly body: ArrayBuffer;
}

/**
 * Sends one request and answers with whatever status came back, following
 * redirects. Rejects only when no response was obtained at all.
 */
export type HttpFunction = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Resolves after `ms`. Once `signal` aborts, the timer is dropped and the
 * promise may stay pending for good.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Header names differ in case between desktop and mobile. */
export function headerOf(response: HttpResponse, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}
