#!/usr/bin/env python3
"""問題md(簡単.md〜最難関.md)を Web用の data.js に変換する。

出力: /Users/yuki/Downloads/super-dictation-jp/web/data.js
    window.QUESTIONS = [ {id, level, levelI, spec, pattern, text, qs:[...]} ... ]
"""
from __future__ import annotations

import json
import re
from pathlib import Path

BASE = Path("/Users/yuki/Downloads/super-dictation-jp")
OUT = BASE / "web/data.js"
SUFFIX_W = "簡単 標準 応用".split()  # p1

# 括弧マーカーの分類
FOUR_TOKENS = ("4択", "数字を選ぶ")
MARKER_PAT = re.compile(r"\(([^()]*)\)")

def classify_paren(c: str):
    c = c.strip()
    if c.startswith("解答"):
        return ("answer", c)
    if re.match(r"^空欄\d", c) and ":" in c:
        return ("blank", c)
    if "の位" in c and ":" in c:
        return ("digit", c)
    if "回答文の穴埋め検" in c or "回答文の穴埋め選択" in c or "回答文の虫食い選択" in c:
        return ("embed", c)
    if "空白のます" in c and ("桁" in c or "数字を選ぶ" in c):
        return ("digits", c)
    if "空白のます" in c:
        return ("masu", c)
    if "ダミーなし" in c or "記述" in c:
        return ("write", c)
    if c.startswith("4択") or "数字" in c and "選" in c:
        return ("four", c)
    return (None, c)

def parse_q_line(line: str, n: int):
    body = line[len("Q?: ".replace("?", str(n))):] if False else re.sub(r"^Q\d: ", "", line)
    # マーカーを抽出(本文中の「(空欄N)」プレースホルダも含む)
    markers = []
    placeholder_spans = []
    marker_spans = []
    for m in MARKER_PAT.finditer(body):
        kind, content = classify_paren(m.group(1))
        if kind is None and re.match(r"^空欄(\d+)$", content.strip()):
            kind = "ph"
        if kind is None:
            continue
        marker_spans.append((m.start(), m.end(), kind, content))
        if kind == "ph":
            placeholder_spans.append((m.start(), m.end()))
        else:
            markers.append((kind, content))

    # 本文: 全マーカー領域を除いてつなぎ、プレースホルダは「[空欄N]」に置換
    pieces = []
    pos = 0
    for s, e, kind, content in sorted(marker_spans, key=lambda x: x[0]):
        if kind == "ph":
            pieces.append(body[pos:s] + f"[空欄{content.strip('空欄')}]")
        else:
            pieces.append(body[pos:s])
        pos = e
    pieces.append(body[pos:])
    text_part = "".join(pieces).strip()

    q: dict = {"n": n, "text": text_part, "type": "four", "options": [], "answer": ""}
    kinds = [k for k, _ in markers]

    # 回答文(虫食い文)抽出: 回答文「...」
    answer_sentence_m = re.search(r"回答文[「『]([^」』]+)[」』]", text_part)
    if answer_sentence_m:
        q["answer_sentence"] = answer_sentence_m.group(1)

    # blanks/digits/answer meta
    digit_groups: list[dict] = []
    seen_labels: set[str] = set()
    blanks_by_num: dict[int, dict] = {}
    for kind, content in markers:
        if kind == "answer":
            parts = [p.strip() for p in content.split("|")]
            first = parts[0]
            q["answer"] = first.split(":", 1)[1].strip() if ":" in first else first[2:].strip()
            for p in parts[1:]:
                if p.startswith("選択肢"):
                    p = p[len("選択肢"):].strip().lstrip(":").strip()
                    q["options"] = [s.strip() for s in p.split(",") if s.strip()]
                    continue
                m = re.match(r"^([^:の]+の位)\s*[:：]\s*(.+)$", p)
                if m:
                    label = m.group(1).strip()
                    if label not in seen_labels:
                        seen_labels.add(label)
                        digit_groups.append({
                            "label": label,
                            "options": [s.strip() for s in m.group(2).split(",") if s.strip()],
                        })
        elif kind == "blank":
            inner = re.sub(r"^空欄\d\s*[:：]", "", content).strip()
            if "|" in inner:
                ans, opts = inner.split("|", 1)
                opts = re.sub(r"^選択肢\s*[:：]?\s*", "", opts).strip()
            elif ":" in inner:
                ans, opts = inner.split(":", 1)
            else:
                ans, opts = inner, ""
            idx = int(re.match(r"^空欄(\d+)", content).group(1))
            blanks_by_num[idx] = {
                "answer": ans.strip(),
                "options": [s.strip() for s in opts.split(",") if s.strip()],
            }
        elif kind == "digit":
            label, vals = content.split(":", 1)
            label = label.strip()
            if label not in seen_labels:
                seen_labels.add(label)
                digit_groups.append({
                    "label": label,
                    "options": [s.strip() for s in vals.split(",") if s.strip()],
                })

    # 空欄を番号順に並べる
    if blanks_by_num:
        q["blanks"] = [blanks_by_num[k] for k in sorted(blanks_by_num)]

    # type 決定
    if digit_groups:
        q["type"] = "digits"
        q["digits"] = digit_groups
    if "embed" in kinds:
        q["type"] = "embed"
    elif "write" in kinds:
        q["type"] = "write"
    elif "digits" in kinds or digit_groups:
        q["type"] = "digits"
    elif "masu" in kinds:
        q["type"] = "masu"
    elif "four" in kinds and q["type"] != "embed":
        q["type"] = "four"
    # 空欄がある場合
    if "blanks" in q and q["type"] in ("embed",):
        pass
    elif "blanks" in q and q["type"] not in ("embed",):
        q["type"] = "embed"
    return q

def parse_md(path: Path, level_i: int):
    text = path.read_text(encoding="utf-8")
    level = path.stem
    qarr = []
    cur_spec_num = 0
    cur_spec_name = ""
    cur_pat = None
    cur_text = None
    cur_qs = []
    pat_seq = 0

    entries: list[dict] = []

    def flush():
        nonlocal cur_pat, cur_text, cur_qs, pat_seq
        if cur_pat is None:
            return
        pat_seq += 1
        entries.append({
            "id": f"{level_i}-{cur_spec_num:02d}-{cur_pat}",
            "level": level,
            "levelI": level_i,
            "spec": cur_spec_num,
            "specName": cur_spec_name,
            "pattern": cur_pat,
            "seq": pat_seq,
            "text": cur_text or "",
            "qs": [parse_q_line(l, j) for j, l in enumerate(cur_qs, start=1)],
        })

    for line in text.splitlines():
        if line.startswith("## "):
            flush()
            m = re.match(r"^## (\S+?)(\d+) (.+)$", line[3:].strip()) if False else re.match(r"^(\D+?)(\d+)\s*(.+)$", line[3:].strip())
            cur_pat = None
            if m:
                cur_spec_num = int(m.group(2))
                cur_spec_name = m.group(3).strip()
            else:
                m2 = re.match(r"^##\s*(.+)$", line)
                cur_spec_name = line[3:].strip()
                cur_spec_num = 0
        elif line.startswith("### パターン"):
            flush()
            cur_pat = int(line.replace("### パターン", "").strip())
            cur_text = None
            cur_qs = []
        elif line.startswith("文: ") and cur_pat is not None:
            cur_text = line[3:].strip()
        elif re.match(r"^Q\d: ", line) and cur_pat is not None:
            cur_qs.append(line.strip())
    flush()
    return entries

def main():
    level_names = SUFFIX_W + ["難関", "最難関"]
    all_q = []
    for i, level in enumerate(level_names, start=1):
        all_q.extend(parse_md(BASE / f"{level}.md", i))
    for e in all_q:
        e["audio"] = f"audio/{e['id']}.mp3"
    data = {"v": 1, "questions": all_q}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "// 問題データ(簡単.md/標準.md/応用.md/難関.md/最難関.md から自動生成)\n"
        f"window.QUESTIONS = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"questions: {len(all_q)} -> {OUT}")

if __name__ == "__main__":
    main()
