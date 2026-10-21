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

// The backends of Dropbox and Google Drive, made here with their client and
// what the paid plan lets them do (`paid-guard.ts`). The plan they go by is
// the one of the app (`app-gate.ts`), and what it is decided by comes from
// the clients made here and from the services, not from the settings.

import type { Backend } from "../../../src/core/backend";
import type { ConnectionCheck, DriveCheckTarget, DropboxCheckTarget } from "../../../src/core/connection-check";
import type { HttpFunction, Sleep } from "../../../src/core/http";
import type { DeviceSettings } from "../../../src/core/settings";
import { currentAccount } from "../core/dropbox/auth";
import { DropboxBackend } from "../core/dropbox/backend";
import { type AccessTokens, DropboxClient } from "../core/dropbox/client";
import { dropboxSince } from "../core/dropbox/since";
import { currentDriveAccount, googleClientOf, isOwnClient } from "../core/gdrive/auth";
import { GDriveBackend } from "../core/gdrive/backend";
import { checkDriveFolder } from "../core/gdrive/check";
import { DriveClient } from "../core/gdrive/client";
import type { DriveQuota } from "../core/gdrive/quota";
import { PaidGuard } from "../core/paid-guard";
import { googleTokens } from "./google-tokens";

/** What a sync gives the backend of Dropbox or Google Drive, apart from the settings. */
export interface RemoteDeps {
	readonly http: HttpFunction;
	readonly sleep: Sleep;
	readonly signal: AbortSignal;
	/** Each wait before a request is sent again, and what the plan could not learn. */
	readonly log: (line: string) => void;
	/** The most the files fetched at once, and the contents sent at once, may add up to, in bytes. */
	readonly maxConcurrentFetchBytes: number;
}

/** The backend of one sync, with what the paid plan of the account is decided by. */
export interface PaidRemote {
	readonly backend: Backend;
	/**
	 * When the count of the free time of the account started, asked of the
	 * service once for the sync, and kept where the plan of the app reads
	 * it (`PaidGuard.learnSince`). `null` when the service cannot tell, or
	 * could not be asked.
	 */
	readonly learnSince: () => Promise<number | null>;
}

/** The backend of Dropbox for a sync with these settings. */
export function dropboxRemote(
	settings: DeviceSettings,
	target: DropboxCheckTarget,
	deps: RemoteDeps & {
		/** Where the access tokens come from, for the refresh token. */
		readonly tokens: (refreshToken: string) => AccessTokens;
		readonly yieldControl: () => Promise<void>;
	},
): PaidRemote {
	const { http, sleep, signal, log, maxConcurrentFetchBytes } = deps;
	const client = new DropboxClient({ http, now: Date.now, sleep, signal, tokens: deps.tokens(target.refreshToken), log });
	const plan = new PaidGuard({
		backend: "dropbox",
		ownClient: false,
		refreshToken: target.refreshToken,
		askAccount: async () => (await currentAccount(client)).accountId,
		// The file at the top of the app folder: a request or two.
		askSince: () => dropboxSince(client, Date.now),
		settings,
		http,
		log,
	});
	const backend = new DropboxBackend(client, {
		folder: target.folder,
		yieldControl: deps.yieldControl,
		signal,
		maxConcurrentFetchBytes,
		plan,
	});
	return { backend, learnSince: () => plan.learnSince() };
}

/**
 * The client of Google of `target` (`DriveCheckTarget.clientId`): Sync
 * Evo's, or one of the user's own with `secret`. The tokens are taken with
 * it, and the plan is decided by it: a client id that is not the one the
 * tokens were given to gets none.
 */
function driveClientOf(target: DriveCheckTarget, secret: string) {
	const google = googleClientOf(target.clientId, secret);
	return { tokens: googleTokens(target.refreshToken, google), ownClient: isOwnClient(google.id) };
}

/** The backend of Google Drive for a sync with these settings. */
export function driveRemote(
	settings: DeviceSettings,
	target: DriveCheckTarget,
	deps: RemoteDeps & {
		/** The secret this device keeps for a client of the user's own, or "". */
		readonly clientSecret: string;
		/** The units of the Drive API this device has used (`DriveQuota`). */
		readonly quota: DriveQuota;
		/** Told the id of the folder of the vault once it was found by its name, or made. */
		readonly onFolderFound?: (id: string) => void;
	},
): PaidRemote {
	const { http, sleep, signal, log, maxConcurrentFetchBytes } = deps;
	const { tokens, ownClient } = driveClientOf(target, deps.clientSecret);
	const client = new DriveClient({
		http,
		now: Date.now,
		sleep,
		signal,
		tokens,
		quota: deps.quota,
		// Each wait before a request is sent again.
		log,
	});
	const plan = new PaidGuard({
		backend: "gdrive",
		ownClient,
		refreshToken: target.refreshToken,
		askAccount: async () => (await currentDriveAccount(client)).accountId,
		// By the id of the folder `Sync Evo` the one kept is in: one small
		// request. Without a folder kept, the lookup by the name tells it
		// (`onSince`).
		askSince: () => backend.topCreatedAt(),
		settings,
		http,
		log,
	});
	const backend: GDriveBackend = new GDriveBackend(client, {
		folder: target.folder,
		folderId: target.folderId,
		...(deps.onFolderFound === undefined ? {} : { onFolderFound: deps.onFolderFound }),
		// The start of the free time of the account (`paid.ts`).
		onSince: (at) => plan.sinceTold(at),
		signal,
		maxConcurrentFetchBytes,
		plan,
	});
	return { backend, learnSince: () => plan.learnSince() };
}

/**
 * Asks Google Drive about the folder of the vault, as a sync would find it
 * (`checkDriveFolder`), for the test of the connection with these settings.
 * Never throws.
 */
export function checkDriveConnection(
	settings: DeviceSettings,
	target: DriveCheckTarget,
	deps: { readonly http: HttpFunction; readonly sleep: Sleep; readonly clientSecret: string },
): Promise<ConnectionCheck> {
	const { tokens, ownClient } = driveClientOf(target, deps.clientSecret);
	const client = new DriveClient({
		http: deps.http,
		now: Date.now,
		sleep: deps.sleep,
		tokens,
		// The user is looking at the button.
		maxRetries: 1,
	});
	// Not asked: the lookup of the folder is no call of a sync.
	const plan = new PaidGuard({
		backend: "gdrive",
		ownClient,
		refreshToken: target.refreshToken,
		askAccount: async () => (await currentDriveAccount(client)).accountId,
		askSince: () => Promise.resolve(null),
		settings,
		http: deps.http,
	});
	return checkDriveFolder(() => new GDriveBackend(client, { folder: target.folder, folderId: target.folderId, plan }).locate());
}
