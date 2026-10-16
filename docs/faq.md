# FAQ

## How do I get back what a merged file held before?

Sync Evo keeps it in `.trash/.sync-evo-merged/` in the vault, as `<date> <name>.<extension>`. Obsidian does not show that folder. Use the file manager of the device to move the copy into a folder Obsidian shows. See [Getting a merged file's previous version back](syncing.md#getting-a-merged-files-previous-version-back).

## Where are conflict files?

In the folder `_conflicts/` at the root of the vault, as `<date> <name> (<device>).<extension>`. The notice of the sync names them. They are moved to `.trash/` after 30 days, unless you move them out of `_conflicts/` or rename them. See [Conflict files](syncing.md#conflict-files).

## Switching a device from Git to Sync Evo

Use Git (or the Obsidian Git plugin) or Sync Evo on a device, not both. Git does not learn of what Sync Evo sends, so its next pull on that device would stop. Other devices can keep using Git on the same repository.

To move a device to Sync Evo, for automatic sync on a phone for example:

1. With Git, commit and push everything on that device, then pull, so that it matches the repository.
2. Turn off the Obsidian Git plugin, or stop the Git app, on that device.
3. Set up Sync Evo and sync. Files that match the repository are taken as they are.

If the device was behind the repository, every file that changed since is kept twice on the first sync, with the device's version in `_conflicts/`. That is why step 1 matters.

While the vault still has a `.git` folder at its root, Sync Evo tells you once that it found it, and keeps syncing. Delete that folder when you no longer use Git on the device.

## Can I use a vault in iCloud Drive?

Yes, but support is experimental. Do not sync the same iCloud vault with Sync Evo on two devices. Do not make it a git working tree on the Mac. If you can choose, a vault under "On My iPhone" is simpler. See [A vault in iCloud Drive](icloud.md).

## What happens when I exclude something?

Nothing is deleted, on a device or on GitHub. What is excluded is neither uploaded nor downloaded, and a deletion on either side is not carried over. To remove excluded files from the repository, use "Remove from GitHub" in the settings. See [What happens when you exclude something](settings.md#what-happens-when-you-exclude-something).

## How do I report a bug?

Open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token, or a file name you would rather keep private, into a report.

<!-- TODO: My token expired. What do I do? -->
<!-- TODO: How do I go back to a previous version of Sync Evo? -->
<!-- TODO: How do I move from another sync plugin? -->
