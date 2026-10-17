# GitHub, Dropbox or Google Drive?

**No GitHub account? Use Dropbox or Google Drive.** A free account is enough. You sign in, and there is no repository or token to make.

**Use GitHub** when you already have an account, when you use Git on a computer, or when you want every change kept for good.

## Side by side

| | GitHub | Dropbox | Google Drive |
| --- | --- | --- | --- |
| Setting up | Create a repository and a token, and enter both | Press **Connect** and allow Sync Evo | Press **Connect**, paste the code in the browser, and allow Sync Evo |
| Later upkeep | A token expires (after 90 days with the link in the README). Create a new one then | None, unless the connection is removed on Dropbox. Then connect again | None, unless the connection is removed in the Google Account, or more than 100 connections of the account end the oldest. Then connect again |
| Free space | Private repositories are free. GitHub recommends keeping one under 1 GB, and it grows with the history | 2 GB on the free plan | 15 GB on a free Google account, shared with Gmail and Google Photos |
| History | Each upload is a commit. Every earlier version stays in the history | Earlier versions and deleted files stay in Dropbox's version history for a while (30 days on the free plan) | Files Sync Evo deletes go to Drive's trash, for 30 days. A version written over stays in the file's version history on Drive |
| Merging a note changed on two devices | Always possible | Possible while Dropbox still holds the version from the last sync, among the latest 100 versions. Otherwise both versions are kept | Not done. Both versions are kept |
| Files added outside Sync Evo | Synced (pushed with Git, for one) | Not yet tried | Not seen: Sync Evo sees only the files it made |
| First download of a large vault on Android | Over about 5,000 files, it waits for GitHub's hourly limit and can take over an hour | No hourly limit like GitHub's. Sync Evo waits only when Dropbox asks it to. Not yet tried with a large vault | No hourly limit like GitHub's. Sync Evo waits only when Google asks it to. Not yet tried with a large vault |
| Git on a computer | Works on the same repository | Not available | Not available |
| Tested on | iPhone and Mac. Basic syncs on Android, iPad and Windows. Not on Linux | Android and iPhone. Not yet on a computer | Android. Not yet on an iPhone or a computer |

All three have the same file size limit (38 MB). None needs the GitHub, Dropbox or Google Drive app on the device. With none of them does Sync Evo sync two paths that differ only in upper and lower case.

Google Drive needs Sync Evo 0.5.0 or later, which is not released yet. To try it now, install the beta with BRAT.

## Who should pick which

- **You have no GitHub account**: Dropbox or Google Drive. Dropbox, if you want a note changed on two devices merged. Google Drive, if your vault is over 2 GB, or you would rather use the Google account you have.
- **You use Git on a computer, or want a full history of your notes**: GitHub.
- **Your vault is over 2 GB**: Google Drive (up to what your Google account has free), a paid Dropbox plan, or GitHub if the vault is mostly notes (GitHub recommends under 1 GB, history included).

You can switch later. Changing the service starts the sync over, as a first download does. No file in the vault is deleted. A file that differs from the new service's copy is replaced by it, and the vault's version is kept as a conflict file.

More: [Dropbox](dropbox.md), [Google Drive](google-drive.md), [Limits](limits.md).
