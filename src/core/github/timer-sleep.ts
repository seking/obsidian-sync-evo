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
 * `Sleep` on the platform's own timer. It lives here rather than next to the
 * Obsidian adapter because it needs nothing but `setTimeout`, and a file that
 * imports `obsidian` cannot be loaded by the tests.
 *
 * An aborted sleep stays pending and never resolves: resolving would tell the
 * caller that the time has passed.
 */
export const timerSleep: Sleep = (ms, signal) =>
	new Promise((resolve) => {
		// `addEventListener` does not call back for an abort that has already
		// happened, so without this the timer would run to its end.
		if (signal?.aborted) return;

		const onAbort = (): void => {
			clearTimeout(id);
			signal?.removeEventListener("abort", onAbort);
		};
		const id = setTimeout(() => {
			// A signal can outlive many sleeps. Each one takes its listener
			// with it, so that they do not pile up on the signal.
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort);
	});
