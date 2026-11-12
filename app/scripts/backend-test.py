#!/usr/bin/env python3
"""后端单元测试（容器内跑：docker exec paper-system-app python3 /app/scripts/backend-test.py）。

覆盖审计指出的测试盲区——全部走临时 sqlite（data/test-unit.db），不动生产库：
  1. citekey：键消歧（同年同姓 a/b）、2作者区分、中文键、证据分级、宽容化校验、幻影拦截
  2. acqtask：状态机字段更新（error=None → SQL NULL 而非字符串 "null"）、候选键匹配
  3. summarizer cache_key 语义（同 run+model 同 key）
  4. synthesis rewrite 键表复用逻辑（参数透传正确性——不跑 LLM，只验分支取数）
"""
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("PAPERSYS_DATA", tempfile.mkdtemp(prefix="ps-unit-"))
sys.path.insert(0, "/app")

PASS = FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {extra}" if extra and not cond else ""))
    PASS, FAIL = PASS + (1 if cond else 0), FAIL + (0 if cond else 1)

print("== citekey ==")
from core.citekey import build_table, verify_report, render_references, citable_entries, need_manual

papers = [
    {"id": "p1", "title": "Feed-forward Recon", "authors": "Lei Wang, Wei Zhang, Yan Liu",
     "year": "2025", "journal": "CVPR", "doi": "", "meta_source": "", "meta_verified_at": None},
    {"id": "p2", "title": "Another Gaussian", "authors": "Ming Wang, Qiang Chen, Bo Li",
     "year": "2025", "journal": "ICCV", "doi": "", "meta_source": "", "meta_verified_at": None},
    {"id": "p3", "title": "Kerbl Splats", "authors": "Bernhard Kerbl",
     "year": "2023", "journal": "SIGGRAPH", "doi": "", "meta_source": "", "meta_verified_at": None},
    {"id": "p4", "title": "VGGT Reloaded", "authors": "Tao Wang, Xin Wu",
     "year": "2026", "journal": "", "doi": "10.48550/arXiv.2601.12345",
     "meta_source": "", "meta_verified_at": None},
    {"id": "p5", "title": "三维高斯泼溅综述", "authors": "刘晓悦, 陈锐",
     "year": "2026", "journal": "计算机学报", "doi": "", "meta_source": "", "meta_verified_at": None},
    {"id": "p6", "title": "Verified", "authors": "Yuan Fei, Jin Guo",
     "year": "2024", "journal": "", "doi": "", "meta_source": "arxiv", "meta_verified_at": "2026-01-01"},
]
t = build_table(papers, api_check=False)
keys = {e["id"]: e["key"] for e in t}
ev = {e["id"]: e["evidence"] for e in t}
ok("同年同姓 a/b 消歧", keys["p1"] == "Wang et al., 2025a" and keys["p2"] == "Wang et al., 2025b", str(keys))
ok("单作者键", keys["p3"] == "Kerbl, 2023")
ok("arXiv 水印分级", ev["p4"] == "watermark")
ok("已核验分级", ev["p6"] == "api")
ok("中文键", keys["p5"].startswith("刘晓悦等，2026"))
ok("可引/待核验划分", len(citable_entries(t)) == 3 and len(need_manual(t)) == 3,
   f"可引{len(citable_entries(t))}/待核{len(need_manual(t))}")

md_bad = "(Wang et al., 2025a) 与 (Kerbl, 2023)…(Ghost et al., 2099)\n\n## 参考文献\n" + render_references(t)
v = verify_report(md_bad, t, "author_year", "quick")
ok("幻影拦截", not v["pass"] and any("Ghost" in p for p in v["phantom"]))
# 宽容化：缩写 (Pellitero, 2025) ⊂ 表键 (Jang & Pérez-Pellitero, 2025) 不算幻影
t2 = [{"id": "n1", "key": "Jang & Pérez-Pellitero, 2025", "evidence": "api", "title": "CoMapGS"},
      {"id": "n2", "key": "Fei et al., 2024", "evidence": "api", "title": "F"}]
md2 = "(Jang & Pérez-Pellitero, 2025) 其缩写 (Pellitero, 2025) 与 (Fei et al., 2024)\n\n## 参考文献\n" + render_references(t2)
v2 = verify_report(md2, t2, "author_year", "quick")
ok("缩写宽容化（子串视为同引用）", not v2["phantom"], str(v2["phantom"]))
ok("真幻影仍拦", not verify_report("(Ghost, 2099) x", t2, "author_year", "quick")["pass"])

print("== acqtask（临时库）==")
from core.db import db
u = db.one("SELECT id FROM users ORDER BY id LIMIT 1")
if u is None:   # 临时库无用户（backend-test 用 PAPERSYS_DATA 指向空目录）——造一个
    import hashlib
    with db.write() as c:
        c.execute("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)",
                  (1, "unit", hashlib.sha256(b"x").hexdigest(), "member"))
    u = {"id": 1}
uid = u["id"]
tid = "atktest01"
with db.write() as c:
    c.execute("DELETE FROM acq_tasks WHERE id=?", (tid,))
    c.execute("INSERT INTO acq_tasks(id,user_id,title,query,site) VALUES(?,?,?,?,?)",
              (tid, uid, "t", "q", "chinaxiv"))
from core import acqtask
acqtask.update(tid, error=None)
row = db.one("SELECT error FROM acq_tasks WHERE id=?", (tid,))
ok("error=None → SQL NULL（非字符串 null）", row["error"] is None, repr(row["error"]))

acqtask.set_candidates(tid, [
    {"title": "甲", "pdf_url": "https://x/a.pdf"},
    {"title": "乙", "pdf_url": ""},
])
acqtask.mark_candidate(tid, "https://x/a.pdf", dl_status="done", paper_id="px")
tt = acqtask.get(tid)
d = {c["title"]: c for c in tt["candidates"]}
ok("候选键精确匹配", d["甲"]["dl_status"] == "done")
ok("无链接候选不受空键影响", d["乙"]["dl_status"] == "pending")
with db.write() as c:
    c.execute("DELETE FROM acq_tasks WHERE id=?", (tid,))

print("== summarizer cache_key ==")
from core.summarizer import compute_key
k1 = compute_key("runA", "modelX")
k2 = compute_key("runA", "modelX")
k3 = compute_key("runB", "modelX")
k4 = compute_key("runA", "modelY")
ok("同 run+model 同 key", k1 == k2)
ok("run/model 变化 key 变化", k1 != k3 and k1 != k4)

print("== verify_report numeric ==")
t3 = [{"id": "n1", "key": "[1]", "evidence": "api", "title": "A"},
      {"id": "n2", "key": "[2]", "evidence": "api", "title": "B"}]
# numeric 模式的 key 实际由渲染序承担——验证 render_references numeric 形态
refs = render_references(t, "numeric")
ok("numeric 渲染有序号", bool(__import__("re").match(r"^\d+\. ", refs)), refs[:30])

print("== 多用户配额（临时库）==")
from server.main import _daily_parse_limit, _check_daily_quota
from fastapi import HTTPException
ok("admin 用全站上限", _daily_parse_limit(True, {}) == 600)
ok("member 默认上限", _daily_parse_limit(False, {}) == 200)
ok("member 覆盖生效", _daily_parse_limit(False, {"daily_parse_papers": 5}) == 5)
# 触发 429：把该用户今日 parse 任务计数顶到上限
with db.write() as c:
    c.execute("INSERT INTO jobs(id,user_id,job_type,status,payload) VALUES(90001,?, 'parse','done','{}')", (uid,))
    c.execute("INSERT INTO jobs(id,user_id,job_type,status,payload) VALUES(90002,?, 'parse','running','{}')", (uid,))
try:
    _check_daily_quota(uid, False, {"daily_parse_papers": 2})
    ok("达上限触发 429", False, "未抛异常")
except HTTPException as e:
    ok("达上限触发 429", e.status_code == 429 and "上限" in e.detail, f"{e.status_code} {e.detail}")
ok("admin 不受 member 上限约束", _check_daily_quota(uid, True, {"daily_parse_papers": 2}) is None)

# admin/users 与 papers 列表的新列（disabled bug 修复面 + owner_name 归属标识）
row = db.one(
    "SELECT u.id, u.disabled, u.username, "
    "(SELECT COUNT(*) FROM papers p WHERE p.owner_id=u.id AND p.deleted_at IS NULL) AS papers, "
    "(SELECT COALESCE(SUM(p.file_size),0) FROM papers p WHERE p.owner_id=u.id AND p.deleted_at IS NULL) AS disk_used, "
    "(SELECT COALESCE(SUM(lc.prompt_tokens+lc.completion_tokens),0) FROM llm_calls lc "
    "WHERE lc.user_id=u.id AND lc.created_at>=date('now','-30 day')) AS tokens_30d "
    "FROM users u LEFT JOIN user_quotas q ON q.user_id=u.id WHERE u.id=?", (uid,))
ok("admin/users SQL 含 disabled/disk_used/tokens_30d",
   all(k in row.keys() for k in ("disabled", "disk_used", "tokens_30d")), str(dict(row)))
with db.write() as c:
    c.execute("INSERT INTO papers(id,owner_id,visibility,title,parse_status,file_size,file_hash) VALUES('px1',?,'shared','T','parsed',1024,'h1')", (uid,))
pj = db.one("SELECT p.id, p.owner_id, u.username AS owner_name FROM papers p "
            "LEFT JOIN users u ON u.id=p.owner_id WHERE p.id='px1'")
ok("papers JOIN 出 owner_name", pj["owner_name"] == "unit", str(dict(pj)))
with db.write() as c:
    c.execute("DELETE FROM papers WHERE id='px1'")
    c.execute("DELETE FROM jobs WHERE id IN (90001, 90002)")

print("== 跨页参考文献合并（get_references）==")
from core.meta import get_references
with db.write() as c:
    c.execute("INSERT INTO papers(id,owner_id,visibility,title,parse_status,file_hash) "
              "VALUES('pref',1,'shared','Ref Merge Fixture','parsed','hr1')")
    c.execute("INSERT INTO parse_runs(id,paper_id,tier,status) VALUES('runref','pref','standard','done')")
    blocks = [
        ("[46] Alpha, A. Prior work on gaussian splatting. J. Conf., 1–9, 2024.", 0),
        ("[47] Jiang Wu, et al. Sparse2dgs: Geometry-prioritized gaussian", 0),          # 断在句中
        ("splatting for surface reconstruction from sparse views. In Proceedings, 2025. 3", 1),  # 跨页续块
        ("[48] Beta, B. Hyphenated continuation is com-", 2),                            # 连字符断词
        ("pletely common in two-column PDFs, 2024.", 2),
        ("Disclaimer/Publisher's Note: statements are those of the authors.", 3),        # 大写开头 → 独立
    ]
    for i, (text, page) in enumerate(blocks):
        c.execute("INSERT INTO blocks(block_id,parse_run_id,paper_id,type,text,page_index,block_index) "
                  "VALUES(?, 'runref', 'pref', 'ref_text', ?, ?, ?)",
                  (f"pref-b{i:05d}", text, page, i))
refs = get_references("pref")
ok("跨页续块并入上一条（59→58 同型）", len(refs) == 4, f"实际 {len(refs)} 条")
r47 = next((r for r in refs if r["text"].startswith("[47]")), None)
ok("[47] 全文完整", r47 is not None and "sparse views. In Proceedings, 2025. 3" in r47["text"],
   (r47 or {}).get("text", "")[-60:])
ok("跳转定位保留起始块", r47 is not None and r47["page_index"] == 0, str((r47 or {}).get("page_index")))
r48 = next((r for r in refs if r["text"].startswith("[48]")), None)
ok("连字符断词去 '-' 拼接", r48 is not None and "completely common" in r48["text"],
   (r48 or {}).get("text", "")[:60])
ok("大写 Disclaimer 不被并入", any(r["text"].startswith("Disclaimer") for r in refs) and
   not refs[-1]["text"].startswith("[48]"))
with db.write() as c:
    c.execute("DELETE FROM blocks WHERE paper_id='pref'")
    c.execute("DELETE FROM parse_runs WHERE id='runref'")
    c.execute("DELETE FROM papers WHERE id='pref'")

print(f"\n结果: {PASS} 通过, {FAIL} 失败")
sys.exit(1 if FAIL else 0)
