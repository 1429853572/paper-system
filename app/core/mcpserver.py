"""MCP Server（JSON-RPC over HTTP）：ZCode / Claude 等客户端直连文献库。

- 认证：bearer PAPERSYS_API_TOKEN（服务间令牌，与 CLI 共用，非用户会话）
- 读工具直接执行：search_papers / read_paper / search_text / get_summary / cite
- 写工具默认关闭（PAPERSYS_MCP_TOOLSETS 含 write 时开放）：
  update_meta / import_by_doi 不直接执行 → 返回 requires_confirmation + action_id，
  人工在网页「队列」浮层确认执行或丢弃（llm-for-zotero 的 reviewable actions 式）；
  执行记录可撤销（undo_last_action，每用户最近 10 条，撤销=回写旧值/删新建行）。
- 配额与审计：写动作落 audit_log；属主校验按 token 所属 admin 用户。
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime

from .db import db

_READ_TOOLS = [
    ("search_papers", "按标题/作者关键词搜索文献库", {
        "type": "object", "properties": {
            "query": {"type": "string"}, "limit": {"type": "integer", "default": 10}},
        "required": ["query"]}),
    ("read_paper", "读单篇论文元数据与摘要", {
        "type": "object", "properties": {"paper_id": {"type": "string"}}, "required": ["paper_id"]}),
    ("search_text", "全文检索（返回命中段落及所在页）", {
        "type": "object", "properties": {
            "query": {"type": "string"}, "limit": {"type": "integer", "default": 8}},
        "required": ["query"]}),
    ("get_summary", "获取论文 9 字段结构化导读", {
        "type": "object", "properties": {"paper_id": {"type": "string"}}, "required": ["paper_id"]}),
    ("cite", "格式化引用（gbt7714/apa/mla/bibtex）", {
        "type": "object", "properties": {
            "paper_id": {"type": "string"}, "style": {"type": "string", "default": "gbt7714"}},
        "required": ["paper_id"]}),
]

_WRITE_TOOLS = [
    ("update_meta", "更新论文元数据（需网页确认后执行）", {
        "type": "object", "properties": {
            "paper_id": {"type": "string"},
            "fields": {"type": "object", "description": "title/authors/year/journal/doi/volume/issue/pages 的子集"}},
        "required": ["paper_id", "fields"]}),
    ("import_by_doi", "按 DOI 导入新论文（元数据+OA PDF，需网页确认后执行）", {
        "type": "object", "properties": {"doi": {"type": "string"}}, "required": ["doi"]}),
    ("undo_last_action", "撤销最近一次写操作", {"type": "object", "properties": {}}),
]

# 中文文献采集（宿主浏览器服务；需该服务在运行）
_ACQ_TOOLS = [
    ("search_cnki", "检索中文文献（chinaxiv 预印本 / 知网），返回候选与下载直链", {
        "type": "object", "properties": {
            "query": {"type": "string", "description": "关键词（中文主题/标题）"},
            "site": {"type": "string", "enum": ["chinaxiv", "cnki"], "default": "chinaxiv"},
            "limit": {"type": "integer", "default": 10}},
        "required": ["query"]}),
    ("acquire_cnki", "把中文文献候选下载并入库（复用既有解析管线）", {
        "type": "object", "properties": {
            "items": {"type": "array", "description": "search_cnki 结果中的候选（含 pdf_url/title）",
                      "items": {"type": "object"}}},
        "required": ["items"]}),
]


def writes_enabled() -> bool:
    return "write" in (os.environ.get("PAPERSYS_MCP_TOOLSETS") or "read").lower()


# ---------------- 内存态：待确认 / 撤销栈 ----------------
_PENDING: dict[str, dict] = {}       # action_id → 待确认动作
_UNDO: dict[int, list[dict]] = {}    # user_id → 已执行动作（最近 10）


def pending_for(user_id: int) -> list[dict]:
    return [dict(v, action_id=k) for k, v in _PENDING.items() if v["user_id"] == user_id
            and v.get("status") == "pending"]


def confirm_action(user_id: int, action_id: str, approve: bool) -> dict:
    act = _PENDING.get(action_id)
    if act is None or act["user_id"] != user_id:
        return {"ok": False, "message": "待确认动作不存在（可能已处理）"}
    del _PENDING[action_id]
    if not approve:
        act["status"] = "discarded"
        return {"ok": True, "executed": False, "message": "已丢弃"}
    try:
        inverse = _execute(act)
        act["status"] = "executed"
        stack = _UNDO.setdefault(user_id, [])
        stack.append({"action_id": action_id, "tool": act["tool"],
                      "summary": act.get("summary") or "", "inverse": inverse})
        del stack[:-10]
        return {"ok": True, "executed": True, "summary": act.get("summary") or ""}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "executed": False, "message": f"执行失败: {e}"}


def _execute(act: dict) -> dict:
    """执行已确认动作，返回撤销信息（inverse）。"""
    from .meta import verify_meta_online

    if act["tool"] == "update_meta":
        pid = act["args"]["paper_id"]
        fields = {k: str(v)[:3000] for k, v in (act["args"].get("fields") or {}).items()
                  if k in ("title", "authors", "year", "journal", "doi", "volume", "issue", "pages")}
        row = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if row is None:
            raise ValueError("论文不存在")
        inverse = {"tool": "update_meta", "paper_id": pid,
                   "fields": {k: row[k] or "" for k in fields},
                   "applied": dict(fields)}   # CAS 基准：撤销时字段仍等于本次写入值才回退
        sets = ", ".join(f"{k}=?" for k in fields)
        with db.write() as c:
            c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*fields.values(), pid))
        return inverse
    if act["tool"] == "import_by_doi":
        from . import identifier
        meta = identifier.resolve_identifier("doi", act["args"]["doi"])
        url = meta.get("pdf_url") or ""
        if not url.startswith(("http://", "https://")):
            raise ValueError("该 DOI 无公开 PDF，导入中止")
        if db.one("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", (meta["doi"],)):
            raise ValueError("该 DOI 已在库中")
        from .urlimport import import_paper_from_url
        r = import_paper_from_url(act["user_id"], url, title=meta["title"],
                                  collection_id=ingest_default_collection(act["user_id"]),
                                  meta={"authors": meta.get("authors"), "year": meta.get("year"),
                                        "journal": meta.get("journal"), "doi": meta.get("doi"),
                                        "abstract": meta.get("abstract")})
        return {"tool": "import_by_doi", "paper_id": r["paper_id"]}
    raise ValueError("未知动作类型")


def ingest_default_collection(user_id: int) -> str | None:
    row = db.one("SELECT id FROM collections WHERE owner_id=? ORDER BY id LIMIT 1", (user_id,))
    return row["id"] if row else None


def undo_last(user_id: int) -> dict:
    stack = _UNDO.get(user_id) or []
    if not stack:
        return {"ok": False, "message": "没有可撤销的写操作"}
    act = stack.pop()
    inv = act["inverse"]
    try:
        if inv["tool"] == "update_meta":
            fields, applied = inv["fields"], inv.get("applied") or {}
            conflicts = []
            with db.write() as c:
                for k, old in fields.items():
                    # CAS：字段仍是本次写入值才回退；已被他人改过 → 保留并上报
                    cur = c.execute(
                        f"UPDATE papers SET {k}=? WHERE id=? AND {k}=?",
                        (old, inv["paper_id"], applied.get(k, "")))
                    if cur.rowcount == 0:
                        conflicts.append(k)
            if conflicts:
                return {"ok": True, "message":
                        f"部分字段已被后续修改，未回退: {', '.join(conflicts)}；其余已撤销"}
        elif inv["tool"] == "import_by_doi":
            from .jobs import scheduler
            scheduler.hard_delete_paper(inv["paper_id"])
        return {"ok": True, "message": f"已撤销：{act['tool']} {act.get('summary', '')}".strip()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"撤销失败: {e}"}


# ---------------- 工具实现（读直接跑） ----------------

def _visible_cond() -> str:
    return " AND p.deleted_at IS NULL"


def run_tool(user_id: int, name: str, args: dict) -> dict:
    if name == "search_papers":
        q = f"%{(args.get('query') or '').strip()}%"
        limit = min(int(args.get("limit") or 10), 50)
        rows = db.all(
            "SELECT p.id, p.title, p.authors, p.year, p.journal, p.doi, p.parse_status "
            "FROM papers p WHERE p.deleted_at IS NULL "
            "AND (p.title LIKE ? OR p.authors LIKE ?) ORDER BY p.created_at DESC LIMIT ?",
            (q, q, limit))
        return {"papers": [dict(r) for r in rows]}
    if name == "read_paper":
        r = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (args.get("paper_id"),))
        if r is None:
            raise ValueError("论文不存在")
        return {"paper": dict(r)}
    if name == "search_text":
        from .retrieval import fts_query
        q = fts_query((args.get("query") or "").strip())
        limit = min(int(args.get("limit") or 8), 20)
        rows = db.all(
            "SELECT f.text, f.paper_id, p.title FROM chunks_fts f "
            "JOIN papers p ON p.id=f.paper_id WHERE chunks_fts MATCH ? "
            "AND p.deleted_at IS NULL LIMIT ?", (q, limit))
        return {"hits": [{"paper_id": r["paper_id"], "title": r["title"],
                          "text": r["text"][:500]} for r in rows]}
    if name == "get_summary":
        r = db.one("SELECT content, model FROM summaries WHERE paper_id=? "
                   "ORDER BY created_at DESC LIMIT 1", (args.get("paper_id"),))
        if r is None:
            return {"summary": None, "message": "该论文还没有导读"}
        try:
            sec = json.loads(r["content"]).get("sections", {})
        except Exception:  # noqa: BLE001
            sec = {}
        return {"summary": sec, "model": r["model"]}
    if name == "cite":
        from .cite import format_citation
        r = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (args.get("paper_id"),))
        if r is None:
            raise ValueError("论文不存在")
        return {"citation": format_citation(dict(r), args.get("style") or "gbt7714")}
    if name == "update_meta":
        pid = args.get("paper_id")
        if db.one("SELECT id FROM papers WHERE id=? AND deleted_at IS NULL", (pid,)) is None:
            raise ValueError("论文不存在")
        act_id = uuid.uuid4().hex[:10]
        _PENDING[act_id] = {"user_id": user_id, "tool": "update_meta", "args": args,
                            "status": "pending", "created_at": datetime.now().isoformat(timespec="seconds"),
                            "summary": f"更新元数据 {pid}"}
        return {"requires_confirmation": True, "action_id": act_id,
                "message": "已生成待确认动作——请在 paper-system 网页「队列」浮层中确认执行"}
    if name == "import_by_doi":
        doi = (args.get("doi") or "").strip()
        if not doi.startswith("10."):
            raise ValueError("无效 DOI")
        if db.one("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", (doi,)):
            raise ValueError("该 DOI 已在库中")
        act_id = uuid.uuid4().hex[:10]
        _PENDING[act_id] = {"user_id": user_id, "tool": "import_by_doi", "args": args,
                            "status": "pending", "created_at": datetime.now().isoformat(timespec="seconds"),
                            "summary": f"导入 DOI {doi}"}
        return {"requires_confirmation": True, "action_id": act_id,
                "message": "已生成待确认动作——请在 paper-system 网页「队列」浮层中确认执行"}
    if name == "undo_last_action":
        return undo_last(user_id)
    if name == "search_cnki":
        from . import acquire
        q = (args.get("query") or "").strip()
        if not q:
            raise ValueError("query 必填")
        site = (args.get("site") or "chinaxiv").strip()
        try:
            items = acquire.search(site, q, 1, min(int(args.get("limit") or 10), 30))
        except ValueError as e:
            raise ValueError(str(e)) from None
        titles = {r[0].lower() for r in db.all("SELECT title FROM papers WHERE deleted_at IS NULL")}
        for it in items:
            it["in_library"] = (it.get("title") or "").strip().lower() in titles
        return {"site": site, "count": len(items), "items": items}
    if name == "acquire_cnki":
        from . import acquire
        picks = [x for x in (args.get("items") or []) if isinstance(x, dict)][:10]
        if not picks:
            raise ValueError("items 为空")
        out, skipped = [], []
        for it in picks:
            url = (it.get("pdf_url") or "").strip()
            title = (it.get("title") or "").strip() or "未命名"
            if not url.startswith(("http://", "https://")):
                skipped.append({"title": title, "reason": "无 pdf_url"})
                continue
            try:
                data, _ct, fname = acquire.fetch(url)
            except ValueError as e:
                skipped.append({"title": title, "reason": str(e)[:120]})
                continue
            if not data or data[:5] != b"%PDF-":
                skipped.append({"title": title, "reason": "非 PDF 内容"})
                continue
            from . import ingest
            try:
                pages, _k = ingest.preflight_doc(data, fname or "paper.pdf", is_admin=True, overrides={})
            except Exception as e:  # noqa: BLE001
                skipped.append({"title": title, "reason": str(e)[:100]})
                continue
            fh = ingest.sha256_bytes(data)
            pid, dup = ingest.create_paper(user_id, fh, pages, len(data), "shared", fname or "paper.pdf")
            if dup:
                skipped.append({"title": title, "reason": "已在库中"})
                continue
            with db.write() as c:
                c.execute("UPDATE papers SET title=COALESCE(NULLIF(title,''),?) WHERE id=?", (title, pid))
                c.execute("UPDATE papers SET meta_source=COALESCE(meta_source,'acquire') WHERE id=?", (pid,))
                if it.get("authors"):
                    c.execute("UPDATE papers SET authors=? WHERE id=?", (it["authors"][:500], pid))
                if it.get("year"):
                    c.execute("UPDATE papers SET year=? WHERE id=?", (it["year"][:10], pid))
            ingest.store_pdf(pid, data, "original.pdf")
            from .jobs import scheduler
            scheduler.enqueue(user_id, "parse", pid,
                              {"tier": "standard", "original_name": fname or "paper.pdf",
                               "source_url": url}, priority="background")
            out.append({"title": title, "paper_id": pid})
        return {"imported": out, "skipped": skipped}
    raise ValueError(f"未知工具: {name}")


# ---------------- JSON-RPC 分发 ----------------

def handle(user_id: int, payload: dict) -> dict:
    method = payload.get("method") or ""
    rid = payload.get("id")
    params = payload.get("params") or {}

    def ok(result) -> dict:
        return {"jsonrpc": "2.0", "id": rid, "result": result}

    def err(code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            return ok({"protocolVersion": "2024-11-05",
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": "paper-system", "version": "1.0"}})
        if method == "ping":
            return ok({})
        if method == "tools/list":
            tools = [{"name": n, "description": d, "inputSchema": s}
                     for n, d, s in _READ_TOOLS]
            tools += [{"name": n, "description": d, "inputSchema": s}
                      for n, d, s in _ACQ_TOOLS]          # 采集是写动作但走既有入库管线，不需确认卡
            if writes_enabled():
                tools += [{"name": n, "description": d, "inputSchema": s}
                          for n, d, s in _WRITE_TOOLS]
            return ok({"tools": tools})
        if method == "tools/call":
            name = params.get("name") or ""
            if name in {n for n, _, _ in _WRITE_TOOLS} and not writes_enabled():
                return err(-32601, "写工具未启用（设置 PAPERSYS_MCP_TOOLSETS=read,write）")
            if name in {n for n, _, _ in _ACQ_TOOLS} and name == "acquire_cnki" \
                    and not writes_enabled():
                return err(-32601, "采集入库属写操作，请开启 PAPERSYS_MCP_TOOLSETS=read,write")
            result = run_tool(user_id, name, params.get("arguments") or {})
            return ok({"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]})
        return err(-32601, f"未知方法: {method}")
    except ValueError as e:
        return err(-32000, str(e))
    except Exception as e:  # noqa: BLE001
        return err(-32603, f"内部错误: {e}")
