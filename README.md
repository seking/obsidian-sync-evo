# Sync Evo

Sync your vault across all your devices — free, through your own GitHub or Dropbox.

It works on phones and computers alike, with no Git to install.

<!-- TODO: screenshot -->

## Why Sync Evo

**Free, with your own storage.** Your notes go to your own GitHub repository or Dropbox, with no account with the developer and no server in between.

**Made for phones and large vaults.** A first download of thousands of files picks up where it stopped.

**Never overwrites your notes.** A note changed on two devices is merged or kept twice, and Sync Evo asks before it deletes many files.

**History on GitHub.** Each upload is a commit, so earlier versions of your notes stay in the repository's history.

**You choose what syncs.** Leave out folders (for all your devices or just this one), file types on this device, and parts of the vault's settings.

**Quiet automatic sync.** If you turn it on, Sync Evo syncs on startup and at an interval, and says nothing when all is well.

## GitHub or Dropbox?

- **No GitHub account? Use Dropbox.** A [free Dropbox account](https://www.dropbox.com/register) is enough. You sign in, and there is no repository or token to make.
- **Use GitHub** if you already have an account, use Git on a computer, or want every change kept.

[Compare them](https://github.com/seking/obsidian-sync-evo/blob/main/docs/github-or-dropbox.md)

## Get started

Not in the community plugin directory yet: install with [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `seking/obsidian-sync-evo`.

### GitHub

1. If you have no repository for the vault, [create an empty private one](https://github.com/new) on GitHub. No [GitHub account](https://github.com/signup) yet? Create one first, for free.
2. [Create a token](https://github.com/settings/personal-access-tokens/new?name=Sync+Evo&description=Obsidian+Sync+Evo&expires_in=90&contents=write), and choose the vault's repository on that page.
3. In Settings → Community plugins → Sync Evo, enter the repository and the branch, and save the token as a secret.
4. Press **Test**, then **Sync**.

### Dropbox

1. No Dropbox account yet? [Create one](https://www.dropbox.com/register), for free.
2. In Settings → Community plugins → Sync Evo, set **Service** to **Dropbox**.
3. Press **Connect**, and allow Sync Evo in the browser.
4. Press **Test**, then **Sync**.

[Step-by-step guide](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)

## Good to know

- If the vault has a `.git` folder, sync that device with git instead. [Why](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md#my-vault-has-a-git-folder)
- A vault in iCloud Drive works, but support is experimental. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- Syncing "Installed community plugins" runs plugin code from your other devices. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#installed-community-plugins)
- If you sync the "Active community plugin list", keep Sync Evo enabled on every device. [Why](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#active-community-plugin-list)

## Network and privacy

Sync Evo connects only to GitHub (`api.github.com`, `codeload.github.com`) or Dropbox (`api.dropboxapi.com`, `content.dropboxapi.com`, `www.dropbox.com`), to sync your vault. It does so only when you sync, or when you have turned on automatic sync. It sends nothing anywhere else, collects no usage data and has no server of the developer's. A GitHub or Dropbox account is required. [Details](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)

## Learn more

- [Setting up, step by step](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)
- [GitHub or Dropbox?](https://github.com/seking/obsidian-sync-evo/blob/main/docs/github-or-dropbox.md)
- [How syncing works](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md), and its [commands](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md#commands)
- [Settings](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md)
- [Dropbox](https://github.com/seking/obsidian-sync-evo/blob/main/docs/dropbox.md)
- [A vault in iCloud Drive](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- [Limits, what is not supported yet, and where it was tested](https://github.com/seking/obsidian-sync-evo/blob/main/docs/limits.md)
- [Network use and privacy](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)
- [FAQ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md)
- [All documentation](https://github.com/seking/obsidian-sync-evo/blob/main/docs/README.md)

## Help

See the [FAQ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md), or open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token or a private file name into a report.

## License

Copyright (C) 2026 seking. Licensed under [AGPL-3.0-only](https://github.com/seking/obsidian-sync-evo/blob/main/LICENSE), with no warranty.

Third-party licences: [see this page](https://github.com/seking/obsidian-sync-evo/blob/main/docs/third-party-licences.md).

To build Sync Evo or help with it, see [CONTRIBUTING.md](https://github.com/seking/obsidian-sync-evo/blob/main/CONTRIBUTING.md).
