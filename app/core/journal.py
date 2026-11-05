"""期刊分区/影响因子：easyScholar 数据源（需注册 key）+ 本地缓存."""
from __future__ import annotations

import json

import httpx

from .config import EASYSCHOLAR_KEY, EASYSCHOLAR_URL
from .db import db


def get_journal_rank(journal: str, force: bool = False) -> dict:
    journal = (journal or "").strip()
    if not journal:
        return {"found": False, "message": "论文缺少期刊名（先用联网校准补全）"}
    if not EASYSCHOLAR_KEY:
        return {"found": False, "message": "未配置分区数据源：在 .env 填入 EASYSCHOLAR_KEY（easyscholar.cc 免费注册）"}

    if not force:
        row = db.one("SELECT data, source, fetched_at FROM journal_ranks WHERE journal=?",
                     (journal.lower(),))
        if row:
            return {"found": True, "cached": True, "fetched_at": row["fetched_at"],
                    **json.loads(row["data"])}

    try:
        r = httpx.get(EASYSCHOLAR_URL,
                      params={"secretKey": EASYSCHOLAR_KEY, "journalName": journal}, timeout=15)
    except httpx.HTTPError as e:
        return {"found": False, "message": f"数据源不可达: {e}"}
    if r.status_code != 200:
        return {"found": False, "message": f"数据源返回 {r.status_code}（检查 EASYSCHOLAR_KEY/URL）"}
    d = r.json()
    if d.get("code") not in (200, "200", 0, "0"):
        return {"found": False, "message": f"数据源拒绝: {d.get('msg') or d.get('data')}"}

    # easyScholar 返回字段：data → {rank: [{sciup: 大类分区, sciup_small: 小类, jcr: JCR分区, impact_factor: IF, ...}]}
    data = d.get("data") or {}
    rank = (data.get("rank") or [{}])[0]
    out = {
        "journal": rank.get("journal_name") or journal,
        "cas": rank.get("sciup") or "",                  # 中科院大类分区
        "cas_small": rank.get("sciup_small") or "",      # 中科院小类分区
        "jcr": rank.get("jcr") or "",                    # JCR 分区 Q1-Q4
        "impact_factor": rank.get("impact_factor") or "",
        "source": "easyScholar",
        "found": bool(rank),
    }
    if out["found"]:
        with db.write() as c:
            c.execute(
                "INSERT INTO journal_ranks(journal,data,source) VALUES(?,?,?) "
                "ON CONFLICT(journal) DO UPDATE SET data=?, source=?, fetched_at=datetime('now')",
                (journal.lower(), json.dumps(out, ensure_ascii=False), "easyScholar",
                 json.dumps(out, ensure_ascii=False), "easyScholar"),
            )
    else:
        out["message"] = "数据源中未收录该期刊"
    return out
