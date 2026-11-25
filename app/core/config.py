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
    # LLM 单价（元/百万 token，公开定价参考值——各家 OpenAI 兼容厂商不同，
    # 用户可在设置页按自己的实际单价覆盖）。未收录的模型不计费。
    "pricing": {
        "gpt-4o":           {"prompt": 18.0, "completion": 72.0},
        "gpt-4o-mini":      {"prompt": 1.1,  "completion": 4.3},
        "gpt-4.1":          {"prompt": 14.0, "completion": 56.0},
        "gpt-4.1-mini":     {"prompt": 3.0,  "completion": 12.0},
        "deepseek-chat":    {"prompt": 0.55, "completion": 2.2},
        "deepseek-reasoner": {"prompt": 2.2, "completion": 8.8},
        "glm-4-flash":      {"prompt": 0.5,  "completion": 0.5},
        "glm-4-plus":       {"prompt": 50.0, "completion": 50.0},
        "glm-5.3-flash":    {"prompt": 0.5,  "completion": 1.5},
        "kimi-k2":          {"prompt": 4.0,  "completion": 16.0},
        "moonshot-v1":      {"prompt": 12.0, "completion": 12.0},
        "qwen-plus":        {"prompt": 4.0,  "completion": 12.0},
        "qwen-turbo":       {"prompt": 1.0,  "completion": 4.0},
    },
    "limits": {
        "max_file_mb": 100,
        "max_pages": 500,
        "daily_parse_papers": 200,
        "translate_concurrency": 2,
        "disk_quota_gb": 20,
        "global_daily_parse": 600,
        "tracker_subs": 5,           # 每成员订阅数上限（文献追踪；可在成员限额里按人覆盖）
        "sse_per_user": 4,           # 每用户 SSE 并发连接上限（每标签页常驻 1 条，占线程池 token）
        "sse_total": 200,            # 全站 SSE 连接上限（超限 429——防线程池被打满整站假死）
    },
    "scheduler": {
        "translate_workers": 4,
        "embed_backfill_batch": 32,
        "poll_interval_sec": 10,
        "retry_max": 3,
        "parse_task_timeout_sec": 1800,  # 单个 MinerU 远程任务时长上限：卡 running 的任务
                                         # 会占死唯一 parse worker（全站解析停摆），超时即失败重试
    },
    "rag": {
        "chunk_tokens": 650,
        "overlap_tokens": 100,
        "fts_top_k": 15,
    },
    "qa": {
        "fulltext_max_tokens": 200000,
        "multi_paper_max": 10,
        "context_char_budget": 90000,
        "smart_top_sections": 3,   # smart 模式喂入的命中章节数
    },
    "retention": {"trash_days": 30, "backup_keep": 7},
    "rerank": {"enabled": False, "base_url": "http://xinference:9997",
               "model": "bge-reranker-v2-m3", "top_n": 50, "keep": 8, "timeout": 30},
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
        """取值优先级：config.yaml → 内建默认 → None（不抛错）。"""
        sec = self._data.get(section)
        if isinstance(sec, dict) and key in sec:
            return sec[key]
        return _DEFAULTS.get(section, {}).get(key)

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
# embedding 服务地址：容器内 compose 注入 http://xinference:9997；缺省 localhost:9997
# 兜底本地直跑场景（多视角评审 P0-2：此前 retrieval 引用了未定义名，裸跑时
# NameError 被 except 吞掉 → 向量检索静默降级为纯 FTS）
EMBED_BASE_URL = os.environ.get("EMBED_BASE_URL", "http://localhost:9997")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
EASYSCHOLAR_KEY = os.environ.get("EASYSCHOLAR_KEY", "")
S2_API_KEY = os.environ.get("S2_API_KEY", "")

# 宿主浏览器采集服务（中文文献获取：知网/chinaxiv 等，容器内不装浏览器）
ACQUIRE_SERVICE_URL = os.environ.get("ACQUIRE_SERVICE_URL", "http://host.docker.internal:8802")
ACQUIRE_TOKEN = os.environ.get("PAPERSYS_ACQUIRE_TOKEN", "")
EASYSCHOLAR_URL = os.environ.get("EASYSCHOLAR_URL", "https://www.easyscholar.cc/open/getRank")
EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "1024"))

if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY 未配置——请通过 install.sh 初始化 .env")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY 未配置——请通过 install.sh 初始化 .env")
