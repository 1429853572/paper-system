"""术语表：全局共享 + 人工锁定（保留英文/指定译法/首现并列）."""
from __future__ import annotations

import hashlib
import json

from .db import db

# 术语表内容变化时缓存键失效
_version_cache: str | None = None


def glossary_version() -> str:
    global _version_cache
    rows = db.all("SELECT term, target, value FROM glossary ORDER BY term")
    payload = json.dumps([[r["term"], r["target"], r["value"]] for r in rows], ensure_ascii=False)
    _version_cache = hashlib.sha256(payload.encode()).hexdigest()[:12]
    return _version_cache


def glossary_block() -> str:
    """翻译提示词中的术语表文本。"""
    rows = db.all("SELECT term, target, value FROM glossary ORDER BY term")
    lines = []
    for r in rows:
        if r["target"] == "keep_en":
            lines.append(f'- {r["term"]}: 保留英文不翻译')
        elif r["target"] == "first_both":
            lines.append(f'- {r["term"]}: 首次出现译为「{r["value"]}（{r["term"]}）」，其后用「{r["value"]}」')
        elif r["value"]:
            lines.append(f'- {r["term"]}: 统一译为「{r["value"]}」')
    return "\n".join(lines)
