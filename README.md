# Sync Evo

Sync Evo is a plugin for [Obsidian](https://obsidian.md) that syncs a vault with a GitHub repository, or with a folder in Dropbox. It is made for large vaults and for phones: it needs no git on the device, talks to the API of GitHub or Dropbox directly, and can pick up a first download of thousands of files where it was interrupted.

Most of this page speaks of GitHub and the repository. With Dropbox, read them as Dropbox and the folder of the vault; what differs is told under "Dropbox" below.

It is free, with all of its features. There is no account to create and no server of the developer's.

## What it does

- **Download** brings the vault in line with the repository: it gets the files that are new or changed there, and deletes the ones that were deleted there.
- **Upload** sends what was added, changed, and deleted in the vault as one commit.
- **Sync** does both, a download and then an upload. It is also the button in the ribbon.

Nothing runs on its own unless you switch it on: a sync happens when you press the button or run a command. Under "How it syncs" in the settings, Sync Evo can also sync when Obsidian starts or comes back from another app, and at an interval while it is in front. Such a sync only downloads, unless you let it upload changes too; it says nothing when it went well, and never answers one of the questions below for you: it changes nothing then, and tells you once to sync manually. It does not start the first download of a vault either; that one you start yourself. A note you are typing in is left as it is by an automatic sync, and is updated or sent by a later one, once you have stopped typing for 20 seconds. A sync you start while an automatic one is running takes its place.

A file that was changed both in the vault and in the repository is not overwritten. It gets the changes of both sides, line by line, under its own name, and the notice of the sync names it. What the file held on the device before that is kept in `.trash/.sync-evo-merged/` in the vault, as `<date> <name>.<extension>`: for `notes/a.md` that is `.trash/.sync-evo-merged/2026-10-13 a.md`, and a second one on the same day is `2026-10-13 a (1).md`. It is not synced, Obsidian does not show it, and Sync Evo never deletes it: delete the folder when you no longer need what is in it.

To read that copy or to put it back, use the file manager of the device, and move the copy into a folder of the vault that Obsidian shows. In Finder on a Mac, `⌘⇧.` shows the folders whose names start with a dot. In the file manager of Android, "Show hidden files" in the menu does. The Files app of an iPhone or iPad does not list them, but its search finds the copy by the name of the note: hold the result and choose "Move".

A file that does not merge that way is kept twice instead: when both sides changed the same lines, when it is no text, a `.canvas` or a `.base`, and always on a device where "On a conflict", under "How it syncs" in the settings, is set to create a conflict file. The repository's version takes the name, and the vault's version is kept as a conflict file in the folder `_conflicts/` at the root of the vault, as `<date> <name> (<device>).<extension>`: the conflict file of `notes/a.md` is `_conflicts/2026-10-12 a (iPhone).md`, and a second one of the same note on the same day is `_conflicts/2026-10-12 a (iPhone) (1).md`. The notice of the sync names both files. A conflict file is synced like any other file, whatever is excluded. A file in the configuration folder gets none: the vault's version goes to `.trash/` in the vault.

A conflict file is kept for 30 days from the end of the day in its name. After that a sync moves it to `.trash/` in the vault, and tells how many it moved; the next upload deletes it in the repository, and the other devices then remove it as they remove any deleted file. To keep a conflict file, move it out of `_conflicts/` or rename it. Up to 0.2.0 a conflict file was made beside its file, as `<name>.conflict-from-<device>-<date>-<time>.<extension>`. Conflict files of that form stay where they are, are synced as before, and are never moved to `.trash/`.

Sync Evo stops and asks before it goes on when

- a download or an upload would delete many files (more than 50, or more than 5 that are also more than a tenth of all files),
- an upload finds none of the files it synced before in the vault, however few they are (a vault whose folder was deleted and created again looks like this): it can then download them again from the repository instead of deleting them there,
- the first download finds files in the vault that differ from the repository's,
- a device uploads for the first time,
- the history of the repository was rewritten (a force upload).

What is not synced is decided in two places: the `.gitignore` at the root of the vault, for all your devices and for git on a computer, and the settings of each device, for that device alone. The settings screen writes both for you. The rules of `.gitignore` are read the way git reads them, and applied differently: what they exclude is not synced even when the repository already holds it, while git keeps tracking a file it tracks already. So when `.obsidian/plugins/` is in the repository and you add it to `.gitignore`, your devices with Sync Evo stop syncing it, and git on a computer keeps uploading it.

### Submodules

What is inside a submodule is downloaded into its folder, at the commit the repository of the vault points to, and downloaded again when that commit moves. On the device it is an ordinary folder.

- It is only read. A file you change, add or delete inside a submodule on the device is not uploaded: the change stays on that device, and Sync Evo tells you once which files. Make such changes with git on a computer. When the same file later changes in the submodule, your version is kept as a conflict file in `_conflicts/`, and is not merged.
- The submodule has to point to a repository on GitHub that the token can read, and be listed in the `.gitmodules` at the root of the repository of the vault. URLs of the forms `https://github.com/owner/name`, `git@github.com:owner/name` and `../name` are read.
- When it cannot be downloaded (the token cannot read that repository, the commit was not pushed there yet, it points to another host, or it is a submodule inside a submodule), what the device already has in its folder is left as it is, and Sync Evo tells you once why.
- A submodule that is excluded, such as one in an excluded folder, is not downloaded.

## Not supported yet

- **Changes inside a submodule.** What is inside a submodule is downloaded, and only read: see "Submodules" below.
- **Git LFS.** A pointer file is synced as it is, and the content it stands for is not downloaded.
- **Line ending conversion.** The `text` and `eol` settings of `.gitattributes` are not applied: every file is stored and written byte for byte as the repository holds it.
- **Symbolic links.** A link in the repository is not written to the device, and is left as it is in the repository. The settings list them. On a desktop, a link in the vault (or a junction, on Windows) is not synced, and neither is anything behind it: nothing is uploaded from it, and a download writes and deletes nothing there, also when the link points outside the vault. The first sync that finds one says so.
- **Other services** than GitHub and Dropbox.

Also:

- A file over 38 MB is not synced.
- A repository with more than 100,000 files, or one whose listing is over 7 MB, cannot be synced.
- `.gitignore` files in subfolders are synced as ordinary files and are not read as rules. Only the one at the root counts.
- On Android, a rename made on another device that changes only upper and lower case (`tools/` to `Tools/`) is not applied. The download skips the path and says so, and the upload holds the file back. Nothing is lost, but the path stays unsynced, and the two notices come back on every sync.

## Dropbox

Under "Connection" in the settings, "Service" chooses between GitHub and Dropbox. Sync Evo reaches only its own folder in your Dropbox, `Apps/Sync Evo/` (the name of `Apps` follows the language of your Dropbox), and keeps each vault in a folder of its own there, named in the settings.

- **Connecting** is done in the browser: press **Connect**, sign in to Dropbox if asked, press **Allow**, and the browser sends you back to Obsidian. There is no token to copy. **Disconnect** tells Dropbox to forget the connection, and forgets it on the device. The account (its ID and e-mail address) stays in the settings, so that connecting again to the same account does not start the sync over.
- **An upload is no commit.** The files are sent together, and each one only while Dropbox still holds the version this device last saw. A file another device changed first is not overwritten, and one it changed is not deleted: the upload sends the rest and says so, and the next download takes that file up as a conflict. An upload that is stopped once its files were sent leaves them on Dropbox, and the next sync sends what is left.
- **Deleted files** stay in the version history of Dropbox for a while (30 days on the free plan) and are not put into a trash of Sync Evo's.
- **Automatic merging** finds what a file held at the last sync among its versions on Dropbox. When that version is gone, the file is kept twice instead, as a conflict file.
- Dropbox does not tell upper and lower case apart. Two files in the vault whose paths differ only in case are not uploaded, and a rename on Dropbox that changes only case reaches the device only when the folder is listed in full again.
- Every device that syncs the vault has to connect to the same Dropbox account and name the same folder. Changing the service, the folder, or the account starts the sync over, as a first download does.

## Before you use it

**A vault in iCloud Drive works, but support is experimental.** It was checked on one iPhone, on Wi-Fi, with a small vault. Before you rely on it:

- The first sync (and a sync after "Start over") reads every file. Files that iCloud has taken off the device are brought back by iCloud for that read, so it needs the space and the connection for the whole vault. As long as even one file cannot be brought back, that sync does not finish, and nothing is uploaded.
- When GitHub can be reached and iCloud cannot (iCloud Drive switched off for mobile data, for example), a file that is off the device cannot be read. Sync Evo leaves it alone, says so in the result of the sync, and tries again the next time.
- When iCloud finds two versions of a file, it may keep both and name one `<name> 2.md`. Sync Evo sends that as a new file.
- Do not make the iCloud vault a git working tree on the Mac. With the vault in iCloud, the Mac and the iPhone share one folder: what Sync Evo sends from the iPhone, git on the Mac does not know of, and its next pull stops. If Sync Evo on the iPhone tells you that the vault has a `.git`, this is what happened.
- Do not sync the same iCloud vault with Sync Evo on two devices. iCloud already carries every change between them, and two syncs of the same change can leave duplicates.

If you can choose, a vault under "On My iPhone" is the simpler setup.

**On a device where the vault is a git repository, use git.** If the vault has a `.git` at its root, sync that device with git or with the Obsidian Git plugin. Git does not learn of what Sync Evo sends, and its next pull would stop. Sync Evo is for the devices that have no git.

**"Installed community plugins" runs code from your other devices.** With that option on, the code of your other plugins, and their `data.json` (which can hold tokens and other credentials), is synced. Plugin code that came from another device runs on this one. Turn it on only with devices and a repository you trust. Sync Evo never syncs its own folder.

**"Active community plugin list" needs Sync Evo enabled everywhere.** While that list is synced, keep Sync Evo enabled on all your devices. If it is not enabled on one of them, the list that device sends turns Sync Evo off on the others the next time Obsidian starts, and syncing stops there.

## Setting up

Sync Evo is not in the community plugin directory yet. Until it is, it can be installed with [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `seking/obsidian-sync-evo`.

1. On GitHub, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) that has access to the repository of the vault only, with the repository permission **Contents: Read and write**. If the vault has submodules, give the token access to their repositories too; **Contents: Read-only** is enough for those, but one token has one set of permissions for all its repositories. If the vault holds files under `.github/workflows/` that you change on the device, it also needs **Workflows: Read and write**.
2. In Obsidian, open Settings → Sync Evo and fill in "Connection":
   - **Repository**: as `owner/name`, or its address pasted from the browser.
   - **Branch**: the branch to sync with. Sync Evo does not create it.
   - **Token**: the secret that holds the token. It is kept in Obsidian's Keychain, and not in a file of the vault. On iPhone and Android, every vault on the device can link the same secret; on Windows and Mac, each vault has its own, and a vault that is removed from the list of vaults and opened again asks for the token again.
   - **Device name**: it appears in commit messages and in the names of conflict files.
3. Press **Test** under "Connection test". It tells you whether the token reaches the repository and the branch.
4. Run **Sync** from the ribbon or the command palette. The first download asks when files in the vault differ from the repository's, and the first upload shows what it is about to upload and asks.

For Dropbox, set "Service" to **Dropbox**, check the name under **Folder** (the name of the vault, at first) and **Device name** (used in the names of conflict files), press **Connect** and allow in the browser, and go on from step 3.

### What is not synced

The settings under "Not synced (all devices)" are written into the `.gitignore` at the root of the vault, between two lines that start with `# >>> Sync Evo` and `# <<< Sync Evo`. They apply alike to all your devices and to git on a computer.

- **Excluded folders**: folders that are not synced, as paths from the root of the vault.
- **Vault configuration sync**: which parts of the configuration folder (`.obsidian/`) are synced, under the names Obsidian Sync uses for them.

The settings under "Not synced (this device only)" are kept with the other settings of the device, and reach no other device and no git. The group is closed until you open it, and says beside its name what it leaves out.

- **File types**: images, audio, videos, PDFs, and all other types. Notes, canvases and bases are always synced.
- **Excluded folders**: as above, for this device alone.

**Write rules directly (.gitignore)** shows the whole file, for rules of your own. Write them outside the lines Sync Evo manages.

Excluding something deletes nothing, on a device or on GitHub. What is excluded is not synced even when the repository already holds it: it is neither uploaded nor downloaded, and a deletion on either side is not carried over. "Excluded files still on GitHub" lists the files the repository holds that are excluded for all devices, and "Remove from GitHub" tidies them away: it removes them from the repository and leaves them on every device with Sync Evo, while git on a computer deletes them from its working tree at its next `git pull`. What is deleted while it is excluded is not deleted on the other side when you stop excluding it: a file deleted on the device is downloaded again, and one removed from GitHub is uploaded again. So a file you deleted on purpose with git on a computer may be uploaded again from a device that excluded it.

The trash, the layout of the workspace, Sync Evo's own folder, and files an operating system leaves behind are left out by default.

### How it syncs

These are kept per device. The three switches of automatic sync are off until you switch them on.

- **Sync on startup**: syncs when Obsidian starts, and when you come back to it from another app, unless the last sync started less than 5 minutes ago.
- **Sync at an interval**: syncs while Obsidian is in front, each time the interval (in minutes) has passed since the last sync started. After a sync that failed, the next one waits twice as long, up to an hour.
- **Also upload changes in automatic sync**: when off, automatic sync only downloads, and what you edit on the device is uploaded when you sync manually. When on, the interval is at least 5 minutes, since every upload is a commit.
- **On a conflict**: "Automatically merge", which is the default, or "Create conflict file". What each does is told under "What it does" above.

### Commands

| Command | What it does |
| --- | --- |
| Sync | A download, and then an upload. |
| Download changes from GitHub (or Dropbox) | Only downloads from the repository. |
| Upload changes to GitHub (or Dropbox) | Only uploads to the repository. A file the repository changed since this device last downloaded is not overwritten: it is left for the next download. A device has to download once before its first upload. |
| Start over (download everything from GitHub, or Dropbox, again) | Compares the vault with the repository again, as a first download does. No file is deleted. |
| Stop the sync | Stops a running sync. A stopped download continues from where it was; a stopped upload does not change the branch, and what it had already uploaded is in no commit. |

On GitHub, an upload makes one commit, with the message `Sync Evo: <device name> (<n> added, <n> modified, <n> deleted)` and the changed paths below it.

## Tested on

iPhone (iOS) and Mac (macOS). The basic sync was also tried on one Android phone (a Pixel 6a), one iPad, and one Windows 11 PC. It has not been tried on Linux. Dropbox was tried on one Android phone and one iPhone, and not yet on a desktop.

On Android, files are always downloaded one at a time: the zip of the whole commit is not used there, because Obsidian's request function runs out of memory on a large response. So the first download of a vault of more than about 5,000 files runs into GitHub's hourly request limit: a sync started by hand waits for the limit to lift and takes over an hour, and a sync that started by itself stops there and a later one goes on. Files of 2 MB and more are downloaded with the WebView's `fetch`, which does not go through the part that runs out of memory.

## Bugs and requests

Report a bug or ask for a feature in the [issues](https://github.com/seking/obsidian-sync-evo/issues) of the repository. Do not put a token, or a file name you would rather keep to yourself, into a report.

## Where things are kept

The settings and the record of what was synced are kept on the device, outside the vault (in the app's local storage and in IndexedDB), and are not synced. The token is kept in Obsidian's Keychain; the settings hold only the name it is saved under. What lets Sync Evo reach Dropbox (a refresh token) is kept in the app's local storage, for this vault on this device, and the settings hold the ID and the e-mail address of the Dropbox account. Sync Evo writes no `data.json`.

## Network use

Sync Evo makes network requests only when you press "Test" in its settings, run one of its commands or press its button in the ribbon, or remove files from GitHub in its settings, or, with Dropbox, press "Connect" or "Disconnect"; and, when you have switched automatic sync on under "How it syncs", for the downloads and uploads it then starts by itself, which ask and send what a download and an upload do. All of them go to GitHub (`api.github.com`) and carry the token and the names of the repository and the branch, or of the repository a submodule points to. One kind of request, the download of a zip described below, is redirected by GitHub to another of its hosts (`codeload.github.com`).

- **Connection test** asks for the branch you entered, and for the repository when the branch is not found, to tell you whether the token can reach them.
- **Download** asks for the branch (and, like the test, for the repository when the branch is not found), for the list of files in its latest commit, and for the content of each file that is new or changed. For a symbolic link, which is not written to the vault, it reads where the link points: one small request per link that is new or changed. When the branch has moved since the last download, it also asks whether the new commit builds on the old one. When more than 1,000 files are new or changed (a first download of a large repository, for one) and the zip is not expected to be too large for the device, it asks for the zip of that commit in one request instead of for each file (not on Android: see "Tested on"), and then only for the files the zip does not hold as they are listed. The zip is kept in memory and never saved. When the repository has submodules, a download reads its `.gitmodules` and asks the repository each submodule points to, on GitHub and with the same token, for the list of files of the commit the submodule points to, for the content of the files that are new or changed (or for the zip of that commit, as above), and, when the list cannot be had, whether the token sees that repository at all. A download sends nothing from the vault: no file, no file name, and no content.
- **Upload** asks for the branch and the list of files as a download does, then sends the content of each file that was added or changed in the vault, the paths of the files that were added, changed, or deleted, and a commit whose message holds the device name and those paths. It then moves the branch to that commit and asks for the list of files of the new commit. When it is not known whether an earlier upload went through, it first asks whether the commit on the branch builds on the one this device last synced with. For a repository that has no commits yet, it asks for the repository to learn its default branch, and the `.gitignore` is sent first, as a commit of its own. Files that are excluded are not sent.
- **Removing files from GitHub** asks for the branch and the list of files as a download does, then sends the paths of the files to remove from the repository, the `.gitignore` of the vault when the repository does not hold it as the device has it, and a commit whose message holds the device name and those paths, and moves the branch to that commit. A download runs before it. No other change of the vault is sent with it.

With Dropbox, the same actions go to Dropbox instead (`api.dropboxapi.com` and `content.dropboxapi.com`), and carry a token Dropbox gave for this device and the path of the folder of the vault. Sync Evo's own folder is all they can reach.

- **Connect** opens Dropbox's page in the browser (`www.dropbox.com`). After you allow, Sync Evo exchanges the code Dropbox sends back for a token, and asks which account it reached: its ID, to tell a reconnection to the same account from another, and its e-mail address, to show in the settings. A token is renewed with Dropbox when it runs out, every few hours. **Disconnect** tells Dropbox to forget the token.
- **Connection test** asks whether the folder of the vault is there.
- **Download** asks for what changed in the folder since the last sync (the whole list of files, the first time), and for the content of each file that is new or changed. To merge a file, it asks for the list of its versions and for the content of the one from the last sync.
- **Upload** sends the content and the path of each file that was added or changed, the paths of the files that were deleted, and then asks what changed in the folder again.
- **Removing files from Dropbox** sends the `.gitignore` of the vault when Dropbox does not hold it as the device has it, and then the paths of the files to remove.

Nothing is sent anywhere else. Sync Evo collects no usage data and contacts no server of its developer.

## Development

Requires Node.js and npm.

```sh
npm install
npm run dev      # rebuild main.js on change
npm run build    # type check and lint, then production build of main.js
npm test         # unit tests
```

### Source layout

`src/core/` holds the parts that do not depend on where they run: the interface a remote implements, and the decision of what to download, upload, and delete. Code there must not import `obsidian` (a types-only package that the tests cannot load) or any Node API (the mobile app has none); a test checks this. Code that touches the Obsidian API stays outside `src/core/` and is kept thin.

The in-memory remote used by the tests is in `tests/support/`.

Every text the plugin shows comes from `src/core/i18n/`, never from a string written where it is used; a test searches the code outside `src/core/` for a string given to `setName`, `Notice`, and the like. To add a message, add it to `en.ts` (the base) and to `ja.ts`, and read it through the plugin's `t("key", { name: value })`; placeholders are `{name}`, and a message that changes with a number is written as `{ one: "{count} file", other: "{count} files" }`. The build fails if Japanese lacks a key, has one the base does not, or names a placeholder differently. The type check also stops an empty message, a misnamed or empty plural form, and an `other` form that drops a placeholder, while the tests (`npm test`, which `npm run build` does not run) stop what the types cannot see, such as text that is only spaces. To add a language, add its file (with `partialTranslation` while it is incomplete; missing messages are shown in English) and register it in `index.ts` under the code Obsidian uses for that language.

The names of the file type and vault configuration options follow the wording of the same options of Obsidian Sync in the app ([obsidian-translations](https://github.com/obsidianmd/obsidian-translations)), so that they read the same in each language.

### Installing into a vault

`npm run install:vault` copies `main.js` and `manifest.json` (and `styles.css`, if present) into `<vault>/.obsidian/plugins/sync-evo/`.

Set the vault folder in the `SYNC_EVO_VAULT` environment variable, or copy `.env.example` to `.env.local` (ignored by git) and edit it there.

```sh
npm run build
SYNC_EVO_VAULT=/path/to/your/vault npm run install:vault
```

Then enable Sync Evo under Settings → Community plugins. Reload the app, or turn the plugin off and on, after installing a new build.

### Testing on a phone

`npm run release:beta` creates a GitHub prerelease of the current commit, tagged `<version>-beta.<N>`, with `main.js` and a `manifest.json` carrying that version attached. It needs the [GitHub CLI](https://cli.github.com) (`gh`), a clean working tree, and the commit pushed. Add `-- --dry-run` to see what it would do without creating the release.

On the phone, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository as a beta plugin. To pick up a newer beta, use BRAT's check for updates.

## License

Copyright (C) 2026 seking

Sync Evo is free software licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text. It comes with no warranty.

The source code is at <https://github.com/seking/obsidian-sync-evo>.

### Third-party licences

The distributed `main.js` bundles the packages below. Their copyright notices and the text of their licence are also at the top of `main.js`.

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| [ignore](https://github.com/kaelzhang/node-ignore) | 7.0.12 | MIT | Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors |
| [node-diff3](https://github.com/bhousel/node-diff3) | 3.2.1, with [one change](https://github.com/seking/node-diff3/commit/8b787fe55d7979b37d7116aed2b2c91f31600c45) | MIT | Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net><br>Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net><br>Copyright (c) 2019-2026 Bryan Housel <bhousel@gmail.com> |
