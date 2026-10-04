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

import { baseCatalog } from "./catalog";

/**
 * The base catalog. Every message is added here first; its keys and
 * placeholders are what the other languages are checked against.
 */
export const en = baseCatalog({
	// Names of the file type and vault configuration toggles. They follow the
	// wording of the same options of Obsidian Sync in the app, in each
	// language, so do not reword them here.
	"fileTypes.images": "Sync images",
	"fileTypes.audio": "Sync audio",
	"fileTypes.videos": "Sync videos",
	"fileTypes.pdfs": "Sync PDFs",
	"fileTypes.others": "Sync all other types",
	"vaultConfig.main": "Main settings",
	"vaultConfig.appearance": "Appearance settings",
	"vaultConfig.themesAndSnippets": "Themes and snippets",
	"vaultConfig.hotkeys": "Hotkeys",
	"vaultConfig.corePluginList": "Active core plugin list",
	"vaultConfig.corePluginSettings": "Core plugin settings",
	"vaultConfig.communityPluginList": "Active community plugin list",
	"vaultConfig.communityPlugins": "Installed community plugins",
});
