# Google Drive

Under "Connection" in the settings, **Service** chooses between GitHub, Dropbox and Google Drive. Google Drive needs Sync Evo 0.5.0 or later, which is not released yet. To try it now, install the beta with BRAT.

## The folder

- Sync Evo keeps each vault in a folder of its own in your Google Drive, `Sync Evo/<folder>`, at the top of **My Drive**.
- The name of that folder is set in the settings under **Folder**. At first, it is the name of the vault.
- Sync Evo makes the folders with the first upload.

## Setting up

1. Set **Service** to **Google Drive**.
2. Check the name under **Folder**.
3. Check **Device name**. It is used in the names of conflict files.
4. Press **Connect**, and allow Sync Evo in the browser. See [Connecting](#connecting).
5. Press **Test** under "Connection test", then run **Sync**.

## Connecting

Google does not send the browser back to Obsidian. You enter a code instead.

1. Press **Connect**. Sync Evo shows a code in a window, copies it, and opens `google.com/device` in the browser.
2. Paste the code there, choose your Google account, and allow Sync Evo.
3. Come back to Obsidian. The window closes by itself, and the settings show the account it is connected to.

Also:

- If the browser did not open, press **Open the browser** in the window. It copies the code too. **Copy the code** copies it again.
- Closing the window stops the wait. The code runs out after a while. Then press **Connect** again.
- There is no token to copy, and nothing to set up in Google Cloud.

## Several devices

- Every device that syncs the vault has to connect to the same Google account and name the same folder.
- The name of the folder tells upper and lower case apart. `Notes` and `notes` are two folders.
- Changing the service, the folder, or the account starts the sync over, as a first download does.
- Renaming the folder on Google Drive (on the web, say) does not stop the sync. Sync Evo follows the folder, not its name. The settings keep the name they had.
- A device you set up after that looks for the folder by the name in its settings, and makes a new one. So after a rename, either rename the folder back on Google Drive, or give every device the new name under **Folder** (which starts the sync over).

## What Sync Evo can see

Sync Evo asks Google only for the files it made itself (the `drive.file` permission). It sees nothing else in your Google Drive.

- Sync your vault with Sync Evo on every device.
- A file you put into the folder yourself, on the Google Drive website or with Google Drive for desktop, is not seen. It is not synced.
- A change to a file Sync Evo made may reach your devices when it is made on the Google Drive website. But an app that saves by making the file anew (Google Drive for desktop, for one) leaves a new file Sync Evo cannot see. The old one then reaches your devices as deleted.
- So do not edit the vault's files on Google Drive. Edit them in Obsidian.
- A folder already in your Google Drive cannot be synced. Sync Evo makes its own.

## Deleting

- When Sync Evo deletes a file on Google Drive, it puts the file in Drive's trash. Google deletes it there for good after 30 days.
- A file you put in the trash on Google Drive is deleted on your devices at the next download.
- So is a file you move out of the folder of the vault.
- When many files would be deleted, Sync Evo asks first, as it does with every service. See [When Sync Evo stops and asks](syncing.md#when-sync-evo-stops-and-asks).

## How it differs from GitHub and Dropbox

**An upload is not a commit.**

- The files are sent one by one.
- Before it sends, Sync Evo asks Google Drive what changed since the download. A file another device changed in the meantime is not overwritten or deleted. The next download takes it up as a conflict.
- In the short moment between that check and the write, another device's version could still be overwritten. Google Drive keeps it in the file's version history.
- An upload that is stopped half way leaves the files it sent on Google Drive. The next sync sends what is left.

**No automatic merging.** A file changed on two devices is always kept twice, as a conflict file, whatever "On a conflict" says. See [Conflict files](syncing.md#conflict-files).

**What is not synced.**

- Google Docs, Sheets and other files only Google Drive can open, and shortcuts.
- A file or folder with `/` in its name.
- Empty folders, as with GitHub and Dropbox. A folder whose files were all deleted stays on Google Drive.
- Two files of the same name in one folder on Google Drive. Sync Evo writes neither, and says so.

## When the folder is not as it was

**Two folders of the same name.** When `Sync Evo` at the top of My Drive, or the folder of the vault in it, is there twice, Sync Evo stops and changes nothing. Keep one of them: put the other in the trash on Google Drive, and sync again.

- A device that synced with the folder you took away then says that its folder is gone (below). The sync after that finds the one that is left.

**The folder is gone.** When the folder of the vault was deleted, put in the trash, or can no longer be seen by Sync Evo:

- Sync Evo changes nothing on the device, and says so.
- The next sync starts over, as a first sync does. It asks before the first upload.

## Disconnecting

- **Disconnect** ends the connection of this device only. Sync Evo forgets it on the device, and does not tell Google.
- The account (its ID and e-mail address) and the folder stay in the settings. So connecting again to the same account does not start the sync over.
- To end the connection of every device, remove Sync Evo under "Third-party apps & services" in your Google Account. Every device then says "Google no longer accepts the connection of Sync Evo". Connecting again to the same account keeps the sync state.

## Limits of Google

- **100 connections per account.** Google keeps at most 100 connections of Sync Evo for one Google account. Each press of **Connect** makes one. Past 100, the oldest device is disconnected. Connect it again.
- **Work and school accounts.** With a Google Workspace account, the administrator may block apps such as Sync Evo. Ask them, or use another account.
- **Space.** A Google account comes with 15 GB for free, shared with Gmail and Google Photos. A file that does not fit is not uploaded, and Sync Evo says so. The rest is sent. Only the first upload to a new folder stops as a whole when its first file does not fit.

More: [Network use and privacy](network.md#google-drive), [Limits](limits.md).
