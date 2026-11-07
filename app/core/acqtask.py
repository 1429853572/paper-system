"""专题采集任务：关键词 → 检索候选 → 勾选下载入库 → 综述（可中断可恢复）。

与「一次性采集弹层」的本质差别：
- 任务持久化在库里（关掉页面继续跑、重启后 recover 续传）
- 每篇候选的下载状态单独记录（断点续传：已下载的不重复下）
- 下载走 jobs 队列（不占 web worker，进度进任务中心）
- 综述联动：论文全部解析完成后可一键生成，专题名作为研究问题先验注入综述
"""
from __future__ import annotations

import json
import uuid

from .db import db

STATUSES = {
    "draft": "待检索",
    "searching": "检索中",
    "ready": "待勾选",
    "downloading": "下载中",
    "ingested": "已入库",
    "reviewing": "综述中",
    "done": "已完成",
    "failed": "失败",
}

# 候选里的下载状态
DL_PENDING = "pending"
DL_OK = "done"
DL_FAIL = "failed"
DL_SKIP = "skipped"


def create(user_id: int, title: str, query: str, site: str = "chinaxiv",
           filters: dict | None = None) -> str:
    tid = "atk" + uuid.uuid4().hex[:10]
    with db.write() as c:
        c.execute(
            "INSERT INTO acq_tasks(id,user_id,title,query,site,filters,status) "
            "VALUES(?,?,?,?,?,?,'draft')",
            (tid, user_id, title[:120], query[:300], site,
             json.dumps(filters or {}, ensure_ascii=False)))
    return tid


def get(task_id: str) -> dict | None:
    row = db.one("SELECT * FROM acq_tasks WHERE id=?", (task_id,))
    if row is None:
        return None
    d = dict(row)
    for k in ("filters", "candidates", "paper_ids"):
        try:
            d[k] = json.loads(d.get(k) or ("[]" if k != "filters" else "{}"))
        except Exception:  # noqa: BLE001
            d[k] = [] if k != "filters" else {}
    d["status_label"] = STATUSES.get(d["status"], d["status"])
    return d


def update(task_id: str, **fields) -> None:
    if not fields:
        return
    sets, args = [], []
    for k, v in fields.items():
        sets.append(f"{k}=?")
        args.append(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
    args.append(task_id)
    with db.write() as c:
        c.execute(f"UPDATE acq_tasks SET {', '.join(sets)}, updated_at=datetime('now') WHERE id=?",
                  tuple(args))


def set_candidates(task_id: str, candidates: list[dict]) -> None:
    """覆盖候选（重新检索时保留已勾选与已下载状态）。"""
    cur = get(task_id)
    old = {c.get("pdf_url") or c.get("title"): c for c in (cur or {}).get("candidates", [])}
    merged = []
    for c in candidates:
        key = c.get("pdf_url") or c.get("title")
        prev = old.get(key) or {}
        merged.append({**c,
                       "selected": bool(prev.get("selected")),
                       "dl_status": prev.get("dl_status") or DL_PENDING,
                       "paper_id": prev.get("paper_id"),
                       "error": prev.get("error")})
    update(task_id, candidates=merged)


def candidate(task_id: str, pdf_url: str) -> dict | None:
    for c in get(task_id).get("candidates", []):
        if c.get("pdf_url") == pdf_url:
            return c
    return None


def mark_candidate(task_id: str, pdf_url: str, **fields) -> None:
    cands = get(task_id).get("candidates", [])
    changed = False
    for c in cands:
        if c.get("pdf_url") == pdf_url:
            c.update(fields)
            changed = True
    if changed:
        update(task_id, candidates=cands)


def selected_candidates(task_id: str) -> list[dict]:
    return [c for c in get(task_id).get("candidates", []) if c.get("selected")]


def attach_papers(task_id: str, paper_ids: list[str]) -> None:
    cur = get(task_id)
    ids = list(dict.fromkeys((cur.get("paper_ids") or []) + paper_ids))
    update(task_id, paper_ids=ids)


def task_of_paper(paper_id: str) -> str | None:
    row = db.one("SELECT acq_task_id FROM papers WHERE id=?", (paper_id,))
    return row["acq_task_id"] if row else None


def all_parsed(paper_ids: list[str]) -> bool:
    """全部论文解析完成（综述的前置条件）。"""
    if not paper_ids:
        return False
    marks = ",".join("?" * len(paper_ids))
    row = db.one(
        f"SELECT COUNT(*) n FROM papers WHERE id IN ({marks}) "
        "AND deleted_at IS NULL AND parse_status='parsed'", tuple(paper_ids))
    total = db.one(
        f"SELECT COUNT(*) n FROM papers WHERE id IN ({marks}) AND deleted_at IS NULL",
        tuple(paper_ids))
    return bool(row and total and row["n"] == total["n"])
