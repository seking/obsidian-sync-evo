# Sync Evo

Sync a vault with a GitHub repository or a Dropbox folder, without Git on the device. Built for large vaults and for phones.

## What it does

- **Download** brings the vault in line with the remote. It gets the files that are new or changed there, and deletes the ones that were deleted there.
- **Upload** sends what you added, changed and deleted in the vault. On GitHub, it is one commit.
- **Sync** does a download and then an upload. It is also the button in the ribbon.
- Nothing runs on its own unless you switch on automatic sync.
- Before a large deletion and other risky steps, Sync Evo stops and asks.
- When a file changed on both sides, nothing is overwritten. The changes are merged, or both versions are kept.
- What a merge replaced is kept in `.trash/.sync-evo-merged/` in the vault. [How syncing works](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md)

## What you need

- Obsidian 1.11.4 or later.
- A GitHub account and a repository, or a Dropbox account.
- No account with the developer. Every feature is free.

## Before you start

> [!WARNING]
> **If the vault has a `.git` folder at its root, sync that device with git or the Obsidian Git plugin.** Sync Evo is for the devices that have no git. [Why](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md#my-vault-has-a-git-folder)

> [!WARNING]
> **Support for a vault in iCloud Drive is experimental.** Do not sync the same iCloud vault with Sync Evo on two devices. Do not make it a git working tree on the Mac. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)

## Setting up

Sync Evo is not in the community plugin directory yet. Until it is, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `seking/obsidian-sync-evo`.

### GitHub

1. If you have no repository for the vault yet, create an empty private repository on GitHub. Do not add a README or any other file. The first upload fills it.
2. Open [this page to create a token](https://github.com/settings/personal-access-tokens/new?name=Sync+Evo&description=Obsidian+Sync+Evo&expires_in=90&contents=write). The name, the expiry and **Contents: Read and write** are filled in.
   - Under "Repository access", choose **Only select repositories** and pick the vault's repository. The link cannot choose it for you.
   - With submodules or files under `.github/workflows/`, the token needs more. See [Token permissions](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#token-permissions).
3. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", fill in:
   - **Repository**: `owner/name`, or the address pasted from the browser.
   - **Branch**: the branch to sync with. Sync Evo does not create it. For a new empty repository, use the branch GitHub shows for it (`main`, unless you changed GitHub's default).
   - **Token**: the secret that holds the token. It is kept in Obsidian's Keychain, not in the vault.
   - **Device name**: shown in commit messages and in the names of conflict files.
4. Press **Test** under "Connection test". It tells you whether the token reaches the repository and the branch.
5. Run **Sync** from the ribbon or the command palette. The first download asks when files in the vault differ from the repository's. The first upload shows what it will upload, and asks.

### Dropbox

1. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", set **Service** to **Dropbox**. Check **Folder** (the name of the vault, at first) and **Device name** (used in the names of conflict files).
2. Press **Connect**, sign in to Dropbox if asked, and press **Allow**. The browser sends you back to Obsidian.
3. Press **Test**, then run **Sync**, as in steps 4 and 5 for GitHub.

Sync Evo reaches only its own folder in your Dropbox, `Apps/Sync Evo/`. Files you delete stay in Dropbox's version history for a while. More: [Dropbox](https://github.com/seking/obsidian-sync-evo/blob/main/docs/dropbox.md).

## Settings at a glance

- **Not synced**: folders, file types and parts of `.obsidian/` to leave out. Some apply to all devices, through the vault's `.gitignore`. Others apply to this device only. Excluding something deletes nothing. [Settings](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md)
- **How it syncs**: sync on startup, sync at an interval, and whether automatic sync also uploads. All are off at first.
- **On a conflict**: merge automatically (the default), or create a conflict file.

> [!WARNING]
> **"Installed community plugins" runs code from your other devices.** Their code runs here, and their `data.json` (which can hold tokens) is synced too. Turn it on only with devices and a remote you trust. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#installed-community-plugins)

> [!WARNING]
> **"Active community plugin list" needs Sync Evo enabled on every device.** Otherwise a device without it turns Sync Evo off on the others, and syncing stops there. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#active-community-plugin-list)

## Commands

| Command | What it does |
| --- | --- |
| Sync | A download, then an upload. |
| Download changes from GitHub (or Dropbox) | Only downloads. |
| Upload changes to GitHub (or Dropbox) | Only uploads. A device has to download once before its first upload. |
| Start over (download everything from GitHub, or Dropbox, again) | Compares the vault with the remote again, as a first download does. No file is deleted. |
| Stop the sync | Stops a running sync. A stopped download continues where it left off. |

[More about the commands](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md#commands)

## Not supported yet

- Changes inside a submodule. Submodules are downloaded and read only.
- Git LFS.
- Line ending conversion from `.gitattributes`.
- Symbolic links.
- Services other than GitHub and Dropbox.
- Files over 38 MB, and repositories with more than 100,000 files. [All limits](https://github.com/seking/obsidian-sync-evo/blob/main/docs/limits.md)

## Network use and privacy

Sync Evo connects only when you use it, or when you have switched on automatic sync. [Full details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)

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

- Nothing is sent anywhere else. Sync Evo collects no usage data. There is no server of the developer's.
- The token is kept in Obsidian's Keychain. The settings and the sync state stay on the device, outside the vault. Sync Evo writes no `data.json`.
- Sync Evo never syncs its own folder.

## Tested on

iPhone and Mac. Also tried on one Android phone, one iPad and one Windows 11 PC, not on Linux. Dropbox was tried on Android and iPhone, not yet on a desktop.

## Help and bugs

- Questions: see the [FAQ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md) and the [documentation](https://github.com/seking/obsidian-sync-evo/blob/main/docs/README.md).
- Bugs and feature requests: open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token, or a file name you would rather keep private, into a report.

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

To build Sync Evo or help with it, see [CONTRIBUTING.md](https://github.com/seking/obsidian-sync-evo/blob/main/CONTRIBUTING.md).
