#!/usr/bin/env python3
"""super-dictation-jp 用 TTS バッチ生成スクリプト(Irodori-TTS v4.1-Small MLX版)。

問題md(簡単.md/標準.md/応用.md/難関.md/最難関.md)から「文:」行を読み取り、
レベルごとの声設定で mp3 を生成する。

使い方(irodori-tts環境のpythonで実行):
    /Users/yuki/Downloads/irodori-tts/.venv/bin/python generate_batch.py \
        --inputs /Users/yuki/Downloads/super-dictation-jp/簡単.md \
        --out-dir /Users/yuki/Downloads/super-dictation-jp/tts/outputs/簡単

    # 全レベル一括
    /Users/yuki/Downloads/irodori-tts/.venv/bin/python generate_batch.py --all
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from mlx_audio.tts.generate import generate_audio  # noqa: E402

MODEL = "mlx-community/Irodori-TTS-v4.1-Small-fp16"
BASE_DIR = Path("/Users/yuki/Downloads/super-dictation-jp")

# レベルごとの声設定(VoiceDesignキャプション)。必要なら書き換え。
CAPTIONS = {
    "簡単": "明るく丁寧で、聞き取りやすい若い女性話者",
    "標準": "落ち着いていて明るく、聞き取りやすい女性話者",
    "応用": "落ち着いていて明るく、聞き取りやすい女性話者",
    "難関": "落ち着いた、はっきりとした距離感の近い女性話者",
    "最難関": "落ち着いた、はっきりとした距離感の近い男性話者",
}

文_RE = re.compile(r"^文:\s*(.+)$", re.MULTILINE)


def parse_pat_entries(md_path: Path) -> list[tuple[str, str]]:
    """mdから「パターン見出し → 文」の一覧を返す。名前は「種名_パターンN」。"""
    text = md_path.read_text(encoding="utf-8")
    entries: list[tuple[str, str]] = []
    current_species = ""
    current_pat = None
    for line in text.splitlines():
        if line.startswith("## "):
            current_species = line[3:].strip().replace(" ", "_")
        elif line.startswith("### パターン"):
            current_pat = line.replace("### パターン", "").strip()
        elif line.startswith("文: ") and current_pat:
            name = f"{current_species}_パターン{current_pat}"
            entries.append((name, line[len("文: "):].strip()))
    return entries


def run(level: str, out_dir: Path, overwrite: bool = False, fmt: str = "mp3") -> None:
    md_path = BASE_DIR / f"{level}.md"
    entries = parse_pat_entries(md_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    caption = CAPTIONS[level]
    print(f"[{level}] {len(entries)}パターン, model={MODEL}, caption={caption}")
    n_done = 0
    for name, text in entries:
        if not overwrite and (any(out_dir.glob(f"{name}*.wav")) or any(out_dir.glob(f"{name}*.mp3"))):
            print(f"  skip(exists): {name}")
            continue
        generate_audio(
            model=MODEL,
            text=text,
            instruct=caption,
            file_prefix=name,
            audio_format=fmt,
            output_path=str(out_dir) + "/",
        )
        n_done += 1
        print(f"  done: {name}")
    print(f"[{level}] 完了: 新規生成 {n_done}/{len(entries)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", nargs="*", help="mdファイルのフルパス(簡単.md等)")
    ap.add_argument("--all", action="store_true", help="全5レベルを一括生成")
    ap.add_argument("--out-root", default=None, help="出力ルート(既定: super-dictation-jp/tts/outputs)")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--format", default="mp3", choices=["mp3", "wav"], help="出力形式(既定: mp3)")
    args = ap.parse_args()

    out_root = Path(args.out_root) if args.out_root else BASE_DIR / "tts/outputs"
    if args.all:
        levels = list(CAPTIONS)
    else:
        levels = [Path(p).stem for p in args.inputs or []]
    for level in levels:
        run(level, out_root / level, overwrite=args.overwrite, fmt=args.format)


if __name__ == "__main__":
    main()
