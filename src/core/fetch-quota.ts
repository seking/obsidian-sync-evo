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

// What there is to tell about the request limit while files are fetched one
// by one: that the fetch will not fit in what is left of the quota, and that
// it is waiting for the quota to come back. Decided here; worded in
// `pull-report.ts`; put on the screen by whoever runs the pull.

import type { FetchedFile } from "./backend";
import type { RateLimitQuota } from "./github/rate-limit";
import type { ContentSource } from "./pull-io";

/** A fetch of more files than the quota has requests left for. */
export interface QuotaNote {
	/** About how many files can be fetched before the limit is reached. */
	readonly fetchable: number;
	/** When the rest continues, in milliseconds since the epoch. */
	readonly resumesAt: number;
}

/**
 * Whether fetching `files` files, one request each, runs into the limit, and
 * what to tell if so. `null` when it fits, and when the quota is not known:
 * none was reported yet, or the one reported has been reset since, and what
 * the new one holds is not known until a response says so. Also `null` when
 * nothing is left of the quota: the first request is refused then, and the
 * wait that follows says all there is to say.
 */
export function quotaNoteFor(files: number, quota: RateLimitQuota | null, now: number): QuotaNote | null {
	if (quota === null || quota.resetAt <= now) return null;
	if (files <= quota.remaining || quota.remaining <= 0) return null;
	return { fetchable: quota.remaining, resumesAt: quota.resetAt };
}

/** What the progress of a pull shows about the request limit, at one moment. */
export interface FetchLimitState {
	/** The fetch is waiting for a limit to be lifted, until this time. */
	readonly waitingUntil: number | null;
	readonly quota: QuotaNote | null;
}

export const NO_FETCH_LIMIT: FetchLimitState = { waitingUntil: null, quota: null };

/** Whether two states are shown the same. */
export function sameFetchLimit(a: FetchLimitState, b: FetchLimitState): boolean {
	return (
		a.waitingUntil === b.waitingUntil &&
		a.quota?.fetchable === b.quota?.fetchable &&
		a.quota?.resumesAt === b.quota?.resumesAt
	);
}

/**
 * Keeps track of one pull's fetching for `FetchLimitState`: how many files
 * are still to be fetched, and until when a limit is waited out.
 */
export class FetchLimitWatch {
	private readonly quota: () => RateLimitQuota | null;
	private readonly now: () => number;
	/** Files asked for and not yet handed over. */
	private left = 0;
	private waitingUntil: number | null = null;
	private note: QuotaNote | null = null;

	/** `quota` answers with the quota as last reported; it is read again each time. */
	constructor(quota: () => RateLimitQuota | null, now: () => number) {
		this.quota = quota;
		this.now = now;
	}

	/** The same source, with its files counted. */
	watch(source: ContentSource): ContentSource {
		const count = (): void => {
			this.left -= 1;
		};
		return (revision, entries) => {
			this.left += entries.length;
			return counted(source(revision, entries), count);
		};
	}

	/** A limit was reached, and is waited out until `until`. For the client's `onRateLimit`. */
	rateLimited(until: number): void {
		this.waitingUntil = Math.max(this.waitingUntil ?? 0, until);
	}

	state(): FetchLimitState {
		const now = this.now();
		if (this.waitingUntil !== null && now >= this.waitingUntil) this.waitingUntil = null;
		// A note stands until the reset it names, so that its numbers do not
		// run down with every file. After that, and while there is none, it
		// is worked out from what is left to fetch.
		if (this.note === null || now >= this.note.resumesAt) {
			this.note = quotaNoteFor(this.left, this.quota(), now);
		}
		// The wait says the same and more: its time is the one that counts.
		return { waitingUntil: this.waitingUntil, quota: this.waitingUntil === null ? this.note : null };
	}
}

async function* counted(files: AsyncIterable<FetchedFile>, count: () => void): AsyncGenerator<FetchedFile, void, void> {
	for await (const file of files) {
		count();
		yield file;
	}
}
