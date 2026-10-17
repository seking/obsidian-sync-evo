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

import { getLanguage, Notice, Platform, Plugin } from "obsidian";
import { TICK_MS } from "./core/auto-sync";
import { type CheckOutcome, checkDriveFolder, checkDropboxFolder, runConnectionCheck } from "./core/connection-check";
import {
	currentAccount,
	DROPBOX_REDIRECT_ACTION,
	exchangeCode,
	finishSignIn,
	RefreshingTokens,
	revokeToken,
	type SignIn,
} from "./core/dropbox/auth";
import { type AccessTokens, DropboxClient } from "./core/dropbox/client";
import { BackendError } from "./core/backend";
import {
	currentDriveAccount,
	type DeviceCode,
	type GoogleClient,
	GoogleTokens,
	googleClientOf,
	isOwnClient,
	requestDeviceCode,
	waitForDeviceGrant,
} from "./core/gdrive/auth";
import { GDriveBackend } from "./core/gdrive/backend";
import { DriveClient } from "./core/gdrive/client";
import { GoogleClientSecretMissingError } from "./core/gdrive/errors";
import { DODO_API } from "./core/license";
import { PAID_ENABLED_AT, type PaidInfo } from "./core/paid";
import { PaidGate } from "./core/paid-gate";
import {
	applyExclusionEdit,
	type ExclusionChanged,
	type ExclusionEdit,
	type ExclusionScreenDeps,
	readExclusionScreen,
	saveGitignoreText,
	type UntrackList,
} from "./core/exclusion-settings";
import {
	type DeviceExclusion,
	type DeviceExclusionEdit,
	editedDeviceExclusion,
	kindsFromSection,
} from "./core/device-exclusion";
import { readRootGitignore, settleGitignoreWrite } from "./core/gitignore-file";
import { GitHubClient } from "./core/github/client";
import { type Translate, translatorFor } from "./core/i18n";
import { DEFAULT_SIZE_LIMIT } from "./core/plan";
import { readSymlinkTargets, type SymlinkTarget } from "./core/pull";
import { type PushFailure, readPushFailure } from "./core/push-failure";
import { pushFailureReminderText } from "./core/push-report";
import {
	type ConnectionChange,
	connectionChange,
	connectionOf,
	defaultDeviceName,
	defaultSettings,
	type DeviceSettings,
} from "./core/settings";
import { type UntrackConfirmRequest, untrackConfirmRequest } from "./core/untrack-report";
import { AutoScheduler } from "./obsidian/auto-scheduler";
import { EditingWatch } from "./obsidian/editing-watch";
import { exclusionPathsOf } from "./obsidian/exclusion-paths";
import type { ExclusionChange, ExclusionLoad } from "./obsidian/exclusion-settings";
import { deviceNetwork } from "./obsidian/http";
import { log, showLog } from "./obsidian/log";
import { pullVaultOf } from "./obsidian/pull-vault";
import { ResultsStore, resultsStoreDepsOf } from "./obsidian/results-store";
import { showResults } from "./obsidian/results-view";
import { type SyncHost, SyncRunner } from "./obsidian/sync-runner";
import { SettingsStore } from "./obsidian/settings-store";
import { type SettingsHost, SyncEvoSettingTab } from "./obsidian/settings-tab";
import { SyncState, syncStateDepsOf } from "./obsidian/sync-state";
import { windowSleep } from "./obsidian/window-sleep";
import { copyText, DriveCodeModal } from "./obsidian/gdrive-connect";
import { windowStorage } from "./obsidian/paid-storage";

/** A code fetched before the press is used only while it has this much left. */
const CODE_MARGIN_MS = 60_000;

/** The name of a service, as texts put it for `{remote}`. */
function remoteName(backend: DeviceSettings["backend"] | undefined): string {
	return backend === "dropbox" ? "Dropbox" : backend === "gdrive" ? "Google Drive" : "GitHub";
}

export default class SyncEvoPlugin extends Plugin implements SettingsHost, SyncHost {
	/** The language of the app. A change of it takes effect on restart, so reading it once is enough. */
	private language = "";
	/** The translators made so far, by the name of the service in their texts. */
	private readonly translators = new Map<string, Translate>();

	/**
	 * The commands, named for the service chosen. Added again when another
	 * is chosen: Obsidian takes a command of the same id in place of the
	 * one before, and the palette shows the new name at once.
	 */
	private addCommands(): void {
		this.addCommand({
			id: "sync",
			name: this.t("command.sync"),
			callback: () => void this.syncs.run("sync"),
		});
		this.addCommand({
			id: "pull",
			name: this.t("command.pull"),
			callback: () => void this.syncs.run("pull"),
		});
		this.addCommand({
			id: "push",
			name: this.t("command.push"),
			callback: () => void this.syncs.run("push"),
		});
		this.addCommand({
			id: "first-fetch",
			name: this.t("command.firstFetch"),
			callback: () => void this.syncs.run("first-fetch"),
		});
		this.addCommand({
			id: "stop",
			name: this.t("command.stop"),
			callback: () => this.syncs.requestStop(),
		});
		// Starts no sync: the last lines of the log, for a device whose
		// console cannot be read.
		this.addCommand({
			id: "show-log",
			name: this.t("command.showLog"),
			callback: () => showLog(this.app, this.t, () => this.hideNotices()),
		});
		// Every file of what the last syncs told, which a notice lists the
		// first few of.
		this.addCommand({
			id: "show-results",
			name: this.t("command.showResults"),
			callback: () => void showResults(this.app, this.t, this.results, () => this.hideNotices()),
		});
	}

	/**
	 * Looks up every text the plugin shows, in the language of the app, with
	 * the service the settings name where a text has `{remote}`.
	 */
	get t(): Translate {
		const remote = remoteName(this.deviceSettings?.backend);
		let translate = this.translators.get(remote);
		if (translate === undefined) {
			translate = translatorFor(this.language, remote);
			this.translators.set(remote, translate);
		}
		return translate;
	}

	/** The access tokens of Dropbox, kept while the refresh token they come from is the one in use. */
	private dropboxAccess: { readonly refreshToken: string; readonly tokens: RefreshingTokens } | null = null;

	/** The access tokens of Google Drive, likewise, with the client they are taken with. */
	private gdriveAccess: { readonly refreshToken: string; readonly client: GoogleClient; readonly tokens: GoogleTokens } | null = null;

	/**
	 * The code asked of Google ahead of a press of "Connect", kept while it
	 * lasts, so that drawing the settings again asks for none. Taken by the
	 * press it is used for.
	 */
	private gdriveCode: { readonly asked: Promise<DeviceCode>; code: DeviceCode | null } | null = null;

	/**
	 * The settings of this device for this vault. `null` when what is stored
	 * was written by a newer version of Sync Evo: there is then nothing to
	 * sync with, and nothing is written over it.
	 *
	 * Not named `settings`: since 1.13 the app knows a field of that name on
	 * a plugin, and its declared settings save it to `data.json`, the one
	 * place these must never be written to.
	 */
	deviceSettings: DeviceSettings | null = null;

	private readonly store = new SettingsStore(this.app);

	/**
	 * The records and everything else a sync leaves behind for the next one.
	 * A sync gets them with `syncState.open()` and in no other way: that
	 * waits for a discard asked for by a change of the connection, and
	 * answers "newer-version" or "unavailable" instead of a store when there
	 * is nothing the sync may use. Nothing is opened before a sync asks, the
	 * settings screen does for what it lists, or the app has started and a
	 * push that did not finish is looked for, or, with automatic sync on,
	 * the time of the last sync; and never while there is no connection.
	 */
	readonly syncState = new SyncState(syncStateDepsOf(this.app, () => this.syncs.stateBlocked()));

	/**
	 * Which file the user is typing in right now, as far as the events of
	 * the page tell. A sync that starts by itself leaves that file alone.
	 */
	readonly editing = new EditingWatch(this.app);

	/**
	 * The results of the last syncs that had something to tell, for the
	 * screen that lists them. Apart from the sync state: they outlive a
	 * change of the connection, and a first fetch.
	 */
	readonly results = new ResultsStore(resultsStoreDepsOf(this.app));

	/**
	 * The paid plan of Dropbox and Google Drive (T082): what a sync is let
	 * do, and the license key of this device. Does nothing while the plan
	 * is not switched on (`PAID_ENABLED_AT`).
	 */
	readonly paid = new PaidGate({
		storage: windowStorage,
		http: (request) => deviceNetwork().http(request),
		now: Date.now,
		enabledAt: PAID_ENABLED_AT,
		api: DODO_API,
		log,
	});

	/** The one place a sync of any kind is started from, so that two never run at once. */
	private readonly syncs = new SyncRunner(this);

	/** Starts the syncs nobody asked for, when automatic sync is on and one is due. */
	private readonly autoSync = new AutoScheduler(this, this.syncs);

	/** The settings screen, once it is made: drawn again in part when an untracking has ended. */
	private settingTab: SyncEvoSettingTab | null = null;

	/** The plugin is going away: nothing more is shown. */
	private unloaded = false;

	override onload(): void {
		this.language = getLanguage();
		this.translators.clear();

		const loaded = this.store.load(defaultDeviceName(Platform));
		this.deviceSettings = loaded.status === "ok" ? loaded.settings : null;
		this.settingTab = new SyncEvoSettingTab(this.app, this, this);
		this.addSettingTab(this.settingTab);

		// What the user starts a sync with. Each keeps the screen on while
		// it runs (`SyncRunner.run`). The button of the ribbon is the sync:
		// a pull, and then a push. Untracking is the one sync that has no
		// command: it starts from the settings screen, where its files are
		// listed (`untrack`). A sync that starts by itself comes from the
		// clock further down.
		this.addRibbonIcon("refresh-cw", this.t("command.sync"), () => void this.syncs.run("sync"));
		this.addCommands();

		// Where Dropbox sends the browser back after the user allowed (R-4).
		this.registerObsidianProtocolHandler(DROPBOX_REDIRECT_ACTION, (params) => void this.finishDropboxSignIn(params));

		// Listened to whether or not automatic sync is on: switched on, it
		// has to know of a composition that began before.
		this.editing.register(this);

		// The clock of automatic sync. It does nothing while both of its
		// switches are off, which is how they start. The timer stands still
		// while a phone has the app in the background; the event tells of the
		// return at once, and the timer tells of it too, by how late it fires.
		// Both are taken away when the plugin is unloaded.
		this.registerInterval(window.setInterval(() => this.autoSync.tick(), TICK_MS));
		this.registerDomEvent(document, "visibilitychange", () => this.autoSync.visibilityChanged());

		// Once the app is up. For the reminder the sync state is only read:
		// nothing is asked of the remote, and nothing is sent again. A sync
		// starts here only when automatic sync is on.
		this.app.workspace.onLayoutReady(() => {
			void this.remindOfPushFailure();
			this.autoSync.started();
		});
	}

	/** Tells once more, until it is dismissed, of a push that did not get to its end (`push-failure.ts`). */
	private async remindOfPushFailure(): Promise<void> {
		const failure = await this.pushFailure();
		if (this.unloaded) {
			// The sync state was let go of while this waited for it, and
			// has been opened since.
			this.syncState.close();
			return;
		}
		if (failure !== null) new Notice(pushFailureReminderText(this.t, failure), 0);
	}

	override onunload(): void {
		this.unloaded = true;
		// A question about untracking that is still open is closed, as a
		// "no": answered later, it would start a sync of a plugin that is off.
		this.settingTab?.dropExclusion();
		// Before the state is let go of, so that the sync stops asking for it.
		this.syncs.stop();
		this.syncState.close();
	}

	/**
	 * The one way the settings change. It is one place so that no change of
	 * the connection can be saved without being noticed here.
	 */
	updateSettings(next: DeviceSettings): ConnectionChange {
		const before = this.deviceSettings;
		// Settings of a newer version are never written over.
		if (before === null) return "none";

		const change = connectionChange(connectionOf(before), connectionOf(next));
		// The sync state is discarded on "set" and "changed", so that the
		// records of one repository are never compared with another; a change
		// of the token or the device name is "none" and keeps it. Asked for
		// before the connection is saved: the request leaves a note that
		// outlives the app, so no stop in between can leave the new
		// connection with the old state. The removal itself ends later, and
		// `syncState.open()` waits for it.
		//
		// A sync that is running is stopped first, and the removal waits for
		// it to end. Removed under a pull, the state would lose the marker
		// of the file being written before that file is whole, and the next
		// sync would take the half of it for a file of the user's.
		//
		// A write of the root `.gitignore` that did not get to its end is
		// remembered in the state too, and is settled before the state goes:
		// forgotten with it, half a file would be left to be read as rules.
		// Only on "changed". On "set" the state is one that was left behind,
		// and nothing is done by what such a state remembers. When settling
		// fails, the state goes all the same: it is of no use to the new
		// connection.
		if (change === "set" || change === "changed") {
			// A question about untracking that is open lists the files of the
			// remote that is left: answered with a yes after this, it would
			// untrack them on the new one. It is closed, as a "no".
			this.settingTab?.closeUntrackQuestion();
			const vault = pullVaultOf(this.app);
			this.syncState.requestDiscard(
				this.syncs.interrupt(),
				change === "changed" ? (store) => settleGitignoreWrite({ store, vault }) : undefined,
			);
		}
		const renamed = this.deviceSettings?.backend !== next.backend;
		this.deviceSettings = next;
		this.store.save(next);
		if (renamed) this.addCommands();
		return change;
	}

	/**
	 * Gives up settings written by a newer version, at the user's request.
	 * What is left is no connection, so entering one again counts as a new
	 * connection, like any other from none.
	 */
	resetSettings(): void {
		// Only what cannot be read is given up this way.
		if (this.deviceSettings !== null) return;
		this.store.clear();
		this.deviceSettings = defaultSettings(defaultDeviceName(Platform));
	}

	readToken(secretName: string): string | null {
		return this.store.readToken(secretName);
	}

	/**
	 * Copies the kinds of file the section of the root `.gitignore` leaves
	 * out, as an earlier version wrote them there, to what this device alone
	 * does not sync (`kindsFromSection`): once, the first time a section is
	 * read. Asked before a sync and before the settings show the section.
	 * Never rejects: a file that cannot be read is looked at the next time.
	 */
	async adoptSectionKinds(): Promise<void> {
		if (this.deviceSettings === null || this.deviceSettings.deviceExclusion.sectionChecked) return;
		let text: string;
		try {
			const read = await readRootGitignore(pullVaultOf(this.app), DEFAULT_SIZE_LIMIT);
			if (read.kind !== "text") return;
			text = read.text;
		} catch {
			return;
		}
		// As they are now: they may have changed while the file was read.
		const settings = this.deviceSettings;
		if (settings === null) return;
		const next = kindsFromSection(text, exclusionPathsOf(this.app, this.manifest), settings.deviceExclusion);
		if (next !== null) this.updateSettings({ ...settings, deviceExclusion: next });
	}

	exclusionChangeTold(): void {
		const settings = this.deviceSettings;
		if (settings === null || settings.exclusionChangeTold) return;
		this.updateSettings({ ...settings, exclusionChangeTold: true });
	}

	/**
	 * The symlinks of the remote that are skipped, as of the last pull.
	 * Empty while there is no connection: there is then no sync state, and
	 * asking for one would make one. Never rejects.
	 */
	async skippedSymlinks(): Promise<readonly SymlinkTarget[]> {
		const settings = this.deviceSettings;
		if (settings === null || connectionOf(settings) === null) return [];
		try {
			const opened = await this.syncState.open();
			return opened.status === "ok" ? await readSymlinkTargets(opened.store) : [];
		} catch {
			return [];
		}
	}

	/**
	 * The push that did not get to its end, if no sync has sent since.
	 * `null` while there is no connection, as for the symlinks. Never rejects.
	 */
	async pushFailure(): Promise<PushFailure | null> {
		const settings = this.deviceSettings;
		if (settings === null || connectionOf(settings) === null) return null;
		try {
			const opened = await this.syncState.open();
			return opened.status === "ok" ? await readPushFailure(opened.store) : null;
		} catch {
			return null;
		}
	}

	/**
	 * What the settings show of the root `.gitignore`. Read under the mark
	 * that keeps a sync from starting meanwhile, since it settles a write
	 * that did not get to its end, which can write the file. While a sync
	 * runs, it is read without that. Never rejects.
	 */
	async exclusionScreen(): Promise<ExclusionLoad> {
		const settings = this.deviceSettings;
		if (settings === null || connectionOf(settings) === null) return { status: "no-connection" };
		await this.adoptSectionKinds();
		try {
			const deps = await this.exclusionDeps();
			if (deps === null) return { status: "no-state" };
			const read = await this.syncs.editGitignore(() => readExclusionScreen(deps, { settle: true }));
			if (read.status === "done") return { status: "ok", screen: read.value, syncing: false };
			return { status: "ok", screen: await readExclusionScreen(deps, { settle: false }), syncing: true };
		} catch {
			return { status: "no-state" };
		}
	}

	editExclusion(edit: ExclusionEdit): Promise<ExclusionChange> {
		return this.changeGitignore((deps) => applyExclusionEdit(deps, edit));
	}

	saveGitignore(text: string, opened: string | null): Promise<ExclusionChange> {
		return this.changeGitignore((deps) => saveGitignoreText(deps, text, opened));
	}

	deviceExclusion(): DeviceExclusion | null {
		return this.deviceSettings?.deviceExclusion ?? null;
	}

	/**
	 * Saved like any other setting, and not a change of the connection: the
	 * sync state stays. A sync that is running goes by what it read when it
	 * began; the next one by this.
	 */
	editDeviceExclusion(edit: DeviceExclusionEdit): void {
		const settings = this.deviceSettings;
		if (settings === null) return;
		const next = editedDeviceExclusion(settings.deviceExclusion, edit);
		if (next !== settings.deviceExclusion) this.updateSettings({ ...settings, deviceExclusion: next });
	}

	/**
	 * What the question before untracking is drawn from: which of the files
	 * this device holds. Only read. `null` while there is no connection.
	 * Never rejects.
	 */
	async untrackRequest(list: UntrackList): Promise<UntrackConfirmRequest | null> {
		const settings = this.deviceSettings;
		if (settings === null || connectionOf(settings) === null) return null;
		try {
			return await untrackConfirmRequest({ vault: pullVaultOf(this.app) }, list);
		} catch {
			return null;
		}
	}

	hideNotices(): () => void {
		return this.syncs.hideStaying();
	}

	/**
	 * Untracks the paths the user confirmed, after the sync it needs
	 * (`SyncRunner.run`). Called from the handler of the button that
	 * confirms, and not `async`: nothing may be awaited before the sync asks
	 * the screen to stay on. When it has ended, however it ended, what the
	 * settings show of the remote is drawn again, if they are open.
	 */
	untrack(shown: readonly string[]): void {
		// A question that outlived the plugin: no sync is started from it.
		if (this.unloaded) return;
		const redraw = (): void => {
			if (!this.unloaded) this.settingTab?.redrawExclusion();
		};
		void this.syncs.run("untrack", shown).then(redraw, redraw);
	}

	/**
	 * A write of the settings to the root `.gitignore`: turned away while a
	 * sync runs, and no sync begins while it runs. Answers with how the write
	 * went and what it left to ask about untracking. Never rejects.
	 */
	private async changeGitignore(
		write: (deps: ExclusionScreenDeps) => Promise<ExclusionChanged>,
	): Promise<ExclusionChange> {
		const settings = this.deviceSettings;
		if (settings === null || connectionOf(settings) === null) return "no-state";
		try {
			const deps = await this.exclusionDeps();
			if (deps === null) return "no-state";
			const written = await this.syncs.editGitignore(() => write(deps));
			return written.status === "done" ? written.value : "syncing";
		} catch (error) {
			return { failed: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * What reading and writing the root `.gitignore` takes, or `null` when
	 * the sync state cannot be used. The state is opened here, before the
	 * work is handed to `editGitignore`, and never inside it: a discard of
	 * the state waits for that work to end, and an open waits for the discard.
	 */
	private async exclusionDeps(): Promise<ExclusionScreenDeps | null> {
		const opened = await this.syncState.open();
		if (opened.status !== "ok") return null;
		return {
			store: opened.store,
			vault: pullVaultOf(this.app),
			paths: exclusionPathsOf(this.app, this.manifest),
			sizeLimit: DEFAULT_SIZE_LIMIT,
		};
	}

	readDropboxToken(): string | null {
		return this.store.readDropboxToken();
	}

	dropboxTokens(refreshToken: string): AccessTokens {
		const kept = this.dropboxAccess;
		if (kept !== null && kept.refreshToken === refreshToken) return kept.tokens;
		const tokens = new RefreshingTokens(deviceNetwork().http, Date.now, refreshToken);
		this.dropboxAccess = { refreshToken, tokens };
		return tokens;
	}

	/** The account this device is connected to Dropbox with, or `null` while it is not. */
	dropboxConnection(): { readonly email: string } | null {
		const account = this.deviceSettings?.dropboxAccount ?? null;
		return account !== null && this.store.readDropboxToken() !== null ? { email: account.email } : null;
	}

	/**
	 * Opens Dropbox in the browser for the user to allow, with a sign-in
	 * made before the press: iOS opens the browser only right after a tap,
	 * and nothing may be awaited in between (R-4). What the return is
	 * checked against is stored first, so that it outlives the app being
	 * closed while the browser is out. A press takes the place of the one
	 * before.
	 */
	startDropboxSignIn(sign: SignIn): void {
		this.store.saveSignIn({ verifier: sign.verifier, state: sign.state, at: Date.now() });
		window.open(sign.url);
	}

	/** What the browser brought back to `obsidian://sync-evo-dropbox`. Never rejects. */
	private async finishDropboxSignIn(params: { readonly [key: string]: string | undefined }): Promise<void> {
		const t = this.t;
		const http = deviceNetwork().http;
		const pending = this.store.readSignIn();
		const result = await finishSignIn(
			params,
			pending,
			(sign) => exchangeCode(http, Date.now, sign),
			(grant) => {
				const tokens = new RefreshingTokens(http, Date.now, grant.refreshToken, grant);
				return currentAccount(new DropboxClient({ http, now: Date.now, sleep: windowSleep, tokens }));
			},
		);
		if (this.unloaded) return;
		if (result.status === "not-waited") {
			new Notice(t("dropbox.notWaited"), 0);
			return;
		}
		// Used, or turned down: no second return goes on from it.
		this.store.saveSignIn(null);
		if (result.status === "denied") {
			new Notice(t("dropbox.denied"));
			return;
		}
		if (result.status === "failed") {
			const detail = result.error instanceof Error ? result.error.message : String(result.error);
			new Notice(t("dropbox.signInFailed", { detail }), 0);
			return;
		}
		const settings = this.deviceSettings;
		if (settings === null) {
			new Notice(t("settings.unknownVersion"), 0);
			return;
		}
		const { grant, account } = result;
		this.store.saveDropboxToken(grant.refreshToken);
		this.dropboxAccess = { refreshToken: grant.refreshToken, tokens: new RefreshingTokens(http, Date.now, grant.refreshToken, grant) };
		// Another account than the one before is a new connection, and its
		// sync state is discarded; the same account keeps it (R-4).
		this.updateSettings({ ...settings, dropboxAccount: { id: account.accountId, email: account.email } });
		new Notice(t("dropbox.connected", { email: account.email }));
		this.settingTab?.redrawIfShown();
	}

	/**
	 * Ends the connection to Dropbox: the token is revoked on Dropbox's
	 * side, and taken off the device whatever Dropbox answers. The account
	 * stays in the settings, so that connecting again with it keeps the
	 * sync state (R-4). Never rejects.
	 */
	async disconnectDropbox(): Promise<void> {
		const refreshToken = this.store.readDropboxToken();
		// A sync that runs is stopped, and waited for, before the token
		// goes: revoked under it, a write would fail as if Dropbox had
		// turned this device away.
		await this.syncs.interrupt();
		this.store.saveDropboxToken(null);
		this.dropboxAccess = null;
		if (refreshToken === null) return;
		try {
			const tokens = new RefreshingTokens(deviceNetwork().http, Date.now, refreshToken);
			await revokeToken(deviceNetwork().http, await tokens.get());
		} catch (error) {
			// Ended on Dropbox's side already: nothing to tell.
			if (error instanceof BackendError && error.kind === "unauthorized") return;
			log(`dropbox: the token could not be revoked: ${error instanceof Error ? error.message : String(error)}`);
			if (!this.unloaded) new Notice(this.t("dropbox.revokeFailed"), 0);
		}
	}

	readGdriveToken(): string | null {
		return this.store.readGdriveToken();
	}

	/**
	 * The client of Google to connect with: Sync Evo's, or the one of the
	 * user's own the settings name, with the secret this device keeps for it.
	 */
	private gdriveClient(clientId: string | undefined = this.deviceSettings?.gdriveClientId): GoogleClient {
		return googleClientOf(clientId, this.store.readGdriveClientSecret());
	}

	gdriveTokens(refreshToken: string, clientId: string | undefined = this.deviceSettings?.gdriveClientId): AccessTokens {
		const client = this.gdriveClient(clientId);
		const kept = this.gdriveAccess;
		if (kept !== null && kept.refreshToken === refreshToken && kept.client.id === client.id && kept.client.secret === client.secret) {
			return kept.tokens;
		}
		const tokens = new GoogleTokens(deviceNetwork().http, Date.now, client, refreshToken);
		this.gdriveAccess = { refreshToken, client, tokens };
		return tokens;
	}

	/** The account this device is connected to Google Drive with, or `null` while it is not. */
	gdriveConnection(): { readonly email: string } | null {
		const account = this.deviceSettings?.gdriveAccount ?? null;
		return account !== null && this.store.readGdriveToken() !== null ? { email: account.email } : null;
	}

	/**
	 * A code of Google, ahead of the press of "Connect" (R-1): the one asked
	 * for before while it is on its way or lasts, or a new one.
	 */
	prepareGdriveCode(): Promise<DeviceCode> {
		const kept = this.gdriveCode;
		if (kept !== null && (kept.code === null || kept.code.expiresAt - Date.now() > CODE_MARGIN_MS)) return kept.asked;
		const asked = requestDeviceCode(deviceNetwork().http, Date.now, this.gdriveClient());
		const entry: { readonly asked: Promise<DeviceCode>; code: DeviceCode | null } = { asked, code: null };
		this.gdriveCode = entry;
		asked.then(
			(code) => {
				entry.code = code;
			},
			() => {
				// Asked for again by the next drawing of the settings.
				if (this.gdriveCode === entry) this.gdriveCode = null;
			},
		);
		return asked;
	}

	/**
	 * Connects to Google Drive by the device flow (R-1). Called in the
	 * handler of the press, with nothing awaited before. The dialog shows the
	 * code first, copied at once when it was asked for ahead (the clipboard
	 * too takes a press on some platforms); without one, the dialog asks for
	 * it. The browser opens from the button of the dialog only, in the
	 * handler of its press, which iOS needs. Sync Evo waits for the user to
	 * allow while the dialog is up; closing it stops the wait.
	 */
	connectGdrive(prefetched: DeviceCode | null): void {
		const http = deviceNetwork().http;
		const client = this.gdriveClient();
		const ready = prefetched !== null && prefetched.expiresAt - Date.now() > CODE_MARGIN_MS ? prefetched : null;
		// A code is for one press.
		this.gdriveCode = null;
		const copied = ready === null ? null : copyText(ready.userCode);
		const code = ready === null ? requestDeviceCode(http, Date.now, client) : Promise.resolve(ready);
		const modal = new DriveCodeModal(this.app, this.t, {
			code,
			copied,
			copy: copyText,
			open: (url) => {
				window.open(url);
			},
		});
		modal.open();
		void this.finishGdriveSignIn(code, modal);
	}

	/** Waits for the user to allow, and keeps what Google gives. Never rejects. */
	private async finishGdriveSignIn(code: Promise<DeviceCode>, modal: DriveCodeModal): Promise<void> {
		const t = this.t;
		const http = deviceNetwork().http;
		const client = this.gdriveClient();
		try {
			const waited = await waitForDeviceGrant(http, Date.now, windowSleep, client, await code, modal.signal);
			if (this.unloaded || waited.status === "cancelled") return;
			if (waited.status === "denied") {
				new Notice(t("gdrive.denied"));
				return;
			}
			if (waited.status === "expired") {
				new Notice(t("gdrive.expired"), 0);
				return;
			}
			const { grant } = waited;
			const tokens = new GoogleTokens(http, Date.now, client, grant.refreshToken, grant);
			const account = await currentDriveAccount(new DriveClient({ http, now: Date.now, sleep: windowSleep, tokens }));
			if (this.unloaded) return;
			const settings = this.deviceSettings;
			if (settings === null) {
				new Notice(t("settings.unknownVersion"), 0);
				return;
			}
			this.store.saveGdriveToken(grant.refreshToken);
			this.gdriveAccess = { refreshToken: grant.refreshToken, client, tokens };
			// Another account than the one before is a new connection, and its
			// sync state is discarded, with the folder found for that account;
			// the same account keeps both (R-1, as R-4).
			const same = settings.gdriveAccount?.id === account.accountId;
			this.updateSettings({
				...settings,
				gdriveAccount: { id: account.accountId, email: account.email },
				gdriveFolderId: same ? settings.gdriveFolderId : null,
			});
			new Notice(t("gdrive.connected", { email: account.email }));
			this.settingTab?.redrawIfShown();
		} catch (error) {
			if (this.unloaded) return;
			if (error instanceof GoogleClientSecretMissingError) {
				new Notice(t(error.own ? "gdrive.ownClientNoSecret" : "gdrive.noClientSecret"), 0);
				return;
			}
			new Notice(t("gdrive.signInFailed", { detail: error instanceof Error ? error.message : String(error) }), 0);
		} finally {
			modal.close();
		}
	}

	/**
	 * Ends the connection of this device to Google Drive: its token is taken
	 * off the device, and Google is not told. Google's revocation is of
	 * everything the account allowed the project, and would end the
	 * connection of every other device as well (measured 2026-10-17, as
	 * Google's guide for limited-input devices says). The settings say how
	 * to end it for every device: in the Google Account. The account and
	 * the folder stay in the settings, as with Dropbox. Never rejects.
	 */
	async disconnectGdrive(): Promise<void> {
		await this.syncs.interrupt();
		this.store.saveGdriveToken(null);
		this.gdriveAccess = null;
	}

	/**
	 * A sync found the folder of the vault on Drive by its name, or made it:
	 * its id is kept, while the settings still name that folder of that
	 * account and keep no id. The same connection still: nothing is discarded.
	 */
	driveFolderFound(id: string, account: string, folder: string): void {
		const settings = this.deviceSettings;
		if (settings === null || settings.backend !== "gdrive" || settings.gdriveFolderId !== null) return;
		if (settings.gdriveAccount?.id !== account || settings.gdriveFolder !== folder) return;
		this.updateSettings({ ...settings, gdriveFolderId: id });
	}

	/**
	 * The folder of the vault, by the id kept, is gone from Drive (R-3): the
	 * id is let go of, which is a change of the connection, and the sync
	 * state is discarded (D-2). The next sync looks for the folder by its
	 * name again, as a first sync.
	 */
	driveFolderGone(id: string): void {
		const settings = this.deviceSettings;
		if (settings === null || settings.gdriveFolderId !== id) return;
		this.updateSettings({ ...settings, gdriveFolderId: null });
	}

	/** The secret of the Google client of the user's own this device keeps, or "". */
	gdriveClientSecret(): string {
		return this.store.readGdriveClientSecret() ?? "";
	}

	/**
	 * Takes the secret of the Google client of the user's own. The tokens
	 * are taken with it from here on: a new secret of the same client keeps
	 * the connection.
	 */
	setGdriveClientSecret(typed: string): void {
		this.store.saveGdriveClientSecret(typed.trim());
		this.gdriveAccess = null;
		this.gdriveCode = null;
	}

	/**
	 * Takes the id of the Google client of the user's own: "" goes back to
	 * the client of Sync Evo. Another client than the one before takes no
	 * refresh token of the one before, so this device is disconnected, and
	 * the user connects again. The account and the folder stay: where the
	 * client is of another project, the folder kept is no longer seen, and
	 * the next sync starts over in a new one (R-3). Answers whether the
	 * client changed. Never rejects.
	 */
	async setGdriveClientId(typed: string): Promise<boolean> {
		const settings = this.deviceSettings;
		if (settings === null) return false;
		const id = typed.trim();
		const next = isOwnClient(id === "" ? undefined : id) ? id : undefined;
		if (next === settings.gdriveClientId) return false;
		await this.disconnectGdrive();
		this.gdriveCode = null;
		const current = this.deviceSettings ?? settings;
		const { gdriveClientId: _, ...rest } = current;
		this.updateSettings(next === undefined ? rest : { ...rest, gdriveClientId: next });
		return true;
	}

	/** What the settings show of the paid plan, or `null` while it is off, or with GitHub, which it does not apply to. */
	paidInfo(settings: DeviceSettings): PaidInfo | null {
		if (!this.paid.enabled || settings.backend === "github") return null;
		return {
			standing: this.paid.standing(settings),
			license: this.paid.licenseStanding(),
			key: this.paid.license()?.key ?? "",
			ownClient: settings.backend === "gdrive" && isOwnClient(settings.gdriveClientId),
		};
	}

	/** Takes the license key typed in the settings (`PaidGate.setKey`). Never rejects. */
	async setLicenseKey(typed: string): Promise<void> {
		await this.paid.setKey(typed, this.deviceSettings?.deviceName ?? "");
	}

	/** Asks GitHub for the head of the branch with the settings as given. Sends nothing else. */
	testConnection(settings: DeviceSettings): Promise<CheckOutcome> {
		return runConnectionCheck(
			settings,
			(name) => this.store.readToken(name),
			(target) =>
				new GitHubClient({
					...target,
					http: deviceNetwork().http,
					now: Date.now,
					sleep: windowSleep,
					// The user is looking at the button. A limit is reported, not waited out.
					onRateLimit: () => false,
				}),
			{
				readToken: () => this.store.readDropboxToken(),
				check: (target) =>
					checkDropboxFolder(
						new DropboxClient({
							http: deviceNetwork().http,
							now: Date.now,
							sleep: windowSleep,
							tokens: this.dropboxTokens(target.refreshToken),
							// The user is looking at the button.
							maxRetries: 1,
						}),
						target.folder,
					),
			},
			{
				readToken: () => this.store.readGdriveToken(),
				check: (target) =>
					checkDriveFolder(() =>
						new GDriveBackend(
							new DriveClient({
								http: deviceNetwork().http,
								now: Date.now,
								sleep: windowSleep,
								tokens: this.gdriveTokens(target.refreshToken, target.clientId),
								// The user is looking at the button.
								maxRetries: 1,
							}),
							{ folder: target.folder, folderId: target.folderId },
						).locate(),
					),
			},
		);
	}
}
