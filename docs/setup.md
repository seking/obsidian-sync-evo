# Setting up

## What you need

- Obsidian 1.11.4 or later.
- A GitHub account and a repository, or a Dropbox account.
- No account with the developer. Every feature is free.

## Installing

Sync Evo is not in the community plugin directory yet. Until it is, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `seking/obsidian-sync-evo`.

1. In Settings → Community plugins, turn off **Restricted mode** if it is on. Press **Browse**, search for **BRAT**, then install and enable it.
2. In Settings → BRAT, press **Add beta plugin**, and enter `https://github.com/seking/obsidian-sync-evo`. Keep the latest version, and add it.
3. In Settings → Community plugins, turn on **Sync Evo**. BRAT keeps it up to date.

## Before you start

- **Use Git or Sync Evo on a device, not both.** Git on a computer and Sync Evo on a phone can share one repository. To move a device from Git to Sync Evo, see [Switching a device from Git to Sync Evo](faq.md#switching-a-device-from-git-to-sync-evo).
- **Support for a vault in iCloud Drive is experimental.** Do not sync the same iCloud vault with Sync Evo on two devices. Do not make it a git working tree on the Mac. [Details](icloud.md)

## GitHub

1. If you have no repository for the vault yet, create an empty private repository on GitHub. Do not add a README or any other file. The first upload fills it.
2. Open [this page to create a token](https://github.com/settings/personal-access-tokens/new?name=Sync+Evo&description=Obsidian+Sync+Evo&expires_in=90&contents=write). The name, the expiry and **Contents: Read and write** are filled in.
   - Under "Repository access", choose **Only select repositories** and pick the vault's repository. The link cannot choose it for you.
   - With submodules or files under `.github/workflows/`, the token needs more. See [Token permissions](settings.md#token-permissions).
3. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", fill in:
   - **Repository**: `owner/name`, or the address pasted from the browser.
   - **Branch**: the branch to sync with. For a new empty repository, enter `main` (or the default branch name GitHub shows): the first upload creates it. For an existing repository, Sync Evo does not create a branch.
   - **Token**: choose the secret that holds the token. If you have none yet, create a secret (named `Sync Evo`, for example) and paste the token as its value. It is kept in Obsidian's Keychain, not in the vault. See [The token](settings.md#the-token).
   - **Device name**: shown in commit messages and in the names of conflict files.
4. Press **Test** under "Connection test". It tells you whether the token reaches the repository and the branch.
5. Sync: tap the **Sync** icon (two circling arrows) in the ribbon, or run **Sync Evo: Sync** from the command palette.
   - The first download asks when files in the vault differ from the repository's.
   - The first upload shows what it will upload, and asks.

## Dropbox

1. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", set **Service** to **Dropbox**. Check **Folder** (the name of the vault, at first) and **Device name** (used in the names of conflict files).
2. Press **Connect**, sign in to Dropbox if asked, and press **Allow**. The browser sends you back to Obsidian.
3. Press **Test**, then run **Sync**, as in steps 4 and 5 for GitHub.

Sync Evo reaches only its own folder in your Dropbox, `Apps/Sync Evo/`. Files you delete stay in Dropbox's version history for a while. More: [Dropbox](dropbox.md).

## Next

- [What is not synced, and automatic sync](settings.md)
- [How syncing works](syncing.md)
