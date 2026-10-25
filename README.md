# Sync Evo

[![CI](https://github.com/seking/obsidian-sync-evo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seking/obsidian-sync-evo/actions/workflows/ci.yml)

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/README.ja.md)

Sync your vault across all your devices, through your own GitHub, Dropbox or Google Drive.

> [!NOTE]
> **Payment is required for full access, once the paid plan starts.** For now, all of Sync Evo is free. Syncing with Dropbox and Google Drive may become paid later, with a license key: $3 a month, $24 a year, or $49 once, one key for both. Any paid plan will be announced here and in the release notes before it starts, and even then, Dropbox and Google Drive stay free for 3 months from the day it starts, or from the day you start using them, if that is later. [Pricing](https://github.com/seking/obsidian-sync-evo#pricing)

It works on phones and computers alike, with no Git to install.

<!-- TODO: screenshot -->

## Why Sync Evo

**Your own storage.** Your notes go to your own GitHub repository, Dropbox or Google Drive, with no account with the developer and no server in between.

**Made for phones and large vaults.** A first download of thousands of files picks up where it stopped.

**Never overwrites your notes.** A note changed on two devices is merged or kept twice, and Sync Evo asks before it deletes many files.

**History on GitHub.** Each upload is a commit, so earlier versions of your notes stay in the repository's history.

**You choose what syncs.** Leave out folders (for all your devices or just this one), file types on this device, and parts of the vault's settings.

**Quiet automatic sync.** If you turn it on, Sync Evo syncs on startup and at an interval, and says nothing when all is well.

## How your notes are kept safe

- A note changed on two devices is merged, or kept twice, with the device's version in `_conflicts/`. Before a merge, the note as it was is kept in `.trash/`.
- Sync Evo stops and asks before it deletes many files, before a device's first upload, when the first download finds files that differ, and when the history on GitHub was rewritten.
- An upload does not write over a file that changed on the service since this device last downloaded. With Google Drive it rarely can, and the other version stays in Drive's version history.
- An interrupted download goes on from where it stopped. So does an upload to GitHub or Google Drive.

[How syncing works](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md)

## GitHub, Dropbox or Google Drive?

- **You have a GitHub account**: use GitHub.
- **You don't**: Dropbox, if your vault is up to 2 GB. It can merge a note changed on two devices. Google Drive, if it is larger. If you already use one of the two, that is fine too.

With Dropbox and Google Drive, you just sign in. There is no repository or token to make.

[Compare them](https://github.com/seking/obsidian-sync-evo/blob/main/docs/choosing-a-service.md)

## Pricing

- **GitHub**: free for now.
- **Dropbox and Google Drive**: free for now. They may become paid later: free for 3 months, and then a license key is needed. One key is for both: $3 a month, $24 a year, or $49 once. Keys are sold through Dodo Payments, which handles the payment and the tax.
- **Not started yet.** A paid plan, for any service, will be announced in this README and in the release notes before it starts. It starts with a later version of Sync Evo.

How it works, once it has started:

- The 3 months are counted for each Dropbox or Google account, from the day the paid plan starts, or from the first sync with the account, if that is later. No one's 3 months begin before the paid plan starts.
- A device that first runs a Sync Evo with the paid plan when those 3 months are over, or nearly, is still free for 14 days from that day, so that you are told before it ends.
- Once 14 days are left before your free time ends, and again once 7 days are left, Sync Evo tells you at the next sync.
- After it ends, Sync Evo only downloads for 30 days, and uploads nothing. Then it stops syncing with Dropbox or Google Drive. Nothing is deleted, on your devices or in your Dropbox or Google Drive.
- Enter the key in the Sync Evo settings, on each device. Sync Evo checks it with Dodo Payments. When Dodo cannot be reached, a key that was valid keeps working for 14 days.

[Terms of service](https://gyap.jp/sync-evo/terms), including refunds.

## Get started

### Install

Sync Evo is not in the community plugin directory yet. Install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. In Settings → Community plugins, turn off **Restricted mode** if it is on. Press **Browse**, search for **BRAT**, then install and enable it.
2. In Settings → BRAT, press **Add beta plugin**, and enter `https://github.com/seking/obsidian-sync-evo`. Keep the latest version, and add it.
3. In Settings → Community plugins, turn on **Sync Evo**. BRAT keeps it up to date.

### GitHub

1. If you have no repository for the vault, [create an empty private one](https://github.com/new) on GitHub. No [GitHub account](https://github.com/signup) yet? Create one first, for free.
2. [Create a token](https://github.com/settings/personal-access-tokens/new?name=Sync+Evo&description=Obsidian+Sync+Evo&expires_in=90&contents=write), and choose the vault's repository on that page.
3. In Settings → Community plugins → Sync Evo, enter the repository and the branch, and save the token as a secret.
4. Press **Test**. Then sync: tap the two circling arrows (**Sync**) in the ribbon, the strip of icons at the edge of the screen, or run **Sync Evo: Sync** from the command palette.

### Dropbox

Free for now. It may later need a license key, after 3 months free. See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

1. No Dropbox account yet? [Create one](https://www.dropbox.com/register), for free.
2. In Settings → Community plugins → Sync Evo, set **Service** to **Dropbox**.
3. Press **Connect**, and allow Sync Evo in the browser.
4. Press **Test**, then sync as in step 4 for GitHub.

### Google Drive

Google Drive needs Sync Evo 0.5.0 or later, which is not released yet. To try it now, install the beta with BRAT.

Free for now. It may later need a license key, after 3 months free. See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

1. In Settings → Community plugins → Sync Evo, set **Service** to **Google Drive**.
2. Press **Connect**. Sync Evo shows a code and copies it.
3. Press **Open the browser**. It opens `google.com/device`, and copies the code again.
4. Paste the code, choose your Google account, and allow Sync Evo. Then come back to Obsidian. The settings show the account it is connected to.
5. Press **Test**, then sync as in step 4 for GitHub.

Sync Evo sees only the files it made in your Google Drive. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/google-drive.md)

[Step-by-step guide](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)

## Good to know

- Already syncing with Git? Use Git or Sync Evo on a device, not both. Git on a computer and Sync Evo on a phone can share one repository. [Switching from Git](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md#switching-a-device-from-git-to-sync-evo)
- A vault in iCloud Drive works, but support is experimental. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- Syncing "Installed community plugins" runs plugin code from your other devices. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#installed-community-plugins)
- If you sync the "Active community plugin list", keep Sync Evo enabled on every device. [Why](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#active-community-plugin-list)
- To go back to an earlier version of Sync Evo, first finish a sync on that device. [How](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md#how-do-i-go-back-to-an-earlier-version-of-sync-evo)

## Network and privacy

Sync Evo connects only to GitHub (`api.github.com`, `codeload.github.com`), Dropbox (`api.dropboxapi.com`, `content.dropboxapi.com`, `www.dropbox.com`) or Google (`oauth2.googleapis.com`, `www.googleapis.com`), to sync your vault. To connect to Google Drive, it opens `google.com/device` in the browser. It does so only when you sync, when you have turned on automatic sync, or when you connect. Once the paid plan has started, with Dropbox or Google Drive it also connects to Dodo Payments (`live.dodopayments.com`) to check the license key you entered: it sends the key and the device name, and nothing from the vault. It sends nothing anywhere else, collects no usage data and has no server of the developer's. A GitHub, Dropbox or Google account is required. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md), [Privacy policy](https://gyap.jp/sync-evo/privacy)

## Learn more

- [Setting up, step by step](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)
- [GitHub, Dropbox or Google Drive?](https://github.com/seking/obsidian-sync-evo/blob/main/docs/choosing-a-service.md)
- [How syncing works](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md), and its [commands](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md#commands)
- [Settings](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md)
- [Dropbox](https://github.com/seking/obsidian-sync-evo/blob/main/docs/dropbox.md)
- [Google Drive](https://github.com/seking/obsidian-sync-evo/blob/main/docs/google-drive.md)
- [A vault in iCloud Drive](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- [Limits, what is not supported yet, and where it was tested](https://github.com/seking/obsidian-sync-evo/blob/main/docs/limits.md)
- [Network use and privacy](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)
- [FAQ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md)
- [All documentation](https://github.com/seking/obsidian-sync-evo/blob/main/docs/README.md)

## Help

See the [FAQ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md), or open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Without a GitHub account, write to contact@gyap.jp. Do not put a token or a private file name into a report. To report a security problem privately, see [SECURITY.md](https://github.com/seking/obsidian-sync-evo/blob/main/SECURITY.md).

## License

Copyright (C) 2026 seking. Sync Evo has two parts, under two licenses. Both come with no warranty.

- **The sync itself and GitHub**: open source, under [AGPL-3.0-only](https://github.com/seking/obsidian-sync-evo/blob/main/LICENSE-AGPL).
- **Dropbox and Google Drive** (the folder `pro/`, with the license key check): source-available, under the [Elastic License 2.0](https://github.com/seking/obsidian-sync-evo/blob/main/pro/LICENSE). You may use, change and share it, but not change, remove or get around the license key check, not remove its notices, and not offer it to others as a hosted service.

[LICENSE](https://github.com/seking/obsidian-sync-evo/blob/main/LICENSE) says which files are under which license.

Third-party licences: [see this page](https://github.com/seking/obsidian-sync-evo/blob/main/docs/third-party-licences.md).

To build Sync Evo or help with it, see [CONTRIBUTING.md](https://github.com/seking/obsidian-sync-evo/blob/main/CONTRIBUTING.md).
