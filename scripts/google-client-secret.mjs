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

// The client secret of Sync Evo's Google client, which esbuild puts into
// main.js (`define` in esbuild.config.mjs). It is kept out of the repository:
// Google's OAuth 2.0 Policies ask that client credentials not be committed
// to a public one. In main.js it is no secret, as Google's guide to
// installed apps says of every installed app.
//
// Taken from the environment variable SYNC_EVO_GOOGLE_CLIENT_SECRET, or else
// from the file ~/.config/sync-evo/google-client-secret (the value alone;
// spaces and line ends around it are dropped).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const SECRET_ENV = "SYNC_EVO_GOOGLE_CLIENT_SECRET";
export const SECRET_FILE = join(homedir(), ".config", "sync-evo", "google-client-secret");
/** Set by the release scripts: the build fails without the secret. */
export const REQUIRE_ENV = "SYNC_EVO_REQUIRE_GOOGLE_CLIENT_SECRET";

/** The secret and where it came from, or null when there is none. */
export function googleClientSecret() {
	const fromEnv = (process.env[SECRET_ENV] ?? "").trim();
	if (fromEnv !== "") return { value: fromEnv, source: `the environment variable ${SECRET_ENV}` };
	let fromFile = "";
	try {
		fromFile = readFileSync(SECRET_FILE, "utf8").trim();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return fromFile === "" ? null : { value: fromFile, source: SECRET_FILE };
}
