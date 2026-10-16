# GitHub or Dropbox?

**No GitHub account? Use Dropbox.** A free Dropbox account is enough. You sign in, and there is no repository or token to make.

**Use GitHub** when you already have an account, when you use Git on a computer, or when you want every change kept for good.

## Side by side

| | GitHub | Dropbox |
| --- | --- | --- |
| Setting up | Create a repository and a token, and enter both | Press **Connect** and allow Sync Evo |
| Later upkeep | A token expires (after 90 days with the link in the README). Create a new one then | None, unless the connection is removed on Dropbox. Then connect again |
| Free space | Private repositories are free. GitHub recommends keeping one under 1 GB, and it grows with the history | 2 GB on the free plan |
| History | Each upload is a commit. Every earlier version stays in the history | Earlier versions and deleted files stay in Dropbox's version history for a while (30 days on the free plan) |
| Merging a note changed on two devices | Always possible | Possible while Dropbox still holds the version from the last sync, among the latest 100 versions. Otherwise both versions are kept |
| Names that differ only in upper and lower case | Synced | Not uploaded, since Dropbox does not tell them apart |
| First download of a large vault on Android | Over about 5,000 files, it waits for GitHub's hourly limit and can take over an hour | No hourly limit like GitHub's. Sync Evo waits only when Dropbox asks it to. Not yet tried with a large vault |
| Git on a computer | Works on the same repository | Not available |
| Tested on | iPhone and Mac. Basic syncs on Android, iPad and Windows. Not on Linux | Android and iPhone. Not yet on a computer |

Both have the same file size limit (38 MB). Neither needs the GitHub or Dropbox app on the device.

## Who should pick which

- **You have no GitHub account, and your vault is under 2 GB**: Dropbox.
- **You use Git on a computer, or want a full history of your notes**: GitHub.
- **Your vault is over 2 GB**: a paid Dropbox plan, or GitHub if the vault is mostly notes (GitHub recommends under 1 GB, history included).

You can switch later. Changing the service starts the sync over, as a first download does. No file in the vault is deleted. A file that differs from the new service's copy is replaced by it, and the vault's version is kept as a conflict file.

More: [Dropbox](dropbox.md), [Limits](limits.md).
