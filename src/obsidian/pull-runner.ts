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
import { ArchiveGate } from "../core/archive-fetch";
import { BackendError } from "../core/backend";
import { connectionCheckText, prepareCheck } from "../core/connection-check";
import { type FetchLimitState, FetchLimitWatch, NO_FETCH_LIMIT, sameFetchLimit } from "../core/fetch-quota";
import { GitHubBackend } from "../core/github/backend";
import { GitHubClient } from "../core/github/client";
import { timerSleep } from "../core/github/timer-sleep";
import type { Translate } from "../core/i18n";
import { DEFAULT_SIZE_LIMIT } from "../core/plan";
import { type PullProgress, type PullResult, runPull } from "../core/pull";
import {
	pullFailureText,
	pullProgressText,
	pullReport,
	stateProblemText,
	stoppedText,
} from "../core/pull-report";
import type { DeviceSettings } from "../core/settings";
import { exclusionPathsOf } from "./exclusion-paths";
import { graphViewPause } from "./graph-views";
import { obsidianHttp } from "./http";
import { confirmPullIn, type PullTarget } from "./pull-confirm";
import { pullVaultOf } from "./pull-vault";
import type { SyncState } from "./sync-state";
import { ScreenWakeLock } from "./wake-lock";

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

/**
 * - "pull": from where the sync state stands.
 * - "first-fetch": the sync state is discarded and the pull starts over,
 *   after one question that says so.
 */
export type PullMode = "pull" | "first-fetch";

// The line of progress is rewritten at most this often. A pull reports
// every file, thousands of them in a second.
const PROGRESS_INTERVAL_MS = 200;

export class PullRunner {
	private readonly host: PullHost;
	/** Set while a pull runs. Aborted to stop it. */
	private controller: AbortController | null = null;
	/** Set while a pull runs: resolves when it has ended, however it ends. */
	private ended: Promise<void> | null = null;
	/** Whether the running pull was stopped because the connection it runs with was changed. */
	private connectionChanged = false;
	/** Whether the user asked the running pull to stop. The line of progress says so until it has. */
	private stopping = false;
	/** Whether the running pull is waiting for the sync state to open. */
	private opening = false;
	private progress: Notice | null = null;
	private progressShownAt = 0;
	private progressPhase = "";
	private progressClosedViews = false;
	private progressArchive: PullProgress["archive"] = undefined;
	/** What was last reported, for writing the line again when only the request limit changed. */
	private lastProgress: PullProgress | null = null;
	/** Set while a pull runs: what there is to tell about the request limit. */
	private limitWatch: FetchLimitWatch | null = null;
	private shownLimit: FetchLimitState = NO_FETCH_LIMIT;
	/** The plugin is going away: nothing more is shown. */
	private stopped = false;
	/** Across pulls: a pull that is stopped leaves the request for the zip of the commit on its way. */
	private readonly archiveGate = new ArchiveGate();
	private readonly wakeLock = new ScreenWakeLock();

	constructor(host: PullHost) {
		this.host = host;
	}

	/**
	 * Pulls once, and shows how it went. One pull at a time: a second call
	 * only says that one is running.
	 *
	 * Called from the handler of a command, and nothing is awaited before
	 * the screen is asked to stay on, which a phone only grants so. Every
	 * pull is started by the user for now. A sync that starts by itself
	 * (T033) must not keep the screen on.
	 */
	async run(mode: PullMode = "pull"): Promise<void> {
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
		// Named in the question before a first fetch.
		const { owner, repo, branch } = prepared.target;
		const target: PullTarget = { repository: `${owner}/${repo}`, branch };

		const controller = new AbortController();
		this.controller = controller;
		this.wakeLock.hold();
		let end = (): void => {};
		this.ended = new Promise((resolve) => {
			end = resolve;
		});
		this.progress = new Notice(t("pull.progress.starting"), 0);
		try {
			this.opening = true;
			const opened = await host.syncState.open();
			this.opening = false;
			if (controller.signal.aborted) {
				if (this.connectionChanged || this.stopping) this.show(stoppedText(t, this.connectionChanged));
				return;
			}
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
					const answer = await confirmPullIn(host.app, t, target)(request);
					// Not after a "no": nothing is updated then.
					if (!this.stopped && answer !== "cancel") {
						const line = this.stopping ? "pull.progress.stopping" : "pull.progress.applyingStart";
						this.progress = new Notice(t(line), 0);
						this.progressPhase = "";
						// The new line shows nothing of the limit yet.
						this.lastProgress = null;
						this.shownLimit = NO_FETCH_LIMIT;
					}
					return answer;
				},
				...(mode === "first-fetch"
					? {
							// With it go what the device remembers of the zip of the
							// commit (that it gave up on it, and a download left
							// unfinished), so that the first fetch tries the zip again.
							// Emptied in place and not removed: see `startOver`.
							discardState: async (seed) => {
								await opened.store.startOver(seed);
								return opened.store;
							},
						}
					: {}),
				beginBulkWrite: graphViewPause(host.app),
				// Only the files that are fetched one at a time come through
				// here: the pull takes many files from the zip of the commit
				// instead, which is one request and no matter of the quota.
				// Where the number of files to fetch is known, right before
				// the first is asked for: a fetch that does not fit in the
				// quota is told from here on.
				fetchContents: (revision, entries) => {
					const contents = fetchContents(revision, entries);
					this.showLimit();
					return contents;
				},
				archiveGate: this.archiveGate,
				// The estimate of the zip beside its real size, to see later
				// whether the estimate holds.
				log: (message) => console.info(`Sync Evo: ${message}`),
				onProgress: (progress) => this.showProgress(progress),
				signal: controller.signal,
				yieldControl,
				sizeLimit: DEFAULT_SIZE_LIMIT,
			});
			this.report(result, settings);
		} catch (error) {
			// A pull that was stopped while the remote was asked ends by
			// throwing too, and did not fail.
			const cancelled = error instanceof BackendError && error.kind === "cancelled";
			if (!this.stopped && !cancelled) console.error("Sync Evo: the pull failed", error);
			this.show(pullFailureText(t, settings, error, this.connectionChanged), 0);
		} finally {
			this.wakeLock.release();
			this.opening = false;
			this.controller = null;
			this.ended = null;
			this.connectionChanged = false;
			this.stopping = false;
			this.progress?.hide();
			this.progress = null;
			this.progressPhase = "";
			this.progressArchive = undefined;
			this.lastProgress = null;
			this.limitWatch = null;
			this.shownLimit = NO_FETCH_LIMIT;
			// Last: whoever waited for the pull to end may start the next.
			end();
		}
	}

	/**
	 * Stops a running pull because the connection it runs with is being
	 * changed, and resolves when it has ended: between two files, after the
	 * one being written is written and recorded. Resolved at once when no
	 * pull runs. The sync state is discarded after this (`main.ts`), and not
	 * under a pull that still writes to it.
	 */
	interrupt(): Promise<void> {
		if (this.controller === null || this.ended === null) return Promise.resolve();
		this.connectionChanged = true;
		this.controller.abort();
		return this.ended;
	}

	/**
	 * Stops a running pull because the user said so. The line of progress
	 * says at once that it is stopping; the pull ends after the file being
	 * written is written and recorded, without waiting for a request that
	 * is on its way, and then tells that it was stopped. The next pull goes
	 * on from there.
	 */
	requestStop(): void {
		const t = this.host.t;
		if (this.controller === null) {
			new Notice(t("pull.notRunning"));
			return;
		}
		this.stopping = true;
		this.controller.abort();
		// None while a question is open; the line that comes back says it.
		this.progress?.setMessage(t("pull.progress.stopping"));
	}

	/** Stops a running pull between two files, and tells nothing. For when the plugin is unloaded. */
	stop(): void {
		this.stopped = true;
		this.controller?.abort();
		this.progress?.hide();
		this.wakeLock.release();
	}

	/**
	 * For `SyncStateDeps.onDiscardBlocked`. Only a pull that waits for the
	 * state says anything; the text names the wait and not a cause, which
	 * can be another window or nothing but a moment.
	 */
	stateBlocked(): void {
		if (this.opening && !this.stopping) this.progress?.setMessage(this.host.t("state.waiting"));
	}

	private showProgress(progress: PullProgress): void {
		// A pull that is stopping still reports the file it finishes.
		if (this.stopped || this.stopping || this.progress === null) return;
		// After the guard: while a question is open there is no line, and
		// what `showLimit` passes in place of a report must not be kept.
		this.lastProgress = progress;
		const now = Date.now();
		const limit = this.limitWatch?.state() ?? NO_FETCH_LIMIT;
		// A wait that ended takes its line away with the next file.
		const step =
			progress.phase !== this.progressPhase ||
			progress.closedViews !== this.progressClosedViews ||
			progress.archive !== this.progressArchive ||
			!sameFetchLimit(limit, this.shownLimit);
		const last = progress.total > 0 && progress.done === progress.total;
		if (!step && !last && now - this.progressShownAt < PROGRESS_INTERVAL_MS) return;
		this.progressPhase = progress.phase;
		this.progressClosedViews = progress.closedViews;
		this.progressArchive = progress.archive;
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
		const report = pullReport(this.host.t, result, {
			settings,
			sizeLimit: DEFAULT_SIZE_LIMIT,
			connectionChanged: this.connectionChanged,
		});
		this.show(report.summary);
		// Until they are dismissed: each is something to know or to act on.
		for (const detail of report.details) this.show(detail, 0);
	}

	private show(text: string, duration?: number): void {
		if (this.stopped) return;
		new Notice(text, duration);
	}
}
