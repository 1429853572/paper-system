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

from .config import config
from .db import db
from .ingest import attach_to_collection

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
# 读工具：只检索不落库
_ACQ_READ_TOOLS = [
    ("search_cnki", "检索中文文献（chinaxiv 预印本 / 知网），返回候选与下载直链", {
        "type": "object", "properties": {
            "query": {"type": "string", "description": "关键词（中文主题/标题）"},
            "site": {"type": "string", "enum": ["chinaxiv", "cnki"], "default": "chinaxiv"},
            "limit": {"type": "integer", "default": 10}},
        "required": ["query"]}),
]
# 写工具：落库/下载（需 PAPERSYS_MCP_TOOLSETS=read,write）
_ACQ_WRITE_TOOLS = [
    ("create_topic_task", "创建专题采集任务（关键词→检索→勾选下载→综述）并立即检索候选", {
        "type": "object", "properties": {
            "title": {"type": "string", "description": "专题名（同时作为综述的研究问题先验）"},
            "query": {"type": "string", "description": "检索关键词"},
            "site": {"type": "string", "enum": ["chinaxiv", "cnki"], "default": "chinaxiv"},
            "limit": {"type": "integer", "default": 20}},
        "required": ["title", "query"]}),
    ("list_topic_tasks", "列出我的专题采集任务与候选", {"type": "object", "properties": {}}),
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
        # MCP 链路同样过 SSRF 校验（此前仅 3 处 HTTP 端点有——MCP 是漏网入口）
        from .config import DATA_DIR
        try:
            import ipaddress
            from urllib.parse import urlparse as _up
            _h = (_up(url).hostname or "").lower()
            _ip = None
            try:
                _ip = ipaddress.ip_address(_h)
            except ValueError:
                pass
            if not _h or _h in ("localhost",) or _h.endswith((".local", ".internal")) \
                    or (_ip is not None and not _ip.is_global):
                return {"tool": "import_by_doi", "error": "URL 不允许（内网/环回地址）"}
        except Exception:  # noqa: BLE001
            pass
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
    if name == "create_topic_task":
        from . import acqtask, acquire
        title = (args.get("title") or "").strip()[:120]
        query = (args.get("query") or "").strip()[:300]
        if not query:
            raise ValueError("query 必填")
        site = (args.get("site") or "chinaxiv").strip()
        tid = acqtask.create(user_id, title or query, query, site)
        try:
            items = acquire.search(site, query, 1, min(int(args.get("limit") or 20), 40))
        except ValueError as e:
            acqtask.update(tid, status="failed", error=str(e)[:300])
            raise ValueError(str(e)) from None
        titles = {r[0].lower() for r in db.all("SELECT title FROM papers WHERE deleted_at IS NULL")}
        cands = [{"title": it.get("title") or "", "authors": it.get("authors") or "",
                   "year": it.get("year") or "", "venue": it.get("venue") or "",
                   "summary": it.get("summary") or "", "pdf_url": it.get("pdf_url") or "",
                   "abs_url": it.get("abs_url") or "", "doi": it.get("doi") or "",
                   "source": it.get("source") or site,
                   "in_library": (it.get("title") or "").strip().lower() in titles}
                  for it in items]
        acqtask.set_candidates(tid, cands)
        acqtask.update(tid, status="ready")
        return {"task_id": tid, "title": title or query, "count": len(cands),
                "candidates": cands,
                "next": "把候选的 pdf_url/title 等字段放入 acquire_cnki(items=[...]) 即可下载入库"}
    if name == "list_topic_tasks":
        from . import acqtask
        rows = db.all("SELECT id,title,query,site,status,paper_ids,synthesis_id "
                      "FROM acq_tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 20",
                      (user_id,))
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["papers"] = len(json.loads(d.get("paper_ids") or "[]"))
            except Exception:  # noqa: BLE001
                d["papers"] = 0
            out.append(d)
        return {"tasks": out}
    if name == "acquire_cnki":
        from . import acquire
        picks = [x for x in (args.get("items") or []) if isinstance(x, dict)][:10]
        if not picks:
            raise ValueError("items 为空")
        role = (db.one("SELECT role FROM users WHERE id=?", (user_id,)) or {}).get("role", "member")
        # 落默认分库（与 HTTP 链路一致，避免落在「未分库」）
        row = db.one("SELECT id FROM collections WHERE owner_id=? ORDER BY id LIMIT 1", (user_id,))
        default_cid = row["id"] if row else None
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
            if data[:5] != b"%PDF-":
                from . import caj as caj_mod
                try:
                    data = caj_mod.convert_bytes(data, fname or "paper.pdf")
                except caj_mod.ConvertError as e:
                    skipped.append({"title": title, "reason": f"非 PDF 且转换失败: {str(e)[:110]}"})
                    continue
            # MCP 通道与 HTTP 同闸：此前 acquire_cnki 无每日解析配额
            _qrow = db.one("SELECT overrides FROM user_quotas WHERE user_id=?",
                           (act["user_id"],))
            try:
                _qov = json.loads(_qrow["overrides"]) if _qrow and _qrow["overrides"] else {}
            except ValueError:
                _qov = {}
            _used = db.one(
                "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND job_type='parse' "
                "AND created_at>=date('now')", (act["user_id"],))["n"]
            _limit = int(_qov.get("daily_parse_papers")
                         or config.get("limits", "daily_parse_papers"))
            if _used >= _limit:
                skipped.append({"title": title,
                                "reason": f"已达今日解析配额（{_used}/{_limit}）"})
                continue
            try:
                # is_admin 用真实角色：否则 MCP 通道能绕过 member 的页数限额
                pages, _k = ingest.preflight_doc(data, fname or "paper.pdf",
                                                 is_admin=(role == "admin"), overrides={})
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
            attach_to_collection(pid, default_cid)   # 自带写锁——必须在 with 块外（嵌套即自死锁）
            with db.write() as c:
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
                      for n, d, s in _ACQ_READ_TOOLS]
            if writes_enabled():
                tools += [{"name": n, "description": d, "inputSchema": s}
                          for n, d, s in _WRITE_TOOLS + _ACQ_WRITE_TOOLS]
            return ok({"tools": tools})
        if method == "tools/call":
            name = params.get("name") or ""
            if name in {n for n, _, _ in _WRITE_TOOLS} and not writes_enabled():
                return err(-32601, "写工具未启用（设置 PAPERSYS_MCP_TOOLSETS=read,write）")
            if name in {n for n, _, _ in _ACQ_WRITE_TOOLS} and not writes_enabled():
                return err(-32601, "采集入库/建专题属写操作，请开启 PAPERSYS_MCP_TOOLSETS=read,write")
            result = run_tool(user_id, name, params.get("arguments") or {})
            return ok({"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]})
        return err(-32601, f"未知方法: {method}")
    except ValueError as e:
        return err(-32000, str(e))
    except Exception as e:  # noqa: BLE001
        return err(-32603, f"内部错误: {e}")
