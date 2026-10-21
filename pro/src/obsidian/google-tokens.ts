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

// The access tokens of Google Drive, for the whole app: kept while the
// refresh token they come from and the client they are taken with are the
// ones in use, so that a token is taken again only once it ends. Made here,
// with the client the paid plan is decided by (`remotes.ts`).

import { deviceNetwork } from "../../../src/obsidian/http";
import { type GoogleClient, GoogleTokens } from "../core/gdrive/auth";

let kept: { readonly refreshToken: string; readonly client: GoogleClient; readonly tokens: GoogleTokens } | null = null;

/** The access tokens for this refresh token, taken with `client`. */
export function googleTokens(refreshToken: string, client: GoogleClient): GoogleTokens {
	if (kept !== null && kept.refreshToken === refreshToken && kept.client.id === client.id && kept.client.secret === client.secret) {
		return kept.tokens;
	}
	const tokens = new GoogleTokens(deviceNetwork().http, Date.now, client, refreshToken);
	kept = { refreshToken, client, tokens };
	return tokens;
}

/** Keeps the tokens a connection was just made with, so that the first sync takes none again. */
export function keepGoogleTokens(refreshToken: string, client: GoogleClient, tokens: GoogleTokens): void {
	kept = { refreshToken, client, tokens };
}

/** Lets go of the tokens kept: the connection ended, or its client changed. */
export function forgetGoogleTokens(): void {
	kept = null;
}
