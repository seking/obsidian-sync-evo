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
	"settings.connection.heading": "Connection",
	"settings.repository.name": "Repository",
	"settings.repository.desc":
		"The GitHub repository to sync this vault with. Enter it as owner/name, or paste its address from the browser.",
	"settings.repository.placeholder": "owner/name",
	"settings.repository.invalid": "This is not in the form owner/name, so it was not saved.",
	"settings.branch.name": "Branch",
	"settings.branch.desc": "The branch to sync with.",
	"settings.branch.placeholder": "main",
	"settings.branch.empty": "Enter a branch. The previous branch is still in use.",
	"settings.token.name": "Token",
	"settings.token.desc":
		"A fine-grained personal access token with Contents read and write on the repository. It is kept in Obsidian's Keychain, and not in a file of the vault. Whether the other vaults on this device can use it depends on the device.",
	"settings.deviceName.name": "Device name",
	"settings.deviceName.desc": "It appears in commit messages and in the names of files kept from a conflict.",
	"settings.deviceName.empty": "Enter a name. The previous name is still in use.",
	"settings.deviceName.invalidCharacter":
		"A device name cannot contain a line break, a tab, or any of * \" \\ / < > : | ? # ^ [ ]. The previous name is still in use.",
	"settings.test.name": "Connection test",
	"settings.test.button": "Test",
	"settings.test.running": "Checking…",
	"settings.unknownVersion":
		"The settings of this vault were written by a newer version of Sync Evo. Update the plugin to use them. Until then Sync Evo does not sync and leaves the settings as they are.",
	"settings.reset.name": "Start over",
	"settings.reset.desc":
		"Discards the settings of this vault on this device so that you can enter them again in this version. The token stays in Obsidian's Keychain.",
	"settings.reset.button": "Discard settings",
	// The group between the connection and what is synced. Its heading is
	// not "Automatic sync": how a conflict is handled goes into it as well.
	"settings.howItSyncs.heading": "How it syncs",
	"settings.autoSync.onStartup.name": "Sync on startup",
	"settings.autoSync.onStartup.desc":
		"Syncs when Obsidian starts, and when you come back to it from another app. Not when the last sync started less than 5 minutes ago.",
	"settings.autoSync.atInterval.name": "Sync at an interval",
	"settings.autoSync.atInterval.desc":
		"Syncs while Obsidian is in front, each time the interval below has passed since the last sync started.",
	"settings.autoSync.interval.name": "Interval (minutes)",
	"settings.autoSync.interval.desc":
		"From {min} to {max} minutes. At least {sendingMin} while automatic sync also sends changes.",
	"settings.autoSync.interval.invalid":
		"Enter a whole number of minutes from {min} to {max}. The previous interval is still in use.",
	"settings.autoSync.interval.raised":
		"Raised to {minutes} minutes, because automatic sync now also sends changes.",
	"settings.autoSync.sends.name": "Also send changes in automatic sync",
	"settings.autoSync.sends.desc":
		"When this is off, automatic sync only receives: what you edit on this device is not sent until you sync manually. When it is on, each automatic sync that finds changes on this device makes a commit, so the interval is at least {sendingMin} minutes.",
	"settings.onConflict.name": "On a conflict",
	"settings.onConflict.desc":
		"What happens to a file that was changed both on this device and on the remote. Merging goes line by line, and a file that cannot be merged is kept as a separate file. What a file held on this device before a merge is put in .trash/.sync-evo-merged/ in this vault.",
	"settings.onConflict.merge": "Merge automatically",
	"settings.onConflict.copy": "Keep as a separate file",
	"settings.symlinks.name": "Skipped symbolic links",
	"settings.symlinks.summary": { one: "{count} link", other: "{count} links" },
	"settings.symlinks.desc":
		"Symbolic links on the remote are not written to this device. Each is listed with where it points, as of the last pull.",
	"settings.symlinks.item": "{path} → {target}",

	// The part of the settings screen about what is synced: the switches that
	// write the lines Sync Evo manages in .gitignore, and the file itself.
	"settings.exclusion.heading": "What is synced",
	"settings.exclusion.desc":
		"These settings are written into the .gitignore at the root of this vault, and apply alike to all your devices and to git on a computer. Excluding something deletes nothing. What the remote already holds stays synced until it is untracked.",
	"settings.exclusion.tracked": {
		one: "{count} file that matches an exclusion rule is still on the remote, as of the last sync.",
		other: "{count} files that match an exclusion rule are still on the remote, as of the last sync.",
	},
	"settings.exclusion.untrack.name": "Files that match a rule",
	"settings.exclusion.untrack.desc":
		"Untracking removes them from the remote, and they are no longer synced. The files on this device stay.",
	"settings.exclusion.handEdited":
		"The lines Sync Evo manages in .gitignore were edited by hand. The switches show them as Sync Evo reads them. The next change made with a switch rewrites these lines in Sync Evo's own form. Lines it does not know are kept.",
	"settings.exclusion.noState":
		"The sync state of this vault cannot be used at the moment, so what is synced cannot be shown or changed here. Run a sync to see why.",
	"settings.exclusion.syncRunning":
		"A sync is running, so nothing can be changed here until it has ended, and what is shown may be out of date. Open the settings again afterwards.",
	"settings.exclusion.unsettled":
		"An earlier change to .gitignore did not finish, and the file may be incomplete. It is not shown until that is settled. Check that .gitignore at the root of the vault can be read on this device, then open the settings again.",
	"settings.exclusion.unreadable.notAFile":
		"There is a folder named .gitignore at the root of this vault, so there are no rules to show or change. Rename or remove that folder.",
	"settings.exclusion.unreadable.tooLarge":
		"The .gitignore of this vault is over {limit} MB, so it is not read and cannot be changed here. Make it smaller on a computer.",
	"settings.exclusion.unreadable.notDownloaded":
		"The .gitignore of this vault is not downloaded to this device (a cloud drive keeps only a placeholder), so it cannot be shown or changed here. Download it, then open the settings again.",
	"settings.exclusion.unreadable.respelled":
		"The .gitignore of this vault is spelled with other upper and lower case (.GITIGNORE, say), so it is not read as rules and cannot be changed here. Rename it to .gitignore.",
	"settings.exclusion.unreadable.readFailed":
		"The .gitignore of this vault could not be read, so it cannot be shown or changed here. Open the settings again to retry.",
	"settings.exclusion.unreadable.notText":
		"The .gitignore of this vault is not UTF-8 text, so it cannot be shown or changed here without damaging it. Save it as UTF-8 on a computer.",
	"settings.exclusion.broken":
		"The two lines that mark the lines Sync Evo manages in .gitignore (they start with \"# >>> Sync Evo\" and \"# <<< Sync Evo\") do not form one pair: one is missing, one is there twice, or they are in the wrong order. The switches are hidden until that is put right. Correct the file under \"Write rules directly (.gitignore)\": keep one of each, the first above the second. Or delete every line that starts with either of the two, and the next sync adds the managed lines again.",
	"settings.exclusion.noSection.name": "Lines managed by Sync Evo",
	"settings.exclusion.noSection.desc":
		"The .gitignore of this vault has no lines managed by Sync Evo yet, so there is nothing to switch. Until it has, Sync Evo applies the default lines as if they were there, on every device. Git on a computer does not, since the lines are not in the file. The next sync that sends changes adds them as well.",
	"settings.exclusion.noSection.button": "Add the lines Sync Evo manages",
	"settings.exclusion.noSection.syncFirst":
		"This device has not pulled from the remote yet, so the lines are not added here: a .gitignore on the remote would then be in conflict with this one. Sync first. The sync adds the lines.",
	"settings.exclusion.noSection.overLimit":
		"With these lines .gitignore would be over {limit} MB, so they cannot be added, here or by a sync. Shorten the file first.",
	"settings.exclusion.fileKinds.name": "File types",
	"settings.exclusion.fileKinds.desc":
		"Applies to files outside the configuration folder. Notes, canvases and bases are always synced.",
	"settings.exclusion.folders.name": "Excluded folders",
	"settings.exclusion.folders.desc": "Add folders that are not synced, as paths from the root of the vault.",
	"settings.exclusion.folders.placeholder": "folder/subfolder",
	"settings.exclusion.folders.add": "Add",
	"settings.exclusion.folders.remove": "Remove",
	"settings.exclusion.folders.invalid":
		"This is not the path of a folder from the root of the vault, so nothing was added.",
	"settings.exclusion.config.name": "Vault configuration",
	"settings.exclusion.config.desc":
		"Which parts of the configuration folder are synced. A change that is pulled may only take effect after Obsidian is reloaded.",
	"settings.exclusion.config.summary": "{count} of {total} synced",
	"settings.exclusion.communityPluginList.warning":
		"While this is on, keep Sync Evo enabled on all your devices. If it is not enabled on one of them, Sync Evo is turned off on this device as well the next time Obsidian starts, and syncing stops.",
	"settings.exclusion.communityPlugins.warning":
		"The data.json of your other plugins is synced as well (it can hold tokens and other credentials). Plugin code that comes from your other devices runs on this device. Turn it on only with devices and a repository you trust.",
	"settings.exclusion.fixedOff.name": "Exclusions that are not in effect",
	"settings.exclusion.fixedOff.desc":
		"The lines below are there to keep the trash, the layout of the workspace, Sync Evo's own folder, and files an operating system leaves behind out of the sync. They are not in effect: the line was deleted, or a later line that starts with ! undoes it. What they left out is synced now. Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it.",
	"settings.exclusion.fixedOff.restore": "Restore",
	"settings.exclusion.fixedOff.restoreNote":
		"Restoring puts the deleted lines back among the lines Sync Evo manages. A line that a later line starting with ! undoes stays listed here after that: change that later line under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.fixedOff.undone":
		"None of these lines is missing, so there is nothing to restore: a later line that starts with ! undoes each of them. Change those lines under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.fixedOff.undoneNoSection":
		"A line of .gitignore that starts with ! undoes each of them. Change those lines under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.editor.name": "Write rules directly (.gitignore)",
	"settings.exclusion.editor.desc":
		"The whole .gitignore at the root of this vault. Write your own rules outside the lines Sync Evo manages (between \"# >>> Sync Evo\" and \"# <<< Sync Evo\"). Nothing is saved until you press Save, and using a switch discards what is typed here and not saved.",
	"settings.exclusion.editor.absent": "This vault has no .gitignore yet. Saving creates it.",
	"settings.exclusion.editor.save": "Save",
	"settings.exclusion.editor.saved": "Saved .gitignore. The next sync sends it to the remote.",
	"settings.exclusion.notices.name": "Found by the last sync",
	"settings.exclusion.notices.desc": "What applies to this vault, as of the last sync.",
	"settings.exclusion.write.syncing": "A sync is running. .gitignore cannot be changed until it has ended.",
	"settings.exclusion.write.changed":
		".gitignore was changed after this screen read it, so nothing was written. The screen now shows the file as it is. Make the change again.",
	"settings.exclusion.write.refused": "This device refused to write .gitignore. Nothing was changed.",
	"settings.exclusion.write.unsettled":
		".gitignore could not be written to its end, or an earlier change to it could not be finished. The file may be incomplete, and no push goes by it until that is settled. Check that the file can be written on this device, then open the settings again.",
	"settings.exclusion.write.overLimit":
		"With this change .gitignore would be over {limit} MB, and a file over that is not synced. Nothing was written.",
	"settings.exclusion.write.unreadable":
		".gitignore can no longer be read on this device, so nothing was written.",
	"settings.exclusion.write.noState":
		"The sync state of this vault cannot be used at the moment, so .gitignore was not changed. Run a sync to see why.",
	"settings.exclusion.write.failed": ".gitignore was not changed: {detail}",

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
		"The remote contains Sync Evo's own folder ({path}). Sync Evo never syncs that folder: it is left as it is, on the remote and on this device. Everything else is synced as usual. To remove the folder from the remote, untrack its files in the settings of Sync Evo (while .gitignore has the line for that folder).",
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
		"This device refused to write, move, or delete some files, so the pull skipped them. Nothing about them was changed on the remote, and each pull tries them again:\n{list}",
	"notice.blockedPath":
		"The file {path} of the remote could not be written: files that are only on this device are in its place. Move or rename them, and the next pull writes it:\n{list}",
	"notice.archiveLimited":
		"Downloading all files at once did not work on this device. From now on Sync Evo does not try it here when the download is expected to be about {size} MB or more. Many files are then fetched one by one, which takes longer.",
	"notice.archiveGivenUp":
		"Downloading all files at once did not work on this device, so Sync Evo no longer tries it here. When there are many files to fetch, they are now fetched one by one, which takes longer.",
	"notice.localPathCollision":
		"Some new files were not sent. Their paths differ only in upper and lower case from another path on the remote, or from another new file. Rename them, and the next push sends them. Other files are sent as usual:\n{list}",
	"notice.renameNotSent":
		"Some files were renamed on this device in upper and lower case only, and the new name is not sent: a rule of .gitignore excludes it, or it differs only in case from another path. The file under the old name was therefore not deleted on the remote either:\n{list}",
	"notice.nestedGitignore":
		"There are .gitignore files in subfolders. Sync Evo syncs them as ordinary files and does not read them as rules: only the .gitignore at the root of the vault decides what is synced. Git on a computer does apply them, so the same vault is treated differently there. Put the rules you need into the .gitignore at the root:\n{list}",
	"notice.fixedExclusionOff":
		"Some of the lines Sync Evo manages in .gitignore are not in effect: they were deleted, or a later line undoes them. What they left out is synced now (the trash, the layout of the workspace, files an operating system leaves behind). Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it. Deleted lines can be restored in the settings of Sync Evo; where a later line that starts with ! undoes one, change that line:\n{list}",
	"notice.submodule":
		"The remote has submodules. Sync Evo does not sync what is inside a submodule yet: its folder is not created on this device, and nothing in it is fetched or sent. Everything else is synced as usual:\n{list}",

	// The lines Sync Evo manages in .gitignore, added by a push without
	// asking. In the question before a first push, and else in a message of
	// its own.
	"section.added.intro":
		"Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
	"section.added.created":
		"This vault had no .gitignore, so Sync Evo created one with the lines below. They are the lines Sync Evo manages, and say what is not synced:",
	"section.added.outside": "Nothing else in .gitignore was changed.",
	"section.added.sends": "This push sends the change to the remote.",
	"section.added.sent": "This push sent the change to the remote.",
	"section.added.unsent": "The change has not been sent to the remote yet. The next push sends it.",
	"section.added.unknown":
		"Whether this push sent the change to the remote is not known. If it did not, the next push sends it.",
	"section.added.howTo":
		"You can change these lines in the settings of Sync Evo. If you do not want them, delete the lines in between and keep the first and the last line (the two that start with #): if those two are deleted as well, the next sync adds the lines again.",
	"section.added.tracked": {
		one: "{count} file that these lines match is already on the remote, so it stays synced:",
		other: "{count} files that these lines match are already on the remote, so they stay synced:",
	},
	"section.added.untrackHint":
		"To stop syncing them, untrack them in the settings of Sync Evo. That removes them from the remote and leaves them on this device.",

	// Lists inside a message.
	"list.separator": ", ",
	"list.showRest": "Show {count} more",
	"list.more": { one: "…and {count} more", other: "…and {count} more" },

	// The commands.
	"command.sync": "Sync (pull, then push)",
	"command.pull": "Pull",
	"command.push": "Push",
	"command.firstFetch": "First fetch (discard the sync state and start over)",
	"command.stop": "Stop the sync",
	"command.showLog": "Show the recent log",

	// The last lines of the log, shown on the device. The lines themselves are not translated.
	"log.title": "Recent log",
	"log.desc":
		"What Sync Evo has done since it was loaded, newest at the bottom. Kept in memory on this device only, and gone when Obsidian is closed or Sync Evo is updated.",
	"log.empty": "Nothing has been logged yet.",
	"log.copy": "Copy all",
	"log.copied": "Copied the log.",
	"log.copyFailed": "Could not copy. Select the lines by hand and copy them.",

	// A pull: its progress, its outcome, and what the user has to know of it.
	"sync.alreadyRunning": "A sync is already running.",
	"pull.notRunning": "No sync is running.",
	// A sync that started by itself. It tells nothing when it went well.
	// What it does tell comes under this line, the waits below included,
	// which therefore do not name it again; what stands in its way is told
	// once, and not again while it stays the same.
	"auto.heading": "Automatic sync:",
	"auto.waiting.deletions":
		"Pulling would delete many files on this device, which needs your confirmation. Nothing was changed. Sync manually to be asked.",
	"auto.waiting.rewritten":
		"The history of the remote was rewritten, so pulling needs your confirmation. Nothing was changed. Sync manually to be asked.",
	"auto.waiting.firstFetch":
		"The first fetch into this vault is not finished. It is not started without you, and not continued while files in the vault differ from the remote's. Nothing was changed. Sync manually to start or continue it.",
	"auto.waiting.firstPush":
		"The first push from this device needs your confirmation. Nothing was sent. Sync manually to be asked.",
	"auto.waiting.pushDeletions":
		"Pushing would delete many files on the remote, which needs your confirmation. Nothing was sent. Sync manually to be asked.",
	"auto.waiting.emptyVault":
		"None of the files synced before is on this device, which needs your confirmation. Nothing was sent. Sync manually to be asked.",
	"pull.progress.starting": "Pull: starting…",
	"pull.progress.listing": "Pull: checking the remote…",
	"pull.progress.scanning": "Pull: looking through the vault…",
	"pull.progress.hashing": "Pull: comparing files ({done}/{total})…",
	"pull.progress.applyingStart": "Pull: updating files…",
	"pull.progress.applying": "Pull: updating files ({done}/{total})…",
	"pull.progress.downloadingArchive": "Pull: downloading all files at once…",
	"pull.progress.archiveWaiting": "Pull: waiting for the download of the stopped pull to end…",
	"pull.progress.stopping": "Pull: stopping…",
	"pull.progress.archiveRetry":
		"The last download did not finish. Keep Obsidian in front and wait until this one is done.",
	"pull.progress.graphClosed":
		"Graph views are closed while the files are written. They reopen when the pull ends.",
	"pull.progress.rateLimited":
		"GitHub's request limit was reached. The pull continues at {time}. You can close the app: the next sync continues from where it stopped.",
	"pull.progress.overQuota": {
		one: "About {count} file can be fetched before GitHub's request limit is reached. The rest continues after {time}.",
		other: "About {count} files can be fetched before GitHub's request limit is reached. The rest continues after {time}.",
	},
	"pull.count.fetched": { one: "{count} file fetched", other: "{count} files fetched" },
	"pull.count.deleted": { one: "{count} file deleted", other: "{count} files deleted" },
	"pull.count.renamed": { one: "{count} file renamed", other: "{count} files renamed" },
	"pull.count.conflicts": { one: "{count} conflict", other: "{count} conflicts" },
	"pull.count.merged": { one: "{count} file merged", other: "{count} files merged" },
	"pull.summary": "Pull finished: {details}.",
	"pull.refetched": {
		one: "{count} file was missing from the download of all files, or differed from GitHub's listing there. It was fetched on its own.",
		other: "{count} files were missing from the download of all files, or differed from GitHub's listing there. They were fetched one by one.",
	},
	"pull.done": "Pull finished.",
	"pull.upToDate": "Nothing to pull. This device is up to date.",
	"pull.remoteEmpty": "The remote is empty: it has no commits yet. There is nothing to pull.",
	"pull.declined": "The pull was cancelled. Nothing was changed.",
	"pull.declinedAfterTrash":
		"The pull was cancelled. Only the files listed below were moved to .trash/ in this vault. Nothing else was changed.",
	"pull.cancelled": "The pull was stopped. The next pull continues from there.",
	"pull.cancelledAfter": "Done before it stopped: {details}.",
	"pull.connectionChanged":
		"The pull was stopped because the connection was changed. The next pull starts with the new connection.",
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
	"pull.reason.trashFailed": "A file on this device could not be moved to .trash/ in this vault.",
	"pull.notDownloaded": {
		one: "{count} file is not downloaded to this device (a cloud drive keeps only a placeholder). Download it, then sync again:\n{list}",
		other:
			"{count} files are not downloaded to this device (a cloud drive keeps only a placeholder). Download them, then sync again:\n{list}",
	},
	"pull.unreadable": {
		one: "{count} file on this device could not be read and was left as it is. Check it, then sync again:\n{list}",
		other: "{count} files on this device could not be read and were left as they are. Check them, then sync again:\n{list}",
	},
	"pull.waitingForUnread": {
		one: "{count} other file was not pulled either: it waits for a file that is left for the next sync. A later sync pulls it.",
		other: "{count} other files were not pulled either: they wait for a file that is left for the next sync. A later sync pulls them.",
	},
	"pull.conflicts": {
		one: "The content of {count} file on this device was kept under another name:\n{list}",
		other: "The content of {count} files on this device was kept under another name:\n{list}",
	},
	"pull.conflict.conflict": "{copy} (a conflict: {path} now has the content of the remote)",
	"pull.conflict.becameSymlink":
		"{copy} ({path} is a symbolic link on the remote now, which is not written to this device)",
	"pull.conflict.becameFolder": "{copy} ({path} is a folder on the remote now)",
	"pull.conflict.nameTaken": "{copy} (the remote renamed another file to {path})",
	"pull.merged": {
		one: "{count} file was changed both on this device and on the remote, and now holds the changes of both. What it held on this device before is in .trash/.sync-evo-merged/ in this vault:\n{list}",
		other: "{count} files were changed both on this device and on the remote, and now hold the changes of both. What they held on this device before is in .trash/.sync-evo-merged/ in this vault:\n{list}",
	},
	"pull.merged.item": "{path} (before: {kept})",
	"pull.replacedSettings": {
		one: "{count} file in the configuration folder now has the content of the remote. What it held on this device before is in .trash/ in this vault:\n{list}",
		other: "{count} files in the configuration folder now have the content of the remote. What they held on this device before is in .trash/ in this vault:\n{list}",
	},
	"pull.trashed": {
		one: "{count} file was moved to .trash/ in this vault by the pull, so that its content is not lost. You can get it back from there:\n{list}",
		other: "{count} files were moved to .trash/ in this vault by the pull, so that their content is not lost. You can get them back from there:\n{list}",
	},
	"pull.halfWritten": {
		one: "An earlier pull stopped while it was writing {count} file. What was left of it was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited the file since, you can get your edit back from there:\n{list}",
		other: "An earlier pull stopped while it was writing {count} files. What was left of them was moved to .trash/ in this vault. A pull fetches the content of the remote. If you had edited them since, you can get your edits back from there:\n{list}",
	},
	"pull.halfMerged": {
		one: "An earlier pull stopped while it was writing the merged content of {count} file. A pull fetches the content of the remote, without the changes of this device. What the file held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\n{list}",
		other: "An earlier pull stopped while it was writing the merged content of {count} files. A pull fetches the content of the remote, without the changes of this device. What the files held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\n{list}",
	},
	"pull.halfCopies": {
		one: "{count} conflict copy that an earlier pull left unfinished was moved to .trash/ in this vault. A complete copy is made again. If you had edited the copy, your edit is there:\n{list}",
		other: "{count} conflict copies that an earlier pull left unfinished were moved to .trash/ in this vault. Complete copies are made again. If you had edited the copies, your edits are there:\n{list}",
	},
	"pull.tidiedCopies": {
		one: "{count} conflict copy in _conflicts/ was made 30 days ago or more, and was moved to .trash/ in this vault. To keep a copy, move it out of _conflicts/ or rename it.",
		other: "{count} conflict copies in _conflicts/ were made 30 days ago or more, and were moved to .trash/ in this vault. To keep a copy, move it out of _conflicts/ or rename it.",
	},
	"pull.keptLocal": {
		one: "{count} file was left as it is on this device, as you chose. It differs from the remote:\n{list}",
		other: "{count} files were left as they are on this device, as you chose. They differ from the remote:\n{list}",
	},
	"pull.keptUnsent": {
		one: "{count} of the files you chose to keep on this device is not sent back to the remote, because a rule in .gitignore excludes it. It stays on this device only:\n{list}",
		other: "{count} of the files you chose to keep on this device are not sent back to the remote, because a rule in .gitignore excludes them. They stay on this device only:\n{list}",
	},
	"pull.symlinks": {
		one: "The remote has {count} symbolic link. Sync Evo does not write it to this device and leaves it as it is on the remote. The settings list the links that are skipped:\n{list}",
		other: "The remote has {count} symbolic links. Sync Evo does not write them to this device and leaves them as they are on the remote. The settings list the links that are skipped:\n{list}",
	},

	// A push: its progress, its outcome, and what the user has to know of it.
	"push.progress.starting": "Push: starting…",
	"push.progress.listing": "Push: checking the remote…",
	"push.progress.scanning": "Push: looking through the vault…",
	"push.progress.hashing": "Push: comparing files ({done}/{total})…",
	"push.progress.sendingStart": "Push: sending files…",
	"push.progress.sending": "Push: sending files ({done}/{total})…",
	"push.progress.finishing": "Push: finishing…",
	"push.progress.stopping": "Push: stopping…",
	"push.progress.rateLimited":
		"GitHub's limit on creating content was reached. The push continues at {time}. Keep Obsidian in front until then: a push that stops sends nothing.",
	"push.count.added": { one: "{count} file added", other: "{count} files added" },
	"push.count.modified": { one: "{count} file modified", other: "{count} files modified" },
	"push.count.deleted": { one: "{count} file deleted", other: "{count} files deleted" },
	"push.summary": "Push finished: {details}.",
	"push.nothing": "Nothing to push. The remote is up to date.",
	"push.nothingSent": "Nothing was sent.",
	"push.recovered": "The previous push had reached the remote: {details}. It is recorded on this device now.",
	"push.recoveredUntrack": {
		one: "An earlier untracking had reached the remote: {count} file untracked. It is recorded on this device now. The file on this device is as it was.",
		other: "An earlier untracking had reached the remote: {count} files untracked. It is recorded on this device now. The files on this device are as they were.",
	},
	"push.pullFirst.noBase":
		"Nothing was sent. This device has not finished its first pull from the remote yet. Pull first, then push.",
	"push.pullFirst.remoteEmpty":
		"Nothing was sent. The remote has no commits. This device has synced with this remote before, and the commits it had are gone. Pull first to look at that.",
	"push.pullFirst.notDefaultBranch":
		"Nothing was sent. The remote is empty: it has no commits yet. GitHub makes the first commit of an empty repository on its default branch, {branch}. Set the branch in the settings of Sync Evo to {branch}, or change the default branch of the repository on GitHub, then sync again.",
	"push.pullFirst.gitignoreUnreadable":
		"Nothing was sent. The .gitignore of this vault decides what is sent, and it cannot be read on this device: a cloud drive has not downloaded it, there is a folder named .gitignore, or its name differs in upper and lower case (.GITIGNORE, say). Put that right, then push again.",
	"push.pullFirst.remoteMoved":
		"Nothing was sent. The remote was changed from another device after this push began. Pull first, then push again.",
	"push.pullFirst.gitignore":
		"Nothing was sent. The .gitignore of this vault decides what is sent, and it could not be relied on: an editor could not save it, or an earlier pull stopped while writing it. If .gitignore is open in an editor, save or close it, then push again. Otherwise pull first, then push.",
	"push.declined": "The push was cancelled. Nothing was sent.",
	"push.cancelled": "The push was stopped. Nothing was sent.",
	"push.connectionChanged": "The push was stopped because the connection was changed. Nothing was sent.",
	"push.failed": "The push failed. {reason}",
	"push.unfinished":
		"The last sync ({time}) did not finish its push. Changes on this device may not have reached the remote. Nothing is sent again by itself: run a sync to send what this device holds now.",
	"push.error.workflows":
		"GitHub refused the push because it changes files under .github/workflows/. For that, the token also needs the Workflows read and write permission.",
	"push.error.notAsListed":
		"Nothing was sent. The remote does not hold what this device had listed for it. The next sync lists the remote again. Sync again.",
	"push.storedOtherwise": {
		one: "GitHub stored {count} file with other content than this device sent. The next pull replaces the file on this device with GitHub's version:\n{list}",
		other: "GitHub stored {count} files with other content than this device sent. The next pull replaces the files on this device with GitHub's versions:\n{list}",
	},
	"push.held": {
		one: "{count} file was not sent: a pull has not finished with it, or an editor could not save it. Sync again:\n{list}",
		other: "{count} files were not sent: a pull has not finished with them, or an editor could not save them. Sync again:\n{list}",
	},
	"push.remoteInTheWay": {
		one: "{count} file was not sent: the remote has a file or a folder in its place that this device has not pulled yet. Pull first, then push again:\n{list}",
		other: "{count} files were not sent: the remote has files or folders in their place that this device has not pulled yet. Pull first, then push again:\n{list}",
	},
	"push.notDownloaded": {
		one: "{count} new file was not sent: it is not downloaded to this device (a cloud drive keeps only a placeholder). Download it, then sync again:\n{list}",
		other: "{count} new files were not sent: they are not downloaded to this device (a cloud drive keeps only a placeholder). Download them, then sync again:\n{list}",
	},
	"push.grownTooLarge": {
		one: "{count} file was not sent: it grew past {limit} MB while the push ran. Files over {limit} MB are not synced:\n{list}",
		other: "{count} files were not sent: they grew past {limit} MB while the push ran. Files over {limit} MB are not synced:\n{list}",
	},
	"push.refusedSize": {
		one: "{count} file was not sent: GitHub refused it as too large. Make this file smaller or move it out of the vault. A file the remote does not hold yet is also left alone once it is in .gitignore. If it is a conflict copy, check its content and then delete it:\n{list}",
		other: "{count} files were not sent: GitHub refused them as too large. Make these files smaller or move them out of the vault. A file the remote does not hold yet is also left alone once it is in .gitignore. If one is a conflict copy, check its content and then delete it:\n{list}",
	},
	"push.refusedWorkflows": {
		one: "{count} file was not sent: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync sends it. Otherwise, put this file back as it was and change it on a device that has git. If it is a conflict copy that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n{list}",
		other: "{count} files were not sent: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync sends them. Otherwise, put these files back as they were and change them on a device that has git. If one is a conflict copy that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n{list}",
	},
	"push.leftOut": {
		one: "{count} file was left out: it changed or could not be read while the push ran, or an editor could not save it. The next push looks at it again:\n{list}",
		other: "{count} files were left out: they changed or could not be read while the push ran, or an editor could not save them. The next push looks at them again:\n{list}",
	},

	// Untracking: the question before it, and how it ended.
	"untrack.confirm.title": "Untrack files",
	"untrack.confirm.proceed": "Untrack",
	"untrack.confirm.cancel": "Not now",
	"untrack.confirm.body": {
		one: "{count} file on the remote matches a rule of .gitignore. Untracking removes it from the remote, and it is no longer synced:",
		other: "{count} files on the remote match a rule of .gitignore. Untracking removes them from the remote, and they are no longer synced:",
	},
	"untrack.confirm.threshold":
		"This removes {count} files from the remote at once. Check the list before you go on.",
	"untrack.confirm.keeps": "The files on this device are not deleted. They stay as they are.",
	"untrack.confirm.otherDevices":
		"On your other devices, the next pull deletes these files, except files that were changed on that device.",
	"untrack.confirm.mac":
		"To keep the files on a computer that uses git, do not untrack them here: run git rm --cached on that computer, and push from there. The next pull then deletes these files from this device.",
	"untrack.confirm.syncFirst":
		"A pull runs first. If the rules are not on the remote yet, a push follows, and it also sends the other changes of this device.",
	"untrack.confirm.missing": {
		one: "{count} of these files is not on this device. If it is in the list, it is marked there. After untracking, its content is only in the history of the remote.",
		other: "{count} of these files are not on this device. Those in the list are marked there. After untracking, their content is only in the history of the remote.",
	},
	"untrack.confirm.submodules": {
		one: "{count} submodule matches a rule as well. It is not untracked here. Untrack it with git on a Mac or another computer:",
		other: "{count} submodules match a rule as well. They are not untracked here. Untrack them with git on a Mac or another computer:",
	},
	"untrack.confirm.note":
		"If you choose \"Not now\", the rules stay, and these files stay synced. You can untrack them later in the settings of Sync Evo.",
	"untrack.item.tagged": "{path} ({tags})",
	"untrack.tag.symlink": "symbolic link",
	"untrack.tag.ownFolder": "Sync Evo's own folder",
	"untrack.tag.missing": "not on this device",
	"untrack.done": {
		one: "Untracked {count} file: it was removed from the remote. The file on this device is as it was.",
		other: "Untracked {count} files: they were removed from the remote. The files on this device are as they were.",
	},
	"untrack.nothing":
		"There was nothing to untrack: none of the listed files is still on the remote and matched by a rule. Nothing was changed.",
	"untrack.remoteMoved":
		"Nothing was untracked. The remote was changed from another device meanwhile. Untrack again in the settings of Sync Evo.",
	"untrack.cancelled": "Untracking was stopped. Nothing was removed from the remote.",
	"untrack.connectionChanged":
		"Untracking was stopped because the connection was changed. Nothing was removed from the remote.",
	"untrack.progress.running": "Untracking: removing the files from the remote…",
	"untrack.progress.stopping": "Untracking: stopping…",
	"untrack.submodules": {
		one: "{count} submodule on the remote matches a rule of .gitignore. Sync Evo does not untrack submodules. Untrack it with git on a Mac or another computer.",
		other: "{count} submodules on the remote match a rule of .gitignore. Sync Evo does not untrack submodules. Untrack them with git on a Mac or another computer.",
	},
	"untrack.failed": "Untracking failed. {reason}",
	"untrack.syncFirst.remoteEmpty":
		"Nothing was untracked. The remote has no commits. Sync first, then untrack again in the settings of Sync Evo.",
	"untrack.syncFirst.pullUnfinished":
		"Nothing was untracked. This device has not pulled everything from the remote yet. Sync until no file is left for later, then untrack again in the settings of Sync Evo.",
	"untrack.syncFirst.gitignoreUnsettled":
		"Nothing was untracked. The .gitignore of this vault could not be relied on: an editor could not save it, or an earlier write to it did not finish. Save or close it, sync, then untrack again in the settings of Sync Evo.",
	"untrack.syncFirst.gitignoreUnreadable":
		"Nothing was untracked. The .gitignore of this vault cannot be read on this device. The settings of Sync Evo say why. Put that right, then untrack again.",
	"untrack.syncFirst.noSection":
		"Nothing was untracked. The .gitignore of this vault has no lines managed by Sync Evo, so the rules that would apply are not in the file. Add the lines in the settings of Sync Evo and sync, then untrack again.",
	"untrack.syncFirst.sectionBroken":
		"Nothing was untracked. The two lines that mark the lines Sync Evo manages in .gitignore do not form one pair. Correct the file in the settings of Sync Evo and sync, then untrack again.",
	"untrack.syncFirst.gitignoreNotSent":
		"Nothing was untracked. The .gitignore of this device is not the one the remote holds, so the rules are not on the remote yet. Sync until .gitignore has been sent, then untrack again in the settings of Sync Evo.",
	"untrack.skipped.pullDeclined":
		"Nothing was untracked, because the pull was cancelled. The rules stay. You can untrack later in the settings of Sync Evo.",
	"untrack.skipped.pullCancelled":
		"Nothing was untracked, because the pull was stopped. The rules stay. You can untrack later in the settings of Sync Evo.",
	"untrack.skipped.pushNotDone":
		"Nothing was untracked, because the push that sends .gitignore to the remote did not go through. The rules stay. You can untrack later in the settings of Sync Evo.",

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

	// The questions a pull or a push stops to ask.
	"confirm.proceed": "Proceed",
	"confirm.keepLocal": "Keep my files",
	"confirm.cancel": "Cancel",
	"confirm.delete.title": "Confirm deletions",
	"confirm.delete.body": {
		one: "{count} file on this device was deleted on the remote or turned into a symbolic link there. The pull deletes it from this device.",
		other: "{count} files on this device were deleted on the remote or turned into symbolic links there. The pull deletes them from this device.",
	},
	"confirm.delete.note": "If you cancel, nothing is pulled and nothing is changed.",
	"confirm.firstFetch.title": "Confirm the first fetch",
	"confirm.firstFetch.body":
		"This is the first pull from {repository}, branch {branch}, and this vault already has files.",
	"confirm.firstFetch.different": {
		one: "{count} file has other content than the remote. It gets the content of the remote, and the content on this device is kept in the folder _conflicts/ under another name:",
		other: "{count} files have other content than the remote. They get the content of the remote, and the content on this device is kept in the folder _conflicts/ under another name:",
	},
	"confirm.firstFetch.differentSettings": {
		one: "{count} file in the configuration folder has other content than the remote. It gets the content of the remote, and the content on this device is moved to .trash/ in this vault:",
		other: "{count} files in the configuration folder have other content than the remote. They get the content of the remote, and the content on this device is moved to .trash/ in this vault:",
	},
	"confirm.firstFetch.localOnly": {
		one: "{count} file is only on this device. It stays on this device as it is. The next push sends it to the remote, unless it is excluded; before it sends, it shows the list of the files to send and asks once more:",
		other: "{count} files are only on this device. They stay on this device as they are. The next push sends them to the remote, except files that are excluded; before it sends, it shows the list of the files to send and asks once more:",
	},
	"confirm.firstFetch.atSymlinks": {
		one: "{count} file is at a path that is a symbolic link on the remote. It is not compared and stays as it is:",
		other: "{count} files are at paths that are symbolic links on the remote. They are not compared and stay as they are:",
	},
	"confirm.firstPush.title": "Confirm the first push",
	"confirm.firstPush.body":
		"This is the first push from this device to {repository}, branch {branch}. It changes the remote as listed below. Once a push has gone through, later pushes do not show this list.",
	"confirm.firstPush.remoteEmpty":
		"The remote is empty: it has no commits yet. A first commit with the .gitignore alone is made, and the rest is sent after it. If this vault has no .gitignore, an empty one is created.",
	"confirm.firstPush.remoteEmptyWithGitignore":
		"The remote is empty: it has no commits yet. A first commit with the .gitignore alone is made, and the rest is sent after it.",
	"confirm.firstPush.added": { one: "{count} file to add:", other: "{count} files to add:" },
	"confirm.firstPush.modified": { one: "{count} file to modify:", other: "{count} files to modify:" },
	"confirm.firstPush.deleted": { one: "{count} file to delete:", other: "{count} files to delete:" },
	"confirm.pushDelete.body": {
		one: "{count} file was deleted on this device. The push deletes it on the remote, and a pull then deletes it on your other devices.",
		other: "{count} files were deleted on this device. The push deletes them on the remote, and a pull then deletes them on your other devices.",
	},
	"confirm.pushDelete.alsoSent": "The same push also sends the files below to the remote.",
	// A push that finds none of the files it has a record of. Three answers,
	// each with a line that says what it does.
	"confirm.emptyVault.title": "No files in the vault",
	// With one file, under a key of its own: a language without plural forms
	// has other words for it too ("none of" one file reads oddly in Japanese).
	"confirm.emptyVault.bodyOne":
		"The {count} file that was synced before is not on this device. This happens when the vault was created again, or when its folder was deleted. The remote ({repository}, branch {branch}) still has it.",
	"confirm.emptyVault.body":
		"None of the {count} files that were synced before is on this device. This happens when the vault was created again, or when its folders were deleted. The remote ({repository}, branch {branch}) still has them.",
	"confirm.emptyVault.refetch": "Fetch again from the remote",
	"confirm.emptyVault.refetchNote": "The files of the remote are fetched to this device. Nothing is deleted on the remote.",
	"confirm.emptyVault.delete": "Delete on the remote too",
	"confirm.emptyVault.deleteNote": {
		one: "{count} file is deleted on the remote too, and a pull then deletes it on your other devices.",
		other: "{count} files are deleted on the remote too, and a pull then deletes them on your other devices.",
	},
	"confirm.emptyVault.cancelNote": "Nothing is sent and nothing is changed.",
	"confirm.push.note": "If you cancel, nothing is sent and nothing is changed.",
	"confirm.push.noteSection":
		"If you cancel, nothing is sent. The lines added to .gitignore stay on this device, and the next push sends them.",
	"confirm.startOver.title": "Discard the sync state and start over",
	"confirm.startOver.body":
		"This discards the sync state of this device and builds it again by pulling from {repository}, branch {branch}. The sync state is only Sync Evo's own record of what has been synced: no file is deleted, on this device or on the remote.",
	"confirm.startOver.nothing":
		"No file on this device has other content than the remote, and none is only on this device.",
	"confirm.startOver.note": "If you cancel, the sync state is kept and nothing is changed.",
	"confirm.rewritten.title": "Remote history rewritten",
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
