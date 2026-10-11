# Sync Evo

Sync Evo is a plugin for [Obsidian](https://obsidian.md) that syncs a vault with a GitHub repository. It is made for large vaults and for phones: it needs no git on the device, talks to GitHub's API directly, and can pick up a first fetch of thousands of files where it was interrupted.

It is free, with all of its features. There is no account to create and no server of the developer's.

## What it does

- **Pull** brings the vault in line with the repository: it fetches the files that are new or changed there, and deletes the ones that were deleted there.
- **Push** sends what was added, changed, and deleted in the vault as one commit.
- **Sync** does both, a pull and then a push. It is also the button in the ribbon.

Nothing runs on its own unless you switch it on: a sync happens when you press the button or run a command. Under "How it syncs" in the settings, Sync Evo can also sync when Obsidian starts or comes back from another app, and at an interval while it is in front. Such a sync only pulls, unless you let it send changes too; it says nothing when it went well, and never answers one of the questions below for you: it changes nothing then, and tells you once to sync manually. It does not start the first fetch of a vault either; that one you start yourself. A note you are typing in is left as it is by an automatic sync, and is updated or sent by a later one, once you have stopped typing for 20 seconds. A sync you start while an automatic one is running takes its place.

A file that was changed both in the vault and in the repository is not overwritten. The repository's version takes the name, and the vault's version is kept beside it as `<name>.conflict-from-<device>-<date>-<time>.<extension>`. A file in the configuration folder gets no such copy: the vault's version goes to `.trash/` in the vault.

Sync Evo stops and asks before it goes on when

- a pull or a push would delete many files (more than 50, or more than 5 that are also more than a tenth of all files),
- the first pull finds files in the vault that differ from the repository's,
- a device pushes for the first time,
- the history of the repository was rewritten (a force push).

What is synced is decided by the `.gitignore` at the root of the vault, so that Sync Evo and git on a computer leave out the same files. The settings screen writes that file for you.

## Not supported yet

- **Merging** two versions of a note. A conflict always leaves both versions as files.
- **Submodules.** The folder of a submodule is not created on the device, and nothing in it is fetched or sent. Sync Evo tells you once when the repository has one.
- **Git LFS.** A pointer file is synced as it is, and the content it stands for is not fetched.
- **Line ending conversion.** The `text` and `eol` settings of `.gitattributes` are not applied: every file is stored and written byte for byte as the repository holds it.
- **Symbolic links.** They are not written to the device and are left as they are in the repository. The settings list them.
- **Vaults in iCloud Drive.** See below.
- **Other services** than GitHub.

Also:

- A file over 38 MB is not synced.
- A repository with more than 100,000 files, or one whose listing is over 7 MB, cannot be synced.
- `.gitignore` files in subfolders are synced as ordinary files and are not read as rules. Only the one at the root counts.

## Before you use it

**Keep the vault on the device, not in iCloud Drive.** A vault in iCloud Drive is not supported. iCloud removes files from the device to save space and leaves placeholders, a removed file looks as if it was deleted, and it can then be deleted in the repository as well. On an iPhone, create the vault under "On My iPhone".

**On a device where the vault is a git repository, use git.** If the vault has a `.git` at its root, sync that device with git or with the Obsidian Git plugin. Git does not learn of what Sync Evo sends, and its next pull would stop. Sync Evo is for the devices that have no git.

**"Installed community plugins" runs code from your other devices.** With that option on, the code of your other plugins, and their `data.json` (which can hold tokens and other credentials), is synced. Plugin code that came from another device runs on this one. Turn it on only with devices and a repository you trust. Sync Evo never syncs its own folder.

**"Active community plugin list" needs Sync Evo enabled everywhere.** While that list is synced, keep Sync Evo enabled on all your devices. If it is not enabled on one of them, the list that device sends turns Sync Evo off on the others the next time Obsidian starts, and syncing stops there.

## Setting up

Sync Evo is not in the community plugin directory yet. Until it is, it can be installed with [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `seking/obsidian-sync-evo`.

1. On GitHub, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) that has access to the repository of the vault only, with the repository permission **Contents: Read and write**. If the vault holds files under `.github/workflows/` that you change on the device, it also needs **Workflows: Read and write**.
2. In Obsidian, open Settings → Sync Evo and fill in "Connection":
   - **Repository**: as `owner/name`, or its address pasted from the browser.
   - **Branch**: the branch to sync with. Sync Evo does not create it.
   - **Token**: the secret that holds the token. It is kept in Obsidian's Keychain and is shared by all vaults on the device.
   - **Device name**: it appears in commit messages and in the names of files kept from a conflict.
3. Press **Test** under "Connection test". It tells you whether the token reaches the repository and the branch.
4. Run **Sync** from the ribbon or the command palette. The first pull asks when files in the vault differ from the repository's, and the first push shows what it is about to send and asks.

### What is synced

The settings under "What is synced" are written into the `.gitignore` at the root of the vault, between two lines that start with `# >>> Sync Evo` and `# <<< Sync Evo`. They apply alike to all your devices and to git on a computer.

- **File types**: images, audio, videos, PDFs, and all other types. Notes, canvases and bases are always synced.
- **Excluded folders**: folders that are not synced, as paths from the root of the vault.
- **Vault configuration**: which parts of the configuration folder (`.obsidian/`) are synced, under the names Obsidian Sync uses for them.
- **Write rules directly (.gitignore)**: the whole file, for rules of your own. Write them outside the lines Sync Evo manages.

Excluding something deletes nothing. A file the repository already holds stays synced until it is untracked: "Files that match a rule" lists those files and can untrack them, which removes them from the repository and leaves them on the device.

The trash, the layout of the workspace, Sync Evo's own folder, and files an operating system leaves behind are left out by default.

### How it syncs

All three are off until you switch them on, and are kept per device.

- **Sync on startup**: syncs when Obsidian starts, and when you come back to it from another app, unless the last sync started less than 5 minutes ago.
- **Sync at an interval**: syncs while Obsidian is in front, each time the interval (in minutes) has passed since the last sync started. After a sync that failed, the next one waits twice as long, up to an hour.
- **Also send changes in automatic sync**: when off, automatic sync only pulls, and what you edit on the device is sent when you sync manually. When on, the interval is at least 5 minutes, since every push is a commit.

### Commands

| Command | What it does |
| --- | --- |
| Sync (pull, then push) | A pull, and then a push. |
| Pull | Only fetches from the repository. |
| Push | Only sends to the repository. A file the repository changed since this device last pulled is not overwritten: it is left for the next pull. A device has to pull once before its first push. |
| First fetch (discard the sync state and start over) | Discards Sync Evo's record of what was synced and builds it again from the repository. No file is deleted. |
| Stop the sync | Stops a running sync. A stopped pull continues from where it was; a stopped push does not change the branch, and what it had already uploaded is in no commit. |

A push makes one commit, with the message `Sync Evo: <device name> (<n> added, <n> modified, <n> deleted)` and the changed paths below it.

## Tested on

iPhone (iOS) and Mac (macOS). It has not been tried on Android, iPad, Windows, or Linux yet.

## Bugs and requests

Report a bug or ask for a feature in the [issues](https://github.com/seking/obsidian-sync-evo/issues) of the repository. Do not put a token, or a file name you would rather keep to yourself, into a report.

## Where things are kept

The settings and the record of what was synced are kept on the device, outside the vault (in the app's local storage and in IndexedDB), and are not synced. The token is kept in Obsidian's Keychain; the settings hold only the name it is saved under. Sync Evo writes no `data.json`.

## Network use

Sync Evo makes network requests only when you press "Test" in its settings, run one of its commands or press its button in the ribbon, or untrack files in its settings; and, when you have switched automatic sync on under "How it syncs", for the pulls and pushes it then starts by itself, which ask and send what a pull and a push do. All of them go to GitHub (`api.github.com`) and carry the token and the names of the repository and the branch. One kind of request, the download of a zip described below, is redirected by GitHub to another of its hosts (`codeload.github.com`).

- **Connection test** asks for the branch you entered, and for the repository when the branch is not found, to tell you whether the token can reach them.
- **Pull** asks for the branch (and, like the test, for the repository when the branch is not found), for the list of files in its latest commit, and for the content of each file that is new or changed. For a symbolic link, which is not written to the vault, it reads where the link points: one small request per link that is new or changed. When the branch has moved since the last pull, it also asks whether the new commit builds on the old one. When more than 1,000 files are new or changed (a first pull of a large repository, for one) and the zip is not expected to be too large for the device, it asks for the zip of that commit in one request instead of for each file, and then only for the files the zip does not hold as they are listed. The zip is kept in memory and never saved. A pull sends nothing from the vault: no file, no file name, and no content.
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
