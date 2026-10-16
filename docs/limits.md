# Limits

## Not supported yet

- **Changes inside a submodule.** What is inside a submodule is downloaded, and only read. See [Submodules](#submodules).
- **Git LFS.** A pointer file is synced as it is. The content it stands for is not downloaded.
- **Line ending conversion.** The `text` and `eol` settings of `.gitattributes` are not applied. Every file is stored and written byte for byte as the repository holds it.
- **Symbolic links.** See [Symbolic links](#symbolic-links).
- **Other services** than GitHub and Dropbox.
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

On Android, a rename made on another device that changes only upper and lower case (`tools/` to `Tools/`) is not applied.

- The download skips the path and says so.
- The upload holds the file back.
- Nothing is lost, but the path stays unsynced.
- The two notices come back on every sync.

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
