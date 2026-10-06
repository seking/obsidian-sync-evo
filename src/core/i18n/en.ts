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

	// The settings screen.
	"settings.repository.name": "Repository",
	"settings.repository.desc":
		"The GitHub repository to sync this vault with, as owner/name. You can also paste its address from the browser.",
	"settings.repository.placeholder": "owner/name",
	"settings.repository.invalid": "This is not in the form owner/name, so it was not saved.",
	"settings.branch.name": "Branch",
	"settings.branch.desc": "The branch to sync with.",
	"settings.branch.placeholder": "main",
	"settings.branch.empty": "Enter a branch. The previous branch is still in use.",
	"settings.token.name": "Token",
	"settings.token.desc":
		"A fine-grained personal access token with Contents read and write on the repository. It is kept in Obsidian's Keychain under the name you give it, and is shared by all vaults on this device.",
	"settings.deviceName.name": "Device name",
	"settings.deviceName.desc":
		"Distinguishes this device from your others. It appears in commit messages and in the names of files kept from a conflict.",
	"settings.deviceName.empty": "Enter a name. The previous name is still in use.",
	"settings.deviceName.invalidCharacter":
		"A device name cannot contain a line break, a tab, or any of * \" \\ / < > : | ? # ^ [ ]. The previous name is still in use.",
	"settings.test.name": "Connection",
	"settings.test.desc": "Checks that the token can reach the repository and the branch.",
	"settings.test.button": "Test connection",
	"settings.test.running": "Checking…",
	"settings.unknownVersion":
		"The settings of this vault were written by a newer version of Sync Evo. Update the plugin to use them. Until then Sync Evo does not sync and leaves the settings as they are.",
	"settings.reset.name": "Start over",
	"settings.reset.desc":
		"Discards the settings of this vault on this device so that you can enter them again in this version. The token stays in Obsidian's Keychain.",
	"settings.reset.button": "Discard settings",

	// The result of testing the connection.
	"check.connected": "Connected to {repository}, branch {branch}.",
	"check.empty": "Connected to {repository}. The remote is empty: it has no commits yet.",
	"check.unauthorized":
		"GitHub did not accept the token. It is wrong, or it was revoked or has expired. Create a new token and save it under the selected secret.",
	"check.forbidden":
		"The token is valid but lacks permission. It needs Contents read and write on {repository}.",
	"check.notFound": "{repository} does not exist, or the token was not given access to it.",
	"check.branchNotFound":
		"{repository} has no branch named {branch}. Sync Evo does not create it for you, so check the name.",
	"check.unreachable": "Could not reach GitHub. Check the network connection and try again.",
	"check.rateLimited": "GitHub's request limit has been reached. Try again later.",
	"check.other": "The connection test failed: {detail}",
	"check.noRepository": "Enter the repository as owner/name first.",
	"check.noBranch": "Enter a branch first.",
	"check.noTokenSecret": "Select the secret that holds the token first.",
	"check.noTokenValue": "The secret {name} has no value. Save the token under it, or select another secret.",

	// Things the user is told once, and again only after they went away and
	// came back. Neither stops the sync.
	"notice.ownFolderOnRemote":
		"The remote contains Sync Evo's own folder ({path}). Sync Evo never syncs that folder: it is left as it is, on the remote and on this device. Everything else is synced as usual.",
	"notice.gitAtRoot":
		"This vault has a .git at its root, so it is a git repository. Sync this device with git or the Obsidian Git plugin instead: git does not learn of what Sync Evo sends, and its next pull would stop. Sync Evo keeps syncing in the meantime.",
});
