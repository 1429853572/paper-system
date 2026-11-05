"""paper-system API 服务 (FastAPI)."""
from __future__ import annotations

import io
import json
import secrets
from pathlib import Path
from typing import Any, Iterator

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core import auth, ingest, qa, retrieval, summarizer
from core.config import (DATA_DIR, MINERU_BASE_URL, OLLAMA_BASE_URL,
                           PAPERSYS_API_TOKEN, config)
from core.db import db
from core.jobs import bus, scheduler
from core.llm import LLMClient, NoKeyError, test_connection
from core.mineru_client import mineru

app = FastAPI(title="paper-system", docs_url=None, redoc_url=None)


@app.middleware("http")
async def _no_cache_ui(request: Request, call_next):
    """页面与静态资源总是再验证（ETag 304），避免改版后浏览器跑旧 JS."""
    resp = await call_next(request)
    p = request.url.path
    if p.startswith("/static") or p in ("/", "/login"):
        resp.headers["Cache-Control"] = "no-cache"
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
        return auth.parse_session(token)
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
    ollama_ok = False
    try:
        import httpx
        r = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        ollama_ok = r.status_code == 200
    except Exception:  # noqa: BLE001
        pass
    return {"db": True, "mineru": mineru.healthy(), "ollama": ollama_ok}


# ---------------- 登录/注册 ----------------
@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    ip = request.client.host if request.client else "?"
    try:
        auth.check_login_rate(ip)
    except auth.AuthError as e:
        raise HTTPException(429, str(e))
    user = auth.authenticate(body.get("username", ""), body.get("password", ""))
    if user is None:
        auth.record_login_fail(ip)
        raise HTTPException(401, "用户名或密码错误")
    token = auth.make_session(user["id"], user["role"])
    resp = JSONResponse({"id": user["id"], "username": user["username"], "role": user["role"]})
    resp.set_cookie("ps_session", token, httponly=True, samesite="lax",
                    max_age=30 * 24 * 3600)
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("ps_session")
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
                collection_id: str = ""):
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
        vis += " AND collection_id=?"
        args.append(collection_id)
    cond = "deleted_at IS NULL" if not trash else "deleted_at IS NOT NULL"
    rows = db.all(f"SELECT * FROM papers WHERE {cond}{vis} ORDER BY created_at DESC LIMIT 500", tuple(args))
    return {"papers": [dict(r) for r in rows]}


@app.get("/api/papers/{paper_id}")
def paper_detail(paper_id: str, request: Request):
    u = require(request)
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    blocks = ingest.latest_blocks(paper_id)
    return {"paper": dict(p), "blocks": [dict(b) for b in blocks]}


def _require_visible(u: dict, paper) -> None:
    if paper["visibility"] == "private" and paper["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "无权访问该论文")


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
def list_jobs(request: Request, status: str = "", job_type: str = "", limit: int = 100):
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


@app.post("/api/papers/import-url")
async def import_url(request: Request):
    """URL 直接导入（MinerU 服务端抓取；支持 pdf/arxiv 直链等）."""
    u = require(request)
    body = await request.json()
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "无效 URL")
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
        "SELECT c.*, (SELECT COUNT(*) FROM papers p WHERE p.collection_id=c.id "
        "AND p.deleted_at IS NULL AND (p.visibility='shared' OR p.owner_id=?)) AS papers "
        "FROM collections c WHERE c.owner_id=? ORDER BY c.created_at",
        (u["id"], u["id"]),
    )
    return {"total": total, "collections": [dict(r) for r in rows]}


@app.post("/api/collections")
async def create_collection(request: Request):
    u = require(request)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not (1 <= len(name) <= 50):
        raise HTTPException(400, "库名 1-50 字符")
    cid = "c" + secrets.token_hex(6)
    with db.write() as c:
        c.execute("INSERT INTO collections(id,name,owner_id) VALUES(?,?,?)", (cid, name, u["id"]))
    return {"id": cid, "name": name}


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


@app.delete("/api/collections/{cid}")
def delete_collection(cid: str, request: Request):
    u = require(request)
    row = db.one("SELECT owner_id FROM collections WHERE id=?", (cid,))
    if row is None or (row["owner_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "文献库不存在")
    with db.write() as c:
        c.execute("UPDATE papers SET collection_id=NULL WHERE collection_id=?", (cid,))
        c.execute("DELETE FROM collections WHERE id=?", (cid,))
    return {"ok": True}


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
    for field in ("title", "authors", "journal", "year", "doi", "keywords", "abstract"):
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
        return {"figures": [], "tables": []}
    mf = ingest.PAPERS_DIR / paper_id / "parse" / run["id"] / "middle_json.json"
    if not mf.exists():
        return {"figures": [], "tables": []}
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

    # 编号解析：Figure N / Table N → 徽标；无编号子图归并到同页主图
    import re as _re

    def _label(cap: str, kind: str) -> str:
        m = _re.search(rf"{kind}\s*\.?\s*(\d+)", cap or "", _re.I)
        if not m:
            return ""
        return ("图" if kind == "figure" else "表") + m.group(1)

    for t in tables:
        t["label"] = _label(t["caption"], "table") or f"第{t['page_index'] + 1}页·表"
    tables.sort(key=lambda t: t["page_index"])

    by_page: dict[int, list] = {}
    for f in figures_raw:
        by_page.setdefault(f["page_index"], []).append(f)
    figures = []
    for pg in sorted(by_page):
        imgs = sorted(by_page[pg], key=lambda x: ((x.get("bbox") or [0, 0, 0, 0])[1]))
        numbered, others = [], []
        for f in imgs:
            (_label(f["caption"], "figure") if False else None)
            if _label(f["caption"], "figure"):
                numbered.append(f)
            else:
                others.append(f)
        def _union(members):
            bs = [m.get("bbox") for m in members if m.get("bbox")]
            if not bs:
                return None
            return [min(b[0] for b in bs), min(b[1] for b in bs),
                    max(b[2] for b in bs), max(b[3] for b in bs)]

        if not numbered:
            if imgs:
                first = imgs[0]
                first["label"] = f"第{pg + 1}页·组图"
                first["extra_images"] = [o["image_path"] for o in imgs[1:]]
                first["sub_captions"] = [o["caption"] for o in imgs if o["caption"]]
                first["union_bbox"] = _union(imgs)
                figures.append(first)
            continue
        # 有编号：未编号子图挂到「bbox 纵向在其上方的最近编号图」
        assigned: dict[int, list] = {id(n): [] for n in numbered}
        for o in others:
            oy = (o.get("bbox") or [0, 0, 0, 0])[1]
            target = None
            for n in numbered:
                ny = (n.get("bbox") or [0, 9, 0, 9])[1]
                if ny <= oy + 0.02:
                    target = n  # 保留最下方的上方编号
            assigned[id(target if target else numbered[0])].append(o)
        for n in numbered:
            subs = assigned[id(n)]
            n["label"] = _label(n["caption"], "figure")
            n["extra_images"] = [s["image_path"] for s in subs]
            n["sub_captions"] = [s["caption"] for s in subs if s["caption"]]
            n["union_bbox"] = _union([n] + subs)
            figures.append(n)
    return {"figures": figures, "tables": tables}


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
    return _md_response("\n".join(lines), f"对话-{s['title'] or session_id}.md")


@app.post("/api/papers/{paper_id}/verify-meta")
def verify_meta(paper_id: str, request: Request):
    """联网校准元数据（arXiv/CrossRef；只发标题，标题匹配≥0.75 才写入）。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
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
def papers_statuses(request: Request):
    """全部论文的 解析/翻译状态 + 每篇 token 用量（文库管理行内展示）."""
    u = require(request)
    vis = "" if u["role"] == "admin" else " AND (visibility='shared' OR owner_id=?)"
    args = () if u["role"] == "admin" else (u["id"],)
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
    return {"statuses": out}


@app.get("/api/papers/{paper_id}/block-notes")
def get_block_notes(paper_id: str, request: Request):
    u = require(request)
    rows = db.all("SELECT block_id, note FROM block_notes WHERE user_id=? AND paper_id=?",
                  (u["id"], paper_id))
    return {"notes": {r["block_id"]: r["note"] for r in rows}}


@app.put("/api/papers/{paper_id}/block-notes")
async def set_block_note(paper_id: str, request: Request):
    u = require(request)
    body = await request.json()
    bid = body.get("block_id") or ""
    note = (body.get("note") or "").strip()[:2000]
    if not bid:
        raise HTTPException(400, "block_id 必填")
    with db.write() as c:
        if note:
            c.execute(
                "INSERT INTO block_notes(user_id,paper_id,block_id,note,updated_at) "
                "VALUES(?,?,?,?,datetime('now')) "
                "ON CONFLICT(user_id, block_id) DO UPDATE SET note=?, updated_at=datetime('now')",
                (u["id"], paper_id, bid, note, note))
        else:
            c.execute("DELETE FROM block_notes WHERE user_id=? AND block_id=?", (u["id"], bid))
    return {"ok": True}


@app.get("/api/papers/{paper_id}/merges")
def get_merges(paper_id: str, request: Request):
    require(request)
    rows = db.all("SELECT head_bid, member_bids FROM block_merges WHERE paper_id=?", (paper_id,))
    import json as _j
    return {"merges": [{"head_bid": r["head_bid"], "member_bids": _j.loads(r["member_bids"])} for r in rows]}


@app.post("/api/papers/{paper_id}/merges")
async def create_merge(paper_id: str, request: Request):
    """合并段落：member_bids 有序数组（识别错拆的段落并回一块）."""
    u = require(request)
    body = await request.json()
    bids = body.get("member_bids") or []
    if len(bids) < 2:
        raise HTTPException(400, "至少选择两段")
    with db.write() as c:
        c.execute("INSERT OR REPLACE INTO block_merges(paper_id, head_bid, member_bids) VALUES(?,?,?)",
                  (paper_id, bids[0], json.dumps(bids)))
    return {"ok": True}


@app.delete("/api/papers/{paper_id}/merges/{head_bid}")
def delete_merge(paper_id: str, head_bid: str, request: Request):
    require(request)
    with db.write() as c:
        c.execute("DELETE FROM block_merges WHERE paper_id=? AND head_bid=?", (paper_id, head_bid))
    return {"ok": True}


# ---------------- 索引重建 ----------------
@app.post("/api/papers/{paper_id}/reindex")
def reindex_paper(paper_id: str, request: Request):
    """embedding/FTS 索引重建（后台任务）。换向量模型或索引异常时使用。"""
    u = require(request)
    p = db.one("SELECT id, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    scheduler.enqueue(u["id"], "embed_backfill", paper_id, {}, priority="background")
    return {"ok": True}


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
        # 已有完整译文且非强制重译 → 跳过（缓存零成本也没必要走队列）
        if not body.get("force_new_version"):
            from core.translator import translation_status
            if translation_status(pid)["complete_any"]:
                skipped.append(pid)
                continue
        scheduler.enqueue(u["id"], "translate", pid,
                          {"force_new_version": bool(body.get("force_new_version"))},
                          priority="background" if batch else "interactive")
        queued.append(pid)
    return {"queued": queued, "skipped_in_flight": skipped}


@app.get("/api/papers/{paper_id}/bilingual")
def get_bilingual(paper_id: str, request: Request, cache_key: str = ""):
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
    return {"run_id": run["id"], "pairs": pairs, "versions": translation_versions(paper_id)}


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

    # 会话管理
    with db.write() as c:
        if not session_id:
            session_id = "s" + secrets.token_hex(8)   # TEXT 主键，直接构造
            c.execute(
                "INSERT INTO chat_sessions(id,user_id,paper_scope,title) VALUES(?,?,?,?)",
                (session_id, u["id"], ",".join(paper_ids), question[:30]),
            )
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
    messages = [
        {"role": "system", "content": qa.SYSTEM},
        {"role": "user", "content": (
            f"证据材料：\n\n{prepared['context']}\n\n问题：{q_full}\n\n请回答（标注 [n] 证据编号）："
        )},
    ]

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
    return {"questions": qa.PRESET_QUESTIONS}


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
        c.execute("INSERT INTO chat_messages(session_id,role,content,evidence) VALUES(?,?,?,?)",
                  (session_id, "user", "请生成这篇论文的科研导读", "[]"))
        c.execute("INSERT INTO chat_messages(session_id,role,content,evidence) VALUES(?,?,?,?)",
                  (session_id, "assistant",
                   "\n\n".join(f"**{k}**：{v}" for k, v in payload["sections"].items()),
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
