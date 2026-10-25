# Limits

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/limits.md)

## Not supported yet

- **Changes inside a submodule.** What is inside a submodule is downloaded, and only read. See [Submodules](#submodules).
- **Git LFS.** A pointer file is synced as it is. The content it stands for is not downloaded.
- **Line ending conversion.** The `text` and `eol` settings of `.gitattributes` are not applied. Every file is stored and written byte for byte as the repository holds it.
- **Symbolic links.** See [Symbolic links](#symbolic-links).
- **Other services** than GitHub, Dropbox and Google Drive.
- **Merging with Google Drive.** A file changed on two devices is kept twice. See [Google Drive](google-drive.md#how-it-differs-from-github-and-dropbox).
- **Files over 38 MB**, and repositories with more than 100,000 files. See [Sizes](#sizes).

## Sizes

- A file over 38 MB is not synced.
- A repository with more than 100,000 files cannot be synced.
- A repository whose listing is over 7 MB cannot be synced.

## `.gitignore` in subfolders

`.gitignore` files in subfolders are synced as ordinary files. They are not read as rules. Only the one at the root counts.

## Symbolic links

- A link in the repository is not written to the device. It is left as it is in the repository.
- The settings list them.
- On a desktop, a link in the vault (or a junction, on Windows) is not synced, and neither is anything behind it. Nothing is uploaded from it. A download writes and deletes nothing there, also when the link points outside the vault.
- The first sync that finds one says so.

## Submodules

What is inside a submodule is downloaded into its folder, at the commit the repository of the vault points to. It is downloaded again when that commit moves. On the device, it is an ordinary folder.

**It is only read.**

- A file you change, add or delete inside a submodule on the device is not uploaded.
- The change stays on that device, and Sync Evo tells you once which files.
- Make such changes with git on a computer.
- When the same file later changes in the submodule, your version is kept as a conflict file in `_conflicts/`. It is not merged.

**What it needs.**

- The submodule has to point to a repository on GitHub that the token can read. See [Token permissions](settings.md#token-permissions).
- It has to be listed in the `.gitmodules` at the root of the repository of the vault.
- URLs of the forms `https://github.com/owner/name`, `git@github.com:owner/name` and `../name` are read.

**When it cannot be downloaded**, what the device already has in its folder is left as it is, and Sync Evo tells you once why. This happens when:

- the token cannot read that repository,
- the commit was not pushed there yet,
- it points to another host,
- it is a submodule inside a submodule.

A submodule that is excluded, such as one in an excluded folder, is not downloaded.

## Android

### Renames that change only case

Obsidian on Android refuses a rename that changes only upper and lower case (`tools/` to `Tools/`). Sync Evo then makes it in two steps, through a name with `.sync-evo-renaming` at the end: `tools` → `Tools.sync-evo-renaming` → `Tools`.

The rename goes through. For a folder, though, Obsidian may also show it under its old spelling in the file list (`tools/` next to `Tools/`) until Obsidian is restarted. Sync Evo tells you so after the sync that renamed it.

- Do not delete the one with the old spelling. Both are the same folder, so that deletes the real folder, with everything in it.
- Restarting Obsidian makes the old spelling go away.
- Uploads are not affected.
- The cause is in Obsidian on Android: after the rename, it goes on reporting writes in the folder under the old name as well. Sync Evo cannot prevent it.

**How the two steps work.**

- A name with `.sync-evo-renaming` at the end is never synced.
- If a sync stops between the two steps, the next sync gives the name back, and goes on with the rename.
- Sync Evo writes nothing down between the two steps, so it tells the names it put there by what the remote and the last sync have: a file is given back where they have a file at the name without `.sync-evo-renaming`, and a folder where they have files in a folder of that name. Names one inside the other are given back too.
- Any other name with `.sync-evo-renaming` at the end is left as it is: not synced, and nothing is said about it. That is a file or folder you named so yourself, such as a file `Notes.sync-evo-renaming` next to a folder `Notes/`. It is also one Sync Evo left between the two steps that had not been synced before, once its name is deleted from the remote.
- A file or folder you name yourself by putting `.sync-evo-renaming` after a name the remote has (a file `Notes.md.sync-evo-renaming` where the remote has `Notes.md`) cannot be told from one Sync Evo put there, and the next sync tries to give it that name.
- If something else has taken the name in the meantime, the file or folder keeps the name with `.sync-evo-renaming`, and Sync Evo tells you once. Until it is given back, nothing is downloaded to the name or deleted there, and the sync is not complete. Move or rename what has the name, and the next sync gives it back.
- A file you changed while it had the name with `.sync-evo-renaming` may then be kept twice: the remote's version keeps the name, and yours is kept as a conflict file in `_conflicts/`.

### Downloads one file at a time

On Android, files are always downloaded one at a time. The zip of the whole commit is not used there, because Obsidian's request function runs out of memory on a large response.

So the first download of a vault of more than about 5,000 files runs into GitHub's hourly request limit:

- A sync started by hand waits for the limit to lift, and takes over an hour.
- A sync that started by itself stops there, and a later one goes on.

Files of 2 MB and more are downloaded with the WebView's `fetch`, which does not go through the part that runs out of memory.

## Tested on

- iPhone (iOS) and Mac (macOS).
- The basic sync was also tried on one Android phone (a Pixel 6a), one iPad, and one Windows 11 PC.
- It has not been tried on Linux.
- Dropbox was tried on one Android phone and one iPhone, and not yet on a desktop.
- Google Drive was tried on one Android phone (a Pixel 6a) and one iPhone, and not yet on a desktop.
