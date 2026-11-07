# super-dictation-jp — 毎日の聞き取りドリル

音声を聞いて、2つのクイズに答える小学・中学生向けの聞き取り学習サイト。
**400パターン × 2クイズ = 800問**、全問に音声つき。

- 公開URL: **https://sd-jp.pages.dev/**

## 遊び方

1. ホームでレベル(簡単 / 標準 / 応用 / 難関 / 最難関)を選んで「始める」
2. 音声を聞いて問題を解く(1問に2クイズ、1セット5問=10点満点)
3. 「答え合わせ」で採点(◎◯△✕)と音声の文を表示。**答え合わせ後は上の「音声を聞こう」で何度でも聞き直せる**
4. ホームにきょうの採点・昨日までの平均・7日ぶんの履歴が記録される(IndexedDB・端末内のみ、広告/解析なし)

初めての人は「音声つきデモ(声あり 5問)」で試せる(記録には残らない)。

## 構成

| パス | 内容 |
|---|---|
| `web/` | 公開本体(index.html / quiz.html / data.js / assets/ / audio/*.mp3) |
| `web/README.md` | サイト仕様の詳細 |
| `tools/build_all.py` | md問題ソース → data.js 変換 + 未生成音声の自動生成(全量生成ツール) |
| `tools/convert_md_data.py` | md → data.js 変換モジュール |
| `tts/generate_batch.py` | TTSバッチ生成(Irodori v4.1 small MLX 版) |
| `簡単.md` 〜 `最難関.md` | 問題ソース(全400パターン) |
| `概要.md` | 仕様・パターンの考え方 |

## ローカル実行

```bash
cd web
python3 -m http.server 8642
# → http://localhost:8642
```

## データ・音声の再生成

```bash
# md → data.js の変換 + 未生成の音声だけ生成(既存音声はそのまま)
python3 tools/build_all.py

# 音声を含めて全問強制再生成
python3 tools/build_all.py --force

# 単一問題だけ再生成(例: 2-01-1)
python3 tools/build_all.py --ids 2-01-1 --force
```

TTS は `irodori` モジュール(MPS/MLX)を使う。音声生成の実行環境・手順は `web/README.md` の「全量自動生成」を参照。

## 公開(Cloudflare Pages)

```bash
wrangler pages deploy web --project-name sd-jp --branch main
```

詳細は `super-dictation-jp.md`(保守メモ)を参照。

## Author

- **Yuki_Orita** (折田悠希)
- 公式サイト: https://studio-rizi.pages.dev/
- GitHub: https://github.com/oriyu90

## License

[MIT](LICENSE)
