"""综述引用键表（survey-writer 方法论：准确性防线前移）。

设计要点（源自 96 篇综述实战教训）：
- **建表即冻结**：报告写作只允许用表内键；改键必重建表
- **证据分级**：api（元数据已经三源核验或本次在线核验命中）> watermark
  （arXiv 水印可从 doi/编号提取）> inferred（仅本地推断，**不得进正文**，
  进 NEED-MANUAL-CHECK 清单等人工/API 二次确认）> zh-manual（中文文献）
- **同年同键消歧**：第一作者姓+年份 相同 → a/b/c（按第一作者全名+标题排序，确定性）
- 中文文献键 =「首作者姓(2-4字)等，年份」（GB/T 中文惯例）

复用：cite.py _split_authors/_name_parts（姓氏提取，兼容 "Chen, W." 与
"Yang Fu" 两种形态）；meta.py verify_meta_online(apply=False)（在线核验
不写库——键表核验是只读探测，元数据正式落库仍走原确认流）。
"""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict

from .cite import _name_parts, _split_authors
from .db import db

# 综述内可引用的分级（inferred 排除）
CITABLE = {"api", "watermark", "zh-manual"}
_VERIFIED_SOURCES = {"arxiv", "s2", "crossref", "semantic scholar",
                     "arXiv", "Semantic Scholar", "CrossRef"}


def _is_cjk(s: str) -> bool:
    return bool(re.search(r"[一-鿿]", s or ""))


def _split(raw: str) -> list[str]:
    """作者串 → 作者列表。cite._split_authors 处理 ';'/逗号缩写并回，
    但不认 ' and ' 连接（LLM 提取与 arXiv 风格常见）——这里先归一化再复用它。"""
    if not raw or not raw.strip():
        return []
    normalized = re.sub(r"[,，]?\s+and\s+", "; ", raw, flags=re.I)
    return _split_authors(normalized)


def _surname(name: str) -> str:
    """作者全名 → 姓（NFKD 归一，去变音符）。"""
    fam, _ = _name_parts(name)
    fam = unicodedata.normalize("NFKD", fam or name or "")
    return fam.strip()


def _arxiv_of(p: dict) -> str:
    doi = (p.get("doi") or "").strip()
    m = re.search(r"10\.48550/arXiv\.([\d.]+[vV]?\d*)", doi, re.I)
    if m:
        return m.group(1)
    return ""


def _evidence_of(p: dict, api_hit: bool) -> str:
    """分级：api > watermark > inferred；中文文献单独 zh-manual。"""
    if api_hit:
        return "api"
    src = (p.get("meta_source") or "").strip()
    if (p.get("meta_verified_at") and src and src.lower() in
            {s.lower() for s in _VERIFIED_SOURCES}):
        return "api"
    if _arxiv_of(p) or re.search(r"arxiv", src or "", re.I):
        return "watermark"
    return "inferred"


def build_table(paper_rows: list[dict], api_check: bool = True,
                progress_cb=None) -> list[dict]:
    """构建冻结键表。paper_rows 为 papers 行 dict 列表。

    api_check=True 时对未核验论文逐篇在线核验（verify_meta_online
    apply=False，不写库）；核验命中 → evidence=api（年份/venue 取本地行，
    不擅改用户数据）。progress_cb(done,total) 供任务进度。
    """
    rows = []
    for i, p in enumerate(paper_rows):
        api_hit = False
        if api_check and not p.get("meta_verified_at"):
            try:
                from .meta import verify_meta_online
                r = verify_meta_online(p["id"], apply=False)
                api_hit = bool(r.get("verified"))
            except Exception:  # noqa: BLE001 —— 核验失败按本地证据分级，不阻塞建表
                pass
            if progress_cb:
                progress_cb(i + 1, len(paper_rows))

        title = (p.get("title") or p["id"]).strip()
        authors = _split(p.get("authors") or "")
        zh = _is_cjk(title) or (authors and _is_cjk(authors[0]))
        year = (p.get("year") or "").strip()[:4]
        if zh:
            # 中文键：首作者姓（取 2-4 个 CJK 字符）+ 等，年份
            m = re.search(r"[一-鿿]{2,4}", authors[0] if authors else title)
            base = (m.group(0) if m else "佚名") + "等"
            rows.append({"id": p["id"], "type": "zh", "key": f"{base}，{year}" if year else base,
                         "base": base, "authors": authors, "year": year,
                         "venue": (p.get("journal") or "").strip(),
                         "arxiv": _arxiv_of(dict(p)), "title": title,
                         "evidence": "zh-manual"})
            continue

        if not authors:
            base = p["id"]
        elif len(authors) == 1:
            base = _surname(authors[0]) or "Anon"
        elif len(authors) == 2:
            base = f"{_surname(authors[0])} & {_surname(authors[1])}"
        else:
            base = f"{_surname(authors[0])} et al."
        rows.append({"id": p["id"], "type": "en", "key": "", "base": base,
                     "authors": authors, "year": year,
                     "venue": (p.get("journal") or "").strip(),
                     "arxiv": _arxiv_of(dict(p)), "title": title,
                     "evidence": _evidence_of(dict(p), api_hit)})

    # 同年同键消歧：a/b/c（第一作者全名+标题排序，确定性）
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in rows:
        if e["type"] == "en" and e.get("year"):
            groups[(e["base"], e["year"])].append(e)
    for (_b, _y), es in groups.items():
        es.sort(key=lambda e: ((e["authors"] or [""])[0], e["title"]))
        multi = len(es) > 1
        for i, e in enumerate(es):
            e["key"] = f"{e['base']}, {e['year']}" + (chr(97 + i) if multi else "")
    for e in rows:      # 无年份的兜底键
        if e["type"] == "en" and not e["key"]:
            e["key"] = f"{e['base']}, n.d."
    return rows


def citable_entries(table: list[dict]) -> list[dict]:
    return [e for e in table if e.get("evidence") in CITABLE]


def need_manual(table: list[dict]) -> list[dict]:
    return [e for e in table if e.get("evidence") == "inferred"]


def render_references(table: list[dict], style: str = "author_year") -> str:
    """参考文献机械渲染（LLM 不生成——这是准确性防线的一部分）。

    author_year：按 key 字母序，行 = `- (Fei et al., 2024) 标题. venue, year. arXiv:xxx`
    numeric：按表序 [1]..[N]，行 = GB/T 著录（复用 cite.format_citation 的 gbt7714）
    """
    if style == "numeric":
        from .cite import format_citation
        lines = []
        for i, e in enumerate(citable_entries(table), 1):
            pseudo = {"title": e["title"], "authors": "; ".join(e.get("authors") or []),
                      "journal": e.get("venue") or "", "year": e.get("year") or "",
                      "doi": f"10.48550/arXiv.{e['arxiv']}" if e.get("arxiv") else "",
                      "volume": "", "issue": "", "pages": ""}
            lines.append(f"{i}. {format_citation(pseudo, 'gbt7714')}")
        return "\n".join(lines)
    lines = []
    for e in sorted(citable_entries(table), key=lambda x: x["key"]):
        bits = [f"- ({e['key']}) {e['title']}."]
        if e.get("venue"):
            bits.append(f"{e['venue']}, {e.get('year') or 'n.d.'}.")
        elif e.get("year"):
            bits.append(f"{e['year']}.")
        if e.get("arxiv"):
            bits.append(f"arXiv:{e['arxiv']}")
        lines.append(" ".join(bits))
    return "\n".join(lines)


# ---------------- 双向校验（survey-writer 脚本④的移植） ----------------

# 作者-年份引用模式（英文姓 et al./& 姓，年+可选 abc；中文 姓等，年）
_CITE_RE = re.compile(
    r"([A-ZÀ-ÿ][A-Za-zÀ-ÿ''\-]+(?:,? et al\.| & [A-ZÀ-ÿ][A-Za-zÀ-ÿ''\-]+)?, (?:19|20)\d{2}[a-c]?)"
    r"|([一-鿿]{2,4}等[，,] ?(?:19|20)\d{2})")

_TIERS_CJK = {"quick": (0, 10 ** 9), "standard": (5000, 12000), "deep": (12000, 10 ** 9)}


def verify_report(report_md: str, table: list[dict], style: str = "author_year",
                  tier: str = "quick") -> dict:
    """双向引用校验。返回 {pass, missing, phantom, stale, refs_n, table_n, cjk}。

    - missing：表（citable）有、正文无 —— 覆盖率缺口
    - phantom：正文有、表无 —— 幻影引用（模型编造）
    - stale：正文出现 "…, 2025b" 而该作者当年无多版本分组 —— 残留旧键
    - refs_n：参考文献列表条数 vs citable 表数
    """
    body = report_md.split("## 参考文献")[0]
    citable = citable_entries(table)
    keys = [e["key"] for e in citable]

    if style == "numeric":
        used = set()
        for m in re.finditer(r"\[(\d{1,3})\]", body):
            used.add(int(m.group(1)))
        table_ns = {i + 1 for i in range(len(citable))}
        missing = [citable[n - 1]["key"] for n in sorted(table_ns - used)]
        phantom = sorted(f"[{n}]" for n in used - table_ns if n != 0)
    else:
        missing = [k for k in keys if k not in body]
        body_keys = {re.sub(r"\s+", " ", m.group(0)) for m in _CITE_RE.finditer(body)}
        phantom = sorted(body_keys - set(keys))

    stale = []
    if style != "numeric":
        suffix_in_body = set(re.findall(
            r"([A-ZÀ-ÿ][A-Za-zÀ-ÿ''\-]+)(?= et al\., (?:19|20)\d{2}[b-z])", body))
        authors_multi = {e["base"].split()[0] for e in citable
                         if e.get("base") and re.search(r"[a-c]$", e["key"] or "")}
        stale = sorted(suffix_in_body - authors_multi)

    refs_part = report_md.split("## 参考文献", 1)
    refs_n = len(re.findall(r"^(?:\d+\. |- )", refs_part[1], re.M)) if len(refs_part) > 1 else 0
    cjk = len(re.findall(r"[一-鿿]", body))
    lo, hi = _TIERS_CJK.get(tier, (0, 10 ** 9))

    ok = (not missing and not phantom and not stale
          and (not refs_n or refs_n == len(citable))
          and lo <= cjk <= hi)
    return {"pass": ok, "missing": missing, "phantom": phantom, "stale": stale,
            "refs_n": refs_n, "table_n": len(citable), "cjk": cjk}
