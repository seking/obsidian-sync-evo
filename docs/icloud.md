# A vault in iCloud Drive

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/icloud.md)

A vault in iCloud Drive works, but support is experimental. It was checked on one iPhone, on Wi-Fi, with a small vault.

If you can choose, a vault under "On My iPhone" is the simpler setup.

## Before you rely on it

**The first sync reads every file.** This is also true of a sync after "Start over".

- iCloud brings back files it has taken off the device, for that read.
- So it needs the space and the connection for the whole vault.
- As long as even one file cannot be brought back, that sync does not finish, and nothing is uploaded.

**When GitHub can be reached and iCloud cannot**, a file that is off the device cannot be read. This happens, for example, when iCloud Drive is switched off for mobile data.

- Sync Evo leaves the file alone.
- It says so in the result of the sync.
- It tries again the next time.

**When iCloud finds two versions of a file**, it may keep both and name one `<name> 2.md`. Sync Evo sends that as a new file.

## Do not make the iCloud vault a git working tree on the Mac

With the vault in iCloud, the Mac and the iPhone share one folder.

- Git on the Mac does not know of what Sync Evo sends from the iPhone.
- Its next pull stops.
- If Sync Evo on the iPhone tells you that the vault has a `.git`, this is what happened.

## Do not sync the same iCloud vault on two devices

Do not sync the same iCloud vault with Sync Evo on two devices. iCloud already carries every change between them. Two syncs of the same change can leave duplicates.
