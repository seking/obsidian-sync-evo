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

// Running a pull in the app: gathering what `runPull` is handed, and putting
// what it answers on the screen. Everything that is decided about a pull is
// in `core/`; everything that is worded is in `core/pull-report.ts`.

import { type App, Notice, type PluginManifest } from "obsidian";
import { connectionCheckText, prepareCheck } from "../core/connection-check";
import { GitHubBackend } from "../core/github/backend";
import { GitHubClient } from "../core/github/client";
import { timerSleep } from "../core/github/timer-sleep";
import type { Translate } from "../core/i18n";
import { DEFAULT_SIZE_LIMIT } from "../core/plan";
import { type PullProgress, type PullResult, runPull } from "../core/pull";
import { pullFailureText, pullProgressText, pullReport, stateProblemText } from "../core/pull-report";
import type { DeviceSettings } from "../core/settings";
import { exclusionPathsOf } from "./exclusion-paths";
import { graphViewPause } from "./graph-views";
import { obsidianHttp } from "./http";
import { confirmPullIn } from "./pull-confirm";
import { pullVaultOf } from "./pull-vault";
import type { SyncState } from "./sync-state";

/** What a pull needs from the plugin. Read when a pull starts, so that it runs with the settings of that moment. */
export interface PullHost {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly t: Translate;
	readonly deviceSettings: DeviceSettings | null;
	readonly syncState: SyncState;
	/** The token saved under a name, or `null`. */
	readToken(secretName: string): string | null;
}

// The line of progress is rewritten at most this often. A pull reports
// every file, thousands of them in a second.
const PROGRESS_INTERVAL_MS = 200;

export class PullRunner {
	private readonly host: PullHost;
	/** Set while a pull runs. Aborted to stop it. */
	private controller: AbortController | null = null;
	/** Whether the running pull is waiting for the sync state to open. */
	private opening = false;
	private progress: Notice | null = null;
	private progressShownAt = 0;
	private progressPhase = "";
	private progressClosedViews = false;
	/** The plugin is going away: nothing more is shown. */
	private stopped = false;

	constructor(host: PullHost) {
		this.host = host;
	}

	/** Pulls once, and shows how it went. One pull at a time: a second call only says that one is running. */
	async run(): Promise<void> {
		const { host } = this;
		const t = host.t;
		if (this.controller !== null) {
			new Notice(t("pull.alreadyRunning"));
			return;
		}

		const settings = host.deviceSettings;
		if (settings === null) {
			new Notice(t("settings.unknownVersion"));
			return;
		}
		const prepared = prepareCheck(settings, (name) => host.readToken(name));
		if (prepared.status === "not-ready") {
			new Notice(connectionCheckText(t, settings, prepared));
			return;
		}

		const controller = new AbortController();
		this.controller = controller;
		this.progress = new Notice(t("pull.progress.starting"), 0);
		try {
			this.opening = true;
			const opened = await host.syncState.open();
			this.opening = false;
			if (controller.signal.aborted) return;
			if (opened.status !== "ok") {
				this.show(stateProblemText(t, opened.status === "unavailable" ? opened.reason : opened.status), 0);
				return;
			}

			const yieldControl = (): Promise<void> => timerSleep(0);
			const client = new GitHubClient({
				...prepared.target,
				http: obsidianHttp,
				now: Date.now,
				sleep: timerSleep,
				signal: controller.signal,
				// Reported, not waited out, for now. Waiting, with a display
				// of the wait, comes with the fetch of many files (T022).
				onRateLimit: () => false,
			});
			const result = await runPull({
				store: opened.store,
				backend: new GitHubBackend(client, { yieldControl }),
				vault: pullVaultOf(host.app),
				paths: exclusionPathsOf(host.app, host.manifest),
				pluginId: host.manifest.id,
				deviceName: settings.deviceName,
				now: Date.now,
				confirm: confirmPullIn(host.app, t),
				beginBulkWrite: graphViewPause(host.app),
				onProgress: (progress) => this.showProgress(progress),
				signal: controller.signal,
				yieldControl,
				sizeLimit: DEFAULT_SIZE_LIMIT,
			});
			this.report(result, settings);
		} catch (error) {
			if (!this.stopped) console.error("Sync Evo: the pull failed", error);
			this.show(pullFailureText(t, settings, error), 0);
		} finally {
			this.opening = false;
			this.controller = null;
			this.progress?.hide();
			this.progress = null;
			this.progressPhase = "";
		}
	}

	/** Stops a running pull between two files. For when the plugin is unloaded. */
	stop(): void {
		this.stopped = true;
		this.controller?.abort();
		this.progress?.hide();
	}

	/**
	 * For `SyncStateDeps.onDiscardBlocked`. Only a pull that waits for the
	 * state says anything; the text names the wait and not a cause, which
	 * can be another window or nothing but a moment.
	 */
	stateBlocked(): void {
		if (this.opening) this.progress?.setMessage(this.host.t("state.waiting"));
	}

	private showProgress(progress: PullProgress): void {
		if (this.stopped || this.progress === null) return;
		const now = Date.now();
		const step = progress.phase !== this.progressPhase || progress.closedViews !== this.progressClosedViews;
		const last = progress.total > 0 && progress.done === progress.total;
		if (!step && !last && now - this.progressShownAt < PROGRESS_INTERVAL_MS) return;
		this.progressPhase = progress.phase;
		this.progressClosedViews = progress.closedViews;
		this.progressShownAt = now;
		this.progress.setMessage(pullProgressText(this.host.t, progress));
	}

	private report(result: PullResult, settings: DeviceSettings): void {
		// Unloading stops the pull; there is no one to tell.
		if (this.stopped) return;
		const report = pullReport(this.host.t, result, { settings, sizeLimit: DEFAULT_SIZE_LIMIT });
		this.show(report.summary);
		// Until they are dismissed: each is something to know or to act on.
		for (const detail of report.details) this.show(detail, 0);
	}

	private show(text: string, duration?: number): void {
		if (this.stopped) return;
		new Notice(text, duration);
	}
}
