# Sync Evo and other ways to sync

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/compared.md)

There are many good ways to sync a vault. This page explains how Sync Evo differs from the common ones, and when another one fits you better. The details about the other tools were checked against their own pages in October 2026, and may have changed since.

## Side by side

| | Sync Evo | Obsidian Sync | Obsidian Git | Remotely Save | Self-hosted LiveSync | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| Where your notes are kept | Your GitHub, Dropbox or Google Drive | Obsidian's servers | Your Git repository | Your S3, Dropbox, OneDrive, WebDAV and more | Your own CouchDB, or S3-compatible storage | Your GitHub |
| What a device needs | Nothing but the plugin | Nothing but an Obsidian account | Git, on a computer | Nothing but the plugin | Nothing but the plugin, once the server is set up | Nothing but the plugin |
| Works on phones | Yes | Yes | Its README calls mobile very unstable, and does not recommend it | Yes | Yes | Yes |
| A note changed on two devices | Merged, or both versions kept (Google Drive: both versions kept) | Notes are merged. For other files, the newer one wins | Merged by Git. A conflict is solved by hand | The newer or the larger, as you choose. Merging small notes, or keeping both, is a paid feature | Merged, or you choose | Both versions kept, the other one in `_fit/` |
| End-to-end encryption | No | Yes | No | Optional | Optional | No |
| Cost | See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing) | From $4 a month, billed yearly | Free | Free, with a paid plan for some services and features | Free, plus the cost of the server | Free |

## When another one fits you better

- **You want your notes encrypted end to end**: Obsidian Sync, Remotely Save, or Self-hosted LiveSync. Sync Evo does not encrypt: your notes are as readable in your GitHub, Dropbox or Google Drive as any other file there.
- **You want a change to show up on another device within seconds**: Obsidian Sync or Self-hosted LiveSync. Sync Evo syncs when you tell it to, and, if you turn it on, at startup and every few minutes.
- **You want official support from the makers of Obsidian, with no setup**: Obsidian Sync.
- **You want your notes in S3, OneDrive or WebDAV**: Remotely Save. Sync Evo works only with GitHub, Dropbox and Google Drive.
- **You use only computers, and know Git**: Obsidian Git, or Git itself. You get all of Git: branches, your own commit messages, any host. Sync Evo can work on the same repository from your phone (see [Switching a device from Git to Sync Evo](faq.md#switching-a-device-from-git-to-sync-evo)).
- **Your devices are all on one network, or all Apple**: Syncthing, or iCloud Drive, may be all you need.
- **Your vault already syncs well the way it does**: keep it.

## When Sync Evo may fit you

- **You want your phone to sync with GitHub, with no Git to install.** Sync Evo talks to GitHub's API. There is no repository on the device to clone, grow or break.
- **Your vault is large.** A first download of thousands of files picks up where it left off. With GitHub, a repository of up to 100,000 files can be synced. Files up to 38 MB are synced. See [Limits](limits.md).
- **You do not want a sync to overwrite a note.** A note changed on two devices is merged, or both versions are kept, and Sync Evo stops and asks before it deletes many files. See [How your notes are kept safe](https://github.com/seking/obsidian-sync-evo#how-your-notes-are-kept-safe).
- **You'd rather sign in than set things up.** With Dropbox and Google Drive, there is no repository, token or server to make.
- **You want a history of every change.** With GitHub, each upload is a commit.

## Moving from another method

Use only one sync method for a vault on a device. Two at once can upload each other's changes as conflicts, or bring back what one of them deleted.

1. With the method you have been using, sync every device one last time, so they all match.
2. Turn it off on each device: Obsidian Sync in Settings → Sync, a plugin in Settings → Community plugins, or an app outside Obsidian.
3. On the first device, set up Sync Evo and sync. The repository or folder of a new setup is empty, so everything is uploaded. Sync Evo asks first only if it is a public GitHub repository.
4. On each other device, set up Sync Evo and sync. A file that matches what the first device uploaded is taken as it is. If some differ, Sync Evo asks first, and then keeps both versions, with the device's version in `_conflicts/` (or in `.trash/`, for a file in the vault's config folder).

From Git, see [Switching a device from Git to Sync Evo](faq.md#switching-a-device-from-git-to-sync-evo).
