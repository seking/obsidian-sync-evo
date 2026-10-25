/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
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
	"vaultConfig.main.desc": "エディタ設定、ファイルとリンクの設定などを同期します。",
	"vaultConfig.appearance.desc": "ダークモード、アクティブなテーマ、有効化されているスニペットなどの外観の設定を同期します。",
	"vaultConfig.themesAndSnippets.desc": "ダウンロードされたテーマとスニペットを同期します。有効化されているかどうかは、上の外観設定に従います。",
	"vaultConfig.hotkeys.desc": "カスタムホットキーを同期します。",
	"vaultConfig.corePluginList.desc": "有効化されているコアプラグインを同期します。",
	"vaultConfig.corePluginSettings.desc": "コアプラグインの設定を同期します。",
	"vaultConfig.communityPluginList.desc": "有効化されているコミュニティプラグインを同期します。",
	"vaultConfig.communityPlugins.desc": "インストールされているコミュニティプラグイン（.js、.css、manifest.json のファイル）と、その設定を同期します。",

	"settings.connection.heading": "接続",
	"settings.service.name": "サービス",
	"settings.service.desc": "この保管庫を同期する先です。変えると、同期を最初からやり直します。",
	"settings.dropbox.name": "Dropbox",
	"settings.dropbox.desc":
		"「接続する」を押すと、ブラウザで Dropbox が開きます。ログインして「許可」を押すと、Obsidian に戻ります。利用者が少ないアプリだという警告が出たら、「続行」で進めます。",
	"settings.dropbox.connected": "接続中：{email}",
	"settings.dropbox.connect": "接続する",
	"settings.dropbox.disconnect": "接続を解除",
	"settings.dropboxFolder.name": "フォルダ",
	"settings.dropboxFolder.desc":
		"Dropbox の アプリ/Sync Evo の中の、この保管庫のフォルダの名前です。同じ名前にしたデバイスどうしが同期します。変えると、同期を最初からやり直します。",
	"settings.dropboxFolder.invalid": "フォルダの名前にならないため、保存されていません。空にせず、/ や \\ を入れないでください。",
	"settings.gdrive.name": "Google Drive",
	"settings.gdrive.desc":
		"「接続する」を押すと、コードが表示され、コピーされます。「ブラウザで開く」で google.com/device が開くので、そこにコードを入れ、Google アカウントを選び、Sync Evo を許可してください。その後、Obsidian に戻ります。",
	"settings.gdrive.connected":
		"接続中：{email}。「接続を解除」は、このデバイスだけの解除です。全デバイスの接続を取り消す時は、Google アカウントの「サードパーティ製のアプリとサービス」から Sync Evo を外してください。",
	"settings.gdrive.connect": "接続する",
	"settings.gdrive.disconnect": "接続を解除",
	"settings.gdriveFolder.name": "フォルダ",
	"settings.gdriveFolder.desc":
		"Google Drive の Sync Evo フォルダの中の、この保管庫のフォルダの名前です。同じ名前にしたデバイスどうしが同期します。変えると、同期を最初からやり直します。",
	"settings.gdriveClient.heading": "自分の Google のクライアント",
	"settings.gdriveClient.desc":
		"Sync Evo のクライアントが使えなくなった時のためだけの欄です。自分の Google Cloud のプロジェクトで作った、種類が「テレビと入力が限られたデバイス」の OAuth クライアントの ID とシークレットを入れ、接続し直してください。Google Drive は、ファイルを置いたのと同じプロジェクトにしかそのファイルを見せません。別のプロジェクトのクライアントでは、この保管庫のフォルダが見えなくなり、全ファイルを新しいフォルダに送り直します。古いフォルダは Google Drive に残ります。Sync Evo のクライアントに戻すには、ID を空にしてください。",
	"settings.gdriveClient.id.name": "クライアント ID",
	"settings.gdriveClient.id.clear": "クライアント ID を消す",
	"settings.gdriveClient.secret.name": "クライアント シークレット",
	"settings.gdriveClient.secret.clear": "クライアント シークレットを消す",
	"settings.gdriveClient.secret.desc": "接続の情報と同じく、このデバイスにこの保管庫の分として置きます。保管庫のファイルには書きません。",
	"settings.gdriveClient.reconnect": "クライアントを変えました。Google Drive に接続し直してください。",
	"settings.license.name": "ライセンスキー",
	"settings.license.desc":
		"Dropbox と Google Drive は、3か月は無料で、その後はライセンスキーが要ります。1つのキーで両方を、このデバイスで使えます。GitHub は無料です。",
	"settings.license.readme": "詳しくは Sync Evo の README をご覧ください。",
	"settings.license.buy": "キーを入手",
	"settings.license.trial": "このアカウントでは、{date} まで無料です。",
	"settings.license.trialUnknown": "このアカウントでは、3か月は無料です。終わる日は、次の同期の後に表示します。",
	"settings.license.readOnly": "無料の期間は {ended} に終わりました。{stops} までは、ダウンロードだけを行います。",
	"settings.license.stopped": "無料の期間は {ended} に終わりました。{remote} との同期を止めています。",
	"settings.license.ownClient": "自分の Google のクライアントを使う時は、ライセンスキーは要りません。",
	"settings.license.checking": "キーを確かめています…",
	"settings.license.clear": "このデバイスからキーを外す",
	"settings.license.valid": "このデバイスでキーを使っています。",
	"settings.license.grace": "{since} からキーを確かめられていません。{until} までは使え、その間にまた確かめます。",
	"settings.license.unconfirmed": "キーを確かめられませんでした。後でまた確かめます。ネットワークの接続を確認してください。",
	"settings.license.invalid": "このキーは使えません。",
	"settings.license.testClock": "（試験用の時計 {days} 日）",
	"settings.repository.name": "リポジトリ",
	"settings.repository.desc": "同期する GitHub のリポジトリです。owner/name の形で入力するか、ブラウザのアドレスを貼り付けます。",
	"settings.repository.placeholder": "owner/name",
	"settings.repository.clear": "リポジトリを消す",
	"settings.repository.invalid": "owner/name の形になっていないため、保存されていません。",
	"settings.branch.name": "ブランチ",
	"settings.branch.desc": "同期するブランチです。",
	"settings.branch.placeholder": "main",
	"settings.branch.empty": "ブランチを入力してください。前のブランチのままになっています。",
	"settings.token.name": "トークン",
	"settings.token.desc":
		"このリポジトリの Contents の読み書きを許可した fine-grained personal access token です。Obsidian のキーチェーンに保存され、保管庫のファイルには書かれません。iPhone と Android では、デバイスのどの保管庫からも同じシークレットを使えます。パソコンでは、保管庫ごとに別です。",
	"settings.token.create": "GitHub でトークンを作る（そのページで、このリポジトリを選びます）",
	"settings.deviceName.name": "デバイス名",
	"settings.deviceName.desc": "コミットメッセージと、競合ファイルの名前に使われます。",
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
	"settings.autoSync.interval.desc": "{min}〜{max} 分で指定します。「自動同期でこのデバイスの変更もアップロードする」が入の時は、{sendingMin} 分以上です。",
	"settings.autoSync.interval.gdriveDesc":
		"{min}〜{max} 分で指定します。Google Drive を確かめるたびに、Sync Evo の利用者全員で分け合う上限に数えられます。",
	"settings.autoSync.interval.invalid":
		"{min}〜{max} の整数を、分で入力してください。前の間隔のままになっています。",
	"settings.autoSync.interval.raised": "「自動同期でこのデバイスの変更もアップロードする」を入にしたため、間隔を {minutes} 分に上げました。",
	"settings.autoSync.interval.raisedForGdrive": "Google Drive では間隔が {minutes} 分以上必要なため、間隔を {minutes} 分に上げました。",
	"settings.autoSync.sends.name": "自動同期でこのデバイスの変更もアップロードする",
	"settings.autoSync.sends.githubDesc":
		"切の時、自動同期はダウンロードするだけです。このデバイスで編集した内容は、手動で同期するまでアップロードされません。入の時は、このデバイスに変更があるたびにコミットが作られるため、間隔は {sendingMin} 分以上になります。",
	"settings.autoSync.sends.dropboxDesc":
		"切の時、自動同期はダウンロードするだけです。このデバイスで編集した内容は、手動で同期するまでアップロードされません。入の時は、書きかけのノートを何度もアップロードしないよう、間隔は {sendingMin} 分以上になります。",
	"settings.autoSync.sends.gdriveDesc":
		"切の時、自動同期はダウンロードするだけです。このデバイスで編集した内容は、手動で同期するまでアップロードされません。",
	"settings.onConflict.name": "競合した時",
	"settings.onConflict.desc":
		"このデバイスと {remote} の両方で変更したファイルの扱いです。統合は行単位で行い、統合できないファイルは競合ファイルとして残します。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ に入れます。",
	"settings.onConflict.merge": "自動で統合",
	"settings.onConflict.copy": "競合ファイルを作成",
	"settings.symlinks.name": "スキップしているシンボリックリンク",
	"settings.symlinks.summary": "{count} 件",
	"settings.symlinks.desc":
		"{remote} のシンボリックリンクは、このデバイスに書き込みません。最後にダウンロードした時点のリンクと、リンク先です。",
	"settings.symlinks.item": "{path} → {target}",

	"settings.exclusion.heading": "同期しない物（全デバイス）",
	"settings.exclusion.desc": "ここで選んだ物は、全デバイスで同期しません。どのデバイスのファイルも、{remote} の物も削除しません。",
	"settings.exclusion.tracked": "除外しているファイルが、{remote} に {count} 件残っています（最後の同期の時点）。",
	"settings.exclusion.untrack.name": "除外していて、{remote} に残っているファイル",
	"settings.exclusion.untrack.desc": "どのデバイスの Sync Evo も、これらを同期しません。{remote} から削除しても、Sync Evo のデバイスのファイルは残ります。",
	"settings.exclusion.untrack.button": "{remote} から削除",
	"settings.exclusion.untrack.noState": "今は、{remote} から削除できません。何も変更していません。同期を実行すると、理由が表示されます。",
	"settings.exclusion.handEdited":
		".gitignore の Sync Evo が管理する行が、手で直されています。切り替えには、Sync Evo が読み取った状態を出しています。次に切り替えると、これらの行を Sync Evo の決まった形に書き直します。Sync Evo が知らない行は残します。",
	"settings.exclusion.noState": "今は、ここで同期しない物の表示と変更ができません。同期を実行すると、理由が表示されます。",
	"settings.exclusion.syncRunning":
		"同期中のため、終わるまでここでは何も変えられません。表示が古いことがあります。終わってから、設定画面を開き直してください。",
	"settings.exclusion.unsettled":
		"前に行った .gitignore の変更が終わっておらず、ファイルが途中までの可能性があります。片付くまで表示しません。保管庫のルートの .gitignore がこのデバイスで読めるかを確かめて、設定画面を開き直してください。",
	"settings.exclusion.unreadable.notAFile": "この保管庫のルートに .gitignore という名前のフォルダがあるため、表示や変更ができる除外の設定がありません。フォルダの名前を変えるか、削除してください。",
	"settings.exclusion.unreadable.tooLarge":
		"この保管庫の .gitignore は {limit}MB を超えているため、読み取らず、ここでは変えられません。パソコンで小さくしてください。",
	"settings.exclusion.unreadable.notDownloaded":
		"この保管庫の .gitignore の中身が、このデバイスにありません（クラウドドライブが、仮のファイルだけを置いています）。そのため、ここでは表示も変更もできません。クラウドドライブのアプリでこのデバイスに保存してから、設定画面を開き直してください。",
	"settings.exclusion.unreadable.respelled":
		"この保管庫の .gitignore は、大文字と小文字が違う名前（.GITIGNORE など）になっているため、除外の設定として読まれず、ここでは変えられません。名前を .gitignore に変えてください。",
	"settings.exclusion.unreadable.readFailed":
		"この保管庫の .gitignore を読めなかったため、ここでは表示も変更もできません。設定画面を開き直すと、もう一度試します。",
	"settings.exclusion.unreadable.notText":
		"この保管庫の .gitignore は UTF-8 のテキストではないため、ここで表示や変更をすると中身が壊れます。パソコンで、UTF-8 で保存し直してください。",
	"settings.exclusion.broken":
		".gitignore の、Sync Evo が管理する行を囲む2つの印の行（「# >>> Sync Evo」と「# <<< Sync Evo」で始まる行）が、1組になっていません。片方が無いか、同じ物が2つあるか、順番が逆です。直るまで、切り替えは出しません。「規則を直接書く（.gitignore）」の欄で直してください。それぞれ1行ずつにし、「# >>>」の行を上にします。この2種類の印の行を全部消すと、次の同期で Sync Evo が管理する行を足し直します。",
	"settings.exclusion.noSection.name": "Sync Evo が管理する行",
	"settings.exclusion.noSection.desc":
		"この保管庫の .gitignore には、Sync Evo が管理する行がまだありません。下のボタンで足せます。足すまでは、どのデバイスの Sync Evo も初期設定のとおりに除外しますが、パソコンの git には効きません。変更をアップロードする次の同期でも、行を足します。",
	"settings.exclusion.noSection.button": "Sync Evo が管理する行を足す",
	"settings.exclusion.noSection.syncFirst":
		"このデバイスは、まだ {remote} からダウンロードしていないため、ここでは行を足しません。{remote} に .gitignore があると、競合になるためです。先に同期してください。同期の時に足されます。",
	"settings.exclusion.noSection.overLimit":
		"行を足すと .gitignore が {limit}MB を超えるため、ここでも同期でも足せません。先に、ファイルを短くしてください。",
	"settings.exclusion.fileKinds.name": "ファイルの種類",
	"settings.exclusion.fileKinds.desc":
		"設定フォルダの外のファイルに効きます。ノート、キャンバス、ベースは、常に同期します。",
	"settings.exclusion.folders.name": "除外フォルダ",
	"settings.exclusion.folders.desc": "同期しないフォルダを、保管庫のルートからのパスで足します。",
	"settings.exclusion.folders.clear": "欄を消す",
	"settings.exclusion.folders.placeholder": "フォルダ/下位のフォルダ",
	"settings.exclusion.folders.add": "追加",
	"settings.exclusion.folders.remove": "除外リストから削除",
	"settings.exclusion.folders.invalid": "保管庫のルートからのフォルダのパスになっていないため、足していません。",
	"settings.exclusion.config.name": "保管庫の設定を同期",
	"settings.exclusion.config.desc":
		"設定フォルダのどの項目を同期するかを選びます。ダウンロードした変更は、Obsidian を再読み込みした後に効くことがあります。",
	"settings.exclusion.config.summary": "{total} 項目のうち {count} 項目を同期",
	"settings.exclusion.communityPluginList.warning":
		"入にしている間は、全デバイスで Sync Evo を有効にしておいてください。有効でないデバイスがあると、このデバイスの Sync Evo も次の起動で無効になり、同期が止まります。",
	"settings.exclusion.communityPlugins.warning":
		"ほかのプラグインの data.json も同期されます（トークンなどが入っていることがあります）。ほかのデバイスから来たプラグインのコードが、このデバイスで動きます。信頼できるデバイスとリポジトリでだけ、入にしてください。",
	"settings.exclusion.fixedOff.name": "効いていない初期設定の除外",
	"settings.exclusion.fixedOff.desc":
		"下の行で除外していた物（ゴミ箱、画面の配置のファイル、OS が残すファイルなど）が、今は同期されます。行が消されたか、後ろの ! で始まる行で打ち消されているためです。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、パソコンの git ではコミットされます。",
	"settings.exclusion.fixedOff.restore": "元に戻す",
	"settings.exclusion.fixedOff.restoreNote":
		"元に戻すと、消された行を、Sync Evo が管理する行に足し直します。後ろの ! で始まる行で打ち消されている行は、戻した後もここに残ります。その時は、「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.fixedOff.undone":
		"消された行は無いため、元に戻す物はありません。どの行も、後ろの ! で始まる行で打ち消されています。「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.fixedOff.undoneNoSection":
		"どの行も、.gitignore の ! で始まる行で打ち消されています。「規則を直接書く（.gitignore）」の欄で、打ち消している行を直してください。",
	"settings.exclusion.editor.name": "規則を直接書く（.gitignore）",
	"settings.exclusion.editor.desc":
		"全デバイスの除外は、保管庫のルートの .gitignore に書きます。パソコンの git にも効きますが、git は、すでに {remote} にある物をアップロードし続けます。自分の規則は、Sync Evo が管理する行（「# >>> Sync Evo」と「# <<< Sync Evo」の間）の外に書きます。「保存」を押すまで保存されず、切り替えを使うと、保存していない入力は消えます。",
	"settings.exclusion.editor.absent": "この保管庫には、まだ .gitignore がありません。保存すると作ります。",
	"settings.exclusion.editor.save": "保存",
	"settings.exclusion.editor.saved": ".gitignore を保存しました。次の同期で {remote} にアップロードします。",
	"settings.deviceExclusion.heading": "同期しない物（このデバイスのみ）",
	"settings.deviceExclusion.desc":
		"ここで選んだ物は、このデバイスでだけ同期しません。このデバイスのファイルも、{remote} の物も削除しません。",
	"settings.deviceExclusion.summary.none": "なし",
	"settings.deviceExclusion.summary.folders": "フォルダ {count} 件",
	"settings.deviceExclusion.kind.image": "画像",
	"settings.deviceExclusion.kind.audio": "音声",
	"settings.deviceExclusion.kind.video": "動画",
	"settings.deviceExclusion.kind.pdf": "PDF",
	"settings.deviceExclusion.kind.other": "その他",
	"settings.exclusion.notices.name": "最後の同期で分かったこと",
	"settings.exclusion.notices.desc": "最後の同期の時点で、この保管庫に当てはまっていることです。",
	"settings.exclusion.write.syncing": "同期中は変えられません。同期が終わってから、もう一度行ってください。",
	"settings.exclusion.write.changed":
		"この画面が読んだ後に .gitignore が変わっていたため、何も書き込んでいません。今の中身で画面を描き直しました。もう一度変更してください。",
	"settings.exclusion.write.refused": "このデバイスが .gitignore の書き込みを断りました。何も変更していません。",
	"settings.exclusion.write.unsettled":
		".gitignore を最後まで書き込めなかったか、前に行った変更を終えられませんでした。ファイルが途中までの可能性があり、片付くまで、この .gitignore に従ったアップロードは行いません。このデバイスで .gitignore に書き込めるかを確かめて、設定画面を開き直してください。",
	"settings.exclusion.write.overLimit":
		"この変更をすると .gitignore が {limit}MB を超えます。超えたファイルは同期されないため、何も書き込んでいません。",
	"settings.exclusion.write.unreadable": "このデバイスで .gitignore を読めなくなったため、何も書き込んでいません。",
	"settings.exclusion.write.noState": "今は、.gitignore を変更できません。何も変更していません。同期を実行すると、理由が表示されます。",
	"settings.exclusion.write.failed": ".gitignore を変更していません：{detail}",

	"check.connected": "{repository} のブランチ {branch} に接続できました。",
	"dropbox.connected": "Dropbox に接続しました（{email}）。",
	"dropbox.denied": "Dropbox に接続していません。許可されませんでした。",
	"dropbox.notWaited":
		"この保管庫が待っていない接続が、Dropbox から戻りました。「接続する」を押した保管庫を開き、そこでもう一度押してください。",
	"dropbox.signInFailed": "Dropbox に接続できませんでした。もう一度「接続する」を押してください。（{detail}）",
	"dropbox.revokeFailed":
		"このデバイスの接続は解除しましたが、Dropbox に伝えられませんでした。Dropbox の設定の「リンク済みアプリ」から、Sync Evo を外してください。",
	"check.dropbox.connected": "Dropbox に接続できました。アプリ/Sync Evo/{folder} フォルダがあります。",
	"check.dropbox.empty": "Dropbox に接続できました。アプリ/Sync Evo/{folder} フォルダは、まだありません。最初のアップロードで作ります。",
	"check.dropbox.noFolder": "先に、Dropbox のフォルダの名前を入れてください。",
	"check.dropbox.notConnected": "このデバイスは Dropbox に接続していません。Sync Evo の設定画面で「接続する」を押してください。",
	"check.dropbox.unauthorized":
		"Dropbox が、このデバイスの接続を受け付けなくなりました。Dropbox の「リンク済みアプリ」から Sync Evo が外された可能性があります。Sync Evo の設定画面で、もう一度「接続する」を押してください。",
	"check.dropbox.forbidden": "Dropbox が、フォルダを読むことを許しませんでした。Sync Evo の設定画面で、接続し直してください。",
	"gdrive.code.title": "Google Drive に接続する",
	"gdrive.code.asking": "Google にコードを求めています…",
	"gdrive.code.body":
		"このコードを、ブラウザで開く Google の画面（{url}）に入れてください。Google アカウントを選び、Sync Evo を許可したら、Obsidian に戻ってください。",
	"gdrive.code.copied": "コードはコピー済みです。",
	"gdrive.code.open": "ブラウザで開く",
	"gdrive.code.cancel": "やめる",
	"gdrive.connected": "Google Drive に接続しました（{email}）。",
	"gdrive.denied": "Google Drive に接続していません。許可されませんでした。",
	"gdrive.expired": "Google Drive に接続していません。コードを入れる前に、コードの期限が切れました。もう一度「接続する」を押してください。",
	"gdrive.signInFailed": "Google Drive に接続できませんでした。もう一度「接続する」を押してください。（{detail}）",
	"gdrive.noClientSecret":
		"この版の Sync Evo には Google のクライアントの情報が入っていないため、Google Drive に接続できません。公開されている版の Sync Evo を使ってください。",
	"gdrive.ownClientNoSecret":
		"自分の Google のクライアントの、クライアント シークレットが入っていません。Sync Evo の設定画面の「自分の Google のクライアント」で入れるか、クライアント ID を空にしてください。",
	"paid.warning":
		"{remote} での Sync Evo は、{date} まで（あと {count} 日）無料です。その後も {remote} と同期するには、ライセンスキーが要ります。Sync Evo の設定画面をご覧ください。GitHub は無料です。",
	"paid.readOnly.pulling":
		"{remote} での Sync Evo の無料の期間は、{ended} に終わりました。{stops} までは、ダウンロードだけを行い、何もアップロードしません。また同期するには、Sync Evo の設定画面でライセンスキーを入れてください。",
	"paid.readOnly.blocked":
		"何もアップロードしていません。{remote} での Sync Evo の無料の期間は、{ended} に終わりました。{stops} までは、ダウンロードだけを行います。また同期するには、Sync Evo の設定画面でライセンスキーを入れてください。",
	"paid.stopped":
		"{remote} との同期を止めています。無料の期間が {ended} に終わったためです。何も変更していません。また同期するには、Sync Evo の設定画面でライセンスキーを入れてください。",
	"paid.refused":
		"{remote} での Sync Evo の無料の期間は終わっています。また同期するには、Sync Evo の設定画面でライセンスキーを入れてください。",
	"gdrive.folderGone":
		"この保管庫が同期していた Google Drive の Sync Evo/{folder} フォルダが、見えなくなりました。削除されたか、ゴミ箱に入ったか、Sync Evo から見えなくなっています。このデバイスでは何も変更していません。次の同期は、最初の同期としてやり直します。",
	"gdrive.duplicateFolder":
		"Google Drive に {folder} フォルダが複数あり、どれと同期するかを決められません。何も変更していません。Google Drive で1つだけを残してから、もう一度同期してください。",
	"gdrive.dailyLimit":
		"Sync Evo の利用者全員で分け合う、今日の Google Drive へのリクエスト数の上限に達しました。{time} から、また同期できます。自動同期は、それまで止めます。接続し直す必要はありません。",
	"check.gdrive.connected": "Google Drive に接続できました。Sync Evo/{folder} フォルダがあります。",
	"check.gdrive.empty": "Google Drive に接続できました。Sync Evo/{folder} フォルダは、まだありません。最初のアップロードで作ります。",
	"check.gdrive.noFolder": "先に、Google Drive のフォルダの名前を入れてください。",
	"check.gdrive.notConnected": "このデバイスは Google Drive に接続していません。Sync Evo の設定画面で「接続する」を押してください。",
	"check.gdrive.unauthorized":
		"Google が Sync Evo の接続を受け付けなくなりました。Google アカウントで Sync Evo を外したか、ほかの理由で取り消された可能性があります。Sync Evo の設定画面で、接続し直してください。",
	"check.gdrive.forbidden": "Google Drive が、フォルダを読むことを許しませんでした。Sync Evo の設定画面で、接続し直してください。",
	"check.empty": "{repository} に接続できました。リポジトリは空です。",
	"check.unauthorized":
		"GitHub がトークンを受け付けませんでした。トークンが間違っているか、取り消されたか、期限が切れています。このリポジトリの Contents の読み書きを許可した fine-grained のトークンを新しく作り、選択中のシークレットに保存してください。",
	"check.forbidden":
		"トークンは有効ですが、権限が足りません。{repository} の Contents の読み取りと書き込みの権限が必要です。GitHub でトークンを編集し、{repository} の Contents を「Read and write」にしてください。",
	"check.notFound":
		"このトークンでは、{repository} というリポジトリが見つかりません。名前（owner/name）の綴りと、トークンの「Repository access」にこのリポジトリが入っているかを確かめてください。ほかのリポジトリだけに限ったトークンでも、同じ答えになります。",
	"check.branchNotFound":
		"{repository} に {branch} というブランチがありません。設定のブランチの名前を確かめるか、先に GitHub でブランチを作ってください。",
	"check.unreachable": "GitHub に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
	"check.rateLimited": "GitHub のリクエスト数の上限に達しました。しばらくしてから、もう一度試してください。",
	"check.other": "接続のテストに失敗しました（{detail}）。上の設定を確かめて、もう一度試してください。",
	"check.noRepository": "先に、リポジトリを owner/name の形で入力してください。",
	"check.noBranch": "先に、ブランチを入力してください。",
	"check.noTokenSecret": "先に、トークンを保存したシークレットを選んでください。",
	"check.noTokenValue":
		"シークレット「{name}」が空です。トークンを貼り付けるか、別のシークレットを選んでください。",
	"check.notSetUp":
		"Sync Evo の設定が、まだ済んでいません。Sync Evo の設定画面で、同期するサービス（GitHub、Dropbox、Google Drive）を選び、求められる項目を入れてください。",

	"notice.ownFolderOnRemote":
		"{remote} に Sync Evo 自身のフォルダがあります。Sync Evo はこのフォルダを同期しません。{remote} でも、このデバイスでも、そのままにします。ほかのファイルは、通常どおり同期されます。{remote} から消すには、Sync Evo の設定画面で「{remote} から削除」を行います（.gitignore にこのフォルダの行がある時）：\n{list}",
	"notice.gitAtRoot":
		"この保管庫のルートに .git があり、Git のリポジトリになっています。このデバイスでは、Git（または Obsidian Git プラグイン）と Sync Evo のどちらか一方だけを使ってください。Sync Evo が同期した内容は、Git からはまだコミットしていない変更に見えるため、pull が止まったり、コミットに混ざったりします。このデバイスを Sync Evo に移したのなら、ここでは Git を使わず（Obsidian Git を止め）、要らなくなった時に .git のフォルダを消してください。Sync Evo は、どちらの場合も同期を続けます。FAQ の「デバイスを Git から Sync Evo に移す」を見てください。",

	"notice.remotePathCollision":
		"{remote} に、大文字と小文字だけ、または Unicode の正規化（NFC と NFD）だけが違うパスがあります。区別できないデバイスがあるため、このデバイスにはどれも書き込みません。{remote} で名前を変えてください：\n{list}",
	"notice.tooLarge":
		"{limit}MB を超えるファイルは同期しません。スキップし、{remote} でもこのデバイスでもそのままにします：\n{list}",
	"notice.lfsPointer":
		"{remote} に Git LFS のポインターファイルがあります。Sync Evo はポインターをそのまま同期し、本体はダウンロードしません。そのため、このデバイスでは開けません：\n{list}",
	"notice.invalidPath": "{remote} に、ファイルのパスとして扱えないパスがあります。スキップします：\n{list}",
	"notice.pluginNotListed":
		"ダウンロードした「アクティブなコミュニティプラグインのリスト」に Sync Evo がありません。次に Obsidian を起動すると Sync Evo が無効になり、同期が止まります。設定の「コミュニティプラグイン」で、もう一度有効にしてください：\n{list}",
	"notice.unwritablePath":
		"このデバイスで書き込み、移動、または削除ができなかったファイルがあったため、スキップしました。{remote} では何も変更していません。ダウンロードのたびに、もう一度試します：\n{list}",
	"notice.blockedPath":
		"{remote} の次のファイルを書き込めませんでした。その場所に、このデバイスにだけあるファイルがあります。それを移動するか名前を変えると、次のダウンロードで書き込みます：\n{list}",
	"notice.blockedPath.item": "{path}（その場所にあるファイル：{local}）",
	"notice.archiveLimited":
		"このデバイスでは、全ファイルをまとめてダウンロードできませんでした。今後このデバイスでは、まとめた大きさの見込みが約 {size}MB 以上のときは、まとめてダウンロードしません。ファイルが多いときも1件ずつダウンロードするため、時間が長くかかります。",
	"notice.archiveGivenUp":
		"このデバイスでは、全ファイルをまとめてダウンロードできませんでした。今後このデバイスでは、まとめてダウンロードしません。ファイルが多いときも1件ずつダウンロードするため、時間が長くかかります。",
	"notice.archiveLimited.brief": "今後このデバイスでは、約 {size}MB 以上はまとめてダウンロードしません。",
	"notice.archiveGivenUp.brief": "今後このデバイスでは、まとめてダウンロードしません。",

	"notice.localPathCollision":
		"一部の新しいファイルを、アップロードしていません。{remote} のほかのパス、またはほかの新しいファイルと、大文字と小文字だけが違います。名前を変えると、次のアップロードに入ります。ほかのファイルは、通常どおりアップロードします：\n{list}",
	"notice.renameNotSent":
		"このデバイスで、大文字と小文字だけを変えて名前を変えたファイルがあります。新しい名前は、除外しているか、ほかのパスと大文字と小文字だけが違うため、アップロードしていません。そのため、{remote} にある古い名前のファイルも削除していません：\n{list}",
	"notice.nestedGitignore":
		"下位のフォルダに .gitignore があります。Sync Evo は、これらを通常のファイルとして同期しますが、規則としては読みません。何を同期するかは、保管庫のルートの .gitignore だけで決まります。パソコンの git はこれらの規則も使うため、同じ保管庫でも効き方が違います。要る規則は、ルートの .gitignore に書いてください：\n{list}",
	"notice.fixedExclusionOff":
		"ゴミ箱、画面の配置のファイル、OS が残すファイルなど、除外していた物が、今は同期されます。下に示す .gitignore の行（Sync Evo が管理する行）で除外していましたが、その行が消されたか、後ろの行で打ち消されています。Sync Evo 自身のフォルダだけは、Sync Evo は同期しませんが、パソコンの git ではコミットされます。消した行は、Sync Evo の設定画面で元に戻せます。! で始まる行で打ち消している時は、その行を直してください：\n{list}",
	"notice.submodule":
		"次のサブモジュールの中身は、ダウンロードできません。ダウンロードできるのは、GitHub のリポジトリを指し、リポジトリの .gitmodules に載っているサブモジュールです。サブモジュールの中のサブモジュールと、ファイルが多すぎて一覧を取れない物は、ダウンロードできません。このデバイスにあるそのフォルダの中身は、そのままにします。ほかは通常どおり同期します：\n{list}",
	"notice.submoduleNoAccess":
		"サブモジュールが指すリポジトリを読めません。トークンに、そのリポジトリの Contents の読み取り権限があるかを確かめてください。権限を足すと、次の同期でダウンロードします。それまで、このデバイスにあるそのフォルダの中身は、そのままにします。ほかは通常どおり同期します：\n{list}",
	"notice.submoduleNoCommit":
		"サブモジュールが指すコミットが、指す先のリポジトリにありません。パソコンの git で、サブモジュールの中の変更を push したかを確かめてください。push されると、次の同期でダウンロードします。それまで、このデバイスにあるそのフォルダの中身は、そのままにします。ほかは通常どおり同期します：\n{list}",
	"notice.submoduleNotSent":
		"サブモジュールの中は、読むだけです。このデバイスで変えた、足した、または消した次のファイルはアップロードされず、その変更はこのデバイスにだけ残ります。サブモジュールの中の変更は、パソコンの git で行ってください：\n{list}",

	"notice.exclusionChange":
		"このバージョンの Sync Evo から、除外している物は、{remote} にあっても同期しません。{remote} にある {count} 件のファイルを、このデバイスでは同期しなくなりました。全デバイスで除外している物は、Sync Evo の設定画面の「除外していて、{remote} に残っているファイル」で見られます。",
	"notice.localLink":
		"保管庫の中に、リンク（シンボリックリンク、ジャンクション）があります。Sync Evo は、リンクとその中を同期しません。{remote} でも、このデバイス（リンクの先）でも、そのままにします。ほかは通常どおり同期します：\n{list}",
	"notice.renamingLeft":
		"Sync Evo は、次の名前の大文字と小文字を2回に分けて変え、その途中で止まりました。末尾の「.sync-evo-renaming」を除いた名前に別の物があるか、このデバイスが改名を断ったため、今はこの名前のままにしていて、同期しません。元の名前に戻すまでは、末尾を除いた名前とその下の物も、同期しません。その名前にある物を移すか名前を変えると、次の同期で元の名前に戻します：\n{list}",
	"notice.caseRenamedFolder":
		"Sync Evo は、次のフォルダの名前の大文字と小文字を変えました。Android の Obsidian では、再起動するまで、それぞれが古い綴りでも一覧に見えることがあります。古い綴りの方を消さないでください。中身ごと、本物のフォルダが消えます。再起動すると、古い綴りは見えなくなります：\n{list}",
	"notice.nestedGitignore.brief": "下位のフォルダの .gitignore {count} 件は、規則として読みません。",
	"notice.submodule.brief": "サブモジュール {count} 件の中身は、ダウンロードできません。",
	"notice.localLink.brief": "保管庫の中のリンク {count} 件は、同期しません。",
	"notice.seeResults": "全部は、コマンド「前回の同期の結果を表示」で見られます。",
	"notice.openSettings": "設定を開く",

	"section.added.intro":
		"この保管庫の .gitignore の先頭に、下の行を足しました。Sync Evo が管理する行で、同期しない物を決めます：",
	"section.added.created":
		"この保管庫に .gitignore が無かったので、下の行で作りました。Sync Evo が管理する行で、同期しない物を決めます：",
	"section.added.introFolded": "この保管庫の .gitignore に、同期しない物の規則（{count} 件）を足しました。Sync Evo の設定画面で変えられます。",
	"section.added.createdFolded": "この保管庫に .gitignore が無かったので、同期しない物の規則（{count} 件）を書いて作りました。Sync Evo の設定画面で変えられます。",
	"section.added.unwanted":
		"Sync Evo が管理する行です。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
	"section.added.outside": ".gitignore のほかの部分は、変えていません。",
	"section.added.sends": "この変更は、今回のアップロードに入ります。",
	"section.added.sent": "この変更は、今回アップロードしました。",
	"section.added.unsent": "この変更は、まだアップロードしていません。次の同期でアップロードします。",
	"section.added.unknown": "この変更は、今回アップロードできなかったかもしれません。次の同期で確かめて、まだならアップロードします。",
	"section.added.howTo":
		"これらの行は、Sync Evo の設定画面で変えられます。要らない時は、最初と最後の行（# で始まる2行）だけを残して、間の行を消してください。その2行も消すと、次の同期でまた足します。",
	"section.added.tracked": "Sync Evo が足した規則で除外しているファイルが、{remote} に {count} 件あります。どのデバイスの Sync Evo も、これらを同期しなくなります：",
	"section.added.brief": ".gitignore に、Sync Evo が管理する行を足しました。",
	"section.added.untrackHint": "{remote} から消すには、Sync Evo の設定画面で「{remote} から削除」を行います。Sync Evo のデバイスのファイルは残ります。",

	"list.separator": "、",
	"list.showRest": "残り {count} 件を表示",
	"list.more": "…ほか {count} 件",

	"command.sync": "同期する",
	"command.pull": "{remote} から変更をダウンロードする",
	"command.push": "{remote} へ変更をアップロードする",
	"command.firstFetch": "最初からやり直す（{remote} から全部ダウンロードし直す）",
	"command.stop": "同期を中止する",
	"command.showLog": "同期ログを表示",
	"command.showResults": "前回の同期の結果を表示",

	"results.title": "前回の同期の結果",
	"results.desc":
		"知らせることがあった同期を、新しい方から {count} 回分、全部のファイルと一緒に示します。このデバイスに残り、Obsidian を閉じても消えません。",
	"results.empty": "知らせることがあった同期は、まだありません。",
	"results.manual": "{time}　同期",
	"results.automatic": "{time}　自動同期",
	"results.error": "エラー",
	"results.warn": "確認が要る物",
	"results.info": "お知らせ",
	"results.copy": "すべてコピー",
	"results.copied": "結果をコピーしました。",
	"results.copyFailed": "コピーできませんでした。文字を選択して、コピーしてください。",

	"log.title": "同期ログ",
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
		"ダウンロードすると、このデバイスのファイルが大量に削除されるため、確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"auto.waiting.rewritten": "リポジトリの履歴が書き換えられているため、ダウンロードする前に確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"auto.waiting.firstFetch":
		"この保管庫の最初のダウンロードが、まだ済んでいません。何も変更していません。手動で同期すると、最初のダウンロードを始めるか、続きから進めます。",
	"auto.waiting.firstPush":
		"このデバイスからの最初のアップロードには、確認が必要です。何もアップロードしていません。手動で同期すると、確認が表示されます。",
	"auto.waiting.pushDeletions":
		"アップロードすると、{remote} のファイルが大量に削除されるため、確認が必要です。何もアップロードしていません。手動で同期すると、確認が表示されます。",
	"auto.waiting.emptyVault":
		"前に同期したファイルが、このデバイスに1つも無いため、確認が必要です。何もアップロードしていません。手動で同期すると、確認が表示されます。",
	"pull.progress.starting": "ダウンロード：始めています…",
	"pull.progress.listing": "ダウンロード：{remote} を確認中…",
	"pull.progress.scanning": "ダウンロード：保管庫を確認中…",
	"pull.progress.hashing": "ダウンロード：ファイルを比較中（{done}/{total}）…",
	"pull.progress.applyingStart": "ダウンロード：ファイルを更新中…",
	"pull.progress.applying": "ダウンロード：ファイルを更新中（{done}/{total}）…",
	"pull.progress.downloadingArchive": "ダウンロード：全ファイルをまとめて転送中…",
	"pull.progress.archiveWaiting": "ダウンロード：中止したダウンロードが止まるのを待っています…",
	"pull.progress.stopping": "ダウンロード：中止しています…",
	"pull.progress.archiveRetry": "前回は、ダウンロードが終わりませんでした。終わるまで、Obsidian を前に出したまま待ってください。",
	"pull.progress.graphClosed":
		"ファイルを書き込む間、グラフビューを閉じています。ダウンロードが終わると、開き直します。",
	"pull.progress.rateLimited":
		"GitHub のリクエスト数の上限に達しました。{time} に続きをダウンロードします。アプリを閉じても、次の同期で続きから進みます。",
	"pull.progress.overQuota": "GitHub のリクエスト数の上限までにダウンロードできるのは、約 {count} 件です。残りは {time} 以降にダウンロードします。",
	"pull.count.fetched": "更新 {count} 件",
	"pull.count.deleted": "削除 {count} 件",
	"pull.count.renamed": "名前の変更 {count} 件",
	"pull.count.conflicts": "競合 {count} 件",
	"pull.count.merged": "統合 {count} 件",
	"pull.summary": "ダウンロードが終わりました：{details}",
	"pull.refetched": "{count} 件のファイルは、まとめてダウンロードした中に無いか、中身が GitHub の一覧と合わなかったため、1件ずつダウンロードしました。",
	"pull.done": "ダウンロードが終わりました。",
	"pull.upToDate": "ダウンロードするものはありません。このデバイスは最新です。",
	"pull.remoteEmpty": "リポジトリは空です。ダウンロードするものはありません。",
	"pull.declined": "ダウンロードをやめました。何も変更していません。",
	"pull.declinedAfterTrash":
		"ダウンロードをやめました。下に示すファイルだけを、この保管庫の .trash/ へ移しました。ほかは何も変更していません。",
	"pull.cancelled": "ダウンロードを中止しました。次のダウンロードで、続きから進みます。",
	"pull.cancelledAfter": "中止するまでに済んだ分：{details}",
	"pull.connectionChanged":
		"接続先が変わったため、ダウンロードを中止しました。次のダウンロードは、新しい接続先で始めます。",
	"pull.failed": "ダウンロードに失敗しました。{reason}",
	"pull.error.incompleteListing":
		"リポジトリのファイルが多く、GitHub が1回で一覧を返せません（10万件を超えるか、一覧が 7MB を超えています）。そのため、Sync Evo では同期できません。",
	"pull.error.other": "詳細：{detail}",
	"pull.incomplete": "{count} 件のファイルをダウンロードできませんでした。次の同期で、もう一度試します。{reason}",
	"pull.incompleteSome": "一部のファイルをダウンロードできませんでした。次の同期で、もう一度試します。{reason}",
	"pull.reason.hashMismatch": "GitHub から受け取った内容が、GitHub の一覧と合いませんでした。",
	"pull.reason.trashFailed": "このデバイスのファイルを、この保管庫の .trash/ へ移せませんでした。",
	"pull.notDownloaded":
		"{count} 件のファイルの中身が、このデバイスにありません（クラウドドライブが仮のファイルだけを置いています）。クラウドドライブのアプリでこのデバイスに保存してから、もう一度同期してください：\n{list}",
	"pull.unreadable":
		"このデバイスのファイル {count} 件を読めませんでした。そのままにしてあります。ファイルを確かめてから、もう一度同期してください：\n{list}",
	"pull.waitingForUnread":
		"ほかに {count} 件のファイルも、上のファイルの後に回したため、ダウンロードしていません。上のファイルが片付くと、次の同期でダウンロードします。",
	"pull.waitingAlone":
		"{count} 件のファイルを、ダウンロードも削除もせず、次の同期に回しました。Sync Evo が知らせた、このデバイスの物が片付くのを待っています。",
	"pull.conflicts": "このデバイスのファイル {count} 件の内容を、競合ファイルとして残しました：\n{list}",
	"pull.conflict.conflict": "{copy}（競合。{path} は {remote} の内容になりました）",
	"pull.conflict.becameSymlink":
		"{copy}（{path} は {remote} でシンボリックリンクになりました。リンクは、このデバイスに書き込みません）",
	"pull.conflict.becameFolder": "{copy}（{path} は {remote} でフォルダになりました）",
	"pull.conflict.nameTaken": "{copy}（{remote} で、別のファイルの名前が {path} に変わりました）",
	"pull.merged":
		"このデバイスと {remote} の両方で変更していたファイル {count} 件を、両方の変更を入れた内容にしました。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ にあります：\n{list}",
	"pull.merged.item": "{path}（前の内容：{kept}）",
	"pull.replacedSettings":
		"設定フォルダのファイル {count} 件を、{remote} の内容にしました。このデバイスの前の内容は、この保管庫の .trash/ にあります：\n{list}",
	"pull.replacedSettings.brief": "設定フォルダのファイル {count} 件を、{remote} の内容にしました。",
	"pull.trashed":
		"ダウンロードで、{count} 件のファイルをこの保管庫の .trash/ へ移しました。内容は失われていません。そこから戻せます：\n{list}",
	"pull.trashed.brief": "{count} 件のファイルを .trash/ へ移しました。",
	"pull.halfWritten":
		"前のダウンロードが、{count} 件のファイルを書いている途中で止まっていました。残っていた内容は、この保管庫の .trash/ へ移しました。{remote} の内容を、ダウンロードし直します。その後に編集していた時は、そこから戻せます：\n{list}",
	"pull.halfMerged":
		"前のダウンロードが、統合した内容を {count} 件のファイルに書いている途中で止まっていました。ダウンロードし直すのは {remote} の内容で、このデバイスの変更は入りません。統合する前のこのデバイスの内容は、この保管庫の .trash/.sync-evo-merged/ にあります：\n{list}",
	"pull.halfCopies":
		"前のダウンロードが作りかけていた競合ファイル {count} 件を、この保管庫の .trash/ へ移しました。競合ファイルは作り直します。競合ファイルを編集していた時は、編集した内容がそこにあります：\n{list}",
	"pull.halfCopies.brief": "作りかけの競合ファイル {count} 件を .trash/ へ移しました。",
	"pull.tidiedCopies":
		"作ってから30日たった競合ファイル {count} 件を、_conflicts/ からこの保管庫の .trash/ へ移しました。残したい競合ファイルは、_conflicts/ の外へ移すか、名前を変えてください。",
	"pull.tidiedCopies.brief": "30日たった競合ファイル {count} 件を .trash/ へ移しました。",
	"pull.keptLocal":
		"選んだとおり、このデバイスのファイル {count} 件をそのまま残しました。{remote} の内容とは異なります：\n{list}",
	"pull.keptLocal.brief": "選んだとおり、{count} 件のファイルをそのまま残しました。",
	"pull.symlinks.brief": "{remote} のシンボリックリンク {count} 件をスキップしています。",
	"pull.symlinks":
		"{remote} にシンボリックリンクが {count} 件あります。Sync Evo は、このデバイスに書き込まず、{remote} でもそのままにします。スキップしているリンクは、設定画面で確認できます：\n{list}",

	"push.progress.starting": "アップロード：始めています…",
	"push.progress.listing": "アップロード：{remote} を確認中…",
	"push.progress.scanning": "アップロード：保管庫を確認中…",
	"push.progress.hashing": "アップロード：ファイルを比較中（{done}/{total}）…",
	"push.progress.sendingStart": "アップロード：ファイルを転送中…",
	"push.progress.sending": "アップロード：ファイルを転送中（{done}/{total}）…",
	"push.progress.finishing": "アップロード：仕上げています…",
	"push.progress.stopping": "アップロード：中止しています…",
	"push.progress.rateLimited":
		"GitHub の、ファイル作成の上限に達しました。{time} に続きをアップロードします。それまで、Obsidian を前に出したままにしてください。アップロードは、途中で止まると何もアップロードされません。",
	"push.count.added": "追加 {count} 件",
	"push.count.modified": "変更 {count} 件",
	"push.count.deleted": "削除 {count} 件",
	"push.summary": "アップロードが終わりました：{details}",
	"push.nothing": "アップロードするものはありません。{remote} は最新です。",
	"push.nothingSent": "何もアップロードしていません。アップロードできないファイルが残っています。理由は、前回の同期の結果にあります。",
	"push.recovered": "前回のアップロードは、できていました：{details}。このデバイスに記録しました。",
	"push.recoveredUntrack": "前に行った {remote} からの削除は、できていました（{count} 件）。このデバイスに記録しました。このデバイスのファイルは、そのままです。",
	"push.pullFirst.noBase":
		"何もアップロードしていません。このデバイスは、{remote} からの最初のダウンロードをまだ終えていません。先にダウンロードを行ってから、アップロードしてください。",
	"push.pullFirst.remoteEmpty":
		"何もアップロードしていません。このデバイスは、前にこのリポジトリと同期していますが、リポジトリが空になっています。先にダウンロードを実行して確かめてください。",
	"push.pullFirst.notDefaultBranch":
		"何もアップロードしていません。リポジトリは空です。GitHub は、空のリポジトリの最初のコミットを、既定のブランチ {branch} に作ります。Sync Evo の設定のブランチを {branch} にするか、GitHub でリポジトリの既定のブランチを変えてから、もう一度同期してください。",
	"push.pullFirst.gitignoreUnreadable":
		"何もアップロードしていません。何をアップロードするかは、この保管庫の .gitignore で決まりますが、このデバイスで読めません。クラウドドライブが仮のファイルだけを置いているか、.gitignore という名前のフォルダがあるか、大文字と小文字だけが違う名前（.GITIGNORE など）になっています。直してから、もう一度アップロードしてください。",
	"push.pullFirst.remoteMoved":
		"何もアップロードしていません。このアップロードを始めた後に、{remote} がほかのデバイスから変更されました。先にダウンロードを行ってから、もう一度アップロードしてください。",
	"push.pullFirst.gitignore":
		"何もアップロードしていません。何をアップロードするかを決める .gitignore の中身を、確かめられませんでした。もう一度同期してください。.gitignore をほかのアプリで開いている時は、閉じてから。",
	"push.declined": "アップロードをやめました。何もアップロードしていません。",
	"push.cancelled": "アップロードを中止しました。何もアップロードしていません。",
	"push.connectionChanged": "接続先が変わったため、アップロードを中止しました。何もアップロードしていません。",
	"push.failed": "アップロードに失敗しました。{reason}",
	"push.unfinished":
		"前の同期（{time}）では、アップロードが終わっていません。このデバイスの変更が、アップロードされていないことがあります。自動ではアップロードし直しません。同期を実行すると、今の内容でアップロードします。",
	"push.error.workflows":
		"GitHub がアップロードを拒否しました。.github/workflows/ の下のファイルを変更するには、トークンに Workflows の読み取りと書き込みの権限も必要です。",
	"push.error.notAsListed":
		"{remote} では何も変更していません。{remote} の中身が、このデバイスが知っている内容と違っていました。もう一度同期してください。",
	"push.storedOtherwise":
		"{remote} が、このデバイスがアップロードした内容と違う内容で保存したファイル：{count} 件。次のダウンロードで、このデバイスのファイルを {remote} の内容に置き換えます：\n{list}",
	"push.held":
		"{count} 件のファイルを、アップロードしていません。ダウンロードが済んでいないか、開いているファイルを保存できませんでした。もう一度同期してください：\n{list}",
	"push.remoteInTheWay":
		"{count} 件のファイルを、アップロードしていません。その場所に、このデバイスがまだダウンロードしていないファイルかフォルダが、{remote} にあります。先にダウンロードを行ってから、もう一度アップロードしてください：\n{list}",
	"push.caseCollision":
		"{count} 件の新しいファイルを、アップロードしていません。{remote} のほかのパス、またはほかの新しいファイルと、大文字と小文字だけが違い、区別できないデバイスがあるためです。名前を変えると、次の同期でアップロードします：\n{list}",
	"push.notDownloaded":
		"{count} 件の新しいファイルを、アップロードしていません。中身がこのデバイスに無いためです（クラウドドライブが仮のファイルだけを置いています）。クラウドドライブのアプリでこのデバイスに保存してから、もう一度同期してください：\n{list}",
	"push.grownTooLarge":
		"{count} 件のファイルを、アップロードしていません。アップロードの途中で {limit}MB を超えました。{limit}MB を超えるファイルは同期しません：\n{list}",
	"push.refusedSize":
		"{count} 件のファイルを、アップロードしていません。GitHub が、大きすぎるとして受け付けませんでした。このファイルは、小さくするか、保管庫の外へ移してください。{remote} にまだ無いファイルは、除外してもアップロードしなくなります。競合ファイルなら、中身を確かめてから削除してください：\n{list}",
	"push.refusedSpace":
		"{count} 件のファイルを、アップロードしていません。{remote} の容量が足りません。{remote} で空きを作ると、次の同期でアップロードします：\n{list}",
	"push.refusedWorkflows":
		"{count} 件のファイルを、アップロードしていません。.github/workflows/ の下のファイルを足すか変えるには、トークンに Workflows の読み取りと書き込みの権限が要ります。トークンに権限を足すと、次の同期でアップロードします。足さない時は、このファイルを元の内容に戻して、変更はパソコンの git で行ってください。前の版の Sync Evo が残した競合ファイル（名前に .conflict-from- が入る物）なら、中身を確かめてから削除してください：\n{list}",
	"push.remoteChanged":
		"{count} 件のファイルを、アップロードも削除もしていません。ほかのデバイスが、先に {remote} で変えていました。次の同期で、競合として扱います：\n{list}",
	"push.remoteChanged.brief": "{count} 件のファイルは、ほかのデバイスが先に {remote} で変えていました。次の同期で扱います。",
	"push.leftOut":
		"{count} 件のファイルを、アップロードしていません。アップロードの途中で変わったか、読めなかったか、開いているファイルを保存できませんでした。次のアップロードで、もう一度確かめます：\n{list}",

	"untrack.confirm.title": "{remote} から削除する確認",
	"untrack.confirm.proceed": "削除",
	"untrack.confirm.cancel": "やめる",
	"untrack.confirm.body":
		"次の {count} 件を {remote} から削除します。Sync Evo のデバイスのファイルは残ります（パソコンの git では、次の git pull で消えます）。",
	"untrack.confirm.missing":
		"このうち {count} 件は、このデバイスにありません。一覧に出した物には、印を付けています。{remote} から削除すると、中身は {remote} の履歴にだけ残ります。",
	"untrack.confirm.submodules": "除外しているサブモジュールも {count} 件あります。ここでは削除しません。パソコンの git で行ってください：",
	"untrack.item.tagged": "{path}（{tags}）",
	"untrack.tag.symlink": "シンボリックリンク",
	"untrack.tag.ownFolder": "Sync Evo 自身のフォルダ",
	"untrack.tag.missing": "このデバイスに無い",
	"untrack.done": "{remote} から {count} 件を削除しました。このデバイスのファイルは、そのままです。",
	"untrack.nothing": "{remote} から削除する物はありませんでした。一覧のファイルは、もう {remote} に無いか、除外しなくなっています。何も変更していません。",
	"untrack.kept":
		"{count} 件は、{remote} から削除していません。ほかのデバイスが、先に {remote} で変えていました。次の同期で取り込みます。除外したままなら、取り込んだ後に、もう一度削除してください：\n{list}",
	"untrack.remoteMoved": "{remote} から削除していません。その間に、{remote} がほかのデバイスから変更されました。Sync Evo の設定画面から、もう一度行ってください。",
	"untrack.cancelled": "{remote} からの削除を中止しました。何も削除していません。",
	"untrack.connectionChanged": "接続先が変わったため、{remote} からの削除を中止しました。何も削除していません。",
	"untrack.progress.running": "{remote} から削除しています…",
	"untrack.progress.stopping": "{remote} からの削除：中止しています…",
	"untrack.submodules":
		"{remote} に、除外しているサブモジュールが {count} 件あります。Sync Evo では、サブモジュールを削除できません。パソコンの git で行ってください。",
	"untrack.failed": "{remote} から削除できませんでした。{reason}",
	"untrack.syncFirst.remoteEmpty": "{remote} から削除していません。リポジトリが空になっています。先に同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.syncFirst.pullUnfinished":
		"{remote} から削除していません。このデバイスは、{remote} からのダウンロードをまだ終えていません。次の同期に残るファイルが無くなるまで同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.syncFirst.gitignoreUnsettled":
		"{remote} から削除していません。この保管庫の .gitignore の中身を、確かめられませんでした。同期してから、Sync Evo の設定画面で、もう一度行ってください。.gitignore をほかのアプリで開いている時は、閉じてから。",
	"untrack.syncFirst.gitignoreUnreadable":
		"{remote} から削除していません。この保管庫の .gitignore を、このデバイスで読めません。理由は、Sync Evo の設定画面に出ます。直してから、もう一度行ってください。",
	"untrack.syncFirst.noSection":
		"{remote} から削除していません。この保管庫の .gitignore に Sync Evo が管理する行が無く、除外の設定がファイルに書かれていません。Sync Evo の設定画面で行を足してから、もう一度行ってください。",
	"untrack.syncFirst.sectionBroken":
		"{remote} から削除していません。.gitignore の、Sync Evo が管理する行を囲む2つの印の行が、1組になっていません。Sync Evo の設定画面で直してから、もう一度行ってください。",
	"untrack.syncFirst.gitignoreDiffers":
		"{remote} から削除していません。{remote} の .gitignore が、このデバイスが最後に同期した物と違います。同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"untrack.skipped.pullDeclined": "ダウンロードをやめたため、{remote} から削除していません。除外の設定は残っています。後から、Sync Evo の設定画面で削除できます。",
	"untrack.skipped.pullCancelled": "ダウンロードを中止したため、{remote} から削除していません。除外の設定は残っています。後から、Sync Evo の設定画面で削除できます。",

	"state.waiting": "準備中…",
	"state.newerVersion": "この保管庫は、新しいバージョンの Sync Evo で同期されています。同期するには、プラグインを更新してください。何も変更していません。",
	"state.noAppId": "Obsidian からこの保管庫の ID を取得できないため、同期できません。",
	"state.noIndexedDb": "このデバイスでは、Sync Evo が使う保存の仕組み（IndexedDB）を使えないため、同期できません。",
	"state.openFailed": "同期の準備ができなかったため、同期していません。Obsidian を再起動して、もう一度試してください。",
	"state.discardFailed": "前の接続先の片付けができなかったため、同期していません。Obsidian を再起動して、もう一度試してください。",

	"confirm.proceed": "進める",
	"confirm.keepLocal": "このデバイスのファイルを残す",
	"confirm.cancel": "やめる",
	"confirm.delete.title": "ファイル削除の確認",
	"confirm.delete.body":
		"このデバイスにあるファイル {count} 件が、{remote} で削除されたか、シンボリックリンクに変わっています。ダウンロードすると、このデバイスから削除されます。",
	"confirm.delete.note": "やめた場合は、何もダウンロードせず、何も変更しません。",
	"confirm.firstFetch.title": "最初のダウンロードの確認",
	"place.repository": "{repository} のブランチ {branch}",
	"place.folder": "Dropbox の「アプリ/Sync Evo/{folder}」フォルダ",
	"remotePlace.repository": "{remote}（{repository} のブランチ {branch}）",
	"remotePlace.folder": "Dropbox の「アプリ/Sync Evo/{folder}」フォルダ",
	"place.gdriveFolder": "Google Drive の「Sync Evo/{folder}」フォルダ",
	"remotePlace.gdriveFolder": "Google Drive の「Sync Evo/{folder}」フォルダ",
	"confirm.firstFetch.body": "{place} から、この保管庫に初めてダウンロードします。この保管庫には、すでにファイルがあります。",
	"confirm.firstFetch.different":
		"{remote} と中身が違うファイル：{count} 件。{remote} の内容に書き換えます。このデバイスの内容は、_conflicts/ フォルダに競合ファイルとして残します。",
	"confirm.firstFetch.differentSettings":
		"{remote} と中身が違う設定フォルダのファイル：{count} 件。{remote} の内容に書き換えます。このデバイスの内容は、この保管庫の .trash/ へ移します。",
	"confirm.firstFetch.localOnly":
		"このデバイスにだけあるファイル：{count} 件。このデバイスに、そのまま残します。次のアップロードに入ります。アップロードの前に、ファイルの一覧を示して、もう一度確認を求めます。除外しているファイルは、アップロードしません。",
	"confirm.firstFetch.atSymlinks":
		"{remote} でシンボリックリンクになっているパスにあるファイル：{count} 件。比べずに、そのまま残します。",
	"confirm.firstPush.title": "最初のアップロードの確認",
	"confirm.firstPush.body":
		"このデバイスから {place} へ、初めてアップロードします。{remote} を、下のとおりに変更します。アップロードが1回済むと、次からのアップロードでは、この一覧を出しません。",
	"confirm.firstPush.remoteEmpty":
		"リポジトリは空です。この保管庫に .gitignore が無い時は、空の .gitignore を作ってアップロードします。",
	"confirm.firstPush.remoteEmptyWithGitignore": "リポジトリは空です。",
	"confirm.firstPush.added": "追加するファイル：{count} 件",
	"confirm.firstPush.modified": "変更するファイル：{count} 件",
	"confirm.firstPush.deleted": "削除するファイル：{count} 件",
	"confirm.pushDelete.body":
		"このデバイスで削除したファイル {count} 件を、{remote} からも削除します。ほかのデバイスでも、ダウンロードすると削除されます。",
	"confirm.pushDelete.alsoSent": "同じアップロードに、下のファイルも入ります。",
	"confirm.emptyVault.title": "保管庫にファイルがありません",
	"confirm.emptyVault.bodyOne":
		"前に同期したファイル {count} 件が、このデバイスにありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。{remotePlace}には、まだあります。",
	"confirm.emptyVault.body":
		"前に同期したファイル {count} 件が、このデバイスに1つもありません。保管庫を作り直した時や、フォルダを消した時に、こうなります。{remotePlace}には、まだあります。",
	"confirm.emptyVault.refetch": "{remote} からダウンロードし直す",
	"confirm.emptyVault.refetchNote":
		"{remote} のファイルを、このデバイスにダウンロードします。{remote} からは、何も消しません。",
	"confirm.emptyVault.delete": "{remote} からも削除する",
	"confirm.emptyVault.deleteNote":
		"{count} 件を、{remote} からも削除します。ほかのデバイスでも、ダウンロードすると削除されます。",
	"confirm.emptyVault.cancelNote": "何もアップロードせず、何も変更しません。",
	"confirm.push.note": "やめた場合は、何もアップロードせず、何も変更しません。",
	"confirm.push.noteSection": "やめた場合は、何もアップロードしません。.gitignore に足した行は、このデバイスに残り、次のアップロードに入ります。",
	"confirm.startOver.title": "最初からやり直す",
	"confirm.startOver.body": "{remotePlace}と比べ直します。ファイルは、このデバイスでも {remote} でも削除しません。",
	"confirm.startOver.nothing":
		"{remote} と中身が違うファイルも、このデバイスにだけあるファイルも、ありません。",
	"confirm.startOver.note": "やめた場合は、何も変更しません。",
	"confirm.rewritten.title": "リポジトリの履歴の書き換え",
	"confirm.rewritten.body":
		"リポジトリの履歴が、このデバイスが最後に同期した時点から続いていません（force push の後など）。このデバイスからアップロードした変更が、{remote} から消えている可能性があります。{remote} に合わせると、下のファイルがこのデバイスから失われます。",
	"confirm.rewritten.deletions": "削除するファイル：{count} 件",
	"confirm.rewritten.overwrites": "{remote} の内容で上書きするファイル：{count} 件",
	"confirm.rewritten.trashNote":
		"「進める」を選ぶと、{remote} に合わせます。これらのファイルは、先にこの保管庫の .trash/ へ移すので、後から戻せます。",
	"confirm.rewritten.keepNote":
		"「このデバイスのファイルを残す」を選ぶと、これらのファイルをそのままにして、ほかの変更だけをダウンロードします。「やめる」を選ぶと、何もダウンロードしません。",
	// What Dropbox has no repository, commit or history for (`DROPBOX_VARIANT`).
	"check.unreachable.dropbox":
		"Dropbox に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
	"check.rateLimited.dropbox":
		"Dropbox が、しばらく待つよう求めています。しばらくしてから、もう一度試してください。",
	"confirm.firstPush.remoteEmpty.dropbox":
		"Dropbox に、このフォルダはまだありません。この保管庫に .gitignore が無い時は、空の .gitignore を作ってアップロードします。",
	"confirm.firstPush.remoteEmptyWithGitignore.dropbox":
		"Dropbox に、このフォルダはまだありません。",
	"pull.remoteEmpty.dropbox":
		"Dropbox に、このフォルダはまだありません。ダウンロードするものはありません。",
	"confirm.rewritten.title.dropbox":
		"Dropbox のフォルダが消えています",
	"confirm.rewritten.body.dropbox":
		"Dropbox のこの保管庫のフォルダが、このデバイスが最後に同期した後に、消されたか空になっています。このデバイスからアップロードした変更が、{remote} から消えている可能性があります。{remote} に合わせると、下のファイルがこのデバイスから失われます。",
	"auto.waiting.rewritten.dropbox":
		"Dropbox のこの保管庫のフォルダが、消されたか空になっているため、ダウンロードする前に確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"push.pullFirst.remoteEmpty.dropbox":
		"何もアップロードしていません。このデバイスは、前にこのフォルダと同期していますが、Dropbox にフォルダがありません。先にダウンロードを実行して確かめてください。",
	"untrack.syncFirst.remoteEmpty.dropbox":
		"{remote} から削除していません。Dropbox にフォルダがありません。先に同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"pull.reason.hashMismatch.dropbox":
		"Dropbox から受け取った内容が、Dropbox の一覧と合いませんでした。",
	"confirm.delete.body.dropbox":
		"このデバイスにあるファイル {count} 件が、{remote} で削除されています。ダウンロードすると、このデバイスから削除されます。",
	"settings.deviceName.desc.dropbox":
		"競合ファイルの名前に使われます。",
	// What Google Drive has no repository, commit or history for (`GDRIVE_VARIANT`).
	"check.unreachable.gdrive":
		"Google Drive に接続できませんでした。ネットワーク接続を確かめて、もう一度試してください。",
	"check.rateLimited.gdrive":
		"Google Drive が、しばらく待つよう求めています。しばらくしてから、もう一度試してください。",
	"confirm.firstPush.remoteEmpty.gdrive":
		"Google Drive に、このフォルダはまだありません。この保管庫に .gitignore が無い時は、空の .gitignore を作ってアップロードします。",
	"confirm.firstPush.remoteEmptyWithGitignore.gdrive":
		"Google Drive に、このフォルダはまだありません。",
	"pull.remoteEmpty.gdrive":
		"Google Drive に、このフォルダはまだありません。ダウンロードするものはありません。",
	"confirm.rewritten.title.gdrive":
		"Google Drive のフォルダが消えています",
	"confirm.rewritten.body.gdrive":
		"Google Drive のこの保管庫のフォルダが、このデバイスが最後に同期した後に、消されたか空になっています。このデバイスからアップロードした変更が、{remote} から消えている可能性があります。{remote} に合わせると、下のファイルがこのデバイスから失われます。",
	"auto.waiting.rewritten.gdrive":
		"Google Drive のこの保管庫のフォルダが、消されたか空になっているため、ダウンロードする前に確認が必要です。何も変更していません。手動で同期すると、確認が表示されます。",
	"push.pullFirst.remoteEmpty.gdrive":
		"何もアップロードしていません。このデバイスは、前にこのフォルダと同期していますが、Google Drive にフォルダがありません。先にダウンロードを実行して確かめてください。",
	"untrack.syncFirst.remoteEmpty.gdrive":
		"{remote} から削除していません。Google Drive にフォルダがありません。先に同期してから、Sync Evo の設定画面で、もう一度行ってください。",
	"pull.reason.hashMismatch.gdrive":
		"Google Drive から受け取った内容が、Google Drive の一覧と合いませんでした。",
	"confirm.delete.body.gdrive":
		"このデバイスにあるファイル {count} 件が、{remote} で削除されたか、ゴミ箱に入ったか、同期先のフォルダの外へ動かされています。ダウンロードすると、このデバイスから削除されます。",
	"settings.deviceName.desc.gdrive":
		"競合ファイルの名前に使われます。",
});
