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
import { type FetchLimitState, FetchLimitWatch, NO_FETCH_LIMIT, sameFetchLimit } from "../core/fetch-quota";
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
	/** What was last reported, for writing the line again when only the request limit changed. */
	private lastProgress: PullProgress | null = null;
	/** Set while a pull runs: what there is to tell about the request limit. */
	private limitWatch: FetchLimitWatch | null = null;
	private shownLimit: FetchLimitState = NO_FETCH_LIMIT;
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
			const client: GitHubClient = new GitHubClient({
				...prepared.target,
				http: obsidianHttp,
				now: Date.now,
				sleep: timerSleep,
				signal: controller.signal,
				// Waited out: a fetch of thousands of files does not fit in
				// the quota of an hour. The requests that run together ask
				// once, and the line of progress says until when.
				onRateLimit: (notice) => {
					limitWatch.rateLimited(notice.until);
					this.showLimit();
					return true;
				},
			});
			const limitWatch = new FetchLimitWatch(() => client.quota, Date.now);
			this.limitWatch = limitWatch;
			const backend = new GitHubBackend(client, { yieldControl, signal: controller.signal });
			const fetchContents = limitWatch.watch((revision, entries) => backend.fetch(revision, entries));
			const result = await runPull({
				store: opened.store,
				backend,
				vault: pullVaultOf(host.app),
				paths: exclusionPathsOf(host.app, host.manifest),
				pluginId: host.manifest.id,
				deviceName: settings.deviceName,
				now: Date.now,
				confirm: async (request) => {
					// The line of progress stays on top of everything, a dialog
					// included: on a phone it covered the title of the question.
					// It is taken away while the user answers and put back after.
					this.progress?.hide();
					this.progress = null;
					const answer = await confirmPullIn(host.app, t)(request);
					// Not after a "no": nothing is updated then.
					if (!this.stopped && answer !== "cancel") {
						this.progress = new Notice(t("pull.progress.applyingStart"), 0);
						this.progressPhase = "";
						// The new line shows nothing of the limit yet.
						this.lastProgress = null;
						this.shownLimit = NO_FETCH_LIMIT;
					}
					return answer;
				},
				beginBulkWrite: graphViewPause(host.app),
				// Where the number of files to fetch is known, right before
				// the first is asked for: a fetch that does not fit in the
				// quota is told from here on.
				fetchContents: (revision, entries) => {
					const contents = fetchContents(revision, entries);
					this.showLimit();
					return contents;
				},
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
			this.lastProgress = null;
			this.limitWatch = null;
			this.shownLimit = NO_FETCH_LIMIT;
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
		// After the guard: while a question is open there is no line, and
		// what `showLimit` passes in place of a report must not be kept.
		this.lastProgress = progress;
		const now = Date.now();
		const limit = this.limitWatch?.state() ?? NO_FETCH_LIMIT;
		// A wait that ended takes its line away with the next file.
		const step =
			progress.phase !== this.progressPhase ||
			progress.closedViews !== this.progressClosedViews ||
			!sameFetchLimit(limit, this.shownLimit);
		const last = progress.total > 0 && progress.done === progress.total;
		if (!step && !last && now - this.progressShownAt < PROGRESS_INTERVAL_MS) return;
		this.progressPhase = progress.phase;
		this.progressClosedViews = progress.closedViews;
		this.shownLimit = limit;
		this.progressShownAt = now;
		this.progress.setMessage(pullProgressText(this.host.t, progress, limit));
	}

	/**
	 * Writes the line of progress again when what there is to tell about the
	 * request limit changed. While a limit is waited out no file is reported,
	 * so the line would not change by itself.
	 */
	private showLimit(): void {
		const limit = this.limitWatch?.state() ?? NO_FETCH_LIMIT;
		if (sameFetchLimit(limit, this.shownLimit)) return;
		// Nothing reported since the line was put up: after a question it
		// is the one the updating starts with.
		this.showProgress(this.lastProgress ?? { phase: "applying", done: 0, total: 0, closedViews: false });
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
