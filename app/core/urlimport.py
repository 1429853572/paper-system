"""URL 导入公共路径：先把原文件抓回本地，落盘失败才退回 MinerU 代抓。

此前 URL 导入（import-url / 找相关导入 / 标识符导入 / MCP 导入）只把 URL 交给
MinerU 服务端抓取，本地从未存原文件 → 论文永久「无 PDF 预览」+ 列表页数显示
「?页」。这里统一改为：服务端先下载（跟重定向）→ 是 PDF 就本地落盘
（页数/文件大小真实入库，/pdf 预览直接可用）→ 解析任务走本地文件；
下载失败或非 PDF（Office/落地页）→ 保留原 MinerU 代抓路径。
"""
from __future__ import annotations

import httpx

from . import ingest
from .db import db

_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch_remote(url: str, timeout: int = 90) -> tuple[bytes | None, str]:
    """下载 URL 内容（跟重定向）。返回 (data|None, content_type)；失败 (None, '')。"""
    try:
        r = httpx.get(url, headers={"User-Agent": _UA, "Accept": "*/*"},
                      timeout=timeout, follow_redirects=True)
        if r.status_code != 200 or not r.content:
            return None, ""
        return r.content, (r.headers.get("content-type") or "").lower()
    except Exception:  # noqa: BLE001 —— 网络/超时/证书：一律退回 MinerU 代抓
        return None, ""


def import_paper_from_url(user_id: int, url: str, *, visibility: str = "shared",
                          collection_id: str | None = None, priority: str = "interactive",
                          title: str = "", meta: dict | None = None,
                          is_admin: bool = True, overrides: dict | None = None) -> dict:
    """URL → 建论文 → （能落盘则落盘）→ 解析入队。返回 {paper_id, status, stored, pages}。

    meta 非空时把已知元数据一并写入（S2/CrossRef 已给全，MinerU 标题提取会再校准）。
    file_hash 维持 "url:"+sha256(url)（同 URL 去重语义不变）。
    """
    file_hash = "url:" + ingest.sha256_bytes(url.encode())
    exist = db.one("SELECT id FROM papers WHERE file_hash=? AND deleted_at IS NULL", (file_hash,))
    if exist:
        return {"paper_id": exist["id"], "status": "duplicate", "stored": False, "pages": 0}

    data, _ct = fetch_remote(url)
    stored = False
    pages, size = 0, 0
    fname = url.split("?")[0].rsplit("/", 1)[-1] or "document.pdf"
    payload: dict = {"tier": "standard"}
    if data and data[:5] == b"%PDF-":
        try:
            pages, kind = ingest.preflight_doc(data, fname + ".pdf",
                                               is_admin=is_admin, overrides=overrides or {})
        except ingest.PreflightError:
            data = None   # 加密/损坏/超限 → 不落盘，交 MinerU 代抓（它有自己的容错）
        else:
            stored = True
            size = len(data)
            if not fname.lower().endswith(".pdf"):
                fname += ".pdf"

    paper_id, _ = ingest.create_paper(user_id, file_hash, pages, size, visibility,
                                      title or fname)
    if collection_id:
        with db.write() as c:
            c.execute("UPDATE papers SET collection_id=? WHERE id=?", (collection_id, paper_id))
    if meta:
        sets, args = [], []
        for k in ("title", "authors", "year", "journal", "doi", "abstract"):
            v = (meta.get(k) or "").strip()
            if v:
                sets.append(f"{k}=?")
                args.append(v[:3000])
        if sets:
            with db.write() as c:
                c.execute(f"UPDATE papers SET {', '.join(sets)} WHERE id=?", (*args, paper_id))
    if stored:
        ingest.store_pdf(paper_id, data, fname)
    else:
        payload["url"] = url   # MinerU 代抓路径（原行为）

    from .jobs import scheduler
    scheduler.enqueue(user_id, "parse", paper_id, payload, priority=priority)
    return {"paper_id": paper_id, "status": "queued", "stored": stored, "pages": pages}
