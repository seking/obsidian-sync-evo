# Setting up

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/setup.md)

## What you need

- Obsidian 1.11.4 or later.
- A GitHub account and a repository, a Dropbox account, or a Google account. Google Drive needs Sync Evo 0.5.0 or later, which is not released yet. To try it now, install the beta with BRAT.
- No account with the developer.
- Sync Evo is free for now, with every service. With Dropbox or Google Drive, it may become paid later, after 3 months free, and that will be announced before it starts. See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

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
5. Sync: tap the two circling arrows (**Sync**) in the ribbon, the strip of icons at the edge of the screen, or run **Sync Evo: Sync** from the command palette.
   - The first download asks when files in the vault differ from the repository's.
   - The first upload shows what it will upload, and asks.

## Dropbox

1. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", set **Service** to **Dropbox**. Check **Folder** (the name of the vault, at first) and **Device name** (used in the names of conflict files).
2. Press **Connect**, sign in to Dropbox if asked, and press **Allow**. The browser sends you back to Obsidian.
3. Press **Test**, then run **Sync**, as in steps 4 and 5 for GitHub.

Sync Evo reaches only its own folder in your Dropbox, `Apps/Sync Evo/`. Files you delete stay in Dropbox's version history for a while. More: [Dropbox](dropbox.md).

## Google Drive

1. In Obsidian, open Settings → Community plugins → Sync Evo. Under "Connection", set **Service** to **Google Drive**. Check **Folder** (the name of the vault, at first) and **Device name** (used in the names of conflict files).
2. Press **Connect**. Sync Evo shows a code in a window, and copies it. Press **Open the browser** in the window: it opens `google.com/device` in the browser, and copies the code again.
3. In the browser, paste the code, choose your Google account, and allow Sync Evo. Then come back to Obsidian. The window of the code closes by itself, and the settings show the account it is connected to.
4. Press **Test**, then run **Sync**, as in steps 4 and 5 for GitHub.

On every device, connect to the same Google account and name the same folder. Sync Evo keeps the vault in `Sync Evo/<folder>` in My Drive, and sees only the files it made there. Files it deletes go to Drive's trash. More: [Google Drive](google-drive.md).

## Next

- [What is not synced, and automatic sync](settings.md)
- [How syncing works](syncing.md)
