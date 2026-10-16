# Sync Evo

[English](https://github.com/seking/obsidian-sync-evo/blob/main/README.md)

保管庫を、すべてのデバイスで同期します。使うのは自分の GitHub か Dropbox で、無料です。

スマートフォンでもパソコンでも動きます。Git のインストールは要りません。

<!-- TODO: screenshot -->

## Sync Evo の特長

**自分のストレージで、無料。** ノートは、自分の GitHub のリポジトリか Dropbox に保存されます。開発者にアカウントを作る必要は無く、間にサーバーもありません。

**スマートフォンと大きな保管庫のために作りました。** 数千ファイルの最初のダウンロードは、途中で止まっても、続きから進みます。

**ノートを上書きしません。** 2台のデバイスで変えたノートは、統合するか、両方を残します。多くのファイルを削除する前には、確認します。

**GitHub に履歴が残ります。** アップロードのたびにコミットになります。ノートの前のバージョンは、リポジトリの履歴に残ります。

**同期する物を選べます。** フォルダ（全デバイス、またはこのデバイスだけ）、このデバイスのファイルの種類、保管庫の設定の一部を、除外できます。

**自動同期は、邪魔をしません。** 有効にすると、起動時と一定の間隔で同期します。問題が無い時は、何も知らせません。

## GitHub か Dropbox か

- **GitHub のアカウントが無いなら、Dropbox を。** [無料の Dropbox アカウント](https://www.dropbox.com/register)で足ります。ログインするだけで、リポジトリやトークンを作る必要はありません。
- **GitHub が向くのは**、すでにアカウントがある時、パソコンで Git を使う時、変更をすべて残したい時です。

[GitHub と Dropbox の比較](https://github.com/seking/obsidian-sync-evo/blob/main/docs/github-or-dropbox.md)

## 始め方

### インストール

Sync Evo は、まだコミュニティプラグインの一覧にありません。[BRAT](https://github.com/TfTHacker/obsidian42-brat) でインストールします。

1. 設定 → コミュニティプラグインで、**制限モード**がオンならオフにします。**閲覧**を押し、**BRAT**を検索して、インストールし、有効にします。
2. 設定 → BRAT で**Add beta plugin**を押し、`https://github.com/seking/obsidian-sync-evo` を入力します。バージョンは最新のままにして、追加します。
3. 設定 → コミュニティプラグインで、**Sync Evo**を有効にします。更新は BRAT が行います。

### GitHub

1. 保管庫のリポジトリが無ければ、GitHub で[空のプライベートリポジトリを作ります](https://github.com/new)。[GitHub のアカウント](https://github.com/signup)が無ければ、先に作ります。無料です。
2. [トークンを作り](https://github.com/settings/personal-access-tokens/new?name=Sync+Evo&description=Obsidian+Sync+Evo&expires_in=90&contents=write)、そのページで保管庫のリポジトリを選びます。
3. 設定 → コミュニティプラグイン → Sync Evo で、**リポジトリ**と**ブランチ**を入力し、**トークン**をシークレットとして保存します。
4. **テスト**を押します。次に同期します。リボンの**同期する**のアイコン（円を描く2本の矢印）をタップするか、コマンドパレットで**Sync Evo: 同期する**を実行します。

### Dropbox

1. Dropbox のアカウントが無ければ、[作ります](https://www.dropbox.com/register)。無料です。
2. 設定 → コミュニティプラグイン → Sync Evo で、**サービス**を**Dropbox**にします。
3. **接続する**を押し、ブラウザで Sync Evo を許可します。
4. **テスト**を押し、GitHub の手順 4 と同じように同期します。

[手順の詳しい説明](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)

## 知っておくこと

- 保管庫に `.git` フォルダがある時は、そのデバイスでは git で同期してください。[理由](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md#my-vault-has-a-git-folder)
- iCloud Drive の保管庫も使えますが、対応は試験的です。[詳細](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- 「インストールされているコミュニティプラグイン」を同期すると、ほかのデバイスから来たプラグインのコードが動きます。[詳細](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#installed-community-plugins)
- 「アクティブなコミュニティプラグインのリスト」を同期するなら、全デバイスで Sync Evo を有効にしておいてください。[理由](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md#active-community-plugin-list)

## 通信とプライバシー

Sync Evo が接続するのは、GitHub（`api.github.com`、`codeload.github.com`）か Dropbox（`api.dropboxapi.com`、`content.dropboxapi.com`、`www.dropbox.com`）だけです。どちらも保管庫の同期に使い、通信するのは、同期する時と、自動同期を有効にしている時だけです。ほかへは何も送りません。利用状況は集めず、開発者のサーバーもありません。GitHub か Dropbox のアカウントが必要です。[詳細](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)

## 詳しく知る

- [セットアップの手順](https://github.com/seking/obsidian-sync-evo/blob/main/docs/setup.md)
- [GitHub か Dropbox か](https://github.com/seking/obsidian-sync-evo/blob/main/docs/github-or-dropbox.md)
- [同期のしくみ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md)と[コマンド](https://github.com/seking/obsidian-sync-evo/blob/main/docs/syncing.md#commands)
- [設定](https://github.com/seking/obsidian-sync-evo/blob/main/docs/settings.md)
- [Dropbox](https://github.com/seking/obsidian-sync-evo/blob/main/docs/dropbox.md)
- [iCloud Drive の保管庫](https://github.com/seking/obsidian-sync-evo/blob/main/docs/icloud.md)
- [制限、未対応のこと、試験した環境](https://github.com/seking/obsidian-sync-evo/blob/main/docs/limits.md)
- [通信とプライバシー](https://github.com/seking/obsidian-sync-evo/blob/main/docs/network.md)
- [よくある質問](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md)
- [ドキュメントの一覧](https://github.com/seking/obsidian-sync-evo/blob/main/docs/README.md)

## ヘルプ

[よくある質問](https://github.com/seking/obsidian-sync-evo/blob/main/docs/faq.md)を見るか、[issue](https://github.com/seking/obsidian-sync-evo/issues) を開いてください。報告には、トークンや人に見せたくないファイル名を書かないでください。

## ライセンス

Copyright (C) 2026 seking. [AGPL-3.0-only](https://github.com/seking/obsidian-sync-evo/blob/main/LICENSE) のもとで配布します。無保証です。

同梱しているライブラリのライセンスは、[このページ](https://github.com/seking/obsidian-sync-evo/blob/main/docs/third-party-licences.md)にあります。

Sync Evo をビルドする時や、開発に協力する時は、[CONTRIBUTING.md](https://github.com/seking/obsidian-sync-evo/blob/main/CONTRIBUTING.md) を見てください。
