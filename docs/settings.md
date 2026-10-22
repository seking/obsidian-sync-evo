# Settings

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/settings.md)

## Connection

For GitHub:

- **Repository**: as `owner/name`, or its address pasted from the browser.
- **Branch**: the branch to sync with. Sync Evo does not create it.
- **Token**: the secret that holds the token. See [The token](#the-token).
- **Device name**: it appears in commit messages and in the names of conflict files.

For Dropbox, see [Dropbox](dropbox.md). For Google Drive, see [Google Drive](google-drive.md).

With Dropbox and Google Drive, there is also **License key**. See [License key](#license-key).

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

### License key

Sync Evo with Dropbox and Google Drive is free for 3 months, and then a license key is needed. One key is for both. GitHub is free. See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

**License key** is shown under "Connection" with Dropbox and Google Drive:

- Buy a key on the web, at [gyap.jp/sync-evo](https://gyap.jp/sync-evo/#pricing). On a computer, **Get a key** opens that page. The settings on phones have no link to buy one, only the link "See the README of Sync Evo for details.".
- Enter the key on each device. It is taken when you leave the field. The × beside the field ("Remove the key from this device") empties it and removes the key at once.
- One key is for this device, whichever vault it is entered in. It is kept in the app's local storage, not in a file of the vault.
- Sync Evo checks the key with Dodo Payments, the seller of the keys. It sends the key, and the **Device name** as the name of this device's activation. Nothing from the vault. See [Network use and privacy](network.md#license-key).
- One key works on up to 5 devices. Emptying the field removes the key from this device, and ends its activation with Dodo, which frees its place for another device. If you no longer have a device, end its activation in the [billing portal](https://customer.dodopayments.com/login/bus_0NpvnyuwMvGA62iaE3swK) of Dodo Payments, or write to contact@gyap.jp.
- Below the field, Sync Evo says where this device stands:
  - "Free until … with this account.", while the free time lasts ("Free for 3 months with this account. The day it ends is shown after the next sync.", until Sync Evo has learnt when it began),
  - "The free time ended on …. Until …, Sync Evo only downloads.", for 30 days after it,
  - "The free time ended on …. Sync Evo no longer syncs with …", after those 30 days,
  - "The key is in use on this device.",
  - "The key could not be checked since …. It works until …, and is checked again meanwhile.", when Dodo could not be reached: a key that was valid works for 14 days,
  - "The key could not be checked. …", when Dodo could not be reached and the key has not been valid within those 14 days,
  - "This key cannot be used.", when the key was refunded, cancelled, has ended, or is not a key of Sync Evo.
- With your own Google client, no key is needed. See [Your own Google client](#your-own-google-client).

## Your own Google client

Shown with Google Drive, closed until you open it. For advanced users, and for when the Google client of Sync Evo stops working:

- **Client ID** and **Client secret**: of an OAuth client of the type "TVs and Limited Input devices", from a Google Cloud project of your own.
- Changing the client asks you to connect again. With a client of another project, the vault is uploaded again into a new folder, and the old one stays on Google Drive.
- Empty the ID to go back to the client of Sync Evo.

What it takes and what changes: see [Your own Google client](google-drive.md#your-own-google-client).

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

- Excluding something deletes nothing, on a device or on GitHub, Dropbox or Google Drive.
- What is excluded is not synced, even when GitHub, Dropbox or Google Drive already holds it.
- It is neither uploaded nor downloaded.
- A deletion on either side is not carried over.

**Excluded files still on GitHub** (or Dropbox, or Google Drive) lists the files held there that are excluded for all devices. **Remove from GitHub** (or Dropbox, or Google Drive) tidies them away:

- It removes them from GitHub, Dropbox or Google Drive.
- It leaves them on every device with Sync Evo.
- Git on a computer deletes them from its working tree at its next `git pull`.

What is deleted while it is excluded is not deleted on the other side when you stop excluding it:

- A file deleted on the device is downloaded again.
- A file removed from GitHub, Dropbox or Google Drive is uploaded again.

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
  - When on, the interval is at least 5 minutes. With GitHub, every upload is a commit. With Dropbox, a note in the middle of being written would otherwise be uploaded over and over.
  - With Google Drive, the interval is at least 5 minutes either way: every check counts against a limit that all users of Sync Evo share (see [Google Drive](google-drive.md#limits-of-google)).
- **On a conflict**: "Automatically merge" (the default), or "Create conflict file". See [When a file changed on both sides](syncing.md#when-a-file-changed-on-both-sides). With Google Drive, a conflict file is always made.

How automatic sync behaves is in [When it runs](syncing.md#when-it-runs).
