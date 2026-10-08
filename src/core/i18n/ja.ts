/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of Sync Evo, which is free software licensed under the
 * GNU Affero General Public License, version 3. It comes with ABSOLUTELY NO
 * WARRANTY. See the LICENSE file for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { completeTranslation } from "./catalog";
import { en } from "./en";

export const ja = completeTranslation(en, {
	"fileTypes.images": "画像を同期",
	"fileTypes.audio": "音声を同期",
	"fileTypes.videos": "動画を同期",
	"fileTypes.pdfs": "PDFを同期",
	"fileTypes.others": "他のすべてのタイプのファイルを同期",
	"vaultConfig.main": "メイン設定",
	"vaultConfig.appearance": "外観設定",
	"vaultConfig.themesAndSnippets": "テーマとスニペット",
	"vaultConfig.hotkeys": "ホットキー",
	"vaultConfig.corePluginList": "アクティブなコアプラグインのリスト",
	"vaultConfig.corePluginSettings": "コアプラグイン設定",
	"vaultConfig.communityPluginList": "アクティブなコミュニティプラグインのリスト",
	"vaultConfig.communityPlugins": "インストールされているコミュニティプラグイン",

	"settings.repository.name": "リポジトリ",
	"settings.repository.desc":
		"この保管庫を同期する GitHub のリポジトリです。owner/name の形で入力します。ブラウザからアドレスを貼り付けることもできます。",
	"settings.repository.placeholder": "owner/name",
	"settings.repository.invalid": "owner/name の形になっていないため、保存されていません。",
	"settings.branch.name": "ブランチ",
	"settings.branch.desc": "同期するブランチです。",
	"settings.branch.placeholder": "main",
	"settings.branch.empty": "ブランチを入力してください。前のブランチのままになっています。",
	"settings.token.name": "トークン",
	"settings.token.desc":
		"このリポジトリの Contents の読み取りと書き込みを許可した、fine-grained personal access token を使います。トークンは、付けた名前で Obsidian のキーチェーンに保存され、このデバイスのすべての保管庫で共有されます。",
	"settings.deviceName.name": "デバイス名",
	"settings.deviceName.desc":
		"ほかのデバイスと見分けるための名前です。コミットメッセージと、競合したときに残すファイルの名前に使われます。",
	"settings.deviceName.empty": "名前を入力してください。前の名前のままになっています。",
	"settings.deviceName.invalidCharacter":
		"デバイス名には、改行、タブ、および * \" \\ / < > : | ? # ^ [ ] は使えません。前の名前のままになっています。",
	"settings.test.name": "接続",
	"settings.test.desc": "トークンでリポジトリとブランチにアクセスできるかを確かめます。",
	"settings.test.button": "接続をテスト",
	"settings.test.running": "確認中…",
	"settings.unknownVersion":
		"この保管庫の設定は、新しいバージョンの Sync Evo で保存されたものです。使うには、プラグインを更新してください。それまで Sync Evo は同期せず、設定も変更しません。",
	"settings.reset.name": "やり直す",
	"settings.reset.desc":
		"このデバイスにある、この保管庫の設定を破棄します。破棄すると、このバージョンで設定を入力し直せます。トークンは、Obsidian のキーチェーンに残ります。",
	"settings.reset.button": "設定を破棄",
	"settings.symlinks.name": "飛ばしているシンボリックリンク",
	"settings.symlinks.desc":
		"保存先のシンボリックリンクは、このデバイスに書き込まず、保存先でもそのままにします。最後に取り込んだ時点のリンクと、そのリンク先です。",
	"settings.symlinks.item": "{path} → {target}",

	"check.connected": "{repository} のブランチ {branch} に接続できました。",
	"check.empty": "{repository} に接続できました。保存先は空で、コミットがまだありません。",
	"check.unauthorized":
		"GitHub がトークンを受け付けませんでした。トークンが間違っているか、取り消されたか、期限が切れています。新しいトークンを作り、選択中のシークレットに保存してください。",
	"check.forbidden":
		"トークンは有効ですが、権限が足りません。{repository} の Contents の読み取りと書き込みの権限が必要です。",
	"check.notFound": "{repository} が存在しないか、トークンにこのリポジトリへのアクセスが許可されていません。",
	"check.branchNotFound":
		"{repository} に {branch} というブランチがありません。Sync Evo はブランチを作らないので、名前を確かめてください。",
	"check.unreachable": "GitHub に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
	"check.rateLimited": "GitHub のリクエスト数の上限に達しました。しばらくしてから、もう一度試してください。",
	"check.other": "接続のテストに失敗しました：{detail}",
	"check.noRepository": "先に、リポジトリを owner/name の形で入力してください。",
	"check.noBranch": "先に、ブランチを入力してください。",
	"check.noTokenSecret": "先に、トークンを保存したシークレットを選んでください。",
	"check.noTokenValue":
		"シークレット {name} に値がありません。トークンをこの名前で保存するか、別のシークレットを選んでください。",

	"notice.ownFolderOnRemote":
		"保存先に Sync Evo 自身のフォルダ（{path}）があります。Sync Evo はこのフォルダを同期しません。保存先でも、このデバイスでも、そのままにします。ほかのファイルは、通常どおり同期されます。",
	"notice.gitAtRoot":
		"この保管庫のルートに .git があり、git のリポジトリになっています。このデバイスでは、git か Obsidian Git プラグインで同期してください。Sync Evo が送った内容を git は知らないため、次の git pull が止まります。Sync Evo は、その間も同期を続けます。",

	"notice.remotePathCollision":
		"保存先に、大文字と小文字だけ、または Unicode の正規化（NFC と NFD）だけが違うパスがあります。区別できないデバイスがあるため、このデバイスにはどれも書き込みません。保存先で名前を変えてください：\n{list}",
	"notice.tooLarge":
		"{limit}MB を超えるファイルは同期しません。飛ばし、保存先でもこのデバイスでもそのままにします：\n{list}",
	"notice.lfsPointer":
		"保存先に Git LFS のポインターファイルがあります。Sync Evo はポインターをそのまま同期し、本体は取得しません。そのため、このデバイスでは開けません：\n{list}",
	"notice.invalidPath": "保存先に、ファイルのパスとして扱えないパスがあります。飛ばします：\n{list}",
	"notice.pluginNotListed":
		"取り込んだ「アクティブなコミュニティプラグインのリスト」（{path}）に Sync Evo がありません。次に Obsidian を起動すると Sync Evo が無効になり、同期が止まります。設定の「コミュニティプラグイン」で、もう一度有効にしてください。",
	"notice.unwritablePath":
		"このデバイスで書き込み、移動、または削除ができなかったファイルがあったため、飛ばしました。保存先では何も変更していません。取り込みのたびに、もう一度試します：\n{list}",
	"notice.blockedPath":
		"保存先のファイル {path} を書き込めませんでした。その場所に、このデバイスにだけあるファイルがあります。移動するか名前を変えると、次の取り込みで書き込みます：\n{list}",
	"notice.archiveGivenUp":
		"このデバイスでは、全ファイルをまとめて取得できませんでした。今後このデバイスでは、まとめて取得しません。ファイルが多いときも1件ずつ取得するため、時間が長くかかります。",

	"list.separator": "、",
	"list.more": "…ほか {count} 件",

	"command.pull": "保存先から取り込む（pull）",
	"command.firstFetch": "初回取得（同期の状態を捨ててやり直す）",
	"command.stop": "同期を中止する",

	"pull.alreadyRunning": "取り込みは、すでに実行中です。",
	"pull.notRunning": "同期は実行していません。",
	"pull.progress.starting": "取り込み：始めています…",
	"pull.progress.listing": "取り込み：保存先を確認中…",
	"pull.progress.scanning": "取り込み：保管庫を確認中…",
	"pull.progress.hashing": "取り込み：ファイルを比較中（{done}/{total}）…",
	"pull.progress.applyingStart": "取り込み：ファイルを更新中…",
	"pull.progress.applying": "取り込み：ファイルを更新中（{done}/{total}）…",
	"pull.progress.downloadingArchive": "取り込み：全ファイルをまとめて取得中…",
	"pull.progress.archiveWaiting": "取り込み：中止した取り込みの取得が終わるのを待っています…",
	"pull.progress.stopping": "取り込み：中止しています…",
	"pull.progress.archiveRetry":
		"前回は、取得が終わりませんでした。終わるまで、Obsidian を前に出したまま待ってください。",
	"pull.progress.graphClosed":
		"ファイルを書き込む間、グラフビューを閉じています。取り込みが終わると、開き直します。",
	"pull.progress.rateLimited":
		"GitHub のリクエスト数の上限に達しました。{time} に続きを取り込みます。アプリを閉じても、次の同期で続きから進みます。",
	"pull.progress.overQuota":
		"GitHub のリクエスト数の上限までに取得できるのは、約 {count} 件です。残りは {time} 以降に取り込みます。",
	"pull.count.fetched": "取得 {count} 件",
	"pull.count.deleted": "削除 {count} 件",
	"pull.count.renamed": "名前の変更 {count} 件",
	"pull.count.conflicts": "競合 {count} 件",
	"pull.summary": "取り込みが終わりました：{details}",
	"pull.refetched":
		"{count} 件のファイルは、まとめて取得した中に無いか、中身が GitHub の一覧と合わなかったため、1件ずつ取得しました。",
	"pull.done": "取り込みが終わりました。",
	"pull.upToDate": "取り込むものはありません。このデバイスは最新です。",
	"pull.remoteEmpty": "保存先は空で、コミットがまだありません。取り込むものはありません。",
	"pull.declined": "取り込みをやめました。何も変更していません。",
	"pull.declinedAfterTrash":
		"取り込みをやめました。下に示すファイルだけを、この保管庫の .trash/ へ移しました。ほかは何も変更していません。",
	"pull.cancelled": "取り込みを中止しました。次の取り込みで、続きから進みます。",
	"pull.cancelledAfter": "中止するまでに済んだ分：{details}",
	"pull.connectionChanged":
		"接続先が変わったため、取り込みを中止しました。次の取り込みは、新しい接続先で始めます。",
	"pull.failed": "取り込みに失敗しました。{reason}",
	"pull.error.incompleteListing":
		"リポジトリのファイルが多く、GitHub が1回で一覧を返せません（10万件を超えるか、一覧が 7MB を超えています）。そのため、Sync Evo では同期できません。",
	"pull.error.other": "詳細：{detail}",
	"pull.incomplete": "{count} 件のファイルを取り込めませんでした。次の同期で、もう一度試します。{reason}",
	"pull.incompleteSome": "一部のファイルを取り込めませんでした。次の同期で、もう一度試します。{reason}",
	"pull.reason.hashMismatch": "GitHub から受け取った内容が、GitHub の一覧と合いませんでした。",
	"pull.reason.unreadable": "このデバイスのファイルを読めませんでした。",
	"pull.reason.trashFailed": "このデバイスのファイルを、この保管庫の .trash/ へ移せませんでした。",
	"pull.conflicts": "このデバイスのファイル {count} 件の内容を、別名で残しました：\n{list}",
	"pull.conflict.conflict": "{copy}（競合。{path} は保存先の内容になりました）",
	"pull.conflict.becameSymlink":
		"{copy}（{path} は保存先でシンボリックリンクになりました。リンクは、このデバイスに書き込みません）",
	"pull.conflict.becameFolder": "{copy}（{path} は保存先でフォルダになりました）",
	"pull.conflict.nameTaken": "{copy}（保存先で、別のファイルの名前が {path} に変わりました）",
	"pull.replacedSettings":
		"設定フォルダのファイル {count} 件を、保存先の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：\n{list}",
	"pull.trashed":
		"取り込みで、{count} 件のファイルをこの保管庫の .trash/ へ移しました。内容は失われていません。そこから戻せます：\n{list}",
	"pull.halfWritten":
		"前の取り込みが、{count} 件のファイルを書いている途中で止まっていました。残っていた内容は、この保管庫の .trash/ へ移しました。保存先の内容は、取り込みで取得します。その後に編集していた時は、そこから戻せます：\n{list}",
	"pull.halfCopies":
		"前の取り込みが作りかけていた競合の別名 {count} 件を、この保管庫の .trash/ へ移しました。別名は作り直します。別名を編集していた時は、編集した内容がそこにあります：\n{list}",
	"pull.keptLocal":
		"選んだとおり、このデバイスのファイル {count} 件をそのまま残しました。保存先の内容とは異なります：\n{list}",
	"pull.symlinks":
		"保存先にシンボリックリンクが {count} 件あります。Sync Evo は、このデバイスに書き込まず、保存先でもそのままにします。飛ばしているリンクは、設定画面で確認できます：\n{list}",

	"state.waiting": "前の接続先の同期の状態を削除し終えるまで待っています…",
	"state.newerVersion":
		"この保管庫の同期の状態は、新しいバージョンの Sync Evo で保存されたものです。同期するには、プラグインを更新してください。何も変更していません。",
	"state.noAppId":
		"Obsidian からこの保管庫の ID を取得できないため、同期の状態を保存する場所がありません。同期していません。",
	"state.noIndexedDb":
		"このデバイスでは、Sync Evo が同期の状態を保存する IndexedDB を使えません。同期していません。",
	"state.openFailed":
		"同期の状態を開けなかったため、同期していません。Obsidian を再起動して、もう一度試してください。",
	"state.discardFailed":
		"前の接続先の同期の状態を削除できなかったため、同期していません。Obsidian を再起動して、もう一度試してください。",

	"confirm.proceed": "進める",
	"confirm.keepLocal": "このデバイスのファイルを残す",
	"confirm.cancel": "やめる",
	"confirm.delete.title": "ファイル削除の確認",
	"confirm.delete.body":
		"このデバイスにあるファイル {count} 件が、保存先で削除されたか、シンボリックリンクに変わっています。取り込むと、このデバイスから削除されます。",
	"confirm.delete.note": "やめた場合は、何も取り込まず、何も変更しません。",
	"confirm.firstFetch.title": "初回取得の確認",
	"confirm.firstFetch.body":
		"{repository} のブランチ {branch} から、この保管庫に初めて取り込みます。この保管庫には、すでにファイルがあります。",
	"confirm.firstFetch.different":
		"保存先と中身が違うファイル：{count} 件。保存先の内容に書き換えます。このデバイスの内容は、同じ場所に別名で残します。",
	"confirm.firstFetch.differentSettings":
		"保存先と中身が違う設定フォルダのファイル：{count} 件。保存先の内容に書き換えます。このデバイスの内容は、この保管庫の .trash/ へ移します。",
	"confirm.firstFetch.localOnly": "このデバイスにだけあるファイル：{count} 件。このデバイスに、そのまま残します。",
	"confirm.firstFetch.atSymlinks":
		"保存先でシンボリックリンクになっているパスにあるファイル：{count} 件。比べずに、そのまま残します。",
	"confirm.startOver.title": "同期の状態を捨ててやり直す",
	"confirm.startOver.body":
		"このデバイスの同期の状態を捨てて、{repository} のブランチ {branch} から取り込み直して作り直します。同期の状態は、何を同期したかを Sync Evo が覚えておくための記録です。ファイルは、このデバイスでも保存先でも削除しません。",
	"confirm.startOver.nothing":
		"保存先と中身が違うファイルも、このデバイスにだけあるファイルも、ありません。",
	"confirm.startOver.note": "やめた場合は、同期の状態を捨てず、何も変更しません。",
	"confirm.rewritten.title": "保存先の履歴の書き換え",
	"confirm.rewritten.body":
		"保存先の履歴が、このデバイスが最後に同期した時点から続いていません（force push の後など）。このデバイスから送った変更が、保存先から消えている可能性があります。保存先に合わせると、下のファイルがこのデバイスから失われます。",
	"confirm.rewritten.deletions": "削除するファイル：{count} 件",
	"confirm.rewritten.overwrites": "保存先の内容で上書きするファイル：{count} 件",
	"confirm.rewritten.trashNote":
		"「進める」を選ぶと、保存先に合わせます。これらのファイルは、先にこの保管庫の .trash/ へ移すので、後から戻せます。",
	"confirm.rewritten.keepNote":
		"「このデバイスのファイルを残す」を選ぶと、これらのファイルをそのままにして、ほかの変更だけを取り込みます。「やめる」を選ぶと、何も取り込みません。",
});
