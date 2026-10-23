# FAQ

[日本語](https://github.com/seking/obsidian-sync-evo/blob/main/docs/ja/faq.md)

## Is Sync Evo free?

For now, yes, with every service. Dropbox and Google Drive may become paid later, with a license key: $3 a month, $24 a year, or $49 once, one key for both. That will be announced in the README and in the release notes before it starts, and even then, they stay free for 3 months from the day it starts, or from your first sync with the account, if that is later. See [Pricing](https://github.com/seking/obsidian-sync-evo#pricing).

## What happens when the free time ends?

Once the paid plan has started: for 30 days, Sync Evo only downloads from Dropbox or Google Drive, and uploads nothing. Then it stops syncing with them. Nothing is deleted. Enter a license key in the settings to sync again, or switch the vault to GitHub, which is free for now. See [License key](settings.md#license-key).

## Do I need a key for each device?

No. One key is for up to 5 of your devices, with Dropbox and Google Drive. Enter it in the settings on each device: each device activates it once, whichever vault it is entered in.

To free a place for another device, empty the field of the key on a device that no longer needs it: that ends its activation. If you no longer have that device, end its activation in the [billing portal](https://customer.dodopayments.com/login/bus_0NpvnyuwMvGA62iaE3swK) of Dodo Payments, where activations are listed by device name, or write to contact@gyap.jp.

## How do I cancel a subscription?

In the [billing portal](https://customer.dodopayments.com/login/bus_0NpvnyuwMvGA62iaE3swK) of Dodo Payments: enter the email you bought the key with, open the link it sends you, and choose the subscription. Cancelling at the next billing date keeps the key working until the end of the period you paid for. Cancelling now stops the key at once, and the rest of the period is not refunded, apart from the refund within 14 days below. You can also write to contact@gyap.jp.

## Can I get a refund?

Within 14 days of the first purchase, and of each renewal of a subscription, in full and for any reason. Refunds are made through Dodo Payments. A key that was refunded no longer works. See the [terms of service](https://gyap.jp/sync-evo/terms).

## How do I get back what a merged file held before?

Sync Evo keeps it in `.trash/.sync-evo-merged/` in the vault, as `<date> <name>.<extension>`. Obsidian does not show that folder. Use the file manager of the device to move the copy into a folder Obsidian shows. See [Getting a merged file's previous version back](syncing.md#getting-a-merged-files-previous-version-back).

## Where are conflict files?

In the folder `_conflicts/` at the root of the vault, as `<date> <name> (<device>).<extension>`. The notice of the sync names them. They are moved to `.trash/` after 30 days, unless you move them out of `_conflicts/` or rename them. See [Conflict files](syncing.md#conflict-files).

## Switching a device from Git to Sync Evo

Use Git (or the Obsidian Git plugin) or Sync Evo on a device, not both. To Git, what Sync Evo syncs looks like changes not yet committed, so on that device its pulls can stop, and its commits can take them in. Other devices can keep using Git on the same repository.

To move a device to Sync Evo, for automatic sync on a phone for example:

1. With Git, commit and push everything on that device, then pull, so that it matches the repository.
2. Turn off the Obsidian Git plugin, or stop the Git app, on that device.
3. Set up Sync Evo and sync. Files that match the repository are taken as they are.

If the device was behind the repository, every file that changed since is kept twice on the first sync, with the device's version in `_conflicts/`. That is why step 1 matters.

While the vault still has a `.git` folder at its root, Sync Evo tells you once that it found it, and keeps syncing. Delete that folder when you no longer use Git on the device.

## Can I use a vault in iCloud Drive?

Yes, but support is experimental. Do not sync the same iCloud vault with Sync Evo on two devices. Do not make it a git working tree on the Mac. If you can choose, a vault under "On My iPhone" is simpler. See [A vault in iCloud Drive](icloud.md).

## What happens when I exclude something?

Nothing is deleted, on a device or on the service. What is excluded is neither uploaded nor downloaded, and a deletion on either side is not carried over. To remove excluded files from the service, use "Remove from GitHub" (or Dropbox, or Google Drive) in the settings. See [What happens when you exclude something](settings.md#what-happens-when-you-exclude-something).

## I put a file into the folder on Google Drive. Why is it not synced?

Sync Evo sees only the files it made itself on Google Drive. A file you add there on the Google Drive website, or with Google Drive for desktop, is not seen. Put the file into the vault on one of your devices instead. See [What Sync Evo can see](google-drive.md#what-sync-evo-can-see).

## I cannot connect to Google Drive with my work or school account

With a Google Workspace account, the administrator may have blocked apps such as Sync Evo. Ask them, or use another Google account.

## Sync Evo says that Google no longer accepts its connection

Sync Evo was removed in your Google Account, or this device's connection ended for another reason: one Google account keeps at most 100 connections of Sync Evo, and the oldest ends past that. Press **Connect** in the settings again. With the same account, the sync goes on where it was. See [Disconnecting](google-drive.md#disconnecting).

## Sync Evo says that there is more than one folder on Google Drive

Keep only one of them: put the other one in the trash on Google Drive, and sync again on every device. See [When the folder is not as it was](google-drive.md#when-the-folder-is-not-as-it-was).

## How do I report a bug?

Open an [issue](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token, or a file name you would rather keep private, into a report.

<!-- TODO: My token expired. What do I do? -->
<!-- TODO: How do I go back to a previous version of Sync Evo? -->
<!-- TODO: How do I move from another sync plugin? -->
