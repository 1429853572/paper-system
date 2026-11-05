"""配置加载：config.yaml（可调优项，有默认值）+ .env（敏感项）."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

APP_ROOT = Path(os.environ.get("PAPERSYS_APP_ROOT", "/app"))
DATA_DIR = Path(os.environ.get("PAPERSYS_DATA", "/app/data"))
DB_PATH = DATA_DIR / "papersys.db"

_DEFAULTS: dict[str, dict[str, Any]] = {
    "limits": {
        "max_file_mb": 100,
        "max_pages": 500,
        "daily_parse_papers": 200,
        "translate_concurrency": 2,
        "max_queued_jobs": 50,
        "disk_quota_gb": 20,
        "max_tier": "standard",
        "global_daily_parse": 600,
    },
    "scheduler": {
        "parse_workers": 1,
        "translate_workers": 4,
        "embed_backfill_batch": 32,
        "poll_interval_sec": 10,
        "retry_max": 3,
    },
    "rag": {
        "chunk_tokens": 650,
        "overlap_tokens": 100,
        "vector_top_k": 15,
        "bm25_top_k": 15,
        "fts_top_k": 15,
    },
    "qa": {
        "fulltext_max_tokens": 60000,
        "multi_paper_max": 10,
        "context_char_budget": 90000,
    },
    "retention": {"trash_days": 30, "backup_keep": 7},
}


class Config:
    """config.yaml 覆盖内建默认值；键不存在时回落默认。"""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        for path in (APP_ROOT / "config.yaml", Path("config.yaml")):
            if path.is_file():
                with open(path, encoding="utf-8") as f:
                    self._data = yaml.safe_load(f) or {}
                break

    def get(self, section: str, key: str) -> Any:
        return self._data.get(section, {}).get(key, _DEFAULTS[section][key])

    def section(self, section: str) -> dict[str, Any]:
        return {**_DEFAULTS.get(section, {}), **self._data.get(section, {})}


config = Config()

# ---- .env 敏感项 ----
SECRET_KEY = os.environ.get("SECRET_KEY", "")
FERNET_KEY = os.environ.get("FERNET_KEY", "")
ADMIN_INITIAL_PASSWORD = os.environ.get("ADMIN_INITIAL_PASSWORD", "")
PAPERSYS_API_TOKEN = os.environ.get("PAPERSYS_API_TOKEN", "")
POOL_API_BASE = os.environ.get("POOL_API_BASE", "")
POOL_API_KEY = os.environ.get("POOL_API_KEY", "")
POOL_MODEL = os.environ.get("POOL_MODEL", "")
MINERU_BASE_URL = os.environ.get("MINERU_BASE_URL", "http://mineru:8000")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
EASYSCHOLAR_KEY = os.environ.get("EASYSCHOLAR_KEY", "")
EASYSCHOLAR_URL = os.environ.get("EASYSCHOLAR_URL", "https://www.easyscholar.cc/open/getRank")
EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "1024"))

if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY 未配置——请通过 install.sh 初始化 .env")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY 未配置——请通过 install.sh 初始化 .env")
