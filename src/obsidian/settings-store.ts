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
import type { PendingSignIn } from "../core/dropbox/auth";
import { type DeviceSettings, type ParsedSettings, parseSettings, serializeSettings } from "../core/settings";

// The app puts the id of the vault in front of the key, which is what keeps
// the settings of one vault from another's.
const KEY = "sync-evo-settings";
/** The refresh token of Dropbox, apart from the settings: it is only there while this device is connected. */
const DROPBOX_TOKEN_KEY = "sync-evo-dropbox-token";
/** The sign-in to Dropbox that waits for the browser to come back (R-4). */
const DROPBOX_SIGN_IN_KEY = "sync-evo-dropbox-sign-in";
/** The refresh token of Google Drive, kept like the one of Dropbox (R-1). */
const GDRIVE_TOKEN_KEY = "sync-evo-gdrive-token";
/** The secret of a Google client of the user's own (T082), kept like the token. */
const GDRIVE_CLIENT_SECRET_KEY = "sync-evo-gdrive-client-secret";


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

	/**
	 * The refresh token of Dropbox, or `null` while this device is not
	 * connected. Kept by the app in this device's storage for the vault, and
	 * not in its secret storage: it is a value Sync Evo was handed, not one
	 * the user chose (R-4).
	 */
	readDropboxToken(): string | null {
		const value: unknown = this.app.loadLocalStorage(DROPBOX_TOKEN_KEY);
		return typeof value === "string" && value !== "" ? value : null;
	}

	saveDropboxToken(token: string | null): void {
		this.app.saveLocalStorage(DROPBOX_TOKEN_KEY, token);
	}

	/** The refresh token of Google Drive, or `null` while this device is not connected. Kept as the one of Dropbox (R-1). */
	readGdriveToken(): string | null {
		const value: unknown = this.app.loadLocalStorage(GDRIVE_TOKEN_KEY);
		return typeof value === "string" && value !== "" ? value : null;
	}

	saveGdriveToken(token: string | null): void {
		this.app.saveLocalStorage(GDRIVE_TOKEN_KEY, token);
	}

	/**
	 * The secret of the Google client of the user's own, or `null` for none.
	 * Beside the token, and not in the settings with the client id: it is
	 * not to travel with them, in a copy or a report of the settings.
	 */
	readGdriveClientSecret(): string | null {
		const value: unknown = this.app.loadLocalStorage(GDRIVE_CLIENT_SECRET_KEY);
		return typeof value === "string" && value !== "" ? value : null;
	}

	saveGdriveClientSecret(secret: string | null): void {
		this.app.saveLocalStorage(GDRIVE_CLIENT_SECRET_KEY, secret === "" ? null : secret);
	}

	readSignIn(): PendingSignIn | null {
		const value: unknown = this.app.loadLocalStorage(DROPBOX_SIGN_IN_KEY);
		if (typeof value !== "object" || value === null) return null;
		const { verifier, state, at } = value as Record<string, unknown>;
		if (typeof verifier !== "string" || typeof state !== "string" || typeof at !== "number") return null;
		return { verifier, state, at };
	}

	/** Written at once: the browser is opened right after, and the app may be closed while it is out. */
	saveSignIn(pending: PendingSignIn | null): void {
		this.app.saveLocalStorage(DROPBOX_SIGN_IN_KEY, pending);
	}
}
