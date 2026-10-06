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
});
