#!/usr/bin/env python3
"""回填 llm_calls.user_id 为 NULL 的历史记录。

背景：core/translator.py 的 _translate_batch() 构造 LLMClient 时漏传
      user_id，导致 388 次翻译调用记成匿名（llm_calls.user_id IS NULL），
      不进任何用户的用量/预算统计——用户看到的花费被低估。

      这些历史记录连 paper_id 也是 NULL（同样漏传），无法按论文回溯归属。
      本系统当时只有 admin 一个真实用户，故按「唯一管理员」归属；
      若存在多个 admin，取最早创建的那个。

用法: python3 scripts/backfill-llm-user.py [--dry-run]
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "papersys.db"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    nulls = conn.execute(
        "SELECT COUNT(*) c, SUM(prompt_tokens) p, SUM(completion_tokens) t "
        "FROM llm_calls WHERE user_id IS NULL").fetchone()
    if not nulls["c"]:
        print("无匿名用量记录，无需回填")
        return 0

    admins = conn.execute(
        "SELECT id, username FROM users WHERE role='admin' ORDER BY created_at, id").fetchall()
    if not admins:
        print("没有管理员账号，无法归属——保持原样")
        return 1
    target = admins[0]
    print(f"匿名记录 {nulls['c']} 条（prompt {nulls['p'] or 0} tok / "
          f"completion {nulls['t'] or 0} tok）→ 归属 admin #{target['id']} ({target['username']})")

    if args.dry_run:
        print("(dry-run，未执行)")
        return 0

    with conn:
        conn.execute("UPDATE llm_calls SET user_id=? WHERE user_id IS NULL", (target["id"],))
    left = conn.execute("SELECT COUNT(*) c FROM llm_calls WHERE user_id IS NULL").fetchone()["c"]
    print(f"已回填。剩余匿名记录 {left} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
