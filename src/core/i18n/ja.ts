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
	"notice.archiveLimited":
		"このデバイスでは、全ファイルをまとめて取得できませんでした。今後このデバイスでは、まとめた大きさの見込みが約 {size}MB 以上のときは、まとめて取得しません。ファイルが多いときも1件ずつ取得するため、時間が長くかかります。",
	"notice.archiveGivenUp":
		"このデバイスでは、全ファイルをまとめて取得できませんでした。今後このデバイスでは、まとめて取得しません。ファイルが多いときも1件ずつ取得するため、時間が長くかかります。",

	"notice.localPathCollision":
		"一部の新しいファイルを、送信していません。保存先のほかのパス、またはほかの新しいファイルと、大文字と小文字だけが違います。名前を変えると、次の送信で送ります。ほかのファイルは、通常どおり送信します：\n{list}",
	"notice.renameNotSent":
		"このデバイスで、大文字と小文字だけを変えて名前を変えたファイルがあります。新しい名前は、.gitignore の規則で除外されるか、ほかのパスと大文字と小文字だけが違うため、送信していません。そのため、保存先にある古い名前のファイルも削除していません：\n{list}",

	"list.separator": "、",
	"list.more": "…ほか {count} 件",

	"command.sync": "同期する（取り込んでから送信）",
	"command.pull": "保存先から取り込む（pull）",
	"command.push": "保存先へ送信する（push）",
	"command.firstFetch": "初回取得（同期の状態を捨ててやり直す）",
	"command.stop": "同期を中止する",

	"sync.alreadyRunning": "同期は、すでに実行中です。",
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
	"pull.reason.trashFailed": "このデバイスのファイルを、この保管庫の .trash/ へ移せませんでした。",
	"pull.notDownloaded":
		"{count} 件のファイルが、このデバイスにダウンロードされていません（クラウドドライブが仮のファイルだけを置いています）。ダウンロードしてから、もう一度同期してください：\n{list}",
	"pull.unreadable":
		"このデバイスのファイル {count} 件を読めませんでした。そのままにしてあります。ファイルを確かめてから、もう一度同期してください：\n{list}",
	"pull.waitingForUnread":
		"ほかに {count} 件のファイルも、取り込んでいません。次の同期に残したファイルを待っています。後の同期で、取り込みます。",
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
	"pull.keptUnsent":
		"選んだとおりに残したファイルのうち {count} 件は、.gitignore の規則に当たるため、保存先へは送信しません。このデバイスにだけ残ります：\n{list}",
	"pull.symlinks":
		"保存先にシンボリックリンクが {count} 件あります。Sync Evo は、このデバイスに書き込まず、保存先でもそのままにします。飛ばしているリンクは、設定画面で確認できます：\n{list}",

	"push.progress.starting": "送信：始めています…",
	"push.progress.listing": "送信：保存先を確認中…",
	"push.progress.scanning": "送信：保管庫を確認中…",
	"push.progress.hashing": "送信：ファイルを比較中（{done}/{total}）…",
	"push.progress.sendingStart": "送信：ファイルを送信中…",
	"push.progress.sending": "送信：ファイルを送信中（{done}/{total}）…",
	"push.progress.finishing": "送信：仕上げています…",
	"push.progress.stopping": "送信：中止しています…",
	"push.progress.rateLimited":
		"GitHub の、ファイル作成の上限に達しました。{time} に続きを送信します。それまで、Obsidian を前に出したままにしてください。送信は、途中で止まると何も送られません。",
	"push.count.added": "追加 {count} 件",
	"push.count.modified": "変更 {count} 件",
	"push.count.deleted": "削除 {count} 件",
	"push.summary": "送信が終わりました：{details}",
	"push.nothing": "送信するものはありません。保存先は最新です。",
	"push.nothingSent": "何も送信していません。",
	"push.recovered": "前回の送信は、保存先に届いていました：{details}。このデバイスに記録しました。",
	"push.pullFirst.noBase":
		"何も送信していません。このデバイスは、保存先からの最初の取り込みをまだ終えていません。先に取り込み（pull）を行ってから、送信してください。",
	"push.pullFirst.remoteEmpty":
		"何も送信していません。保存先にコミットがありません。このデバイスは、前にこの保存先と同期しています。保存先のコミットが無くなったので、先に取り込みを実行して確かめてください。",
	"push.pullFirst.notDefaultBranch":
		"何も送信していません。保存先は空で、コミットがまだありません。GitHub は、空のリポジトリの最初のコミットを、既定のブランチ {branch} に作ります。Sync Evo の設定のブランチを {branch} にするか、GitHub でリポジトリの既定のブランチを変えてから、もう一度同期してください。",
	"push.pullFirst.gitignoreUnreadable":
		"何も送信していません。何を送信するかは、この保管庫の .gitignore で決まりますが、このデバイスで読めません。クラウドドライブからダウンロードされていないか、.gitignore という名前のフォルダがあるか、大文字と小文字だけが違う名前（.GITIGNORE など）になっています。直してから、もう一度送信してください。",
	"push.pullFirst.remoteMoved":
		"何も送信していません。この送信を始めた後に、保存先がほかのデバイスから変更されました。先に取り込み（pull）を行ってから、もう一度送信してください。",
	"push.pullFirst.gitignore":
		"何も送信していません。何を送信するかは、この保管庫の .gitignore で決まりますが、その内容を確かめられませんでした。エディタが .gitignore を保存できなかったか、前の取り込みが書いている途中で止まりました。.gitignore をエディタで開いている時は、保存するか閉じてから、もう一度送信してください。開いていない時は、先に取り込み（pull）を行ってから、送信してください。",
	"push.declined": "送信をやめました。何も送信していません。",
	"push.cancelled": "送信を中止しました。何も送信していません。",
	"push.connectionChanged": "接続先が変わったため、送信を中止しました。何も送信していません。",
	"push.failed": "送信に失敗しました。{reason}",
	"push.unfinished":
		"前の同期（{time}）では、送信が終わっていません。このデバイスの変更が、保存先に届いていないことがあります。自動では送り直しません。同期を実行すると、今の内容で送信します。",
	"push.error.workflows":
		"GitHub が送信を拒否しました。.github/workflows/ の下のファイルを変更するには、トークンに Workflows の読み取りと書き込みの権限も必要です。",
	"push.error.notAsListed":
		"何も送信していません。保存先の中身が、このデバイスが持っている保存先の一覧と違っていました。次の同期で、一覧を取り直します。もう一度同期してください。",
	"push.storedOtherwise":
		"GitHub が、このデバイスが送信した内容と違う内容で保存したファイル：{count} 件。次の取り込み（pull）で、このデバイスのファイルを GitHub の内容に置き換えます：\n{list}",
	"push.held":
		"{count} 件のファイルを、送信していません。取り込みが済んでいないか、エディタが保存できませんでした。もう一度同期してください：\n{list}",
	"push.remoteInTheWay":
		"{count} 件のファイルを、送信していません。その場所に、このデバイスがまだ取り込んでいないファイルかフォルダが、保存先にあります。先に取り込み（pull）を行ってから、もう一度送信してください：\n{list}",
	"push.notDownloaded":
		"{count} 件の新しいファイルを、送信していません。このデバイスにダウンロードされていないためです（クラウドドライブが仮のファイルだけを置いています）。ダウンロードしてから、もう一度同期してください：\n{list}",
	"push.grownTooLarge":
		"{count} 件のファイルを、送信していません。送信の途中で {limit}MB を超えました。{limit}MB を超えるファイルは同期しません：\n{list}",
	"push.refusedSize":
		"{count} 件のファイルを、送信していません。GitHub が、大きすぎるとして受け付けませんでした。このファイルは、小さくするか、保管庫の外へ移してください。保存先にまだ無いファイルは、.gitignore に足しても送らなくなります。競合で残した別名のファイルなら、中身を確かめてから削除してください：\n{list}",
	"push.refusedWorkflows":
		"{count} 件のファイルを、送信していません。.github/workflows/ の下のファイルを足すか変えるには、トークンに Workflows の読み取りと書き込みの権限が要ります。トークンに権限を足すと、次の同期で送信します。足さない時は、このファイルを元の内容に戻して、変更は git が使えるデバイスで行ってください。競合で残した別名のファイルなら、中身を確かめてから削除してください：\n{list}",
	"push.leftOut":
		"{count} 件のファイルを、送信していません。送信の途中で変わったか、読めなかったか、エディタが保存できませんでした。次の送信で、もう一度確かめます：\n{list}",

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
	"confirm.firstFetch.localOnly":
		"このデバイスにだけあるファイル：{count} 件。このデバイスに、そのまま残します。次の送信（push）で、保存先に送ります。送信の前に、送るファイルの一覧を示して、もう一度確認を求めます。除外するファイルは、送りません。",
	"confirm.firstFetch.atSymlinks":
		"保存先でシンボリックリンクになっているパスにあるファイル：{count} 件。比べずに、そのまま残します。",
	"confirm.firstPush.title": "最初の送信の確認",
	"confirm.firstPush.body":
		"このデバイスから {repository} のブランチ {branch} へ、初めて送信します。保存先を、下のとおりに変更します。送信が1回済むと、次からの送信では、この一覧を出しません。",
	"confirm.firstPush.remoteEmpty":
		"保存先は空で、コミットがまだありません。最初に .gitignore だけのコミットを作り、続けて残りを送信します。この保管庫に .gitignore が無い時は、空の .gitignore を作ります。",
	"confirm.firstPush.added": "追加するファイル：{count} 件",
	"confirm.firstPush.modified": "変更するファイル：{count} 件",
	"confirm.firstPush.deleted": "削除するファイル：{count} 件",
	"confirm.pushDelete.body":
		"このデバイスで削除したファイル {count} 件を、保存先からも削除します。ほかのデバイスでも、取り込むと削除されます。",
	"confirm.push.note": "やめた場合は、何も送信せず、何も変更しません。",
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
