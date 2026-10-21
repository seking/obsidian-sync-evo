/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { vi } from "vitest";
import { PaidGuard } from "../../src/core/paid-guard";
import { NO_DEVICE_EXCLUSION } from "../../../src/core/device-exclusion";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../../../src/core/settings";

/** Settings of a device that syncs with Dropbox or Google Drive, connected to an account. */
export function paidSettings(backend: "dropbox" | "gdrive", over: Partial<DeviceSettings> = {}): DeviceSettings {
	return {
		backend,
		repository: "",
		branch: "main",
		tokenSecret: "",
		dropboxFolder: "Vault",
		dropboxAccount: { id: "dbid:1", email: "a@example.com" },
		gdriveFolder: "Vault",
		gdriveAccount: { id: "perm1", email: "a@example.com" },
		gdriveFolderId: null,
		deviceName: "iPhone",
		autoSync: DEFAULT_AUTO_SYNC,
		onConflict: "copy",
		deviceExclusion: NO_DEVICE_EXCLUSION,
		exclusionChangeTold: true,
		...over,
	};
}

/**
 * The local storage of the app, where the plan of the app keeps what it
 * remembers (`paid-storage.ts`), stood in for in `window`: what was written,
 * as JSON, by key.
 */
export function stubLocalStorage(values = new Map<string, string>()): Map<string, string> {
	const localStorage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
	};
	vi.stubGlobal("window", { ...(globalThis as { window?: object }).window, setTimeout, clearTimeout, localStorage });
	return values;
}

/**
 * The guard of a backend while the plan is not switched on, as in the tests
 * that do not mock it (`PAID_ENABLED_AT`): everything is let through, and
 * nothing asked.
 */
export function freeGuard(): PaidGuard {
	return new PaidGuard({
		backend: "dropbox",
		ownClient: false,
		refreshToken: "refresh",
		askAccount: () => Promise.reject(new Error("not to be asked")),
		askSince: () => Promise.reject(new Error("not to be asked")),
		settings: paidSettings("dropbox"),
		http: () => Promise.reject(new Error("offline")),
	});
}
