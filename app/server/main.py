"""paper-system API 服务 (FastAPI)."""
from __future__ import annotations

import io
import json
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core import auth, ingest, qa, retrieval, summarizer, synthesis
from core.config import (DATA_DIR, MINERU_BASE_URL, OLLAMA_BASE_URL,
                           PAPERSYS_API_TOKEN, config)
from core.db import db
from core.jobs import bus, scheduler
from core.llm import LLMClient, NoKeyError, test_connection
from core.mineru_client import mineru

app = FastAPI(title="paper-system", docs_url=None, redoc_url=None)


import logging
log = logging.getLogger("app")


def audit(user_id: int | None, action: str, detail: str = "") -> None:
    """敏感操作审计（audit_log 表；管理区可查）。"""
    with db.write() as c:
        c.execute("INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)",
                  (user_id, action, detail[:300]))


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """未捕获异常统一返回 JSON（此前 500 为纯文本，前端无法解析提示）。"""
    log.exception("未处理异常 %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "服务器内部错误"}, status_code=500)


@app.middleware("http")
async def _cache_policy(request: Request, call_next):
    """缓存策略：vendor 库（版本锁定、不变）长缓存 immutable；
    业务页面与 JS/CSS 保持 no-cache（ETag 304），改版后浏览器不跑旧代码."""
    resp = await call_next(request)
    p = request.url.path
    if p.startswith("/static/vendor/"):
        resp.headers["Cache-Control"] = "public, max-age=2592000, immutable"
    elif p.startswith("/static") or p in ("/", "/login"):
        resp.headers["Cache-Control"] = "no-cache"
    # 安全响应头（同源部署）
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    # CSP 用 CSP3 的 elem/attr 拆分，兼顾"注入防护"与"内联 onclick"：
    #   script-src-elem 'self'           → 禁止内联 <script> 块（XSS 注入的主要载体）
    #   script-src-attr 'unsafe-inline'  → 放行 onclick=... 属性（本代码库 70+ 处内联 handler）
    #   style-src-attr 'unsafe-inline'   → 放行 style="" 属性（viewer.js 动态定位用）
    #   worker-src blob:                 → pdf.js worker
    # 内联 <script> 已外置为 /static/login.js；若日后要彻底去掉 unsafe-inline，
    # 需先做 P4 重构（内联 handler 全部改为 addEventListener 绑定）。
    resp.headers.setdefault("Content-Security-Policy",
        "default-src 'self'; "
        "img-src 'self' data: blob:; "
        "style-src 'self'; style-src-attr 'unsafe-inline'; "
        "script-src 'self'; script-src-elem 'self'; script-src-attr 'unsafe-inline'; "
        "worker-src 'self' blob:; font-src 'self'; connect-src 'self'")
    return resp

WEBUI_DIR = Path(__file__).parent.parent / "webui"


# ---------------- 认证基础设施 ----------------
def current_user(request: Request) -> dict | None:
    # CLI admin token
    ah = request.headers.get("Authorization", "")
    if PAPERSYS_API_TOKEN and ah == f"Bearer {PAPERSYS_API_TOKEN}":
        row = db.one("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1")
        if row:
            return {"id": row["id"], "username": row["username"], "role": "admin"}
    token = request.cookies.get("ps_session")
    if token:
        u = auth.parse_session(token)
        if u and auth.check_token_ver(u):
            return u
    return None


def require(request: Request) -> dict:
    u = current_user(request)
    if u is None:
        raise HTTPException(401, "未登录")
    return u


def require_admin(request: Request) -> dict:
    u = require(request)
    if u["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return u


@app.on_event("startup")
def _startup() -> None:
    auth.ensure_admin()

    # 翻译任务处理器
    def _translate_handler(job) -> None:
        from core import translator

        payload = json.loads(job["payload"] or "{}")
        run = db.one(
            "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
            "ORDER BY created_at DESC LIMIT 1",
            (job["paper_id"],),
        )
        if run is None:
            raise ValueError("论文尚未解析完成")

        def cb(done: int, total: int) -> None:
            scheduler._update(job["id"], progress_done=done, progress_total=total)

        def cancel_check() -> bool:
            row = db.one("SELECT status FROM jobs WHERE id=?", (job["id"],))
            return bool(row and row["status"] == "canceled")

        n = translator.translate_paper(
            job["user_id"], job["paper_id"], run["id"],
            force_new=bool(payload.get("force_new_version")), progress_cb=cb,
            cancel_check=cancel_check,
        )
        # 外部取消时保留 canceled 状态，不覆盖为 done
        cur = db.one("SELECT status FROM jobs WHERE id=?", (job["id"],))
        if cur and cur["status"] != "canceled":
            scheduler._update(job["id"], status="done", progress_done=n, progress_total=n)

    scheduler.translate_handler = _translate_handler
    scheduler.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    scheduler.stop()


# ---------------- 健康与配置自检 ----------------
@app.get("/api/health")
def health():
    # 本地 AI 服务（xinference：embedding + rerank）
    ai_ok = False
    models: list[str] = []
    try:
        import httpx
        base = (os.environ.get("EMBED_BASE_URL") or OLLAMA_BASE_URL).rstrip("/")
        r = httpx.get(f"{base}/v1/models", timeout=5)
        if r.status_code == 200:
            models = [m.get("id", "") for m in r.json().get("data", [])]
            ai_ok = any("bge-m3" in m for m in models)
    except Exception:  # noqa: BLE001
        pass
    return {"db": True, "mineru": mineru.healthy(), "ai": ai_ok, "models": models,
            "trash_days": int(config.get("retention", "trash_days"))}


# ---------------- 登录/注册 ----------------
@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    ip = request.client.host if request.client else "?"
    uname = (body.get("username") or "").strip()
    try:
        auth.check_login_rate(ip, uname)
    except auth.AuthError as e:
        raise HTTPException(429, str(e))
    user = auth.authenticate(uname, body.get("password", ""))
    if user is None:
        auth.record_login_fail(ip, uname)
        raise HTTPException(401, "用户名或密码错误")
    token = auth.make_session(user["id"], user["role"], user.get("token_ver", 0))
    resp = JSONResponse({"id": user["id"], "username": user["username"], "role": user["role"]})
    resp.set_cookie("ps_session", token, httponly=True, samesite="lax",
                    max_age=auth.SESSION_MAX_AGE)
    audit(user["id"], "login", user["username"])
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("ps_session")
    return resp


@app.post("/api/password")
async def change_password(request: Request):
    """修改自己的密码：验证旧密码 → 更新 → token_ver+1 吊销全部旧会话（含当前）。"""
    u = require(request)
    body = await request.json()
    old_pw = body.get("old_password") or ""
    new_pw = body.get("new_password") or ""
    if len(new_pw) < 8:
        raise HTTPException(400, "新密码至少 8 位")
    row = db.one("SELECT password_hash FROM users WHERE id=?", (u["id"],))
    if not row or not auth.verify_password(old_pw, row["password_hash"]):
        raise HTTPException(400, "旧密码不正确")
    auth.bump_token_ver(u["id"])
    with db.write() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?",
                  (auth.hash_password(new_pw), u["id"]))
    audit(u["id"], "change-password", db.one("SELECT username FROM users WHERE id=?", (u["id"],))["username"])
    resp = JSONResponse({"ok": True})
    # 当前会话也被吊销 → 重新签发，避免自己被踢出
    row2 = db.one("SELECT role, token_ver FROM users WHERE id=?", (u["id"],))
    token = auth.make_session(u["id"], row2["role"], row2["token_ver"])
    resp.set_cookie("ps_session", token, httponly=True, samesite="lax",
                    max_age=auth.SESSION_MAX_AGE)
    return resp


@app.post("/api/logout-all")
def logout_all(request: Request):
    """登出所有设备：token_ver+1，全部旧会话失效（当前设备除外——重新签发）。"""
    u = require(request)
    auth.bump_token_ver(u["id"])
    audit(u["id"], "logout-all", (db.one("SELECT username FROM users WHERE id=?", (u["id"],)) or {"username": "?"})["username"])
    row2 = db.one("SELECT role, token_ver FROM users WHERE id=?", (u["id"],))
    resp = JSONResponse({"ok": True})
    token = auth.make_session(u["id"], row2["role"], row2["token_ver"])
    resp.set_cookie("ps_session", token, httponly=True, samesite="lax",
                    max_age=auth.SESSION_MAX_AGE)
    return resp


@app.get("/api/me")
def me(request: Request):
    u = require(request)
    row = db.one("SELECT username, role, created_at FROM users WHERE id=?", (u["id"],))
    llm = auth.get_user_llm(u["id"]) or {}
    return {
        "id": u["id"], "username": row["username"], "role": row["role"],
        "llm_configured": {
            "chat": bool(llm.get("chat", {}).get("key")),
            "translate": bool(llm.get("translate", {}).get("key")),
        },
    }


@app.post("/api/register")
async def register(request: Request):
    body = await request.json()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not (2 <= len(username) <= 32) or len(password) < 8:
        raise HTTPException(400, "用户名 2-32 字符，密码至少 8 位")
    if db.one("SELECT id FROM users WHERE username=?", (username,)):
        raise HTTPException(400, "用户名已存在")
    with db.write() as c:
        cur = c.execute(
            "INSERT INTO users(username,password_hash,role) VALUES(?,?,'member')",
            (username, auth.hash_password(password)),
        )
        uid = cur.lastrowid
    if not auth.consume_invite(body.get("invite_code", ""), uid):
        with db.write() as c:
            c.execute("DELETE FROM users WHERE id=?", (uid,))
        raise HTTPException(400, "邀请码无效或已过期")
    return {"ok": True}


# ---------------- BYOK 设置 ----------------
@app.get("/api/settings/llm")
def get_llm_settings(request: Request):
    u = require(request)
    row = db.one("SELECT chat_meta, translate_meta FROM user_llm_keys WHERE user_id=?", (u["id"],))
    if row is None:
        return {"chat": {"base_url": "", "model": "", "configured": False},
                "translate": {"base_url": "", "model": "", "configured": False}}
    out = {}
    import json as _json
    for purpose, meta_col in (("chat", "chat_meta"), ("translate", "translate_meta")):
        meta = _json.loads(row[meta_col] or "{}")
        row2 = db.one(f"SELECT {purpose}_cipher IS NOT NULL AS has FROM user_llm_keys WHERE user_id=?", (u["id"],))
        out[purpose] = {"base_url": meta.get("base_url", ""), "model": meta.get("model", ""),
                        "configured": bool(row2 and row2["has"])}
    return out  # 永不回显 key


@app.put("/api/settings/llm")
async def set_llm_settings(request: Request):
    u = require(request)
    body = await request.json()
    import json as _json
    with db.write() as c:
        c.execute(
            "INSERT INTO user_llm_keys(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING",
            (u["id"],),
        )
        for purpose in ("chat", "translate"):
            conf = body.get(purpose)
            if conf is None:
                continue
            meta = {"base_url": conf.get("base_url", ""), "model": conf.get("model", ""),
                    "api_type": conf.get("api_type", "openai")}
            sets = [f"{purpose}_meta=?"]
            args: list[Any] = [_json.dumps(meta)]
            if conf.get("api_key"):  # 有新 key 才更新密文；留空保持原值
                sets.append(f"{purpose}_cipher=?")
                args.append(auth.encrypt_key(conf["api_key"]))
            c.execute(f"UPDATE user_llm_keys SET {','.join(sets)} WHERE user_id=?",
                      (*args, u["id"]))
    return {"ok": True}


@app.post("/api/settings/llm/test")
async def test_llm(request: Request):
    u = require(request)
    body = await request.json()
    ok, msg = test_connection(body.get("base_url", ""), body.get("api_key", ""),
                              body.get("model", ""), body.get("api_type", "openai"))
    return {"ok": ok, "message": msg}


# ---------------- 论文导入 ----------------
def _quota_overrides(user_id: int) -> dict:
    row = db.one("SELECT overrides FROM user_quotas WHERE user_id=?", (user_id,))
    return json.loads(row["overrides"]) if row and row["overrides"] else {}


def _check_daily_quota(user_id: int, is_admin: bool, overrides: dict) -> None:
    limit = overrides.get("daily_parse_papers")
    if is_admin:
        limit = config.get("limits", "global_daily_parse")
    elif limit is None:
        limit = config.get("limits", "daily_parse_papers")
    today = db.one(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND job_type='parse' "
        "AND status IN ('queued','pending_gate','running','done') "
        "AND date(created_at)=date('now')",
        (user_id,),
    )
    if today and today["n"] >= int(limit):
        raise HTTPException(429, f"今日解析已达上限 {limit} 篇")


@app.post("/api/papers/upload")
async def upload_papers(request: Request, files: list[UploadFile]):
    u = require(request)
    is_admin = u["role"] == "admin"
    overrides = _quota_overrides(u["id"])
    _check_daily_quota(u["id"], is_admin, overrides)

    # 体积预检：Content-Length 超限直接拒绝（避免整文件读进内存后才检查）；
    # 多文件批量按上限 ×2 估算（multipart 开销 +20MB），只拦明显超限的请求
    from core.config import config as _cfg
    max_mb = (10_000 if is_admin
              else int(overrides.get("max_file_mb") or _cfg.get("limits", "max_file_mb") or 100))
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > (max_mb * max(1, len(files)) + 20) * 1024 * 1024:
        raise HTTPException(413, f"请求体超过上限（单文件 ≤{max_mb}MB）")

    visibility = request.query_params.get("visibility", "shared")
    if visibility not in ("shared", "private"):
        visibility = "shared"
    collection_id = request.query_params.get("collection_id") or None
    if collection_id:
        if db.one("SELECT id FROM collections WHERE id=?", (collection_id,)) is None:
            raise HTTPException(400, "目标文献库不存在")
    else:
        collection_id = get_or_create_default_collection(u["id"])   # 未选库 → 默认文献库
    batch = len(files) > 3  # >3 篇视为批量 → background

    results = []
    for f in files:
        data = await f.read()
        try:
            pages, _kind = ingest.preflight_doc(data, f.filename or "", is_admin=is_admin, overrides=overrides)
        except ingest.PreflightError as e:
            results.append({"name": f.filename, "status": "rejected", "reason": str(e)})
            continue
        file_hash = ingest.sha256_bytes(data)
        paper_id, dup = ingest.create_paper(
            u["id"], file_hash, pages, len(data), visibility, f.filename or "untitled")
        if dup:
            results.append({"name": f.filename, "status": "duplicate", "paper_id": paper_id})
            continue
        if collection_id:
            with db.write() as c:
                c.execute("UPDATE papers SET collection_id=? WHERE id=?", (collection_id, paper_id))
        ingest.store_pdf(paper_id, data, f.filename or "original.pdf")
        tier = "standard" if (is_admin or overrides.get("max_tier", "standard") != "advanced") else "standard"
        scheduler.enqueue(
            u["id"], "parse", paper_id,
            {"tier": tier, "original_name": f.filename, "visibility": visibility},
            priority="background" if batch else "interactive",
        )
        results.append({"name": f.filename, "status": "queued", "paper_id": paper_id})
    return {"results": results}


@app.get("/api/papers")
def list_papers(request: Request, q: str = "", status: str = "", trash: int = 0,
                collection_id: str = "", page: int = 0, page_size: int = 0):
    u = require(request)
    is_admin = u["role"] == "admin"
    vis = "" if is_admin else " AND (visibility='shared' OR owner_id=?)"
    args: list[Any] = [] if is_admin else [u["id"]]
    if q:
        vis += " AND title LIKE ?"
        args.append(f"%{q}%")
    if status:
        vis += " AND parse_status=?"
        args.append(status)
    if collection_id == "none":
        vis += " AND collection_id IS NULL"
    elif collection_id:
        ids = [x for x in collection_id.split(",") if x]
        vis += f" AND collection_id IN ({','.join('?' * len(ids))})"
        args.extend(ids)
    cond = "deleted_at IS NULL" if not trash else "deleted_at IS NOT NULL"
    limit = max(1, min(500, page_size or 500))
    offset = max(0, (page - 1)) * limit if page else 0
    rows = db.all(f"SELECT * FROM papers WHERE {cond}{vis} ORDER BY created_at DESC LIMIT {limit} OFFSET {offset}",
                  tuple(args))
    return {"papers": [dict(r) for r in rows], "page": page, "has_more": len(rows) == limit}


@app.get("/api/papers/{paper_id}")
def paper_detail(paper_id: str, request: Request, offset: int = 0, limit: int = 0):
    """论文详情 + 解析块（分页：大论文首屏只取需要的量，滚动再拉）。

    limit=0 表示不分页（兼容旧调用）；前端用 limit 做首屏 + 增量加载。
    """
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    blocks = ingest.latest_blocks(paper_id)
    total = len(blocks)
    if limit:
        blocks = blocks[offset:offset + limit]
    return {"paper": dict(p), "blocks": [dict(b) for b in blocks],
            "total": total, "offset": offset, "limit": limit}


def _require_visible(u: dict, paper) -> None:
    if paper["visibility"] == "private" and paper["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "无权访问该论文")


def _require_owner(u: dict, paper) -> None:
    """写操作（重解析/取消任务/改元数据/重建索引）仅属主或 admin 可执行。"""
    if paper["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "仅论文所有者或管理员可执行此操作")


@app.get("/api/papers/{paper_id}/pdf")
def paper_pdf(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    import mimetypes
    path = None
    base = ingest.PAPERS_DIR / paper_id
    if base.exists():
        for f in sorted(base.iterdir()):
            if f.name.startswith("original."):
                path = f
                break
    if path is None:
        raise HTTPException(404, "原始文件缺失（URL 导入的论文无本地原件）")
    from urllib.parse import quote
    from core.meta import canonical_name
    name = canonical_name(p)
    mt = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=mt,
                        headers={"Content-Disposition":
                                 'inline; filename="paper.' + path.name.rsplit(".", 1)[-1] + '"'})


@app.get("/api/papers/{paper_id}/markdown")
def paper_markdown(paper_id: str, request: Request, run: str = ""):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    if not run:
        r = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                   "ORDER BY created_at DESC LIMIT 1", (paper_id,))
        if r is None:
            raise HTTPException(404, "尚未解析完成")
        run = r["id"]
    elif db.one("SELECT id FROM parse_runs WHERE paper_id=? AND id=?", (paper_id, run)) is None:
        raise HTTPException(404, "解析版本不存在")   # 防路径穿越：run 必须属于该论文
    path = ingest.PAPERS_DIR / paper_id / "parse" / run / "markdown.md"
    if not path.exists():
        raise HTTPException(404, "markdown 不存在")
    from urllib.parse import quote
    from core.meta import canonical_name
    name = canonical_name(p)
    return FileResponse(path, media_type="text/markdown",
                        headers={"Content-Disposition":
                                 'attachment; filename="paper.md"; filename*=UTF-8\'\'' + quote(name + ".md")})


@app.get("/api/papers/{paper_id}/images/{name}")
def paper_image(paper_id: str, name: str, request: Request):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    base = (ingest.PAPERS_DIR / paper_id / "parse").resolve()
    matches = sorted(base.glob(f"*/images/{name}"))
    if not matches or not str(matches[0].resolve()).startswith(str(base)):
        raise HTTPException(404, "图片不存在")
    return FileResponse(matches[0])


# ---------------- 删除/回收站 ----------------
@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    if p["visibility"] == "shared" and u["role"] != "admin":
        raise HTTPException(403, "共享论文仅管理员可删除")
    if p["visibility"] == "private" and p["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能删除自己的私人论文")
    # 取消在途任务
    for j in db.all("SELECT * FROM jobs WHERE paper_id=? AND status IN ('queued','pending_gate','running')", (paper_id,)):
        if j["remote_task_id"]:
            mineru.cancel(j["remote_task_id"])
        with db.write() as c:
            c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
    with db.write() as c:
        c.execute("UPDATE papers SET deleted_at=datetime('now') WHERE id=?", (paper_id,))
        c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (paper_id,))
    audit(u["id"], "delete-paper", p["title"])
    return {"ok": True}


@app.post("/api/papers/{paper_id}/restore")
def restore_paper(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or not p["deleted_at"]:
        raise HTTPException(404, "不在回收站")
    if u["role"] != "admin" and p["owner_id"] != u["id"]:
        raise HTTPException(403, "无权恢复")
    with db.write() as c:
        c.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", (paper_id,))
    # 重建 FTS 索引
    blocks = ingest.latest_blocks(paper_id)
    if blocks:
        run = blocks[0]["parse_run_id"]
        retrieval.build_chunks(paper_id, run, blocks)
    return {"ok": True}


# ---------------- 任务中心 ----------------
@app.get("/api/jobs")
def list_jobs(request: Request, status: str = "", job_type: str = "",
              batch_id: str = "", limit: int = 100):
    u = require(request)
    cond, args = "", []
    if u["role"] != "admin":
        cond = " AND j.user_id=?"
        args = [u["id"]]
    if status:
        cond += " AND j.status=?"
        args.append(status)
    if job_type:
        cond += " AND j.job_type=?"
        args.append(job_type)
    if batch_id:
        cond += " AND j.batch_id=?"
        args.append(batch_id)
    rows = db.all(
        "SELECT j.*, u.username, p.title FROM jobs j "
        "LEFT JOIN users u ON u.id=j.user_id LEFT JOIN papers p ON p.id=j.paper_id "
        f"WHERE 1=1{cond} ORDER BY j.updated_at DESC LIMIT {int(limit)}",
        tuple(args),
    )
    return {"jobs": [dict(r) for r in rows]}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int, request: Request):
    u = require(request)
    j = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if j is None:
        raise HTTPException(404, "任务不存在")
    if u["role"] != "admin" and j["user_id"] != u["id"]:
        raise HTTPException(403, "无权取消他人任务")
    if j["remote_task_id"]:
        mineru.cancel(j["remote_task_id"])
    with db.write() as c:
        c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (job_id,))
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: int, request: Request):
    u = require(request)
    j = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if j is None:
        raise HTTPException(404, "任务不存在")
    if u["role"] != "admin" and j["user_id"] != u["id"]:
        raise HTTPException(403, "无权重试他人任务")
    with db.write() as c:
        c.execute("UPDATE jobs SET status='queued', retry_count=0, error=NULL, "
                  "remote_task_id=NULL WHERE id=?", (job_id,))
    scheduler._wake.set()
    return {"ok": True}


@app.post("/api/queue/{job_type}/pause")
def queue_pause(job_type: str, request: Request):
    require_admin(request)
    scheduler.pause_resume(job_type, pause=True)
    return {"ok": True}


@app.post("/api/queue/{job_type}/resume")
def queue_resume(job_type: str, request: Request):
    require_admin(request)
    scheduler.pause_resume(job_type, pause=False)
    return {"ok": True}


# ---------------- 批量中心 ----------------
# 批次机制：一次批量操作 → 同一 batch_id 的一组 jobs。进度面板按 batch_id 聚合，
# SSE 事件透传 batch_id（_emit），失败项复用既有 /api/jobs/{id}/retry。
BATCH_LIMIT = 200   # 单批圈定上限（90 篇综述场景绰绰有余）


def _batch_papers(u: dict, paper_ids: list[str]) -> list[tuple[str, Any]]:
    """批量圈定校验：存在且可见的论文才有资格入批。"""
    out = []
    for pid in paper_ids[:BATCH_LIMIT]:
        p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is not None:
            _require_visible(u, p)
            out.append((pid, p))
    return out


@app.post("/api/batch/{action}")
async def batch_action(action: str, request: Request):
    """批量中心：对圈定论文发起一批同型任务，返回 batch_id 供进度面板跟踪。

    bibtex/删除不走这里：bibtex 是同步导出（既有 /api/papers/export/bibtex），
    删除是即时操作（既有 /api/papers/batch-delete）。
    """
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or []) if x][:BATCH_LIMIT]
    if not ids:
        raise HTTPException(400, "请先圈定论文")
    batch_id = uuid.uuid4().hex[:12]
    papers = _batch_papers(u, ids)
    queued, skipped = [], []

    if action == "translate":
        for pid, _p in papers:
            in_flight = db.one(
                "SELECT id FROM jobs WHERE paper_id=? AND job_type='translate' "
                "AND status IN ('queued','pending_gate','running')", (pid,))
            if in_flight:
                skipped.append(pid)
                continue
            from core.translator import translation_status
            if translation_status(pid)["complete_any"]:
                skipped.append(pid)   # 已有完整译文，缓存零成本不重跑
                continue
            scheduler.enqueue(u["id"], "translate", pid, {"batch_id": batch_id},
                              priority="background")
            queued.append(pid)
    elif action == "meta":
        for pid, _p in papers:
            scheduler.enqueue(u["id"], "meta", pid, {"batch_id": batch_id},
                              priority="background")
            queued.append(pid)
    elif action == "summary":
        for pid, _p in papers:
            has = db.one("SELECT id FROM summaries WHERE paper_id=? LIMIT 1", (pid,))
            if has and not body.get("force"):
                skipped.append(pid)   # 已有导读，跳过（强制重跑传 force）
                continue
            scheduler.enqueue(u["id"], "summary", pid, {"batch_id": batch_id},
                              priority="background")
            queued.append(pid)
    elif action == "parse":
        for pid, p in papers:
            if p["owner_id"] != u["id"] and u["role"] != "admin":
                skipped.append(pid)   # 重解析仅属主
                continue
            _cancel_paper_jobs(pid, "parse")
            prev = db.one(
                "SELECT payload FROM jobs WHERE paper_id=? AND job_type='parse' "
                "AND payload LIKE '%\"url\"%' ORDER BY id DESC LIMIT 1", (pid,))
            url = (json.loads(prev["payload"]).get("url") if prev else None)
            scheduler.enqueue(u["id"], "parse", pid,
                              {"tier": "standard", "reparse": True, "batch_id": batch_id,
                               **({"url": url} if url else {})},
                              priority="interactive")
            with db.write() as c:
                c.execute("UPDATE papers SET parse_status='pending' WHERE id=?", (pid,))
            queued.append(pid)
    else:
        raise HTTPException(404, f"未知批量操作 {action}")

    audit(u["id"], f"batch-{action}", f"{len(queued)} queued / {len(skipped)} skipped batch={batch_id}")
    return {"batch_id": batch_id, "queued": queued, "skipped": skipped,
            "skipped_reason": "进行中或已完成的任务自动跳过；重解析仅限自己上传的论文"}


@app.get("/api/batches")
def list_batches(request: Request, limit: int = 12):
    """批次汇总（批量中心进度面板：每批次一行聚合）。"""
    u = require(request)
    scope = "" if u["role"] == "admin" else f" AND user_id={int(u['id'])}"
    rows = db.all(
        "SELECT batch_id, MIN(job_type) AS job_type, COUNT(*) AS total, "
        "SUM(status='done') AS done, SUM(status='failed') AS failed, "
        "SUM(status IN ('queued','pending_gate','running')) AS active, "
        "MIN(created_at) AS started_at, MAX(updated_at) AS updated_at "
        f"FROM jobs WHERE batch_id IS NOT NULL AND batch_id!=''{scope} "
        f"GROUP BY batch_id ORDER BY MAX(updated_at) DESC LIMIT {int(limit)}")
    return {"batches": [dict(r) for r in rows]}


# ---------------- 综述流水线（批量中心核心卡） ----------------

@app.post("/api/synthesize/estimate")
async def synthesize_estimate(request: Request):
    """综述成本预估：预计 LLM 调用数（缺导读逐篇补齐 + 组内比对 + 跨组综合）。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or []) if x]
    if not ids:
        raise HTTPException(400, "请先圈定论文")
    est = synthesis.estimate(ids)
    if len(est["valid"]) < 2:
        raise HTTPException(400, "有效论文不足 2 篇（未解析完成的已剔除）")
    if len(est["valid"]) > synthesis.MAX_PAPERS:
        raise HTTPException(400, f"一次综述最多 {synthesis.MAX_PAPERS} 篇，请分卷进行")
    return {"valid": len(est["valid"]), "missing_summaries": est["missing_summaries"],
            "groups": est["groups"], "calls": est["calls"],
            "no_parse": est["no_parse"]}


@app.post("/api/synthesize")
async def synthesize_start(request: Request):
    """发起综述：建 syntheses 行 + synthesis job（batch_id 进批次面板）。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or []) if x]
    est = synthesis.estimate(ids)
    if len(est["valid"]) < 2:
        raise HTTPException(400, "有效论文不足 2 篇（未解析完成的已剔除）")
    if len(est["valid"]) > synthesis.MAX_PAPERS:
        raise HTTPException(400, f"一次综述最多 {synthesis.MAX_PAPERS} 篇，请分卷进行")
    # 并发上限：同一用户同时只跑一篇综述（LLM 长任务）
    live = db.one("SELECT id FROM syntheses WHERE user_id=? AND status='running' LIMIT 1", (u["id"],))
    if live:
        raise HTTPException(409, "已有一篇综述在进行中，请等它完成或先删除")
    sid = synthesis.create(u["id"], ids, est)
    batch_id = uuid.uuid4().hex[:12]
    scheduler.enqueue(u["id"], "synthesis", None, {"synthesis_id": sid, "batch_id": batch_id},
                      priority="background", progress_total=est["calls"])
    audit(u["id"], "synthesize", f"{len(est['valid'])} 篇 batch={batch_id}")
    return {"synthesis_id": sid, "batch_id": batch_id, "estimate": est}


@app.get("/api/syntheses")
def list_syntheses(request: Request, limit: int = 20):
    u = require(request)
    scope = "" if u["role"] == "admin" else " WHERE s.user_id=" + str(int(u["id"]))
    rows = db.all(
        "SELECT s.id, s.title, s.status, s.stage, s.progress_done, s.progress_total, "
        "s.error, s.model, s.created_at, s.updated_at, "
        "json_array_length(s.paper_ids) AS papers "
        f"FROM syntheses s{scope} ORDER BY s.updated_at DESC LIMIT {int(limit)}")
    return {"syntheses": [dict(r) for r in rows]}


def _own_synthesis(u: dict, sid: str):
    row = db.one("SELECT * FROM syntheses WHERE id=?", (sid,))
    if row is None:
        raise HTTPException(404, "综述不存在")
    if u["role"] != "admin" and row["user_id"] != u["id"]:
        raise HTTPException(403, "无权访问他人综述")
    return row


@app.get("/api/syntheses/{sid}")
def get_synthesis(sid: str, request: Request):
    u = require(request)
    row = _own_synthesis(u, sid)
    return {"synthesis": dict(row)}


@app.delete("/api/syntheses/{sid}")
def delete_synthesis(sid: str, request: Request):
    u = require(request)
    row = _own_synthesis(u, sid)
    if row["status"] == "running":   # 在途：连带取消队列任务
        for j in db.all("SELECT * FROM jobs WHERE payload LIKE ? AND status IN ('queued','pending_gate','running')",
                        (f'%{sid}%',)):
            with db.write() as c:
                c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
    with db.write() as c:
        c.execute("DELETE FROM syntheses WHERE id=?", (sid,))
    return {"ok": True}


@app.get("/api/syntheses/{sid}/export")
def export_synthesis(sid: str, request: Request, fmt: str = "md"):
    u = require(request)
    row = _own_synthesis(u, sid)
    if fmt == "csv":
        data = (row["matrix_csv"] or "").encode("utf-8-sig")   # BOM：Excel 直接打开不乱码
        fname = f"synthesis-{sid}.csv"
        media = "text/csv"
    else:
        data = (row["report_md"] or "").encode("utf-8")
        fname = f"synthesis-{sid}.md"
        media = "text/markdown"
    if not data:
        raise HTTPException(404, "报告尚未生成")
    from urllib.parse import quote
    return Response(content=data, media_type=media,
                    headers={"Content-Disposition":
                             f"attachment; filename=\"{fname}\"; filename*=UTF-8''{quote(fname)}"})


@app.get("/api/jobs/stream")
def jobs_stream(request: Request):
    u = require(request)
    is_admin = u["role"] == "admin"

    def gen(q: "queue.Queue") -> Iterator[str]:
        import queue as _q
        try:
            while True:
                try:
                    ev = q.get(timeout=15)
                except _q.Empty:
                    yield ": keepalive\n\n"
                    continue
                if not is_admin and ev.get("user_id") != u["id"]:
                    continue
                yield f"data: {json.dumps(ev)}\n\n"
        finally:
            bus.unsubscribe(q)

    q = bus.subscribe()
    return StreamingResponse(gen(q), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# ---------------- 用量 ----------------
@app.get("/api/usage")
def usage(request: Request):
    u = require(request)
    is_admin = u["role"] == "admin"
    scope = "" if is_admin else " WHERE user_id=?"
    args = () if is_admin else (u["id"],)
    by_user = db.all(
        f"SELECT COALESCE(u.username,'?') AS username, key_source, purpose, "
        "SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, COUNT(*) AS calls "
        "FROM llm_calls LEFT JOIN users u ON u.id=llm_calls.user_id"
        f"{scope} GROUP BY llm_calls.user_id, key_source, purpose", args)
    by_day = db.all(
        f"SELECT date(created_at) AS day, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c "
        f"FROM llm_calls{scope} GROUP BY day ORDER BY day DESC LIMIT 30", args)
    return {"by_user": [dict(r) for r in by_user], "by_day": [dict(r) for r in by_day]}


# ---------------- 管理 ----------------
@app.post("/api/admin/invite")
def create_invite(request: Request, days: int = 7):
    admin = require_admin(request)
    code = auth.create_invite(admin["id"], days)
    with db.write() as c:
        c.execute("INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)",
                  (admin["id"], "create_invite", code))
    return {"code": code, "expires_in_days": days}


@app.get("/api/admin/users")
def admin_users(request: Request):
    require_admin(request)
    rows = db.all(
        "SELECT u.id, u.username, u.role, u.created_at, q.overrides, "
        "(SELECT COUNT(*) FROM papers p WHERE p.owner_id=u.id AND p.deleted_at IS NULL) AS papers "
        "FROM users u LEFT JOIN user_quotas q ON q.user_id=u.id ORDER BY u.id")
    return {"users": [dict(r) for r in rows]}


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, request: Request):
    """admin 重置用户密码：生成一次性临时密码返回（用户登录后自行修改）。"""
    admin = require_admin(request)
    row = db.one("SELECT id, username FROM users WHERE id=?", (user_id,))
    if row is None:
        raise HTTPException(404, "用户不存在")
    import secrets
    temp = secrets.token_urlsafe(9)
    auth.bump_token_ver(user_id)
    with db.write() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?",
                  (auth.hash_password(temp), user_id))
    audit(admin["id"], "reset-password", f"{row['username']}(id={user_id})")
    return {"ok": True, "temp_password": temp, "username": row["username"]}


@app.post("/api/admin/users/{user_id}/disable")
def admin_disable_user(user_id: int, request: Request):
    """禁用用户：无法登录，已有会话全部吊销。不能禁用自己。"""
    admin = require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(400, "不能禁用自己")
    row = db.one("SELECT username, role FROM users WHERE id=?", (user_id,))
    if row is None:
        raise HTTPException(404, "用户不存在")
    if row["role"] == "admin":
        raise HTTPException(400, "不能禁用管理员账号")
    with db.write() as c:
        c.execute("UPDATE users SET disabled=1, token_ver=token_ver+1 WHERE id=?", (user_id,))
    audit(admin["id"], "disable-user", row["username"])
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/enable")
def admin_enable_user(user_id: int, request: Request):
    admin = require_admin(request)
    row = db.one("SELECT username FROM users WHERE id=?", (user_id,))
    if row is None:
        raise HTTPException(404, "用户不存在")
    with db.write() as c:
        c.execute("UPDATE users SET disabled=0 WHERE id=?", (user_id,))
    audit(admin["id"], "enable-user", row["username"])
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: Request):
    """软删除用户：禁用 + 匿名化用户名（保留其论文归属与统计，可随时恢复 disabled=0）。"""
    admin = require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(400, "不能删除自己")
    row = db.one("SELECT username, role FROM users WHERE id=?", (user_id,))
    if row is None:
        raise HTTPException(404, "用户不存在")
    if row["role"] == "admin":
        raise HTTPException(400, "不能删除管理员账号")
    with db.write() as c:
        c.execute("UPDATE users SET disabled=2, username=? WHERE id=?",
                  (f"[已注销]{row['username']}#{user_id}", user_id))
    audit(admin["id"], "delete-user", row["username"])
    return {"ok": True}


@app.get("/api/admin/audit")
def admin_audit(request: Request, limit: int = 100):
    require_admin(request)
    rows = db.all("SELECT a.id, a.action, a.detail, a.created_at, u.username "
                  "FROM audit_log a LEFT JOIN users u ON u.id=a.user_id "
                  "ORDER BY a.id DESC LIMIT ?", (max(1, min(500, limit)),))
    return {"rows": [dict(r) for r in rows]}


@app.put("/api/admin/users/{user_id}/quota")
async def admin_set_quota(user_id: int, request: Request):
    require_admin(request)
    body = await request.json()
    with db.write() as c:
        c.execute("INSERT INTO user_quotas(user_id,overrides) VALUES(?,?) "
                  "ON CONFLICT(user_id) DO UPDATE SET overrides=?",
                  (user_id, json.dumps(body), json.dumps(body)))
    return {"ok": True}


@app.get("/api/admin/pool")
def admin_get_pool(request: Request):
    require_admin(request)
    row = db.one("SELECT value FROM settings WHERE key='pool_enabled'")
    return {"enabled": row is not None and row["value"] == "1"}


@app.post("/api/admin/pool")
async def admin_set_pool(request: Request):
    require_admin(request)
    body = await request.json()
    val = "1" if body.get("enabled") else "0"
    with db.write() as c:
        c.execute("INSERT INTO settings(key,value) VALUES('pool_enabled',?) "
                  "ON CONFLICT(key) DO UPDATE SET value=?", (val, val))
    return {"ok": True}


def _assert_public_url(url: str) -> None:
    """拦 SSRF：MinerU 会服务端抓取该 URL——禁止内网/环回/链路本地地址。"""
    import ipaddress
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower()
    if not host:
        raise HTTPException(400, "无效 URL")
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        raise HTTPException(400, "不允许内网地址")
    try:
        infos = ipaddress.ip_address(host)
    except ValueError:
        infos = None   # 域名：交由 DNS（公网域名才放行；DNS rebinding 在自建内网风险可接受）
    if infos is not None and not infos.is_global:
        raise HTTPException(400, "不允许内网/环回地址")


@app.post("/api/papers/import-url")
async def import_url(request: Request):
    """URL 直接导入（MinerU 服务端抓取；支持 pdf/arxiv 直链等）."""
    u = require(request)
    body = await request.json()
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "无效 URL")
    _assert_public_url(url)
    name = Path(url.split("?")[0]).name or "document.pdf"
    if "." not in name:
        name += ".pdf"
    file_hash = "url:" + ingest.sha256_bytes(url.encode())
    exist = db.one("SELECT id FROM papers WHERE file_hash=? AND deleted_at IS NULL", (file_hash,))
    if exist:
        return {"paper_id": exist["id"], "status": "duplicate"}
    paper_id, _ = ingest.create_paper(u["id"], file_hash, 0, 0,
                                      body.get("visibility", "shared"), name)
    cid = body.get("collection_id") or get_or_create_default_collection(u["id"])
    with db.write() as c:
        c.execute("UPDATE papers SET collection_id=? WHERE id=?", (cid, paper_id))
    scheduler.enqueue(u["id"], "parse", paper_id, {"tier": "standard", "url": url},
                      priority="interactive")
    return {"paper_id": paper_id, "status": "queued"}


_status_cache: dict[str, tuple[float, Any]] = {}

# ---------------- 文献库（collections） ----------------
def get_or_create_default_collection(user_id: int) -> str:
    row = db.one("SELECT id FROM collections WHERE owner_id=? AND name='默认文献库'", (user_id,))
    if row:
        return row["id"]
    cid = "c" + secrets.token_hex(6)
    with db.write() as c:
        c.execute("INSERT INTO collections(id,name,owner_id) VALUES(?,?,?)",
                  (cid, "默认文献库", user_id))
    return cid


@app.get("/api/collections")
def list_collections(request: Request):
    u = require(request)
    vis = "" if u["role"] == "admin" else " AND (p.visibility='shared' OR p.owner_id=?)"
    args = () if u["role"] == "admin" else (u["id"],)
    total = db.one(
        f"SELECT COUNT(*) AS n FROM papers p WHERE p.deleted_at IS NULL{vis}", args)["n"]
    rows = db.all(
        "SELECT c.id, c.name, c.parent_id, (SELECT COUNT(*) FROM papers p WHERE p.collection_id=c.id "
        "AND p.deleted_at IS NULL AND (p.visibility='shared' OR p.owner_id=?)) AS papers "
        "FROM collections c WHERE c.owner_id=? ORDER BY c.created_at",
        (u["id"], u["id"]),
    )
    nodes = [dict(r) for r in rows]
    # 汇总：父库计数含全部子孙
    children = {}
    for n in nodes:
        children.setdefault(n["parent_id"], []).append(n)
    def rollup(nid):
        for ch in children.get(nid, []):
            ch["papers_total"] = ch["papers"] + rollup(ch["id"])
            rollup(ch["id"])
        return sum(ch.get("papers_total", ch["papers"]) for ch in children.get(nid, []))
    roots = [n for n in nodes if not n["parent_id"]]
    rollup(None)
    for n in nodes:
        n.setdefault("papers_total", n["papers"])
    return {"total": total, "collections": nodes}


@app.post("/api/collections")
async def create_collection(request: Request):
    u = require(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not (1 <= len(name) <= 50):
        raise HTTPException(400, "库名 1-50 字符")
    parent = body.get("parent_id") or None
    if parent:
        prow = db.one("SELECT id, parent_id FROM collections WHERE id=? AND owner_id=?", (parent, u["id"]))
        if prow is None:
            raise HTTPException(400, "父库不存在")
        depth, cur = 1, prow
        while cur and cur["parent_id"]:
            cur = db.one("SELECT id, parent_id FROM collections WHERE id=?", (cur["parent_id"],))
            depth += 1
        if depth >= 3:
            raise HTTPException(400, "最多三级目录")
    cid = "c" + secrets.token_hex(6)
    with db.write() as c:
        c.execute("INSERT INTO collections(id,name,owner_id,parent_id) VALUES(?,?,?,?)",
                  (cid, name, u["id"], parent))
    return {"id": cid, "name": name, "parent_id": parent}


@app.patch("/api/collections/{cid}")
async def rename_collection(cid: str, request: Request):
    u = require(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not (1 <= len(name) <= 50):
        raise HTTPException(400, "库名 1-50 字符")
    row = db.one("SELECT owner_id FROM collections WHERE id=?", (cid,))
    if row is None or (row["owner_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "文献库不存在")
    with db.write() as c:
        c.execute("UPDATE collections SET name=? WHERE id=?", (name, cid))
    return {"ok": True}


def _subtree_ids(cid: str) -> list[str]:
    """库 + 全部后代子库（BFS）。"""
    ids = [cid]
    frontier = [cid]
    while frontier:
        ph = ",".join("?" * len(frontier))
        rows = db.all(f"SELECT id FROM collections WHERE parent_id IN ({ph})", frontier)
        frontier = [r["id"] for r in rows if r["id"] not in ids]
        ids.extend(frontier)
    return ids


@app.delete("/api/collections/{cid}")
def delete_collection(cid: str, request: Request):
    """删除文献库（整个子树）；库内论文一并移入回收站（30 天可恢复）。

    member 删含他人共享论文的库 → 403（共享论文的回收是 admin 权限）。
    """
    u = require(request)
    row = db.one("SELECT owner_id FROM collections WHERE id=?", (cid,))
    if row is None or (row["owner_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "文献库不存在")
    ids = _subtree_ids(cid)
    ph = ",".join("?" * len(ids))
    papers = db.all(
        f"SELECT id, owner_id, visibility, title FROM papers "
        f"WHERE collection_id IN ({ph}) AND deleted_at IS NULL", ids)
    if u["role"] != "admin" and any(
            p["visibility"] == "shared" and p["owner_id"] != u["id"] for p in papers):
        raise HTTPException(403, "库内含他人共享的论文——整库删除（含论文入回收站）仅管理员可执行")
    n = 0
    for p in papers:
        for j in db.all("SELECT * FROM jobs WHERE paper_id=? AND status IN ('queued','pending_gate','running')",
                        (p["id"],)):
            if j["remote_task_id"]:
                mineru.cancel(j["remote_task_id"])
            with db.write() as c:
                c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
        with db.write() as c:
            c.execute("UPDATE papers SET deleted_at=datetime('now') WHERE id=?", (p["id"],))
            c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (p["id"],))
        audit(u["id"], "batch-delete", p["title"])
        n += 1
    from core.retrieval import invalidate_vec_cache
    invalidate_vec_cache()
    with db.write() as c:
        c.execute(f"DELETE FROM collections WHERE id IN ({ph})", ids)
    from core.retrieval import invalidate_vec_cache
    invalidate_vec_cache()
    return {"ok": True, "libs": len(ids), "trashed": n}


@app.patch("/api/papers/{paper_id}")
async def patch_paper(paper_id: str, request: Request):
    """移动论文到文献库 / 修正元数据字段。"""
    u = require(request)
    body = await request.json()
    p = db.one("SELECT id, owner_id FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    if p["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只有上传者可修改")
    sets, args = [], []
    cid = body.get("collection_id")
    if "collection_id" in body:
        if cid is not None and db.one("SELECT id FROM collections WHERE id=?", (cid,)) is None:
            raise HTTPException(400, "目标文献库不存在")
        sets.append("collection_id=?")
        args.append(cid)
    for field in ("title", "authors", "journal", "year", "doi", "keywords", "abstract",
                  "volume", "issue", "pages"):
        if field in body:
            sets.append(f"{field}=?")
            args.append(str(body[field])[:3000])
    if sets:
        with db.write() as c:
            c.execute(f"UPDATE papers SET {', '.join(sets)} WHERE id=?", (*args, paper_id))
    return {"ok": True}


# ---------------- 文库搜索 ----------------
@app.post("/api/search")
async def search_api(request: Request):
    u = require(request)
    body = await request.json()
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "query 必填")
    hits = retrieval.search(
        query, user_id=u["id"], is_admin=u["role"] == "admin",
        paper_ids=body.get("paper_ids"), top_k=int(body.get("top_k", 10)),
    )
    return {"hits": hits}


# ---------------- 图表资产（右栏"图表"页签） ----------------
@app.get("/api/papers/{paper_id}/assets")
def paper_assets(paper_id: str, request: Request):
    """从解析产物提取图表/表格清单：页码、图、题注。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if run is None:
        return {"figures": [], "tables": [], "formulas": []}
    mf = ingest.PAPERS_DIR / paper_id / "parse" / run["id"] / "middle_json.json"
    if not mf.exists():
        return {"figures": [], "tables": [], "formulas": []}
    import json as _json
    middle = _json.loads(mf.read_text(encoding="utf-8"))

    def _flat_text(content) -> str:
        if isinstance(content, str):
            return content
        out = []
        for s in content or []:
            if isinstance(s, dict):
                if s.get("type") == "text":
                    out.append(s.get("content", ""))
                elif "content" in s:
                    out.append(_flat_text(s.get("content")))
        return "".join(out)

    figures_raw, tables = [], []
    for page in middle.get("pages", []):
        pg = int(page.get("page_idx", 0))
        for b in page.get("blocks", []):
            if b.get("type") == "image":
                body = next((x for x in b.get("content", []) if x.get("type") == "image_body"), None)
                cap = next((x for x in b.get("content", []) if x.get("type") == "image_caption"), None)
                if body and body.get("image_path") and Path(body["image_path"]).name:
                    figures_raw.append({
                        "page_index": pg, "image_path": body["image_path"],
                        "caption": _flat_text(cap.get("content")) if cap else "",
                        "bbox": b.get("bbox"),
                    })
            elif b.get("type") == "chart":
                # MinerU 4 的图表块（chart_body 一样有提取图）——漏掉会导致
                # 「上 image 下 chart」的并图只裁出上半部分
                body = next((x for x in b.get("content", []) if x.get("type") == "chart_body"), None)
                caps = [x for x in b.get("content", []) if x.get("type") == "chart_caption"]
                if body and body.get("image_path") and Path(body["image_path"]).name:
                    figures_raw.append({
                        "page_index": pg, "image_path": body["image_path"],
                        "caption": " ".join(_flat_text(c.get("content")) for c in caps if c.get("content")).strip(),
                        "bbox": b.get("bbox"),
                    })
            elif b.get("type") == "table":
                body = next((x for x in b.get("content", []) if x.get("type") == "table_body"), None)
                cap = next((x for x in b.get("content", []) if x.get("type") == "table_caption"), None)
                _html = body.get("content", "") if body else ""
                _bbox = b.get("bbox")
                if _html.strip() or _bbox:
                    tables.append({
                        "page_index": pg,
                        "caption": _flat_text(cap.get("content")) if cap else "",
                        "html": _html,
                        "bbox": _bbox,
                    })

    # 编号解析：Fig. 2 / Figs. 2 / Figure 2 / 图 2 → 徽标；无编号子图归并到同页主图
    import re as _re

    def _label(cap: str, kind: str) -> str:
        # \b 防 config 里的 fig 误配；Tab. 支持表格缩写
        pat = r"\b(?:figure|figs?\.?|图)\s*(\d+)" if kind == "figure" else r"\b(?:table|tabs?\.?|表)\s*(\d+)"
        m = _re.search(pat, cap or "", _re.I)
        if not m:
            return ""
        return ("图" if kind == "figure" else "表") + m.group(1)

    for t in tables:
        t["label"] = _label(t["caption"], "table") or f"第{t['page_index'] + 1}页·表"
    tables.sort(key=lambda t: t["page_index"])

    def _union(members):
        bs = [m.get("bbox") for m in members if m.get("bbox")]
        if not bs:
            return None
        return [min(b[0] for b in bs), min(b[1] for b in bs),
                max(b[2] for b in bs), max(b[3] for b in bs)]

    def _finalize(members, label):
        """一组（同号多块/主图+子图）合成一个条目：按 y 排序、题注去重。
        MinerU 会把多分体 figure 拆成多个 image 块且各带同一题注——不合并会
        出现重复条目和题注显示两遍。"""
        members = sorted(members, key=lambda x: (x.get("bbox") or [0, 0, 0, 0])[1])
        first = members[0]
        caps = []
        for m in members:
            c = (m.get("caption") or "").strip()
            if c and c not in caps:
                caps.append(c)
        first["label"] = label
        first["caption"] = caps[0] if caps else ""
        first["extra_images"] = [m["image_path"] for m in members[1:] if m.get("image_path")]
        first["sub_captions"] = caps[1:]
        first["union_bbox"] = _union(members)
        figures.append(first)

    by_page: dict[int, list] = {}
    for f in figures_raw:
        by_page.setdefault(f["page_index"], []).append(f)
    figures = []
    for pg in sorted(by_page):
        imgs = sorted(by_page[pg], key=lambda x: ((x.get("bbox") or [0, 0, 0, 0])[1]))
        labeled: dict[str, list] = {}   # 同页同号多块 = 同一 figure 的分体
        others = []
        for f in imgs:
            lb = _label(f["caption"], "figure")
            if lb:
                labeled.setdefault(lb, []).append(f)
            else:
                others.append(f)
        if not labeled:
            if imgs:
                _finalize(imgs, f"第{pg + 1}页·组图")
            continue
        # 未编号子图：挂到 bbox 纵向在其上方的最近编号组
        anchored: dict[str, list] = {lb: [] for lb in labeled}
        for o in others:
            oy = (o.get("bbox") or [0, 0, 0, 0])[1]
            target = None
            for lb, members in labeled.items():
                ny = min((m.get("bbox") or [0, 9, 0, 9])[1] for m in members)
                if ny <= oy + 0.02:
                    target = lb   # 保留最下方的上方编号组
            anchored[target if target else next(iter(labeled))].append(o)
        for lb, members in labeled.items():
            _finalize(members + anchored[lb], lb)

    # 公式清单（IvySCI 式独立页签）：blocks 里 type=equation 即 LaTeX
    run_id = run["id"]
    formulas = [
        {"page_index": r["page_index"], "latex": r["text"], "block_id": r["block_id"]}
        for r in db.all(
            "SELECT block_id, page_index, text FROM blocks WHERE parse_run_id=? AND type='equation' "
            "AND TRIM(text)<>'' ORDER BY page_index, block_index", (run_id,))
    ]
    return {"figures": figures, "tables": tables, "formulas": formulas}


# ---------------- 文献信息（管理器式） ----------------
@app.get("/api/papers/{paper_id}/references")
def paper_references(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.meta import get_references
    return {"references": get_references(paper_id)}


@app.post("/api/papers/{paper_id}/extract-meta")
def extract_meta(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    try:
        from core.meta import extract_meta_llm
        data = extract_meta_llm(u["id"], paper_id)
    except NoKeyError as e:
        raise HTTPException(400, str(e))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "meta": data}


@app.get("/api/papers/{paper_id}/notes")
def get_paper_notes(paper_id: str, request: Request):
    u = require(request)
    row = db.one("SELECT importance, tags, notes, updated_at FROM paper_notes "
                 "WHERE user_id=? AND paper_id=?", (u["id"], paper_id))
    return dict(row) if row else {"importance": 0, "tags": "", "notes": ""}


@app.put("/api/papers/{paper_id}/notes")
async def set_paper_notes(paper_id: str, request: Request):
    u = require(request)
    body = await request.json()
    with db.write() as c:
        c.execute(
            "INSERT INTO paper_notes(user_id,paper_id,importance,tags,notes,updated_at) "
            "VALUES(?,?,?,?,?,datetime('now')) "
            "ON CONFLICT(user_id,paper_id) DO UPDATE SET importance=?, tags=?, notes=?, "
            "updated_at=datetime('now')",
            (u["id"], paper_id, int(body.get("importance", 0)),
             body.get("tags", "")[:300], body.get("notes", "")[:5000],
             int(body.get("importance", 0)), body.get("tags", "")[:300], body.get("notes", "")[:5000]),
        )
    return {"ok": True}


# ---------------- 导出下载 ----------------
def _md_response(md: str, filename: str) -> Response:
    from urllib.parse import quote
    return Response(
        content=md.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"export.md\"; filename*=UTF-8''{quote(filename)}"},
    )


@app.get("/api/papers/{paper_id}/export/translation")
def export_translation(paper_id: str, request: Request, lang: str = "both", cache_key: str = ""):
    """译文导出：lang=both 双语对照 | zh 纯中文。"""
    u = require(request)
    p = db.one("SELECT id, title, authors, year, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.translator import bilingual_pairs
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if run is None:
        raise HTTPException(404, "尚未解析")
    pairs = [x for x in bilingual_pairs(paper_id, run["id"], cache_key or None) if x["zh"]]
    if not pairs:
        raise HTTPException(404, "尚无译文")
    title = p["title"] or paper_id
    lines = [f"# {title} · {'双语对照' if lang == 'both' else '中文翻译'}", ""]
    cur_section = ""
    for x in pairs:
        if x["section_path"] and x["section_path"] != cur_section:
            cur_section = x["section_path"]
            lines += [f"## {cur_section}", ""]
        if lang == "both":
            lines += [x["en"], "", f"> {x['zh']}", ""]
        else:
            lines += [x["zh"], ""]
    md = "\n".join(lines)
    from core.meta import canonical_name
    suffix = "双语对照" if lang == "both" else "中文翻译"
    return _md_response(md, f"{canonical_name(p)}-{suffix}.md")


@app.get("/api/chat/sessions/{session_id}/export")
def export_session(session_id: str, request: Request):
    """对话记录导出 Markdown（含引用与证据页码）。"""
    u = require(request)
    s = db.one("SELECT * FROM chat_sessions WHERE id=?", (session_id,))
    if s is None or (s["user_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "会话不存在")
    msgs = db.all("SELECT role, content, evidence FROM chat_messages "
                  "WHERE session_id=? ORDER BY id", (session_id,))
    lines = [f"# 对话记录 · {s['title']}", "",
             f"- 论文范围: {s['paper_scope']}", f"- 导出时间: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')}", ""]
    for m in msgs:
        if m["role"] == "user":
            lines += [f"## ❓ {m['content']}", ""]
        else:
            lines += [m["content"], ""]
            ev = json.loads(m["evidence"] or "[]")
            if ev:
                lines.append("**证据**: " + " ; ".join(
                    f"[{e['evidence_id']}] {e['title']} 第{e['page_index'] + 1}页" for e in ev))
                lines.append("")
    # 文件名与文章保持一致：<规范名>_discussion.md（与翻译导出同一命名规则）
    scope = [x for x in (s["paper_scope"] or "").split(",") if x]
    fname = "对话_discussion.md"
    if scope:
        p = db.one("SELECT * FROM papers WHERE id=?", (scope[0],))
        if p is not None:
            from core.meta import canonical_name
            fname = f"{canonical_name(p)}_discussion.md"
    return _md_response("\n".join(lines), fname)


@app.get("/api/papers/{paper_id}/export/summary")
def export_summary(paper_id: str, request: Request):
    """导读导出 Markdown（9 字段 + 证据页码）。"""
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    s = db.one("SELECT * FROM summaries WHERE paper_id=? ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if s is None:
        raise HTTPException(404, "尚未生成导读")
    data = json.loads(s["content"])
    names = {"problem": "研究问题", "core_idea": "核心思想", "method": "方法",
             "datasets": "数据集", "baselines": "基线", "metrics": "评价指标",
             "ablation": "消融", "complexity": "复杂度", "limitations": "局限"}
    ev_by_id = {e["evidence_id"]: e for e in (data.get("evidence") or [])}
    cite_map = data.get("cite_map") or {}
    lines = [f"# 科研导读 · {p['title']}", "", f"- 模型: {s['model']}", ""]
    for k, v in (data.get("sections") or {}).items():
        lines += [f"## {names.get(k, k)}", "", v, ""]
        # 证据脚注：编号在文件内自解释（此前导出只有裸 [n]，读者无从核对）
        local = cite_map.get(k) or {}
        for n, gid in sorted(local.items(), key=lambda kv: int(kv[0])):
            ev = ev_by_id.get(gid)
            if ev is None:
                continue
            lines.append(f"> [{n}] 第{ev['page_index'] + 1}页 · {(ev.get('text') or '').strip()[:300]}")
        if local:
            lines.append("")
    lines += ["", f"（由 paper-system 生成 · {s['created_at'][:16]}）"]
    from core.meta import canonical_name
    return _md_response("\n".join(lines), f"{canonical_name(p)}_reading-guide.md")


@app.post("/api/papers/export/bibtex")
async def export_bibtex(request: Request):
    """批量引用导出：多选论文 → 单 .bib 文件。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or [])][:300]
    if not ids:
        raise HTTPException(400, "paper_ids 必填")
    from core.meta import canonical_name
    entries = []
    for pid in ids:
        p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is None:
            continue
        _require_visible(u, p)
        from core.cite import format_citation
        entries.append(format_citation(dict(p), "bibtex") + "\n")
    if not entries:
        raise HTTPException(404, "没有可导出的论文")
    from core.meta import canonical_name as _cn
    fname = "references.bib" if len(entries) > 1 else f"{_cn(dict(p)) if p else 'ref'}.bib"
    return Response(content=("\n\n".join(entries) + "\n").encode("utf-8"),
                    media_type="application/x-bibtex",
                    headers={"Content-Disposition":
                             f"attachment; filename=\"references.bib\"; "
                             f"filename*=UTF-8''{__import__('urllib.parse', fromlist=['quote']).quote(fname)}"})


@app.post("/api/papers/{paper_id}/verify-meta")
def verify_meta(paper_id: str, request: Request):
    """联网校准元数据（arXiv/CrossRef；只发标题，标题匹配≥0.75 才写入）。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)   # 改写元数据属写操作
    try:
        from core.meta import verify_meta_online
        result = verify_meta_online(paper_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"校准服务不可达: {e}")
    return result


@app.get("/api/papers/{paper_id}/journal-rank")
def paper_journal_rank(paper_id: str, request: Request, force: int = 0):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility, journal FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.journal import get_journal_rank
    return get_journal_rank(p["journal"], force=bool(force))


@app.get("/api/statuses")
def papers_statuses(request: Request, paper_ids: str = "", limit: int = 0):
    """论文的 解析/翻译状态 + 每篇 token 用量。

    优化: 支持 paper_ids 精确查询（前端按当前视图传）+ 结果缓存 30s
    （库上千篇时全表扫描会拖慢文库页）.
    """
    u = require(request)
    # 缓存（状态变更频率低，30 秒足够）
    cache_key = f"statuses:{u['role']}:{u['id']}:{paper_ids}:{limit}"
    hit = _status_cache.get(cache_key)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    vis = "" if u["role"] == "admin" else " AND (visibility='shared' OR owner_id=?)"
    args = () if u["role"] == "admin" else (u["id"],)
    if paper_ids:
        ids = [x for x in paper_ids.split(",") if x]
        if ids:
            vis += f" AND id IN ({','.join('?' * len(ids))})"
            args.extend(ids)
    if limit:
        vis += " LIMIT ?"
        args = (*args, int(limit))
    papers = db.all(f"SELECT id, parse_status FROM papers WHERE deleted_at IS NULL{vis}", args)
    # 每篇最新 parse/translate 任务
    latest: dict[str, dict] = {}
    for j in db.all(
        "SELECT j.* FROM jobs j WHERE j.job_type IN ('parse','translate') "
        "AND j.id IN (SELECT MAX(id) FROM jobs WHERE job_type IN ('parse','translate') GROUP BY paper_id, job_type)"
    ):
        latest.setdefault(j["paper_id"], {})[j["job_type"]] = j
    tokens = {r["paper_id"]: r for r in db.all(
        "SELECT paper_id, SUM(prompt_tokens) p, SUM(completion_tokens) c, COUNT(*) calls "
        "FROM llm_calls WHERE paper_id IS NOT NULL GROUP BY paper_id")}
    out = {}
    for p in papers:
        lj = latest.get(p["id"], {})
        pj, tj = lj.get("parse"), lj.get("translate")
        tk = tokens.get(p["id"])
        out[p["id"]] = {
            "parse_status": p["parse_status"],
            "parsing": bool(pj and pj["status"] in ("queued", "pending_gate", "running")),
            "parse_job": {"id": pj["id"], "status": pj["status"],
                          "error": pj["error"]} if pj else None,
            "translating": bool(tj and tj["status"] in ("queued", "pending_gate", "running")),
            "translate_job": {"id": tj["id"], "status": tj["status"],
                              "done": tj["progress_done"], "total": tj["progress_total"],
                              "error": tj["error"]} if tj else None,
            "tokens": {"p": tk["p"], "c": tk["c"], "calls": tk["calls"]} if tk else None,
        }
    result = {"statuses": out}
    _status_cache[cache_key] = (time.time(), result)
    if len(_status_cache) > 64:
        for k in list(_status_cache)[:32]:
            _status_cache.pop(k, None)
    return result


@app.post("/api/papers/batch-delete")
async def batch_delete_papers(request: Request):
    """批量移入回收站（替代前端 N+1 逐篇 DELETE）。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or [])][:100]
    n = 0
    for pid in ids:
        p = db.one("SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is None:
            continue
        _require_visible(u, p)
        if p["visibility"] == "private" and p["owner_id"] != u["id"] and u["role"] != "admin":
            continue
        for j in db.all("SELECT * FROM jobs WHERE paper_id=? AND status IN ('queued','pending_gate','running')", (pid,)):
            if j["remote_task_id"]:
                mineru.cancel(j["remote_task_id"])
            with db.write() as c:
                c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
        with db.write() as c:
            c.execute("UPDATE papers SET deleted_at=datetime('now') WHERE id=?", (pid,))
            c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (pid,))
        audit(u["id"], "batch-delete", p["title"])
        n += 1
    return {"ok": True, "count": n}


@app.post("/api/trash/empty")
def empty_trash(request: Request):
    """清空回收站（按用户独立）：member 清自己删除的；admin 清全部。"""
    u = require(request)
    scope = "" if u["role"] == "admin" else " AND owner_id=?"
    sargs = () if u["role"] == "admin" else (u["id"],)
    rows = db.all(f"SELECT id FROM papers WHERE deleted_at IS NOT NULL{scope}", sargs)
    from core.jobs import scheduler
    for r in rows:
        scheduler.hard_delete_paper(r["id"])
    return {"purged": len(rows)}


@app.get("/api/export/bibtex")
def export_bibtex(request: Request, collection_id: str = ""):
    """整库/按库导出 BibTeX（Zotero/EndNote 可直接导入）."""
    u = require(request)
    vis = "" if u["role"] == "admin" else " AND (visibility='shared' OR owner_id=?)"
    args: list[Any] = [] if u["role"] == "admin" else [u["id"]]
    if collection_id:
        ids = [x for x in collection_id.split(",") if x]
        vis += f" AND collection_id IN ({','.join('?' * len(ids))})"
        args.extend(ids)
    rows = db.all(
        f"SELECT id, title, authors, year, journal, doi, abstract, keywords FROM papers "
        f"WHERE deleted_at IS NULL{vis} ORDER BY created_at", tuple(args))
    out = ["% BibTeX export from paper-system", ""]
    for r in rows:
        key = _bibtex_key(r)
        authors = r["authors"] or ""
        fields = [("title", (r["title"] or "").replace("{", "").replace("}", "")),
                  ("author", authors),
                  ("journal", r["journal"] or ""),
                  ("year", r["year"] or ""),
                  ("doi", r["doi"] or "")]
        if r["keywords"]:
            fields.append(("keywords", r["keywords"].strip("[]\"' ")))
        if r["abstract"]:
            fields.append(("abstract", r["abstract"].replace("{", "").replace("}", "")))
        out.append(f"@article{{{key},")
        for k, v in fields:
            if v:
                out.append(f"  {k} = {{{v}}},")
        out.append("}")
        out.append("")
    md = "\n".join(out)
    return _md_response(md, f"paper-system-{len(rows)}-papers.bib")


def _bibtex_key(r) -> str:
    """生成 BibTeX 引用键：首作者姓+年份+标题首词."""
    import re as _re
    authors = (r["authors"] or "").split(",")[0].strip()
    surname = authors.split()[-1] if authors else "anon"
    surname = _re.sub(r"[^A-Za-z]", "", surname) or "anon"
    year = _re.sub(r"[^0-9]", "", r["year"] or "")[:4] or "0000"
    words = _re.sub(r"[^A-Za-z ]", " ", r["title"] or "").split()
    first = words[0].lower() if words else "paper"
    return f"{surname.lower()}{year}{first}"


# ---------------- 导出下载（原文/双语 PDF·MD·ZIP 组合） ----------------
@app.get("/api/papers/{paper_id}/download/{fmt}")
def download_paper(paper_id: str, fmt: str, request: Request, items: str = ""):
    """fmt: pdf(原始PDF) md(原文md) bilingual_md bilingual_pdf zh_pdf en_pdf zip(组合)"""
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.exporter import (_zip_base_name, bilingual_md, build_zip, en_md,
                               md_to_pdf, original_md, zh_md)
    base = _zip_base_name(dict(p))
    title = p["title"] or base

    def _resp(content: bytes, filename: str, mime: str):
        from urllib.parse import quote
        return Response(content=content, media_type=mime, headers={
            "Content-Disposition":
                f"attachment; filename=\"file\"; filename*=UTF-8''{quote(filename)}"})

    if fmt == "pdf":
        path = ingest.PAPERS_DIR / paper_id / "original.pdf"
        if not path.exists():
            raise HTTPException(404, "原始 PDF 不存在")
        return _resp(path.read_bytes(), f"{base}.pdf", "application/pdf")
    if fmt == "md":
        return _resp(original_md(paper_id).encode("utf-8"), f"{base}.md", "text/markdown; charset=utf-8")
    if fmt == "bilingual_md":
        content = bilingual_md(paper_id)
        if not content.strip():
            raise HTTPException(400, "尚未翻译，无法导出中英对照")
        return _resp(content.encode("utf-8"), f"{base}-双语对照.md", "text/markdown; charset=utf-8")
    if fmt in ("bilingual_pdf", "zh_pdf", "en_pdf"):
        if fmt == "bilingual_pdf":
            from core.exporter import bilingual_pdf as _bp
            try:
                pdf = _bp(paper_id, title)
            except RuntimeError as e:
                raise HTTPException(400, str(e))
        else:
            src = {"zh_pdf": zh_md, "en_pdf": en_md}[fmt]
            content = src(paper_id)
            if not content.strip():
                raise HTTPException(400, "尚未翻译，无法导出该 PDF")
            from core.exporter import _parse_dir
            pdf = md_to_pdf(content, title, _parse_dir(paper_id))
        suffix = {"bilingual_pdf": "中英对照", "zh_pdf": "中文版", "en_pdf": "English"}[fmt]
        return _resp(pdf, f"{base}-{suffix}.pdf", "application/pdf")
    if fmt == "zip":
        want = [x for x in items.split(",") if x]
        if not want:
            raise HTTPException(400, "请选择要打包的内容")
        try:
            data, name = build_zip(paper_id, want)
        except RuntimeError as e:
            raise HTTPException(500, f"打包失败：{e}")
        return _resp(data, name, "application/zip")
    raise HTTPException(400, f"不支持的格式: {fmt}")


@app.get("/api/papers/{paper_id}/download-options")
def download_options(paper_id: str, request: Request):
    """可下载项（依据是否已翻译）。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    has_pdf = (ingest.PAPERS_DIR / paper_id / "original.pdf").exists()
    tr = db.one("SELECT COUNT(*) n FROM translations WHERE paper_id=?", (paper_id,))
    translated = bool(tr and tr["n"] > 0)
    return {
        "pdf": has_pdf, "md": True,
        "bilingual_md": translated, "bilingual_pdf": translated,
        "zh_pdf": translated, "en_pdf": True,
        "translated": translated,
    }


# ---------------- 索引重建 ----------------
@app.post("/api/papers/{paper_id}/reindex")
def reindex_paper(paper_id: str, request: Request):
    """重建块结构与检索索引：从已存的 middle.json 重新入库（不占 GPU）+ embedding 回填。

    解析产物结构修复后使用（如跨栏续文合并）；也用于换向量模型或索引异常。
    """
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)   # 重建索引会重建 parse_run 结构
    try:
        n_blocks, n_chunks = ingest.rebuild_from_stored(paper_id)
        from core.retrieval import invalidate_vec_cache
        from core.translator import invalidate_block_cache
        invalidate_vec_cache()   # chunks 已重建，向量矩阵缓存作废
        invalidate_block_cache()  # rebuild 复用同一 run_id 重建 blocks → 可翻译块缓存作废
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"重建失败：{e}")
    scheduler.enqueue(u["id"], "embed_backfill", paper_id, {}, priority="background")
    return {"ok": True, "blocks": n_blocks, "chunks": n_chunks}


@app.patch("/api/papers/{paper_id}/blocks/{block_id}")
async def edit_paper_block(paper_id: str, block_id: str, request: Request):
    """可视化修正：人工修正解析块文本，并同步重建受影响 chunk 的 FTS 与向量。

    与 reindex 同口径（仅属主/admin）：修正会改共享解析结果与检索索引。
    表格/图片块不支持（表格可视化编辑后置）。
    """
    u = require(request)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "文本不能为空")
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if run is None:
        raise HTTPException(400, "论文尚未解析完成")
    blk = db.one("SELECT type FROM blocks WHERE paper_id=? AND parse_run_id=? AND block_id=?",
                 (paper_id, run["id"], block_id))
    if blk is None:
        raise HTTPException(404, "块不存在")
    if blk["type"] in ("table", "image", "chart"):
        raise HTTPException(400, "表格/图片块暂不支持文本修正")
    n = retrieval.sync_block_edit(paper_id, run["id"], block_id, text)
    audit(u["id"], "edit-block", f"{paper_id}:{block_id}")
    return {"ok": True, "chunks": n}


# ---------------- 解析/翻译控制 ----------------
def _cancel_paper_jobs(paper_id: str, job_type: str) -> int:
    """取消该论文指定类型的在途任务。返回取消数。"""
    n = 0
    for j in db.all(
        "SELECT * FROM jobs WHERE paper_id=? AND job_type=? "
        "AND status IN ('queued','pending_gate','running')",
        (paper_id, job_type),
    ):
        if j["remote_task_id"]:
            mineru.cancel(j["remote_task_id"])
        with db.write() as c:
            c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
        n += 1
    return n


@app.post("/api/papers/{paper_id}/cancel-parse")
def cancel_parse(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)   # 取消他人任务属写操作
    n = _cancel_paper_jobs(paper_id, "parse")
    has_done = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done'", (paper_id,))
    with db.write() as c:
        if has_done:
            c.execute("UPDATE papers SET parse_status='parsed' WHERE id=?", (paper_id,))
        else:
            c.execute("UPDATE papers SET parse_status='failed' WHERE id=? AND parse_status IN ('pending','parsing')",
                      (paper_id,))
    return {"canceled": n}


@app.post("/api/papers/{paper_id}/cancel-translate")
def cancel_translate(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)   # 取消他人任务属写操作
    return {"canceled": _cancel_paper_jobs(paper_id, "translate")}


@app.post("/api/papers/{paper_id}/parse")
def start_parse(paper_id: str, request: Request):
    """(重新)解析：入队 interactive 任务，新建 parse_run。"""
    u = require(request)
    is_admin = u["role"] == "admin"
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    _require_owner(u, p)   # 重解析会作废旧译文对应关系，仅属主可操作
    overrides = _quota_overrides(u["id"])
    _check_daily_quota(u["id"], is_admin, overrides)
    _cancel_paper_jobs(paper_id, "parse")  # 重解析前清掉在途旧任务
    # URL 导入的论文：从历史任务继承 url（无本地原件）
    prev = db.one("SELECT payload FROM jobs WHERE paper_id=? AND job_type='parse' "
                  "AND payload LIKE '%\"url\"%' ORDER BY id DESC LIMIT 1", (paper_id,))
    import json as _j
    url = (_j.loads(prev["payload"]).get("url") if prev else None)
    scheduler.enqueue(u["id"], "parse", paper_id,
                      {"tier": "standard", "reparse": True, **({"url": url} if url else {})},
                      priority="interactive")
    with db.write() as c:
        c.execute("UPDATE papers SET parse_status='pending' WHERE id=?", (paper_id,))
    return {"ok": True}


@app.get("/api/papers/{paper_id}/jobstate")
def paper_jobstate(paper_id: str, request: Request):
    """论文当前在途任务状态（前端按钮切换依据）。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility, parse_status FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    rows = db.all(
        "SELECT job_type, status, progress_done, progress_total FROM jobs WHERE paper_id=? "
        "AND job_type IN ('parse','translate') AND status IN ('queued','pending_gate','running')",
        (paper_id,),
    )

    def _prog(t: str) -> dict | None:
        r = [x for x in rows if x["job_type"] == t]
        if not r:
            return None
        return {"done": r[0]["progress_done"], "total": r[0]["progress_total"], "status": r[0]["status"]}

    from core.translator import translation_status
    ts = translation_status(paper_id)
    complete_model = next((v["model"] for v in ts["versions"] if v["complete"]), None)
    return {"parse_status": p["parse_status"],
            "parsing": _prog("parse") is not None,
            "translating": _prog("translate") is not None,
            "parse_progress": _prog("parse"),
            "translate_progress": _prog("translate"),
            "translated": ts["complete_any"],
            "translated_model": complete_model}


# ---------------- 翻译 ----------------
@app.post("/api/papers/translate")
async def translate_papers(request: Request):
    """单篇或多选批量翻译（显式触发，非入库自动）。"""
    u = require(request)
    body = await request.json()
    paper_ids: list[str] = body.get("paper_ids") or []
    if not paper_ids:
        raise HTTPException(400, "paper_ids 为空")
    batch = len(paper_ids) > 1
    queued, skipped = [], []
    for pid in paper_ids:
        p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is None:
            raise HTTPException(404, f"论文 {pid} 不存在")
        _require_visible(u, p)
        # 防重复：已有进行中的翻译任务 → 跳过（除非显式 force_new_version）
        in_flight = db.one(
            "SELECT id FROM jobs WHERE paper_id=? AND job_type='translate' "
            "AND status IN ('queued','pending_gate','running')", (pid,))
        if in_flight and not body.get("force_new_version"):
            skipped.append(pid)
            continue
        # 已有完整译文且非强制重译 → 跳过（缓存零成本，没必要走队列）
        if not body.get("force_new_version"):
            from core.translator import translation_status
            st = translation_status(pid)
            if st["complete_any"]:
                skipped.append(pid)
                continue
            # 有部分译文但未完整 → 续翻（翻译器会按块补齐）
        scheduler.enqueue(u["id"], "translate", pid,
                          {"force_new_version": bool(body.get("force_new_version"))},
                          priority="background" if batch else "interactive")
        queued.append(pid)
    return {"queued": queued, "skipped_in_flight": skipped,
            "skipped_already_done": len(skipped)}


@app.get("/api/papers/{paper_id}/cite")
def paper_cite(paper_id: str, request: Request):
    """引用文本：一次给出全部样式（GB/T 7714 / APA / MLA / BibTeX）。

    前端拿到后本地切换样式、即时预览，不弹窗、不逐次请求。
    """
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.cite import STYLES, DEFAULT_STYLE, all_styles, csl_json, CSL_STYLES
    return {
        "styles": all_styles(dict(p)),          # 旧内置渲染：bibtex 用；CSL 失败时兜底
        "labels": {k: v for k, v in STYLES},
        "default": DEFAULT_STYLE,
        "csl_json": csl_json(dict(p)),          # citeproc-js 输入
        "csl_list": CSL_STYLES,                 # [(style_id, label)]
    }


# ---------------- 找相关（Semantic Scholar 三模式） ----------------
@app.get("/api/papers/{paper_id}/discover")
def paper_discover(paper_id: str, request: Request, mode: str = "rec", limit: int = 20):
    """相关文献发现：rec=相关推荐 / refs=参考文献 / cites=引证。结果带 in_library 标记。"""
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core import discover as _disc
    try:
        items = _disc.discover(dict(p), mode, limit)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Semantic Scholar 不可达: {e}")
    out = []
    for it in items:
        dup = None
        if it["doi"]:
            dup = db.one("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", (it["doi"],))
        if dup is None and it["title"]:
            dup = db.one("SELECT id FROM papers WHERE lower(title)=? AND deleted_at IS NULL",
                         (it["title"].lower(),))
        out.append({**it, "in_library": dup["id"] if dup else None})
    return {"items": out, "mode": mode}


@app.post("/api/papers/discover-import")
async def discover_import(request: Request):
    """导入「找相关」勾选的论文：DOI/标题查重 → URL 导入（复用 import-url 链路）→ 元数据先行回填。

    仅接受带公开 PDF 的条目（无 pdf_url 的返回 no_pdf）。
    """
    u = require(request)
    body = await request.json()
    items = [x for x in (body.get("items") or []) if isinstance(x, dict)][:20]
    if not items:
        raise HTTPException(400, "items 为空")
    out = []
    imported = 0
    for it in items:
        title = (it.get("title") or "").strip()
        url = (it.get("pdf_url") or "").strip()
        if not title:
            continue
        dup = None
        if it.get("doi"):
            dup = db.one("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", (it["doi"],))
        if dup is None:
            dup = db.one("SELECT id FROM papers WHERE lower(title)=? AND deleted_at IS NULL",
                         (title.lower(),))
        if dup:
            out.append({"title": title, "status": "duplicate", "paper_id": dup["id"]})
            continue
        if not url.startswith(("http://", "https://")):
            out.append({"title": title, "status": "no_pdf"})
            continue
        from core.discover import resolve_direct_pdf
        url = resolve_direct_pdf(url)   # doi.org 落地页 → 直链 PDF（MinerU 不跟 302）
        try:
            _assert_public_url(url)
        except HTTPException:
            out.append({"title": title, "status": "no_pdf"})
            continue
        file_hash = "url:" + ingest.sha256_bytes(url.encode())
        exist = db.one("SELECT id FROM papers WHERE file_hash=? AND deleted_at IS NULL", (file_hash,))
        if exist:
            out.append({"title": title, "status": "duplicate", "paper_id": exist["id"]})
            continue
        name = Path(url.split("?")[0]).name or "document.pdf"
        if "." not in name:
            name += ".pdf"
        paper_id, _ = ingest.create_paper(u["id"], file_hash, 0, 0,
                                          body.get("visibility", "shared"), name)
        cid = body.get("collection_id") or get_or_create_default_collection(u["id"])
        with db.write() as c:
            c.execute("UPDATE papers SET collection_id=? WHERE id=?", (cid, paper_id))
            # 元数据先行：S2 已给全，MinerU 解析完成后的标题提取会再校准一次
            c.execute("UPDATE papers SET title=?, authors=?, year=?, journal=?, doi=? WHERE id=?",
                      (title, it.get("authors") or "", it.get("year") or "",
                       it.get("venue") or "", it.get("doi") or "", paper_id))
        scheduler.enqueue(u["id"], "parse", paper_id, {"tier": "standard", "url": url},
                          priority="interactive")
        out.append({"title": title, "status": "queued", "paper_id": paper_id})
        imported += 1
    if imported:
        audit(u["id"], "discover-import", f"{imported} 篇")
    return {"results": out}


@app.get("/api/papers/{paper_id}/bilingual")
def get_bilingual(paper_id: str, request: Request, cache_key: str = "",
                  offset: int = 0, limit: int = 0):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.translator import bilingual_pairs, translation_versions
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if run is None:
        return {"pairs": [], "versions": []}
    pairs = bilingual_pairs(paper_id, run["id"], cache_key or None)
    total = len(pairs)
    if limit:
        pairs = pairs[offset:offset + limit]
    return {"run_id": run["id"], "pairs": pairs, "versions": translation_versions(paper_id),
            "total": total, "offset": offset, "limit": limit}


# ---------------- 术语表 ----------------
@app.get("/api/glossary")
def get_glossary(request: Request):
    require(request)
    return {"terms": [dict(r) for r in db.all("SELECT * FROM glossary ORDER BY term")]}


@app.post("/api/glossary")
async def set_glossary(request: Request):
    u = require(request)
    body = await request.json()
    term = (body.get("term") or "").strip()
    if not term:
        raise HTTPException(400, "term 必填")
    with db.write() as c:
        c.execute(
            "INSERT INTO glossary(term,target,value,created_by) VALUES(?,?,?,?) "
            "ON CONFLICT(term) DO UPDATE SET target=?, value=?",
            (term, body.get("target", "keep_en"), body.get("value", ""), u["id"],
             body.get("target", "keep_en"), body.get("value", "")),
        )
    return {"ok": True}


@app.delete("/api/glossary/{term}")
def del_glossary(term: str, request: Request):
    require(request)
    with db.write() as c:
        c.execute("DELETE FROM glossary WHERE term=?", (term,))
    return {"ok": True}


# ---------------- 问答（SSE 流式） ----------------
@app.post("/api/chat/stream")
async def chat_stream(request: Request):
    u = require(request)
    body = await request.json()
    question = (body.get("question") or "").strip()
    paper_ids: list[str] = body.get("paper_ids") or []
    mode = body.get("mode", "auto")
    session_id = body.get("session_id") or ""
    if not question or not paper_ids:
        raise HTTPException(400, "question/paper_ids 必填")

    try:
        prepared = qa.answer(u, question, paper_ids, mode)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except NoKeyError as e:
        raise HTTPException(400, str(e))

    # 会话管理（传入 session_id 必须归属本人，防跨用户注入消息）
    with db.write() as c:
        if not session_id:
            session_id = "s" + secrets.token_hex(8)   # TEXT 主键，直接构造
            c.execute(
                "INSERT INTO chat_sessions(id,user_id,paper_scope,title) VALUES(?,?,?,?)",
                (session_id, u["id"], ",".join(paper_ids), question[:30]),
            )
        elif (srow := db.one("SELECT user_id FROM chat_sessions WHERE id=?", (session_id,))) is None \
                or srow["user_id"] != u["id"]:
            raise HTTPException(403, "会话不存在或无权访问")
        c.execute(
            "INSERT INTO chat_messages(session_id,role,content) VALUES(?,?,'')",
            (session_id, "user"),
        )
        c.execute(
            "UPDATE chat_messages SET content=? WHERE id=(SELECT MAX(id) FROM chat_messages "
            "WHERE session_id=? AND role='user')",
            (question, session_id),
        )
        c.execute("UPDATE chat_sessions SET updated_at=datetime('now') WHERE id=?", (session_id,))

    cfg = prepared["cfg"]
    evidence = prepared["evidence"]
    quote = (body.get("quote") or "").strip()[:800]
    q_full = f"{question}\n\n用户引用的原文：\n{quote}" if quote else question
    # 多轮上下文：注入最近 2 轮问答（每则截断 400 字，总预算 1600），支持追问。
    # 当前问题已在上面入库 → 排除最后一条 user。
    hist_rows = db.all(
        "SELECT role, content FROM chat_messages WHERE session_id=? AND role IN ('user','assistant') "
        "ORDER BY id DESC LIMIT 8", (session_id,))
    rows = list(reversed(hist_rows))
    if rows and rows[-1]["role"] == "user":
        rows = rows[:-1]
    turns = []
    for r in rows:
        if r["role"] == "user":
            turns.append({"role": "user", "content": r["content"][:400]})
        elif turns and turns[-1]["role"] == "user":
            turns.append({"role": "assistant", "content": r["content"][:400]})
        elif turns:
            turns[-1] = {"role": "assistant", "content": r["content"][:400]}   # 连续 assistant 取最后
    turns = turns[-4:]                                   # 最多 2 轮
    if sum(len(m["content"]) for m in turns) > 1600:     # 超预算 → 只保留最后一轮
        turns = turns[-2:]
    messages = [{"role": "system", "content": prepared["system"]}]
    if len(turns) >= 2:                                  # 至少一轮完整问答才注入
        messages += turns
    messages.append(
        {"role": "user", "content": (
            f"证据材料：\n\n{prepared['context']}\n\n问题：{q_full}\n\n请回答（标注 [n] 证据编号）："
        )})

    def gen() -> Iterator[str]:
        full: list[str] = []
        try:
            client = LLMClient(cfg, user_id=u["id"],
                               paper_id=paper_ids[0] if len(paper_ids) == 1 else None)
            for delta in client.stream(messages, max_tokens=4096):
                full.append(delta)
                yield f"data: {json.dumps({'type': 'delta', 'text': delta})}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)[:200]})}\n\n"
        answer_text = "".join(full)
        try:
            check = qa.validate_citations(answer_text, evidence)
            payload = {"type": "done", "session_id": session_id, "mode": prepared["mode"],
                       "truncated": prepared["truncated"],
                       "citations": {"cited": check["cited"], "illegal": check["illegal"]},
                       "evidence": check["evidence"]}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            with db.write() as c:
                c.execute(
                    "INSERT INTO chat_messages(session_id,role,content,evidence) VALUES(?,?,?,?)",
                    (session_id, "assistant", answer_text,
                     json.dumps(check["evidence"], ensure_ascii=False)),
                )
        except Exception as e:  # noqa: BLE001
            log.exception("chat 收尾失败 %s", session_id)
            yield f"data: {json.dumps({'type': 'error', 'message': f'回答收尾失败: {str(e)[:120]}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


@app.get("/api/chat/sessions")
def chat_sessions(request: Request, paper_id: str = ""):
    u = require(request)
    cond, args = "user_id=?", [u["id"]]
    if paper_id:
        cond += " AND paper_scope LIKE ?"
        args.append(f"%{paper_id}%")
    rows = db.all(f"SELECT * FROM chat_sessions WHERE {cond} ORDER BY updated_at DESC LIMIT 50",
                  tuple(args))
    return {"sessions": [dict(r) for r in rows]}


@app.delete("/api/chat/sessions/{session_id}")
def delete_chat_session(session_id: str, request: Request):
    u = require(request)
    row = db.one("SELECT user_id FROM chat_sessions WHERE id=?", (session_id,))
    if row is None or (row["user_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "会话不存在")
    with db.write() as c:
        c.execute("DELETE FROM chat_messages WHERE session_id=?", (session_id,))
        c.execute("DELETE FROM chat_sessions WHERE id=?", (session_id,))
    return {"ok": True}


@app.patch("/api/chat/sessions/{session_id}")
async def rename_chat_session(session_id: str, request: Request):
    u = require(request)
    row = db.one("SELECT user_id FROM chat_sessions WHERE id=?", (session_id,))
    if row is None or (row["user_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "会话不存在")
    body = await request.json()
    title = (body.get("title") or "").strip()[:60]
    if not title:
        raise HTTPException(400, "标题不能为空")
    with db.write() as c:
        c.execute("UPDATE chat_sessions SET title=? WHERE id=?", (title, session_id))
    return {"ok": True}


@app.get("/api/chat/sessions/{session_id}/messages")
def chat_messages(session_id: str, request: Request):
    u = require(request)
    s = db.one("SELECT * FROM chat_sessions WHERE id=?", (session_id,))
    if s is None or (s["user_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "会话不存在")
    rows = db.all("SELECT role, content, evidence, created_at FROM chat_messages "
                  "WHERE session_id=? ORDER BY id", (session_id,))
    return {"session": dict(s), "messages": [dict(r) for r in rows]}


@app.get("/api/presets")
def presets(request: Request):
    require(request)
    return {"questions": qa.PRESET_QUESTIONS, "compare": qa.COMPARE_QUESTIONS}


# ---------------- 导读 ----------------
@app.post("/api/papers/{paper_id}/summary")
async def paper_summary(paper_id: str, request: Request):
    u = require(request)
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    p = db.one("SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    # 异步模式：入队（任务中心可见进度/可取消），前端轮询 jobstate
    if body.get("async"):
        try:
            job_id = scheduler.enqueue(u["id"], "summary", paper_id, {}, priority="interactive")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"任务入队失败: {e}")
        return {"job_id": job_id}
    try:
        sid, payload = summarizer.generate(u, paper_id)
    except NoKeyError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    # 写回会话：导读 = 对话的首条默认回答
    session_id = body.get("session_id") or ""
    with db.write() as c:
        if not session_id:
            session_id = "s" + secrets.token_hex(8)
            c.execute("INSERT INTO chat_sessions(id,user_id,paper_scope,title) VALUES(?,?,?,?)",
                      (session_id, u["id"], paper_id, f"导读 · {(p['title'] or '')[:24]}"))
        elif (srow := db.one("SELECT user_id FROM chat_sessions WHERE id=?", (session_id,))) is None \
                or srow["user_id"] != u["id"]:
            raise HTTPException(403, "会话不存在或无权访问")
        c.execute("INSERT INTO chat_messages(session_id,role,content,evidence) VALUES(?,?,?,?)",
                  (session_id, "user", "请生成这篇论文的科研导读", "[]"))
        # 聊天记录用全局编号（sections_global）：此处的证据数组是全局 evidence_id，
        # 引用编号必须与之一致，否则点 [n] 会跳到不相干的段落。
        chat_sections = payload.get("sections_global") or payload["sections"]
        c.execute("INSERT INTO chat_messages(session_id,role,content,evidence) VALUES(?,?,?,?)",
                  (session_id, "assistant",
                   "\n\n".join(f"**{k}**：{v}" for k, v in chat_sections.items()),
                   json.dumps(payload["evidence"], ensure_ascii=False)))
    return {"id": sid, "session_id": session_id, **payload}


@app.get("/api/papers/{paper_id}/summary")
def get_paper_summary(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    s = summarizer.get_latest(paper_id)
    if s is None:
        return {"summary": None}
    return {"summary": json.loads(s["content"]), "model": s["model"], "created_at": s["created_at"]}


# ---------------- 静态资源 ----------------
@app.get("/login")
def login_page():
    return FileResponse(WEBUI_DIR / "login.html")


@app.get("/")
def index():
    return FileResponse(WEBUI_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(WEBUI_DIR)), name="static")
