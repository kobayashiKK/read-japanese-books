# read-japanese-books

日本語EPUBをVOICEVOX音声でAudibleのように聴くための読み上げアプリ（開発中）。

## 現在の状態: プロトタイプ

`index.html` は本実装前の検証用プロトタイプです。
iPhoneのSafariで、**画面ロック中も短い音声チャンクの切り替わりをまたいで再生が続くか**を検証します。
ここが動けば、このアプリはWebアプリ（GitHub Pages）として実装できます。

### 使い方

1. https://kobayashikk.github.io/read-japanese-books/ を開く
2. VOICEVOX APIキー（https://voicevox.su-shiki.com/su-shikiapis/ で取得）を入力して「テスト開始」
3. 音声が流れたら画面をロックし、3〜5分放置
4. 画面を開いてログを確認。ロック中も文の切り替わりが進んでいれば検証成功

APIキーは端末のlocalStorageにのみ保存され、リポジトリには含まれません。

## ドキュメント

- [機能仕様書](docs/機能仕様書.md) — 機能一覧、VOICEVOX API調査結果、技術仕様
