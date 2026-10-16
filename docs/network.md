# Network use and privacy

Sync Evo connects only when you use it, or when you have switched on automatic sync. Nothing is sent anywhere else. Sync Evo collects no usage data. There is no server of the developer's. Details are in [When Sync Evo connects](#when-sync-evo-connects).

## At a glance

**GitHub** (with the token, and the names of the repository and the branch)

| Action | Host | What is sent | Why |
| --- | --- | --- | --- |
| Connection test | `api.github.com` | Requests for the repository and the branch | To check that the token reaches them |
| Download | `api.github.com`, `codeload.github.com` | Requests for the file list and contents. Nothing from the vault. | To get new and changed files |
| Upload | `api.github.com` | Added and changed files, the paths of added, changed and deleted files, and a commit | To send your changes |
| Remove from GitHub | `api.github.com` | The paths to remove, the `.gitignore`, and a commit | To remove excluded files from the repository |

**Dropbox** (with a token Dropbox gave this device, and the vault's folder path)

| Action | Host | What is sent | Why |
| --- | --- | --- | --- |
| Connect, Disconnect | `www.dropbox.com`, `api.dropboxapi.com` | The sign-in in the browser, then the code (Connect) or the token (Disconnect) | To connect this device, and to forget it |
| Connection test | `api.dropboxapi.com` | A request for the vault's folder | To check that it is there |
| Download | `api.dropboxapi.com`, `content.dropboxapi.com` | Requests for changes, file contents and versions | To get new and changed files, and to merge |
| Upload | `api.dropboxapi.com`, `content.dropboxapi.com` | Added and changed files, and the paths of deleted files | To send your changes |
| Remove from Dropbox | `api.dropboxapi.com`, `content.dropboxapi.com` | The `.gitignore`, and the paths to remove | To remove excluded files from Dropbox |

- The token is kept in Obsidian's Keychain. The settings and the sync state stay on the device, outside the vault. Sync Evo writes no `data.json`.
- Sync Evo never syncs its own folder.

The rest of this page gives every request in detail.

## When Sync Evo connects

Sync Evo makes network requests only when you:

- press "Test" in its settings,
- run one of its commands, or press its button in the ribbon,
- remove files from GitHub in its settings,
- with Dropbox, press "Connect" or "Disconnect".

When you have switched on automatic sync under "How it syncs", it also connects for the downloads and uploads it starts by itself. These ask for and send what a download and an upload do.

Nothing is sent anywhere else. Sync Evo collects no usage data and contacts no server of its developer.

## GitHub

All requests go to GitHub (`api.github.com`). They carry:

- the token,
- the names of the repository and the branch, or of the repository a submodule points to.

One kind of request, the download of a zip described below, is redirected by GitHub to another of its hosts (`codeload.github.com`).

### Connection test

- Asks for the branch you entered.
- Asks for the repository when the branch is not found.
- This tells you whether the token can reach them.

### Download

A download sends nothing from the vault: no file, no file name, and no content. It asks for:

- the branch, and the repository when the branch is not found (like the test),
- the list of files in the latest commit,
- the content of each file that is new or changed.

Also:

- **Symbolic links.** A link is not written to the vault. The download reads where the link points: one small request per link that is new or changed.
- **A moved branch.** When the branch has moved since the last download, it asks whether the new commit builds on the old one.
- **A zip.** When more than 1,000 files are new or changed (a first download of a large repository, for one), it asks for the zip of that commit in one request, instead of for each file. This happens only when the zip is not expected to be too large for the device. It does not happen on Android: see [Limits](limits.md#downloads-one-file-at-a-time). It then asks only for the files the zip does not hold as they are listed. The zip is kept in memory and never saved.
- **Submodules.** When the repository has submodules, a download reads its `.gitmodules`. It then asks the repository each submodule points to, on GitHub and with the same token, for:
  - the list of files of the commit the submodule points to,
  - the content of the files that are new or changed (or the zip of that commit, as above),
  - whether the token sees that repository at all, when the list cannot be had.

### Upload

An upload:

1. asks for the branch and the list of files, as a download does,
2. sends the content of each file that was added or changed in the vault,
3. sends the paths of the files that were added, changed, or deleted,
4. sends a commit whose message holds the device name and those paths,
5. moves the branch to that commit,
6. asks for the list of files of the new commit.

Also:

- When it is not known whether an earlier upload went through, it first asks whether the commit on the branch builds on the one this device last synced with.
- For a repository that has no commits yet, it asks for the repository to learn its default branch. The `.gitignore` is sent first, as a commit of its own.
- Files that are excluded are not sent.

### Removing files from GitHub

1. A download runs first.
2. It asks for the branch and the list of files, as a download does.
3. It sends the paths of the files to remove from the repository.
4. It sends the `.gitignore` of the vault, when the repository does not hold it as the device has it.
5. It sends a commit whose message holds the device name and those paths.
6. It moves the branch to that commit.

No other change of the vault is sent with it.

## Dropbox

With Dropbox, the same actions go to Dropbox instead (`api.dropboxapi.com` and `content.dropboxapi.com`). They carry:

- a token Dropbox gave for this device,
- the path of the folder of the vault.

Sync Evo's own folder is all they can reach.

### Connect and Disconnect

- **Connect** opens Dropbox's page in the browser (`www.dropbox.com`).
- After you allow, Sync Evo exchanges the code Dropbox sends back for a token.
- It asks which account it reached:
  - its ID, to tell a reconnection to the same account from another,
  - its e-mail address, to show in the settings.
- A token is renewed with Dropbox when it runs out, every few hours.
- **Disconnect** tells Dropbox to forget the token.

### Connection test

Asks whether the folder of the vault is there.

### Download

- Asks for what changed in the folder since the last sync (the whole list of files, the first time).
- Asks for the content of each file that is new or changed.
- To merge a file, asks for the list of its versions and for the content of the one from the last sync.

### Upload

- Sends the content and the path of each file that was added or changed.
- Sends the paths of the files that were deleted.
- Then asks what changed in the folder again.

### Removing files from Dropbox

- Sends the `.gitignore` of the vault, when Dropbox does not hold it as the device has it.
- Then sends the paths of the files to remove.

## Where things are kept

- The settings and the record of what was synced are kept on the device, outside the vault (in the app's local storage and in IndexedDB). They are not synced.
- The token is kept in Obsidian's Keychain. The settings hold only the name it is saved under.
- For Dropbox, what lets Sync Evo reach Dropbox (a refresh token) is kept in the app's local storage, for this vault on this device.
- The settings hold the ID and the e-mail address of the Dropbox account.
- Sync Evo writes no `data.json`.
- Sync Evo never syncs its own folder.
