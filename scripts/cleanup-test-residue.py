#!/usr/bin/env python3
"""清理测试残留账号（mu_t_* 前缀）与其附属数据。

背景：权限/多用户测试会注册临时账号，这些账号在库里长期堆积：
  · 已注销账号被改名为「[已注销]<原名>#<id>」——按原前缀 LIKE 匹配不到，永久残留
  · 名下的「默认文献库」空库、测试论文、任务记录一起堆积

处理（顺序有讲究——先摘引用再删主体）：
  1. 论文迁移到 admin（论文是数据资产，不该随账号消失；papers.owner_id 无 CASCADE）
  2. 删该账号的库（collections 有 CASCADE，但显式删更可控）
  3. 删任务/翻译/审计等记录（jobs.user_id、translations.created_by 无 CASCADE）
  4. 删用户主体
  5. 删悬挂邀请码（used_by 指向已不存在用户）

用法:
  python3 scripts/cleanup-test-residue.py [--dry-run] [--all]
    --dry-run  只打印将执行的操作
    --all      连同「已注销」账号一起清理（默认只清仍以 mu_t_ 开头的）
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "papersys.db"


def find_users(conn: sqlite3.Connection, include_disabled: bool) -> list[sqlite3.Row]:
    if include_disabled:
        sql = ("SELECT id, username, disabled FROM users "
               "WHERE username LIKE 'mu_t_%' OR username LIKE '[已注销]mu_t_%' "
               "ORDER BY id")
    else:
        sql = ("SELECT id, username, disabled FROM users "
               "WHERE username LIKE 'mu_t_%' ORDER BY id")
    return conn.execute(sql).fetchall()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true",
                    help="连同已注销的测试账号一起清理")
    args = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    users = find_users(conn, args.all)
    if not users:
        print("无测试残留账号，无需清理")
        return 0

    ids = [u["id"] for u in users]
    marks = ",".join("?" * len(ids))
    print(f"待清理 {len(users)} 个测试账号: "
          + ", ".join(f"{u['id']}:{u['username']}" for u in users))

    admin = conn.execute(
        "SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY id LIMIT 1"
    ).fetchone()
    admin_id = admin["id"] if admin else None

    # ---- 统计将要动的东西 ----
    papers = conn.execute(
        f"SELECT id, title FROM papers WHERE owner_id IN ({marks})", ids).fetchall()
    colls = conn.execute(
        f"SELECT id FROM collections WHERE owner_id IN ({marks})", ids).fetchall()
    jobs = conn.execute(
        f"SELECT COUNT(*) c FROM jobs WHERE user_id IN ({marks})", ids).fetchone()["c"]
    trans = conn.execute(
        f"SELECT COUNT(*) c FROM translations WHERE created_by IN ({marks})",
        ids).fetchone()["c"]
    audits = conn.execute(
        f"SELECT COUNT(*) c FROM audit_log WHERE user_id IN ({marks})",
        ids).fetchone()["c"]
    print(f"  论文 {len(papers)}（迁至 admin={admin_id}）· 库 {len(colls)} · "
          f"任务 {jobs} · 翻译 {trans} · 审计 {audits}")

    if args.dry_run:
        print("(dry-run，未执行)")
        return 0

    # ---- 执行（顺序：先摘引用，后删主体）----
    for p in papers:
        conn.execute("UPDATE papers SET owner_id=? WHERE id=?", (admin_id, p["id"]))
    for c in colls:
        conn.execute("DELETE FROM collections WHERE id=?", (c["id"],))
    conn.execute(f"DELETE FROM jobs WHERE user_id IN ({marks})", ids)
    conn.execute(f"DELETE FROM translations WHERE created_by IN ({marks})", ids)
    conn.execute(f"DELETE FROM audit_log WHERE user_id IN ({marks})", ids)
    # 有 CASCADE 的子表：显式清一遍，避免依赖 FK 行为随版本漂移
    for tbl in ("user_llm_keys", "user_quotas", "chat_sessions", "paper_notes",
                "syntheses", "acq_tasks"):
        conn.execute(f"DELETE FROM {tbl} WHERE user_id IN ({marks})", ids)
    # 邀请码：used_by/created_by 指向被删账号的先摘掉
    # （老库的 used_by 无 CASCADE；新库已加，但显式清更稳）
    conn.execute(f"DELETE FROM invite_codes WHERE used_by IN ({marks})", ids)
    conn.execute(f"DELETE FROM invite_codes WHERE created_by IN ({marks})", ids)
    conn.execute(f"DELETE FROM users WHERE id IN ({marks})", ids)
    # 兜底：悬挂邀请码（used_by / created_by 指向已不存在用户）
    dangling = conn.execute(
        "DELETE FROM invite_codes WHERE used_by IS NOT NULL "
        "AND used_by NOT IN (SELECT id FROM users)").rowcount
    dangling += conn.execute(
        "DELETE FROM invite_codes WHERE created_by NOT IN (SELECT id FROM users)").rowcount
    conn.commit()

    # ---- 复核 ----
    left = conn.execute(
        "SELECT COUNT(*) c FROM users WHERE username LIKE 'mu_t_%' "
        "OR username LIKE '[已注销]mu_t_%'").fetchone()["c"]
    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    print(f"已清理。残留测试账号 {left} 个；悬挂外键 {len(fk)} 条"
          + (f"（{fk[:3]}）" if fk else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
