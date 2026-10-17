# Settings

## Connection

For GitHub:

- **Repository**: as `owner/name`, or its address pasted from the browser.
- **Branch**: the branch to sync with. Sync Evo does not create it.
- **Token**: the secret that holds the token. See [The token](#the-token).
- **Device name**: it appears in commit messages and in the names of conflict files.

For Dropbox, see [Dropbox](dropbox.md). For Google Drive, see [Google Drive](google-drive.md).

### The token

- The token is kept in Obsidian's Keychain, not in a file of the vault.
- The settings hold only the name it is saved under.
- On iPhone and Android, every vault on the device can link the same secret.
- On Windows and Mac, each vault has its own. A vault that is removed from the list of vaults and opened again asks for the token again.

### Token permissions

The token is a [fine-grained personal access token](https://github.com/settings/personal-access-tokens). It needs:

- access to the repository of the vault only,
- the repository permission **Contents: Read and write**.

If the vault has submodules:

- Give the token access to their repositories too.
- **Contents: Read-only** is enough for those. But one token has one set of permissions for all its repositories.

If the vault holds files under `.github/workflows/` that you change on the device, the token also needs **Workflows: Read and write**.

## What is not synced

What is not synced is decided in two places:

- the `.gitignore` at the root of the vault, for all your devices and for git on a computer,
- the settings of each device, for that device alone.

The settings screen writes both for you.

### Not synced (all devices)

These settings are written into the `.gitignore` at the root of the vault, between two lines that start with `# >>> Sync Evo` and `# <<< Sync Evo`. They apply alike to all your devices and to git on a computer.

- **Excluded folders**: folders that are not synced, as paths from the root of the vault.
- **Vault configuration sync**: which parts of the configuration folder (`.obsidian/`) are synced. They use the names Obsidian Sync uses.

### Not synced (this device only)

These settings are kept with the other settings of the device. They reach no other device and no git. The group is closed until you open it, and says beside its name what it leaves out.

- **File types**: images, audio, videos, PDFs, and all other types. Notes, canvases and bases are always synced.
- **Excluded folders**: as above, for this device alone.

### Write rules directly (.gitignore)

This shows the whole file, for rules of your own. Write them outside the lines Sync Evo manages.

### Left out by default

- the trash,
- the layout of the workspace,
- Sync Evo's own folder,
- files an operating system leaves behind.

### How `.gitignore` rules differ from git

The rules of `.gitignore` are read the way git reads them, but applied differently:

- What they exclude is not synced, even when the repository already holds it.
- Git keeps tracking a file it tracks already.

So when `.obsidian/plugins/` is in the repository and you add it to `.gitignore`, your devices with Sync Evo stop syncing it. Git on a computer keeps uploading it.

Only the `.gitignore` at the root counts. See [Limits](limits.md).

### What happens when you exclude something

- Excluding something deletes nothing, on a device or on GitHub.
- What is excluded is not synced, even when the repository already holds it.
- It is neither uploaded nor downloaded.
- A deletion on either side is not carried over.

**Excluded files still on GitHub** lists the files the repository holds that are excluded for all devices. **Remove from GitHub** tidies them away:

- It removes them from the repository.
- It leaves them on every device with Sync Evo.
- Git on a computer deletes them from its working tree at its next `git pull`.

What is deleted while it is excluded is not deleted on the other side when you stop excluding it:

- A file deleted on the device is downloaded again.
- A file removed from GitHub is uploaded again.

So a file you deleted on purpose with git on a computer may be uploaded again from a device that excluded it.

### Installed community plugins

> [!WARNING]
> This option runs code from your other devices.

- With this option on, the code of your other plugins is synced.
- Their `data.json` is synced too. It can hold tokens and other credentials.
- Plugin code that came from another device runs on this one.
- Turn it on only with devices and a repository you trust.
- Sync Evo never syncs its own folder.

### Active community plugin list

> [!WARNING]
> While this list is synced, keep Sync Evo enabled on all your devices.

If Sync Evo is not enabled on one of them, the list that device sends turns Sync Evo off on the others the next time Obsidian starts. Syncing stops there.

## How it syncs

These settings are kept per device. The three switches of automatic sync are off until you switch them on.

- **Sync on startup**: syncs when Obsidian starts, and when you come back to it from another app. It skips this when the last sync started less than 5 minutes ago.
- **Sync at an interval**: syncs while Obsidian is in the foreground, each time the interval (in minutes) has passed since the last sync started. After a sync that failed, the next one waits twice as long, up to an hour.
- **Also upload changes in automatic sync**:
  - When off, automatic sync only downloads. What you edit on the device is uploaded when you sync manually.
  - When on, the interval is at least 5 minutes, since every upload is a commit.
- **On a conflict**: "Automatically merge" (the default), or "Create conflict file". See [When a file changed on both sides](syncing.md#when-a-file-changed-on-both-sides). With Google Drive, a conflict file is always made.

How automatic sync behaves is in [When it runs](syncing.md#when-it-runs).
