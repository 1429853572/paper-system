"""标识符导入（zotero-mcp 式）：DOI / arXiv ID / BibTeX → 元数据 + OA PDF。

流程：解析标识符 → S2/CrossRef/arXiv 取元数据 → S2 openAccessPdf →
Unpaywall 兜底 → 落地页转直链 → 交给调用方走既有 import 链路。
"""
from __future__ import annotations

import re

import httpx

from .config import S2_API_KEY
from .discover import resolve_direct_pdf

_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>，,;；]+)", re.I)
_ARXIV_RE = re.compile(r"\b(?:arxiv[:\s]*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.I)
_BIBTEX_RE = re.compile(r"@(\w+)\s*\{", re.I)


def parse_identifiers(text: str) -> list[dict]:
    """从自由文本（可多行多条）提取标识符。返回 [{kind, value}]，去重保序。"""
    text = (text or "").strip()
    out: list[dict] = []
    seen: set[str] = set()

    def add(kind: str, value: str) -> None:
        v = value.strip().rstrip(".,;）)")
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append({"kind": kind, "value": v})

    # BibTeX 条目：提取其中的 doi / arxiv id；都没有则把整块交给标题匹配
    if _BIBTEX_RE.search(text):
        blocks = re.split(r"(?=@\w+\s*\{)", text)
        for b in blocks:
            if not _BIBTEX_RE.search(b):
                continue
            doi = _DOI_RE.search(b)
            ax = _ARXIV_RE.search(b)
            title = re.search(r"title\s*=\s*[{\"](.*?)[}\"]\s*,?\s*\n", b, re.I | re.S)
            if doi:
                add("doi", doi.group(1))
            elif ax:
                add("arxiv", ax.group(1))
            elif title:
                add("title", re.sub(r"\s+", " ", title.group(1)).strip())
        if out:
            return out[:10]

    for m in _DOI_RE.finditer(text):
        add("doi", m.group(1))
    for m in _ARXIV_RE.finditer(text):
        # 避免把 DOI 里的数字误判成 arXiv id（DOI 已在上面处理，这里看前缀）
        prefix = text[max(0, m.start() - 8):m.start()].lower()
        if "doi" not in prefix and "10." not in prefix:
            add("arxiv", m.group(1))
    # 裸标题：像标题的长行（无标识符命中时）
    if not out:
        for line in text.splitlines():
            line = line.strip().strip('-•* ')
            if len(line) >= 15 and not _DOI_RE.search(line):
                add("title", line)
                break
    return out[:10]


def _headers() -> dict:
    return {"x-api-key": S2_API_KEY} if S2_API_KEY else {}


def _meta_from_s2(sid: str) -> dict | None:
    fields = "title,year,venue,abstract,externalIds,openAccessPdf,authors,journal"
    r = httpx.get(f"https://api.semanticscholar.org/graph/v1/paper/{sid}",
                  params={"fields": fields}, headers=_headers(), timeout=20)
    if r.status_code != 200:
        return None
    d = r.json()
    ext = d.get("externalIds") or {}
    j = d.get("journal") or {}
    return {"title": d.get("title") or "", "year": str(d.get("year") or ""),
            "journal": j.get("name") or d.get("venue") or "",
            "volume": str(j.get("volume") or ""), "pages": str(j.get("pages") or ""),
            "abstract": d.get("abstract") or "",
            "authors": ", ".join(a.get("name", "") for a in (d.get("authors") or [])),
            "doi": ext.get("DOI") or "", "arxiv": ext.get("ArXiv") or "",
            "pdf_url": (d.get("openAccessPdf") or {}).get("url") or ""}


def _meta_from_crossref(doi: str) -> dict | None:
    r = httpx.get(f"https://api.crossref.org/works/{doi}",
                  headers={"User-Agent": "paper-system/1.0 (mailto:admin@local)"}, timeout=20)
    if r.status_code != 200:
        return None
    m = r.json().get("message", {})
    authors = ", ".join(f"{a.get('family', '')} {a.get('given', '')}".strip()
                        for a in (m.get("author") or []))
    return {"title": (m.get("title") or [""])[0], "year": str((m.get("issued", {})
            .get("date-parts") or [[""]])[0][0] or ""),
            "journal": (m.get("container-title") or [""])[0],
            "volume": str(m.get("volume") or ""), "issue": str(m.get("issue") or ""),
            "pages": str(m.get("page") or ""), "abstract": re.sub(r"<[^>]+>", "", m.get("abstract") or ""),
            "authors": authors, "doi": doi, "arxiv": "", "pdf_url": ""}


def _unpaywall_pdf(doi: str) -> str:
    try:
        r = httpx.get(f"https://api.unpaywall.org/v2/{doi}",
                      params={"email": "admin@paper-system.local"}, timeout=15)
        if r.status_code != 200:
            return ""
        loc = r.json().get("best_oa_location") or {}
        return loc.get("url_for_pdf") or loc.get("url") or ""
    except Exception:  # noqa: BLE001
        return ""


def resolve_identifier(kind: str, value: str) -> dict:
    """标识符 → 完整元数据 + OA 直链 PDF。找不到抛 ValueError。

    kind: doi | arxiv | title
    """
    meta: dict | None = None
    if kind == "doi":
        meta = _meta_from_s2("DOI:" + value) or _meta_from_crossref(value)
        if meta is None:
            raise ValueError(f"DOI 未命中（S2/CrossRef 均无记录）: {value}")
        meta["pdf_url"] = meta.get("pdf_url") or _unpaywall_pdf(value)
    elif kind == "arxiv":
        meta = _meta_from_s2("arXiv:" + value) or _meta_from_s2("DOI:10.48550/arXiv." + value)
        meta = meta or {}
        if not meta.get("title"):
            try:
                r = httpx.get("https://export.arxiv.org/api/query",
                              params={"id_list": value}, timeout=20)
                entries = re.findall(r"<entry>(.*?)</entry>", r.text, re.S)
                if entries:
                    title = re.search(r"<title>([^<]+)</title>", entries[0].replace("\n", " "))
                    summ = re.search(r"<summary>(.*?)</summary>", entries[0], re.S)
                    if title:
                        meta = {"title": title.group(1).strip(), "year": "", "journal": "arXiv",
                                "volume": "", "pages": "", "abstract": (summ.group(1).strip() if summ else ""),
                                "authors": ", ".join(re.findall(r"<name>([^<]+)</name>", entries[0])),
                                "doi": f"10.48550/arXiv.{value}", "arxiv": value,
                                "pdf_url": f"https://arxiv.org/pdf/{value}"}
            except Exception:  # noqa: BLE001
                pass
        if not meta.get("title"):
            raise ValueError(f"arXiv ID 未命中: {value}")
        if not meta.get("pdf_url"):
            meta["pdf_url"] = f"https://arxiv.org/pdf/{value}"   # arXiv 必有 PDF
    elif kind == "title":
        r = httpx.get("https://api.semanticscholar.org/graph/v1/paper/search/match",
                      params={"query": value, "fields": "title,year,venue,abstract,externalIds,openAccessPdf,authors,journal"},
                      headers=_headers(), timeout=20)
        if r.status_code != 200:
            raise ValueError(f"标题匹配失败（S2 无记录）: {value[:60]}")
        d = (r.json().get("data") or [{}])[0]
        ext = d.get("externalIds") or {}
        j = d.get("journal") or {}
        meta = {"title": d.get("title") or value, "year": str(d.get("year") or ""),
                "journal": j.get("name") or d.get("venue") or "",
                "volume": str(j.get("volume") or ""), "pages": str(j.get("pages") or ""),
                "abstract": d.get("abstract") or "",
                "authors": ", ".join(a.get("name", "") for a in (d.get("authors") or [])),
                "doi": ext.get("DOI") or "", "arxiv": ext.get("ArXiv") or "",
                "pdf_url": (d.get("openAccessPdf") or {}).get("url") or ""}
        if not meta["pdf_url"] and meta["doi"]:
            meta["pdf_url"] = _unpaywall_pdf(meta["doi"])
    else:
        raise ValueError("未知标识符类型")
    if meta.get("pdf_url"):
        meta["pdf_url"] = resolve_direct_pdf(meta["pdf_url"])
    return meta
