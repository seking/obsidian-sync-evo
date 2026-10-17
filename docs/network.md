# Network use and privacy

Sync Evo connects only when you use it, or when you have switched on automatic sync. Nothing is sent anywhere else. Sync Evo collects no usage data. There is no server of the developer's. Details are in [When Sync Evo connects](#when-sync-evo-connects).

The privacy policy of Sync Evo is at [gyap.jp/sync-evo/privacy](https://gyap.jp/sync-evo/privacy).

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

**Google Drive** (with a token Google gave this device, and the vault's folder name)

| Action | Host | What is sent | Why |
| --- | --- | --- | --- |
| Connect | `oauth2.googleapis.com`, `www.googleapis.com` | A request for a code (already when the settings are opened), requests for the token, then a request for the account | To connect this device |
| Connection test | `www.googleapis.com` | Requests for the folders `Sync Evo` and the vault's | To check that they are there |
| Download | `www.googleapis.com` | Requests for changes, the file list and file contents | To get new and changed files |
| Upload | `www.googleapis.com` | Added and changed files with their names, and the files to put in the trash | To send your changes |
| Remove from Google Drive | `www.googleapis.com` | The `.gitignore`, and the files to put in the trash | To remove excluded files from Google Drive |

**License key** (once the paid plan has started, with Dropbox or Google Drive, and only when a key is entered)

| Action | Host | What is sent | Why |
| --- | --- | --- | --- |
| Entering a key, checking it | `live.dodopayments.com` | The key, and the device name (first time) or the ID of this device's activation (later). Nothing from the vault, and nothing about your Dropbox or Google account | To activate the key for this device, and to check that it is still valid |
| Emptying the key | `live.dodopayments.com` | The key and the ID of this device's activation | To end this device's activation |

The paid plan has not started yet. Until it does, Sync Evo does not connect to Dodo Payments at all.

The page you allow Sync Evo on, `www.google.com/device`, is opened in the browser. Sync Evo itself does not connect to it. **Disconnect** sends nothing.

- The GitHub token is kept in Obsidian's Keychain. What lets Sync Evo reach Dropbox or Google Drive is kept in the app's local storage. The settings and the sync state stay on the device, outside the vault. Sync Evo writes no `data.json`.
- Sync Evo never syncs its own folder.

The rest of this page gives every request in detail.

## When Sync Evo connects

Sync Evo makes network requests only when you:

- press "Test" in its settings,
- run one of its commands, or press its button in the ribbon,
- remove excluded files from GitHub, Dropbox or Google Drive in its settings,
- with Dropbox, press "Connect" or "Disconnect",
- with Google Drive, open its settings while this device is not connected (Sync Evo asks Google for a code ahead of the press of "Connect"), or press "Connect",
- once the paid plan has started, enter or empty a license key, or sync or open its settings with Dropbox or Google Drive while the key is due to be checked again (see [License key](#license-key)).

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

## Google Drive

With Google Drive, the same actions go to Google instead (`oauth2.googleapis.com` and `www.googleapis.com`). They carry:

- a token Google gave for this device,
- the name of the folder of the vault, and the IDs of its folders and files.

Sync Evo asks only for the files it made itself (the `drive.file` permission). Nothing else in your Google Drive can be reached.

### Connect and Disconnect

- When the settings show Google Drive and this device is not connected, Sync Evo asks Google for a code (`oauth2.googleapis.com`). It keeps the code while it lasts.
- **Connect** shows the code and copies it. **Open the browser** in its window opens Google's page in the browser (`www.google.com/device`). That page is between you and Google. Sync Evo does not connect to it.
- While you allow, Sync Evo asks Google every few seconds whether you have (`oauth2.googleapis.com`). Then it gets a token.
- It asks which account it reached (`www.googleapis.com`):
  - its ID, to tell a reconnection to the same account from another,
  - its e-mail address, to show in the settings.
- A token is renewed with Google when it runs out, every hour.
- **Disconnect** sends nothing. It forgets the token on this device only. Telling Google would end the connection of every device. To end it for every device, remove Sync Evo under "Third-party apps & services" in your Google Account.

### Connection test

Asks whether the folder `Sync Evo` and the folder of the vault in it are there.

### Download

- Asks whether the folder `Sync Evo` and the folder of the vault are there, and are there only once.
- Asks what changed in Google Drive since the last sync (the changes). It takes only those in the folder of the vault.
- Asks for the whole list of files the first time, when a folder in the vault's changed, and when Google does not give the changes since the last sync.
- Asks for the content of each file that is new or changed.

### Upload

- Asks what changed since the download, so as not to write over another device's change.
- Sends the content and the name of each file that was added or changed, and makes the folders it needs. Files over 5 MB are sent in a resumable upload.
- Puts the files that were deleted in Drive's trash.
- Then asks what changed again.

### Removing files from Google Drive

- Sends the `.gitignore` of the vault, when Google Drive does not hold it as the device has it.
- Then puts the files to remove in Drive's trash.

## License key

Once the paid plan has started, a license key entered with Dropbox or Google Drive is checked with Dodo Payments (`live.dodopayments.com`), which sells the keys. Sync Evo uses Dodo's public API for keys, which takes no account and no secret of the developer's. Requests carry:

- the key,
- the device name from the settings, as the name of this device's activation, the first time,
- the ID of that activation, after that.

They carry nothing from the vault, and nothing about your Dropbox or Google account. Dodo sees the address the request comes from, as every service does. GYAP, the publisher of Sync Evo, can see on Dodo the activations of a key and their names.

- **Entering a key** activates it for this device. A key that turns out not to be a key of Sync Evo is let go of again at once.
- **Checking it again.** A valid key is checked again once a day, when you sync or open the settings with Dropbox or Google Drive. When Dodo could not be reached, it is tried again after an hour. A key that was valid keeps working for 14 days without an answer. A key Dodo no longer takes is asked about once a day.
- **Emptying the key**, or entering another, ends this device's activation.

Until the paid plan has started, and with GitHub, Sync Evo never connects to Dodo Payments.

## Where things are kept

- The settings and the record of what was synced are kept on the device, outside the vault (in the app's local storage and in IndexedDB). They are not synced.
- The GitHub token is kept in Obsidian's Keychain. The settings hold only the name it is saved under.
- For Dropbox, what lets Sync Evo reach Dropbox (a refresh token) is kept in the app's local storage, for this vault on this device.
- The settings hold the ID and the e-mail address of the Dropbox account.
- For Google Drive, the refresh token is kept the same way, in the app's local storage, for this vault on this device. The settings hold the ID and the e-mail address of the Google account, and the ID of the vault's folder on Google Drive.
- A license key, and what Dodo last said of it, are kept in the app's local storage, once for the device, whichever vault it was entered in.
- Removing Sync Evo leaves these on the device. With Dropbox or Google Drive, press **Disconnect** first to take the token away.
- Sync Evo writes no `data.json`.
- Sync Evo never syncs its own folder.
