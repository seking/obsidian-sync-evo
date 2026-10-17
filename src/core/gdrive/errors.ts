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

// The failures of the Google Drive remote that the user is told of in words
// of their own, apart from the backend so that the reports need not import it.

import { BackendError, RateLimitedError } from "../backend";

/**
 * The folder of the vault, by the id this device kept, is no longer to be
 * seen: deleted, put in the trash, or out of sight of the client (R-3). The
 * sync state is discarded, as when the folder is changed (D-2), and the
 * next sync is a first one. Nothing on the device is changed for it: a
 * remote that looks empty is not read as one where everything was deleted.
 */
export class DriveFolderGoneError extends BackendError {
	readonly folderId: string;

	constructor(folderId: string, detail: string) {
		super("not-found", `the folder of the vault on Google Drive is gone: ${detail}`);
		this.name = "DriveFolderGoneError";
		this.folderId = folderId;
	}
}

/**
 * More than one folder of the name that is to be synced with: the folder of
 * Sync Evo at the top of Drive, or the folder of the vault in it (R-3).
 * Which one is meant cannot be told, so nothing is synced until the user
 * leaves one of them.
 */
export class DriveDuplicateFolderError extends BackendError {
	/** The path of the folder, as the user sees it on Drive: `Sync Evo` or `Sync Evo/Vault`. */
	readonly folder: string;

	constructor(folder: string) {
		super("other", `more than one folder ${folder} on Google Drive`);
		this.name = "DriveDuplicateFolderError";
		this.folder = folder;
	}
}

/**
 * The build has no client secret of Sync Evo's client: one made from the
 * source without it (`esbuild.config.mjs`). Google would answer "client_secret
 * is missing" only after the user typed the code, so Sync Evo stops before
 * asking. The released builds have it.
 */
export class GoogleClientSecretMissingError extends BackendError {
	constructor() {
		super("other", "this build of Sync Evo has no client secret of Google");
		this.name = "GoogleClientSecretMissingError";
	}
}

/**
 * Google answered that the requests of the day have run out
 * (`dailyLimitExceeded`): the cap that the author of Sync Evo sets on the
 * project of its client, which every user shares (R-1). Not a wait that a
 * retry gets past, nor a matter of the connection: it ends at midnight in
 * the Pacific time (`waitUntil`), and automatic sync waits until then.
 * `at` is when Google answered so: the end is on the next day from 16:00
 * in Japan, and is then told with its date.
 */
export class DriveDailyLimitError extends RateLimitedError {
	readonly at: number;

	constructor(waitUntil: number, at: number, message: string) {
		super(waitUntil, message);
		this.name = "DriveDailyLimitError";
		this.at = at;
	}
}
