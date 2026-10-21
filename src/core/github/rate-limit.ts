/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { headerOf, type HttpResponse } from "../http";

export interface RateLimit {
	/**
	 * "primary" is the hourly quota of the token. "secondary" is GitHub slowing
	 * down a burst (content creation has its own per-minute and per-hour caps).
	 */
	readonly kind: "primary" | "secondary";
	/** When to send the request again, in milliseconds since the epoch. */
	readonly until: number;
	/**
	 * Whether the response named the time. When it did not, `until` is a
	 * minute away, the least GitHub asks for, and the limit may last longer.
	 */
	readonly stated: boolean;
}

// GitHub asks for at least a minute when a secondary limit names no time.
export const UNSTATED_WAIT_MS = 60_000;
// The reset time and the `date` header are in whole seconds, so a request sent
// exactly at the reset can still be refused.
export const MARGIN_MS = 1_000;

/** A header that is a whole number, or `null`. */
function seconds(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value.trim())) return null;
	return Number(value.trim());
}

/**
 * How far GitHub's clock is ahead of the device's, going by the `date` header
 * of the response, or `null` when the header is missing or unreadable.
 */
function clockSkew(response: HttpResponse, now: number): number | null {
	const date = headerOf(response, "date");
	if (date === undefined) return null;
	const sent = Date.parse(date);
	return Number.isNaN(sent) ? null : sent - now;
}

/**
 * Tells whether a response is a rate limit, and until when to wait. `message`
 * is the `message` of the JSON body, or "" when there is none. Follows the
 * order GitHub documents: `retry-after` first, then the reset time of an
 * exhausted quota, then a minute.
 *
 * `until` is a time on the device clock, the one the wait is measured with.
 */
export function rateLimitOf(response: HttpResponse, message: string, now: number): RateLimit | null {
	if (response.status !== 403 && response.status !== 429) return null;

	const retryAfter = seconds(headerOf(response, "retry-after"));
	if (retryAfter !== null) {
		return { kind: "secondary", until: now + retryAfter * 1000 + MARGIN_MS, stated: true };
	}

	if (headerOf(response, "x-ratelimit-remaining")?.trim() === "0") {
		const reset = seconds(headerOf(response, "x-ratelimit-reset"));
		// The reset is a time on GitHub's clock. Read against a device clock
		// that runs ahead it looks nearer than it is, or already past, and the
		// retries are used up within seconds; against one that runs behind the
		// wait is too long. The `date` header says what GitHub's clock showed
		// when it answered, which moves the reset onto the device clock.
		// Without that header the two clocks are taken to agree. `retry-after`
		// above is a duration and needs none of this.
		const skew = clockSkew(response, now) ?? 0;
		// A reset time already past still gets the margin, so that it does not
		// turn into an immediate retry.
		const until = reset === null ? now + UNSTATED_WAIT_MS : Math.max(reset * 1000 - skew, now);
		return { kind: "primary", until: until + MARGIN_MS, stated: reset !== null };
	}

	// A 403 is otherwise a permission problem. Only the body tells the two apart.
	if (response.status === 429 || /rate limit/i.test(message)) {
		return { kind: "secondary", until: now + UNSTATED_WAIT_MS + MARGIN_MS, stated: false };
	}
	return null;
}

/** What is left of the hourly quota of the token, as a response reported it. */
export interface RateLimitQuota {
	/** How many requests are left until the reset. */
	readonly remaining: number;
	/** When the quota is full again, in milliseconds since the epoch, on the device clock. */
	readonly resetAt: number;
	/** The size of the full quota, when the response named it. */
	readonly limit?: number;
}

/**
 * The quota a response reports, or `null` when it reports none, or one of
 * another resource than "core": searching, for one, is counted apart, and its
 * numbers say nothing about the calls a sync makes. A response that does not
 * name its resource is taken to be of the core.
 */
export function quotaOf(response: HttpResponse, now: number): RateLimitQuota | null {
	const resource = headerOf(response, "x-ratelimit-resource")?.trim();
	if (resource !== undefined && resource !== "" && resource !== "core") return null;
	const remaining = seconds(headerOf(response, "x-ratelimit-remaining"));
	const reset = seconds(headerOf(response, "x-ratelimit-reset"));
	if (remaining === null || reset === null) return null;
	const limit = seconds(headerOf(response, "x-ratelimit-limit"));
	// Moved onto the device clock, as in `rateLimitOf`.
	const resetAt = reset * 1000 - (clockSkew(response, now) ?? 0);
	return { remaining, resetAt, ...(limit === null ? {} : { limit }) };
}
