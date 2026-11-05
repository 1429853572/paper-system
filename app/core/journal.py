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

    url = EASYSCHOLAR_URL or "https://www.easyscholar.cc/open/getPublicationRank"
    try:
        r = httpx.get(url,
                      params={"secretKey": EASYSCHOLAR_KEY, "publicationName": journal}, timeout=15)
    except httpx.HTTPError as e:
        return {"found": False, "message": f"数据源不可达: {e}"}
    if r.status_code != 200:
        return {"found": False, "message": f"数据源返回 {r.status_code}（检查 EASYSCHOLAR_KEY/URL）"}
    d = r.json()
    if d.get("code") not in (200, "200", 0, "0"):
        return {"found": False, "message": f"数据源拒绝: {d.get('msg')}"}

    # 实测结构: data.officialRank.all = {sciUp: 中科院大类升级版, sciUpSmall, sciUpTop,
    #          sci: JCR Q1-Q4, sciif: 影响因子, sciif5: 5年IF, sciWarning: 预警}
    all_rank = ((d.get("data") or {}).get("officialRank") or {}).get("all") or {}
    out = {
        "journal": journal,
        "cas": all_rank.get("sciUp") or "",              # 中科院大类（升级版）
        "cas_small": all_rank.get("sciUpSmall") or "",   # 中科院小类
        "cas_top": all_rank.get("sciUpTop") or "",       # TOP 期刊
        "jcr": all_rank.get("sci") or "",                # JCR Q1-Q4
        "impact_factor": all_rank.get("sciif") or "",
        "if5": all_rank.get("sciif5") or "",
        "warning": all_rank.get("sciWarning") or "",
        "source": "easyScholar",
        "found": bool(all_rank),
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
