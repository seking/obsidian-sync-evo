# How syncing works

Sync Evo is made for large vaults and for phones:

- It needs no git on the device.
- It talks to the API of GitHub, Dropbox or Google Drive directly.
- It can pick up a first download of thousands of files where it was interrupted.

With GitHub, the remote is the repository. With Dropbox or Google Drive, it is the vault's folder there. What differs is in [Dropbox](dropbox.md) and [Google Drive](google-drive.md).

## Download, upload and sync

- **Download** brings the vault in line with the remote. It gets the files that are new or changed there, and deletes the ones that were deleted there.
- **Upload** sends what was added, changed and deleted in the vault. On GitHub, it is one commit.
- **Sync** does both: a download, then an upload. It is also the button in the ribbon.

## When it runs

Nothing runs on its own unless you switch it on. A sync happens when you press the button or run a command.

Under "How it syncs" in the settings, you can also let Sync Evo sync:

- when Obsidian starts, or comes back from another app,
- at an interval, while Obsidian is in the foreground.

An automatic sync behaves like this:

- It only downloads, unless you let it upload changes too.
- It says nothing when it went well.
- It never answers one of the [questions below](#when-sync-evo-stops-and-asks) for you. It changes nothing then, and tells you once to sync manually.
- It does not start the first download of a vault. You start that one yourself.
- It leaves a note you are typing in as it is. A later sync updates or sends that note, once you have stopped typing for 20 seconds.
- A sync you start while an automatic one is running takes its place.

The settings for this are in [How it syncs](settings.md#how-it-syncs).

## When a file changed on both sides

A file that was changed both in the vault and in the remote is not overwritten.

### Merging

With GitHub and Dropbox, such a file is merged when it can be. With Google Drive, it is not merged: it is kept twice, as a [conflict file](#conflict-files).

- The file gets the changes of both sides, line by line, under its own name.
- The notice of the sync names it.
- What the file held on the device before the merge is kept in `.trash/.sync-evo-merged/` in the vault.

The copy is named `<date> <name>.<extension>`:

- For `notes/a.md`, it is `.trash/.sync-evo-merged/2026-10-13 a.md`.
- A second one on the same day is `2026-10-13 a (1).md`.

The folder `.trash/.sync-evo-merged/`:

- is not synced,
- is not shown by Obsidian,
- is never deleted by Sync Evo. Delete it when you no longer need what is in it.

### Getting a merged file's previous version back

To read the copy or put it back, use the file manager of the device. Move the copy into a folder of the vault that Obsidian shows.

- **Mac**: in Finder, press `⌘⇧.` to show the folders whose names start with a dot.
- **Android**: in the file manager, choose "Show hidden files" in the menu.
- **iPhone and iPad**: the Files app does not list these folders. Its search finds the copy by the name of the note. Hold the result and choose "Move".

### Conflict files

A file is kept twice instead of merged:

- when both sides changed the same lines,
- when it is not text,
- when it is a `.canvas` or a `.base`,
- always, on a device where "On a conflict" (under "How it syncs" in the settings) is set to create a conflict file,
- always, with Google Drive.

Then:

- The remote's version keeps the name.
- The vault's version is kept as a conflict file in the folder `_conflicts/` at the root of the vault.
- The notice of the sync names both files.

A conflict file is named `<date> <name> (<device>).<extension>`:

- The conflict file of `notes/a.md` is `_conflicts/2026-10-12 a (iPhone).md`.
- A second one of the same note on the same day is `_conflicts/2026-10-12 a (iPhone) (1).md`.

Also:

- A conflict file is synced like any other file, whatever is excluded.
- A file in the configuration folder gets no conflict file. The vault's version goes to `.trash/` in the vault.

### Conflict files are tidied after 30 days

- A conflict file is kept for 30 days from the end of the day in its name.
- After that, a sync moves it to `.trash/` in the vault, and tells you how many it moved.
- The next upload deletes it in the remote. The other devices then remove it, as they remove any deleted file.
- To keep a conflict file, move it out of `_conflicts/` or rename it.

### Conflict files from 0.2.0 and earlier

Up to 0.2.0, a conflict file was made beside its file, as `<name>.conflict-from-<device>-<date>-<time>.<extension>`. Conflict files of that form:

- stay where they are,
- are synced as before,
- are never moved to `.trash/`.

## When Sync Evo stops and asks

Sync Evo stops and asks before it goes on when:

- a download or an upload would delete many files: more than 50, or more than 5 that are also more than a tenth of all files.
- an upload finds none of the files it synced before in the vault, however few they are. A vault whose folder was deleted and created again looks like this. Sync Evo can then download them again from the remote instead of deleting them there.
- the first download finds files in the vault that differ from the remote's.
- a device uploads for the first time.
- the history of the repository was rewritten (a force upload).

## Commands

| Command | What it does |
| --- | --- |
| Sync | A download, and then an upload. |
| Download changes from GitHub (or Dropbox, or Google Drive) | Only downloads from the remote. |
| Upload changes to GitHub (or Dropbox, or Google Drive) | Only uploads to the remote. |
| Start over (download everything from GitHub, Dropbox or Google Drive again) | Compares the vault with the remote again, as a first download does. No file is deleted. |
| Stop the sync | Stops a running sync. |

Upload:

- A file the remote changed since this device last downloaded is not overwritten. It is left for the next download.
- A device has to download once before its first upload.

Stop the sync:

- A stopped download continues from where it was.
- A stopped upload does not change the branch. What it had already uploaded is in no commit.
- With Google Drive, the files a stopped upload already sent stay there. The next sync sends the rest.
- With Dropbox, the files are made final together at the end of the upload. Only those already made final stay there. A stop before that leaves nothing on Dropbox. The next sync sends the rest.

On GitHub, an upload makes one commit. Its message is `Sync Evo: <device name> (<n> added, <n> modified, <n> deleted)`, with the changed paths below it.
