# Dropbox

Under "Connection" in the settings, **Service** chooses between GitHub and Dropbox.

## The folder

- Sync Evo reaches only its own folder in your Dropbox, `Apps/Sync Evo/`.
- The name of `Apps` follows the language of your Dropbox.
- Each vault is kept in a folder of its own there, named in the settings under **Folder**. At first, it is the name of the vault.

## Setting up

1. Set **Service** to **Dropbox**.
2. Check the name under **Folder**.
3. Check **Device name**. It is used in the names of conflict files.
4. Press **Connect** and allow in the browser.
5. Press **Test** under "Connection test", then run **Sync**.

## Connecting

- Connecting is done in the browser.
- Press **Connect**, sign in to Dropbox if asked, and press **Allow**. The browser sends you back to Obsidian.
- There is no token to copy.
- **Disconnect** tells Dropbox to forget the connection, and forgets it on the device.
- The account (its ID and e-mail address) stays in the settings. So connecting again to the same account does not start the sync over.

## How it differs from GitHub

**An upload is not a commit.**

- The files are sent together.
- Each file is sent only while Dropbox still holds the version this device last saw.
- A file another device changed first is not overwritten. A file another device changed is not deleted. The upload sends the rest and says so. The next download takes that file up as a conflict.
- An upload that is stopped after its files were sent leaves them on Dropbox. The next sync sends what is left.

**Deleted files** stay in the version history of Dropbox for a while (30 days on the free plan). They are not put into a trash of Sync Evo's.

**Automatic merging** finds what a file held at the last sync among its versions on Dropbox. When that version is gone, the file is kept twice instead, as a conflict file.

**Upper and lower case.** Dropbox does not tell them apart.

- Two files in the vault whose paths differ only in case are not uploaded.
- A rename on Dropbox that changes only case reaches the device only when the folder is listed in full again.

## Several devices

- Every device that syncs the vault has to connect to the same Dropbox account and name the same folder.
- Changing the service, the folder, or the account starts the sync over, as a first download does.
