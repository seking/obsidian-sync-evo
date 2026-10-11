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

// The clock of automatic sync, in the app: it is told when the app has
// started, when the timer has fired, and when the page says it is shown,
// and starts a sync when the rules say one is due. The rules are in
// `core/auto-sync.ts`; nothing is decided here.

import { dueOnResume, dueOnTick, ForegroundClock } from "../core/auto-sync";
import { connectionOf, type DeviceSettings } from "../core/settings";
import type { SyncRunner } from "./sync-runner";

/** What the clock needs from the plugin. The settings are read at every look, so that a switch takes effect by itself. */
export interface AutoSchedulerHost {
	readonly deviceSettings: DeviceSettings | null;
}

export class AutoScheduler {
	private readonly host: AutoSchedulerHost;
	private readonly syncs: SyncRunner;
	private readonly front = new ForegroundClock();
	/** Whether the app has started or come back to the front since the last decision. */
	private resumed = false;
	/** Whether a look is waiting for what is remembered to be read. */
	private looking = false;
	/** Whether the app is up (`started`). Before that nothing is looked at. */
	private ready = false;

	constructor(host: AutoSchedulerHost, syncs: SyncRunner) {
		this.host = host;
		this.syncs = syncs;
	}

	/**
	 * The app is up. Decided like a return to the front: on a phone a return
	 * often is a start. The timer and the event are there before this, and
	 * do nothing until now: the app is still reading the vault then, and a
	 * sync that went by its index would find half of the files.
	 */
	started(): void {
		this.ready = true;
		this.front.shown(Date.now());
		void this.look(true);
	}

	/** The timer has fired. Nothing while the app is not in front: the clock only runs there. */
	tick(): void {
		if (!this.ready) return;
		const kind = this.front.tick(Date.now(), isVisible());
		if (kind !== null) void this.look(kind === "resume");
	}

	/**
	 * The page says whether it is shown. Shown is a return, at once, without
	 * waiting for the timer. That it was hidden before is not assumed: the
	 * decision goes by how long ago the last sync started, so a second
	 * "shown" in a row starts nothing more.
	 */
	visibilityChanged(): void {
		if (!this.ready || !isVisible()) return;
		this.front.shown(Date.now());
		void this.look(true);
	}

	private async look(resume: boolean): Promise<void> {
		if (resume) {
			this.resumed = true;
			// Whether or not a sync starts now, the next one that starts
			// by itself looks at every folder.
			this.syncs.resumed();
		}
		// One at a time. A return that is noticed meanwhile is kept above,
		// and decided by the look that is waiting.
		if (this.looking) return;
		this.looking = true;
		try {
			const settings = this.host.deviceSettings;
			// Settings of a newer version, automatic sync switched off, or
			// nothing to sync with: nothing is opened, read, or started.
			if (settings === null || connectionOf(settings) === null) return;
			if (!settings.autoSync.onStartup && !settings.autoSync.atInterval) return;
			// No token was chosen: the connection is not entered to the end.
			// One that was chosen and holds nothing is the sync's to tell.
			if (settings.tokenSecret === "") return;
			// A sync that runs is never followed by one that was due
			// meanwhile, and none is kept for later.
			if (this.syncs.running) return;
			// When the last sync started, from the sync state: once, for
			// the first look after the app has started.
			await this.syncs.recallAuto();
			if (this.syncs.running) return;

			// As they are now: the wait may have been a long one, and the
			// connection may have been taken away during it.
			const now = this.host.deviceSettings;
			if (now === null || connectionOf(now) === null) return;
			const auto = now.autoSync;
			const clock = { now: Date.now(), ...this.syncs.autoClock() };
			const check = this.resumed ? dueOnResume(auto, clock) : dueOnTick(auto, clock);
			if (check !== null) void this.syncs.runAuto(check);
		} finally {
			this.resumed = false;
			this.looking = false;
		}
	}
}

function isVisible(): boolean {
	return document.visibilityState === "visible";
}
