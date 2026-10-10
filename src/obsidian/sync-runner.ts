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

// Running a sync in the app (a pull, a push, or one after the other):
// gathering what `runPull` and `runPush` are handed, and putting what they
// answer on the screen. Everything that is decided about a sync is in
// `core/`; everything that is worded is in `core/pull-report.ts` and
// `core/push-report.ts`.

import { type App, Notice, type PluginManifest } from "obsidian";
import { ArchiveGate } from "../core/archive-fetch";
import { BackendError } from "../core/backend";
import { connectionCheckText, prepareCheck } from "../core/connection-check";
import { type FetchLimitState, FetchLimitWatch, NO_FETCH_LIMIT, sameFetchLimit } from "../core/fetch-quota";
import { type GitignoreEdit, GitignoreGate } from "../core/gitignore-gate";
import { GitHubBackend } from "../core/github/backend";
import { GitHubClient } from "../core/github/client";
import { timerSleep } from "../core/github/timer-sleep";
import type { Translate } from "../core/i18n";
import { DEFAULT_SIZE_LIMIT } from "../core/plan";
import { type PullDeps, type PullProgress, type PullResult, runPull } from "../core/pull";
import {
	pullFailureText,
	pullProgressText,
	pullReport,
	stateProblemText,
	stoppedText,
} from "../core/pull-report";
import { type PushDeps, type PushProgress, type PushRunResult, runPush, type SectionAdded } from "../core/push";
import {
	pushFailureText,
	pushProgressText,
	pushReport,
	pushStoppedText,
	sectionAddedText,
} from "../core/push-report";
import type { DeviceSettings } from "../core/settings";
import { runSync } from "../core/sync";
import { exclusionPathsOf } from "./exclusion-paths";
import { graphViewPause } from "./graph-views";
import { obsidianHttp } from "./http";
import { confirmPullIn, type PullTarget } from "./pull-confirm";
import { pullVaultOf } from "./pull-vault";
import { confirmPushIn } from "./push-confirm";
import type { SyncState } from "./sync-state";
import { ScreenWakeLock } from "./wake-lock";

/** What a sync needs from the plugin. Read when a sync starts, so that it runs with the settings of that moment. */
export interface SyncHost {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly t: Translate;
	readonly deviceSettings: DeviceSettings | null;
	readonly syncState: SyncState;
	/** The token saved under a name, or `null`. */
	readToken(secretName: string): string | null;
}

/**
 * - "sync": a pull, and then a push (`runSync`).
 * - "pull": from where the sync state stands.
 * - "push": the changes of this device alone.
 * - "first-fetch": the sync state is discarded and the pull starts over,
 *   after one question that says so. No push follows.
 */
export type SyncMode = "sync" | "pull" | "push" | "first-fetch";

// The line of progress is rewritten at most this often. A sync reports
// every file, thousands of them in a second.
const PROGRESS_INTERVAL_MS = 200;

/**
 * The one place a sync is started from, whichever kind it is: one runs at
 * a time, and the command that stops it stops whichever is running.
 */
export class SyncRunner {
	private readonly host: SyncHost;
	/** Set while a sync runs. Aborted to stop it. */
	private controller: AbortController | null = null;
	/** Set while a sync runs: resolves when it has ended, however it ends. */
	private ended: Promise<void> | null = null;
	/** Whether the running sync was stopped because the connection it runs with was changed. */
	private connectionChanged = false;
	/** Whether the user asked the running sync to stop. The line of progress says so until it has. */
	private stopping = false;
	/** Whether the running sync is waiting for the sync state to open. */
	private opening = false;
	/** Which half of the running sync is at work: it words the line of progress, and a failure. */
	private direction: "pull" | "push" = "pull";
	/** What the push last reported, for writing the line again when only the request limit changed. */
	private lastPushProgress: PushProgress | null = null;
	private progress: Notice | null = null;
	private progressShownAt = 0;
	private progressPhase = "";
	private progressClosedViews = false;
	private progressArchive: PullProgress["archive"] = undefined;
	/** What was last reported, for writing the line again when only the request limit changed. */
	private lastProgress: PullProgress | null = null;
	/** Set while a sync runs: what there is to tell about the request limit. */
	private limitWatch: FetchLimitWatch | null = null;
	private shownLimit: FetchLimitState = NO_FETCH_LIMIT;
	/** The plugin is going away: nothing more is shown. */
	private stopped = false;
	/** Across pulls: a pull that is stopped leaves the request for the zip of the commit on its way. */
	private readonly archiveGate = new ArchiveGate();
	private readonly wakeLock = new ScreenWakeLock();
	/**
	 * The one mark of who is at the root `.gitignore`: a sync, or the settings
	 * screen (`editGitignore`). Held here, where every sync starts.
	 */
	private readonly gitignoreGate = new GitignoreGate();

	constructor(host: SyncHost) {
		this.host = host;
	}

	/**
	 * Syncs once, and shows how it went. One sync at a time, of whatever
	 * kind: a second call only says that one is running.
	 *
	 * Called from the handler of a command, and nothing is awaited before
	 * the screen is asked to stay on, which a phone only grants so. Every
	 * sync is started by the user for now. A sync that starts by itself
	 * (T033) must not keep the screen on.
	 */
	async run(mode: SyncMode = "sync"): Promise<void> {
		const { host } = this;
		const t = host.t;
		if (this.controller !== null) {
			new Notice(t("sync.alreadyRunning"));
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
		// From here on the settings screen writes nothing to `.gitignore`.
		// What it is in the middle of is waited for below, not here: nothing
		// is awaited before the screen is asked to stay on.
		const gitignoreEdits = this.gitignoreGate.beginSync();
		this.wakeLock.hold();
		let end = (): void => {};
		this.ended = new Promise((resolve) => {
			end = resolve;
		});
		this.direction = mode === "push" ? "push" : "pull";
		// What the push wrote to `.gitignore`, until its result has told it.
		let sectionAdded: SectionAdded | null = null;
		this.progress = new Notice(t(mode === "push" ? "push.progress.starting" : "pull.progress.starting"), 0);
		try {
			// A read and a write of one small file: waited out rather than
			// answered with "a sync is already running", which it is not.
			await gitignoreEdits;
			this.opening = true;
			const opened = await host.syncState.open();
			this.opening = false;
			if (controller.signal.aborted) {
				if (this.connectionChanged || this.stopping) this.show(this.stoppedText());
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
				// the quota of an hour, and a push of many binary files runs
				// into the limit on creating content. The requests that run
				// together ask once, and the line of progress says until when.
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
			const pullDeps: PullDeps = {
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
					const answer = await confirmPullIn(host.app, t, target, controller.signal)(request);
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
			};
			const pushDeps: Omit<PushDeps, "hold"> = {
				store: opened.store,
				backend,
				vault: pullDeps.vault,
				paths: pullDeps.paths,
				deviceName: settings.deviceName,
				now: Date.now,
				confirm: async (request) => {
					// As for a pull: the line of progress would cover the question.
					this.progress?.hide();
					this.progress = null;
					const answer = await confirmPushIn(host.app, t, target, controller.signal)(request);
					if (!this.stopped && answer === "proceed") {
						const line = this.stopping ? "push.progress.stopping" : "push.progress.sendingStart";
						this.progress = new Notice(t(line), 0);
						this.progressPhase = "";
						this.lastPushProgress = null;
						this.shownLimit = NO_FETCH_LIMIT;
					}
					return answer;
				},
				onSectionAdded: (added) => {
					sectionAdded = added;
				},
				onProgress: (progress) => this.showPushProgress(progress),
				signal: controller.signal,
				yieldControl,
				sizeLimit: DEFAULT_SIZE_LIMIT,
				log: (message) => console.info(`Sync Evo: ${message}`),
			};

			if (mode === "push") {
				const result = await runPush(pushDeps);
				sectionAdded = null;
				this.reportPush(result);
			} else if (mode === "sync") {
				// The pull is told before the push begins: its result is
				// not held back by a push that asks, or fails.
				const { push } = await runSync({
					pull: pullDeps,
					push: pushDeps,
					onPulled: (result) => {
						this.report(result, settings);
						this.direction = "push";
					},
				});
				sectionAdded = null;
				if (push !== null) this.reportPush(push);
			} else {
				this.report(await runPull(pullDeps), settings);
			}
		} catch (error) {
			// A pull that was stopped while the remote was asked ends by
			// throwing too, and did not fail.
			const cancelled = error instanceof BackendError && error.kind === "cancelled";
			if (!this.stopped && !cancelled) console.error(`Sync Evo: the ${this.direction} failed`, error);
			const failure = this.direction === "push" ? pushFailureText : pullFailureText;
			this.show(failure(t, settings, error, this.connectionChanged), 0);
			// A push that failed has no result to tell it with, and the file
			// on this device is changed all the same. Whether it reached the
			// remote before the failure is not known.
			if (sectionAdded !== null) this.show(sectionAddedText(t, sectionAdded, "unknown"), 0);
		} finally {
			this.wakeLock.release();
			this.gitignoreGate.endSync();
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
			this.lastPushProgress = null;
			this.direction = "pull";
			this.limitWatch = null;
			this.shownLimit = NO_FETCH_LIMIT;
			// Last: whoever waited for the sync to end may start the next.
			end();
		}
	}

	/**
	 * Stops a running sync because the connection it runs with is being
	 * changed, and resolves when it has ended: a pull between two files,
	 * after the one being written is written and recorded; a push before
	 * the branch is moved, or else after it has recorded what it sent.
	 * Resolved at once when no sync runs. The sync state is discarded after
	 * this (`main.ts`), and not under a sync that still writes to it. A
	 * question the sync has open is closed as a "no", so that this does not
	 * wait for the user to answer it.
	 *
	 * A write of the settings screen to `.gitignore` that is under way is
	 * waited for as well: it remembers what it writes in the sync state.
	 */
	interrupt(): Promise<void> {
		// With no sync running, only the settings can be at the file.
		if (this.controller === null || this.ended === null) return this.gitignoreGate.idle();
		this.connectionChanged = true;
		this.controller.abort();
		// A sync that runs has waited for the settings before anything else.
		return this.ended;
	}

	/**
	 * Runs work of the settings screen on the root `.gitignore`, a read as
	 * much as a write, unless a sync is running. While it runs no sync
	 * begins: one that is started waits for it (`run`).
	 */
	editGitignore<T>(work: () => Promise<T>): Promise<GitignoreEdit<T>> {
		return this.gitignoreGate.edit(work);
	}

	/**
	 * Stops a running sync because the user said so. The line of progress
	 * says at once that it is stopping. A pull ends after the file being
	 * written is written and recorded, without waiting for a request that
	 * is on its way, and then tells that it was stopped; the next pull goes
	 * on from there. A push ends before the next thing it would send, with
	 * nothing sent; once it has moved the branch, it is done but for its
	 * own records, and finishes those.
	 */
	requestStop(): void {
		const t = this.host.t;
		if (this.controller === null) {
			new Notice(t("pull.notRunning"));
			return;
		}
		this.stopping = true;
		this.controller.abort();
		// None while a question is open. The question is closed by the stop,
		// as a "no" (`closeWhenAborted`), and no line comes back after that.
		this.progress?.setMessage(t(this.direction === "push" ? "push.progress.stopping" : "pull.progress.stopping"));
	}

	/** Stops a running sync, and tells nothing. For when the plugin is unloaded. */
	stop(): void {
		this.stopped = true;
		this.controller?.abort();
		this.progress?.hide();
		this.wakeLock.release();
	}

	/**
	 * For `SyncStateDeps.onDiscardBlocked`. Only a sync that waits for the
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

	/** The line of progress of a push. Like `showProgress`, with only the wait for a limit beside it. */
	private showPushProgress(progress: PushProgress): void {
		if (this.stopped || this.stopping || this.progress === null) return;
		this.lastPushProgress = progress;
		const now = Date.now();
		const waitingUntil = this.limitWatch?.state().waitingUntil ?? null;
		const phase = `push ${progress.phase}`;
		const step = phase !== this.progressPhase || waitingUntil !== this.shownLimit.waitingUntil;
		const last = progress.total > 0 && progress.done === progress.total;
		if (!step && !last && now - this.progressShownAt < PROGRESS_INTERVAL_MS) return;
		this.progressPhase = phase;
		this.shownLimit = { waitingUntil, quota: null };
		this.progressShownAt = now;
		this.progress.setMessage(pushProgressText(this.host.t, progress, waitingUntil));
	}

	/**
	 * Writes the line of progress again when what there is to tell about the
	 * request limit changed. While a limit is waited out no file is reported,
	 * so the line would not change by itself.
	 */
	private showLimit(): void {
		if (this.direction === "push") {
			const waitingUntil = this.limitWatch?.state().waitingUntil ?? null;
			if (waitingUntil === this.shownLimit.waitingUntil) return;
			this.showPushProgress(this.lastPushProgress ?? { phase: "sending", done: 0, total: 0 });
			return;
		}
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

	private reportPush(result: PushRunResult): void {
		if (this.stopped) return;
		const report = pushReport(this.host.t, result, {
			sizeLimit: DEFAULT_SIZE_LIMIT,
			connectionChanged: this.connectionChanged,
		});
		this.show(report.summary);
		for (const detail of report.details) this.show(detail, 0);
	}

	/** The text for a sync that was stopped before it could begin. */
	private stoppedText(): string {
		const t = this.host.t;
		return this.direction === "push"
			? pushStoppedText(t, this.connectionChanged)
			: stoppedText(t, this.connectionChanged);
	}

	private show(text: string, duration?: number): void {
		if (this.stopped) return;
		new Notice(text, duration);
	}
}
