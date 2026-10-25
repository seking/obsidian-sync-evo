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

// Running a sync in the app (a pull, a push, one after the other, or a pull
// and the untracking that comes after it): gathering what `runPull`, `runPush` and
// `runUntrackSync` are handed, and putting what they answer on the screen.
// Everything that is decided about a sync is in `core/`; everything that is
// worded is in `core/pull-report.ts`, `core/push-report.ts` and
// `core/untrack-report.ts`.

import { type App, Notice, type PluginManifest } from "obsidian";
import { ArchiveGate } from "../core/archive-fetch";
import {
	type AutoReport,
	autoNotices,
	autoResults,
	failureAutoReport,
	joinAutoReports,
	notReadyAutoReport,
	paidAutoReport,
	pullAutoReport,
	pushAutoReport,
	settleAutoSync,
	stateAutoReport,
} from "../core/auto-report";
import {
	type AutoCheck,
	type AutoSyncClock,
	type AutoSyncMemory,
	FullCheckDebt,
	NO_AUTO_SYNC_MEMORY,
	readAutoSyncMemory,
	writeAutoSyncMemory,
} from "../core/auto-sync";
import { BackendError } from "../core/backend";
import { connectionCheckText, nothingEntered, prepareCheck } from "../core/connection-check";
import type { DeviceExclusion } from "../core/device-exclusion";
import type { ExclusionPaths } from "../core/exclusion";
import { excludedOnRemoteCount } from "../core/exclusion-settings";
import { type EditingFact, isBeingEdited } from "../core/editing";
import { failureLine } from "../core/failure-line";
import { type FetchLimitState, FetchLimitWatch, NO_FETCH_LIMIT, sameFetchLimit } from "../core/fetch-quota";
import { type GitignoreEdit, GitignoreGate } from "../core/gitignore-gate";
import type { Backend } from "../core/backend";
import type { AccessTokens } from "../../pro/src/core/dropbox/client";
import { DriveFolderGoneError } from "../../pro/src/core/gdrive/errors";
import { DriveQuota } from "../../pro/src/core/gdrive/quota";
import { paidNoteText, paidWarningText } from "../../pro/src/core/paid";
import type { PaidGate } from "../../pro/src/core/paid-gate";
import { dropboxRemote, driveRemote } from "../../pro/src/obsidian/remotes";
import { GitHubBackend } from "../core/github/backend";
import { GitHubClient, HeadMemory } from "../core/github/client";
import type { MessageKey, Translate } from "../core/i18n";
import { DEFAULT_SIZE_LIMIT } from "../core/plan";
import { type PullDeps, type PullProgress, type PullResult, runPull } from "../core/pull";
import {
	NOTICE_LIST_LIMIT,
	type NoticeLevel,
	type PartReport,
	pullFailureText,
	pullPart,
	pullProgressText,
	stateProblemText,
	stoppedText,
} from "../core/pull-report";
import { type PushDeps, type PushProgress, type PushRunResult, runPush, type SectionAdded } from "../core/push";
import {
	pushFailureText,
	pushPart,
	pushProgressText,
	pushStoppedText,
	sectionAddedText,
} from "../core/push-report";
import { SentBlobMemory } from "../core/sent-blobs";
import type { DeviceSettings } from "../core/settings";
import type { StateStore } from "../core/state";
import { runSync } from "../core/sync";
import {
	paragraphs,
	partNotices,
	partResults,
	type ResultItem,
	type SyncResult,
} from "../core/sync-results";
import { runUntrackSync, type UntrackDeps, type UntrackStep, type UntrackSyncResult } from "../core/untrack";
import { untrackFailureText, untrackPart } from "../core/untrack-report";
import { askEmptyVaultIn } from "./empty-vault-confirm";
import { exclusionPathsOf } from "./exclusion-paths";
import { graphViewPause } from "./graph-views";
import { deviceNetwork } from "./http";
import { log } from "./log";
import { confirmPullIn, type PullTarget } from "./pull-confirm";
import { pullVaultOf } from "./pull-vault";
import { confirmPushIn } from "./push-confirm";
import type { SyncState } from "./sync-state";
import { vaultIndexOf } from "./vault-index";
import { phoneListingOf } from "./folder-stats";
import { ScreenWakeLock } from "./wake-lock";
import { windowSleep } from "./window-sleep";

/** What a sync needs from the plugin. Read when a sync starts, so that it runs with the settings of that moment. */
export interface SyncHost {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly t: Translate;
	readonly deviceSettings: DeviceSettings | null;
	readonly syncState: SyncState;
	/** The token saved under a name, or `null`. */
	readToken(secretName: string): string | null;
	/** The refresh token of Dropbox this device keeps, or `null` while it is not connected. */
	readDropboxToken(): string | null;
	/**
	 * Where the access tokens of Dropbox come from, for this refresh token:
	 * the same for every sync while the refresh token is, so that a token is
	 * taken again only once it ends.
	 */
	dropboxTokens(refreshToken: string): AccessTokens;
	/** The refresh token of Google Drive this device keeps, or `null` while it is not connected. */
	readGdriveToken(): string | null;
	/**
	 * The secret this device keeps for a client of Google of the user's own
	 * (`DeviceSettings.gdriveClientId`), or "". The tokens are taken in the
	 * paid part, with the client the plan is decided by (`remotes.ts`).
	 */
	gdriveClientSecret(): string;
	/** The id of the folder of the vault on Drive, found or made by a sync, for these settings. */
	driveFolderFound?(id: string, account: string, folder: string): void;
	/** The folder of that id is gone from Drive: the sync state is discarded (R-3). */
	driveFolderGone?(id: string): void;
	/** What was seen of where the user types (`editing-watch.ts`). Asked by a sync that started by itself. */
	readonly editing: { facts(): readonly EditingFact[] };
	/**
	 * Copies the kinds of file an earlier version left out in the section of
	 * the root `.gitignore` to what this device alone does not sync, once.
	 * Never rejects.
	 */
	adoptSectionKinds?(): Promise<void>;
	/**
	 * Remembers that the change of what an exclusion does was told
	 * (`DeviceSettings.exclusionChangeTold`).
	 */
	exclusionChangeTold?(): void;
	/** Where the results of the syncs that had something to tell are kept (`results-store.ts`). */
	readonly results?: { add(result: SyncResult): Promise<void> };
	/**
	 * The paid plan of Dropbox and Google Drive (`paid-gate.ts`): what a
	 * sync is let do, decided before it starts and told. Absent, nothing of
	 * it is told; the backends of those services keep to it all the same
	 * (`paid-guard.ts`).
	 */
	readonly paid?: Pick<PaidGate, "check" | "sinceWanted" | "sinceLearned">;
}

/**
 * - "sync": a pull, and then a push (`runSync`).
 * - "pull": from where the sync state stands.
 * - "push": the changes of this device alone.
 * - "first-fetch": the sync state is discarded and the pull starts over,
 *   after one question that says so. No push follows.
 * - "untrack": a pull, and then the files that were confirmed are taken out
 *   of the remote, in one commit with the rules of `.gitignore` where the
 *   remote does not hold them yet (`runUntrackSync`). Asked before it is
 *   started (`untrack-confirm.ts`), and not by the sync.
 */
export type SyncMode = "sync" | "pull" | "push" | "first-fetch" | "untrack";

/** The part of a sync that is at work: a pull, a push, or the one commit of an untracking. */
type Direction = UntrackStep | "push";

const STOPPING_LINES = {
	pull: "pull.progress.stopping",
	push: "push.progress.stopping",
	untrack: "untrack.progress.stopping",
} as const satisfies Record<Direction, MessageKey>;

// The line of progress is rewritten at most this often. A sync reports
// every file, thousands of them in a second.
const PROGRESS_INTERVAL_MS = 200;

// A sync that started by itself shows no line of progress until it has run
// this long. It usually ends within it, having shown nothing at all; one
// that takes longer is then seen to be running, and can be stopped.
const AUTO_PROGRESS_DELAY_MS = 5000;

/** A button on a notice, with what a tap on it does. */
interface NoticeAction {
	readonly label: string;
	readonly run: () => void;
}

/**
 * The settings of the app, as far as they are opened here. Not in the
 * types of the API, which have no way to open them; the app has had these
 * two for long, and a version without them gets no settings opened.
 */
interface AppSettings {
	open?(): void;
	openTabById?(id: string): unknown;
}

/** Opens the settings of the app on the tab of this plugin. */
function openSettings(app: App, id: string): void {
	const setting = (app as App & { setting?: AppSettings }).setting;
	setting?.open?.();
	setting?.openTabById?.(id);
}

/** How many of the notices that stay are kept track of, for taking them away while a question is asked. */
const STAYING_NOTICES = 12;

/**
 * How long a notice that goes by itself stays, when it says more than a
 * line: a summary with the short lines of what is only worth knowing.
 */
const LONG_NOTICE_MS = 10_000;

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
	/** Which part of the running sync is at work: it words the line of progress, and a failure. */
	private direction: Direction = "pull";
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
	/**
	 * What the head of the branch was last answered with, across syncs, so
	 * that the next one asks conditionally (`HeadMemory`). In memory alone.
	 */
	private readonly heads = new HeadMemory();
	/**
	 * The units of the Drive API this device has used (`DriveQuota`), from
	 * one sync to the next: a sync that follows a large one does not start
	 * with the burst again. In memory alone.
	 */
	private readonly driveQuota = new DriveQuota();
	/**
	 * What automatic sync goes by (`auto-sync.ts`): when the last sync
	 * started, and what was told. This copy is the one that is read; the
	 * sync state holds it for the next start of the app, and is written
	 * after it. The start of a sync is set here at once, before anything is
	 * awaited, so that the clock sees it also when the sync state cannot be
	 * opened.
	 */
	private memory: AutoSyncMemory = NO_AUTO_SYNC_MEMORY;
	/** Whether `memory` holds what the sync state remembers of failures and of what was told. */
	private recalled = false;
	/** Whether the sync state was asked for it, outside a sync (`recallAuto`). */
	private recallAsked = false;
	/** Whether the next automatic sync has to list every folder (`FullCheckDebt`). */
	private readonly debt = new FullCheckDebt();
	/** Counts the changes of the connection, for whoever waited through one. */
	private connectionChanges = 0;
	/** Set while a sync that started by itself runs: nothing is shown as it goes. */
	private quiet = false;
	/**
	 * Set while a sync the user started waits for one that started by
	 * itself to end, which it has stopped (`takeOver`). That one tells
	 * nothing of the stop and remembers nothing, and leaves the screen on.
	 */
	private takingOver = false;
	/** Whether the user asked for a stop during that wait: the sync that waits does not start. */
	private takeOverStopped = false;
	/** The timer that puts up the line of progress of such a sync, until it has. */
	private late: number | null = null;
	/** The running sync, part by part, as a sync that started by itself tells it (`auto-report.ts`). */
	private parts: AutoReport[] = [];
	/**
	 * The notices of syncs that started by themselves that say a question
	 * waits for a sync the user starts (`AutoReport.questions`), until one
	 * does. They stay until dismissed, and would lie over that question.
	 */
	private questions: Notice[] = [];
	/** The notices of this plugin that stay until they are tapped, with their text and level (`whileAsking`). */
	private staying: { notice: Notice; text: string; level: NoticeLevel; action: NoticeAction | undefined }[] = [];
	/** What the running sync has told, with every path, for the screen of the results. */
	private told: ResultItem[] = [];
	/** How each part of the running sync ended, for the screen of the results. */
	private summaries: string[] = [];
	/**
	 * Whether the push of the running sync ended on the answer that the
	 * vault is to get its files from the remote again
	 * (`PushRunResult.refetch`): the first fetch follows, once this sync
	 * has ended.
	 */
	private refetchAsked = false;

	constructor(host: SyncHost) {
		this.host = host;
	}

	/** Whether a sync is running, of whatever kind. */
	get running(): boolean {
		return this.controller !== null;
	}

	/** What the decision to sync by itself goes by, apart from the settings and the time. */
	autoClock(): Omit<AutoSyncClock, "now"> {
		const { lastStartedAt, failures, pausedUntil } = this.memory;
		return { lastStartedAt, failures, fullOwed: this.debt.isOwed, ...(pausedUntil === undefined ? {} : { pausedUntil }) };
	}

	/** The app has started, or has come back to the front: the next automatic sync is a full one. */
	resumed(): void {
		this.debt.resumed();
	}

	/**
	 * Reads what automatic sync remembers from the sync state, once: for
	 * the decision when the app has started, which no sync has come before.
	 * Only called while there is a connection and automatic sync is on;
	 * with it off, nothing is opened for this. A start of a sync that is
	 * known here already is the later one, and stays. Never rejects: with
	 * no sync state to read, nothing is remembered, and a sync is due.
	 */
	async recallAuto(): Promise<void> {
		if (this.recalled || this.recallAsked) return;
		this.recallAsked = true;
		try {
			const opened = await this.host.syncState.open();
			if (this.stopped) {
				// Let go of while this waited for it, and opened since.
				this.host.syncState.close();
				return;
			}
			// A sync that began meanwhile has read it itself, and a change
			// of the connection has made it another state's.
			if (opened.status !== "ok" || this.recalled || !this.recallAsked) return;
			this.recall(await readAutoSyncMemory(opened.store));
		} catch {
			// The first sync reads it again.
		}
	}

	private recall(stored: AutoSyncMemory): void {
		this.memory = { ...stored, lastStartedAt: this.memory.lastStartedAt ?? stored.lastStartedAt };
		this.recalled = true;
	}

	/**
	 * Syncs by itself: what `run` does, without anyone looking. Called by
	 * the clock (`auto-scheduler.ts`), which has decided that one is due.
	 *
	 * - A pull and then a push when automatic sync also sends, a pull alone
	 *   when it does not.
	 * - Nothing is said when a sync is running already, when there is no
	 *   connection to sync with, or when it went well. No line of progress,
	 *   unless it runs long (`AUTO_PROGRESS_DELAY_MS`).
	 * - The screen is not asked to stay on: it usually ends in seconds, and
	 *   one that the lock of the screen stops goes on the next time.
	 * - No question is asked. A sync that comes to one changes nothing, and
	 *   says once that a sync the user starts will ask. No first fetch is
	 *   begun, and no section is added to `.gitignore`: both are the user's
	 *   to see first.
	 * - A request limit is not waited out: the sync fails, and a later one
	 *   goes on from there.
	 * - What stands in its way is told once per cause (`auto-report.ts`).
	 * - A file the user is typing in right now is left as it is, by the pull
	 *   and by the push, and taken up by a later sync (`core/editing.ts`).
	 *
	 * `check`: how the vault is looked at (`AutoCheck`).
	 */
	runAuto(check: AutoCheck): Promise<void> {
		const settings = this.host.deviceSettings;
		const mode = settings?.autoSync.sendsChanges === true ? "sync" : "pull";
		return this.start(mode, [], check);
	}

	/**
	 * Syncs once, and shows how it went. One sync at a time, of whatever
	 * kind: a second call only says that one is running.
	 *
	 * Called from the handler of a command, and nothing is awaited before
	 * the screen is asked to stay on, which a phone only grants so. A sync
	 * that starts by itself does not come through here (`runAuto`), and
	 * does not keep the screen on.
	 *
	 * `shown` is only for "untrack": the paths the user confirmed
	 * (`UntrackQuestion.shown`).
	 */
	run(mode: SyncMode = "sync", shown: readonly string[] = []): Promise<void> {
		this.hideQuestions();
		// A sync that started by itself is in the way. The user sees none
		// running, and is not told that one is.
		if (this.controller !== null && this.quiet && !this.takingOver && !this.stopped) {
			return this.takeOver(mode, shown);
		}
		return this.start(mode, shown, null);
	}

	/**
	 * What the user was told to do is being done: the questions that wait
	 * for a sync by hand go off the screen. Only off the screen: what was
	 * told stays remembered as told.
	 */
	private hideQuestions(): void {
		for (const notice of this.questions) notice.hide();
		// Nor are they put back after a question (`whileAsking`): a notice
		// that was told to go is still on the screen for a moment.
		this.staying = this.staying.filter(({ notice }) => !this.questions.includes(notice));
		this.questions = [];
	}

	/**
	 * Runs a sync the user started in the place of one that started by
	 * itself: that one is stopped, quietly, and this one begins when it has
	 * ended. A pull that is stopped so is gone on with by this one; a push
	 * that has moved the branch finishes its records first.
	 *
	 * The screen is asked to stay on here, before anything is awaited, and
	 * let go of again on every way out.
	 */
	private async takeOver(mode: SyncMode, shown: readonly string[]): Promise<void> {
		const ended = this.ended;
		const changes = this.connectionChanges;
		this.takingOver = true;
		this.takeOverStopped = false;
		this.wakeLock.hold();
		try {
			this.controller?.abort();
			try {
				await ended;
			} finally {
				this.takingOver = false;
			}
			// The one that was stopped may have been past its end already,
			// and have put its question up while it was waited for.
			this.hideQuestions();
			// The plugin went away, or the user said stop after all.
			if (this.stopped || this.takeOverStopped) return;
			// The connection was changed meanwhile. What was asked for was
			// asked of the one from before: the paths to untrack are that
			// remote's.
			if (changes !== this.connectionChanges) {
				const t = this.host.t;
				this.show(mode === "push" ? pushStoppedText(t, true) : stoppedText(t, true));
				return;
			}
			await this.start(mode, shown, null);
		} finally {
			// Held by the sync that ran, and let go of by it; held by
			// nothing when none began.
			this.wakeLock.release();
		}
	}

	/**
	 * `run`, and `runAuto` with `auto` set to how the vault is looked at.
	 * Nothing is awaited before the screen is asked to stay on. `asked`: the
	 * kind of sync that was asked for, which the paid plan may change.
	 */
	private async start(asked: SyncMode, shown: readonly string[], auto: AutoCheck | null): Promise<void> {
		const { host } = this;
		const t = host.t;
		if (this.stopped) return;
		if (this.controller !== null) {
			if (auto === null) new Notice(t("sync.alreadyRunning"));
			return;
		}

		const settings = host.deviceSettings;
		if (settings === null) {
			if (auto === null) new Notice(t("settings.unknownVersion"));
			return;
		}
		const prepared = prepareCheck(
			settings,
			(name) => host.readToken(name),
			() => host.readDropboxToken(),
			() => host.readGdriveToken(),
		);
		if (prepared.status === "not-ready") {
			const text = connectionCheckText(t, settings, prepared);
			if (auto === null) {
				// Stays, with the way to the settings on it: a sync the user
				// started has nothing else to show, and nothing is kept for
				// the screen of the results.
				const shown = nothingEntered(settings) ? t("check.notSetUp") : text;
				this.show(shown, 0, "warn", { label: t("notice.openSettings"), run: () => openSettings(host.app, host.manifest.id) });
			} else {
				// With a repository and a branch there is a connection, and a
				// sync state to remember this in. Without, none is ever opened.
				// Dropbox is connected once it was: the account stays when
				// the user disconnects.
				const connected =
					prepared.reason === "dropbox-account"
						? settings.dropboxAccount !== null
						: prepared.reason === "gdrive-account"
							? settings.gdriveAccount !== null
							: prepared.reason !== "repository" &&
								prepared.reason !== "branch" &&
								prepared.reason !== "dropbox-folder" &&
								prepared.reason !== "gdrive-folder";
				this.notReady(notReadyAutoReport(t, prepared.reason, text), connected);
			}
			return;
		}
		// The paid plan of Dropbox and Google Drive (T082), decided here,
		// before anything starts, and never in the middle of a sync. After
		// the free time a sync becomes a download, and an upload does not
		// start; after the time for downloads, nothing does.
		// The backends of Dropbox and Google Drive refuse on their own as
		// well (`paid-guard.ts`); this is where the user is told.
		const paid = host.paid?.check(settings, asked) ?? null;
		const paidNote = paid === null ? null : paidNoteText(t, paid.verdict, paid.standing);
		if (paid !== null && paid.warning !== null) {
			const warning = paidWarningText(t, paid.standing, paid.now);
			// Told once for each, and remembered as told (`PaidGate.check`).
			if (warning !== null) this.show(warning, 0, "warn");
		}
		if (paid !== null && paid.verdict.mode === null) {
			const text = paidNote ?? "";
			log(`${asked}: not started (${auto === null ? "by hand" : "automatic"}): paid plan, ${paid.standing.status}`);
			if (auto === null) this.show(text, 0, "warn");
			else this.notReady(paidAutoReport(t, paid.verdict.note ?? "stopped", false, text), true);
			return;
		}
		let mode: SyncMode = paid?.verdict.mode ?? asked;

		// Named in the question before a first fetch.
		const remote = prepared.target;
		const target: PullTarget =
			remote.kind === "dropbox"
				? { backend: "dropbox", folder: remote.folder }
				: remote.kind === "gdrive"
					? { backend: "gdrive", folder: remote.folder }
					: { backend: "github", repository: `${remote.owner}/${remote.repo}`, branch: remote.branch };

		const controller = new AbortController();
		this.controller = controller;
		// Every sync, of whatever kind and however it ends, is what the next
		// automatic one is counted from.
		this.memory = { ...this.memory, lastStartedAt: Date.now() };
		// Every sync the user starts lists every folder.
		const check: AutoCheck = auto ?? "full";
		// For a line of the log that says the sync failed.
		const startedBy = auto === null ? "by hand" : "automatic";
		this.quiet = auto !== null;
		this.parts = [];
		this.told = [];
		this.summaries = [];
		if (paidNote !== null) this.tellReadOnly(paidNote, auto !== null);
		// The sync state, once it is open: what is remembered is stored there.
		let store: StateStore | null = null;
		// From here on the settings screen writes nothing to `.gitignore`.
		// What it is in the middle of is waited for below, not here: nothing
		// is awaited before the screen is asked to stay on.
		const gitignoreEdits = this.gitignoreGate.beginSync();
		if (auto === null) this.wakeLock.hold();
		let end = (): void => {};
		this.ended = new Promise((resolve) => {
			end = resolve;
		});
		this.direction = mode === "push" ? "push" : "pull";
		// What the push wrote to `.gitignore`, until its result has told it.
		let sectionAdded: SectionAdded | null = null;
		// Whether the first fetch follows this sync (`refetchAsked`).
		let refetch = false;
		// The id of the folder on Drive that is no longer to be seen, to let
		// go of once this sync has ended (`driveFolderGone`).
		let goneFolder: string | null = null;
		// What saves the sent blobs when the app goes to the back, while this sync runs.
		let onHidden: (() => void) | null = null;
		// Asks the service when the count of the free time of the account
		// started (`paid.ts`), for a sync that does not know it yet: `null`
		// for nothing to ask.
		let learnSince: (() => Promise<number | null>) | null = null;
		if (auto === null) {
			this.progress = new Notice(t(mode === "push" ? "push.progress.starting" : "pull.progress.starting"), 0);
		} else {
			this.late = window.setTimeout(() => this.showLate(), AUTO_PROGRESS_DELAY_MS);
		}
		try {
			if (auto !== null) log(`automatic sync: ${mode}, ${auto} check`);
			// A read and a write of one small file: waited out rather than
			// answered with "a sync is already running", which it is not.
			await gitignoreEdits;
			// Before the rules are read: the settings it changes are what
			// this sync goes by.
			await host.adoptSectionKinds?.();
			const device = (host.deviceSettings ?? settings).deviceExclusion;
			this.opening = true;
			const opened = await host.syncState.open();
			this.opening = false;
			if (controller.signal.aborted) {
				if (!this.quiet && (this.connectionChanged || this.stopping)) this.show(this.stoppedText());
				return;
			}
			if (opened.status !== "ok") {
				const problem = opened.status === "unavailable" ? opened.reason : opened.status;
				log(`${this.direction}: failed (${mode}, ${startedBy}): the sync state could not be opened: ${problem}`);
				this.parts.push(stateAutoReport(t, problem));
				if (!this.quiet) {
					const text = stateProblemText(t, problem);
					this.told.push({ level: "error", text });
					this.show(text, 0, "error");
				}
				return;
			}
			store = opened.store;
			await this.rememberStart(opened.store);
			// The blobs a push sends, remembered for the push that goes on
			// from where one stopped. Saved here at the two moments the
			// push cannot see: before a wait for the remote's limit, and
			// when the app goes to the back, after which a phone may run
			// nothing more of this sync.
			const sentBlobs = new SentBlobMemory(opened.store, Date.now, log);
			onHidden = () => {
				if (document.visibilityState === "hidden") void sentBlobs.save();
			};
			document.addEventListener("visibilitychange", onHidden);

			const yieldControl = (): Promise<void> => windowSleep(0);
			// Only a sync that started by itself keeps away from a file that
			// is being typed in. Starting one by hand ends the typing.
			const beingEdited =
				auto === null ? {} : { beingEdited: (path: string) => isBeingEdited(host.editing.facts(), path, Date.now()) };
			const network = deviceNetwork();
			// Dropbox tells no quota: a wait it asks for is waited out by its client.
			let limitWatch = new FetchLimitWatch(() => null, Date.now);
			let backend: Backend;
			if (remote.kind === "gdrive") {
				const account = settings.gdriveAccount?.id ?? "";
				const drive = driveRemote(settings, remote, {
					http: network.http,
					sleep: windowSleep,
					signal: controller.signal,
					clientSecret: host.gdriveClientSecret(),
					quota: this.driveQuota,
					log,
					maxConcurrentFetchBytes: network.maxConcurrentFetchBytes,
					onFolderFound: (id) => host.driveFolderFound?.(id, account, remote.folder),
				});
				backend = drive.backend;
				learnSince = drive.learnSince;
			} else if (remote.kind === "dropbox") {
				const dropbox = dropboxRemote(settings, remote, {
					http: network.http,
					sleep: windowSleep,
					signal: controller.signal,
					tokens: (refreshToken) => host.dropboxTokens(refreshToken),
					yieldControl,
					log,
					maxConcurrentFetchBytes: network.maxConcurrentFetchBytes,
				});
				backend = dropbox.backend;
				learnSince = dropbox.learnSince;
			} else {
				const client: GitHubClient = new GitHubClient({
					...remote,
					http: network.http,
					now: Date.now,
					sleep: windowSleep,
					signal: controller.signal,
					headMemory: this.heads,
					// Waited out: a fetch of thousands of files does not fit in
					// the quota of an hour, and a push of many binary files runs
					// into the limit on creating content. The requests that run
					// together ask once, and the line of progress says until when.
					// Not by a sync that started by itself: it fails, and a later
					// one goes on from where it stopped.
					onRateLimit: (notice) => {
						// Before the wait, which may be as long as an hour and
						// may be the last thing this sync does.
						void sentBlobs.save();
						if (auto !== null) return false;
						limitWatch.rateLimited(notice.until);
						this.showLimit();
						return true;
					},
					// Whether the head was answered with a 304, and each wait
					// for a limit, to be read on a device.
					log,
				});
				limitWatch = new FetchLimitWatch(() => client.quota, Date.now);
				backend = new GitHubBackend(client, {
					yieldControl,
					signal: controller.signal,
					maxConcurrentFetchBytes: network.maxConcurrentFetchBytes,
				});
			}
			// The start of the free time of the account, once for this
			// device, and what the sync is let do decided again with it:
			// before the vault or the remote is touched, so that a sync that
			// does not start is not one stopped halfway. A failure fails
			// nothing: the next sync asks again.
			const paidHost = host.paid;
			if (paidHost !== undefined && learnSince !== null && paidHost.sinceWanted(settings)) {
				// A stop, and what the lookup of the folder of the vault meets,
				// end the sync as the pull would: once, and as what they are.
				const since = await learnSince();
				if (since !== null) {
					paidHost.sinceLearned(settings, since);
					const again = paidHost.check(settings, asked);
					if (again.warning !== null) {
						const warning = paidWarningText(t, again.standing, again.now);
						if (warning !== null) this.show(warning, 0, "warn");
					}
					const note = paidNoteText(t, again.verdict, again.standing);
					if (again.verdict.mode === null) {
						const text = note ?? "";
						log(`${asked}: not started (${startedBy}): paid plan, ${again.standing.status}`);
						this.parts.push(paidAutoReport(t, again.verdict.note ?? "stopped", false, text));
						// As before a sync starts: shown, and not kept as a result.
						if (!this.quiet) this.show(text, 0, "warn");
						return;
					}
					mode = again.verdict.mode;
					if (note !== null) this.tellReadOnly(note, this.quiet);
				}
			}
			this.limitWatch = limitWatch;
			const fetchContents = limitWatch.watch((revision, entries) => backend.fetch(revision, entries));
			// For a check that walks the vault, on a phone (`folder-stats.ts`).
			const phone = phoneListingOf(host.app);
			const listedStats = phone?.stats;
			const pullDeps: PullDeps = {
				store: opened.store,
				backend,
				vault: pullVaultOf(host.app, phone),
				paths: exclusionPathsOf(host.app, host.manifest),
				device,
				pluginId: host.manifest.id,
				deviceName: settings.deviceName,
				mergeConflicts: settings.onConflict === "merge",
				now: Date.now,
				confirm: async (request) => {
					// No one is there to ask. Nothing is opened, and the
					// question waits for a sync the user starts.
					// (`automatic` below: the pull does not come here.)
					if (auto !== null) return "later";
					const answer = await this.whileAsking(() => confirmPullIn(host.app, t, target, controller.signal)(request));
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
							// unfinished), so that the first fetch tries the zip again (on a
							// device that may use it).
							// Emptied in place and not removed: see `startOver`.
							discardState: async (seed) => {
								await opened.store.startOver(seed);
								return opened.store;
							},
						}
					: {}),
				automatic: auto !== null,
				...beingEdited,
				// At an interval the vault is not walked.
				...(auto === "light" ? { index: vaultIndexOf(host.app) } : {}),
				...(listedStats === undefined ? {} : { listedStats }),
				beginBulkWrite: graphViewPause(host.app),
				// Only the files that are fetched one at a time come through
				// here: the pull takes many files from the zip of the commit
				// instead, which is one request and no matter of the quota.
				// On a device that may not use the zip (`archiveAllowed`),
				// every file does.
				// Where the number of files to fetch is known, right before
				// the first is asked for: a fetch that does not fit in the
				// quota is told from here on.
				fetchContents: (revision, entries) => {
					const contents = fetchContents(revision, entries);
					this.showLimit();
					return contents;
				},
				archiveGate: this.archiveGate,
				// Not on Android (`archiveAllowedFor`).
				archiveAllowed: network.archiveAllowed,
				// The estimate of the zip beside its real size, to see later
				// whether the estimate holds.
				log,
				onProgress: (progress) => {
					// Once the vault is listed in full, that is no longer owed.
					this.debt.syncReached(check, progress.phase);
					this.showProgress(progress);
				},
				signal: controller.signal,
				yieldControl,
				sizeLimit: DEFAULT_SIZE_LIMIT,
			};
			const pushDeps: Omit<PushDeps, "hold"> = {
				store: opened.store,
				backend,
				sentBlobs,
				vault: pullDeps.vault,
				paths: pullDeps.paths,
				device,
				deviceName: settings.deviceName,
				now: Date.now,
				confirm: async (request) => {
					if (auto !== null) return "later";
					const answer = await this.whileAsking(() => confirmPushIn(host.app, t, target, controller.signal)(request));
					if (!this.stopped && answer === "proceed") {
						const line = this.stopping ? "push.progress.stopping" : "push.progress.sendingStart";
						this.progress = new Notice(t(line), 0);
						this.progressPhase = "";
						this.lastPushProgress = null;
						this.shownLimit = NO_FETCH_LIMIT;
					}
					return answer;
				},
				askEmptyVault: async (request) => {
					if (auto !== null) return "later";
					// As above. No line comes back after it: what follows is
					// the question about the deletions, or the end of the push.
					return this.whileAsking(() => askEmptyVaultIn(host.app, t, target, controller.signal)(request));
				},
				onSectionAdded: (added) => {
					sectionAdded = added;
				},
				...(pullDeps.index === undefined ? {} : { index: pullDeps.index }),
				...(listedStats === undefined ? {} : { listedStats }),
				// A sync that started by itself writes nothing to the vault
				// that the remote did not send. Without the section its lines
				// are applied all the same (`effectiveRules`), so what is
				// sent is the same; the next push the user starts adds it,
				// and tells of it.
				...(auto === null ? {} : { addSection: false }),
				...beingEdited,
				onProgress: (progress) => {
					this.debt.syncReached(check, progress.phase);
					this.showPushProgress(progress);
				},
				signal: controller.signal,
				yieldControl,
				sizeLimit: DEFAULT_SIZE_LIMIT,
				log,
			};

			if (mode === "push") {
				const result = await runPush(pushDeps);
				sectionAdded = null;
				this.reportPush(result);
			} else if (mode === "untrack") {
				const untrackDeps: UntrackDeps = {
					store: opened.store,
					backend,
					vault: pullDeps.vault,
					paths: pullDeps.paths,
					deviceName: settings.deviceName,
					signal: controller.signal,
					sizeLimit: DEFAULT_SIZE_LIMIT,
					log,
				};
				// The pull is told as it ends, like that of a sync, and the
				// untracking last.
				const result = await runUntrackSync({
					pull: pullDeps,
					untrack: untrackDeps,
					shown,
					onStep: (step) => this.beginStep(step),
					onPulled: (pulled) => this.report(pulled, settings),
				});
				this.reportUntrack(result);
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
					automatic: auto !== null,
					indexAfterWalk: vaultIndexOf(host.app),
				});
				sectionAdded = null;
				if (push !== null) this.reportPush(push);
			} else {
				this.report(await runPull(pullDeps), settings);
			}
			await this.tellExclusionChange(opened.store, pullDeps.paths, device);
		} catch (error) {
			// A pull that was stopped while the remote was asked ends by
			// throwing too, and did not fail.
			const cancelled = error instanceof BackendError && error.kind === "cancelled";
			if (!this.stopped && !cancelled) {
				console.error(`Sync Evo: the ${this.direction} failed`, error);
				// The notice goes; the log is what a report is copied from.
				log(`${this.direction}: failed (${mode}, ${startedBy}): ${failureLine(error)}`);
			}
			// What is still on its way ends: the requests of a fetch that
			// were started beside the one that failed (`fetchConcurrently`),
			// whose answers are dropped, would wait out a limit and send
			// again. Only those are left: what writes, to the vault or to the
			// remote, has ended before the failure came here. The failure is
			// told as it came, and not as a stop.
			controller.abort();
			// The folder on Drive is no longer to be seen: its id is let go
			// of, and the sync state with it, once this sync has ended (R-3),
			// and not here: a change of the connection under a running sync
			// would have it end as stopped, and a sync that started by itself
			// would tell nothing. Told as the failure it is, with what the
			// next sync does.
			if (error instanceof DriveFolderGoneError) goneFolder = error.folderId;
			const text = this.failureText(settings, error);
			this.parts.push(failureAutoReport(t, error, text));
			// A push that failed has no result to tell it with, and the file
			// on this device is changed all the same. Whether it reached the
			// remote before the failure is not known. Told with the failure:
			// there is no summary to give it a line in.
			// Never of a sync that started by itself, which adds none.
			// Set in a callback: the compiler takes it for null still.
			const section = sectionAdded as SectionAdded | null;
			if (!this.quiet) {
				// That it was stopped is no error: it stays all the same,
				// but for an untracking (`failureStays`).
				const stays = this.failureStays(cancelled);
				const level: NoticeLevel = !cancelled ? "error" : stays ? "warn" : "info";
				const added = section === null ? "" : sectionAddedText(t, section, "unknown");
				const more = section !== null && section.tracked.length > NOTICE_LIST_LIMIT ? t("notice.seeResults") : "";
				this.show(paragraphs([text, added, more]), stays ? 0 : undefined, level);
				// A stop the user asked for is how the sync ended, and nothing
				// to see to: alone, it does not keep the sync on the screen
				// of the results.
				if (cancelled && this.stopping && !this.connectionChanged) this.summaries.push(text);
				else this.told.push({ level, text });
				if (section !== null) {
					this.told.push({ level: "info", text: sectionAddedText(t, section, "unknown", Number.POSITIVE_INFINITY) });
				}
			}
		} finally {
			// Before anything is awaited: the line of progress of a sync
			// that started by itself must not come up once it has ended.
			if (this.late !== null) window.clearTimeout(this.late);
			this.late = null;
			if (onHidden !== null) document.removeEventListener("visibilitychange", onHidden);
			try {
				// However it ended: what it leaves remembered, and what a
				// sync that started by itself has to tell.
				await this.settle(store, auto !== null);
			} catch (error) {
				// The sync has ended all the same, and the next may begin.
				console.error("Sync Evo: the end of the sync could not be recorded", error);
			}
			this.keepResult(auto !== null);
			this.quiet = false;
			this.parts = [];
			// Not for a sync that was stopped, or whose connection was
			// changed: the answer was given to the remote from before.
			refetch = this.refetchAsked && !this.stopped && !this.stopping && !this.connectionChanged;
			this.refetchAsked = false;
			// Not under a sync the user started that waits for this one. Nor
			// when the first fetch follows: it could not ask for the screen
			// again, this long after what the user did (`ScreenWakeLock.hold`).
			if (!this.takingOver && !refetch) this.wakeLock.release();
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
		// Told and remembered as a failure by now. No sync runs, so the
		// change of the connection stops none.
		if (goneFolder !== null && !this.stopped) host.driveFolderGone?.(goneFolder);
		if (!refetch) return;
		// What the command for the first fetch does, with its question. Begun
		// with nothing awaited since the sync ended, so that no other starts
		// in between.
		try {
			await this.start("first-fetch", [], null);
		} finally {
			// Let go of by the first fetch, unless it never began.
			this.wakeLock.release();
		}
	}

	/**
	 * Tells that the free time is over, and the sync only downloads
	 * (`paid.ts`): each time by hand, and once by automatic sync
	 * (`paidAutoReport`).
	 */
	private tellReadOnly(text: string, automatic: boolean): void {
		if (automatic) {
			this.parts.push(paidAutoReport(this.host.t, "read-only", true, text));
			return;
		}
		this.show(text, LONG_NOTICE_MS, "warn");
		this.told.push({ level: "warn", text });
	}

	/**
	 * Stops a running sync because the connection it runs with is being
	 * changed, and resolves when it has ended: a pull between two files,
	 * after the one being written is written and recorded; a push before
	 * the branch is moved, or else after it has recorded what it sent; an
	 * untracking likewise, before the branch is moved, which leaves the
	 * remote as it was, or else after it has recorded what it took out.
	 * Resolved at once when no sync runs. The sync state is discarded after
	 * this (`main.ts`), and not under a sync that still writes to it. A
	 * question the sync has open is closed as a "no", so that this does not
	 * wait for the user to answer it.
	 *
	 * A write of the settings screen to `.gitignore` that is under way is
	 * waited for as well: it remembers what it writes in the sync state.
	 */
	interrupt(): Promise<void> {
		// What is remembered is the old connection's, and goes with its sync
		// state. A sync that is still running leaves it so (`settle`).
		this.memory = NO_AUTO_SYNC_MEMORY;
		this.recalled = false;
		this.recallAsked = false;
		this.heads.forget();
		this.connectionChanges += 1;
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
		// Also the sync that waits for this one to end (`takeOver`).
		if (this.takingOver) this.takeOverStopped = true;
		this.stopping = true;
		this.controller.abort();
		// None while a question is open. The question is closed by the stop,
		// as a "no" (`closeWhenAborted`), and no line comes back after that.
		this.progress?.setMessage(t(STOPPING_LINES[this.direction]));
	}

	/** Stops a running sync, and tells nothing. For when the plugin is unloaded. */
	stop(): void {
		this.stopped = true;
		this.controller?.abort();
		this.progress?.hide();
		if (this.late !== null) window.clearTimeout(this.late);
		this.late = null;
		this.wakeLock.release();
	}

	/**
	 * An automatic sync that could not begin: the settings lack what a
	 * request needs. Counted and told like one that failed, and the next is
	 * counted from here, so that it is not tried at every look at the clock.
	 * `store`: whether it is also stored, for the next start of the app.
	 */
	private notReady(report: AutoReport, store: boolean): void {
		const settled = settleAutoSync({ ...this.memory, lastStartedAt: Date.now() }, report, true);
		this.memory = settled.memory;
		log(`automatic sync: not started (${report.cause ?? ""})`);
		for (const notice of autoNotices(this.host.t, report, settled.tell)) this.show(notice.text, 0, notice.level);
		if (store) void this.storeAside();
	}

	/**
	 * Stores what is remembered where no sync ran that would have: so that
	 * what was told is not told again the next time the app starts. Nothing
	 * is stored after a change of the connection, whose sync state is
	 * another, or under a sync that has begun since, which stores it
	 * itself. Never rejects.
	 */
	private async storeAside(): Promise<void> {
		const changes = this.connectionChanges;
		try {
			const opened = await this.host.syncState.open();
			if (this.stopped) {
				// Let go of while this waited for it, and opened since.
				this.host.syncState.close();
				return;
			}
			if (opened.status !== "ok" || changes !== this.connectionChanges || this.controller !== null) return;
			await writeAutoSyncMemory(opened.store, this.memory);
		} catch {
			// It is told once more after the next start of the app.
		}
	}

	/**
	 * Stores when the sync that begins started, with what the sync state
	 * remembers beside it, which is read here when nothing has read it yet.
	 * Nothing here can fail the sync: what is not stored is still known
	 * until the app is closed.
	 */
	private async rememberStart(store: StateStore): Promise<void> {
		try {
			if (!this.recalled) this.recall(await readAutoSyncMemory(store));
			await writeAutoSyncMemory(store, this.memory);
		} catch {
			// The copy in memory is the one that is read.
		}
	}

	/**
	 * The end of a sync: what it leaves remembered (`settleAutoSync`), and,
	 * for one that started by itself, everything it tells. `store` is the
	 * sync state the sync ran with, or `null` when it got none.
	 *
	 * A sync that was stopped, by the user, by a change of the connection,
	 * by the plugin going away, or by a sync the user started in its place
	 * (`takeOver`), is neither a success nor a failure: nothing is
	 * remembered of it. What happened in it before that is told all the
	 * same.
	 */
	private async settle(store: StateStore | null, automatic: boolean): Promise<void> {
		const whole = joinAutoReports(this.parts);
		let tell = false;
		if (!this.stopped && !this.stopping && !this.connectionChanged && !this.takingOver) {
			const settled = settleAutoSync(this.memory, whole, automatic);
			this.memory = settled.memory;
			tell = settled.tell;
			try {
				if (store !== null) await writeAutoSyncMemory(store, this.memory);
			} catch {
				// How the sync ended is not changed by this.
			}
		}
		if (!automatic) return;
		log(`automatic sync: ${whole.end}${whole.cause === null ? "" : ` (${whole.cause})`}`);
		// The user asked for the stop, and is told that it was heard.
		if (this.stopping && !this.connectionChanged) this.show(this.stoppedText());
		for (const shown of autoNotices(this.host.t, whole, tell)) {
			const notice = this.show(shown.text, 0, shown.level);
			if (notice !== null && shown.question === true) this.questions.push(notice);
		}
		this.told.push(...autoResults(whole, tell));
	}

	/**
	 * Keeps what the sync that ended told, with every path, for the screen
	 * of the results: only when it told more than how its parts ended, so
	 * that the syncs that went well do not push out the ones that did not.
	 */
	private keepResult(automatic: boolean): void {
		const items = this.told;
		const summaries = this.summaries.filter((summary) => summary !== "");
		this.told = [];
		this.summaries = [];
		if (this.stopped || items.length === 0) return;
		void this.host.results?.add({ at: Date.now(), automatic, summaries, items });
	}

	/** The notices of a part of a sync the user started (`partNotices`). */
	private showPart(part: PartReport): void {
		for (const notice of partNotices(this.host.t, part)) {
			const duration = notice.stays ? 0 : notice.text.includes("\n") ? LONG_NOTICE_MS : undefined;
			this.show(notice.text, duration, notice.level);
		}
	}

	/**
	 * Puts up the line of progress of a sync that started by itself and is
	 * still running (`AUTO_PROGRESS_DELAY_MS`), with what it last reported.
	 */
	private showLate(): void {
		this.late = null;
		if (this.stopped || this.controller === null || this.progress !== null) return;
		const t = this.host.t;
		const starting = this.direction === "push" ? "push.progress.starting" : "pull.progress.starting";
		this.progress = new Notice(t(this.stopping ? STOPPING_LINES[this.direction] : starting), 0);
		this.progressPhase = "";
		this.shownLimit = NO_FETCH_LIMIT;
		if (this.direction === "push" && this.lastPushProgress !== null) this.showPushProgress(this.lastPushProgress);
		else if (this.direction === "pull" && this.lastProgress !== null) this.showProgress(this.lastProgress);
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
		if (this.stopped || this.stopping) return;
		if (this.progress === null) {
			// Kept for the line a sync that started by itself puts up later.
			if (this.late !== null) this.lastProgress = progress;
			return;
		}
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
		if (this.stopped || this.stopping) return;
		if (this.progress === null) {
			if (this.late !== null) this.lastPushProgress = progress;
			return;
		}
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
		// The untracking has one line, and a handful of requests. While it
		// waits out a limit, that line stays as it is and does not say so.
		if (this.direction === "untrack") return;
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
		const options = { settings, sizeLimit: DEFAULT_SIZE_LIMIT, connectionChanged: this.connectionChanged };
		this.parts.push(pullAutoReport(this.host.t, result, options));
		const part = pullPart(this.host.t, result, options);
		this.summaries.push(part.summary);
		// Told at the end, and not all of it (`settle`).
		if (this.quiet) return;
		this.told.push(...partResults(part));
		this.showPart(part);
	}

	/**
	 * Tells once, after the first sync that got to the head of the remote,
	 * how many files the remote holds that this device no longer syncs since
	 * what an exclusion does was changed, and where the settings list them
	 * (`excludedOnRemoteCount`). Nothing where there are none. Remembered as
	 * told either way, in the settings and not the sync state, so that a
	 * first fetch does not tell it again. Also after a sync that started by
	 * itself: it is said once, and the change is no less for that. Only
	 * worth knowing: a sync that started by itself leaves it on the screen
	 * of the results alone.
	 *
	 * Never fails the sync: what goes wrong here is tried again by the next.
	 */
	private async tellExclusionChange(
		store: StateStore,
		paths: ExclusionPaths,
		device: Pick<DeviceExclusion, "kinds">,
	): Promise<void> {
		const host = this.host;
		if (this.stopped || this.connectionChanged || host.deviceSettings?.exclusionChangeTold !== false) return;
		let count: number | null;
		try {
			count = await excludedOnRemoteCount(
				{ store, vault: pullVaultOf(host.app), paths, sizeLimit: DEFAULT_SIZE_LIMIT },
				device.kinds,
			);
		} catch {
			return;
		}
		if (count === null || this.stopped || this.connectionChanged) return;
		host.exclusionChangeTold?.();
		if (count === 0) return;
		const text = host.t("notice.exclusionChange", { count });
		this.told.push({ level: "info", text });
		if (!this.quiet) this.show(text, LONG_NOTICE_MS);
	}

	private reportPush(result: PushRunResult): void {
		if (this.stopped) return;
		const options = { sizeLimit: DEFAULT_SIZE_LIMIT, connectionChanged: this.connectionChanged };
		this.parts.push(pushAutoReport(this.host.t, result, options));
		const part = pushPart(this.host.t, result, options);
		if (this.quiet) {
			this.summaries.push(part.summary);
			return;
		}
		this.told.push(...partResults(part));
		// Not told as a push the user said no to: the first fetch that was
		// asked for comes next, and tells how it went.
		if (result.refetch === true) {
			this.refetchAsked = true;
			this.showPart({ ...part, summary: "" });
			return;
		}
		this.summaries.push(part.summary);
		this.showPart(part);
	}

	/**
	 * A step of an untracking begins (`UntrackSyncDeps.onStep`). The pull
	 * writes the line of progress itself; the untracking reports
	 * nothing, and gets its one line here. There is no line after a question
	 * that was answered "no", and nothing follows that either.
	 */
	private beginStep(step: UntrackStep): void {
		this.direction = step;
		if (step !== "untrack" || this.stopped || this.stopping) return;
		this.progress?.setMessage(this.host.t("untrack.progress.running"));
		this.progressPhase = "";
	}

	private reportUntrack(result: UntrackSyncResult): void {
		if (this.stopped) return;
		const { connectionChanged } = this;
		const part = untrackPart(this.host.t, result, { connectionChanged });
		this.summaries.push(part.summary);
		this.told.push(...partResults(part));
		// Why nothing was untracked is something to act on, and stays
		// (`untrackPart`).
		this.showPart(part);
	}

	/** The text for a sync that ended by throwing, by the part of it that was at work. */
	private failureText(settings: DeviceSettings, error: unknown): string {
		const t = this.host.t;
		switch (this.direction) {
			case "pull":
				return pullFailureText(t, settings, error, this.connectionChanged);
			case "push":
				return pushFailureText(t, settings, error, this.connectionChanged);
			case "untrack":
				return untrackFailureText(t, settings, error, this.connectionChanged);
		}
	}

	/**
	 * Whether what a sync that ended by throwing is told with stays until
	 * it is dismissed. Not an untracking that was stopped: that leaves
	 * nothing to act on, and is told like one that ended so without
	 * throwing (`reportUntrack`).
	 */
	private failureStays(cancelled: boolean): boolean {
		return !(cancelled && this.direction === "untrack");
	}

	/** The text for a sync that was stopped before it could begin. */
	private stoppedText(): string {
		const t = this.host.t;
		return this.direction === "push"
			? pushStoppedText(t, this.connectionChanged)
			: stoppedText(t, this.connectionChanged);
	}

	/**
	 * Puts up a notice. One that tells of an error looks apart from the
	 * others (`styles.css`). `action`: a button under the text. A tap on it
	 * is a tap on the notice too, which takes the notice away.
	 */
	private show(text: string, duration?: number, level: NoticeLevel = "info", action?: NoticeAction): Notice | null {
		if (this.stopped) return null;
		const notice = new Notice(text, duration);
		if (level === "error") (notice.containerEl as HTMLElement | undefined)?.classList.add("sync-evo-notice-error");
		if (action !== undefined) {
			const button = (notice.messageEl as HTMLElement | undefined)?.createDiv().createEl("button", { text: action.label });
			button?.addEventListener("click", () => action.run());
		}
		// Those that stay until they are tapped, for `whileAsking`. The
		// oldest are let go of: by then they are long read, or long gone.
		if (duration === 0) this.staying = [...this.staying, { notice, text, level, action }].slice(-STAYING_NOTICES);
		return notice;
	}

	/**
	 * Asks the user something in a dialog, with nothing of Sync Evo's on top
	 * of it. The line of progress and the notices that stay cover a dialog:
	 * on a phone its title, and in a narrow window the button that says no
	 * (seen on Windows, 2026-10-12: only "proceed" was left to see). They
	 * are taken away while the user answers. The notices are put back after,
	 * unless the user had closed them; the line of progress is the caller's
	 * to put back, with what goes on then.
	 */
	private async whileAsking<T>(ask: () => Promise<T>): Promise<T> {
		this.progress?.hide();
		this.progress = null;
		const putBack = this.hideStaying();
		try {
			return await ask();
		} finally {
			putBack();
		}
	}

	/**
	 * Takes the notices that stay off the screen, for a question that is
	 * asked outside a sync (the one before files are untracked, from the
	 * settings). Answers what puts them back, to be called once the
	 * question is gone.
	 */
	hideStaying(): () => void {
		const hidden = this.staying.filter(({ notice }) => (notice.containerEl as HTMLElement | undefined)?.isConnected !== false);
		this.staying = [];
		for (const { notice } of hidden) notice.hide();
		return () => {
			for (const { notice: before, text, level, action } of hidden) {
				const notice = this.show(text, 0, level, action);
				// A question of automatic sync is still one: a sync the user
				// starts takes it down (`hideQuestions`).
				const at = this.questions.indexOf(before);
				if (at !== -1) {
					if (notice === null) this.questions.splice(at, 1);
					else this.questions[at] = notice;
				}
			}
		};
	}
}
