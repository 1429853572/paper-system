"""文献采集编排：把「找 → 拿 → 入库」接进既有管线。

宿主跑 scripts/acquire-service.py（Playwright + 宿主 Chrome），容器内本模块
只做编排：
  1. 调宿主服务的 /search 拿候选（知网/chinaxiv；纯 HTTP 会被软封，浏览器才行）
  2. 用户勾选后 /fetch 下载文件（页面内 fetch，带完整浏览器指纹+Cookie）
  3. 文件落盘 → 复用既有 upload→MinerU→索引→导读 管线（与目录导入同款处理）
"""
from __future__ import annotations

import base64
import logging

import httpx

from .config import ACQUIRE_SERVICE_URL, ACQUIRE_TOKEN

log = logging.getLogger("acquire")

SITES = {"chinaxiv": "中国科学院科技论文预印本", "cnki": "中国知网"}


def _headers() -> dict:
    return {"X-Acquire-Token": ACQUIRE_TOKEN} if ACQUIRE_TOKEN else {}


def _base() -> str:
    return (ACQUIRE_SERVICE_URL or "").rstrip("/")


def service_status() -> dict:
    """宿主采集服务可用性（设置页/诊断展示）。"""
    if not _base():
        return {"available": False, "reason": "未配置 ACQUIRE_SERVICE_URL"}
    try:
        r = httpx.get(_base() + "/status", headers=_headers(), timeout=8)
        if r.status_code != 200:
            return {"available": False, "reason": f"HTTP {r.status_code}"}
        d = r.json()
        d["available"] = bool(d.get("browser") and d.get("playwright"))
        if not d.get("playwright"):
            d["reason"] = "宿主未安装 playwright（pip install playwright）"
        return d
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": f"采集服务不可达: {str(e)[:120]}"}


def search(site: str, query: str, page: int = 1, limit: int = 20) -> list[dict]:
    """检索候选。宿主服务不可达/失败时抛 ValueError（前端给可读提示）。"""
    if not _base():
        raise ValueError("未配置采集服务（ACQUIRE_SERVICE_URL）")
    try:
        r = httpx.post(_base() + "/search",
                       json={"site": site, "query": query, "page": page, "limit": limit},
                       headers=_headers(), timeout=120)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"采集服务不可达: {str(e)[:150]}") from None
    if r.status_code != 200:
        try:
            msg = (r.json().get("error") or f"HTTP {r.status_code}")
        except Exception:  # noqa: BLE001
            msg = f"HTTP {r.status_code}"
        raise ValueError(str(msg)[:300])
    return (r.json().get("results") or [])


def fetch(url: str, timeout: int = 120) -> tuple[bytes, str, str]:
    """经宿主浏览器下载。返回 (内容, content_type, 文件名)。"""
    if not _base():
        raise ValueError("未配置采集服务（ACQUIRE_SERVICE_URL）")
    try:
        r = httpx.post(_base() + "/fetch", json={"url": url},
                       headers=_headers(), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"采集服务不可达: {str(e)[:150]}") from None
    if r.status_code != 200:
        try:
            msg = (r.json().get("error") or f"HTTP {r.status_code}")
        except Exception:  # noqa: BLE001
            msg = f"HTTP {r.status_code}"
        raise ValueError(str(msg)[:300])
    d = r.json()
    return (base64.b64decode(d.get("content_base64") or ""),
            d.get("content_type") or "application/octet-stream",
            d.get("filename") or "download.pdf")
