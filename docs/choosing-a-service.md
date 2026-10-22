# GitHub, Dropbox or Google Drive?

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/choosing-a-service.md)

## Which to pick

- **You have a GitHub account, use Git on a computer, or want a full history of your notes**: GitHub.
- **None of these**: Dropbox, if your vault is up to 2 GB. It can merge a note changed on two devices. Google Drive, if it is larger (up to what your Google account has free).
- **You already use Dropbox or Google Drive**: that is fine too. A paid Dropbox plan holds more than 2 GB.

With Dropbox and Google Drive, you just sign in. There is no repository or token to make. For the cost, see [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

## Side by side

| | GitHub | Dropbox | Google Drive |
| --- | --- | --- | --- |
| Price of Sync Evo | Free | Free for 3 months, then a license key ($3 a month, $24 a year, or $49 once, one key for both) | The same as Dropbox |
| Setting up | Create a repository and a token, and enter both | Press **Connect** and allow Sync Evo | Press **Connect**, then **Open the browser**, paste the code, and allow Sync Evo |
| Later upkeep | A token expires (after 90 days with the link in the README). Create a new one then | None, unless the connection is removed on Dropbox. Then connect again | None, unless the connection is removed in the Google Account, or more than 100 connections of the account end the oldest. Then connect again |
| Free space | Private repositories are free. GitHub recommends keeping one under 1 GB, and it grows with the history | 2 GB on the free plan | 15 GB on a free Google account, shared with Gmail and Google Photos |
| History | Each upload is a commit. Every earlier version stays in the history | Earlier versions and deleted files stay in Dropbox's version history for a while (30 days on the free plan) | Files Sync Evo deletes go to Drive's trash, for 30 days. A version written over stays in the file's version history on Drive |
| Merging a note changed on two devices | Always possible | Possible while Dropbox still holds the version from the last sync, among the latest 100 versions. Otherwise both versions are kept | Not done. Both versions are kept |
| Files added outside Sync Evo | Synced (pushed with Git, for one) | Not yet tried | Not seen: Sync Evo sees only the files it made |
| First download of a large vault on Android | Over about 5,000 files, it waits for GitHub's hourly limit and can take over an hour | No hourly limit like GitHub's. Sync Evo waits only when Dropbox asks it to. Not yet tried with a large vault | No hourly limit like GitHub's. Sync Evo waits only when Google asks it to. Not yet tried with a large vault |
| Git on a computer | Works on the same repository | Not available | Not available |
| Tested on | iPhone and Mac. Basic syncs on Android, iPad and Windows. Not on Linux | Android and iPhone. Not yet on a computer | Android. Not yet on an iPhone or a computer |

All three have the same file size limit (38 MB). None needs the GitHub, Dropbox or Google Drive app on the device. With none of them does Sync Evo sync two paths that differ only in upper and lower case.

Google Drive needs Sync Evo 0.5.0 or later.

You can switch later. Changing the service starts the sync over, as a first download does. No file in the vault is deleted. A file that differs from the new service's copy is replaced by it, and the vault's version is kept as a conflict file.

More: [Dropbox](dropbox.md), [Google Drive](google-drive.md), [Limits](limits.md).
