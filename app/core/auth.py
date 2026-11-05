"""认证与会话：argon2 密码哈希、签名 cookie session、Fernet key 加密、登录限速."""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import FERNET_KEY, SECRET_KEY
from .db import db

_ph = PasswordHasher()
_signer = URLSafeTimedSerializer(SECRET_KEY, salt="paper-system-session")
_fernet = Fernet(FERNET_KEY.encode())

SESSION_MAX_AGE = 30 * 24 * 3600  # 30 天
# 登录限速：每 IP+用户名 10 分钟内最多 8 次失败（内存态；重启清零可接受）
_fail_log: dict[str, list[float]] = {}


class AuthError(Exception):
    pass


# ---- 密码 ----
def hash_password(plain: str) -> str:
    return _ph.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, plain)
    except VerifyMismatchError:
        return False


# ---- session cookie 值 ----
def make_session(user_id: int, role: str, token_ver: int) -> str:
    """签发会话 token；payload 带 token_ver，改密/登出所有设备后旧 token 失效."""
    return _signer.dumps({"uid": user_id, "role": role, "ver": token_ver})


def parse_session(token: str) -> dict[str, Any] | None:
    try:
        data = _signer.loads(token, max_age=SESSION_MAX_AGE)
        if isinstance(data, dict) and "uid" in data:
            return {"id": data["uid"], "role": data.get("role", "member"),
                    "ver": data.get("ver", 0)}
        return None
    except BadSignature:
        return None


def bump_token_ver(user_id: int) -> None:
    """会话吊销：版本号 +1 → 该用户所有已签发 token 立即失效."""
    with db.write() as c:
        c.execute("UPDATE users SET token_ver=token_ver+1 WHERE id=?", (user_id,))


def check_token_ver(session_user: dict[str, Any]) -> bool:
    """校验 token 内版本号与数据库一致（不一致 = 已被吊销）."""
    row = db.one("SELECT token_ver FROM users WHERE id=?", (session_user["id"],))
    return row is not None and session_user.get("ver", 0) == (row["token_ver"] or 0)


# ---- 登录限速 ----
def check_login_rate(ip: str, username: str = "") -> None:
    now = time.time()
    key = f"{ip}|{username}"
    fails = [t for t in _fail_log.get(key, []) if now - t < 600]
    _fail_log[key] = fails
    if len(fails) >= 8:
        raise AuthError("失败次数过多，请 10 分钟后再试")


def record_login_fail(ip: str, username: str = "") -> None:
    now = time.time()
    key = f"{ip}|{username}"
    fails = [t for t in _fail_log.get(key, []) if now - t < 600]
    fails.append(time.time())
    _fail_log[key] = fails
    # 防内存增长：键数过多时清掉最旧的一半
    if len(_fail_log) > 500:
        for k in sorted(_fail_log, key=lambda k: min(_fail_log[k], default=0))[:250]:
            _fail_log.pop(k, None)


# ---- 用户 ----
def ensure_admin() -> None:
    """首次启动创建 admin（密码来自 .env，仅首启生效）。"""
    from .config import ADMIN_INITIAL_PASSWORD

    if db.one("SELECT id FROM users LIMIT 1") is None:
        with db.write() as c:
            c.execute(
                "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)",
                ("admin", hash_password(ADMIN_INITIAL_PASSWORD), "admin"),
            )


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    row = db.one("SELECT id,username,password_hash,role,disabled,token_ver FROM users WHERE username=?", (username,))
    if row and not (row["disabled"] or 0) and verify_password(password, row["password_hash"]):
        return {"id": row["id"], "username": row["username"], "role": row["role"],
                "token_ver": row["token_ver"] or 0}
    return None


# ---- BYOK 加密存取 ----
def encrypt_key(plain: str) -> bytes:
    return _fernet.encrypt(plain.encode())


def decrypt_key(cipher: bytes) -> str:
    return _fernet.decrypt(cipher).decode()


def get_user_llm(user_id: int) -> dict[str, Any] | None:
    """返回 {chat:{base_url,model,key}, translate:{...}}；key 解密后仅内存使用。"""
    row = db.one("SELECT * FROM user_llm_keys WHERE user_id=?", (user_id,))
    if row is None:
        return None
    out: dict[str, Any] = {}
    for purpose, cipher_col, meta_col in (
        ("chat", "chat_cipher", "chat_meta"),
        ("translate", "translate_cipher", "translate_meta"),
    ):
        cipher = row[cipher_col]
        meta = json.loads(row[meta_col] or "{}")
        if cipher:
            try:
                key = decrypt_key(cipher)
            except InvalidToken:
                key = ""
            out[purpose] = {"base_url": meta.get("base_url", ""), "model": meta.get("model", ""),
                            "api_type": meta.get("api_type", "openai"), "key": key}
    return out or None


# ---- 邀请码 ----
def create_invite(created_by: int, days: int = 7) -> str:
    code = secrets.token_urlsafe(12)
    with db.write() as c:
        c.execute(
            "INSERT INTO invite_codes(code,created_by,expires_at) VALUES(?,?,datetime('now',?))",
            (code, created_by, f"+{int(days)} days"),
        )
    return code


def consume_invite(code: str, user_id: int) -> bool:
    with db.write() as c:
        cur = c.execute(
            "UPDATE invite_codes SET used_by=? WHERE code=? AND used_by IS NULL AND expires_at>datetime('now')",
            (user_id, code),
        )
        return cur.rowcount == 1
