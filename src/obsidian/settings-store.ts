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

import type { App } from "obsidian";
import { type DeviceSettings, type ParsedSettings, parseSettings, serializeSettings } from "../core/settings";

// The app puts the id of the vault in front of the key, which is what keeps
// the settings of one vault from another's.
const KEY = "sync-evo-settings";

/**
 * Where the settings and the token are kept on the device. Both are outside
 * the vault, and nothing is written to the plugin's `data.json`: that file is
 * inside the vault, where a `git add -A` on a desktop would commit it.
 */
export class SettingsStore {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	load(defaultDeviceName: string): ParsedSettings {
		return parseSettings(this.app.loadLocalStorage(KEY), defaultDeviceName);
	}

	save(settings: DeviceSettings): void {
		this.app.saveLocalStorage(KEY, serializeSettings(settings));
	}

	/** Removes what is stored, as if nothing had been saved for this vault. */
	clear(): void {
		this.app.saveLocalStorage(KEY, null);
	}

	/**
	 * The token saved under a name in the app's secret storage, or `null`
	 * when there is none. Trimmed, since a pasted token easily carries a
	 * line break and GitHub would refuse it for that.
	 */
	readToken(secretName: string): string | null {
		const value = this.app.secretStorage.getSecret(secretName);
		return typeof value === "string" ? value.trim() : null;
	}
}
