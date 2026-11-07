"""相关文献发现（Semantic Scholar 三模式）：推荐 / 参考文献 / 引证。

借鉴 llm-for-zotero 的 /discover_related（OpenAlex 三页签排卡），本系统用
S2（元数据校准已在用，DOI 定位更稳）。无 S2_API_KEY 时匿名调用（限速够用）。
结果内存 TTL 缓存 30 分钟——同一篇反复切换页签不打外网。
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote

import httpx

from .config import S2_API_KEY

_CACHE: dict[str, tuple[float, list]] = {}
_NEG: dict[str, tuple[float, str]] = {}      # 失败短缓存：限流风暴期不反复打外网
_NEG_TTL = 60
_TTL = 1800
_OA = "https://api.openalex.org"
_OA_MAILTO = {"mailto": "admin@paper-system.local"}
_FIELDS = "title,year,venue,abstract,externalIds,openAccessPdf,citationCount,authors"


def _headers() -> dict:
    return {"x-api-key": S2_API_KEY} if S2_API_KEY else {}


def _get(url: str, params: dict) -> httpx.Response:
    """S2 限流（429）常见：退避重试两次（2s/6s）再放弃。"""
    r: httpx.Response | None = None
    for delay in (0, 2, 6):
        if delay:
            time.sleep(delay)
        r = httpx.get(url, params=params, headers=_headers(), timeout=25)
        if r.status_code != 429:
            return r
    return r


def resolve_direct_pdf(url: str) -> str:
    """OA 链接 → 直链 PDF（导入时逐条调用，列表阶段不做）。

    S2 的 openAccessPdf 常给 doi.org/落地页——MinerU 服务端不跟 302，会在
    这里解析掉：content negotiation（Accept: application/pdf）+ nature/springer
    落地页加 .pdf 后缀。
    """
    if not url:
        return url
    low = url.lower()
    if low.endswith('.pdf') or 'arxiv.org/pdf/' in low or '/pdf/' in low:
        return url
    try:
        r = httpx.get(url, headers={'Accept': 'application/pdf',
                                    'User-Agent': 'paper-system/1.0'},
                      timeout=20, follow_redirects=True)
        ct = (r.headers.get('content-type') or '').lower()
        final = str(r.url)
        if r.status_code == 200 and 'pdf' in ct:
            return final
        m = re.match(r'(https?://(?:www\.)?(?:nature\.com|link\.springer\.com)/articles/[^\s?#]+)$', final)
        if m:
            return m.group(1) + '.pdf'
    except Exception:  # noqa: BLE001 —— 解析失败退回原 URL，让 MinerU 自己试
        pass
    return url


def _norm_item(d: dict) -> dict:
    ext = d.get("externalIds") or {}
    oa = d.get("openAccessPdf") or {}
    return {"s2_id": d.get("paperId") or "",
            "title": (d.get("title") or "").strip(),
            "year": str(d.get("year") or ""),
            "venue": d.get("venue") or "",
            "abstract": (d.get("abstract") or "")[:400],
            "doi": ext.get("DOI") or "",
            "arxiv": ext.get("ArXiv") or "",
            "authors": ", ".join(a.get("name", "") for a in (d.get("authors") or [])[:6]),
            "citation_count": d.get("citationCount") or 0,
            "pdf_url": oa.get("url") or ""}


def resolve_s2_id(paper: dict) -> str | None:
    """DOI 直查；无 DOI 走标题精确匹配。返回 S2 paperId。"""
    if paper.get("doi"):
        return "DOI:" + paper["doi"]
    r = _get("https://api.semanticscholar.org/graph/v1/paper/search/match",
             {"query": paper.get("title") or "", "fields": "paperId"})
    if r.status_code != 200:
        return None
    d = (r.json().get("data") or [{}])[0]
    return d.get("paperId")


def discover(paper: dict, mode: str, limit: int = 20) -> list[dict]:
    """mode: rec（相关推荐）| refs（它引用的）| cites（引用它的）。

    主路 S2（摘要/PDF 元数据更全）；429/限流/无记录时自动切 OpenAlex 兜底
    （免 key、限额宽松，llm-for-zotero 同款数据源）。失败结果负缓存 60s。
    """
    if mode not in ("rec", "refs", "cites"):
        raise ValueError("mode 须为 rec|refs|cites")
    key = f"{mode}:{limit}:" + (paper.get("doi") or paper.get("title") or "")[:120]
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    neg = _NEG.get(key)
    if neg and time.time() - neg[0] < _NEG_TTL:
        raise ValueError(neg[1])

    items, err = None, ""
    try:
        items = _discover_s2(paper, mode, limit)
    except Exception as e:  # noqa: BLE001 —— S2 失败（限流等）→ OpenAlex 兜底
        err = str(e)
    if items is None:
        try:
            items = _discover_openalex(paper, mode, limit)
        except Exception as e:  # noqa: BLE001
            msg = f"找相关暂不可用：S2({err[:80]}) / OpenAlex({str(e)[:80]})"
            _NEG[key] = (time.time(), msg)
            raise ValueError(msg) from None
    _CACHE[key] = (time.time(), items)
    _NEG.pop(key, None)
    if len(_CACHE) > 128:
        for k in list(_CACHE)[:64]:
            _CACHE.pop(k, None)
    return items


def _discover_s2(paper: dict, mode: str, limit: int) -> list[dict] | None:
    sid = resolve_s2_id(paper)
    if not sid:
        return None
    # DOI 形如 10.48550/arXiv.2402.07181 自带斜杠——不编码会截断 URL 路径 404
    base = "https://api.semanticscholar.org/graph/v1/paper/" + quote(sid, safe="")
    if mode == "rec":
        url, wrap = base + "/recommendations", "recommendedPapers"
    elif mode == "refs":
        url, wrap = base + "/references", "data"          # 行包装在 citedPaper
    else:
        url, wrap = base + "/citations", "data"           # 行包装在 citingPaper
    r = _get(url, {"fields": _FIELDS, "limit": min(int(limit), 100)})
    if r.status_code == 404:
        return None     # S2 无记录不算失败——静默走 OpenAlex
    r.raise_for_status()
    raw = r.json().get(wrap) or []
    items = []
    for row in raw:
        item = row.get("citingPaper") or row.get("citedPaper") or row
        norm = _norm_item(item)
        if norm["title"]:
            items.append(norm)
    if not items:
        return None     # S2 空结果（参考文献被出版方剔除等）→ OpenAlex 常有货
    return items


# ---------------- OpenAlex 兜底（免 key，llm-for-zotero 同款数据源） ----------------

def _norm_oa(w: dict) -> dict:
    loc = w.get("primary_location") or {}
    src = loc.get("source") or {}
    oa = w.get("open_access") or {}
    return {"s2_id": w.get("id", ""),
            "title": (w.get("title") or w.get("display_name") or "").strip(),
            "year": str(w.get("publication_year") or ""),
            "venue": src.get("display_name") or "",
            "abstract": "",
            "doi": (w.get("doi") or "").replace("https://doi.org/", ""),
            "arxiv": "", "authors": "",
            "citation_count": w.get("cited_by_count") or 0,
            "pdf_url": oa.get("oa_url") or ""}


def _oa_resolve_id(paper: dict) -> str | None:
    """DOI 直查 OpenAlex work id（W...）；无 DOI 走标题搜索。"""
    if paper.get("doi"):
        r = httpx.get(f"{_OA}/works/doi:{paper['doi'].lower()}",
                      params=_OA_MAILTO, timeout=20)
        if r.status_code == 200:
            return (r.json().get("id") or "").rsplit("/", 1)[-1] or None
        return None
    r = httpx.get(f"{_OA}/works", params={**_OA_MAILTO,
                  "filter": f"title.search:{paper.get('title') or ''}", "per-page": 1}, timeout=20)
    if r.status_code != 200:
        return None
    res = r.json().get("results") or []
    return (res[0].get("id") or "").rsplit("/", 1)[-1] if res else None


def _oa_list(url: str, params: dict) -> list[dict]:
    r = httpx.get(url, params={**_OA_MAILTO, **params}, timeout=25)
    r.raise_for_status()
    return [_norm_oa(w) for w in (r.json().get("results") or [])
            if (w.get("title") or w.get("display_name"))]


def _discover_openalex(paper: dict, mode: str, limit: int) -> list[dict]:
    wid = _oa_resolve_id(paper)
    if not wid:
        raise ValueError("未能定位该论文（DOI 与标题均未命中）")
    sel = "title,display_name,publication_year,primary_location,doi,open_access,cited_by_count"
    if mode == "rec":
        return _oa_list(f"{_OA}/works", {"filter": f"related_to:{wid}",
                                         "per-page": min(int(limit), 50), "select": sel})
    if mode == "cites":
        return _oa_list(f"{_OA}/works", {"filter": f"cites:{wid}",
                                         "per-page": min(int(limit), 50), "select": sel})
    # refs：取 referenced_works id 列表 → 批量水合标题
    r = httpx.get(f"{_OA}/works/{wid}",
                  params={**_OA_MAILTO, "select": "referenced_works"}, timeout=20)
    r.raise_for_status()
    ids = [w.rsplit("/", 1)[-1] for w in (r.json().get("referenced_works") or [])][:min(int(limit), 50)]
    if not ids:
        return []
    r2 = httpx.get(f"{_OA}/works", params={**_OA_MAILTO,
                   "filter": "openalex:" + "|".join(ids), "per-page": len(ids), "select": sel},
                   timeout=25)
    r2.raise_for_status()
    return [_norm_oa(w) for w in (r2.json().get("results") or [])
            if (w.get("title") or w.get("display_name"))]
