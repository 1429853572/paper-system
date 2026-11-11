#!/usr/bin/env python3
"""回填存量综述标题：泛称「文献综述 · N 篇」→「首篇论文标题 等 N 篇综述」。

背景：新综述已由 core/synthesis.py 的 _derive_title() 生成可辨识标题，
但存量行是硬编码的泛称，列表里完全看不出是关于什么的。

幂等：已是可辨识标题的行跳过（用与前端 synTitleOf 同样的判据）。
用法: python3 scripts/backfill-synthesis-titles.py [--dry-run]
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "papersys.db"

# 与前端 viewer.js 的 synTitleOf() 判据一致：短且含「综述/survey/report」= 泛称
VAGUE = re.compile(r"综述|survey|report", re.I)

# 自动聚类给出的兜底组名——不能当标题（「此组文献主题不一致」毫无信息量）
JUNK_GROUP = re.compile(r"主题不一致|未分类|其他|杂项|unknown|^默认$", re.I)


def is_vague(title: str) -> bool:
    t = (title or "").strip()
    return (not t) or (len(t) <= 12 and bool(VAGUE.search(t)))


def derive(first_title: str, group: str, axis: str, n: int) -> str:
    """标题来源优先级：组织轴(axis) > 单组分组名 > 首篇论文标题。

    axis 是发起综述时指定的「组织轴」——它就是综述的主题本身，最贴切；
    单组综述用模型总结的分组名；多组且无 axis 时用首篇论文标题兜底。
    """
    a = (axis or "").strip()
    if a:
        a = a.split("——")[0].split("，")[0].strip()[:48]
        return f"{a} 综述（{n} 篇）" if n > 1 else f"{a} 综述"
    g = (group or "").strip()
    if g and not JUNK_GROUP.search(g):
        g = g[:48]
        return f"{g} 综述（{n} 篇）" if n > 1 else f"{g} 综述"
    first = (first_title or "").strip()
    if not first:
        return f"文献综述 · {n} 篇"
    first = first[:48]
    return f"{first} 等 {n} 篇综述" if n > 1 else f"{first} 综述"


def main() -> int:
    dry = "--dry-run" in sys.argv
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = db.execute("SELECT id, title, paper_ids, clusters, params "
                      "FROM syntheses").fetchall()
    changed = 0
    for r in rows:
        if not is_vague(r["title"]):
            continue
        try:
            pids = json.loads(r["paper_ids"] or "[]")
        except json.JSONDecodeError:
            pids = []
        try:
            clusters = json.loads(r["clusters"] or "[]")
        except json.JSONDecodeError:
            clusters = []
        try:
            params = json.loads(r["params"] or "{}")
        except json.JSONDecodeError:
            params = {}
        first_title = ""
        if pids:
            row = db.execute("SELECT title FROM papers WHERE id=?", (pids[0],)).fetchone()
            first_title = (row["title"] if row else "") or ""
        group = clusters[0].get("name", "") if len(clusters) == 1 else ""
        new = derive(first_title, group, params.get("axis", ""), len(pids))
        print(f"  {r['id']}: {r['title']!r} → {new!r}")
        changed += 1
        if not dry:
            with sqlite3.connect(DB) as w:
                w.execute("UPDATE syntheses SET title=? WHERE id=?", (new, r["id"]))
    verb = "将回填" if dry else "已回填"
    print(f"{verb} {changed} / {len(rows)} 篇综述标题")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
