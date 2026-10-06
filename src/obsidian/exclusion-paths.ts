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

import type { App, PluginManifest } from "obsidian";
import type { ExclusionPaths } from "../core/exclusion";

/**
 * What the exclusion needs to know from the app: the name of the
 * configuration folder, which a user can change, and the folder this plugin
 * is installed in. The app leaves the folder out of a manifest it did not
 * load from a disk; the place it installs a plugin to is used then.
 */
export function exclusionPathsOf(app: App, manifest: PluginManifest): ExclusionPaths {
	const configDir = app.vault.configDir;
	return { configDir, pluginDir: manifest.dir ?? `${configDir}/plugins/${manifest.id}` };
}
