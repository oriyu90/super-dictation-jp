# super-dictation-jp 保守メモ(備考事項)

> このファイルは公開サイトには載せない、次回以降の開発向けメモを集めるもの(共通ルール6)。

## 公開

- 正規URL: **https://sd-jp.pages.dev/**(Cloudflare Pages プロジェクト `sd-jp`、Direct Upload 型)
- 更新手順:

```bash
# 1. 手元で確認
cd web && python3 -m http.server 8642

# 2. デプロイ(リポジトリの web/ がそのまま公開ルート)
wrangler pages deploy web --project-name sd-jp --branch main
```

- GitHub 連携ではなく手動デプロイ運用。コードを変えたら上記コマンドを実行する。
- Cloudflare API トークンを使う場合は `CLOUDFLARE_API_TOKEN` を環境変数で渡す(リポジトリに書かない)。
- `studio-rizi.pages.dev/projects/super-dictation-jp/` に紹介サイトがある。アプリ本体のURL変更時は紹介サイト側のリンク・canonical も同じ作業で直す。

## 次回バージョンアップ時に更新すべき箇所

- JS/CSS を変えたらキャッシュバスターを上げる: `index.html` と `quiz.html` の `?v=11`(次は `?v=12`)。
- 問題を増減したら: md ソース → `python3 tools/build_all.py`(data.js 再生成 + 未生成音声のみ生成)→ `web/README.md` の数字(400パターン/800問)を合わせる。
- デモ問題を変えたら: `web/assets/js/quiz.js` の `DEMO_IDS`(現在 `2-01-1〜2-01-5` 5問)と `web/assets/js/app.js`、`index.html` の文言「音声つきデモ(声あり 5問)」を揃える。

## 仕様上の決めごと(実装メモ)

- 採点 = 正解クイズ数。1問=最大2点、5問=10点満点。進捗バーは5セル(◎2点/△1点/✕0点)。
- 音声ルール: 1問につき1回(途中の一時停止→再開は可)。**答え合わせまでは**再再生不可、**答え合わせ後は**上の「音声を聞こう」ボタン・スペースキーで何度でも聞き直せる(`S.replayGranted` で制御)。要約部分に「音声をもう一度聴く」ボタンは出さない(仕様)。
- 数字の答えは空ます式(答え桁数ぶんのます、タップで0〜9ポップ)。ますの上にまとまり表示行(未入力けた「▢」)。
- 選択肢ポップは上から数字順(左列0→4/右列5→9)、画面内にクランプ。
- 途中でやめる→「ここでやめますか。」確認ポップ。やめると未完セッションのみ削除(回答記録の有無で判定、`done` フラグは使わない)。
- IndexedDB: DB名 `super-dictation-jp`、store `sessions`(keyPath `sid`)/ `answers`(autoIncrement)。全データ端末内のみ、外部送信なし。
- 「four の数字4択」は `choice-list` ボタン式が正仕様(数字ます式ではない)。

## 音声生成の注意

- TTS は `irodori`(v4.1 small MLX)を使用。通常の `python3` では依存が足りないため、専用 venv で実行する(手元環境: `~/Downloads/irodori-tts/.venv/bin/python`)。
- `tools/build_all.py` は 5KB 未満の生成物を破損扱い(fail)にする。stray `_000` ファイルは自動リネーム。
- 音声追加後は `web/audio/` 全体をコミットし、デプロイする。

## 今後の予定(アイデア)

- 独自ドメイン取得(取得したら Pages のカスタムドメイン設定 + 紹介サイト・README のURL更新)。
- 問題の追加(5種×5パターン × 各レベルの拡張)。
- 合成音声の声質・速度の微調整(再生速度ボタンは quiz.js に実装済み)。
