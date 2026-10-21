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

// Keeping the screen on while a sync the user started runs (Screen Wake
// Lock). On a phone the work stops when the screen locks, and a first fetch
// can take longer than the auto-lock allows.
//
// Nothing depends on it: where the lock is not there or is refused, the sync
// runs all the same, and one that is stopped by the screen goes on the next
// time.

/** The part of the lock that is used. Not every platform's types know it. */
interface Sentinel {
	release(): Promise<void>;
}

interface WakeLockApi {
	request(type: "screen"): Promise<Sentinel>;
}

export class ScreenWakeLock {
	private wanted = false;
	private sentinel: Sentinel | null = null;

	/**
	 * Asks for the lock, and keeps asking for it again whenever the app
	 * comes back to the front, until `release`.
	 *
	 * To be called from the handler of what the user did, with nothing
	 * awaited before: a phone refused a request made after several awaits.
	 * Nothing is awaited in here either.
	 */
	hold(): void {
		if (this.wanted) return;
		this.wanted = true;
		document.addEventListener("visibilitychange", this.onVisibilityChange);
		this.request();
	}

	/** Lets the screen go off again. However the sync ended. */
	release(): void {
		if (!this.wanted) return;
		this.wanted = false;
		document.removeEventListener("visibilitychange", this.onVisibilityChange);
		const sentinel = this.sentinel;
		this.sentinel = null;
		sentinel?.release().catch(() => {});
	}

	// The lock is let go of by the system when the app goes to the back. The
	// request is made here, in the handler, and not after an await.
	private readonly onVisibilityChange = (): void => {
		if (document.visibilityState === "visible") this.request();
	};

	private request(): void {
		try {
			const api = (navigator as { wakeLock?: WakeLockApi }).wakeLock;
			if (api === undefined) return;
			api.request("screen").then(
				(sentinel) => {
					// Granted after the sync ended.
					if (!this.wanted) {
						sentinel.release().catch(() => {});
						return;
					}
					// The one from before the app went to the back was let
					// go of by the system; releasing it again does nothing.
					this.sentinel?.release().catch(() => {});
					this.sentinel = sentinel;
				},
				() => {
					// Refused. The sync goes on without it.
				},
			);
		} catch {
			// The same.
		}
	}
}
