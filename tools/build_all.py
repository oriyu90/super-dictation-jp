#!/usr/bin/env python3
"""super-dictation-jp 全生成ツール(決定版)。

問題md → web/data.js 変換と、全問題ぶんの TTS 音声(NO MLX 推論)をまとめて行う。

  使い方: /Users/yuki/Downloads/irodori-tts/.venv/bin/python tools/build_all.py

オプション:
  --ids 2-01-1,2-01-2   このIDだけ生成
  --limit 20            今回の実行で生成する最大数(続きから再開できる)
  --skip-data           md→data.js の変換を省く
  --skip-audio          音声生成を省く(data.js だけ作る)
  --force               既存 mp3 があっても作り直す
  --dry-run             生成対象の一覧と所要見込みだけ表示(何も作らない)
  --verbose             mlx_audio の生ログを出す

補足:
  - web ページは index.html / quiz.html が data.js の全問題をそのまま扱うので、
    個別の問題ページ生成は不要。作るのは data.js と audio/*.mp3。
  - 音声生成は1問7〜10秒程度。全800問ぶんは ~2時間。 --limit で分けて実行できる。
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
TOOLS = BASE / "tools"
DATA = BASE / "web/data.js"
AUDIO = BASE / "web/audio"
MODEL = "mlx-community/Irodori-TTS-v4.1-Small-fp16"

CAPTIONS = {
    "簡単": "明るく丁寧で、聞き取りやすい若い女性話者",
    "標準": "落ち着いていて明るく、聞き取りやすい女性話者",
    "応用": "落ち着いていて明るく、聞き取りやすい女性話者",
    "難関": "落ち着いた、はっきりとした近い距離感の女性話者",
    "最難関": "落ち着いた、はっきりとした近い距離感の男性話者",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def build_data() -> None:
    """問題md → web/data.js(convert_md_data.py を呼ぶ)"""
    log("[1/2] 問題データ: 問題md → web/data.js")
    r = subprocess.run([sys.executable, str(TOOLS / "convert_md_data.py")], cwd=str(TOOLS))
    if r.returncode != 0:
        sys.exit("data.js の生成に失敗しました")
    qs = load_questions()
    if not qs:
        sys.exit("data.js が空です。問題md(簡単.md〜最難関.md)を確認してください")
    bad = [e["id"] for e in qs if not e.get("text") or len(e.get("qs", [])) != 2]
    if bad:
        sys.exit(f"問題データが不完全です(md を確認): {bad[:5]}")
    lv: dict[str, int] = {}
    tn: dict[str, int] = {}
    for e in qs:
        lv[e["level"]] = lv.get(e["level"], 0) + 1
        for q in e["qs"]:
            tn[q["type"]] = tn.get(q["type"], 0) + 1
    qn = sum(len(e["qs"]) for e in qs)
    log(f"      終了: {len(qs)}パターン / {qn}問"
        f"  (レベル: {lv}  型: {tn})")


def load_questions() -> list[dict]:
    """web/data.js を読んで [{id, level, text, ...}] を返す"""
    if not DATA.exists():
        return []
    text = DATA.read_text("utf-8")
    text = re.sub(r"^//.*\n", "", text, flags=re.M)
    text = text.replace("window.QUESTIONS = ", "", 1).strip().rstrip(";")
    return json.loads(text)["questions"]


def pick_audio(ids_filter: list[str] | None, qs: list[dict]) -> list[dict]:
    if ids_filter:
        by_id = {e["id"]: e for e in qs}
        unknown = [i for i in ids_filter if i not in by_id]
        if unknown:
            sys.exit(f"問題データにないID: {', '.join(unknown)}")
        return [by_id[i] for i in ids_filter]
    return qs


def existing_or_stray(qid: str) -> Path | None:
    """既存の qid.mp3、または mlx_audio がつくる qid_000.mp3(stray)を返す"""
    direct = AUDIO / f"{qid}.mp3"
    if direct.exists():
        return direct
    stray = AUDIO / f"{qid}_000.mp3"
    if stray.exists():
        stray.rename(direct)
        return direct
    return None


def tts_audio(entry: dict, force: bool, verbose: bool) -> str:
    """1問ぶんの音声を生成。OK / skip / fail を返す"""
    qid = entry["id"]
    out = AUDIO / f"{qid}.mp3"
    if out.exists() and not force:
        return "skip"
    if existing_or_stray(qid) and not force:
        return "skip"
    if force and out.exists():
        out.unlink()
    AUDIO.mkdir(parents=True, exist_ok=True)
    caption = CAPTIONS.get(entry["level"], CAPTIONS["標準"])
    buf = io.StringIO()
    if verbose:
        from mlx_audio.tts.generate import generate_audio  # 既に venv で import 済みのはず
        generate_audio(
            model=MODEL,
            text=entry["text"],
            instruct=caption,
            file_prefix=qid,
            audio_format="mp3",
            output_path=str(AUDIO) + "/",
        )
    else:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            from mlx_audio.tts.generate import generate_audio  # noqa: E402
            generate_audio(
                model=MODEL,
                text=entry["text"],
                instruct=caption,
                file_prefix=qid,
                audio_format="mp3",
                output_path=str(AUDIO) + "/",
            )
    if not existing_or_stray(qid):
        return "fail"
    if out.stat().st_size < 5 * 1024:
        return "fail"
    return "ok"


def fmt_span(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ids", help="生成するID(カンマ区切り)。未指定=データ全部")
    ap.add_argument("--limit", type=int, default=0, help="今回生成する最大数(0=無制限)")
    ap.add_argument("--skip-data", action="store_true", help="md→data.js 変換をしない")
    ap.add_argument("--skip-audio", action="store_true", help="音声生成をしない")
    ap.add_argument("--force", action="store_true", help="既存 mp3 を作り直す")
    ap.add_argument("--dry-run", action="store_true", help="対象一覧と所要見込みだけ表示")
    ap.add_argument("--verbose", action="store_true", help="mlx_audio の生ログを出す")
    args = ap.parse_args()

    if not args.skip_data:
        build_data()
    elif not args.skip_audio:
        # data.js がない場合は音声IDの解決ができないので一度作る
        if not DATA.exists():
            build_data()
    qs = load_questions()

    # ---------- 音声 ----------
    if args.skip_audio:
        return
    targets = pick_audio([i.strip() for i in args.ids.split(",")] if args.ids else None, qs)
    todo = [e for e in targets if not (AUDIO / f"{e['id']}.mp3").exists() or args.force]
    if args.limit:
        todo = todo[: args.limit]

    total = len(targets)
    have = total - len([e for e in targets if not (AUDIO / f"{e['id']}.mp3").exists()])
    log(f"[2/2] 音声: 全{total}問中 {have}問 あり → 今回 {len(todo)}問 生成")
    if not todo:
        log("done(生成する音声なし)")
        return

    if args.dry_run:
        eta = len(todo) * 9
        log(f"      見込み: 約{fmt_span(eta)}")
        for e in todo[:20]:
            log(f"        - {e['id']} ({e['level']}) {e['text'][:30]}…")
        if len(todo) > 20:
            log(f"        …ほか {len(todo) - 20}問")
        return

    try:
        from mlx_audio.tts.generate import generate_audio  # noqa: F401  (venv確認)
    except Exception:
        sys.exit(
            "mlx_audio がありません。TTS環境のPythonで実行してください:\n"
            "  /Users/yuki/Downloads/irodori-tts/.venv/bin/python tools/build_all.py"
        )

    t_start = time.time()
    failed: list[str] = []
    for i, e in enumerate(todo, start=1):
        t0 = time.time()
        try:
            res = tts_audio(e, force=args.force, verbose=args.verbose)
        except Exception:
            res = "fail"
        if res == "fail":
            failed.append(e["id"])
            log(f"      [{i}/{len(todo)}] ✕ {e['id']} — 失敗")
        elif res == "skip":
            log(f"      [{i}/{len(todo)}] ↷ {e['id']} — すでにあり")
        else:
            log(f"      [{i}/{len(todo)}] ✓ {e['id']} — {time.time() - t0:.1f}s")
        if res == "ok" and i > 1:
            eta = (time.time() - t_start) / (i - 1) * (len(todo) - i + 1)
            log(f"          残り見込み {fmt_span(eta)}")

    log("")
    ok_n = len(todo) - len(failed)
    log(f"done: {ok_n}/{len(todo)}問 生成({fmt_span(time.time() - t_start)}), 失敗 {len(failed)}件")
    if failed:
        log(f"  失敗ID: {', '.join(failed)}")
        log("  再実行すると続きから始められます(上記IDだけ出にくい場合は --ids で)")
        sys.exit(1)


if __name__ == "__main__":
    main()
