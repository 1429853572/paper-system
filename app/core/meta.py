"""文献元数据：规则提取（摘要）+ LLM 提取（作者/期刊/年份/DOI/关键词）."""
from __future__ import annotations

import json
import re

from .db import db


def extract_abstract_blocks(blocks: list) -> tuple[str, list[str]]:
    """规则提取摘要：Abstract 小节的正文块拼接。返回 (文本, 块id 列表)——
    块 id 存 papers.abstract_src，翻译完成后按 id 精确取译文回填中文摘要
    （双栏论文的 section_path 有噪声，翻译期再定位不可靠，须在解析期锁定）。

    blocks 先按 (页码, bbox 左上 y, x) 几何排序——MinerU 的 block_index 在
    部分版面（跨栏/图文混排）下不是阅读序，实测会把小节正文排到摘要前。"""
    def _pos(b):
        k = b.keys()   # dict 与 sqlite3.Row 通用
        page = b["page_index"] if "page_index" in k else 0
        try:
            box = json.loads(b["bbox"])
            if isinstance(box, list) and box and isinstance(box[0], list):
                box = box[0]
            return (page, float(box[1]), float(box[0]))
        except Exception:
            return (page, 9e9, 9e9)
    blocks = sorted(blocks, key=_pos)
    texts: list[str] = []
    ids: list[str] = []
    in_abs = False
    for b in blocks:
        sec = (b["section_path"] or "").lower()
        t = (b["text"] or "").strip()
        is_abs_sec = bool(re.search(r"\babstract\b", sec))
        if not in_abs:
            # 锚点 A：Abstract 标题块（标准版式）→ 从其后开始收
            if b["type"] == "title" and (re.fullmatch(r"abstract[:\s]*", t, re.I) or is_abs_sec):
                in_abs = True
            # 锚点 B：无独立标题的版式——正文块自带 abstract 小节归属 → 直收看
            # 锚点 C：内联标题（"Abstract. 3DGS has..." 无独立标题块）→ 从该块收起
            elif (is_abs_sec or re.match(r"abstract\b", t, re.I)) and b["type"] == "text":
                texts.append(t)
                ids.append(b["block_id"])
                in_abs = True
            continue
        # 已进入摘要：进入下一节（Introduction/Keywords/编号小节）即结束；
        # 重复的 Abstract 标题（多 run JOIN/版面重复）跳过不 break
        if re.search(r"\b(introduction|keywords)\b", sec):
            break
        if b["type"] == "title":
            if re.fullmatch(r"abstract[:\s]*", t, re.I):
                continue
            break
        if t and b["type"] not in ("page_number", "aside_text", "header", "footer"):
            texts.append(t)
            ids.append(b["block_id"])
    return "\n".join(texts)[:3000], ids


def extract_abstract_from_blocks(blocks: list) -> str:
    return extract_abstract_blocks(blocks)[0]


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


def _merge_abstract(cur_abs: str | None, zh_abs: str | None) -> str:
    """abstract 字段收敛为中文摘要：已中文保持；英文原文/空 → 用翻译覆盖。"""
    cur_abs = (cur_abs or "").strip()
    zh_abs = (zh_abs or "").strip()
    if cur_abs and re.search(r"[\u4e00-\u9fff]", cur_abs):
        return cur_abs[:3000]
    return (zh_abs or cur_abs)[:3000]


def refresh_abstract_from_translations(paper_id: str) -> bool:
    """翻译完成后把 papers.abstract 收敛为忠实翻译（零 LLM 成本）。

    块来源优先 papers.abstract_src（解析期锁定的摘要块 id）；旧解析无该列
    时现场跑规则提取器定位。摘要块译文存在且非空才回填，否则不动。"""
    ids: list[str] = []
    src = db.one("SELECT abstract_src FROM papers WHERE id=?", (paper_id,))
    if src and src["abstract_src"]:
        try:
            ids = json.loads(src["abstract_src"])
        except (TypeError, ValueError):
            ids = []
    if not ids:
        run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                     "ORDER BY created_at DESC LIMIT 1", (paper_id,))
        if run is None:
            return False
        blocks = db.all(
            "SELECT block_id, type, section_path, text, page_index, bbox FROM blocks "
            "WHERE parse_run_id=? ORDER BY block_index", (run["id"],))
        _, ids = extract_abstract_blocks(blocks)
    if not ids:
        return False
    marks = ",".join("?" * len(ids))
    rows = db.all(
        f"SELECT t.text_zh FROM translations t JOIN blocks b ON b.block_id=t.block_id "
        f"WHERE t.block_id IN ({marks}) AND t.text_zh<>'' "
        f"ORDER BY b.block_index", tuple(ids))
    zh = "\n".join((r["text_zh"] or "").strip() for r in rows if (r["text_zh"] or "").strip())
    if not zh:
        return False
    with db.write() as c:
        c.execute("UPDATE papers SET abstract=? WHERE id=?", (zh[:3000], paper_id))
    return True


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
            '"year": "2024", "doi": "", "keywords": ["...", ...], "abstract_zh": "Abstract 的完整中文翻译"}\n'
            "规则：authors 按原文顺序；year 取发表年份；keywords 无则空数组；"
            "abstract_zh 是 Abstract 部分的完整忠实中文翻译——逐句对应原文，"
            "不概括、不删减、不添加评价。"},
        {"role": "user", "content": f"标题：{paper['title']}\n\n{context}"},
    ], max_tokens=1500)
    try:
        start, end = raw.index("{"), raw.rindex("}") + 1
        data = json.loads(raw[start:end])
    except ValueError:
        raise RuntimeError("元数据提取失败：模型输出无效")

    # AI 补全语义：已有（校准/规则/人工）字段优先，AI 只填空缺
    cur = db.one("SELECT authors, journal, year, doi, keywords, abstract FROM papers WHERE id=?",
                 (paper_id,))
    # abstract 字段语义 = 中文摘要（原文在 PDF 块里，点击定位可达）：
    # 现值已是中文 → 保持；现值是英文原文（规则提取）或空 → 用完整翻译覆盖
    merged = {
        "authors": (cur["authors"] or ", ".join(data.get("authors", [])))[:400],
        "journal": (cur["journal"] or data.get("journal", ""))[:200],
        "year": (cur["year"] or str(data.get("year", "")))[:8],
        "doi": (cur["doi"] or data.get("doi", ""))[:100],
        "keywords": (cur["keywords"] or json.dumps(data.get("keywords", []), ensure_ascii=False))[:500],
        "abstract": _merge_abstract(cur["abstract"], data.get("abstract_zh", "")),
    }
    with db.write() as c:
        c.execute(
            "UPDATE papers SET authors=?, journal=?, year=?, doi=?, keywords=?, abstract=? "
            "WHERE id=?",
            (merged["authors"], merged["journal"], merged["year"], merged["doi"],
             merged["keywords"], merged["abstract"], paper_id),
        )
    return {**data, **merged}


_REF_NUM = re.compile(r"^\s*(?:\[\d{1,4}\]|\d{1,3}[.)])\s*")


def get_references(paper_id: str, limit: int = 300) -> list[dict]:
    """参考文献列表（References 小节的 ref_text 块，带页码可跳转）。

    跨页/跨栏的参考文献会被版面分析切成两块：编号块断在句中，续块以
    小写开头且无编号——列表里表现为一条参考文献裂成两条。此处按
    「无编号 + 小写开头（或前块连字符收尾）→ 并入上一条」合并；
    block_id/page_index 保留起始块（点击跳转仍定位到条目开头）。
    无编号但大写开头的块（如 Disclaimer/Publisher's Note）是独立条目，
    不并入。"""
    rows = db.all(
        "SELECT b.block_id, b.text, b.page_index FROM blocks b "
        "JOIN parse_runs r ON r.id=b.parse_run_id "
        "WHERE b.paper_id=? AND r.status='done' AND b.type='ref_text' "
        "ORDER BY b.page_index, b.block_index LIMIT ?",
        (paper_id, limit),
    )
    out: list[dict] = []
    for r in rows:
        t = (r["text"] or "").strip()
        if not t:
            continue
        numbered = bool(_REF_NUM.match(t))
        lower_cont = t[:1].islower()
        hyphen_cont = bool(out) and out[-1]["text"].rstrip().endswith("-")
        if out and (lower_cont or hyphen_cont) and not numbered:
            prev = out[-1]
            base = prev["text"].rstrip()
            if base.endswith("-"):           # Proceed- + ingss → 去连字符拼词
                prev["text"] = base[:-1] + t
            else:
                prev["text"] = base + " " + t
            continue
        out.append({"block_id": r["block_id"], "text": t, "page_index": r["page_index"]})
    return out


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
            "journal": "arXiv preprint", "volume": "", "issue": "", "pages": "",
            "doi": f"10.48550/arXiv.{arxiv_id}",
            "source": "arXiv", "title": t, "match": round(_title_ratio(t, title), 2)}


def _verify_s2(title: str) -> dict | None:
    """Semantic Scholar 标题精确匹配（带 key）。"""
    from .config import S2_API_KEY
    r = httpx.get(
        "https://api.semanticscholar.org/graph/v1/paper/search/match",
        params={"query": title, "fields": "title,year,venue,authors,externalIds,journal"},
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
    j = p.get("journal") or {}
    pages = str(j.get("pages") or "")
    return {"authors": ", ".join(a.get("name", "") for a in (p.get("authors") or [])),
            "year": str(p.get("year") or ""), "journal": j.get("name") or p.get("venue") or "",
            "volume": str(j.get("volume") or ""), "issue": "", "pages": pages,
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
            "volume": str(it.get("volume") or ""), "issue": str(it.get("issue") or ""),
            "pages": str(it.get("page") or ""),
            "doi": it.get("DOI", ""), "source": "CrossRef",
            "title": cand_title, "match": round(ratio, 2)}


def _verify_openalex(title: str) -> dict | None:
    """OpenAlex 标题检索（免费无 key；覆盖面大，含 CrossRef 缺收的会议/预印本）。"""
    r = httpx.get("https://api.openalex.org/works",
                  params={"search": title, "per-page": 1,
                          "select": "title,publication_year,authorships,primary_location,"
                                    "doi,biblio"},
                  headers={"User-Agent": "paper-system/1.0 (mailto:admin@local)"}, timeout=15)
    if r.status_code != 200:
        return None
    results = r.json().get("results") or []
    if not results:
        return None
    it = results[0]
    cand_title = it.get("title") or ""
    ratio = _title_ratio(cand_title, title)
    if ratio < 0.75:
        return None
    authors = ", ".join(a["author"]["display_name"] for a in (it.get("authorships") or [])
                        if a.get("author"))
    loc = it.get("primary_location") or {}
    src = (loc.get("source") or {})
    bib = it.get("biblio") or {}
    return {"authors": authors[:400], "year": str(it.get("publication_year") or ""),
            "journal": src.get("display_name") or "",
            "volume": str(bib.get("volume") or ""), "issue": str(bib.get("issue") or ""),
            "pages": str(bib.get("first_page") or ""),
            "doi": (it.get("doi") or "").replace("https://doi.org/", ""),
            "source": "OpenAlex", "title": cand_title,
            "match": round(ratio, 2)}


def _verify_dblp(title: str) -> dict | None:
    """DBLP 标题检索（计算机科学会议/期刊元数据最权威，CVPR/ICCV 等年份与 venue 可靠）。"""
    r = httpx.get("https://dblp.org/search/publ/api",
                  params={"q": title, "h": 1, "format": "json"}, timeout=15)
    if r.status_code != 200:
        return None
    hits = ((r.json().get("result") or {}).get("hits") or {}).get("hit") or []
    if not hits:
        return None
    it = hits[0].get("info") or {}
    cand_title = it.get("title") or ""
    ratio = _title_ratio(cand_title, title)
    if ratio < 0.75:
        return None
    a = it.get("authors") or {}
    authors = ", ".join(x["text"] for x in (a.get("author") or [])) \
        if isinstance(a, dict) else ""
    venue = str(it.get("venue") or "")
    return {"authors": authors[:400], "year": str(it.get("year") or ""),
            "journal": venue, "volume": "", "issue": "", "pages": str(it.get("pages") or ""),
            "doi": it.get("doi") or "", "source": "DBLP", "title": cand_title,
            "match": round(ratio, 2)}


def _verify_pdf_native(paper_id: str) -> dict | None:
    """PDF 原件本地提取年份（零网络，mutool）——五个联网源都查不到的
    camera-ready 会议论文兜底（CVF/IEEE 开放版封面自带会议名+年份；
    arXiv 版水印含提交日期）。候选字段与现有元数据合并：只补年份，
    作者/期刊等保持原样（本源拿不到这些，不能清空用户数据）。"""
    import subprocess

    from .config import DATA_DIR
    path = DATA_DIR / "papers" / paper_id / "original.pdf"
    if not path.exists():
        return None
    try:
        out = subprocess.run(
            ["mutool", "draw", "-F", "text", "-o", "-", str(path), "1-2"],
            capture_output=True, timeout=60).stdout.decode("utf-8", "ignore")
        info = subprocess.run(["mutool", "info", str(path)],
                              capture_output=True, timeout=60).stdout.decode("utf-8", "ignore")
    except Exception:
        return None
    year = ""
    m = re.search(r"arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s+\[[^\]]*\]\s+\d{1,2}\s+\w+\s+(20[12]\d)", out)
    if m:
        year = m.group(1)
    else:
        m2 = re.search(r"\b(?:ICLR|NeurIPS|NIPS|CVPR|ICCV|ECCV|AAAI|SIGGRAPH|3DV|WACV)\s+(20[12]\d)", out)
        if m2:
            year = m2.group(1)
        else:
            m3 = re.search(r"©\s*(20[12]\d)", out)
            if m3:
                year = m3.group(1)
            else:
                m4 = re.search(r"CreationDate\(D:(20[12]\d)", info)
                if m4:
                    year = m4.group(1)
    if not year:
        return None
    cur = db.one("SELECT authors, journal, doi, volume, issue, pages, title FROM papers WHERE id=?",
                 (paper_id,))
    return {"authors": cur["authors"] or "", "year": year,
            "journal": cur["journal"] or "", "volume": cur["volume"] or "",
            "issue": cur["issue"] or "", "pages": cur["pages"] or "",
            "doi": cur["doi"] or "", "source": "PDF 原件",
            "title": cur["title"] or "", "match": 1.0}


def verify_meta_online(paper_id: str, apply: bool = True,
                       candidate: dict | None = None) -> dict:
    """联网校准元数据：arXiv 优先（预印本），否则 S2/CrossRef/OpenAlex/DBLP。标题匹配≥0.75 才写入。

    apply=False 只出候选不写库（jasminum 式：先看改前→改后，人工确认再落）；
    candidate 传入时跳过外网解析直接用（确认写入的回传路径）。
    """
    paper = db.one("SELECT title FROM papers WHERE id=?", (paper_id,))
    if paper is None:
        raise ValueError("论文不存在")
    title = paper["title"]
    if not title:
        raise ValueError("缺少标题，无法校准")

    if candidate is None:
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
            try:
                candidate = _verify_openalex(title)
            except httpx.HTTPError:
                candidate = None
        if candidate is None:
            try:
                candidate = _verify_dblp(title)
            except httpx.HTTPError:
                candidate = None
        if candidate is None:
            try:
                candidate = _verify_pdf_native(paper_id)
            except Exception:
                candidate = None
    if candidate is None:
        return {"verified": False, "message": "未在 arXiv/S2/CrossRef/OpenAlex/DBLP 匹配到该论文（标题相似度<0.75），未改动本地元数据"}

    if not apply:
        return {"verified": True, "candidate": candidate, "applied": False}
    with db.write() as c:
        c.execute(
            "UPDATE papers SET authors=?, journal=?, year=?, doi=?, "
            "volume=COALESCE(NULLIF(?,''), volume), "
            "issue=COALESCE(NULLIF(?,''), issue), "
            "pages=COALESCE(NULLIF(?,''), pages), "
            "meta_source=?, meta_verified_at=datetime('now') WHERE id=?",
            (candidate["authors"], candidate["journal"], candidate["year"],
             candidate["doi"], candidate.get("volume", ""), candidate.get("issue", ""),
             candidate.get("pages", ""), candidate["source"], paper_id),
        )
    return {"verified": True, "candidate": candidate, "applied": True}


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
