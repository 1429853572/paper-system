"""文献库核心操作：删库（多对多语义）。

独立于 server.main——backend-test 无需启动调度线程即可测删库语义。
"""
from __future__ import annotations

from .db import db


def delete_subtree(cid: str, user_id: int, is_admin: bool) -> dict:
    """删除文献库（整个子树）。多对多语义：论文移出该库；摘后不再属于
    任何库且属于删除者（admin 可任意）→ 进回收站；仍挂其他库的论文不受
    影响；他人的无主共享论文只摘链不回收。"""
    row = db.one("SELECT owner_id FROM collections WHERE id=?", (cid,))
    if row is None or (row["owner_id"] != user_id and not is_admin):
        return {}   # 由端点映射 404
    ids = [cid]
    frontier = [cid]
    while frontier:                       # BFS 子树（对齐 main._subtree_ids）
        nxt = []
        for x in frontier:
            nxt.extend(r["id"] for r in db.all(
                "SELECT id FROM collections WHERE parent_id=?", (x,)))
        ids.extend(nxt)
        frontier = nxt
    ph = ",".join("?" * len(ids))
    papers = db.all(
        f"SELECT DISTINCT p.id, p.owner_id, p.title FROM papers p "
        f"JOIN paper_collections pc ON pc.paper_id=p.id "
        f"WHERE pc.collection_id IN ({ph}) AND p.deleted_at IS NULL", ids)
    trashed = unlinked = 0
    from core.jobs import scheduler   # 复用其任务取消（与解析/翻译调度同一把刷子）
    for p in papers:
        with db.write() as c:
            c.execute(f"DELETE FROM paper_collections WHERE collection_id IN ({ph}) "
                      "AND paper_id=?", (*ids, p["id"]))
        still = db.one("SELECT COUNT(*) AS n FROM paper_collections WHERE paper_id=?",
                       (p["id"],))["n"]
        mine = is_admin or p["owner_id"] == user_id
        if still == 0 and mine:
            for j in db.all("SELECT * FROM jobs WHERE paper_id=? AND status IN "
                            "('queued','pending_gate','running')", (p["id"],)):
                if j["remote_task_id"]:
                    from . import mineru_client
                    mineru_client.cancel(j["remote_task_id"])
                with db.write() as c:
                    c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
            with db.write() as c:
                c.execute("UPDATE papers SET deleted_at=datetime('now') WHERE id=?", (p["id"],))
                c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (p["id"],))
            trashed += 1
        else:
            unlinked += 1
    from core.retrieval import invalidate_vec_cache
    invalidate_vec_cache()
    with db.write() as c:
        c.execute(f"DELETE FROM collections WHERE id IN ({ph})", ids)
    return {"ok": True, "libs": len(ids), "trashed": trashed, "unlinked": unlinked}
