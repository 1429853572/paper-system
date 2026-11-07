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
import os
from urllib.parse import urlparse

import httpx

from .config import ACQUIRE_SERVICE_URL, ACQUIRE_TOKEN

log = logging.getLogger("acquire")

SITES = {"chinaxiv": "中国科学院科技论文预印本", "cnki": "中国知网"}

# 与宿主服务同款白名单（纵深防御：即便服务侧漏了，这里也拦一道）
ALLOWED_HOSTS = [
    h.strip().lower() for h in
    (os.environ.get("CNKI_ALLOWED_HOSTS") or
     "chinaxiv.org,kns.cnki.net,www.cnki.net,cnki.net,navi.cnki.net,"
     "arxiv.org,export.arxiv.org,doi.org,dx.doi.org,*.cnki.net").split(",")
    if h.strip()
]


def host_allowed(host: str) -> bool:
    host = (host or "").split(":")[0].lower()
    for pat in ALLOWED_HOSTS:
        p = pat.lower()
        if p.startswith("*."):
            if host == p[2:] or host.endswith(p[1:]):
                return True
        elif host == p:
            return True
    return False


def _public_ip(ip: str) -> bool:
    """非公网 IP 判定（环回/私网/链路本地/保留段）——浏览器能带宿主身份访问内网。"""
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified)


def check_url(url: str) -> str:
    """校验下载 URL：协议 + 无 userinfo/反斜杠 + 域名白名单 + 解析到公网 IP。

    Python 的 urlparse 与浏览器(WHATWG)对 `\` 与 userinfo 的解析不一致：
    `http://169.254.169.254\@chinaxiv.org/x` 在 urlparse 看来是 chinaxiv.org，
    浏览器实际连 169.254.169.254 → 这里统一按「拒绝含 \ @ 空白 的 URL」处理。
    """
    if not url.startswith(("http://", "https://")):
        raise ValueError("仅支持 http/https URL")
    if any(ch in url for ch in ("\\", "@", " ", "\t", "\n")):
        raise ValueError("URL 含非法字符（\ @ 空白）")
    parts = urlparse(url)
    host = parts.hostname or ""
    if not host:
        raise ValueError("URL 缺少主机名")
    if not host_allowed(host):
        raise ValueError(f"域名不在采集白名单内（拒绝访问 {host}）")
    # 域名若直接是 IP，必须是公网
    try:
        import ipaddress
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not _public_ip(host):
            raise ValueError(f"拒绝访问非公网 IP（{host}）")
    return host


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
    """经宿主浏览器下载。返回 (内容, content_type, 文件名)。

    下载前校验域名白名单（浏览器带宿主身份访问任意 URL 是 SSRF 跳板）。
    """
    check_url(url)
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
