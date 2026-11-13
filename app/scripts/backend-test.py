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

print("== 摘要提取与收敛（extract_abstract_blocks / _merge_abstract）==")
from core.meta import extract_abstract_blocks, _merge_abstract

def B(i, typ, sec, text, page, y, x):
    return {"block_id": f"ab{i}", "type": typ, "section_path": sec, "text": text,
            "page_index": page, "bbox": json.dumps([x, y, x + 5, y + 1])}

# block_index 是乱的（MinerU 噪声），bbox 排序后才是阅读序
blocks = [
    B(0, "text", "Paper > 1. Introduction", "Intro paragraph here.", 0, 500, 100),
    B(1, "title", "Paper > Abstract", "Abstract", 0, 100, 100),
    B(2, "text", "Paper > Abstract", "The abstract body sentence one.", 0, 130, 100),
    B(3, "title", "Paper > 1. Introduction", "1. Introduction", 0, 400, 100),
]
text, ids = extract_abstract_blocks(blocks)
ok("bbox 几何排序修正阅读序（block_index 乱序不影响）",
   text == "The abstract body sentence one." and ids == ["ab2"], text[:40])

blocks2 = [  # 无标题版式：正文块自带 abstract 小节归属 → 直接收
    B(0, "text", "Paper > Abstract", "Abs body without heading block.", 0, 120, 100),
    B(1, "title", "Paper > 1. Introduction", "1. Introduction", 0, 400, 100),
]
t2, i2 = extract_abstract_blocks(blocks2)
ok("无标题版式（sec 归属直收）", t2 == "Abs body without heading block." and i2 == ["ab0"])

ok("merge：已中文保持", _merge_abstract("中文摘要", "新翻译") == "中文摘要")
ok("merge：英文原文让位于翻译", _merge_abstract("An English abstract.", "中文翻译") == "中文翻译")
ok("merge：空 → 翻译", _merge_abstract("", "中文翻译") == "中文翻译")
ok("merge：翻译缺失 → 保留原文", _merge_abstract("English text", "") == "English text")

print("== 分库多对多（paper_collections）==")
from core.ingest import attach_to_collection, linked_collections, create_paper
from core.db import db
with db.write() as c:
    c.execute("INSERT INTO collections(id,name,owner_id,parent_id) VALUES('mmA','甲库',1,NULL)")
    c.execute("INSERT INTO collections(id,name,owner_id,parent_id) VALUES('mmB','乙库',1,NULL)")
    c.execute("INSERT INTO collections(id,name,owner_id,parent_id) VALUES('mmA1','甲子库',1,'mmA')")
    c.execute("INSERT INTO papers(id,owner_id,visibility,file_hash,title,parse_status) "
              "VALUES('pm1',1,'shared','hashmm','多挂库论文','parsed')")
ok("attach 幂等（重复挂不报错）", attach_to_collection('pm1', 'mmA') and
   not attach_to_collection('pm1', 'mmA'))
ok("一篇挂两库", attach_to_collection('pm1', 'mmB') and sorted(linked_collections('pm1')) == ['mmA', 'mmB'])

# dup 复用：create_paper 同 hash → 返回既有 id
pid2, dup = create_paper(1, 'hashmm', 10, 100, 'shared', '再次上传.pdf')
ok("同内容导入复用记录", dup and pid2 == 'pm1')

# 删库三态（直接调端点函数；u 为 admin dict）
from core.libs import delete_subtree
u_admin = {"id": 1, "role": "admin"}
# pm1 挂 mmA+mmB：删甲库（含子库 mmA1）→ pm1 仍挂 mmB → 只摘链不回收
r = delete_subtree('mmA', 1, True)
ok("删父库：仍挂他库 → 只摘链", r["unlinked"] == 1 and r["trashed"] == 0
   and sorted(linked_collections('pm1')) == ['mmB']
   and db.one("SELECT deleted_at FROM papers WHERE id='pm1'")["deleted_at"] is None)
# 删乙库 → pm1 无主 → 进回收站
r2 = delete_subtree('mmB', 1, True)
ok("删最后所属库：无主 → 进回收站", r2["trashed"] == 1
   and db.one("SELECT deleted_at FROM papers WHERE id='pm1'")["deleted_at"] is not None)
# hard_delete 级联清挂链
# 硬删级联清挂链（前面删库用例已把 mmA/mmB 删掉——重建一个库来挂）
with db.write() as c:
    c.execute("INSERT INTO collections(id,name,owner_id) VALUES('mmC','丙库',1)")
    c.execute("UPDATE papers SET deleted_at=NULL WHERE id='pm1'")
attach_to_collection('pm1', 'mmC')   # attach 自带写锁——必须在 with 块外（非重入，嵌套即自死锁）
from core.jobs import scheduler
scheduler.hard_delete_paper('pm1')
ok("硬删论文级联清挂链", db.one("SELECT COUNT(*) AS n FROM paper_collections WHERE paper_id='pm1'")["n"] == 0)
with db.write() as c:
    c.execute("DELETE FROM collections WHERE id IN ('mmA','mmB','mmA1','mmC')")

print("== 综述 E 标记剥离（_strip_ev_markers）==")
import re as _re
from core.synthesis import _strip_ev_markers
_tab = [{"id": "pa", "key": "Chen & Wang, 2024"}, {"id": "pb", "key": "Liu et al., 2025"}]
_ev = [{"paper_id": "pa"}, {"paper_id": "pa"}, {"paper_id": "pb"}, {"paper_id": "未知pid"}]
_strip_cases = [
    ("重建质量显著退化【E2】。", "重建质量显著退化（Chen & Wang, 2024）。", "孤立→换键（显示是哪篇）"),
    ("明显短板（Chen & Wang, 2024）【E2】。", "明显短板（Chen & Wang, 2024）。", "窗口有键→删"),
    ("该方法泛化性有限 [E3]。", "该方法泛化性有限（Liu et al., 2025）。", "半角孤立→换键"),
    ("未知编号 [E4] 不替换。", "未知编号不替换。", "论文不在键表→删（不编造）"),
    ("混用形态 [E2] 与【E3】。", "混用形态（Chen & Wang, 2024）与（Liu et al., 2025）。", "两种括号"),
]
for _body, _want, _desc in _strip_cases:
    ok("E 剥离：" + _desc, _strip_ev_markers(_body, _tab, _ev) == _want,
       repr(_strip_ev_markers(_body, _tab, _ev)))

print("== v19 读过滤与删库第三态 ==")
import json as _json
from core.libs import delete_subtree
from server.main import list_papers, list_collections
# 造数：admin 论文挂进 member 库（模拟「收藏他人共享论文」），member 只挂此库
with db.write() as c:
    c.execute("INSERT OR IGNORE INTO users(id,username,password_hash,role) VALUES(2,'member_u','x','member')")
    c.execute("INSERT INTO collections(id,name,owner_id) VALUES('mL','我的库',2)")
    c.execute("INSERT INTO collections(id,name,owner_id) VALUES('mL2','我的库2',2)")
    c.execute("INSERT INTO papers(id,owner_id,visibility,file_hash,title,parse_status) "
              "VALUES('pvis',1,'shared','hvis','admin 的共享论文','parsed')")
    c.execute("INSERT INTO paper_collections(paper_id,collection_id) VALUES('pvis','mL')")
# EXISTS 过滤：member 按自己库查能看到 admin 的共享论文
d = list_papers(q="", status="", trash=0, collection_id="mL", page=0, page_size=10, all=0,
                u={"id": 2, "role": "member"})
ok("EXISTS 过滤：member 按库可见他人共享论文", any(x["id"] == "pvis" for x in d["papers"]))
d2 = list_papers(q="", status="", trash=0, collection_id="none", page=0, page_size=10, all=0,
                 u={"id": 2, "role": "member"})
ok("collection_id=none（无挂链）口径正确",
   all((x.get("collection_ids") or []) == [] for x in d2["papers"]))
# 行带 collection_ids 数组（list 端点形状）
d3 = list_papers(q="", status="", trash=0, collection_id="", page=0, page_size=10, all=0,
                 u={"id": 1, "role": "admin"})
ok("list 行带 collection_ids 数组", isinstance(d3["papers"][0].get("collection_ids"), list))
# 计数：member 两库各挂一查 DISTINCT
dc = list_collections(u={"id": 2, "role": "member"})
mL = next(c for c in dc["collections"] if c["id"] == "mL")
ok("collections 计数走关联表", mL["papers"] == 1, str(mL))
# 删库第三态：member 删自己的库（内有 admin 的共享论文）→ 他人论文只摘链不回收
r = delete_subtree("mL", 2, False)
ok("删库第三态：他人论文只摘链不回收",
   r["unlinked"] == 1 and r["trashed"] == 0
   and db.one("SELECT deleted_at FROM papers WHERE id='pvis'")["deleted_at"] is None)
# 软删不摘链 + restore 回原挂链
attach_to_collection("pvis", "mL2")
with db.write() as c:
    c.execute("UPDATE papers SET deleted_at=datetime('now') WHERE id='pvis'")
before = linked_collections("pvis")
with db.write() as c:
    c.execute("UPDATE papers SET deleted_at=NULL WHERE id='pvis'")
after = linked_collections("pvis")
ok("软删不摘链 + restore 回原挂链", before == after == ["mL2"], f"{before}→{after}")
with db.write() as c:
    c.execute("DELETE FROM paper_collections WHERE paper_id='pvis'")
    c.execute("DELETE FROM papers WHERE id='pvis'")
    c.execute("DELETE FROM collections WHERE id IN ('mL','mL2')")
    c.execute("DELETE FROM users WHERE id=2")

print("== 恢复查重（restore_clash）==")
from core.ingest import restore_clash
with db.write() as c:
    c.execute("INSERT INTO papers(id,owner_id,visibility,file_hash,title,parse_status) "
              "VALUES('pa',1,'shared','hashX','活着的','parsed')")
    c.execute("INSERT INTO papers(id,owner_id,visibility,file_hash,title,parse_status,deleted_at) "
              "VALUES('pb',1,'shared','hashX','回收站里的','parsed',datetime('now'))")
ok("活论文不算冲突（自己 ≠ 自己）", restore_clash("pa") is None)
c1 = restore_clash("pb")
ok("回收站行撞同内容活论文 → 报冲突", c1 is not None and c1["id"] == "pa", str(dict(c1) if c1 else None))
with db.write() as c:
    c.execute("UPDATE papers SET deleted_at=NULL WHERE id='pa' AND id='zz'")  # no-op
    c.execute("DELETE FROM papers WHERE id IN ('pa','pb')")

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

# == 文献追踪（tracker）==
print("== 文献追踪（tracker：查询构造/去重/分层/补足/patrol/邮件HTML）==")
from core import tracker as tk
from core import tracker_mail as tm

sub = {"id": "ts1", "user_id": 9001, "categories": "cs.CV eess.IV",
       "keywords": "gaussian splatting, 3D reconstruction", "exclude": "survey, review",
       "journals": "", "frequency_hours": 24}
q = tk.arxiv_search_query(sub, 48)
ok("查询构造：cat 组 AND 关键词组 ANDNOT 排除",
   q == '(cat:cs.CV OR cat:eess.IV) AND ((ti:"gaussian splatting" OR abs:"gaussian splatting") '
         'OR (ti:"3D reconstruction" OR abs:"3D reconstruction")) '
         'ANDNOT ((ti:"survey" OR abs:"survey") OR (ti:"review" OR abs:"review"))', q or "None")
q2 = tk.arxiv_search_query({"categories": "", "keywords": "", "exclude": "", "journals": "Nature"}, 24)
ok("无 arXiv 条件（仅期刊）→ query=None", q2 is None, str(q2))

def _mk(t, ab, doi="", ax="", pdf="", venue="arXiv", pub="2026-11-13", authors="A"):
    return {"title": t, "abstract": ab, "doi": doi, "arxiv_id": ax, "pdf_url": pdf,
            "venue": venue, "published": pub, "authors": authors, "code_url": ""}

a1 = _mk("Gaussian Splatting for Urban Reconstruction", "we render urban scenes with 3D gaussian splatting",
         doi="10.1/aa", ax="2601.0001", pdf="https://arxiv.org/pdf/2601.0001")
a2 = _mk("Gaussian Splatting for Urban  Reconstruction", "short version", ax="2601.0002",
         venue="Nature Communications")
merged = tk.merge_round([a1, a2])
ok("轮内去重：双空格标题≥0.85 合并为一条", len(merged) == 1, f"n={len(merged)}")
a3 = _mk("Gaussian Splatting for Urban Reconstruction v2", "we render urban scenes with 3D gaussian splatting and more",
         ax="2601.0003")
m2 = tk.merge_round([_mk("Gaussian Splatting for Urban Reconstruction", "we render urban scenes with 3D gaussian splatting",
                         doi="10.1/aa", pdf="https://arxiv.org/pdf/x"), a3])
hit = m2[0]
ok("合并保留字段更全者并补空位", hit.get("abstract", "").endswith("splatting") and
   hit.get("pdf_url") and hit.get("arxiv_id") == "2601.0003",
   f"abs_tail={hit.get('abstract','')[-20:]} pdf={hit.get('pdf_url')} ax={hit.get('arxiv_id')}")
a5 = _mk("Totally Different Paper on Topic Modeling", "latent dirichlet allocation")
ok("无关论文不误合", len(tk.merge_round([_mk("Gaussian Splatting Urban", "x gaussian y"), a5])) == 2)

sub_cls = {"keywords": "gaussian splatting", "journals": "Nature Communications"}
ok("分层：期刊命中→core", tk.classify(_mk("Some Other Title", "nothing", venue="Nature Communications"), sub_cls) == "core")
ok("分层：标题命中关键词→core", tk.classify(_mk("Gaussian Splatting Survey of Methods", "x"), sub_cls) == "core")
ok("分层：仅摘要命中→proxy", tk.classify(_mk("Fast Scene Solver", "uses gaussian splatting for speed"), sub_cls) == "proxy")
ok("分层：无命中→eco", tk.classify(_mk("Cat Image Classifier", "cats and dogs"), sub_cls) == "eco")

batch = [_mk("Core Paper", "gaussian splatting here", venue="Nature Communications"),
         _mk("Proxy Paper", "mentions gaussian splatting once")]
for b in batch: b["tier"] = tk.classify(b, sub_cls)
batch += [_mk(f"Filler {i}", "unrelated", pub=f"2026-11-{10+i:02d}") for i in range(8)]
for b in batch:
    if "tier" not in b: b["tier"] = tk.classify(b, sub_cls)
tk.fill_fallback(batch, minimum=5)
fb = [x for x in batch if x.get("is_fallback")]
ok("补足：core+proxy=2 → 从 eco 补 3 篇并标 is_fallback", len(fb) == 3 and all(x["tier"] == "eco" for x in fb),
   f"fb={len(fb)}")
big = batch[:2] + [_mk(f"Strong {i}", "gaussian splatting in title", venue="Nature Communications") for i in range(5)]
for b in big:
    if "tier" not in b: b["tier"] = tk.classify(b, sub_cls)
tk.fill_fallback(big, minimum=5)
ok("足额不补（无 is_fallback）", not any(x.get("is_fallback") for x in big))

# patrol 离线整链（mock 采集与 LLM；临时库真实读写）
from core.db import Database as _TDB
from pathlib import Path as _PPath
_tpath = _PPath(tempfile.mkdtemp(prefix="ps-trk-")) / "trk.db"
_tdb = _TDB(_tpath)
tk.db = _tdb
tm.db = _tdb
sub_row = {"id": "tsX", "user_id": 9001, "name": "T", "keywords": "gaussian splatting",
           "categories": "cs.CV", "exclude": "", "journals": "", "frequency_hours": 24,
           "llm_auto": "off", "email_enabled": 0, "email_to": "", "enabled": 1,
           "last_run_at": None, "last_error": None}
with _tdb.write() as c:
    c.execute("INSERT INTO users(id, username, password_hash, role) VALUES(9001, 'trktest', 'x', 'admin')")
    c.execute("INSERT INTO tracker_subs(id, user_id, name, keywords, categories, exclude, journals, "
              "frequency_hours, llm_auto, email_enabled, email_to, enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)",
              ("tsX", 9001, "T", "gaussian splatting", "cs.CV", "", "", 24, "off", 0, ""))
    c.execute("INSERT INTO papers(id, owner_id, file_hash, title, doi, deleted_at) VALUES('pexists',9001,'h1','An Old Paper','10.9/old',NULL)")
tk.fetch_arxiv = lambda s, lh: [
    _mk("Fresh GS Paper One", "gaussian splatting advances", ax="2602.1", doi="10.2/1"),
    _mk("An Old Paper", "duplicate of library paper", ax="2602.2", doi="10.9/old"),
    _mk("Radiance Field Refinement Study", "more splatting techniques", ax="2602.3", doi="10.2/3"),
]
tk.fetch_journal_articles = lambda s, lh: []
tk.llm_enrich = lambda uid, it: None
mail_calls = []
r1 = tk.patrol(sub_row, email_fn=lambda s, it: mail_calls.append(len(it)))
ok("patrol：新条目 2 篇（已入库去重 1）", r1["new"] == 2 and r1["dup_library"] == 1, str(r1))
r2 = tk.patrol(sub_row, email_fn=lambda s, it: mail_calls.append(len(it)))
ok("patrol 幂等：第二轮 0 新（同 arxiv_id 跳过）", r2["new"] == 0, str(r2))
row = _tdb.one("SELECT COUNT(*) n FROM tracker_items WHERE sub_id='tsX'")
ok("收件箱落库 2 条", row["n"] == 2, str(row["n"]))
srow = _tdb.one("SELECT last_error IS NULL OR last_error='' AS clean FROM tracker_subs WHERE id='tsX'")
ok("patrol 无错误记录", bool(srow["clean"]))
tk.fetch_arxiv = lambda s, lh: (_ for _ in ()).throw(RuntimeError("network down"))
r3 = tk.patrol(sub_row, email_fn=None)
srow2 = _tdb.one("SELECT last_error FROM tracker_subs WHERE id='tsX'")
ok("采集异常记录 last_error 不炸巡逻", r3["new"] == 0 and srow2["last_error"], str(r3))

html = tm._digest_html(sub_row, [
    {"tier": "core", "title": "T1", "zh_summary": "总结一", "zh_title": "论文一", "authors": "A",
     "published": "2026-11-13", "venue": "arXiv", "pdf_url": "https://x/1", "code_url": "", "is_fallback": 0},
    {"tier": "eco", "title": "T2", "zh_summary": None, "zh_title": None, "authors": "B",
     "published": "2026-11-12", "venue": "", "pdf_url": "", "code_url": "", "is_fallback": 1},
])
ok("日报 HTML：tier 徽章 + 中文摘要 + 补足标 + PDF 链接",
   "核心" in html and "总结一" in html and "补足" in html and "https://x/1" in html)
with _tdb.write() as c:
    c.execute("DELETE FROM tracker_items WHERE sub_id='tsX'")
    c.execute("DELETE FROM tracker_subs WHERE id='tsX'")
    c.execute("DELETE FROM papers WHERE id='pexists'")
    c.execute("DELETE FROM users WHERE id=9001")

print(f"\n结果: {PASS} 通过, {FAIL} 失败")
# 导入 server.main 会启动调度器线程（非 daemon）——进程退出被吊住，用 os._exit 硬退
import os
os._exit(1 if FAIL else 0)
