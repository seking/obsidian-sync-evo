# ライセンス

[English](https://github.com/seking/obsidian-sync-evo/blob/main/docs/third-party-licences.md)

Copyright (C) 2026 seking

Sync Evo は2つの部分に分かれ、ライセンスが違います。どのファイルがどちらのライセンスかは、[LICENSE](../../LICENSE) にあります。どちらも無保証です。

- `pro/` のフォルダ以外（同期の本体と GitHub）は、GNU Affero General Public License バージョン3のみ（`AGPL-3.0-only`）のもとで配布する自由ソフトウェアです。全文は [LICENSE-AGPL](../../LICENSE-AGPL) にあります。
- `pro/` のフォルダ（Dropbox、Google Drive、ライセンスキーの照合）は、Elastic License 2.0（`Elastic-2.0`）のもとでソースを公開しています。全文は [pro/LICENSE](../../pro/LICENSE) にあります。

ソースコードは <https://github.com/seking/obsidian-sync-evo> にあります。

## 同梱しているライブラリのライセンス

配布する `main.js` には、下のパッケージが同梱されています。それぞれの著作権表示とライセンスの全文は、`main.js` の先頭にもあります。

| パッケージ | バージョン | ライセンス | 著作権 |
| --- | --- | --- | --- |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| [ignore](https://github.com/kaelzhang/node-ignore) | 7.0.12 | MIT | Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors |
| [node-diff3](https://github.com/bhousel/node-diff3) | 3.2.1（[1か所の変更](https://github.com/seking/node-diff3/commit/8b787fe55d7979b37d7116aed2b2c91f31600c45)あり） | MIT | Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net><br>Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net><br>Copyright (c) 2019-2026 Bryan Housel <bhousel@gmail.com> |
