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

// Fetching the content of many entries, several at a time. What is in memory
// at once is bounded by a count and by the sizes the listing gave, and
// nothing is fetched ahead of a consumer that does not keep up.

import { BackendError, type FetchedFile, type RemoteEntry } from "./backend";

/** How many entries are fetched at once. */
export const MAX_CONCURRENT_FETCHES = 16;

/**
 * The most the entries fetched at once may add up to, by the size the listing
 * gave, in bytes. All of them are in memory together, and a phone does not
 * have room for 16 files of the largest size that is synced.
 */
export const MAX_CONCURRENT_FETCH_BYTES = 64 * 1024 * 1024;

export interface ConcurrentFetchOptions {
	/** `MAX_CONCURRENT_FETCHES` when absent. */
	readonly maxCount?: number;
	/** `MAX_CONCURRENT_FETCH_BYTES` when absent. */
	readonly maxBytes?: number;
	/** Once aborted, nothing more is started, and the fetch ends with a "cancelled" failure. */
	readonly signal?: AbortSignal;
}

/**
 * Yields the content of each entry, as `fetchOne` answers it, in the order
 * the answers come in. The entries are started in the order given.
 *
 * An entry counts against both limits from the moment it is started until
 * the consumer asks for the item after it: content that is fetched but not
 * yet taken is as much in memory as content on its way. An entry larger than
 * the limit on bytes is fetched while nothing else is, alone. An entry
 * without a size counts as empty.
 *
 * After the first failure nothing more is started. What had already been
 * fetched is still yielded, and then the failure is thrown. The requests
 * that are on their way cannot be taken back; what they answer is dropped.
 */
export async function* fetchConcurrently(
	entries: readonly RemoteEntry[],
	fetchOne: (entry: RemoteEntry) => Promise<Uint8Array>,
	options: ConcurrentFetchOptions = {},
): AsyncGenerator<FetchedFile, void, void> {
	const maxCount = Math.max(options.maxCount ?? MAX_CONCURRENT_FETCHES, 1);
	const maxBytes = options.maxBytes ?? MAX_CONCURRENT_FETCH_BYTES;
	const signal = options.signal;

	let next = 0;
	// Started and not yet taken by the consumer: on their way, or in `ready`.
	let held = 0;
	let heldBytes = 0;
	let running = 0;
	const ready: FetchedFile[] = [];
	// In an object: it is set from callbacks, which the type checker does
	// not follow for a variable.
	const state: { failure: { readonly error: unknown } | null } = { failure: null };
	let wake = (): void => {};

	const cancel = (): void => {
		state.failure ??= { error: new BackendError("cancelled", "fetch: cancelled") };
		wake();
	};

	const startMore = (): void => {
		while (state.failure === null && next < entries.length) {
			if (signal?.aborted) {
				cancel();
				return;
			}
			const entry = entries[next] as RemoteEntry;
			const size = entry.size ?? 0;
			if (held >= maxCount) return;
			// With nothing held, an entry starts whatever its size: waiting
			// would not make room for it.
			if (held > 0 && heldBytes + size > maxBytes) return;
			next += 1;
			held += 1;
			heldBytes += size;
			running += 1;
			// Both outcomes are handled here, so a request that fails after
			// the consumer has gone is not an unhandled rejection. The
			// wrapper turns a `fetchOne` that throws into one that rejects.
			(async () => fetchOne(entry))()
				.then(
					(content) => {
						ready.push({ entry, content });
					},
					(error: unknown) => {
						state.failure ??= { error };
					},
				)
				.finally(() => {
					running -= 1;
					wake();
				});
		}
	};

	signal?.addEventListener("abort", cancel);
	try {
		// An abort that came before the listener was there raised no event,
		// and with no entries nothing below would look at the signal.
		if (signal?.aborted) cancel();
		for (;;) {
			startMore();
			const file = ready.shift();
			if (file !== undefined) {
				yield file;
				// Only now: the consumer has come back for more, so it is
				// done with this one.
				held -= 1;
				heldBytes -= file.entry.size ?? 0;
				continue;
			}
			if (state.failure !== null) throw state.failure.error;
			// Nothing held and nothing started means nothing is left.
			if (running === 0) return;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	} finally {
		// Also when the consumer stops early. Nothing is started after this:
		// only the loop above starts anything.
		signal?.removeEventListener("abort", cancel);
		wake = () => {};
	}
}
