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
# 登录限速：每 IP 10 分钟内最多 8 次失败
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
def make_session(user_id: int, role: str) -> str:
    return _signer.dumps({"uid": user_id, "role": role})


def parse_session(token: str) -> dict[str, Any] | None:
    try:
        data = _signer.loads(token, max_age=SESSION_MAX_AGE)
        if isinstance(data, dict) and "uid" in data:
            return {"id": data["uid"], "role": data.get("role", "member")}
        return None
    except BadSignature:
        return None


# ---- 登录限速 ----
def check_login_rate(ip: str) -> None:
    now = time.time()
    fails = [t for t in _fail_log.get(ip, []) if now - t < 600]
    _fail_log[ip] = fails
    if len(fails) >= 8:
        raise AuthError("失败次数过多，请 10 分钟后再试")


def record_login_fail(ip: str) -> None:
    _fail_log.setdefault(ip, []).append(time.time())


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
    row = db.one("SELECT id,username,password_hash,role FROM users WHERE username=?", (username,))
    if row and verify_password(password, row["password_hash"]):
        return {"id": row["id"], "username": row["username"], "role": row["role"]}
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
