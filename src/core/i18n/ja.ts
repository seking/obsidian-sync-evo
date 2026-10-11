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

	"settings.connection.heading": "接続",
	"settings.repository.name": "リポジトリ",
	"settings.repository.desc":
		"同期先の GitHub のリポジトリです。owner/name の形で入力するか、ブラウザのアドレスを貼り付けます。",
	"settings.repository.placeholder": "owner/name",
	"settings.repository.invalid": "owner/name の形になっていないため、保存されていません。",
	"settings.branch.name": "ブランチ",
	"settings.branch.desc": "同期するブランチです。",
	"settings.branch.placeholder": "main",
	"settings.branch.empty": "ブランチを入力してください。前のブランチのままになっています。",
	"settings.token.name": "トークン",
	"settings.token.desc":
		"このリポジトリの Contents の読み書きを許可した fine-grained personal access token です。Obsidian のキーチェーンに保存され、このデバイスの全保管庫で共有されます。",
	"settings.deviceName.name": "デバイス名",
	"settings.deviceName.desc": "コミットメッセージと、競合したときに残すファイルの名前に使われます。",
	"settings.deviceName.empty": "名前を入力してください。前の名前のままになっています。",
	"settings.deviceName.invalidCharacter":
		"デバイス名には、改行、タブ、および * \" \\ / < > : | ? # ^ [ ] は使えません。前の名前のままになっています。",
	"settings.test.name": "接続のテスト",
	"settings.test.button": "テスト",
	"settings.test.running": "確認中…",
	"settings.unknownVersion":
		"この保管庫の設定は、新しいバージョンの Sync Evo で保存されたものです。使うには、プラグインを更新してください。それまで Sync Evo は同期せず、設定も変更しません。",
	"settings.reset.name": "やり直す",
	"settings.reset.desc":
		"このデバイスにある、この保管庫の設定を破棄します。破棄すると、このバージョンで設定を入力し直せます。トークンは、Obsidian のキーチェーンに残ります。",
	"settings.reset.button": "設定を破棄",
	"settings.howItSyncs.heading": "同期のしかた",
	"settings.autoSync.onStartup.name": "起動時に同期する",
	"settings.autoSync.onStartup.desc":
		"Obsidian を起動した時と、ほかのアプリから戻った時に同期します。直前の同期を始めてから5分たっていない時は、同期しません。",
	"settings.autoSync.atInterval.name": "一定間隔で同期する",
	"settings.autoSync.atInterval.desc":
		"Obsidian が前に出ている間、直前の同期を始めてから下の間隔がたつたびに同期します。",
	"settings.autoSync.interval.name": "間隔（分）",
	"settings.autoSync.interval.desc":
		"{min}〜{max} 分で指定します。「自動同期で手元の変更も送る」が入の時は、{sendingMin} 分以上です。",
	"settings.autoSync.interval.invalid":
		"{min}〜{max} の整数を、分で入力してください。前の間隔のままになっています。",
	"settings.autoSync.interval.raised":
		"「自動同期で手元の変更も送る」を入にしたため、間隔を {minutes} 分に上げました。",
	"settings.autoSync.sends.name": "自動同期で手元の変更も送る",
	"settings.autoSync.sends.desc":
		"切の時、自動同期は受け取るだけです。このデバイスで編集した内容は、手動で同期するまで送信されません。入の時は、このデバイスに変更があるたびにコミットが作られるため、間隔は {sendingMin} 分以上になります。",
	"settings.symlinks.name": "飛ばしているシンボリックリンク",
	"settings.symlinks.summary": "{count} 件",
	"settings.symlinks.desc":
		"保存先のシンボリックリンクは、このデバイスに書き込みません。最後に取り込んだ時点のリンクと、リンク先です。",
	"settings.symlinks.item": "{path} → {target}",

	"settings.exclusion.heading": "同期する物",
	"settings.exclusion.desc":
		"ここの設定は、保管庫のルートの .gitignore に書かれ、全デバイスと、パソコンの git に同じに効きます。除外しても、何も削除しません。すでに保存先にある物は、追跡を外すまで同期を続けます。",
	"settings.exclusion.tracked":
		"除外の規則に当たるファイルが、保存先に {count} 件残っています（最後の同期の時点）。",
	"settings.exclusion.untrack.name": "規則に当たるファイル",
	"settings.exclusion.untrack.desc":
		"追跡を外すと、保存先から削除し、同期しなくなります。このデバイスのファイルは残ります。",
	"settings.exclusion.handEdited":
		".gitignore の Sync Evo が管理する行が、手で直されています。切り替えには、Sync Evo が読み取った状態を出しています。次に切り替えると、これらの行を Sync Evo の決まった形に書き直します。Sync Evo が知らない行は残します。",
	"settings.exclusion.noState":
		"この保管庫の同期の状態を今は使えないため、同期する物をここで表示も変更もできません。理由は、同期を実行すると表示されます。",
	"settings.exclusion.syncRunning":
		"同期中のため、終わるまでここでは何も変えられません。表示が古いことがあります。終わってから、設定画面を開き直してください。",
	"settings.exclusion.unsettled":
		"前に行った .gitignore の変更が終わっておらず、ファイルが途中までの可能性があります。片付くまで表示しません。保管庫のルートの .gitignore がこのデバイスで読めるかを確かめて、設定画面を開き直してください。",
	"settings.exclusion.unreadable.notAFile":
		"この保管庫のルートに .gitignore という名前のフォルダがあるため、表示や変更ができる規則がありません。フォルダの名前を変えるか、削除してください。",
	"settings.exclusion.unreadable.tooLarge":
		"この保管庫の .gitignore は {limit}MB を超えているため、読み取らず、ここでは変えられません。パソコンで小さくしてください。",
	"settings.exclusion.unreadable.notDownloaded":
		"この保管庫の .gitignore は、このデバイスにダウンロードされていません（クラウドドライブが、仮のファイルだけを置いています）。そのため、ここでは表示も変更もできません。ダウンロードしてから、設定画面を開き直してください。",
	"settings.exclusion.unreadable.respelled":
		"この保管庫の .gitignore は、大文字と小文字が違う名前（.GITIGNORE など）になっているため、規則として読まれず、ここでは変えられません。名前を .gitignore に変えてください。",
	"settings.exclusion.unreadable.readFailed":
		"この保管庫の .gitignore を読めなかったため、ここでは表示も変更もできません。設定画面を開き直すと、もう一度試します。",
	"settings.exclusion.unreadable.notText":
		"この保管庫の .gitignore は UTF-8 のテキストではないため、ここで表示や変更をすると中身が壊れます。パソコンで、UTF-8 で保存し直してください。",
	"settings.exclusion.broken":
		".gitignore の、Sync Evo が管理する行を囲む2つの印の行（「# >>> Sync Evo」と「# <<< Sync Evo」で始まる行）が、1組になっていません。片方が無いか、同じ物が2つあるか、順番が逆です。直るまで、切り替えは出しません。「規則を直接書く（.gitignore）」の欄で直してください。それぞれ1行ずつにし、「# >>>」の行を上にします。この2種類の印の行を全部消すと、次の同期で Sync Evo が管理する行を足し直します。",
	"settings.exclusion.noSection.name": "Sync Evo が管理する行",
	"settings.exclusion.noSection.desc":
		"この保管庫の .gitignore には、Sync Evo が管理する行がまだ無いため、切り替える物がありません。それまでは、どのデバイスの Sync Evo も、初期設定の行があるものとして扱います。行が .gitignore に無いので、Mac などの git には効きません。変更を送信する次の同期でも、行を足します。",
	"settings.exclusion.noSection.button": "Sync Evo が管理する行を足す",
	"settings.exclusion.noSection.syncFirst":
		"このデバイスは、まだ保存先から取り込んでいないため、ここでは行を足しません。保存先に .gitignore があると、競合になるためです。先に同期してください。同期の時に足されます。",
	"settings.exclusion.noSection.overLimit":
		"行を足すと .gitignore が {limit}MB を超えるため、ここでも同期でも足せません。先に、ファイルを短くしてください。",
	"settings.exclusion.fileKinds.name": "ファイルの種類",
	"settings.exclusion.fileKinds.desc":
		"設定フォルダの外のファイルに効きます。ノート、キャンバス、ベースは、常に同期します。",
	"settings.exclusion.folders.name": "除外フォルダ",
	"settings.exclusion.folders.desc": "同期しないフォルダを、保管庫のルートからのパスで足します。",
	"settings.exclusion.folders.placeholder": "フォルダ/下位のフォルダ",
	"settings.exclusion.folders.add": "追加",
	"settings.exclusion.folders.remove": "外す",
	"settings.exclusion.folders.invalid": "保管庫のルートからのフォルダのパスになっていないため、足していません。",
	"settings.exclusion.config.name": "保管庫の設定",
	"settings.exclusion.config.desc":
		"設定フォルダのどの項目を同期するかを選びます。取り込んだ変更は、Obsidian を再読み込みした後に効くことがあります。",
	"settings.exclusion.config.summary": "{total} 項目のうち {count} 項目を同期",
	"settings.exclusion.communityPluginList.warning":
		"入にしている間は、全デバイスで Sync Evo を有効にしておいてください。有効でないデバイスがあると、このデバイスの Sync Evo も次の起動で無効になり、同期が止まります。",
	"settings.exclusion.communityPlugins.warning":
		"ほかのプラグインの data.json も同期されます（トークンなどが入っていることがあります）。ほかのデバイスから来たプラグインのコードが、このデバイスで動きます。信頼できるデバイスとリポジトリでだけ、入にしてください。",
	"settings.exclusion.fixedOff.name": "効いていない除外",
	"settings.exclusion.fixedOff.desc":
		"下の行は、ゴミ箱、画面の配置のファイル、Sync Evo 自身のフォルダ、OS が残すファイルを同期から除くための行です。行が消されたか、後ろの ! で始まる行で打ち消されていて、今は効いていません。除いていた物も、同期されます。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、Mac などの git ではコミットされます。",
	"settings.exclusion.fixedOff.restore": "元に戻す",
	"settings.exclusion.fixedOff.restoreNote":
		"元に戻すと、消された行を、Sync Evo が管理する行に足し直します。後ろの ! で始まる行で打ち消されている行は、戻した後もここに残ります。その時は、「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.fixedOff.undone":
		"消された行は無いため、元に戻す物はありません。どの行も、後ろの ! で始まる行で打ち消されています。「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.fixedOff.undoneNoSection":
		"どの行も、.gitignore の ! で始まる行で打ち消されています。「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.editor.name": "規則を直接書く（.gitignore）",
	"settings.exclusion.editor.desc":
		"保管庫のルートの .gitignore の全体です。自分の規則は、Sync Evo が管理する行（「# >>> Sync Evo」と「# <<< Sync Evo」の間）の外に書きます。「保存」を押すまで保存されず、切り替えを使うと、保存していない入力は消えます。",
	"settings.exclusion.editor.absent": "この保管庫には、まだ .gitignore がありません。保存すると作ります。",
	"settings.exclusion.editor.save": "保存",
	"settings.exclusion.editor.saved": ".gitignore を保存しました。次の同期で保存先に届きます。",
	"settings.exclusion.notices.name": "最後の同期で分かったこと",
	"settings.exclusion.notices.desc": "最後の同期の時点で、この保管庫に当てはまっていることです。",
	"settings.exclusion.write.syncing": "同期中は変えられません。同期が終わってから、もう一度行ってください。",
	"settings.exclusion.write.changed":
		"この画面が読んだ後に .gitignore が変わっていたため、何も書き込んでいません。今の中身で画面を描き直しました。もう一度変更してください。",
	"settings.exclusion.write.refused": "このデバイスが .gitignore の書き込みを断りました。何も変更していません。",
	"settings.exclusion.write.unsettled":
		".gitignore を最後まで書き込めなかったか、前に行った変更を終えられませんでした。ファイルが途中までの可能性があり、片付くまで、この .gitignore に従った送信は行いません。このデバイスで .gitignore に書き込めるかを確かめて、設定画面を開き直してください。",
	"settings.exclusion.write.overLimit":
		"この変更をすると .gitignore が {limit}MB を超えます。超えたファイルは同期されないため、何も書き込んでいません。",
	"settings.exclusion.write.unreadable": "このデバイスで .gitignore を読めなくなったため、何も書き込んでいません。",
	"settings.exclusion.write.noState":
		"この保管庫の同期の状態を今は使えないため、.gitignore を変更していません。理由は、同期を実行すると表示されます。",
	"settings.exclusion.write.failed": ".gitignore を変更していません：{detail}",

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
		"保存先に Sync Evo 自身のフォルダ（{path}）があります。Sync Evo はこのフォルダを同期しません。保存先でも、このデバイスでも、そのままにします。ほかのファイルは、通常どおり同期されます。保存先から消すには、Sync Evo の設定画面で追跡を外します（.gitignore にこのフォルダの行がある時）。",
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
	"notice.nestedGitignore":
		"下位のフォルダに .gitignore があります。Sync Evo は、これらを通常のファイルとして同期しますが、規則としては読みません。何を同期するかは、保管庫のルートの .gitignore だけで決まります。Mac などの git はこれらの規則も使うため、同じ保管庫でも効き方が違います。要る規則は、ルートの .gitignore に書いてください：\n{list}",
	"notice.fixedExclusionOff":
		"Sync Evo が管理する .gitignore の行のうち、次の行が効いていません。行が消されたか、後ろの行で打ち消されています。これらの行で除いていた物（ゴミ箱、画面の配置のファイル、OS が残すファイル）も、同期されます。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、Mac などの git ではコミットされます。消した行は、Sync Evo の設定画面で元に戻せます。! で始まる行で打ち消している時は、その行を直してください：\n{list}",
	"notice.submodule":
		"保存先にサブモジュールがあります。Sync Evo は、サブモジュールの中身にまだ対応していません。このデバイスにはそのフォルダを作らず、中のファイルは取得も送信もしません。ほかは通常どおり同期します：\n{list}",

	"section.added.intro":
		"この保管庫の .gitignore の先頭に、下の行を足しました。Sync Evo が管理する行で、同期しない物を決めます：",
	"section.added.created":
		"この保管庫に .gitignore が無かったので、下の行で作りました。Sync Evo が管理する行で、同期しない物を決めます：",
	"section.added.outside": ".gitignore のほかの部分は、変えていません。",
	"section.added.sends": "この変更は、この送信で保存先に届きます。",
	"section.added.sent": "この変更は、この送信で保存先に届きました。",
	"section.added.unsent": "この変更は、まだ保存先に届いていません。次の送信で届きます。",
	"section.added.unknown": "この変更が、この送信で保存先に届いたかは、分かりません。届いていなければ、次の送信で届きます。",
	"section.added.howTo":
		"これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
	"section.added.tracked": "これらの行に当たるファイルが、保存先に {count} 件あります。これらは同期を続けます：",
	"section.added.untrackHint":
		"同期をやめるには、Sync Evo の設定画面で追跡を外します。保存先からは消え、このデバイスのファイルは残ります。",

	"list.separator": "、",
	"list.showRest": "残り {count} 件を表示",
	"list.more": "…ほか {count} 件",

	"command.sync": "同期する（取り込んでから送信）",
	"command.pull": "保存先から取り込む（pull）",
	"command.push": "保存先へ送信する（push）",
	"command.firstFetch": "初回取得（同期の状態を捨ててやり直す）",
	"command.stop": "同期を中止する",
	"command.showLog": "最近の動作の記録を見る",

	"log.title": "最近の動作の記録",
	"log.desc":
		"Sync Evo が読み込まれてからの記録です。新しい物が下にあります。このデバイスのメモリにだけあり、Obsidian を閉じた時と、Sync Evo を更新した時に消えます。",
	"log.empty": "まだ記録はありません。",
	"log.copy": "すべてコピー",
	"log.copied": "記録をコピーしました。",
	"log.copyFailed": "コピーできませんでした。記録を選択して、コピーしてください。",

	"sync.alreadyRunning": "同期は、すでに実行中です。",
	"pull.notRunning": "同期は実行していません。",
	"auto.heading": "自動同期：",
	"auto.waiting.deletions":
		"取り込むと、このデバイスのファイルが大量に削除されるため、確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"auto.waiting.rewritten":
		"保存先の履歴が書き換えられているため、取り込む前に確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"auto.waiting.firstFetch":
		"この保管庫の初回取得が終わっていません。初回取得は、自動では始めません。保管庫に保存先と違うファイルがある間は、続きも自動では行いません。何も変更していません。手動で同期すると、初回取得が始まるか、続きから進みます。",
	"auto.waiting.firstPush":
		"このデバイスからの最初の送信には、確認が必要です。何も送信していません。手動で同期すると、確認が表示されます。",
	"auto.waiting.pushDeletions":
		"送信すると、保存先のファイルが大量に削除されるため、確認が必要です。何も送信していません。手動で同期すると、確認が表示されます。",
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
	"pull.tidiedCopies":
		"作ってから30日たった競合の別名 {count} 件を、_conflicts/ からこの保管庫の .trash/ へ移しました。残したい別名は、_conflicts/ の外へ移すか、名前を変えてください。",
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
	"push.recoveredUntrack":
		"前に行った追跡を外す操作は、保存先に届いていました（{count} 件）。このデバイスに記録しました。このデバイスのファイルは、そのままです。",
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
		"{count} 件のファイルを、送信していません。.github/workflows/ の下のファイルを足すか変えるには、トークンに Workflows の読み取りと書き込みの権限が要ります。トークンに権限を足すと、次の同期で送信します。足さない時は、このファイルを元の内容に戻して、変更は git が使えるデバイスで行ってください。前の版の Sync Evo が残した競合の別名（名前に .conflict-from- が入る物）なら、中身を確かめてから削除してください：\n{list}",
	"push.leftOut":
		"{count} 件のファイルを、送信していません。送信の途中で変わったか、読めなかったか、エディタが保存できませんでした。次の送信で、もう一度確かめます：\n{list}",

	"untrack.confirm.title": "追跡を外す確認",
	"untrack.confirm.proceed": "追跡を外す",
	"untrack.confirm.cancel": "今は外さない",
	"untrack.confirm.body":
		"保存先に、.gitignore の規則に当たるファイルが {count} 件あります。追跡を外すと、保存先から削除し、同期しなくなります：",
	"untrack.confirm.threshold": "一度に {count} 件のファイルを、保存先から削除します。一覧を確かめてから進めてください。",
	"untrack.confirm.keeps": "このデバイスのファイルは削除しません。そのまま残ります。",
	"untrack.confirm.otherDevices":
		"ほかのデバイスでは、次の取り込みで削除されます。そのデバイスで変更していたファイルは残ります。",
	"untrack.confirm.mac":
		"git を使うパソコンにファイルを残したい時は、ここでは外さず、そのパソコンで git rm --cached をして push してください。その時は、このデバイスのファイルが、次の取り込みで削除されます。",
	"untrack.confirm.syncFirst":
		"先に取り込みを行います。規則がまだ保存先に届いていなければ、送信も行い、このデバイスのほかの変更も送ります。",
	"untrack.confirm.missing":
		"このうち {count} 件は、このデバイスにありません。一覧に出した物には、印を付けています。追跡を外すと、中身は保存先の履歴にだけ残ります。",
	"untrack.confirm.submodules":
		"規則に当たるサブモジュールも {count} 件あります。ここでは追跡を外しません。Mac などの git で外してください：",
	"untrack.confirm.note":
		"「今は外さない」を選ぶと、規則は残り、これらのファイルは同期を続けます。後から、Sync Evo の設定画面で外せます。",
	"untrack.item.tagged": "{path}（{tags}）",
	"untrack.tag.symlink": "シンボリックリンク",
	"untrack.tag.ownFolder": "Sync Evo 自身のフォルダ",
	"untrack.tag.missing": "このデバイスに無い",
	"untrack.done": "追跡を外しました：{count} 件。保存先から削除しました。このデバイスのファイルは、そのままです。",
	"untrack.nothing":
		"追跡を外す物はありませんでした。一覧のファイルは、もう保存先に無いか、規則に当たらなくなっています。何も変更していません。",
	"untrack.remoteMoved":
		"追跡を外していません。その間に、保存先がほかのデバイスから変更されました。Sync Evo の設定画面から、もう一度行ってください。",
	"untrack.cancelled": "追跡を外す操作を中止しました。保存先からは、何も削除していません。",
	"untrack.connectionChanged":
		"接続先が変わったため、追跡を外す操作を中止しました。保存先からは、何も削除していません。",
	"untrack.progress.running": "追跡を外す操作：保存先から削除しています…",
	"untrack.progress.stopping": "追跡を外す操作：中止しています…",
	"untrack.submodules":
		"保存先に、.gitignore の規則に当たるサブモジュールが {count} 件あります。Sync Evo では、サブモジュールの追跡を外せません。Mac などの git で外してください。",
	"untrack.failed": "追跡を外せませんでした。{reason}",
	"untrack.syncFirst.remoteEmpty":
		"追跡を外していません。保存先にコミットがありません。先に同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.syncFirst.pullUnfinished":
		"追跡を外していません。このデバイスは、保存先からの取り込みをまだ終えていません。次の同期に残るファイルが無くなるまで同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.syncFirst.gitignoreUnsettled":
		"追跡を外していません。この保管庫の .gitignore の内容を確かめられませんでした。エディタが .gitignore を保存できなかったか、前の書き込みが終わっていません。保存するか閉じてから同期し、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.syncFirst.gitignoreUnreadable":
		"追跡を外していません。この保管庫の .gitignore を、このデバイスで読めません。理由は、Sync Evo の設定画面に出ます。直してから、もう一度行ってください。",
	"untrack.syncFirst.noSection":
		"追跡を外していません。この保管庫の .gitignore に Sync Evo が管理する行が無く、当てている規則がファイルに書かれていません。Sync Evo の設定画面で行を足して同期してから、もう一度行ってください。",
	"untrack.syncFirst.sectionBroken":
		"追跡を外していません。.gitignore の、Sync Evo が管理する行を囲む2つの印の行が、1組になっていません。Sync Evo の設定画面で直して同期してから、もう一度行ってください。",
	"untrack.syncFirst.gitignoreNotSent":
		"追跡を外していません。このデバイスの .gitignore が、保存先の .gitignore と同じではなく、規則がまだ保存先に届いていません。.gitignore が届くまで同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.skipped.pullDeclined":
		"取り込みをやめたため、追跡を外していません。規則は残っています。後から、Sync Evo の設定画面で追跡を外せます。",
	"untrack.skipped.pullCancelled":
		"取り込みを中止したため、追跡を外していません。規則は残っています。後から、Sync Evo の設定画面で追跡を外せます。",
	"untrack.skipped.pushNotDone":
		".gitignore を保存先に届ける送信が済まなかったため、追跡を外していません。規則は残っています。後から、Sync Evo の設定画面で追跡を外せます。",

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
		"保存先と中身が違うファイル：{count} 件。保存先の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに別名で残します。",
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
	"confirm.firstPush.remoteEmptyWithGitignore":
		"保存先は空で、コミットがまだありません。最初に .gitignore だけのコミットを作り、続けて残りを送信します。",
	"confirm.firstPush.added": "追加するファイル：{count} 件",
	"confirm.firstPush.modified": "変更するファイル：{count} 件",
	"confirm.firstPush.deleted": "削除するファイル：{count} 件",
	"confirm.pushDelete.body":
		"このデバイスで削除したファイル {count} 件を、保存先からも削除します。ほかのデバイスでも、取り込むと削除されます。",
	"confirm.push.note": "やめた場合は、何も送信せず、何も変更しません。",
	"confirm.push.noteSection":
		"やめた場合は、何も送信しません。.gitignore に足した行は、このデバイスに残り、次の送信で届きます。",
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
