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
	"settings.symlinks.name": "Skipped symbolic links",
	"settings.symlinks.desc":
		"Symbolic links on the remote are not written to this device, and are left as they are on the remote. Each is listed with where it points, as of the last pull.",
	"settings.symlinks.item": "{path} → {target}",

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

	"notice.remotePathCollision":
		"The remote has paths that differ only in upper and lower case, or only in their Unicode form (NFC and NFD). Not every device can keep such paths apart, so none of them is written here. Rename them on the remote:\n{list}",
	"notice.tooLarge": "Files over {limit} MB are not synced. They are skipped and left as they are:\n{list}",
	"notice.lfsPointer":
		"The remote has Git LFS pointer files. Sync Evo syncs each pointer as it is and does not fetch the content it stands for, so these files do not open on this device:\n{list}",
	"notice.invalidPath": "The remote has paths that cannot be used as file paths. They are skipped:\n{list}",
	"notice.pluginNotListed":
		"The list of active community plugins that was just pulled ({path}) does not include Sync Evo. The next time Obsidian starts, Sync Evo will be turned off and syncing stops. Turn it on again under Settings → Community plugins.",
	"notice.unwritablePath":
		"This device refused to write or to delete some files, so the pull skipped them. Nothing about them was changed on the remote, and each pull tries them again:\n{list}",
	"notice.blockedPath":
		"The file {path} of the remote could not be written: files that are only on this device are in its place. Move or rename them, and the next pull writes it:\n{list}",

	// Lists inside a message.
	"list.separator": ", ",
	"list.more": { one: "…and {count} more", other: "…and {count} more" },

	// The commands.
	"command.pull": "Pull",

	// A pull: its progress, its outcome, and what the user has to know of it.
	"pull.alreadyRunning": "A pull is already running.",
	"pull.progress.starting": "Pull: starting…",
	"pull.progress.listing": "Pull: checking the remote…",
	"pull.progress.scanning": "Pull: looking through the vault…",
	"pull.progress.hashing": "Pull: comparing files ({done}/{total})…",
	"pull.progress.applyingStart": "Pull: updating files…",
	"pull.progress.applying": "Pull: updating files ({done}/{total})…",
	"pull.progress.graphClosed":
		"Graph views are closed while the files are written. They reopen when the pull ends.",
	"pull.count.fetched": { one: "{count} file fetched", other: "{count} files fetched" },
	"pull.count.deleted": { one: "{count} file deleted", other: "{count} files deleted" },
	"pull.count.renamed": { one: "{count} file renamed", other: "{count} files renamed" },
	"pull.count.conflicts": { one: "{count} conflict", other: "{count} conflicts" },
	"pull.summary": "Pull finished: {details}.",
	"pull.done": "Pull finished.",
	"pull.upToDate": "Nothing to pull. This device is up to date.",
	"pull.remoteEmpty": "The remote is empty: it has no commits yet. There is nothing to pull.",
	"pull.declined": "The pull was cancelled. Nothing was changed.",
	"pull.cancelled": "The pull was stopped. The next pull continues from there.",
	"pull.failed": "The pull failed. {reason}",
	"pull.error.incompleteListing":
		"The repository has more files than GitHub lists in one response (over 100,000 entries, or a listing over 7 MB), so Sync Evo cannot sync it.",
	"pull.error.other": "Details: {detail}",
	"pull.incomplete": {
		one: "{count} file could not be pulled and is left for the next sync. {reason}",
		other: "{count} files could not be pulled and are left for the next sync. {reason}",
	},
	"pull.incompleteSome": "Some files could not be pulled and are left for the next sync. {reason}",
	"pull.reason.hashMismatch": "The content GitHub sent did not match its own listing.",
	"pull.reason.unreadable": "A file on this device could not be read.",
	"pull.conflicts": {
		one: "The content of {count} file on this device was kept under another name:\n{list}",
		other: "The content of {count} files on this device was kept under another name:\n{list}",
	},
	"pull.conflict.conflict": "{copy} (a conflict: {path} now has the content of the remote)",
	"pull.conflict.becameSymlink":
		"{copy} ({path} is a symbolic link on the remote now, which is not written to this device)",
	"pull.conflict.becameFolder": "{copy} ({path} is a folder on the remote now)",
	"pull.conflict.nameTaken": "{copy} (the remote renamed another file to {path})",
	"pull.trashed": {
		one: "{count} file was moved to .trash/ in this vault before the pull replaced or removed it. You can get it back from there:\n{list}",
		other: "{count} files were moved to .trash/ in this vault before the pull replaced or removed them. You can get them back from there:\n{list}",
	},
	"pull.symlinks": {
		one: "The remote has {count} symbolic link. Sync Evo does not write it to this device and leaves it as it is on the remote. The settings list the links that are skipped:\n{list}",
		other: "The remote has {count} symbolic links. Sync Evo does not write them to this device and leaves them as they are on the remote. The settings list the links that are skipped:\n{list}",
	},

	// Why there is no sync state to work with.
	"state.waiting": "Waiting for the sync state of the previous connection to be removed…",
	"state.newerVersion":
		"The sync state of this vault was written by a newer version of Sync Evo. Update the plugin to sync. Nothing was changed.",
	"state.noAppId":
		"Obsidian did not give the ID of this vault, so Sync Evo has nowhere to keep its sync state. Nothing was synced.",
	"state.noIndexedDb":
		"This device does not provide IndexedDB, where Sync Evo keeps its sync state. Nothing was synced.",
	"state.openFailed":
		"The sync state could not be opened, so nothing was synced. Restart Obsidian and try again.",
	"state.discardFailed":
		"The sync state of the previous connection could not be removed, so nothing was synced. Restart Obsidian and try again.",

	// The questions a pull stops to ask.
	"confirm.proceed": "Proceed",
	"confirm.keepLocal": "Keep my files",
	"confirm.cancel": "Cancel",
	"confirm.delete.title": "Delete these files from this device?",
	"confirm.delete.body": {
		one: "{count} file on this device was deleted on the remote or turned into a symbolic link there. The pull deletes it from this device.",
		other: "{count} files on this device were deleted on the remote or turned into symbolic links there. The pull deletes them from this device.",
	},
	"confirm.delete.note": "If you cancel, nothing is pulled and nothing is changed.",
	"confirm.rewritten.title": "The history of the remote was rewritten",
	"confirm.rewritten.body":
		"The remote no longer builds on what this device last synced with, as happens after a force push. Changes that came from this device may be gone from it. Following the remote takes the files below away from this device.",
	"confirm.rewritten.deletions": { one: "{count} file to delete:", other: "{count} files to delete:" },
	"confirm.rewritten.overwrites": {
		one: "{count} file to replace with the content of the remote:",
		other: "{count} files to replace with the content of the remote:",
	},
	"confirm.rewritten.trashNote":
		"\"Proceed\" follows the remote. These files are first moved to .trash/ in this vault, so you can get them back.",
	"confirm.rewritten.keepNote":
		"\"Keep my files\" leaves these files as they are and pulls everything else. \"Cancel\" pulls nothing.",
});
