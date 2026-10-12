# Sync Evo

Sync Evo is a plugin for [Obsidian](https://obsidian.md) that syncs a vault with a GitHub repository. It is made for large vaults and for phones: it needs no git on the device, talks to GitHub's API directly, and can pick up a first fetch of thousands of files where it was interrupted.

It is free, with all of its features. There is no account to create and no server of the developer's.

## What it does

- **Pull** brings the vault in line with the repository: it fetches the files that are new or changed there, and deletes the ones that were deleted there.
- **Push** sends what was added, changed, and deleted in the vault as one commit.
- **Sync** does both, a pull and then a push. It is also the button in the ribbon.

Nothing runs on its own unless you switch it on: a sync happens when you press the button or run a command. Under "How it syncs" in the settings, Sync Evo can also sync when Obsidian starts or comes back from another app, and at an interval while it is in front. Such a sync only pulls, unless you let it send changes too; it says nothing when it went well, and never answers one of the questions below for you: it changes nothing then, and tells you once to sync manually. It does not start the first fetch of a vault either; that one you start yourself. A note you are typing in is left as it is by an automatic sync, and is updated or sent by a later one, once you have stopped typing for 20 seconds. A sync you start while an automatic one is running takes its place.

A file that was changed both in the vault and in the repository is not overwritten. It gets the changes of both sides, line by line, under its own name, and the notice of the sync names it. What the file held on the device before that is kept in `.trash/.sync-evo-merged/` in the vault, as `<date> <name>.<extension>`: for `notes/a.md` that is `.trash/.sync-evo-merged/2026-10-13 a.md`, and a second one on the same day is `2026-10-13 a (1).md`. It is not synced, Obsidian does not show it, and Sync Evo never deletes it: delete the folder when you no longer need what is in it.

A file that does not merge that way is kept twice instead: when both sides changed the same lines, when it is no text, a `.canvas` or a `.base`, and always on a device where "On a conflict", under "How it syncs" in the settings, is set to keep a separate file. The repository's version takes the name, and the vault's version is kept as a copy in the folder `_conflicts/` at the root of the vault, as `<date> <name> (<device>).<extension>`: the copy of `notes/a.md` is `_conflicts/2026-10-12 a (iPhone).md`, and a second copy of the same note on the same day is `_conflicts/2026-10-12 a (iPhone) (1).md`. The notice of the sync names both files. A copy is synced like any other file, whatever `.gitignore` says. A file in the configuration folder gets no such copy: the vault's version goes to `.trash/` in the vault.

A copy is kept for 30 days from the end of the day in its name. After that a sync moves it to `.trash/` in the vault, and tells how many it moved; the next push deletes the copy in the repository, and the other devices then remove it as they remove any deleted file. To keep a copy, move it out of `_conflicts/` or rename it. Up to 0.2.0 a copy was made beside its file, as `<name>.conflict-from-<device>-<date>-<time>.<extension>`. Copies of that form stay where they are, are synced as before, and are never moved to `.trash/`.

Sync Evo stops and asks before it goes on when

- a pull or a push would delete many files (more than 50, or more than 5 that are also more than a tenth of all files),
- a push finds none of the files it synced before in the vault, however few they are (a vault whose folder was deleted and created again looks like this): it can then fetch them again from the repository instead of deleting them there,
- the first pull finds files in the vault that differ from the repository's,
- a device pushes for the first time,
- the history of the repository was rewritten (a force push).

What is synced is decided by the `.gitignore` at the root of the vault, so that Sync Evo and git on a computer leave out the same files. The settings screen writes that file for you.

## Not supported yet

- **Submodules.** The folder of a submodule is not created on the device, and nothing in it is fetched or sent. Sync Evo tells you once when the repository has one.
- **Git LFS.** A pointer file is synced as it is, and the content it stands for is not fetched.
- **Line ending conversion.** The `text` and `eol` settings of `.gitattributes` are not applied: every file is stored and written byte for byte as the repository holds it.
- **Symbolic links.** They are not written to the device and are left as they are in the repository. The settings list them.
- **Other services** than GitHub.

Also:

- A file over 38 MB is not synced.
- A repository with more than 100,000 files, or one whose listing is over 7 MB, cannot be synced.
- `.gitignore` files in subfolders are synced as ordinary files and are not read as rules. Only the one at the root counts.
- On a desktop, a symbolic link in the vault (or a junction, on Windows) is listed as if it were a folder, so the files behind it are treated as files of the vault: they are sent, and a pull can write and delete them there, also when the link points outside the vault (seen on Windows; on Mac the link is listed the same way). Do not keep such a link in a vault that Sync Evo syncs.
- On Android, a rename made on another device that changes only upper and lower case (`tools/` to `Tools/`) is not applied. The pull skips the path and says so, and the push holds the file back. Nothing is lost, but the path stays unsynced, and the two notices come back on every sync.

## Tested on

iPhone (iOS) and Mac (macOS). The basic sync was also tried on one Android phone (a Pixel 6a), one iPad, and one Windows 11 PC. It has not been tried on Linux.

On Android, files are always fetched one at a time: the zip of the whole commit is not used there, because Obsidian's request function runs out of memory on a large response. So the first fetch of a vault of more than about 5,000 files runs into GitHub's hourly request limit: a sync started by hand waits for the limit to lift and takes over an hour, and a sync that started by itself stops there and a later one goes on. Files of 2 MB and more are downloaded with the WebView's `fetch`, which does not go through the part that runs out of memory.

## Bugs and requests

Report a bug or ask for a feature in the [issues](https://github.com/seking/obsidian-sync-evo/issues) of the repository. Do not put a token, or a file name you would rather keep to yourself, into a report.

## Where things are kept

The settings and the record of what was synced are kept on the device, outside the vault (in the app's local storage and in IndexedDB), and are not synced. The token is kept in Obsidian's Keychain; the settings hold only the name it is saved under. Sync Evo writes no `data.json`.

## Network use

Sync Evo makes network requests only when you press "Test" in its settings, run one of its commands or press its button in the ribbon, or untrack files in its settings; and, when you have switched automatic sync on under "How it syncs", for the pulls and pushes it then starts by itself, which ask and send what a pull and a push do. All of them go to GitHub (`api.github.com`) and carry the token and the names of the repository and the branch. One kind of request, the download of a zip described below, is redirected by GitHub to another of its hosts (`codeload.github.com`).

- **Connection test** asks for the branch you entered, and for the repository when the branch is not found, to tell you whether the token can reach them.
- **Pull** asks for the branch (and, like the test, for the repository when the branch is not found), for the list of files in its latest commit, and for the content of each file that is new or changed. For a symbolic link, which is not written to the vault, it reads where the link points: one small request per link that is new or changed. When the branch has moved since the last pull, it also asks whether the new commit builds on the old one. When more than 1,000 files are new or changed (a first pull of a large repository, for one) and the zip is not expected to be too large for the device, it asks for the zip of that commit in one request instead of for each file (not on Android: see "Tested on"), and then only for the files the zip does not hold as they are listed. The zip is kept in memory and never saved. A pull sends nothing from the vault: no file, no file name, and no content.
- **Push** asks for the branch and the list of files as a pull does, then sends the content of each file that was added or changed in the vault, the paths of the files that were added, changed, or deleted, and a commit whose message holds the device name and those paths. It then moves the branch to that commit and asks for the list of files of the new commit. When it is not known whether an earlier push went through, it first asks whether the commit on the branch builds on the one this device last synced with. For a repository that has no commits yet, it asks for the repository to learn its default branch, and the `.gitignore` is sent first, as a commit of its own. Files that `.gitignore` excludes are not sent.
- **Untracking** asks for the branch and the list of files as a pull does, then sends the paths of the files to remove from the repository, and a commit whose message holds the device name and those paths, and moves the branch to that commit. A pull runs before it, and a push when the rules are not in the repository yet.

Nothing is sent anywhere else. Sync Evo collects no usage data and contacts no server of its developer.

## Development

Requires Node.js and npm.

```sh
npm install
npm run dev      # rebuild main.js on change
npm run build    # type check, then production build of main.js
npm test         # unit tests
```

### Source layout

`src/core/` holds the parts that do not depend on where they run: the interface a remote implements, and the decision of what to fetch, send, and delete. Code there must not import `obsidian` (a types-only package that the tests cannot load) or any Node API (the mobile app has none); a test checks this. Code that touches the Obsidian API stays outside `src/core/` and is kept thin.

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

On the phone, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository as a beta plugin. While the repository is private, create a fine-grained personal access token that can only read the Contents of this repository, and select it as the GitHub token when adding the repository in BRAT. BRAT keeps the token in the app's secret storage. To pick up a newer beta, use BRAT's check for updates.

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
