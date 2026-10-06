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

import { getLanguage, Platform, Plugin } from "obsidian";
import { type CheckOutcome, runConnectionCheck } from "./core/connection-check";
import { GitHubClient } from "./core/github/client";
import { timerSleep } from "./core/github/timer-sleep";
import { type Translate, translatorFor } from "./core/i18n";
import {
	type ConnectionChange,
	connectionChange,
	connectionOf,
	defaultDeviceName,
	defaultSettings,
	type DeviceSettings,
} from "./core/settings";
import { obsidianHttp } from "./obsidian/http";
import { SettingsStore } from "./obsidian/settings-store";
import { type SettingsHost, SyncEvoSettingTab } from "./obsidian/settings-tab";

export default class SyncEvoPlugin extends Plugin implements SettingsHost {
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

	override onload(): void {
		// A change of the app language takes effect on restart, so reading it once is enough.
		this.t = translatorFor(getLanguage());

		const loaded = this.store.load(defaultDeviceName(Platform));
		this.deviceSettings = loaded.status === "ok" ? loaded.settings : null;
		this.addSettingTab(new SyncEvoSettingTab(this.app, this, this));
	}

	override onunload(): void {
		// Nothing to clean up yet.
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
		// Nothing acts on `change` yet. When there is a sync state, it is
		// discarded here on "set" and "changed", so that the records of one
		// repository are never compared with another; a change of the token
		// or the device name is "none" and keeps it.
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
