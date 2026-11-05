"""文献元数据：规则提取（摘要）+ LLM 提取（作者/期刊/年份/DOI/关键词）."""
from __future__ import annotations

import json
import re

from .db import db


def extract_abstract_from_blocks(blocks: list) -> str:
    """规则提取摘要：Abstract 小节的正文块拼接。"""
    texts = []
    in_abs = False
    for b in blocks:
        sec = (b["section_path"] or "").lower()
        if re.search(r"\babstract\b", sec):
            in_abs = True
            continue
        if in_abs:
            # 进入下一节（Introduction 等）即结束
            if re.search(r"\b(introduction|keywords|keywords:\s*)\b", sec) or b["type"] == "title":
                break
            t = (b["text"] or "").strip()
            if t and b["type"] not in ("page_number", "aside_text", "header", "footer"):
                texts.append(t)
    return "\n".join(texts)[:3000]


def _first_pages_context(paper_id: str, max_chars: int = 9000) -> str:
    rows = db.all(
        "SELECT b.type, b.section_path, b.text FROM blocks b JOIN parse_runs r ON r.id=b.parse_run_id "
        "WHERE b.paper_id=? AND r.status='done' AND b.page_index <= 1 "
        "AND b.type NOT IN ('page_number','aside_text','header','footer') "
        "ORDER BY b.page_index, b.block_index",
        (paper_id,),
    )
    out = []
    used = 0
    for r in rows:
        t = (r["text"] or "").strip()
        if not t:
            continue
        line = f"[{r['type']}] {t}"
        if used + len(line) > max_chars:
            break
        out.append(line)
        used += len(line)
    return "\n\n".join(out)


def extract_meta_llm(user_id: int, paper_id: str) -> dict:
    """用用户 chat key 从首页提取作者/期刊/年份/DOI/关键词。"""
    from .llm import LLMClient, resolve_llm

    cfg = resolve_llm(user_id, "chat")
    paper = db.one("SELECT title, abstract FROM papers WHERE id=?", (paper_id,))
    if paper is None:
        raise ValueError("论文不存在")
    context = _first_pages_context(paper_id)
    if not context:
        raise ValueError("尚未解析完成")

    client = LLMClient(cfg, user_id=user_id, paper_id=paper_id)
    raw = client.complete([
        {"role": "system", "content":
            "从论文首页文本中提取文献元数据，只输出 JSON：\n"
            '{"authors": ["姓 名", ...], "journal": "期刊/会议名，没有则空串", '
            '"year": "2024", "doi": "", "keywords": ["...", ...], "abstract_zh": "中文摘要（3句内）"}\n'
            "规则：authors 按原文顺序；year 取发表年份；keywords 无则空数组；"
            "abstract_zh 依据 Abstract 部分概括，不编造。"},
        {"role": "user", "content": f"标题：{paper['title']}\n\n{context}"},
    ], max_tokens=1500)
    try:
        start, end = raw.index("{"), raw.rindex("}") + 1
        data = json.loads(raw[start:end])
    except ValueError:
        raise RuntimeError("元数据提取失败：模型输出无效")

    with db.write() as c:
        c.execute(
            "UPDATE papers SET authors=?, journal=?, year=?, doi=?, keywords=?, abstract=? "
            "WHERE id=?",
            (", ".join(data.get("authors", []))[:400], data.get("journal", "")[:200],
             str(data.get("year", ""))[:8], data.get("doi", "")[:100],
             json.dumps(data.get("keywords", []), ensure_ascii=False)[:500],
             data.get("abstract_zh", "") or paper["abstract"] or "",
             paper_id),
        )
    return data


def get_references(paper_id: str, limit: int = 300) -> list[dict]:
    """参考文献列表（References 小节的 ref_text 块，带页码可跳转）。"""
    rows = db.all(
        "SELECT b.block_id, b.text, b.page_index FROM blocks b "
        "JOIN parse_runs r ON r.id=b.parse_run_id "
        "WHERE b.paper_id=? AND r.status='done' AND b.type='ref_text' "
        "ORDER BY b.page_index, b.block_index LIMIT ?",
        (paper_id, limit),
    )
    return [{"block_id": r["block_id"], "text": r["text"], "page_index": r["page_index"]} for r in rows]


# ================= 联网元数据校准（arXiv → CrossRef） =================
# 只把 标题/arXiv号/DOI 发往公开书目服务；论文内容永不出网

import difflib
import xml.etree.ElementTree as ET

import httpx


def _find_arxiv_id(paper_id: str) -> str | None:
    row = db.one(
        "SELECT text FROM blocks WHERE paper_id=? AND text LIKE '%arXiv:%' LIMIT 1", (paper_id,))
    if not row:
        return None
    m = re.search(r"arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?", row["text"])
    return m.group(1) if m else None


def _title_ratio(a: str, b: str) -> float:
    a = re.sub(r"\W+", " ", (a or "").lower()).strip()
    b = re.sub(r"\W+", " ", (b or "").lower()).strip()
    return difflib.SequenceMatcher(None, a, b).ratio()


def _verify_arxiv(arxiv_id: str, title: str) -> dict | None:
    r = httpx.get(f"https://export.arxiv.org/api/query?id_list={arxiv_id}", timeout=15)
    if r.status_code != 200:
        return None
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(r.text)
    entry = root.find("a:entry", ns)
    if entry is None:
        return None
    t = (entry.findtext("a:title", "", ns) or "").strip().replace("\n", " ")
    if _title_ratio(t, title) < 0.75:
        return None
    authors = [e.findtext("a:name", "", ns) for e in entry.findall("a:author", ns)]
    year = (entry.findtext("a:published", "", ns) or "")[:4]
    return {"authors": ", ".join(a for a in authors if a), "year": year,
            "journal": "arXiv preprint", "doi": f"10.48550/arXiv.{arxiv_id}",
            "source": "arXiv", "title": t, "match": round(_title_ratio(t, title), 2)}


def _verify_s2(title: str) -> dict | None:
    """Semantic Scholar 标题精确匹配（带 key）。"""
    from .config import S2_API_KEY
    r = httpx.get(
        "https://api.semanticscholar.org/graph/v1/paper/search/match",
        params={"query": title, "fields": "title,year,venue,authors,externalIds"},
        headers={"x-api-key": S2_API_KEY} if S2_API_KEY else {}, timeout=15)
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        return None
    d = r.json().get("data") or [{}]
    p = d[0] if d else {}
    if not p or _title_ratio(p.get("title", ""), title) < 0.75:
        return None
    ext = p.get("externalIds") or {}
    doi = ext.get("DOI") or (f"10.48550/arXiv.{ext['ArXiv']}" if ext.get("ArXiv") else "")
    return {"authors": ", ".join(a.get("name", "") for a in (p.get("authors") or [])),
            "year": str(p.get("year") or ""), "journal": p.get("venue") or "",
            "doi": doi, "source": "Semantic Scholar",
            "title": p.get("title", ""), "match": round(_title_ratio(p.get("title", ""), title), 2)}


def _verify_crossref(title: str) -> dict | None:
    r = httpx.get("https://api.crossref.org/works",
                  params={"query.bibliographic": title, "rows": 1},
                  headers={"User-Agent": "paper-system/1.0 (mailto:admin@local)"} , timeout=15)
    if r.status_code != 200:
        return None
    items = r.json().get("message", {}).get("items", [])
    if not items:
        return None
    it = items[0]
    cand_title = (it.get("title") or [""])[0]
    ratio = _title_ratio(cand_title, title)
    if ratio < 0.75:
        return None
    authors = ", ".join(
        f"{a.get('given','')} {a.get('family','')}".strip() for a in it.get("author", []))
    year = ""
    for k in ("published-print", "published-online", "created", "issued"):
        parts = it.get(k, {}).get("date-parts", [])
        if parts and parts[0] and parts[0][0]:
            year = str(parts[0][0]); break
    return {"authors": authors[:400], "year": year,
            "journal": (it.get("container-title") or [""])[0],
            "doi": it.get("DOI", ""), "source": "CrossRef",
            "title": cand_title, "match": round(ratio, 2)}


def verify_meta_online(paper_id: str) -> dict:
    """联网校准元数据：arXiv 优先（预印本），否则 CrossRef。标题匹配≥0.75 才写入。"""
    paper = db.one("SELECT title FROM papers WHERE id=?", (paper_id,))
    if paper is None:
        raise ValueError("论文不存在")
    title = paper["title"]
    if not title:
        raise ValueError("缺少标题，无法校准")

    candidate = None
    arxiv_id = _find_arxiv_id(paper_id)
    if arxiv_id:
        try:
            candidate = _verify_arxiv(arxiv_id, title)
        except httpx.HTTPError:
            candidate = None
    if candidate is None:
        try:
            candidate = _verify_s2(title)
        except httpx.HTTPError:
            candidate = None
    if candidate is None:
        try:
            candidate = _verify_crossref(title)
        except httpx.HTTPError:
            candidate = None
    if candidate is None:
        return {"verified": False, "message": "未在 arXiv/CrossRef 匹配到该论文（标题相似度<0.75），未改动本地元数据"}

    with db.write() as c:
        c.execute(
            "UPDATE papers SET authors=?, journal=?, year=?, doi=?, "
            "meta_source=?, meta_verified_at=datetime('now') WHERE id=?",
            (candidate["authors"], candidate["journal"], candidate["year"],
             candidate["doi"], candidate["source"], paper_id),
        )
    return {"verified": True, "candidate": candidate}


def canonical_name(paper) -> str:
    """规范文件名：首作者姓+年份+标题（导出/PDF下载统一使用；元数据更新自动跟随）."""
    import re as _re

    def g(k):
        try:
            return paper[k] or ""
        except (IndexError, KeyError):
            return ""
    title = g("title").strip() or paper["id"]
    authors = g("authors").strip()
    year = g("year").strip()
    surname = ""
    if authors:
        first = authors.split(",")[0].strip()
        tokens = first.split()
        surname = tokens[-1] if tokens else first
    name = f"{surname}{year} {title}" if surname or year else title
    name = _re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name)
    return _re.sub(r"\s+", " ", name).strip()[:180]
