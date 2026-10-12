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

import type { Sleep } from "./http";

/**
 * The two calls of a timer that a sleep needs. The app hands over its
 * `window`, and a test the timer of Node: nothing here knows of a window.
 */
export interface Timers<Id> {
	setTimeout: (run: () => void, ms: number) => Id;
	clearTimeout: (id: Id) => void;
}

/**
 * `Sleep` on the timer it is given. It lives here rather than next to the
 * Obsidian adapter because it needs nothing but that timer, and a file that
 * imports `obsidian` cannot be loaded by the tests.
 *
 * An aborted sleep stays pending and never resolves: resolving would tell the
 * caller that the time has passed.
 */
export const timerSleepOn =
	<Id>(timers: Timers<Id>): Sleep =>
	(ms, signal) =>
		new Promise((resolve) => {
			// `addEventListener` does not call back for an abort that has already
			// happened, so without this the timer would run to its end.
			if (signal?.aborted) return;

			const onAbort = (): void => {
				timers.clearTimeout(id);
				signal?.removeEventListener("abort", onAbort);
			};
			const id = timers.setTimeout(() => {
				// A signal can outlive many sleeps. Each one takes its listener
				// with it, so that they do not pile up on the signal.
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort);
		});
