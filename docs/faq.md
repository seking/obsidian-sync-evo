# FAQ

## How do I get back what a merged file held before?

Sync Evo keeps it in `.trash/.sync-evo-merged/` in the vault, as `<date> <name>.<extension>`. Obsidian does not show that folder. Use the file manager of the device to move the copy into a folder Obsidian shows. See [Getting a merged file's previous version back](syncing.md#getting-a-merged-files-previous-version-back).

## Where are conflict files?

In the folder `_conflicts/` at the root of the vault, as `<date> <name> (<device>).<extension>`. The notice of the sync names them. They are moved to `.trash/` after 30 days, unless you move them out of `_conflicts/` or rename them. See [Conflict files](syncing.md#conflict-files).

## My vault has a .git folder

On a device where the vault has a `.git` at its root, sync with git or with the Obsidian Git plugin. Git does not learn of what Sync Evo sends, and its next pull would stop. Sync Evo is for the devices that have no git.

## Can I use a vault in iCloud Drive?

Yes, but support is experimental. Do not sync the same iCloud vault with Sync Evo on two devices. Do not make it a git working tree on the Mac. If you can choose, a vault under "On My iPhone" is simpler. See [A vault in iCloud Drive](icloud.md).

## What happens when I exclude something?

Nothing is deleted, on a device or on GitHub. What is excluded is neither uploaded nor downloaded, and a deletion on either side is not carried over. To remove excluded files from the repository, use "Remove from GitHub" in the settings. See [What happens when you exclude something](settings.md#what-happens-when-you-exclude-something).

## How do I report a bug?

Open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token, or a file name you would rather keep private, into a report.

<!-- TODO: My token expired. What do I do? -->
<!-- TODO: How do I go back to a previous version of Sync Evo? -->
<!-- TODO: How do I move from another sync plugin? -->
