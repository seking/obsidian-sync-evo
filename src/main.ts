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
import { type CheckOutcome, runConnectionCheck } from "./core/connection-check";
import {
	applyExclusionEdit,
	type ExclusionEdit,
	type ExclusionScreenDeps,
	type ExclusionWrite,
	readExclusionScreen,
	saveGitignoreText,
} from "./core/exclusion-settings";
import { settleGitignoreWrite } from "./core/gitignore-file";
import { GitHubClient } from "./core/github/client";
import { timerSleep } from "./core/github/timer-sleep";
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
import { exclusionPathsOf } from "./obsidian/exclusion-paths";
import type { ExclusionChange, ExclusionLoad } from "./obsidian/exclusion-settings";
import { obsidianHttp } from "./obsidian/http";
import { pullVaultOf } from "./obsidian/pull-vault";
import { type SyncHost, SyncRunner } from "./obsidian/sync-runner";
import { SettingsStore } from "./obsidian/settings-store";
import { type SettingsHost, SyncEvoSettingTab } from "./obsidian/settings-tab";
import { SyncState, syncStateDepsOf } from "./obsidian/sync-state";

export default class SyncEvoPlugin extends Plugin implements SettingsHost, SyncHost {
	/** Looks up every text the plugin shows, in the language of the app. */
	t: Translate = translatorFor("");

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
	 * push that did not finish is looked for; and never while there is no
	 * connection.
	 */
	readonly syncState = new SyncState(syncStateDepsOf(this.app, () => this.syncs.stateBlocked()));

	/** The one place a sync of any kind is started from, so that two never run at once. */
	private readonly syncs = new SyncRunner(this);

	/** The plugin is going away: nothing more is shown. */
	private unloaded = false;

	override onload(): void {
		// A change of the app language takes effect on restart, so reading it once is enough.
		this.t = translatorFor(getLanguage());

		const loaded = this.store.load(defaultDeviceName(Platform));
		this.deviceSettings = loaded.status === "ok" ? loaded.settings : null;
		this.addSettingTab(new SyncEvoSettingTab(this.app, this, this));

		// The only things that start a sync. Each is started by the user, and
		// keeps the screen on while it runs (`SyncRunner.run`). The button
		// of the ribbon is the sync: a pull, and then a push.
		this.addCommand({
			id: "sync",
			name: this.t("command.sync"),
			callback: () => void this.syncs.run("sync"),
		});
		this.addRibbonIcon("refresh-cw", this.t("command.sync"), () => void this.syncs.run("sync"));
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

		// Once the app is up. The sync state is only read: nothing is asked
		// of the remote, and nothing is sent again.
		this.app.workspace.onLayoutReady(() => void this.remindOfPushFailure());
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
			const vault = pullVaultOf(this.app);
			this.syncState.requestDiscard(
				this.syncs.interrupt(),
				change === "changed" ? (store) => settleGitignoreWrite({ store, vault }) : undefined,
			);
		}
		this.deviceSettings = next;
		this.store.save(next);
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

	/**
	 * A write of the settings to the root `.gitignore`: turned away while a
	 * sync runs, and no sync begins while it runs. Never rejects.
	 */
	private async changeGitignore(
		write: (deps: ExclusionScreenDeps) => Promise<ExclusionWrite>,
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

	/** Asks GitHub for the head of the branch with the settings as given. Sends nothing else. */
	testConnection(settings: DeviceSettings): Promise<CheckOutcome> {
		return runConnectionCheck(
			settings,
			(name) => this.store.readToken(name),
			(target) =>
				new GitHubClient({
					...target,
					http: obsidianHttp,
					now: Date.now,
					sleep: timerSleep,
					// The user is looking at the button. A limit is reported, not waited out.
					onRateLimit: () => false,
				}),
		);
	}
}
