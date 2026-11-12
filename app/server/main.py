"""paper-system API 服务 (FastAPI)."""
from __future__ import annotations

import io
import json
import os
import re
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
    elif p.startswith("/api"):
        # 动态数据一律禁缓存——浏览器启发式缓存曾让用户看到旧数据
        # （删了的论文还在、改了的数字不动，实测于多对多/n.d. 验证期）
        resp.headers["Cache-Control"] = "no-store"
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
async def _startup() -> None:
    # SSE 长连接与全部同步端点共用 AnyIO 线程池（默认 40）：每条 SSE 常驻占 1 token，
    # 20 人 × 1-2 标签页即贴顶 → 所有端点排队（表现为整站卡顿而 DB 查询都是亚毫秒）。
    # 调大给常驻 SSE 留余量（SSE 每条只占 1 线程、其余端点毫秒级归还）。
    from anyio import to_thread
    to_thread.current_default_thread_limiter().total_tokens = 120
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

        gen_row = db.one("SELECT value FROM settings WHERE key=?", (f"tgen:{job['paper_id']}",))
        my_gen = int(gen_row["value"]) if gen_row else 0

        def _cur_gen() -> int:
            row = db.one("SELECT value FROM settings WHERE key=?", (f"tgen:{job['paper_id']}",))
            return int(row["value"]) if row else 0

        def cancel_check() -> bool:
            row = db.one("SELECT status FROM jobs WHERE id=?", (job["id"],))
            if row and row["status"] == "canceled":
                return True
            return _cur_gen() != my_gen   # 新代次已发起：旧任务让位（T3）

        n = translator.translate_paper(
            job["user_id"], job["paper_id"], run["id"],
            force_new=bool(payload.get("force_new_version")), progress_cb=cb,
            cancel_check=cancel_check,
        )
        # 外部取消时保留 canceled 状态，不覆盖为 done；代次被取代同理
        cur = db.one("SELECT status FROM jobs WHERE id=?", (job["id"],))
        if cur and cur["status"] == "canceled":
            pass
        elif _cur_gen() != my_gen:
            scheduler._update(job["id"], status="canceled",
                              error="已被更新的翻译任务取代（术语表/强制重译）")
        else:
            scheduler._update(job["id"], status="done", progress_done=n, progress_total=n)
            # 摘要收敛为忠实翻译：译文刚生成，用摘要块译文覆盖 3 句总结（零 LLM 成本）
            from core.meta import refresh_abstract_from_translations
            try:
                refresh_abstract_from_translations(job["paper_id"])
            except Exception as e:  # noqa: BLE001 —— 回填失败不影响翻译任务状态
                log.warning("摘要回填失败 %s: %s", job["paper_id"], str(e)[:120])

    scheduler.translate_handler = _translate_handler
    scheduler.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    scheduler.stop()


# ---------------- 健康与配置自检 ----------------
_health_cache: list = [0.0, None]   # [ts, payload]——每标签页 20s 轮询 × 两个上游探测（10s+5s 超时）

@app.get("/api/health")
def health():
    # 30s 服务端缓存：上游探测贵（mineru /health 10s 超时 + embedding 5s），多标签页轮询放大
    now = time.time()
    if _health_cache[1] and now - _health_cache[0] < 30:
        return _health_cache[1]
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
    payload = {"db": True, "mineru": mineru.healthy(), "ai": ai_ok, "models": models,
               "trash_days": int(config.get("retention", "trash_days"))}
    _health_cache[:] = [now, payload]
    return payload


# ---------------- 登录/注册 ----------------
@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    # 反代后 client.host 恒为 caddy 容器 IP → 限速退化成按用户名（爆破横向不受限、
    # 锁号 DoS）。X-Forwarded-For 由本机 caddy 注入，取最后一跳=真实客户端。
    xff = (request.headers.get("x-forwarded-for") or "").split(",")
    ip = xff[-1].strip() if xff and xff[-1].strip() else (request.client.host if request.client else "?")
    uname = (body.get("username") or "").strip()
    try:
        auth.check_login_rate(ip, uname)          # IP+用户名双键（原）
        auth.check_login_rate(ip)                 # 纯 IP 键：换用户名爆破同样受限
    except auth.AuthError as e:
        raise HTTPException(429, str(e))
    user = auth.authenticate(uname, body.get("password", ""))
    if user is None:
        auth.record_login_fail(ip, uname)
        audit(None, "login-fail", f"ip={ip} user={uname}")   # 失败留痕（成功原本就有）
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
def logout_all(u: dict = Depends(require)):
    """登出所有设备：token_ver+1，全部旧会话失效（当前设备除外——重新签发）。"""
    auth.bump_token_ver(u["id"])
    audit(u["id"], "logout-all", (db.one("SELECT username FROM users WHERE id=?", (u["id"],)) or {"username": "?"})["username"])
    row2 = db.one("SELECT role, token_ver FROM users WHERE id=?", (u["id"],))
    resp = JSONResponse({"ok": True})
    token = auth.make_session(u["id"], row2["role"], row2["token_ver"])
    resp.set_cookie("ps_session", token, httponly=True, samesite="lax",
                    max_age=auth.SESSION_MAX_AGE)
    return resp


@app.get("/api/me")
def me(u: dict = Depends(require)):
    row = db.one("SELECT username, role, created_at FROM users WHERE id=?", (u["id"],))
    llm = auth.get_user_llm(u["id"]) or {}
    pool = db.one("SELECT value FROM settings WHERE key='pool_enabled'")
    pool_on = pool is not None and pool["value"] == "1"   # 公共额度池：未配 key 的成员问答走 POOL key
    return {
        "id": u["id"], "username": row["username"], "role": row["role"],
        "llm_configured": {
            "chat": bool(llm.get("chat", {}).get("key")),
            "translate": bool(llm.get("translate", {}).get("key")),
        },
        "llm_usable": {
            "chat": pool_on or bool(llm.get("chat", {}).get("key")),
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
    # 新成员即建「默认文献库」——否则首登侧栏无任何归属（上传时才隐式创建，用户不知去向）
    try:
        get_or_create_default_collection(uid)
    except Exception:  # noqa: BLE001 —— 建库失败不影响注册
        log.warning("新用户 %s 建默认库失败", username)
    audit(uid, "register", username)
    return {"ok": True}


# ---------------- BYOK 设置 ----------------
@app.get("/api/settings/llm")
def get_llm_settings(u: dict = Depends(require)):
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
            if u["role"] != "admin" and conf.get("base_url"):
                _assert_public_url(conf["base_url"])   # BYOK base_url 服务端会主动请求——同堵 SSRF
            meta = {"base_url": conf.get("base_url", ""), "model": conf.get("model", ""),
                    "api_type": conf.get("api_type", "openai")}
            sets = [f"{purpose}_meta=?"]
            args: list[Any] = [_json.dumps(meta)]
            if conf.get("api_key"):  # 有新 key 才更新密文；留空保持原值
                sets.append(f"{purpose}_cipher=?")
                args.append(auth.encrypt_key(conf["api_key"]))
            c.execute(f"UPDATE user_llm_keys SET {','.join(sets)} WHERE user_id=?",
                      (*args, u["id"]))
    purposes = [k for k in ("chat", "translate") if body.get(k)]
    audit(u["id"], "llm-key-set", " + ".join(purposes) + f"（base_url={body.get(purposes[0], {}).get('base_url', '')[:40]}）")   # 只记动作与来源，不落 key
    return {"ok": True}


@app.post("/api/settings/llm/test")
async def test_llm(request: Request):
    u = require(request)
    body = await request.json()
    api_key = body.get("api_key") or ""
    purpose = body.get("purpose") or "chat"
    if not api_key:
        # key 留空 = 测试已保存的配置（base_url/model 仍取表单当前值）
        stored = (auth.get_user_llm(u["id"]) or {}).get(purpose) or {}
        api_key = stored.get("key", "")
        if not api_key:
            return {"ok": False, "message": "未保存任何 key（先在下方填写并保存，或输入 key 再测试）"}
    base_url = (body.get("base_url") or "").strip()
    if u["role"] != "admin" and base_url:
        # SSRF 读回显堵漏：member 可让服务器向任意 URL POST 并回显响应体
        # （127.0.0.1:8000/9997、网关 8801/8802 等）。admin 放行（可指本机 xinference）。
        _assert_public_url(base_url)
    ok, msg = test_connection(base_url, api_key,
                              body.get("model", ""), body.get("api_type", "openai"))
    return {"ok": ok, "message": msg}


# ---------------- 论文导入 ----------------
def _quota_overrides(user_id: int) -> dict:
    row = db.one("SELECT overrides FROM user_quotas WHERE user_id=?", (user_id,))
    return json.loads(row["overrides"]) if row and row["overrides"] else {}


# 活跃任务状态字面量（原散落 12 处，语义改动时是隐患点）
_ACTIVE_JOBS = "('queued','pending_gate','running')"
# 每日解析配额的计数口径：在途 + 今日已完成
_PARSE_COUNTED = "('queued','pending_gate','running','done')"


def _daily_parse_limit(is_admin: bool, overrides: dict) -> int:
    """今日解析上限：admin 用全站上限，member 用个人覆盖或全局默认。"""
    limit = overrides.get("daily_parse_papers")
    if is_admin:
        limit = config.get("limits", "global_daily_parse")
    elif limit is None:
        limit = config.get("limits", "daily_parse_papers")
    return int(limit)


def _parse_used_today(user_id: int) -> int:
    """今日解析计数（_check_daily_quota 与 /api/me/quota 同口径共用）。"""
    return db.one(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND job_type='parse' "
        f"AND status IN {_PARSE_COUNTED} "
        "AND date(created_at)=date('now')",
        (user_id,),
    )["n"]


def _disk_used(owner_id: int) -> int:
    return db.one("SELECT COALESCE(SUM(file_size),0) AS b FROM papers "
                  "WHERE owner_id=? AND deleted_at IS NULL", (owner_id,))["b"]


def _tokens_30d(user_id: int) -> int:
    return db.one("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS t FROM llm_calls "
                  "WHERE user_id=? AND created_at>=date('now','-30 day')", (user_id,))["t"]


def _check_daily_quota(user_id: int, is_admin: bool, overrides: dict) -> None:
    limit = _daily_parse_limit(is_admin, overrides)
    if _parse_used_today(user_id) >= limit:
        raise HTTPException(429, f"今日解析已达上限 {limit} 篇")


def _enforce_parse_quota(u: dict) -> dict:
    """论文创建入口共用的配额闸（6 处）：取 overrides + 校验每日解析上限。"""
    overrides = _quota_overrides(u["id"])
    _check_daily_quota(u["id"], u["role"] == "admin", overrides)
    return overrides


def _get_paper_or_404(paper_id: str, u: dict):
    """取论文行 + 404 + 可见性校验（同构模式；软删行同报 404）。"""
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    return p


@app.post("/api/papers/upload")
async def upload_papers(request: Request, files: list[UploadFile]):
    u = require(request)
    is_admin = u["role"] == "admin"
    overrides = _enforce_parse_quota(u)

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
        _safe_collection(u, collection_id)   # 归属校验（此前只验存在——member 可挂进他人库）
    else:
        collection_id = get_or_create_default_collection(u["id"])   # 未选库 → 默认文献库
    batch = len(files) > 3  # >3 篇视为批量 → background

    results = []
    flt = _get_parse_filter(u["id"])
    for f in files:
        fname = f.filename or "untitled"
        # 解析过滤器·文件名排除（llm4z 式：逗号子串或 /正则/）——命中不入库
        hit = _filter_name_hit(fname, flt.get("exclude") or "")
        if hit:
            results.append({"name": fname, "status": "rejected",
                            "reason": f"命中解析过滤规则「{hit}」，未上传（可在上传弹层调整规则）"})
            continue
        data = await f.read()
        try:
            pages, _kind = ingest.preflight_doc(data, fname, is_admin=is_admin, overrides=overrides)
        except ingest.PreflightError as e:
            results.append({"name": fname, "status": "rejected", "reason": str(e)})
            continue
        # 解析过滤器·页数上限：入库但不自动解析（parse_status='skipped'，手动重解析可绕过）
        max_pages = int(flt.get("max_pages") or 0)
        over_limit = bool(max_pages and pages and pages > max_pages)
        file_hash = ingest.sha256_bytes(data)
        paper_id, dup = ingest.create_paper(
            u["id"], file_hash, pages, len(data), visibility, f.filename or "untitled")
        if dup:
            # 多对多：内容已在库（别的库）→ 复用记录并挂进当前目标库，不拒绝
            linked = ingest.attach_to_collection(paper_id, collection_id)
            results.append({"name": f.filename, "status": "duplicate", "paper_id": paper_id,
                            "linked": linked})
            continue
        ingest.attach_to_collection(paper_id, collection_id)
        ingest.store_pdf(paper_id, data, f.filename or "original.pdf")
        if over_limit:
            with db.write() as c:
                c.execute("UPDATE papers SET parse_status='skipped' WHERE id=?", (paper_id,))
            results.append({"name": fname, "status": "skipped", "paper_id": paper_id,
                            "reason": f"{pages} 页超过上限 {max_pages}，已入库但未自动解析"})
            continue
        tier = "standard"   # （max_tier 死配置已删——原条件两分支同值，恒 standard）
        scheduler.enqueue(
            u["id"], "parse", paper_id,
            {"tier": tier, "original_name": f.filename, "visibility": visibility},
            priority="background" if batch else "interactive",
        )
        results.append({"name": fname, "status": "queued", "paper_id": paper_id})
    ok_n = sum(1 for r in results if r["status"] == "ok")
    if ok_n or any(r["status"] == "duplicate" for r in results):
        audit(u["id"], "upload",
              f"{ok_n} 入库 / {sum(1 for r in results if r['status']=='duplicate')} 重复"
              f" / {sum(1 for r in results if r['status']=='rejected')} 拒收"
              + (f" → {collection_id[:12]}" if collection_id else ""))
    return {"results": results}


def _get_parse_filter(user_id: int) -> dict:
    row = db.one("SELECT value FROM settings WHERE key=?", (f"parse_filter:{user_id}",))
    try:
        d = json.loads(row["value"]) if row else {}
    except Exception:  # noqa: BLE001
        d = {}
    return d if isinstance(d, dict) else {}


def _filter_name_hit(fname: str, rule: str) -> str:
    """文件名命中排除规则则返回命中的规则文本，否则 ''。"""
    rule = (rule or "").strip()
    if not rule:
        return ""
    low = fname.lower()
    for item in rule.split(","):
        item = item.strip()
        if not item:
            continue
        if len(item) > 2 and item.startswith("/") and item.endswith("/"):
            try:
                if re.search(item[1:-1], fname, re.I):
                    return item
            except re.error:
                continue
        elif item.lower() in low:
            return item
    return ""


@app.get("/api/settings/parse-filter")
def get_parse_filter(u: dict = Depends(require)):
    d = _get_parse_filter(u["id"])
    return {"max_pages": int(d.get("max_pages") or 100), "exclude": d.get("exclude") or ""}


@app.put("/api/settings/parse-filter")
async def set_parse_filter(request: Request):
    u = require(request)
    body = await request.json()
    d = {"max_pages": max(0, min(2000, int(body.get("max_pages") or 0))),
         "exclude": str(body.get("exclude") or "")[:500]}
    with db.write() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (f"parse_filter:{u['id']}", json.dumps(d)))
    return {"ok": True, **d}


def _with_collection_ids(row) -> dict:
    """json_group_array 返回 JSON 字符串 → 解析为数组（sqlite 无数组类型）。"""
    row = dict(row)
    v = row.get("collection_ids")
    if isinstance(v, str):
        try:
            row["collection_ids"] = json.loads(v)
        except ValueError:
            row["collection_ids"] = []
    return row


@app.get("/api/papers")
def list_papers(q: str = "", status: str = "", trash: int = 0,
                collection_id: str = "", page: int = 0, page_size: int = 0, all: int = 0, u: dict = Depends(require)):
    is_admin = u["role"] == "admin"
    vis = "" if is_admin else " AND (visibility='shared' OR owner_id=?)"
    args: list[Any] = [] if is_admin else [u["id"]]
    if q:
        vis += " AND (title LIKE ? OR authors LIKE ?)"
        args.extend([f"%{q}%", f"%{q}%"])
        # 全文回退：方法名/正文词不在 title/authors——此前文库管理搜索框搜「方法名」必败
        # （侧栏 q≥2 字符走 FTS，此处永不走——同一系统两套语义）。FTS 命中 → id 并入。
        try:
            from core.db import fts_query
            fts_ids = [r["paper_id"] for r in db.all(
                "SELECT paper_id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 50",
                (fts_query(q),))]
            if fts_ids:
                ph = ",".join("?" * len(fts_ids))
                vis += f" OR p.id IN ({ph})"
                args.extend(fts_ids)
        except Exception:  # noqa: BLE001 —— FTS 异常退回标题/作者 LIKE
            pass
    if status:
        vis += " AND parse_status=?"
        args.append(status)
    if collection_id == "none":
        vis += " AND NOT EXISTS(SELECT 1 FROM paper_collections pc WHERE pc.paper_id=p.id)"
    elif collection_id:
        ids = [x for x in collection_id.split(",") if x]
        vis += (f" AND EXISTS(SELECT 1 FROM paper_collections pc WHERE pc.paper_id=p.id "
                f"AND pc.collection_id IN ({','.join('?' * len(ids))}))")
        args.extend(ids)
    cond = "deleted_at IS NULL" if not trash else "deleted_at IS NOT NULL"
    limit = max(1, min(500, page_size or 500))
    offset = max(0, (page - 1)) * limit if page else 0
    # 列表裁剪：abstract/keywords/file_hash 前端列表不用（详情页返回），
    # 89 篇 × abstract 1-2KB ≈ 90% 传输浪费；owner_name 供 shared 论文归属标识
    sel = (f"SELECT p.id,p.owner_id,p.visibility,p.title,p.authors,p.year,p.page_count,"
           f"p.file_size,p.parse_status,p.journal,p.created_at,p.deleted_at,"
           f"u.username AS owner_name,"
           f"(SELECT json_group_array(pc.collection_id) FROM paper_collections pc "
           f"WHERE pc.paper_id=p.id) AS collection_ids "
           f"FROM papers p LEFT JOIN users u ON u.id=p.owner_id "
           f"WHERE {cond}{vis} ORDER BY p.created_at DESC")
    if all:
        # 范围内全部 id（跨页「全选」用；不分页）
        rows = db.all(sel, tuple(args))
        return {"papers": [_with_collection_ids(r) for r in rows], "page": 1, "has_more": False,
                "total": len(rows)}
    rows = db.all(sel + f" LIMIT {limit} OFFSET {offset}", tuple(args))
    total = db.one(f"SELECT COUNT(*) AS n FROM papers p WHERE {cond}{vis}", tuple(args))["n"]
    return {"papers": [_with_collection_ids(r) for r in rows], "page": page, "has_more": len(rows) == limit,
            "total": total}


@app.get("/api/papers/{paper_id}")
def paper_detail(paper_id: str, offset: int = 0, limit: int = 0, u: dict = Depends(require)):
    """论文详情 + 解析块（分页：大论文首屏只取需要的量，滚动再拉）。

    limit=0 表示不分页（兼容旧调用）；前端用 limit 做首屏 + 增量加载。
    """
    p = db.one(
        "SELECT p.*, u.username AS owner_name, "
        "(SELECT json_group_array(pc.collection_id) FROM paper_collections pc "
        "WHERE pc.paper_id=p.id) AS collection_ids "
        "FROM papers p LEFT JOIN users u ON u.id=p.owner_id WHERE p.id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")   # 判空必须先于 dict() 转换（dict(None) 曾 500）
    p = _with_collection_ids(dict(p))
    _require_visible(u, p)
    # SQL 分页（分页时 total 用 COUNT 单独取，块只读所需行——原先全量读再 Python 切片）
    if limit:
        blocks = ingest.latest_blocks(paper_id, offset=offset, limit=limit)
        total = _blocks_count(paper_id)
    else:
        blocks = ingest.latest_blocks(paper_id)
        total = len(blocks)
    return {"paper": dict(p), "blocks": [dict(b) for b in blocks],
            "total": total, "offset": offset, "limit": limit}


def _blocks_count(paper_id: str) -> int:
    run = latest_run(paper_id)
    if run is None:
        return 0
    return db.one("SELECT COUNT(*) AS n FROM blocks WHERE parse_run_id=?", (run["id"],))["n"]


def _require_visible(u: dict, paper) -> None:
    if paper["visibility"] == "private" and paper["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "无权访问该论文")


def _require_owner(u: dict, paper) -> None:
    """写操作（重解析/取消任务/改元数据/重建索引）仅属主或 admin 可执行。"""
    if paper["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "仅论文所有者或管理员可执行此操作")


def new_batch_id() -> str:
    return uuid.uuid4().hex[:12]


def latest_run(paper_id: str):
    """该论文最新的 done 解析 run（7 处同款查询的公共件）。"""
    return db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                  "ORDER BY created_at DESC LIMIT 1", (paper_id,))


def owner_scope(u: dict, col: str = "user_id", placeholder: bool = True):
    """admin 看全站，member 限自己——返回 (SQL 片段, 参数元组)；placeholder=False 时内联整型。"""
    if u["role"] == "admin":
        return ("", ()) if placeholder else ""
    if placeholder:
        return (f" AND {col}=?", (u["id"],))
    return f" AND {col}={int(u['id'])}"


def _own_paper_or_404(u: dict, paper_id: str, write: bool = False):
    """取论文行 + 404 + （write=True 时）属主校验 / 否则可见性校验。"""
    p = _get_paper_or_404(paper_id, u)
    if write:
        _require_owner(u, p)
    else:
        _require_visible(u, p)
    return p


@app.get("/api/papers/{paper_id}/pdf")
def paper_pdf(paper_id: str, u: dict = Depends(require)):
    p = _get_paper_or_404(paper_id, u)
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


@app.get("/api/papers/{paper_id}/images/{name}")
def paper_image(paper_id: str, name: str, u: dict = Depends(require)):
    p = _get_paper_or_404(paper_id, u)
    base = (ingest.PAPERS_DIR / paper_id / "parse").resolve()
    matches = sorted(base.glob(f"*/images/{name}"))
    if not matches or not str(matches[0].resolve()).startswith(str(base)):
        raise HTTPException(404, "图片不存在")
    return FileResponse(matches[0])


# ---------------- 删除/回收站 ----------------
@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str, u: dict = Depends(require)):
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or p["deleted_at"]:
        raise HTTPException(404, "论文不存在")
    if p["visibility"] == "shared" and u["role"] != "admin":
        raise HTTPException(403, "共享论文仅管理员可删除")
    if p["visibility"] == "private" and p["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能删除自己的私人论文")
    # 取消在途任务
    for j in db.all(f"SELECT * FROM jobs WHERE paper_id=? AND status IN {_ACTIVE_JOBS}", (paper_id,)):
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
def restore_paper(paper_id: str, u: dict = Depends(require)):
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    if p is None or not p["deleted_at"]:
        raise HTTPException(404, "不在回收站")
    if u["role"] != "admin" and p["owner_id"] != u["id"]:
        raise HTTPException(403, "无权恢复")
    from core.ingest import restore_clash
    clash = restore_clash(paper_id)
    if clash:
        raise HTTPException(409, f"库中已有相同内容的论文《{(clash['title'] or clash['id'])[:40]}》"
                                 f"——恢复会造成重复，请先处理重复再恢复")
    with db.write() as c:
        c.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", (paper_id,))
    # 重建 FTS 索引
    blocks = ingest.latest_blocks(paper_id)
    if blocks:
        run = blocks[0]["parse_run_id"]
        retrieval.build_chunks(paper_id, run, blocks)
    audit(u["id"], "restore-paper", p["title"])
    return {"ok": True}


# ---------------- 任务中心 ----------------
@app.get("/api/jobs")
def list_jobs(status: str = "", job_type: str = "",
              batch_id: str = "", limit: int = 100, u: dict = Depends(require)):
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
    # 列裁剪：payload（synthesis 任务可达数 KB）与 remote_task_id 前端不用；
    # synthesis 任务把 synthesis_id 从 payload 提取为独立字段（前端渲染综述行用）
    rows = db.all(
        "SELECT j.id, j.user_id, j.job_type, j.paper_id, j.batch_id, j.priority, j.status, "
        "j.progress_done, j.progress_total, j.error, j.created_at, j.updated_at, "
        "u.username, p.title, json_extract(j.payload, '$.synthesis_id') AS synthesis_id "
        "FROM jobs j LEFT JOIN users u ON u.id=j.user_id "
        "LEFT JOIN papers p ON p.id=j.paper_id "
        f"WHERE 1=1{cond} ORDER BY j.updated_at DESC LIMIT {int(limit)}",
        tuple(args),
    )
    return {"jobs": [dict(r) for r in rows]}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int, u: dict = Depends(require)):
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
def retry_job(job_id: int, u: dict = Depends(require)):
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


@app.post("/api/jobs/clear-finished")
def clear_finished_jobs(request: Request):
    """清理已结束任务（done/failed/canceled）。

    任务记录是纯日志（进度与结果另有表），但会无限堆积——本项目 342 条 done
    + 11 条 failed 已占满列表且失败记录多来自早已修复的外部源问题，
    留着只是噪音。清理后不影响任何论文/综述数据。
    scope=failed 只清失败与取消（保留成功记录，便于回看做过什么）。
    """
    u = require(request)
    scope = (request.query_params.get("scope") or "all").lower()
    conds = ["status IN ('done','failed','canceled')"] if scope == "all" else \
             ["status IN ('failed','canceled')"]
    args: list = []
    if u["role"] != "admin":
        conds.append("user_id=?")
        args.append(u["id"])
    with db.write() as c:
        n = c.execute("DELETE FROM jobs WHERE " + " AND ".join(conds), tuple(args)).rowcount
    audit(u["id"], "clear-jobs", f"{scope}:{n}")
    return {"ok": True, "cleared": n}


@app.get("/api/queue/{job_type}")
def queue_state(job_type: str, request: Request):
    require(request)
    return {"paused": job_type in scheduler._paused_types}


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
    batch_id = new_batch_id()
    papers = _batch_papers(u, ids)
    queued, skipped = [], []

    if action == "translate":
        for pid, _p in papers:
            in_flight = db.one(
                "SELECT id FROM jobs WHERE paper_id=? AND job_type='translate' "
                f"AND status IN {_ACTIVE_JOBS}", (pid,))
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
def list_batches(limit: int = 20, u: dict = Depends(require)):
    """批次汇总（批量中心进度面板）：前端按 active 分「进行中 / 最近完成」两组展示。"""
    scope = owner_scope(u, placeholder=False)
    rows = db.all(
        "SELECT batch_id, MIN(job_type) AS job_type, COUNT(*) AS total, "
        "SUM(status='done') AS done, SUM(status='failed') AS failed, "
        "SUM(status='canceled') AS canceled, "
        f"SUM(status IN {_ACTIVE_JOBS}) AS active, "
        "MIN(created_at) AS started_at, MAX(updated_at) AS updated_at "
        f"FROM jobs WHERE batch_id IS NOT NULL AND batch_id!=''{scope} "
        f"GROUP BY batch_id ORDER BY MAX(updated_at) DESC LIMIT {int(limit)}")
    return {"batches": [dict(r) for r in rows]}


# ---------------- 综述流水线（批量中心核心卡） ----------------

@app.post("/api/synthesize/estimate")
async def synthesize_estimate(request: Request):
    """综述成本预估：预计 LLM 调用数（缺导读逐篇补齐 + 组内比对 + 跨组综合）
    + 费用预估（按用户历史实际均摊单价 × 调用数——用户真正关心的是花多少钱）。"""
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
    from core import costing
    cost = costing.synth_cost_estimate(u["id"], est["calls"])
    return {"valid": len(est["valid"]), "missing_summaries": est["missing_summaries"],
            "groups": est["groups"], "calls": est["calls"],
            "no_parse": est["no_parse"], "cost": cost}


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
    # survey-writer 参数：axis=组织轴（quick 可空）、tier 篇幅档、style 引用式、purpose 用途
    params = body.get("params") or {}
    tier = params.get("tier") if params.get("tier") in ("quick", "standard", "deep") else "quick"
    style = params.get("style") if params.get("style") in ("author_year", "numeric") else "author_year"
    axis = (params.get("axis") or "").strip()[:200]
    if tier in ("standard", "deep") and not axis:
        raise HTTPException(400, "standard/deep 档需要填写组织轴（综述围绕的主线问题）")
    pr = {"tier": tier, "style": style, "purpose": (params.get("purpose") or "note")[:40],
          "axis": axis}
    calls = est["calls"] + ({"standard": 8, "deep": 14}.get(tier, 0))
    est = {**est, "calls": calls}   # syntheses.progress_total 用调整后调用数
    batch_id = new_batch_id()
    scheduler.enqueue(u["id"], "synthesis", None,
                      {"synthesis_id": sid, "batch_id": batch_id, "params": pr},
                      priority="background", progress_total=calls)
    audit(u["id"], "synthesize", f"{len(est['valid'])} 篇 tier={tier} batch={batch_id}")
    return {"synthesis_id": sid, "batch_id": batch_id, "estimate": {**est, "calls": calls},
            "params": pr}


@app.get("/api/syntheses")
def list_syntheses(limit: int = 20, u: dict = Depends(require)):
    scope = "" if u["role"] == "admin" else " WHERE s.user_id=" + str(int(u["id"]))
    rows = db.all(
        "SELECT s.id, s.title, s.status, s.stage, s.progress_done, s.progress_total, "
        "s.error, s.model, s.created_at, s.updated_at, "
        "json_array_length(s.paper_ids) AS papers, "
        # 首篇论文标题——综述标题常是泛称（「文献综述」），列表需要能看出是关于什么的
        "(SELECT p.title FROM papers p WHERE p.id = json_extract(s.paper_ids, '$[0]')) AS first_paper "
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
def get_synthesis(sid: str, u: dict = Depends(require)):
    row = _own_synthesis(u, sid)
    d = dict(row)
    # 大列不下发：cluster_data 仅 rewrite 服务端用（直读库）；matrix_csv 有独立 export 端点
    d.pop("cluster_data", None)
    d.pop("matrix_csv", None)
    return {"synthesis": d}


@app.post("/api/syntheses/{sid}/rewrite")
async def rewrite_synthesis(sid: str, request: Request):
    """换框架重写：复用已存的组比对与键表（零重复消化成本），只重跑章节化+校验。"""
    u = require(request)
    row = _own_synthesis(u, sid)
    body = await request.json()
    try:
        pick = int(body.get("framework") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "framework 必须是数字")
    import json as _j
    try:
        fws = _j.loads(row["frameworks"] or "[]")
    except Exception:  # noqa: BLE001
        fws = None
    if not fws or not (0 <= pick < len(fws.get("frameworks") or [])):
        raise HTTPException(400, "该综述没有可换的候选框架")
    if not row["cluster_data"]:
        raise HTTPException(400, "缺少缓存组数据，无法低成本重写（请重新发起综述）")
    try:
        pr = _j.loads(row["params"] or "{}")
    except Exception:  # noqa: BLE001
        pr = {}
    pr = {**pr, "framework": pick, "rewrite": True}
    tier = pr.get("tier") or "quick"
    calls = {"quick": 3, "standard": 9, "deep": 15}.get(tier, 3)
    with db.write() as c:
        c.execute("UPDATE syntheses SET status='running', error=NULL, progress_done=0, "
                  "progress_total=?, updated_at=datetime('now') WHERE id=?", (calls, sid))
    batch_id = new_batch_id()
    scheduler.enqueue(u["id"], "synthesis", None,
                      {"synthesis_id": sid, "batch_id": batch_id, "params": pr,
                       "topic": pr.get("axis") or ""},
                      priority="background", progress_total=calls)
    audit(u["id"], "synthesis-rewrite", f"{sid} → 框架{pick}")
    return {"ok": True, "framework": pick, "calls": calls}


@app.delete("/api/syntheses/{sid}")
def delete_synthesis(sid: str, u: dict = Depends(require)):
    row = _own_synthesis(u, sid)
    if row["status"] == "running":   # 在途：连带取消队列任务
        for j in db.all(f"SELECT * FROM jobs WHERE payload LIKE ? AND status IN {_ACTIVE_JOBS}",
                        (f'%{sid}%',)):
            with db.write() as c:
                c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
    with db.write() as c:
        c.execute("DELETE FROM syntheses WHERE id=?", (sid,))
    return {"ok": True}


@app.get("/api/syntheses/{sid}/progress")
def synthesis_progress(sid: str, u: dict = Depends(require)):
    """进度轮询专用（仅六字段）——综述运行期 2~6s 一拉，
    detail 全量行含 report_md/evidence/cite_table（0.2~0.7MB），轮询用它纯属浪费。"""
    row = db.one("SELECT id,user_id FROM syntheses WHERE id=?", (sid,))
    if row is None:
        raise HTTPException(404, "综述不存在")
    if u["role"] != "admin" and row["user_id"] != u["id"]:
        raise HTTPException(403, "无权访问他人综述")
    r = db.one("SELECT status,stage,progress_done,progress_total,error FROM syntheses WHERE id=?", (sid,))
    return {"synthesis": dict(r)}


@app.get("/api/syntheses/{sid}/export")
def export_synthesis(sid: str, fmt: str = "md", u: dict = Depends(require)):
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


@app.get("/api/jobs/count")
def jobs_count(u: dict = Depends(require)):
    """badge 轮询专用：只回 {active, mcp_pending} 两个数字。
    原 ?limit=200 每次拉全量（~70KB）只为数个数，空闲单页 ≈8.6MB/h。"""
    scope, args = owner_scope(u)
    n = db.one(f"SELECT COUNT(*) AS n FROM jobs WHERE status IN "
               f"{ _ACTIVE_JOBS }{scope}", args)["n"]
    pend = 0
    try:
        from core import mcpserver
        pend = len(mcpserver.pending_for(u["id"]))
    except Exception:  # noqa: BLE001
        pass
    return {"active": n, "mcp_pending": pend}


@app.get("/api/jobs/stream")
def jobs_stream(u: dict = Depends(require)):
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
def usage(u: dict = Depends(require)):
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


@app.get("/api/me/quota")
def me_quota(u: dict = Depends(require)):
    """个人用量自助面板：今日解析配额 / 磁盘占用 / 近 30 天 token。

    磁盘为「展示+软提醒」口径（超限由前端警告，不在后端硬拦）。
    """
    overrides = _quota_overrides(u["id"])
    from core import costing
    cost = costing.month_cost(u["id"], overrides)
    prev = costing.prev_month_cost(u["id"], overrides)
    budget = costing.budget_of(overrides, u["id"])
    return {"parse_used": _parse_used_today(u["id"]),
            "parse_limit": _daily_parse_limit(u["role"] == "admin", overrides),
            "disk_used_bytes": _disk_used(u["id"]),
            "disk_limit_gb": overrides.get("max_disk_gb") or config.get("limits", "disk_quota_gb"),
            # 花费（按 model×purpose 折算；未收录模型的调用不计费）
            "month_cost": cost["total"], "prev_month_cost": prev,
            "cost_by_purpose": cost["by_purpose"], "cost_priced": cost["priced"],
            "month_calls": cost["calls"],
            "budget": budget,
            "budget_pct": round(min(100, cost["total"] / budget * 100), 1) if budget else None}


@app.put("/api/me/budget")
async def set_my_budget(request: Request):
    """设置月预算（元）与自定义单价覆盖（各家 OpenAI 兼容厂商定价不同）。
    budget=0 表示不设闸（默认）。"""
    u = require(request)
    body = await request.json()
    ov = _quota_overrides(u["id"])
    try:
        budget = float(body.get("budget") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "预算金额格式错误")
    if budget < 0:
        raise HTTPException(400, "预算不能为负")
    # 成员自设预算存 settings（admin 的硬上限另存 overrides，生效时取更严者）
    with db.write() as c:
        if budget:
            c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                      "ON CONFLICT(key) DO UPDATE SET value=?", (f"budget:{u['id']}", str(budget), str(budget)))
        else:
            c.execute("DELETE FROM settings WHERE key=?", (f"budget:{u['id']}",))
    pricing = body.get("pricing")
    if isinstance(pricing, dict) and pricing:
        ov["pricing"] = {k: {"prompt": float(v.get("prompt") or 0),
                             "completion": float(v.get("completion") or 0)}
                         for k, v in pricing.items() if isinstance(v, dict)}
    elif pricing is not None:
        ov.pop("pricing", None)
    with db.write() as c:
        c.execute("INSERT INTO user_quotas(user_id,overrides) VALUES(?,?) "
                  "ON CONFLICT(user_id) DO UPDATE SET overrides=?",
                  (u["id"], json.dumps(ov), json.dumps(ov)))
    return {"ok": True, "budget": budget, "pricing": ov.get("pricing", {})}


# ---------------- 管理 ----------------
@app.post("/api/admin/invite")
def create_invite(days: int = 7, admin: dict = Depends(require_admin)):
    code = auth.create_invite(admin["id"], days)
    audit(admin["id"], "create_invite", code)
    return {"code": code, "expires_in_days": days}


@app.get("/api/admin/users")
def admin_users(request: Request):
    require_admin(request)
    rows = db.all(
        "SELECT u.id, u.username, u.role, u.disabled, u.created_at, q.overrides, "
        "(SELECT COUNT(*) FROM papers p WHERE p.owner_id=u.id AND p.deleted_at IS NULL) AS papers, "
        "(SELECT COALESCE(SUM(p.file_size),0) FROM papers p WHERE p.owner_id=u.id AND p.deleted_at IS NULL) AS disk_used "
        "FROM users u LEFT JOIN user_quotas q ON q.user_id=u.id ORDER BY u.id")
    # 本月花费按模型单价在 Python 层折算（SQL 无法按 pricing 表加权）
    from core import costing
    site = costing.site_cost()
    out = []
    for r in rows:
        d = dict(r)
        d["month_cost"] = site.get(d["id"], 0.0)
        out.append(d)
    return {"users": out}


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, admin: dict = Depends(require_admin)):
    """admin 重置用户密码：生成一次性临时密码返回（用户登录后自行修改）。"""
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
def admin_disable_user(user_id: int, admin: dict = Depends(require_admin)):
    """禁用用户：无法登录，已有会话全部吊销。不能禁用自己。"""
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
def admin_enable_user(user_id: int, admin: dict = Depends(require_admin)):
    row = db.one("SELECT username FROM users WHERE id=?", (user_id,))
    if row is None:
        raise HTTPException(404, "用户不存在")
    with db.write() as c:
        c.execute("UPDATE users SET disabled=0 WHERE id=?", (user_id,))
    audit(admin["id"], "enable-user", row["username"])
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: dict = Depends(require_admin)):
    """软删除用户：禁用 + 匿名化用户名（保留其论文归属与统计，可随时恢复 disabled=0）。"""
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
    # 整数/十六进制/八进制 IP 形式（http://2130706433/ 解析回 127.0.0.1）——先拦
    if re.fullmatch(r"\d{8,}|0x[0-9a-f]+|[0-7]{6,}", host):
        raise HTTPException(400, "不允许的地址形式")
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
    """URL 直接导入：先本地落盘（PDF 预览/页数可用），失败退回 MinerU 代抓。"""
    u = require(request)
    body = await request.json()
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "无效 URL")
    _assert_public_url(url)
    _enforce_parse_quota(u)
    cid = body.get("collection_id") or get_or_create_default_collection(u["id"])
    _safe_collection(u, cid)   # 归属校验（此前零校验：他人库可写、伪 id 落幽灵论文）
    from core.urlimport import import_paper_from_url
    import anyio
    import functools
    # 远程下载（可能数十秒）+ 落库——严禁在事件循环上跑
    r = await anyio.to_thread.run_sync(functools.partial(
        import_paper_from_url,
        u["id"], url,
        visibility=body.get("visibility", "shared"),
        collection_id=cid,
        priority="interactive",
        is_admin=u["role"] == "admin", overrides=_quota_overrides(u["id"])))
    audit(u["id"], "import-url", f"{r['status']} → {cid[:12]}")
    return {"paper_id": r["paper_id"], "status": r["status"]}


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
def list_collections(u: dict = Depends(require)):
    vis = "" if u["role"] == "admin" else " AND (p.visibility='shared' OR p.owner_id=?)"
    args = () if u["role"] == "admin" else (u["id"],)
    total = db.one(
        f"SELECT COUNT(*) AS n FROM papers p WHERE p.deleted_at IS NULL{vis}", args)["n"]
    # 多对多：每库计数经关联表 JOIN（一篇挂 N 库 → 每个库各计一次）
    rows = db.all(
        "SELECT c.id, c.name, c.parent_id, (SELECT COUNT(*) FROM paper_collections pc "
        "JOIN papers p ON p.id=pc.paper_id WHERE pc.collection_id=c.id "
        "AND p.deleted_at IS NULL AND (p.visibility='shared' OR p.owner_id=?)) AS papers "
        "FROM collections c WHERE c.owner_id=? ORDER BY c.created_at",
        (u["id"], u["id"]),
    )
    nodes = [dict(r) for r in rows]
    # 未分库：无任何挂链的论文（多对多下不存在悬挂引用——FK CASCADE 已兜底）
    unassigned = db.one(
        f"SELECT COUNT(*) AS n FROM papers p WHERE p.deleted_at IS NULL "
        f"AND NOT EXISTS(SELECT 1 FROM paper_collections pc WHERE pc.paper_id=p.id){vis}",
        args)["n"]
    # 他人库中的共享论文（我的库列表不含他人库 → 同样会造成数字差额）
    shared_rows = db.all(
        "SELECT c.id, c.name, c.owner_id, COUNT(DISTINCT p.id) AS n FROM papers p "
        "JOIN paper_collections pc ON pc.paper_id=p.id "
        "JOIN collections c ON c.id = pc.collection_id "
        "WHERE p.deleted_at IS NULL AND c.owner_id<>? AND (p.visibility='shared' OR p.owner_id=?) "
        "GROUP BY c.id", (u["id"], u["id"]))
    shared_libs = [{"id": r["id"], "name": r["name"], "owner_id": r["owner_id"], "papers": r["n"],
                    "shared": True} for r in shared_rows]
    # 汇总：父库计数含全部子孙；子树 DISTINCT 去重——同一篇挂父库+子库只计一次
    children = {}
    for n in nodes:
        children.setdefault(n["parent_id"], []).append(n)
    def subtree_ids(nid):
        out = []
        for ch in children.get(nid, []):
            out.append(ch["id"])
            out.extend(subtree_ids(ch["id"]))
        return out
    def distinct_count(ids):
        if not ids:
            return 0
        ph = ",".join("?" * len(ids))
        q = (f"SELECT COUNT(DISTINCT p.id) AS n FROM papers p "
             f"JOIN paper_collections pc ON pc.paper_id=p.id WHERE pc.collection_id IN ({ph}) "
             f"AND p.deleted_at IS NULL")
        q += " AND (p.visibility='shared' OR p.owner_id=?)" if u["role"] != "admin" else ""
        return db.one(q, tuple(ids) + args)["n"]
    roots = [n for n in nodes if not n["parent_id"]]
    for n in nodes:
        n["papers_total"] = distinct_count([n["id"]] + subtree_ids(n["id"]))
    return {"total": total, "collections": nodes,
            "unassigned": unassigned, "shared_libs": shared_libs}


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
def delete_collection(cid: str, u: dict = Depends(require)):
    """删除文献库（整个子树）。语义见 core/libs.delete_subtree：
    论文移出该库；摘后无主且属于自己的进回收站；他人的论文只摘链。"""
    from core.libs import delete_subtree
    r = delete_subtree(cid, u["id"], u["role"] == "admin")
    if not r:
        raise HTTPException(404, "文献库不存在")
    audit(u["id"], "delete-collection",
          f"libs:{r['libs']} trashed:{r['trashed']} unlinked:{r['unlinked']}")
    return r


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
    for field in ("title", "authors", "journal", "year", "doi", "keywords", "abstract",
                  "volume", "issue", "pages"):
        if field in body:
            sets.append(f"{field}=?")
            args.append(str(body[field])[:3000])
    if sets:
        with db.write() as c:
            c.execute(f"UPDATE papers SET {', '.join(sets)} WHERE id=?", (*args, paper_id))
    # 可见性变更 → 向量矩阵缓存按用户 scope 缓存，须立即失效（T5）
    # （挂库变更走 /collections 端点，那里自行失效）
    if "visibility" in body:
        from core.retrieval import invalidate_vec_cache
        invalidate_vec_cache()
    return {"ok": True}


# ---------------- 挂库（多对多）：单篇与批量 ----------------
def _link_change(u: dict, paper_ids: list[str], cid: str, link: bool) -> dict:
    """加入/移出分库的公共实现。校验：论文可见 + 目标库归属（_safe_collection）。"""
    if db.one("SELECT id FROM collections WHERE id=?", (cid,)) is None:
        raise HTTPException(400, "目标文献库不存在")
    _safe_collection(u, cid)
    changed = 0
    for pid in paper_ids:
        p = db.one("SELECT id, owner_id FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is None:
            continue
        if u["role"] != "admin" and p["owner_id"] != u["id"]                 and not db.one("SELECT 1 FROM papers WHERE id=? AND visibility='shared'", (pid,)):
            continue   # 不可见论文跳过（不报错——批量口径）
        with db.write() as c:
            if link:
                cur = c.execute("INSERT OR IGNORE INTO paper_collections(paper_id, collection_id) "
                                "VALUES(?,?)", (pid, cid))
                changed += cur.rowcount
            else:
                cur = c.execute("DELETE FROM paper_collections WHERE paper_id=? AND collection_id=?",
                                (pid, cid))
                changed += cur.rowcount
    if changed:
        from core.retrieval import invalidate_vec_cache
        invalidate_vec_cache()
    return {"ok": True, "changed": changed}


@app.post("/api/papers/batch-link")
async def batch_link_papers(request: Request):
    """批量加入分库（多对多；原「批量移动」的新语义的一半）。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or []) if x]
    cid = body.get("collection_id") or ""
    if not ids or not cid:
        raise HTTPException(400, "paper_ids 与 collection_id 必填")
    return _link_change(u, ids, cid, link=True)


@app.post("/api/papers/batch-unlink")
async def batch_unlink_papers(request: Request):
    """批量从分库移出（论文本体不动；全部库移出后落「未分库」）。"""
    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or []) if x]
    cid = body.get("collection_id") or ""
    if not ids or not cid:
        raise HTTPException(400, "paper_ids 与 collection_id 必填")
    return _link_change(u, ids, cid, link=False)


@app.post("/api/papers/{paper_id}/collections")
async def paper_add_collection(paper_id: str, request: Request):
    """单篇加入分库（详情页 chips）。"""
    u = require(request)
    body = await request.json()
    cid = body.get("collection_id") or ""
    if not cid:
        raise HTTPException(400, "collection_id 必填")
    return _link_change(u, [paper_id], cid, link=True)


@app.delete("/api/papers/{paper_id}/collections/{cid}")
async def paper_remove_collection(paper_id: str, cid: str, request: Request):
    """单篇移出分库（详情页 chips）。"""
    u = require(request)
    return _link_change(u, [paper_id], cid, link=False)


# ---------------- 文库搜索 ----------------
@app.post("/api/search")
async def search_api(request: Request):
    u = require(request)
    body = await request.json()
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "query 必填")
    # retrieval.search 含 embed/rerank 外网同步调用——严禁在事件循环上跑（一处阻塞全站卡）
    import anyio
    import functools
    hits = await anyio.to_thread.run_sync(functools.partial(
        retrieval.search,
        query, user_id=u["id"], is_admin=u["role"] == "admin",
        paper_ids=body.get("paper_ids"), top_k=int(body.get("top_k", 10))))
    return {"hits": hits}


# ---------------- 图表资产（右栏"图表"页签） ----------------
@app.get("/api/papers/{paper_id}/assets")
def paper_assets(paper_id: str, u: dict = Depends(require)):
    """从解析产物提取图表/表格清单：页码、图、题注。"""
    p = _own_paper_or_404(u, paper_id, write=False)
    run = latest_run(paper_id)
    if run is None:
        return {"figures": [], "tables": [], "formulas": []}
    parse_dir = ingest.PAPERS_DIR / paper_id / "parse" / run["id"]
    mf = parse_dir / "middle_json.json"
    if not mf.exists():
        return {"figures": [], "tables": [], "formulas": []}
    import json as _json
    # 物化清单优先：解析完成时已归并好（middle_json 144KB/篇，每次 openPaper 重读+重算归并浪费）
    cached = parse_dir / "assets.json"
    if cached.exists():
        try:
            return _json.loads(cached.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 —— 清单损坏回退现算
            pass
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
    result = {"figures": figures, "tables": tables, "formulas": formulas}
    try:   # 懒物化：算一次写盘，后续请求直接读清单
        cached.write_text(_json.dumps(result, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 —— 只读文件系统等场景静默跳过
        pass
    return result


# ---------------- 文献信息（管理器式） ----------------
@app.get("/api/papers/{paper_id}/references")
def paper_references(paper_id: str, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=False)
    from core.meta import get_references
    return {"references": get_references(paper_id)}


@app.post("/api/papers/{paper_id}/extract-meta")
def extract_meta(paper_id: str, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=False)
    try:
        from core.meta import extract_meta_llm
        data = extract_meta_llm(u["id"], paper_id)
    except NoKeyError as e:
        raise HTTPException(400, str(e))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "meta": data}


@app.get("/api/papers/{paper_id}/notes")
def get_paper_notes(paper_id: str, u: dict = Depends(require)):
    _require_visible(u, _get_paper_or_404(paper_id, u))   # 他人 private 论文的笔记不可读（含存在性探测）
    row = db.one("SELECT importance, tags, notes, updated_at FROM paper_notes "
                 "WHERE user_id=? AND paper_id=?", (u["id"], paper_id))
    return dict(row) if row else {"importance": 0, "tags": "", "notes": ""}


@app.put("/api/papers/{paper_id}/notes")
async def set_paper_notes(paper_id: str, request: Request):
    u = require(request)
    _require_visible(u, _get_paper_or_404(paper_id, u))   # 同上：不可写他人 private 论文的笔记
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


@app.get("/api/chat/sessions/{session_id}/export")
def export_session(session_id: str, u: dict = Depends(require)):
    """对话记录导出 Markdown（含引用与证据页码）。"""
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


@app.post("/api/papers/export-zip")
async def export_papers_zip(request: Request):
    """批量导出 ZIP：多论文 × 多格式，逐篇流式输出。

    此前全内存 BytesIO 组装（50 篇 × 多格式可瞬间吃 1GB+ 内存），改为
    同步生成器 + StreamingResponse：每 4MB 吐一次、内存恒定；且 Starlette
    对同步生成器走 iterate_in_threadpool——zip 组装的 CPU/IO 在线程池，
    不阻塞事件循环。
    """
    import io
    import zipfile
    from urllib.parse import quote

    u = require(request)
    body = await request.json()
    ids = [x for x in (body.get("paper_ids") or [])][:200]
    fmts = [x for x in (body.get("fmts") or [])
            if x in ("pdf", "md", "bilingual_md", "bilingual_pdf", "zh_pdf", "en_pdf", "bibtex")]
    if not ids:
        raise HTTPException(400, "paper_ids 为空")
    if not fmts:
        raise HTTPException(400, "请选择导出内容")

    from core.cite import format_citation
    from core.exporter import _zip_base_name, build_zip

    def _iter_zip():
        skipped = []
        count = 0
        buf = io.BytesIO()
        zf = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
        for pid in ids:
            p = db.one("SELECT * FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
            if p is None:
                skipped.append(f"{pid}: 不存在或已删除")
                continue
            try:
                _require_visible(u, p)
            except HTTPException:
                skipped.append(f"{p['title']}: 无权访问")
                continue
            base = _zip_base_name(dict(p))
            if "bibtex" in fmts:
                zf.writestr(f"{base}/references.bib", format_citation(dict(p), "bibtex"))
                count += 1
            sub = [f for f in fmts if f != "bibtex"]
            if not sub:
                continue
            try:
                data, _name = build_zip(pid, sub)   # 单篇 zip 字节（天然有界）
            except Exception as e:  # noqa: BLE001 —— 单篇失败不拖垮整包
                skipped.append(f"{base}: {str(e)[:120]}")
                continue
            with zipfile.ZipFile(io.BytesIO(data)) as sz:
                for item in sz.infolist():
                    zf.writestr(f"{base}/{item.filename}", sz.read(item.filename))
                    count += 1
            if buf.tell() > 4 * 1024 * 1024:      # 4MB 一冲——内存只保留增量
                zf.close()
                yield buf.getvalue()
                buf = io.BytesIO()
                zf = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
        if skipped:
            zf.writestr("跳过清单.txt", "\n".join(skipped))
        zf.close()
        if count == 0 and not skipped:
            yield b""                              # 全部不可导出：空包由前端提示
        yield buf.getvalue()

    from starlette.responses import StreamingResponse
    return StreamingResponse(_iter_zip(), media_type="application/zip",
                             headers={"Content-Disposition":
                                      'attachment; filename="papers-export.zip"; '
                                      "filename*=UTF-8''" + quote("论文导出.zip")})


# ---------------- 目录批量入库（中文文献落地的关键路径） ----------------
# 场景：知网/万方下载器把整目录文献放在服务器上 → 这里扫描目录批量入库；
#       .caj 自动转 PDF 后走既有 upload→MinerU→索引→导读 管线。
# 安全：只允许 DATA_DIR 之下的子目录（防任意主机文件读取）。
def _safe_import_dir(rel: str) -> Path:
    from core.config import DATA_DIR
    base = (DATA_DIR / "inbox").resolve()
    target = (base / (rel or "")).resolve() if rel else base
    try:
        target.relative_to(base)          # 越界即拒
    except ValueError:
        raise HTTPException(400, "只能导入 inbox/ 下的目录")
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "目录不存在")
    return target


# ---------------- 专题采集任务（可中断可恢复的科研采集流程） ----------------
def _safe_collection(u: dict, cid: str | None) -> str:
    """目标文献库归属校验（不能把论文塞进他人库）；未指定 → 默认库。"""
    if not cid:
        return get_or_create_default_collection(u["id"])
    row = db.one("SELECT id, owner_id FROM collections WHERE id=?", (cid,))
    if row is None:
        raise HTTPException(400, "目标文献库不存在")
    if row["owner_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "无权写入他人文献库")
    return cid


def _own_task(u: dict, tid: str):
    from core import acqtask
    t = acqtask.get(tid)
    if t is None:
        raise HTTPException(404, "专题不存在")
    if u["role"] != "admin" and t["user_id"] != u["id"]:
        raise HTTPException(403, "无权访问他人专题")
    return t


@app.get("/api/acq-tasks")
def list_acq_tasks(u: dict = Depends(require)):
    from core import acqtask
    scope, args = owner_scope(u)
    rows = db.all(
        "SELECT id,title,query,site,status,filters,candidates,paper_ids,synthesis_id,error,"
        "created_at,updated_at FROM acq_tasks WHERE 1=1" + scope +
        " ORDER BY updated_at DESC LIMIT 50", args)
    out = []
    for r in rows:
        d = dict(r)
        try:
            cands = json.loads(d.get("candidates") or "[]")
            d["cand_total"] = len(cands)
            d["cand_selected"] = sum(1 for c in cands if c.get("selected"))
            d["cand_done"] = sum(1 for c in cands if c.get("dl_status") == "done")
        except Exception:  # noqa: BLE001
            d["cand_total"] = d["cand_selected"] = d["cand_done"] = 0
        try:
            d["papers"] = len(json.loads(d.get("paper_ids") or "[]"))
        except Exception:  # noqa: BLE001
            d["papers"] = 0
        d.pop("candidates", None)
        out.append(d)
    return {"tasks": out}


@app.post("/api/acq-tasks")
async def create_acq_task(request: Request):
    u = require(request)
    body = await request.json()
    title = (body.get("title") or "").strip()[:120]
    query = (body.get("query") or "").strip()[:300]
    if not query:
        raise HTTPException(400, "query 必填")
    if not title:
        title = query
    from core import acqtask
    tid = acqtask.create(u["id"], title, query, (body.get("site") or "chinaxiv"),
                         body.get("filters") or {})
    return {"id": tid, "task": acqtask.get(tid)}


@app.get("/api/acq-tasks/{tid}")
def get_acq_task(tid: str, u: dict = Depends(require)):
    t = _own_task(u, tid)
    # 附带论文的解析进度（综述前置条件可视化）
    ids = t.get("paper_ids") or []
    if ids:
        marks = ",".join("?" * len(ids))
        rows = db.all(f"SELECT id,title,parse_status FROM papers WHERE id IN ({marks})", tuple(ids))
        t["papers_detail"] = [dict(r) for r in rows]
        t["all_parsed"] = acqtask_ok(ids)
    return {"task": t}


def acqtask_ok(ids: list[str]) -> bool:
    from core import acqtask
    return acqtask.all_parsed(ids)


@app.post("/api/acq-tasks/{tid}/search")
async def search_acq_task(tid: str, request: Request):
    """检索候选（宿主浏览器）。保留已勾选/已下载状态。"""
    u = require(request)
    t = _own_task(u, tid)
    from core import acqtask, acquire
    body = await request.json()
    query = (body.get("query") or t["query"] or "").strip()
    if not query:
        raise HTTPException(400, "query 必填")
    site = body.get("site") or t["site"] or "chinaxiv"
    try:
        items = acquire.search(site, query, 1, min(int(body.get("limit") or 30), 50))
    except ValueError as e:
        acqtask.update(tid, status="failed", error=str(e)[:300])
        raise HTTPException(502, str(e))
    titles = {row[0].lower() for row in db.all("SELECT title FROM papers WHERE deleted_at IS NULL")}
    cands = []
    for it in items:
        cands.append({"title": it.get("title") or "", "authors": it.get("authors") or "",
                      "year": it.get("year") or "", "venue": it.get("venue") or "",
                      "summary": it.get("summary") or "", "pdf_url": it.get("pdf_url") or "",
                      "abs_url": it.get("abs_url") or it.get("url") or "",
                      "doi": it.get("doi") or "", "source": it.get("source") or site,
                      "in_library": (it.get("title") or "").strip().lower() in titles})
    acqtask.set_candidates(tid, cands)
    acqtask.update(tid, query=query, site=site, status="ready", error=None)
    return {"task": acqtask.get(tid)}


@app.put("/api/acq-tasks/{tid}/select")
async def select_acq_task(tid: str, request: Request):
    """保存勾选（前端排卡勾选后调用）。"""
    u = require(request)
    t = _own_task(u, tid)
    body = await request.json()
    urls = set(body.get("pdf_urls") or [])
    from core import acqtask
    cands = t.get("candidates") or []
    for c in cands:
        c["selected"] = c.get("pdf_url") in urls
    acqtask.update(tid, candidates=cands)
    return {"task": acqtask.get(tid)}


@app.post("/api/acq-tasks/{tid}/download")
async def download_acq_task(tid: str, u: dict = Depends(require)):
    """把勾选的候选入队下载（job_type='acquire'）。"""
    t = _own_task(u, tid)
    from core import acqtask
    cands = acqtask.selected_candidates(tid)
    if not cands:
        raise HTTPException(400, "先勾选要下载的文献")
    todo = [c for c in cands if c.get("dl_status") != "done"]
    if not todo:
        raise HTTPException(400, "勾选项都已下载完成")
    acqtask.update(tid, status="downloading", error=None)
    scheduler.enqueue(u["id"], "acquire", None, {"task_id": tid},
                      priority="background", progress_total=len(todo))
    return {"task": acqtask.get(tid), "queued": len(todo)}


@app.post("/api/acq-tasks/{tid}/synthesize")
async def synthesize_acq_task(tid: str, u: dict = Depends(require)):
    """专题 → 综述：论文全部解析完成后可发起（专题名作为研究问题先验注入）。"""
    t = _own_task(u, tid)
    ids = t.get("paper_ids") or []
    from core import acqtask, synthesis
    # 未解析完成（failed/skipped/pending）的剔除而非硬拒——一篇卡死不该锁死整个专题
    ids = [i for i in ids
           if (db.one("SELECT parse_status s FROM papers WHERE id=? AND deleted_at IS NULL", (i,)) or {}).get("s") == "parsed"]
    if len(ids) < 2:
        raise HTTPException(400, "解析完成的论文不足 2 篇（未完成/失败/跳过的已剔除；可先重试解析）")
    # 已有综述：仅当成功完成才复用；失败/进行中的允许重建（否则永久无法重跑）
    if t.get("synthesis_id"):
        prev = db.one("SELECT status FROM syntheses WHERE id=?", (t["synthesis_id"],))
        if prev and prev["status"] == "done":
            return {"synthesis_id": t["synthesis_id"], "reused": True}
    est = synthesis.estimate(ids)
    sid = synthesis.create(u["id"], ids, est)
    with db.write() as c:
        c.execute("UPDATE syntheses SET title=? WHERE id=?",
                  (f"{t['title']}（{len(ids)} 篇）", sid))
    acqtask.update(tid, synthesis_id=sid, status="reviewing")
    batch_id = new_batch_id()
    scheduler.enqueue(u["id"], "synthesis", None,
                      {"synthesis_id": sid, "batch_id": batch_id, "topic": t["title"],
                       "task_id": tid},
                      priority="background", progress_total=est["calls"])
    return {"synthesis_id": sid, "estimate": est}


@app.delete("/api/acq-tasks/{tid}")
def delete_acq_task(tid: str, u: dict = Depends(require)):
    """删除专题：论文保留在文库，但清掉溯源引用（避免悬挂 task id）。"""
    _own_task(u, tid)
    with db.write() as c:
        c.execute("DELETE FROM acq_tasks WHERE id=?", (tid,))
        c.execute("UPDATE papers SET acq_task_id=NULL WHERE acq_task_id=?", (tid,))
    return {"ok": True}


# ---------------- 文献采集（宿主浏览器服务；中文文献获取主路径） ----------------
@app.get("/api/acquire/status")
def acquire_status(request: Request):
    """采集服务可用性（前端置灰/提示用）。"""
    require(request)
    from core import acquire
    return acquire.service_status()


@app.post("/api/acquire/search")
async def acquire_search(request: Request):
    """检索候选（site: cnki|chinaxiv）。走宿主浏览器会话，绕开知网/预印本软封。"""
    require(request)
    body = await request.json()
    site = (body.get("site") or "chinaxiv").strip()
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "query 必填")
    from core import acquire
    try:
        page = int(body.get("page") or 1)
        limit = min(int(body.get("limit") or 20), 50)
    except (TypeError, ValueError):
        raise HTTPException(400, "page/limit 必须是数字")
    try:
        items = acquire.search(site, query, page, limit)
    except ValueError as e:
        raise HTTPException(502, str(e))
    # 已在库的标记（按标题粗匹配，防重复下载）
    titles = {row[0].lower() for row in db.all("SELECT title FROM papers WHERE deleted_at IS NULL")}
    for it in items:
        it["in_library"] = (it.get("title") or "").strip().lower() in titles
    return {"items": items, "site": site}


@app.post("/api/acquire/import")
async def acquire_import(request: Request):
    """下载勾选的候选并入库（复用 upload→MinerU 管线），返回批次号。"""
    u = require(request)
    body = await request.json()
    picks = [x for x in (body.get("items") or []) if isinstance(x, dict)][:30]
    if not picks:
        raise HTTPException(400, "items 为空")
    is_admin = u["role"] == "admin"
    overrides = _enforce_parse_quota(u)   # 与上传链路同款：解析配额不能被绕过
    from core import acquire, caj as caj_mod

    batch_id = new_batch_id()
    queued, skipped = [], []
    for it in picks:
        url = (it.get("pdf_url") or it.get("url") or "").strip()
        title = (it.get("title") or "").strip() or "未命名"
        if not url.startswith(("http://", "https://")):
            skipped.append({"title": title, "reason": "无可下载链接"})
            continue
        try:
            data, ctype, fname = acquire.fetch(url)
        except ValueError as e:
            skipped.append({"title": title, "reason": str(e)[:150]})
            continue
        if not data:
            skipped.append({"title": title, "reason": "下载内容为空"})
            continue
        if data[:5] != b"%PDF-":     # 非 PDF（CAJ 等）→ 尝试转换
            try:
                data = caj_mod.convert_bytes(data, fname)
            except caj_mod.ConvertError as e:
                skipped.append({"title": title, "reason": f"非 PDF 且转换失败: {str(e)[:110]}"})
                continue
        try:
            pages, _k = ingest.preflight_doc(data, fname or "paper.pdf",
                                             is_admin=is_admin, overrides=overrides)
        except ingest.PreflightError as e:
            skipped.append({"title": title, "reason": str(e)})
            continue
        file_hash = ingest.sha256_bytes(data)
        paper_id, dup = ingest.create_paper(u["id"], file_hash, pages, len(data),
                                            body.get("visibility", "shared"), fname or "paper.pdf")
        if dup:
            skipped.append({"title": title, "reason": "已在库中（内容重复）"})
            continue
        cid = _safe_collection(u, body.get("collection_id"))
        ingest.attach_to_collection(paper_id, cid)
        with db.write() as c:
            c.execute("UPDATE papers SET title=COALESCE(NULLIF(title,''),?) WHERE id=?", (title, paper_id))
            # 溯源：来源站点 + 外部链接（评审的可追溯要求）
            c.execute("UPDATE papers SET meta_source=COALESCE(meta_source,?) WHERE id=?",
                      (it.get("source") or "acquire", paper_id))
            c.execute("UPDATE papers SET doi=COALESCE(NULLIF(doi,''),?) WHERE id=?",
                      (it.get("doi") or "", paper_id))
            if it.get("authors"):
                c.execute("UPDATE papers SET authors=? WHERE id=?", (it["authors"][:500], paper_id))
            if it.get("year"):
                c.execute("UPDATE papers SET year=? WHERE id=?", (it["year"][:10], paper_id))
            if it.get("summary"):
                c.execute("UPDATE papers SET abstract=? WHERE id=?", (it["summary"][:3000], paper_id))
        ingest.store_pdf(paper_id, data, "original.pdf")
        scheduler.enqueue(u["id"], "parse", paper_id,
                          {"tier": "standard", "original_name": fname or "paper.pdf",
                           "source_url": url, "batch_id": batch_id},
                          priority="background")
        queued.append({"title": title, "paper_id": paper_id})
    audit(u["id"], "acquire-import", f"{len(queued)} 入库 / {len(skipped)} 跳过")
    return {"batch_id": batch_id, "queued": queued, "skipped": skipped}


@app.get("/api/import-dirs")
def list_import_dirs(request: Request):
    """列出可导入的目录（inbox 下，含子目录与文件数）。"""
    require(request)
    from core.config import DATA_DIR
    base = (DATA_DIR / "inbox").resolve()
    if not base.exists():
        return {"dirs": [], "base": str(base)}
    dirs = []
    for p in sorted(base.iterdir()):
        if not p.is_dir():
            continue
        n = sum(1 for _ in p.rglob("*") if _.is_file() and _.suffix.lower() in (".pdf", ".caj", ".kdh"))
        dirs.append({"name": p.name, "files": n, "path": str(p.relative_to(base))})
    return {"dirs": dirs, "base": str(base)}


@app.post("/api/import-directory")
async def import_directory(request: Request):
    """目录批量入库：PDF 直接入库；CAJ/KDH 先转 PDF 再入库；逐篇入队解析。"""
    u = require(request)
    body = await request.json()
    target = _safe_import_dir((body.get("path") or "").strip())
    is_admin = u["role"] == "admin"
    overrides = _enforce_parse_quota(u)   # 与上传链路同款：解析配额不能被绕过
    from core import caj as caj_mod

    files = [p for p in sorted(target.rglob("*"))
             if p.is_file() and p.suffix.lower() in (".pdf", ".caj", ".kdh")]
    if not files:
        raise HTTPException(404, "该目录下没有 PDF/CAJ 文件")
    if len(files) > 100:
        raise HTTPException(400, f"单次最多导入 100 个文件（当前 {len(files)} 个），请分批")

    batch_id = new_batch_id()
    queued, skipped = [], []
    for f in files:
        try:
            data = f.read_bytes()
        except Exception as e:  # noqa: BLE001
            skipped.append({"file": f.name, "reason": f"读取失败: {str(e)[:80]}"})
            continue
        # 按内容判定（扩展名为 .caj 的可能实为 PDF；PDF 优先直通）
        kind = caj_mod.sniff(data)
        if kind != "pdf":
            try:
                data = caj_mod.convert_bytes(data, f.name)
            except caj_mod.ConvertError as e:
                skipped.append({"file": f.name, "reason": str(e)})
                continue
        try:
            pages, _k = ingest.preflight_doc(data, f.name, is_admin=is_admin, overrides=overrides)
        except ingest.PreflightError as e:
            skipped.append({"file": f.name, "reason": str(e)})
            continue
        file_hash = ingest.sha256_bytes(data)
        paper_id, dup = ingest.create_paper(u["id"], file_hash, pages, len(data),
                                            body.get("visibility", "shared"), f.name)
        if dup:
            skipped.append({"file": f.name, "reason": "已在库中（内容重复）"})
            continue
        cid = _safe_collection(u, body.get("collection_id"))
        ingest.attach_to_collection(paper_id, cid)
        with db.write() as c:
            # 溯源：来源目录与原始文件名（评审的「获取可追溯」）
            c.execute("UPDATE papers SET meta_source=COALESCE(meta_source,'dir-import') WHERE id=?",
                      (paper_id,))
        ingest.store_pdf(paper_id, data, "original.pdf")
        scheduler.enqueue(u["id"], "parse", paper_id,
                          {"tier": "standard", "original_name": f.name,
                           "source_dir": str(target), "batch_id": batch_id},
                          priority="background")
        queued.append({"file": f.name, "paper_id": paper_id})
    audit(u["id"], "import-directory", f"{target.name}: {len(queued)} 入库 / {len(skipped)} 跳过")
    return {"batch_id": batch_id, "queued": queued, "skipped": skipped,
            "total": len(files)}


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


@app.get("/api/meta/cnki-search")
def cnki_search_meta(request: Request, title: str = ""):
    """知网中文元数据候选（jasminum 式：候选列表 → 人工确认 → 前端 PATCH 写入）。"""
    require(request)
    title = title.strip()
    if len(title) < 2:
        raise HTTPException(400, "title 太短")
    from core import cnki
    try:
        cands = cnki.search(title)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"知网检索失败（可能反爬拦截）: {e}")
    return {"candidates": cands}


# ---------------- MCP Server（ZCode/Claude 直连；bearer=PAPERSYS_API_TOKEN） ----------------
def _mcp_user() -> int | None:
    """token 归属 admin（单部署者模型）；找不到则拒绝。"""
    row = db.one("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")
    return row["id"] if row else None


@app.post("/api/mcp")
async def mcp_endpoint(request: Request):
    auth = request.headers.get("authorization") or ""
    if not (auth.startswith("Bearer ") and secrets.compare_digest(
            auth[7:], PAPERSYS_API_TOKEN or "-")):
        raise HTTPException(401, "无效 bearer token（PAPERSYS_API_TOKEN）")
    uid = _mcp_user()
    if uid is None:
        raise HTTPException(503, "无 admin 用户")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "无效 JSON-RPC")
    from core import mcpserver
    return mcpserver.handle(uid, payload)


@app.get("/api/mcp/pending")
def mcp_pending(u: dict = Depends(require)):
    """待确认的 MCP 写动作（网页「队列」浮层轮询展示）。"""
    from core import mcpserver
    return {"pending": mcpserver.pending_for(u["id"])}


@app.post("/api/mcp/confirm")
async def mcp_confirm(request: Request):
    """确认/丢弃 MCP 写动作；执行后可经 undo_last_action 撤销。"""
    u = require(request)
    body = await request.json()
    from core import mcpserver
    r = mcpserver.confirm_action(u["id"], body.get("action_id") or "",
                                 bool(body.get("approve")))
    if r.get("executed"):
        audit(u["id"], "mcp-execute", str(body.get("action_id")))
    return r


@app.post("/api/papers/{paper_id}/verify-meta")
async def verify_meta(paper_id: str, request: Request):
    """联网校准元数据（jasminum 式确认制）。

    默认（apply=false）只返回候选不改库，前端弹「改前→改后」对照；
    确认后带 {apply: true, candidate} 回传直接写入。
    """
    u = require(request)
    p = _own_paper_or_404(u, paper_id, write=True)
    try:
        body = await request.json() if (request.headers.get("content-length") or "0") != "0" else {}
    except Exception:  # noqa: BLE001
        body = {}
    apply = bool(body.get("apply"))
    candidate = body.get("candidate") if apply else None
    try:
        from core.meta import verify_meta_online
        import anyio
        import functools
        # 五源外网调用（各 15s 超时）+ mutool（60s）——严禁在事件循环上跑
        result = await anyio.to_thread.run_sync(functools.partial(
            verify_meta_online, paper_id, apply=apply, candidate=candidate))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"校准服务不可达: {e}")
    if apply:
        audit(u["id"], "verify-meta-apply", p["id"])
    return result


@app.get("/api/papers/{paper_id}/journal-rank")
def paper_journal_rank(paper_id: str, force: int = 0, u: dict = Depends(require)):
    p = db.one("SELECT id, owner_id, visibility, journal FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    from core.journal import get_journal_rank
    return get_journal_rank(p["journal"], force=bool(force))


@app.get("/api/statuses")
def papers_statuses(paper_ids: str = "", limit: int = 0, u: dict = Depends(require)):
    """论文的 解析/翻译状态 + 每篇 token 用量。

    优化: 支持 paper_ids 精确查询（前端按当前视图传）+ 结果缓存 30s
    （库上千篇时全表扫描会拖慢文库页）.
    """
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
    # 覆盖扫描 idx_jobs_paper(paper_id,job_type,status) 求 MAX(id)（无 temp b-tree、不回表），
    # JOIN 取行时显式列——payload（综述任务可达数 KB）不进 statuses 响应
    for j in db.all(
        "SELECT j.id, j.paper_id, j.job_type, j.status, j.error, j.progress_done, j.progress_total "
        "FROM jobs j JOIN (SELECT paper_id, job_type, MAX(id) AS mid FROM jobs "
        "WHERE job_type IN ('parse','translate') GROUP BY paper_id, job_type) m ON m.mid=j.id"
    ):
        latest.setdefault(j["paper_id"], {})[j["job_type"]] = j
    tokens = {r["paper_id"]: r for r in db.all(
        "SELECT paper_id, SUM(prompt_tokens) p, SUM(completion_tokens) c, COUNT(*) calls "
        "FROM llm_calls WHERE paper_id IS NOT NULL"
        + owner_scope(u)[0],
        owner_scope(u)[1])}
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
    # 先校验+取消远程任务，再单事务批量软删（原先每篇 2-3 个独立事务：写锁+fsync ×N）
    todo, titles = [], []
    for pid in ids:
        p = db.one("SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (pid,))
        if p is None:
            continue
        _require_visible(u, p)
        # 与单删同规则：private 非本人跳过；shared 仅 admin 可删（member 删他人共享论文 = 越权，
        # 此前只拦 private、shared 放行——与单删端点 403 不对称的权限洞）
        if p["visibility"] == "private" and p["owner_id"] != u["id"] and u["role"] != "admin":
            continue
        if p["visibility"] == "shared" and p["owner_id"] != u["id"] and u["role"] != "admin":
            raise HTTPException(403, "他人上传的共享论文仅管理员可删除")
        for j in db.all(f"SELECT * FROM jobs WHERE paper_id=? AND status IN {_ACTIVE_JOBS}", (pid,)):
            if j["remote_task_id"]:
                mineru.cancel(j["remote_task_id"])
        todo.append(pid)
        titles.append(p["title"])
    if todo:
        marks = ",".join("?" * len(todo))
        with db.write() as c:
            c.execute(f"UPDATE jobs SET status='canceled' WHERE paper_id IN ({marks}) "
                      f"AND status IN {_ACTIVE_JOBS}", tuple(todo))
            c.execute(f"UPDATE papers SET deleted_at=datetime('now') WHERE id IN ({marks})", tuple(todo))
            from core.retrieval import clear_fts_by_paper
            for _pid in todo:
                clear_fts_by_paper(c, _pid)
        for t in titles:
            audit(u["id"], "batch-delete", t)
        from core.retrieval import invalidate_vec_cache
        invalidate_vec_cache()
    return {"ok": True, "count": len(todo)}


@app.post("/api/trash/empty")
def empty_trash(u: dict = Depends(require)):
    """清空回收站（按用户独立）：member 清自己删除的；admin 清全部。"""
    scope, sargs = owner_scope(u, "owner_id")
    rows = db.all(f"SELECT id FROM papers WHERE deleted_at IS NOT NULL{scope}", sargs)
    from core.jobs import scheduler
    for r in rows:
        scheduler.hard_delete_paper(r["id"])
    audit(u["id"], "empty-trash", f"{len(rows)} 篇")
    return {"purged": len(rows)}


# ---------------- 导出下载（原文/双语 PDF·MD·ZIP 组合） ----------------
@app.get("/api/papers/{paper_id}/download/{fmt}")
def download_paper(paper_id: str, fmt: str, items: str = "", u: dict = Depends(require)):
    """fmt: pdf(原始PDF) md(原文md) bilingual_md bilingual_pdf zh_pdf en_pdf zip(组合)"""
    p = _get_paper_or_404(paper_id, u)
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
def download_options(paper_id: str, u: dict = Depends(require)):
    """可下载项（依据是否已翻译）。"""
    p = _own_paper_or_404(u, paper_id, write=False)
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
def reindex_paper(paper_id: str, u: dict = Depends(require)):
    """重建块结构与检索索引：从已存的 middle.json 重新入库（不占 GPU）+ embedding 回填。

    解析产物结构修复后使用（如跨栏续文合并）；也用于换向量模型或索引异常。
    """
    p = _own_paper_or_404(u, paper_id, write=True)
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
    p = _own_paper_or_404(u, paper_id, write=True)
    run = latest_run(paper_id)
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
        f"AND status IN {_ACTIVE_JOBS}",
        (paper_id, job_type),
    ):
        if j["remote_task_id"]:
            mineru.cancel(j["remote_task_id"])
        with db.write() as c:
            c.execute("UPDATE jobs SET status='canceled' WHERE id=?", (j["id"],))
        n += 1
    return n


@app.post("/api/papers/{paper_id}/cancel-parse")
def cancel_parse(paper_id: str, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=True)
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
def cancel_translate(paper_id: str, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=True)
    return {"canceled": _cancel_paper_jobs(paper_id, "translate")}


@app.post("/api/papers/{paper_id}/parse")
def start_parse(paper_id: str, u: dict = Depends(require)):
    """(重新)解析：入队 interactive 任务，新建 parse_run。"""
    is_admin = u["role"] == "admin"
    p = _own_paper_or_404(u, paper_id, write=True)
    _enforce_parse_quota(u)
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
def paper_jobstate(paper_id: str, u: dict = Depends(require)):
    """论文当前在途任务状态（前端按钮切换依据）。"""
    p = db.one("SELECT id, owner_id, visibility, parse_status FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)
    rows = db.all(
        "SELECT job_type, status, progress_done, progress_total FROM jobs WHERE paper_id=? "
        f"AND job_type IN ('parse','translate') AND status IN {_ACTIVE_JOBS}",
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
            f"AND status IN {_ACTIVE_JOBS}", (pid,))
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
        if body.get("force_new_version"):
            # 代际递增：旧代次的在途任务写库前会被 cancel_check 拦下（T3 乱序防护）
            with db.write() as c:
                c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                          "ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)",
                          (f"tgen:{pid}", "1"))
        scheduler.enqueue(u["id"], "translate", pid,
                          {"force_new_version": bool(body.get("force_new_version"))},
                          priority="background" if batch else "interactive")
        queued.append(pid)
    return {"queued": queued, "skipped_in_flight": skipped,
            "skipped_already_done": len(skipped)}


@app.get("/api/papers/{paper_id}/cite")
def paper_cite(paper_id: str, u: dict = Depends(require)):
    """引用文本：一次给出全部样式（GB/T 7714 / APA / MLA / BibTeX）。

    前端拿到后本地切换样式、即时预览，不弹窗、不逐次请求。
    """
    p = _get_paper_or_404(paper_id, u)
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
def paper_discover(paper_id: str, mode: str = "rec", limit: int = 20, u: dict = Depends(require)):
    """相关文献发现：rec=相关推荐 / refs=参考文献 / cites=引证。结果带 in_library 标记。"""
    p = _get_paper_or_404(paper_id, u)
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


# ---------------- 标识符导入（DOI / arXiv / BibTeX，zotero-mcp 式） ----------------
@app.post("/api/papers/import-identifier")
async def import_identifier(request: Request):
    """粘贴 DOI / arXiv ID / BibTeX / 标题 → 元数据 + OA PDF 自动获取 → 走导入链路。

    逐条独立返回（部分失败不拖垮整批）。
    """
    u = require(request)
    body = await request.json()
    from core.identifier import parse_identifiers, resolve_identifier
    idents = parse_identifiers(body.get("text") or "")
    if not idents:
        raise HTTPException(400, "未识别到 DOI / arXiv ID / BibTeX 条目")
    out = []
    cid = body.get("collection_id") or get_or_create_default_collection(u["id"])
    _safe_collection(u, cid)   # 归属校验（此前零校验）
    # 配额闸：此前 import-identifier 无每日解析配额（唯一旁路口），且条数无上限可刷队列
    _enforce_parse_quota(u)
    import re as _re
    _ident_n = len(_re.findall(r"10\.\d{4,9}/\S+|arXiv:\d{4}\.\d{4,5}", body.get("text") or ""))
    if _ident_n > 50:
        raise HTTPException(400, f"单次最多导入 50 条标识符（本次 {_ident_n} 条）")
    for ident in idents:
        try:
            meta = resolve_identifier(ident["kind"], ident["value"])
        except ValueError as e:
            out.append({"ident": ident, "status": "not_found", "message": str(e)})
            continue
        except Exception as e:  # noqa: BLE001
            out.append({"ident": ident, "status": "error", "message": str(e)[:150]})
            continue
        title = meta.get("title") or ""
        # 查重（DOI / 标题）
        dup = None
        if meta.get("doi"):
            dup = db.one("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", (meta["doi"],))
        if dup is None and title:
            dup = db.one("SELECT id FROM papers WHERE lower(title)=? AND deleted_at IS NULL",
                         (title.lower(),))
        if dup:
            # 与 upload 口径一致：内容已在库（别的库）→ 挂进目标库并提示
            from core.ingest import attach_to_collection
            linked = attach_to_collection(dup["id"], cid)
            out.append({"ident": ident, "status": "duplicate", "paper_id": dup["id"],
                        "linked": linked, "metadata": meta})
            continue
        url = meta.get("pdf_url") or ""
        if not url.startswith(("http://", "https://")):
            out.append({"ident": ident, "status": "no_pdf", "metadata": meta})
            continue
        try:
            _assert_public_url(url)
        except HTTPException:
            out.append({"ident": ident, "status": "no_pdf", "metadata": meta})
            continue
        from core.urlimport import import_paper_from_url
        r = import_paper_from_url(
            u["id"], url,
            visibility=body.get("visibility", "shared"),
            collection_id=cid,
            title=title,
            meta={"authors": meta.get("authors"), "year": meta.get("year"),
                  "journal": meta.get("journal"), "doi": meta.get("doi"),
                  "abstract": meta.get("abstract")},
            is_admin=u["role"] == "admin", overrides=_quota_overrides(u["id"]))
        out.append({"ident": ident, "status": r["status"], "paper_id": r["paper_id"],
                    "metadata": meta})
    return {"results": out}


# ---------------- 命令标签（zotero-gpt 式：问答框上方一键快捷指令） ----------------
@app.get("/api/cmdtags")
def get_cmdtags(u: dict = Depends(require)):
    row = db.one("SELECT value FROM settings WHERE key=?", (f"cmdtags:{u['id']}",))
    try:
        tags = json.loads(row["value"]) if row else []
    except Exception:  # noqa: BLE001
        tags = []
    return {"tags": [t for t in tags if isinstance(t, dict) and t.get("label")][:20]}


@app.put("/api/cmdtags")
async def set_cmdtags(request: Request):
    u = require(request)
    body = await request.json()
    tags = [t for t in (body.get("tags") or [])[:20]
            if isinstance(t, dict) and (t.get("label") or "").strip()]
    for t in tags:
        t["label"] = str(t["label"])[:20]
        t["prompt"] = str(t.get("prompt") or "")[:2000]
    with db.write() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (f"cmdtags:{u['id']}", json.dumps(tags, ensure_ascii=False)))
    return {"ok": True, "tags": tags}


# ---------------- 选中文字翻译（阅读页浮条「翻译」用，单次 LLM 调用不落库） ----------------
@app.post("/api/translate-selection")
async def translate_selection(request: Request):
    u = require(request)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text 为空")
    if len(text) > 6000:
        text = text[:6000]
    from core.llm import LLMClient, resolve_llm
    cfg = resolve_llm(u["id"], "chat")
    client = LLMClient(cfg, user_id=u["id"], paper_id=body.get("paper_id"))
    zh = bool(re.search(r"[一-鿿]", text))
    direction = "译成英文，保留术语与公式" if zh else "翻译成中文，术语首次出现保留英文原文"
    out = client.complete([
        {"role": "system", "content":
            f"你是学术翻译。{direction}。只输出译文，不要解释。"},
        {"role": "user", "content": text},
    ], max_tokens=3000)
    return {"translation": out.strip()}


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
    _enforce_parse_quota(u)
    cid = body.get("collection_id") or get_or_create_default_collection(u["id"])
    _safe_collection(u, cid)   # 归属校验（此前 cid 未定义即用——NameError 风险 + 零校验）
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
            from core.ingest import attach_to_collection
            linked = attach_to_collection(dup["id"], cid)
            out.append({"title": title, "status": "duplicate", "paper_id": dup["id"],
                        "linked": linked})
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
        from core.urlimport import import_paper_from_url
        r = import_paper_from_url(
            u["id"], url,
            visibility=body.get("visibility", "shared"),
            collection_id=cid,
            title=title,
            meta={"authors": it.get("authors"), "year": it.get("year"),
                  "journal": it.get("venue"), "doi": it.get("doi")},
            is_admin=u["role"] == "admin", overrides=_quota_overrides(u["id"]))
        out.append({"title": title, "status": r["status"], "paper_id": r["paper_id"]})
        if r["status"] == "queued":
            imported += 1
    if imported:
        audit(u["id"], "discover-import", f"{imported} 篇")
    return {"results": out}


@app.get("/api/papers/{paper_id}/bilingual")
def get_bilingual(paper_id: str, cache_key: str = "",
                  offset: int = 0, limit: int = 0, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=False)
    from core.translator import bilingual_pairs, translation_versions
    run = latest_run(paper_id)
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
        import anyio
        prepared = await anyio.to_thread.run_sync(
            functools.partial(qa.answer, u, question, paper_ids, mode))
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
def chat_sessions(paper_id: str = "", u: dict = Depends(require)):
    cond, args = "user_id=?", [u["id"]]
    if paper_id:
        cond += " AND paper_scope LIKE ?"
        args.append(f"%{paper_id}%")
    rows = db.all(f"SELECT * FROM chat_sessions WHERE {cond} ORDER BY updated_at DESC LIMIT 50",
                  tuple(args))
    return {"sessions": [dict(r) for r in rows]}


@app.delete("/api/chat/sessions/{session_id}")
def delete_chat_session(session_id: str, u: dict = Depends(require)):
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
def chat_messages(session_id: str, u: dict = Depends(require)):
    s = db.one("SELECT * FROM chat_sessions WHERE id=?", (session_id,))
    if s is None or (s["user_id"] != u["id"] and u["role"] != "admin"):
        raise HTTPException(404, "会话不存在")
    rows = db.all("SELECT role, content, evidence, created_at FROM chat_messages "
                  "WHERE session_id=? ORDER BY id", (session_id,))
    return {"session": dict(s), "messages": [dict(r) for r in rows]}


# ---------------- 导读 ----------------
@app.post("/api/papers/{paper_id}/summary/stream")
async def paper_summary_stream(paper_id: str, u: dict = Depends(require)):
    """流式导读：逐段推送（section 事件即时上屏，done 事件给最终校验版）。"""
    p = db.one("SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL", (paper_id,))
    if p is None:
        raise HTTPException(404, "论文不存在")
    _require_visible(u, p)

    def gen() -> Iterator[str]:
        try:
            for ev in summarizer.generate_stream(u, paper_id):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except NoKeyError as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
        except ValueError as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            log.exception("流式导读失败 %s", paper_id)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)[:200]}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


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
def get_paper_summary(paper_id: str, u: dict = Depends(require)):
    p = _own_paper_or_404(u, paper_id, write=False)
    s = summarizer.get_latest(paper_id)
    if s is None:
        return {"summary": None}
    data = json.loads(s["content"])
    # 读取时规范化：早期版本把模型的扁平 JSON（含 ```json 围栏）整段塞进 problem
    # → 界面显示源码。历史记录无需重新生成即可修复。
    if isinstance(data.get("sections"), dict):
        by_key, cm = summarizer.normalize_sections(data)
        if by_key:
            data = {**data, "sections": by_key, "cite_map": cm or data.get("cite_map", {})}
    return {"summary": data, "model": s["model"], "created_at": s["created_at"]}


# ---------------- 静态资源 ----------------
@app.get("/login")
def login_page():
    return FileResponse(WEBUI_DIR / "login.html")


_ASSET_VER: list[tuple[float, str]] = [0.0, ""]


def _asset_version() -> str:
    """styles.css/viewer.js 内容指纹 → 资源链接 ?v=。改版即换 URL，杜绝
    『换版瞬间新 JS + 旧 CSS』的浏览器缓存错配（布局重叠正是这么来的）。

    viewer.js 是 app/webui/src/*.js 的拼接产物——指纹同时纳入各分片的
    mtime/size，任一分片改动都会换版本号（不必重新构建也能让缓存失效）。"""
    import hashlib

    sig = []
    for name in ("styles.css", "viewer.js"):
        p = WEBUI_DIR / name
        sig.append(f"{name}:{p.stat().st_mtime_ns}:{p.stat().st_size}")
    src_dir = WEBUI_DIR / "src"
    if src_dir.is_dir():
        for p in sorted(src_dir.glob("*.js")):
            st = p.stat()
            sig.append(f"src/{p.name}:{st.st_mtime_ns}:{st.st_size}")
    key = "|".join(sig)
    if _ASSET_VER[1] != key:
        h = hashlib.sha1(key.encode()).hexdigest()[:12]
        _ASSET_VER[:] = [time.time(), h]
    return _ASSET_VER[1]


@app.get("/")
def index():
    html = (WEBUI_DIR / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = html.replace("/static/styles.css", f"/static/styles.css?v={v}")
    html = html.replace("/static/viewer.js", f"/static/viewer.js?v={v}")
    from fastapi.responses import Response as _Resp
    return _Resp(html, media_type="text/html")


app.mount("/static", StaticFiles(directory=str(WEBUI_DIR)), name="static")
