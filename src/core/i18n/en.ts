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
	"vaultConfig.main.desc": "Sync editor settings, files & links settings, and the like.",
	"vaultConfig.appearance.desc": "Sync appearance settings like dark mode, the active theme, and enabled snippets.",
	"vaultConfig.themesAndSnippets.desc": "Sync downloaded themes and snippets. Whether they are enabled depends on the setting above.",
	"vaultConfig.hotkeys.desc": "Sync custom hotkeys.",
	"vaultConfig.corePluginList.desc": "Sync which core plugins are enabled.",
	"vaultConfig.corePluginSettings.desc": "Sync core plugin settings.",
	"vaultConfig.communityPluginList.desc": "Sync which community plugins are enabled.",
	"vaultConfig.communityPlugins.desc": "Sync installed community plugins (.js, .css, and manifest.json files) and their settings.",

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
	"settings.deviceName.desc": "It appears in commit messages and in the names of conflict files.",
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
		"From {min} to {max} minutes. At least {sendingMin} while automatic sync also uploads changes.",
	"settings.autoSync.interval.invalid":
		"Enter a whole number of minutes from {min} to {max}. The previous interval is still in use.",
	"settings.autoSync.interval.raised": "Raised to {minutes} minutes, because automatic sync now also uploads changes.",
	"settings.autoSync.sends.name": "Also upload changes in automatic sync",
	"settings.autoSync.sends.desc":
		"When this is off, automatic sync only downloads: what you edit on this device is not uploaded until you sync manually. When it is on, each automatic sync that finds changes on this device makes a commit, so the interval is at least {sendingMin} minutes.",
	"settings.onConflict.name": "On a conflict",
	"settings.onConflict.desc":
		"What happens to a file that was changed both on this device and on {remote}. Merging goes line by line, and a file that cannot be merged is kept as a conflict file. What a file held on this device before a merge is put in .trash/.sync-evo-merged/ in this vault.",
	"settings.onConflict.merge": "Automatically merge",
	"settings.onConflict.copy": "Create conflict file",
	"settings.symlinks.name": "Skipped symbolic links",
	"settings.symlinks.summary": { one: "{count} link", other: "{count} links" },
	"settings.symlinks.desc":
		"Symbolic links on {remote} are not written to this device. Each is listed with where it points, as of the last download.",
	"settings.symlinks.item": "{path} → {target}",

	// The part of the settings screen about what is not synced: the switches
	// that write the lines Sync Evo manages in .gitignore, the file itself,
	// and what this device alone leaves out.
	"settings.exclusion.heading": "Not synced (all devices)",
	"settings.exclusion.desc":
		"What you choose here is not synced on any of your devices. Nothing is deleted, neither the files on your devices nor what is on {remote}.",
	"settings.exclusion.tracked": {
		one: "{count} excluded file is still on {remote}, as of the last sync.",
		other: "{count} excluded files are still on {remote}, as of the last sync.",
	},
	"settings.exclusion.untrack.name": "Excluded files still on {remote}",
	"settings.exclusion.untrack.desc":
		"Sync Evo does not sync them on any device. Removing them from {remote} leaves the files on your devices with Sync Evo as they are.",
	"settings.exclusion.untrack.button": "Remove from {remote}",
	"settings.exclusion.untrack.noState":
		"The files cannot be removed from {remote} at the moment, and nothing was changed. Run a sync to see why.",
	"settings.exclusion.handEdited":
		"The lines Sync Evo manages in .gitignore were edited by hand. The switches show them as Sync Evo reads them. The next change made with a switch rewrites these lines in Sync Evo's own form. Lines it does not know are kept.",
	"settings.exclusion.noState":
		"What is not synced cannot be shown or changed here at the moment. Run a sync to see why.",
	"settings.exclusion.syncRunning":
		"A sync is running, so nothing can be changed here until it has ended, and what is shown may be out of date. Open the settings again afterwards.",
	"settings.exclusion.unsettled":
		"An earlier change to .gitignore did not finish, and the file may be incomplete. It is not shown until that is settled. Check that .gitignore at the root of the vault can be read on this device, then open the settings again.",
	"settings.exclusion.unreadable.notAFile":
		"There is a folder named .gitignore at the root of this vault, so there are no exclusions to show or change. Rename or remove that folder.",
	"settings.exclusion.unreadable.tooLarge":
		"The .gitignore of this vault is over {limit} MB, so it is not read and cannot be changed here. Make it smaller on a computer.",
	"settings.exclusion.unreadable.notDownloaded":
		"The .gitignore of this vault is not on this device yet (a cloud drive keeps only a placeholder), so it cannot be shown or changed here. Have the cloud drive keep it on this device, then open the settings again.",
	"settings.exclusion.unreadable.respelled":
		"The .gitignore of this vault is spelled with other upper and lower case (.GITIGNORE, say), so it is not read as exclusions and cannot be changed here. Rename it to .gitignore.",
	"settings.exclusion.unreadable.readFailed":
		"The .gitignore of this vault could not be read, so it cannot be shown or changed here. Open the settings again to retry.",
	"settings.exclusion.unreadable.notText":
		"The .gitignore of this vault is not UTF-8 text, so it cannot be shown or changed here without damaging it. Save it as UTF-8 on a computer.",
	"settings.exclusion.broken":
		"The two lines that mark the lines Sync Evo manages in .gitignore (they start with \"# >>> Sync Evo\" and \"# <<< Sync Evo\") do not form one pair: one is missing, one is there twice, or they are in the wrong order. The switches are hidden until that is put right. Correct the file under \"Write rules directly (.gitignore)\": keep one of each, the first above the second. Or delete every line that starts with either of the two, and the next sync adds the managed lines again.",
	"settings.exclusion.noSection.name": "Lines managed by Sync Evo",
	"settings.exclusion.noSection.desc":
		"The .gitignore of this vault has no lines managed by Sync Evo yet. Add them with the button below. Until then, Sync Evo on every device excludes what the default lines would, but git on a computer does not. The next sync that uploads changes adds them as well.",
	"settings.exclusion.noSection.button": "Add the lines Sync Evo manages",
	"settings.exclusion.noSection.syncFirst":
		"This device has not downloaded anything from {remote} yet, so the lines are not added here: a .gitignore on {remote} would then be in conflict with this one. Sync first. The sync adds the lines.",
	"settings.exclusion.noSection.overLimit":
		"With these lines .gitignore would be over {limit} MB, so they cannot be added, here or by a sync. Shorten the file first.",
	"settings.exclusion.fileKinds.name": "File types",
	"settings.exclusion.fileKinds.desc":
		"Applies to files outside the configuration folder. Notes, canvases and bases are always synced.",
	"settings.exclusion.folders.name": "Excluded folders",
	"settings.exclusion.folders.desc": "Add folders that are not synced, as paths from the root of the vault.",
	"settings.exclusion.folders.placeholder": "folder/subfolder",
	"settings.exclusion.folders.add": "Add",
	"settings.exclusion.folders.remove": "Remove from excluded list",
	"settings.exclusion.folders.invalid":
		"This is not the path of a folder from the root of the vault, so nothing was added.",
	"settings.exclusion.config.name": "Vault configuration sync",
	"settings.exclusion.config.desc":
		"Which parts of the configuration folder are synced. A change that is downloaded may only take effect after Obsidian is reloaded.",
	"settings.exclusion.config.summary": "{count} of {total} synced",
	"settings.exclusion.communityPluginList.warning":
		"While this is on, keep Sync Evo enabled on all your devices. If it is not enabled on one of them, Sync Evo is turned off on this device as well the next time Obsidian starts, and syncing stops.",
	"settings.exclusion.communityPlugins.warning":
		"The data.json of your other plugins is synced as well (it can hold tokens and other credentials). Plugin code that comes from your other devices runs on this device. Turn it on only with devices and a repository you trust.",
	"settings.exclusion.fixedOff.name": "Exclusions that are not in effect",
	"settings.exclusion.fixedOff.desc":
		"What the lines below excluded (the trash, the layout of the workspace, files an operating system leaves behind, and so on) is synced now. The line was deleted, or a later line that starts with ! undoes it. Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it.",
	"settings.exclusion.fixedOff.restore": "Restore",
	"settings.exclusion.fixedOff.restoreNote":
		"Restoring puts the deleted lines back among the lines Sync Evo manages. A line that a later line starting with ! undoes stays listed here after that: change that later line under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.fixedOff.undone":
		"None of these lines is missing, so there is nothing to restore: a later line that starts with ! undoes each of them. Change those lines under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.fixedOff.undoneNoSection":
		"A line of .gitignore that starts with ! undoes each of them. Change those lines under \"Write rules directly (.gitignore)\".",
	"settings.exclusion.editor.name": "Write rules directly (.gitignore)",
	"settings.exclusion.editor.desc":
		"What is not synced on all devices is written into the .gitignore at the root of this vault, shown here whole. Git on a computer follows it too, but git keeps uploading what is already on {remote}. Write your own rules outside the lines Sync Evo manages (between \"# >>> Sync Evo\" and \"# <<< Sync Evo\"). Nothing is saved until you press Save, and using a switch discards what is typed here and not saved.",
	"settings.exclusion.editor.absent": "This vault has no .gitignore yet. Saving creates it.",
	"settings.exclusion.editor.save": "Save",
	"settings.exclusion.editor.saved": "Saved .gitignore. The next sync uploads it to {remote}.",
	"settings.deviceExclusion.heading": "Not synced (this device only)",
	"settings.deviceExclusion.desc":
		"What you choose here is not synced on this device only. Nothing is deleted, neither the files on this device nor what is on {remote}.",
	"settings.deviceExclusion.summary.none": "None",
	"settings.deviceExclusion.summary.folders": { one: "{count} folder", other: "{count} folders" },
	"settings.deviceExclusion.kind.image": "Images",
	"settings.deviceExclusion.kind.audio": "Audio",
	"settings.deviceExclusion.kind.video": "Videos",
	"settings.deviceExclusion.kind.pdf": "PDFs",
	"settings.deviceExclusion.kind.other": "Other types",
	"settings.exclusion.notices.name": "Found by the last sync",
	"settings.exclusion.notices.desc": "What applies to this vault, as of the last sync.",
	"settings.exclusion.write.syncing": "A sync is running. .gitignore cannot be changed until it has ended.",
	"settings.exclusion.write.changed":
		".gitignore was changed after this screen read it, so nothing was written. The screen now shows the file as it is. Make the change again.",
	"settings.exclusion.write.refused": "This device refused to write .gitignore. Nothing was changed.",
	"settings.exclusion.write.unsettled":
		".gitignore could not be written to its end, or an earlier change to it could not be finished. The file may be incomplete, and no upload goes by it until that is settled. Check that the file can be written on this device, then open the settings again.",
	"settings.exclusion.write.overLimit":
		"With this change .gitignore would be over {limit} MB, and a file over that is not synced. Nothing was written.",
	"settings.exclusion.write.unreadable":
		".gitignore can no longer be read on this device, so nothing was written.",
	"settings.exclusion.write.noState": ".gitignore cannot be changed at the moment, and was not. Run a sync to see why.",
	"settings.exclusion.write.failed": ".gitignore was not changed: {detail}",

	// The result of testing the connection.
	"check.connected": "Connected to {repository}, branch {branch}.",
	"check.empty": "Connected to {repository}. The repository is empty.",
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
		"Sync Evo's own folder ({path}) is on {remote}. Sync Evo never syncs that folder: it is left as it is, on {remote} and on this device. Everything else is synced as usual. To remove the folder, use \"Remove from {remote}\" in the settings of Sync Evo (while .gitignore has the line for that folder).",
	"notice.gitAtRoot":
		"This vault has a .git at its root, so it is a git repository. Sync this device with git or the Obsidian Git plugin instead: git does not learn of what Sync Evo uploads, and its next pull would stop. Sync Evo keeps syncing in the meantime.",

	"notice.remotePathCollision":
		"There are paths on {remote} that differ only in upper and lower case, or only in their Unicode form (NFC and NFD). Not every device can keep such paths apart, so none of them is written here. Rename them on {remote}:\n{list}",
	"notice.tooLarge":
		"Files over {limit} MB are not synced. They are skipped and left as they are, on {remote} and on this device:\n{list}",
	"notice.lfsPointer":
		"There are Git LFS pointer files on {remote}. Sync Evo syncs each pointer as it is and does not download the content it stands for, so these files do not open on this device:\n{list}",
	"notice.invalidPath":
		"There are paths on {remote} that cannot be used as file paths. They are skipped:\n{list}",
	"notice.pluginNotListed":
		"The list of active community plugins that was just downloaded ({path}) does not include Sync Evo. The next time Obsidian starts, Sync Evo will be turned off and syncing stops. Turn it on again under Settings → Community plugins.",
	"notice.unwritablePath":
		"This device refused to write, move, or delete some files, so the download skipped them. Nothing about them was changed on {remote}, and each download tries them again:\n{list}",
	"notice.blockedPath":
		"The file {path} on {remote} could not be written: files that are only on this device are in its place. Move or rename them, and the next download writes it:\n{list}",
	"notice.archiveLimited":
		"Downloading all files at once did not work on this device. From now on Sync Evo does not try it here when the download is expected to be about {size} MB or more. Many files are then downloaded one by one, which takes longer.",
	"notice.archiveGivenUp":
		"Downloading all files at once did not work on this device, so Sync Evo no longer tries it here. When there are many files to download, they are now downloaded one by one, which takes longer.",
	"notice.localPathCollision":
		"Some new files were not uploaded. Their paths differ only in upper and lower case from another path on {remote}, or from another new file. Rename them, and the next upload includes them. Other files are uploaded as usual:\n{list}",
	"notice.renameNotSent":
		"Some files were renamed on this device in upper and lower case only, and the new name is not uploaded: it is excluded, or it differs only in case from another path. The file under the old name was therefore not deleted on {remote} either:\n{list}",
	"notice.nestedGitignore":
		"There are .gitignore files in subfolders. Sync Evo syncs them as ordinary files and does not read them as rules: only the .gitignore at the root of the vault decides what is synced. Git on a computer does apply them, so the same vault is treated differently there. Put the rules you need into the .gitignore at the root:\n{list}",
	"notice.fixedExclusionOff":
		"What was excluded is synced now (the trash, the layout of the workspace, files an operating system leaves behind, and so on): the lines of .gitignore below, which Sync Evo manages, were deleted, or a later line undoes them. Only Sync Evo's own folder is still not synced by Sync Evo, but git on a computer commits it. Deleted lines can be restored in the settings of Sync Evo; where a later line that starts with ! undoes one, change that line:\n{list}",
	"notice.submodule":
		"What is inside these submodules cannot be downloaded. Sync Evo downloads a submodule that points to a repository on GitHub and is listed in the .gitmodules of the repository. A submodule inside a submodule, and one with too many files to be listed, are not downloaded. What this device has in those folders is left as it is. Everything else is synced as usual:\n{list}",
	"notice.submoduleNoAccess":
		"The repository a submodule points to cannot be read. Check that the token has read access to the Contents of that repository. Once it has, the next sync downloads it. Until then, what this device has in that folder is left as it is. Everything else is synced as usual:\n{list}",
	"notice.submoduleNoCommit":
		"The repository a submodule points to does not have the commit the submodule points to. With git on a computer, check that the changes inside the submodule were pushed. Once they are, the next sync downloads them. Until then, what this device has in that folder is left as it is. Everything else is synced as usual:\n{list}",
	"notice.submoduleNotSent":
		"What is inside a submodule is only read. These files were changed, added or deleted on this device; that is not uploaded, and stays on this device alone. Make changes inside a submodule with git on a computer:\n{list}",

	// The lines Sync Evo manages in .gitignore, added by a push without
	// asking. In the question before a first push, and else in a message of
	// its own.
	"notice.exclusionChange": {
		one: "From this version of Sync Evo on, what is excluded is not synced, also where it is on {remote}. {count} file on {remote} is no longer synced on this device. What is excluded on all devices is listed in the settings of Sync Evo, under \"Excluded files still on {remote}\".",
		other: "From this version of Sync Evo on, what is excluded is not synced, also where it is on {remote}. {count} files on {remote} are no longer synced on this device. What is excluded on all devices is listed in the settings of Sync Evo, under \"Excluded files still on {remote}\".",
	},
	"notice.localLink":
		"This vault has links in it (symbolic links, or junctions). Sync Evo does not sync a link or what is in it, and leaves it as it is, on {remote} and on this device, where it points to. Everything else is synced as usual:\n{list}",

	"section.added.intro":
		"Sync Evo added the lines below to the top of the .gitignore of this vault. They are the lines Sync Evo manages, and say what is not synced:",
	"section.added.created":
		"This vault had no .gitignore, so Sync Evo created one with the lines below. They are the lines Sync Evo manages, and say what is not synced:",
	"section.added.outside": "Nothing else in .gitignore was changed.",
	"section.added.sends": "This upload includes the change.",
	"section.added.sent": "This upload included the change.",
	"section.added.unsent": "The change has not been uploaded yet. The next sync uploads it.",
	"section.added.unknown":
		"This upload may not have included the change. The next sync checks, and uploads it if it is still needed.",
	"section.added.howTo":
		"You can change these lines in the settings of Sync Evo. If you do not want them, delete the lines in between and keep the first and the last line (the two that start with #): if those two are deleted as well, the next sync adds the lines again.",
	"section.added.tracked": {
		one: "{count} file that these lines exclude is on {remote}. Sync Evo no longer syncs it on any device:",
		other: "{count} files that these lines exclude are on {remote}. Sync Evo no longer syncs them on any device:",
	},
	"section.added.untrackHint":
		"To remove them from {remote}, use \"Remove from {remote}\" in the settings of Sync Evo. The files on your devices with Sync Evo stay.",

	// Lists inside a message.
	"list.separator": ", ",
	"list.showRest": "Show {count} more",
	"list.more": { one: "…and {count} more", other: "…and {count} more" },

	// The commands.
	"command.sync": "Sync",
	"command.pull": "Download changes from {remote}",
	"command.push": "Upload changes to {remote}",
	"command.firstFetch": "Start over (download everything from {remote} again)",
	"command.stop": "Stop the sync",
	"command.showLog": "Show sync log",

	// The last lines of the log, shown on the device. The lines themselves are not translated.
	"log.title": "Sync log",
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
		"Downloading would delete many files on this device, which needs your confirmation. Nothing was changed. Sync manually to be asked.",
	"auto.waiting.rewritten":
		"The history of the repository was rewritten, so downloading needs your confirmation. Nothing was changed. Sync manually to be asked.",
	"auto.waiting.firstFetch":
		"The first download into this vault is not done yet. Nothing was changed. Sync manually to start it or carry on with it.",
	"auto.waiting.firstPush":
		"The first upload from this device needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
	"auto.waiting.pushDeletions":
		"Uploading would delete many files on {remote}, which needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
	"auto.waiting.emptyVault":
		"None of the files synced before is on this device, which needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
	"pull.progress.starting": "Download: starting…",
	"pull.progress.listing": "Download: checking {remote}…",
	"pull.progress.scanning": "Download: looking through the vault…",
	"pull.progress.hashing": "Download: comparing files ({done}/{total})…",
	"pull.progress.applyingStart": "Download: updating files…",
	"pull.progress.applying": "Download: updating files ({done}/{total})…",
	"pull.progress.downloadingArchive": "Download: getting all files at once…",
	"pull.progress.archiveWaiting": "Download: waiting for the stopped download to end…",
	"pull.progress.stopping": "Download: stopping…",
	"pull.progress.archiveRetry":
		"The last download did not finish. Keep Obsidian in front and wait until this one is done.",
	"pull.progress.graphClosed":
		"Graph views are closed while the files are written. They reopen when the download ends.",
	"pull.progress.rateLimited":
		"GitHub's request limit was reached. The download continues at {time}. You can close the app: the next sync continues from where it stopped.",
	"pull.progress.overQuota": {
		one: "About {count} file can be downloaded before GitHub's request limit is reached. The rest continues after {time}.",
		other: "About {count} files can be downloaded before GitHub's request limit is reached. The rest continues after {time}.",
	},
	"pull.count.fetched": {
		one: "{count} file updated",
		other: "{count} files updated",
	},
	"pull.count.deleted": { one: "{count} file deleted", other: "{count} files deleted" },
	"pull.count.renamed": { one: "{count} file renamed", other: "{count} files renamed" },
	"pull.count.conflicts": { one: "{count} conflict", other: "{count} conflicts" },
	"pull.count.merged": { one: "{count} file merged", other: "{count} files merged" },
	"pull.summary": "Download finished: {details}.",
	"pull.refetched": {
		one: "{count} file was missing from the download of all files, or differed from GitHub's listing there. It was downloaded on its own.",
		other: "{count} files were missing from the download of all files, or differed from GitHub's listing there. They were downloaded one by one.",
	},
	"pull.done": "Download finished.",
	"pull.upToDate": "Nothing to download. This device is up to date.",
	"pull.remoteEmpty": "The repository is empty. There is nothing to download.",
	"pull.declined": "The download was cancelled. Nothing was changed.",
	"pull.declinedAfterTrash":
		"The download was cancelled. Only the files listed below were moved to .trash/ in this vault. Nothing else was changed.",
	"pull.cancelled": "The download was stopped. The next download continues from there.",
	"pull.cancelledAfter": "Done before it stopped: {details}.",
	"pull.connectionChanged":
		"The download was stopped because the connection was changed. The next download starts with the new connection.",
	"pull.failed": "The download failed. {reason}",
	"pull.error.incompleteListing":
		"The repository has more files than GitHub lists in one response (over 100,000 entries, or a listing over 7 MB), so Sync Evo cannot sync it.",
	"pull.error.other": "Details: {detail}",
	"pull.incomplete": {
		one: "{count} file could not be downloaded and is left for the next sync. {reason}",
		other: "{count} files could not be downloaded and are left for the next sync. {reason}",
	},
	"pull.incompleteSome": "Some files could not be downloaded and are left for the next sync. {reason}",
	"pull.reason.hashMismatch": "The content GitHub sent did not match its own listing.",
	"pull.reason.trashFailed": "A file on this device could not be moved to .trash/ in this vault.",
	"pull.notDownloaded": {
		one: "{count} file is not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep it on this device, then sync again:\n{list}",
		other: "{count} files are not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep them on this device, then sync again:\n{list}",
	},
	"pull.unreadable": {
		one: "{count} file on this device could not be read and was left as it is. Check it, then sync again:\n{list}",
		other: "{count} files on this device could not be read and were left as they are. Check them, then sync again:\n{list}",
	},
	"pull.waitingForUnread": {
		one: "{count} other file was not downloaded either, since it comes after the files above. Once those are seen to, the next sync downloads it.",
		other: "{count} other files were not downloaded either, since they come after the files above. Once those are seen to, the next sync downloads them.",
	},
	"pull.conflicts": {
		one: "The content of {count} file on this device was kept as a conflict file:\n{list}",
		other: "The content of {count} files on this device was kept as conflict files:\n{list}",
	},
	"pull.conflict.conflict": "{copy} (a conflict: {path} now has the content from {remote})",
	"pull.conflict.becameSymlink":
		"{copy} ({path} is a symbolic link on {remote} now, which is not written to this device)",
	"pull.conflict.becameFolder": "{copy} ({path} is a folder on {remote} now)",
	"pull.conflict.nameTaken": "{copy} (another file was renamed to {path} on {remote})",
	"pull.merged": {
		one: "{count} file was changed both on this device and on {remote}, and now holds the changes of both. What it held on this device before is in .trash/.sync-evo-merged/ in this vault:\n{list}",
		other: "{count} files were changed both on this device and on {remote}, and now hold the changes of both. What they held on this device before is in .trash/.sync-evo-merged/ in this vault:\n{list}",
	},
	"pull.merged.item": "{path} (before: {kept})",
	"pull.replacedSettings": {
		one: "{count} file in the configuration folder now has the content from {remote}. What it held on this device before is in .trash/ in this vault:\n{list}",
		other: "{count} files in the configuration folder now have the content from {remote}. What they held on this device before is in .trash/ in this vault:\n{list}",
	},
	"pull.trashed": {
		one: "{count} file was moved to .trash/ in this vault by the download, so that its content is not lost. You can get it back from there:\n{list}",
		other: "{count} files were moved to .trash/ in this vault by the download, so that their content is not lost. You can get them back from there:\n{list}",
	},
	"pull.halfWritten": {
		one: "An earlier download stopped while it was writing {count} file. What was left of it was moved to .trash/ in this vault. The content from {remote} is downloaded again. If you had edited the file since, you can get your edit back from there:\n{list}",
		other: "An earlier download stopped while it was writing {count} files. What was left of them was moved to .trash/ in this vault. The content from {remote} is downloaded again. If you had edited them since, you can get your edits back from there:\n{list}",
	},
	"pull.halfMerged": {
		one: "An earlier download stopped while it was writing the merged content of {count} file. The content from {remote} is downloaded again, without the changes of this device. What the file held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\n{list}",
		other: "An earlier download stopped while it was writing the merged content of {count} files. The content from {remote} is downloaded again, without the changes of this device. What the files held on this device before the merge is in .trash/.sync-evo-merged/ in this vault:\n{list}",
	},
	"pull.halfCopies": {
		one: "{count} conflict file that an earlier download left unfinished was moved to .trash/ in this vault. A complete one is made again. If you had edited it, your edit is there:\n{list}",
		other: "{count} conflict files that an earlier download left unfinished were moved to .trash/ in this vault. Complete ones are made again. If you had edited them, your edits are there:\n{list}",
	},
	"pull.tidiedCopies": {
		one: "{count} conflict file in _conflicts/ was made 30 days ago or more, and was moved to .trash/ in this vault. To keep a conflict file, move it out of _conflicts/ or rename it.",
		other: "{count} conflict files in _conflicts/ were made 30 days ago or more, and were moved to .trash/ in this vault. To keep a conflict file, move it out of _conflicts/ or rename it.",
	},
	"pull.keptLocal": {
		one: "{count} file was left as it is on this device, as you chose. It differs from what is on {remote}:\n{list}",
		other: "{count} files were left as they are on this device, as you chose. They differ from what is on {remote}:\n{list}",
	},
	"pull.symlinks": {
		one: "There is {count} symbolic link on {remote}. Sync Evo does not write it to this device and leaves it as it is on {remote}. The settings list the links that are skipped:\n{list}",
		other: "There are {count} symbolic links on {remote}. Sync Evo does not write them to this device and leaves them as they are on {remote}. The settings list the links that are skipped:\n{list}",
	},

	// A push: its progress, its outcome, and what the user has to know of it.
	"push.progress.starting": "Upload: starting…",
	"push.progress.listing": "Upload: checking {remote}…",
	"push.progress.scanning": "Upload: looking through the vault…",
	"push.progress.hashing": "Upload: comparing files ({done}/{total})…",
	"push.progress.sendingStart": "Upload: sending files…",
	"push.progress.sending": "Upload: sending files ({done}/{total})…",
	"push.progress.finishing": "Upload: finishing…",
	"push.progress.stopping": "Upload: stopping…",
	"push.progress.rateLimited":
		"GitHub's limit on creating content was reached. The upload continues at {time}. Keep Obsidian in front until then: an upload that stops uploads nothing.",
	"push.count.added": { one: "{count} file added", other: "{count} files added" },
	"push.count.modified": { one: "{count} file modified", other: "{count} files modified" },
	"push.count.deleted": { one: "{count} file deleted", other: "{count} files deleted" },
	"push.summary": "Upload finished: {details}.",
	"push.nothing": "Nothing to upload. {remote} is up to date.",
	"push.nothingSent": "Nothing was uploaded. Some files cannot be uploaded; the notices say why.",
	"push.recovered":
		"The previous upload had gone through: {details}. It is recorded on this device now.",
	"push.recoveredUntrack": {
		one: "An earlier removal from {remote} had gone through: {count} file removed. It is recorded on this device now. The file on this device is as it was.",
		other: "An earlier removal from {remote} had gone through: {count} files removed. It is recorded on this device now. The files on this device are as they were.",
	},
	"push.pullFirst.noBase":
		"Nothing was uploaded. This device has not finished its first download from {remote} yet. Download first, then upload.",
	"push.pullFirst.remoteEmpty":
		"Nothing was uploaded. This device has synced with this repository before, and the repository is empty now. Download first to look at that.",
	"push.pullFirst.notDefaultBranch":
		"Nothing was uploaded. The repository is empty. GitHub makes the first commit of an empty repository on its default branch, {branch}. Set the branch in the settings of Sync Evo to {branch}, or change the default branch of the repository on GitHub, then sync again.",
	"push.pullFirst.gitignoreUnreadable":
		"Nothing was uploaded. The .gitignore of this vault decides what is uploaded, and it cannot be read on this device: a cloud drive keeps only a placeholder of it, there is a folder named .gitignore, or its name differs in upper and lower case (.GITIGNORE, say). Put that right, then upload again.",
	"push.pullFirst.remoteMoved":
		"Nothing was uploaded. Another device changed what is on {remote} after this upload began. Download first, then upload again.",
	"push.pullFirst.gitignore":
		"Nothing was uploaded. The .gitignore of this vault decides what is uploaded, and its content could not be relied on. Sync again; if .gitignore is open in another app, close it first.",
	"push.declined": "The upload was cancelled. Nothing was uploaded.",
	"push.cancelled": "The upload was stopped. Nothing was uploaded.",
	"push.connectionChanged": "The upload was stopped because the connection was changed. Nothing was uploaded.",
	"push.failed": "The upload failed. {reason}",
	"push.unfinished":
		"The last sync ({time}) did not finish its upload. Changes on this device may not have been uploaded. Nothing is uploaded again by itself: run a sync to upload what this device holds now.",
	"push.error.workflows":
		"GitHub refused the upload because it changes files under .github/workflows/. For that, the token also needs the Workflows read and write permission.",
	"push.error.notAsListed":
		"Nothing was changed on {remote}: what is there is not what this device knew of it. Sync again.",
	"push.storedOtherwise": {
		one: "GitHub stored {count} file with other content than this device uploaded. The next download replaces the file on this device with GitHub's version:\n{list}",
		other: "GitHub stored {count} files with other content than this device uploaded. The next download replaces the files on this device with GitHub's versions:\n{list}",
	},
	"push.held": {
		one: "{count} file was not uploaded: a download has not finished with it, or it is open and could not be saved. Sync again:\n{list}",
		other: "{count} files were not uploaded: a download has not finished with them, or they are open and could not be saved. Sync again:\n{list}",
	},
	"push.remoteInTheWay": {
		one: "{count} file was not uploaded: there is a file or a folder in its place on {remote} that this device has not downloaded yet. Download first, then upload again:\n{list}",
		other: "{count} files were not uploaded: there are files or folders in their place on {remote} that this device has not downloaded yet. Download first, then upload again:\n{list}",
	},
	"push.notDownloaded": {
		one: "{count} new file was not uploaded: it is not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep it on this device, then sync again:\n{list}",
		other: "{count} new files were not uploaded: they are not on this device yet (a cloud drive keeps only a placeholder). Have the cloud drive keep them on this device, then sync again:\n{list}",
	},
	"push.grownTooLarge": {
		one: "{count} file was not uploaded: it grew past {limit} MB while the upload ran. Files over {limit} MB are not synced:\n{list}",
		other: "{count} files were not uploaded: they grew past {limit} MB while the upload ran. Files over {limit} MB are not synced:\n{list}",
	},
	"push.refusedSize": {
		one: "{count} file was not uploaded: GitHub refused it as too large. Make this file smaller or move it out of the vault. A file that is not on {remote} yet is also left alone once it is excluded. If it is a conflict file, check its content and then delete it:\n{list}",
		other: "{count} files were not uploaded: GitHub refused them as too large. Make these files smaller or move them out of the vault. A file that is not on {remote} yet is also left alone once it is excluded. If one is a conflict file, check its content and then delete it:\n{list}",
	},
	"push.refusedWorkflows": {
		one: "{count} file was not uploaded: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync uploads it. Otherwise, put this file back as it was and change it with git on a computer. If it is a conflict file that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n{list}",
		other: "{count} files were not uploaded: adding or changing a file under .github/workflows/ needs the Workflows read and write permission on the token. Give the token that permission and the next sync uploads them. Otherwise, put these files back as they were and change them with git on a computer. If one is a conflict file that an earlier version of Sync Evo left there, with .conflict-from- in its name, check its content and then delete it:\n{list}",
	},
	"push.leftOut": {
		one: "{count} file was left out: it changed or could not be read while the upload ran, or it is open and could not be saved. The next upload looks at it again:\n{list}",
		other: "{count} files were left out: they changed or could not be read while the upload ran, or they are open and could not be saved. The next upload looks at them again:\n{list}",
	},

	// Untracking: the question before it, and how it ended.
	"untrack.confirm.title": "Remove files from {remote}",
	"untrack.confirm.proceed": "Remove",
	"untrack.confirm.cancel": "Cancel",
	"untrack.confirm.body": {
		one: "This removes the {count} file below from {remote}. The files on your devices with Sync Evo stay (git on a computer deletes it at the next git pull).",
		other: "This removes the {count} files below from {remote}. The files on your devices with Sync Evo stay (git on a computer deletes them at the next git pull).",
	},
	"untrack.confirm.missing": {
		one: "{count} of these files is not on this device. If it is in the list, it is marked there. After it is removed, its content is only in the history on {remote}.",
		other: "{count} of these files are not on this device. Those in the list are marked there. After they are removed, their content is only in the history on {remote}.",
	},
	"untrack.confirm.submodules": {
		one: "{count} submodule is excluded as well. It is not removed here. Remove it with git on a computer:",
		other: "{count} submodules are excluded as well. They are not removed here. Remove them with git on a computer:",
	},
	"untrack.item.tagged": "{path} ({tags})",
	"untrack.tag.symlink": "symbolic link",
	"untrack.tag.ownFolder": "Sync Evo's own folder",
	"untrack.tag.missing": "not on this device",
	"untrack.done": {
		one: "Removed {count} file from {remote}. The file on this device is as it was.",
		other: "Removed {count} files from {remote}. The files on this device are as they were.",
	},
	"untrack.nothing":
		"There was nothing to remove from {remote}: none of the listed files is still there and excluded. Nothing was changed.",
	"untrack.remoteMoved":
		"Nothing was removed from {remote}. Another device changed what is there meanwhile. Try again in the settings of Sync Evo.",
	"untrack.cancelled": "The removal was stopped. Nothing was removed from {remote}.",
	"untrack.connectionChanged":
		"The removal was stopped because the connection was changed. Nothing was removed from {remote}.",
	"untrack.progress.running": "Removing the files from {remote}…",
	"untrack.progress.stopping": "Removing from {remote}: stopping…",
	"untrack.submodules": {
		one: "{count} excluded submodule is on {remote}. Sync Evo does not remove submodules. Remove it with git on a computer.",
		other: "{count} excluded submodules are on {remote}. Sync Evo does not remove submodules. Remove them with git on a computer.",
	},
	"untrack.failed": "Removing from {remote} failed. {reason}",
	"untrack.syncFirst.remoteEmpty":
		"Nothing was removed from {remote}. The repository is empty now. Sync first, then try again in the settings of Sync Evo.",
	"untrack.syncFirst.pullUnfinished":
		"Nothing was removed from {remote}. This device has not downloaded everything yet. Sync until no file is left for later, then try again in the settings of Sync Evo.",
	"untrack.syncFirst.gitignoreUnsettled":
		"Nothing was removed from {remote}. The content of the .gitignore of this vault could not be relied on. Sync, then try again in the settings of Sync Evo; if .gitignore is open in another app, close it first.",
	"untrack.syncFirst.gitignoreUnreadable":
		"Nothing was removed from {remote}. The .gitignore of this vault cannot be read on this device. The settings of Sync Evo say why. Put that right, then try again.",
	"untrack.syncFirst.noSection":
		"Nothing was removed from {remote}. The .gitignore of this vault has no lines managed by Sync Evo, so the exclusions are not in the file. Add the lines in the settings of Sync Evo, then try again.",
	"untrack.syncFirst.sectionBroken":
		"Nothing was removed from {remote}. The two lines that mark the lines Sync Evo manages in .gitignore do not form one pair. Correct the file in the settings of Sync Evo, then try again.",
	"untrack.syncFirst.gitignoreDiffers":
		"Nothing was removed from {remote}. The .gitignore on {remote} is not the one this device last synced. Sync, then try again in the settings of Sync Evo.",
	"untrack.skipped.pullDeclined":
		"Nothing was removed from {remote}, because the download was cancelled. The exclusions stay. You can remove the files later in the settings of Sync Evo.",
	"untrack.skipped.pullCancelled":
		"Nothing was removed from {remote}, because the download was stopped. The exclusions stay. You can remove the files later in the settings of Sync Evo.",

	// Why there is no sync state to work with.
	"state.waiting": "Preparing…",
	"state.newerVersion":
		"This vault was synced by a newer version of Sync Evo. Update the plugin to sync. Nothing was changed.",
	"state.noAppId": "Obsidian did not give the ID of this vault, so Sync Evo cannot sync it.",
	"state.noIndexedDb":
		"This device does not provide the storage Sync Evo needs (IndexedDB), so nothing can be synced.",
	"state.openFailed":
		"The sync could not be prepared, so nothing was synced. Restart Obsidian and try again.",
	"state.discardFailed":
		"What was kept for the previous connection could not be cleared, so nothing was synced. Restart Obsidian and try again.",

	// The questions a pull or a push stops to ask.
	"confirm.proceed": "Proceed",
	"confirm.keepLocal": "Keep my files",
	"confirm.cancel": "Cancel",
	"confirm.delete.title": "Confirm deletions",
	"confirm.delete.body": {
		one: "{count} file on this device was deleted on {remote} or turned into a symbolic link there. The download deletes it from this device.",
		other: "{count} files on this device were deleted on {remote} or turned into symbolic links there. The download deletes them from this device.",
	},
	"confirm.delete.note": "If you cancel, nothing is downloaded and nothing is changed.",
	"confirm.firstFetch.title": "Confirm the first download",
	"confirm.firstFetch.body":
		"This is the first download from {repository}, branch {branch}, and this vault already has files.",
	"confirm.firstFetch.different": {
		one: "{count} file has other content than on {remote}. It gets the content from {remote}, and the content on this device is kept in the folder _conflicts/ as a conflict file:",
		other: "{count} files have other content than on {remote}. They get the content from {remote}, and the content on this device is kept in the folder _conflicts/ as conflict files:",
	},
	"confirm.firstFetch.differentSettings": {
		one: "{count} file in the configuration folder has other content than on {remote}. It gets the content from {remote}, and the content on this device is moved to .trash/ in this vault:",
		other: "{count} files in the configuration folder have other content than on {remote}. They get the content from {remote}, and the content on this device is moved to .trash/ in this vault:",
	},
	"confirm.firstFetch.localOnly": {
		one: "{count} file is only on this device. It stays on this device as it is. The next upload includes it, unless it is excluded; before anything is uploaded, the list of the files is shown and you are asked once more:",
		other: "{count} files are only on this device. They stay on this device as they are. The next upload includes them, except files that are excluded; before anything is uploaded, the list of the files is shown and you are asked once more:",
	},
	"confirm.firstFetch.atSymlinks": {
		one: "{count} file is at a path that is a symbolic link on {remote}. It is not compared and stays as it is:",
		other: "{count} files are at paths that are symbolic links on {remote}. They are not compared and stay as they are:",
	},
	"confirm.firstPush.title": "Confirm the first upload",
	"confirm.firstPush.body":
		"This is the first upload from this device to {repository}, branch {branch}. It changes what is on {remote} as listed below. Once an upload has gone through, later uploads do not show this list.",
	"confirm.firstPush.remoteEmpty":
		"The repository is empty. If this vault has no .gitignore, an empty one is created and uploaded.",
	"confirm.firstPush.remoteEmptyWithGitignore":
		"The repository is empty.",
	"confirm.firstPush.added": { one: "{count} file to add:", other: "{count} files to add:" },
	"confirm.firstPush.modified": { one: "{count} file to modify:", other: "{count} files to modify:" },
	"confirm.firstPush.deleted": { one: "{count} file to delete:", other: "{count} files to delete:" },
	"confirm.pushDelete.body": {
		one: "{count} file was deleted on this device. The upload deletes it on {remote}, and a download then deletes it on your other devices.",
		other: "{count} files were deleted on this device. The upload deletes them on {remote}, and a download then deletes them on your other devices.",
	},
	"confirm.pushDelete.alsoSent": "The same upload also includes the files below.",
	// A push that finds none of the files it has a record of. Three answers,
	// each with a line that says what it does.
	"confirm.emptyVault.title": "No files in the vault",
	// With one file, under a key of its own: a language without plural forms
	// has other words for it too ("none of" one file reads oddly in Japanese).
	"confirm.emptyVault.bodyOne":
		"The {count} file that was synced before is not on this device. This happens when the vault was created again, or when its folder was deleted. It is still on {remote} ({repository}, branch {branch}).",
	"confirm.emptyVault.body":
		"None of the {count} files that were synced before is on this device. This happens when the vault was created again, or when its folders were deleted. They are still on {remote} ({repository}, branch {branch}).",
	"confirm.emptyVault.refetch": "Download again from {remote}",
	"confirm.emptyVault.refetchNote":
		"The files on {remote} are downloaded to this device. Nothing is deleted on {remote}.",
	"confirm.emptyVault.delete": "Delete on {remote} too",
	"confirm.emptyVault.deleteNote": {
		one: "{count} file is deleted on {remote} too, and a download then deletes it on your other devices.",
		other: "{count} files are deleted on {remote} too, and a download then deletes them on your other devices.",
	},
	"confirm.emptyVault.cancelNote": "Nothing is uploaded and nothing is changed.",
	"confirm.push.note": "If you cancel, nothing is uploaded and nothing is changed.",
	"confirm.push.noteSection":
		"If you cancel, nothing is uploaded. The lines added to .gitignore stay on this device, and the next upload includes them.",
	"confirm.startOver.title": "Start over",
	"confirm.startOver.body":
		"This compares this device with {remote} ({repository}, branch {branch}) again. No file is deleted, on this device or on {remote}.",
	"confirm.startOver.nothing":
		"No file on this device has other content than on {remote}, and none is only on this device.",
	"confirm.startOver.note": "If you cancel, nothing is changed.",
	"confirm.rewritten.title": "Repository history rewritten",
	"confirm.rewritten.body":
		"The repository no longer builds on what this device last synced with, as happens after a force push. Changes that this device uploaded may be gone from {remote}. Following {remote} takes the files below away from this device.",
	"confirm.rewritten.deletions": { one: "{count} file to delete:", other: "{count} files to delete:" },
	"confirm.rewritten.overwrites": {
		one: "{count} file to replace with the content from {remote}:",
		other: "{count} files to replace with the content from {remote}:",
	},
	"confirm.rewritten.trashNote":
		"\"Proceed\" follows {remote}. These files are first moved to .trash/ in this vault, so you can get them back.",
	"confirm.rewritten.keepNote":
		"\"Keep my files\" leaves these files as they are and downloads everything else. \"Cancel\" downloads nothing.",
});
