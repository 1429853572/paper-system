"""引用格式化：GB/T 7714 / APA / MLA / BibTeX。

交互约定（前端）：
- 一次返回全部样式，前端切换样式零延迟（对应 Zotero 的样式下拉即时预览）；
- 不弹窗——引用文本直接在卡片里显示供预览，旁边给「样式 + 复制」。

返回的是"片段"列表 [(文本, 是否斜体)]：
- 复制用纯文本（''.join）；
- 预览用 HTML（斜体片段包 <i>，APA/MLA 的刊名按规范斜体）。
"""
from __future__ import annotations

import re

STYLES: list[tuple[str, str]] = [
    ("gbt7714", "GB/T 7714"),
    ("apa", "APA"),
    ("mla", "MLA"),
    ("bibtex", "BibTeX"),
]
STYLE_IDS = [s for s, _ in STYLES]
DEFAULT_STYLE = "gbt7714"

# CSL 样式（citeproc-js 渲染，文件在 webui/vendor/csl/；BibTeX 保留手写实现）
CSL_STYLES: list[tuple[str, str]] = [
    ("china-national-standard-gb-t-7714-2015-numeric", "GB/T 7714-2015（顺序编码）"),
    ("china-national-standard-gb-t-7714-2015-author-date", "GB/T 7714-2015（著者-出版年）"),
    ("apa", "APA 7"),
    ("modern-language-association", "MLA"),
    ("chicago-author-date", "Chicago（author-date）"),
    ("ieee", "IEEE"),
    ("nature", "Nature"),
    ("science", "Science"),
    ("american-chemical-society", "ACS"),
    ("american-medical-association", "AMA"),
    ("elsevier-harvard", "Elsevier（Harvard）"),
    ("springer-basic-author-date", "Springer"),
]


def csl_json(p: dict) -> dict:
    """paper 行 → CSL-JSON（citeproc-js 的输入）。

    item.language 驱动 GB/T 等样式的 等/et al. 切换（citeproc 按 item 语言
    自动选 locale）；中文作者整体作 family（ CSL 中文惯例）。
    """
    zh = bool(re.search(r"[一-鿿]", (p.get("title") or "") + (p.get("authors") or "")))
    authors = []
    for a in _split_authors(p.get("authors") or ""):
        if re.search(r"[一-鿿]", a):
            authors.append({"family": a, "given": ""})
        else:
            fam, given = _name_parts(a)
            authors.append({"family": fam or a, "given": given or ""})
    item = {
        "id": p.get("id") or "item",
        "type": "article-journal",
        "title": p.get("title") or "",
        "author": authors,
        "language": "zh-CN" if zh else "en-US",
        "DOI": p.get("doi") or "",
    }
    year = (p.get("year") or "").strip()
    if year[:4].isdigit():
        item["issued"] = {"date-parts": [[int(year[:4])]]}
    if p.get("journal"):
        item["container-title"] = p["journal"]
    if p.get("volume"):
        item["volume"] = p["volume"]
    if p.get("issue"):
        item["issue"] = p["issue"]
    if p.get("pages"):
        item["page"] = p["pages"]
    return item

# 形如 "W." / "X.-L." / "A.B." 的缩写（用于识别 "姓, 名" 里的"名"）
_INITIAL_RE = re.compile(r"^[A-Z]\.?([.-][A-Z]\.?)*$")


def _is_initial(tok: str) -> bool:
    return bool(_INITIAL_RE.match(tok.strip()))


def _split_authors(raw: str) -> list[str]:
    """拆作者列表，返回 'First Last' 或 'Last, First' 的原始形式。

    难点：库里作者串可能是 "Chen, W., Li, Z."（姓, 名 成对）也可能是
    "Yang Fu, Xiaolong Wang"。用逗号切会把这两种切坏——所以切完再把
    "缩写" token 并回前一个（Chen + W. → "Chen, W."）。
    """
    if not raw or not raw.strip():
        return []
    out: list[str] = []
    for chunk in re.split(r"[;；]", raw):
        toks = [t.strip() for t in re.split(r"[,，]", chunk) if t.strip()]
        merged: list[str] = []
        for t in toks:
            t = re.sub(r"^(and|&)\s+", "", t, flags=re.I).strip()
            t = re.sub(r"\s*(et al\.?|等)$", "", t, flags=re.I).strip()
            if not t:
                continue
            if merged and _is_initial(t):
                merged[-1] = f"{merged[-1]}, {t}"
            else:
                merged.append(t)
        out.extend(merged)
    return out


def _name_parts(name: str) -> tuple[str, str]:
    """→ (姓, 名)。'Chen, W.' → ('Chen','W.')；'Wenhao Yuan' → ('Yuan','Wenhao')。"""
    name = name.strip()
    if "," in name:                      # "姓, 名" 形式
        fam, _, given = name.partition(",")
        return fam.strip(), given.strip()
    toks = name.split()
    if not toks:
        return "", ""
    if len(toks) == 1:
        return toks[0], ""
    return toks[-1], " ".join(toks[:-1])


def _initials(given: str) -> str:
    """'Wenhao' → 'W.'；'Xiao-Long' → 'X.-L.'；中文名不缩写。"""
    given = given.strip()
    if not given:
        return ""
    if re.fullmatch(r"[A-Za-z]\.?", given):   # 已是缩写
        return given if given.endswith(".") else given + "."
    out = []
    for part in re.split(r"[\s\-]+", given):
        if not part:
            continue
        out.append(part if re.search(r"[一-鿿]", part) else part[0].upper() + ".")
    return " ".join(out)


def _vol_issue_pages(p: dict) -> tuple[str, str, str]:
    return ((p.get("volume") or "").strip(),
            (p.get("issue") or "").strip(),
            (p.get("pages") or "").strip())


def _gbt7714(p: dict) -> list[tuple[str, bool]]:
    """GB/T 7714-2015：主要责任者. 题名[J]. 刊名, 年, 卷(期): 页码. DOI.

    省略词随文献语种：中文文献用"等"，外文文献用"et al."（GB/T 7714-2015 示例口径）。
    语种以责任者字符串是否含 CJK 判定——中文作者发表的英文文献也应著录 et al.。
    """
    raw_authors = p.get("authors") or ""
    cjk = bool(re.search(r"[一-鿿]", raw_authors))
    names = []
    for a in _split_authors(raw_authors):
        fam, given = _name_parts(a)
        if re.search(r"[一-鿿]", a):
            names.append(fam or a)                 # 中文名原样
        else:
            names.append((fam + " " + _initials(given)).strip())
    if len(names) > 3:
        names = names[:3] + ["等" if cjk else "et al."]
    seg = ", ".join(names) if names else ("佚名" if cjk else "Anon.")
    if seg.endswith("."):                 # 末位作者缩写自带句点，别再补一个
        seg = seg[:-1]
    out = f"{seg}. {p.get('title') or '（无标题）'}[J]. "
    out += f"{p.get('journal') or ''}"
    if p.get("year"):
        out += f", {p['year']}"
    vol, issue, pages = _vol_issue_pages(p)
    if vol:
        out += f", {vol}" + (f"({issue})" if issue else "")
    if pages:
        out += f": {pages}"
    out += "."
    if p.get("doi"):
        out += f" DOI: {p['doi']}."
    return [(out, False)]


def _apa(p: dict) -> list[tuple[str, bool]]:
    """APA 7：Family, I. I., & Family, I. I. (Year). Title. Journal, Vol(Iss), pages. DOI"""
    names = []
    for a in _split_authors(p.get("authors") or ""):
        fam, given = _name_parts(a)
        ini = _initials(given)
        names.append(f"{fam}, {ini}".strip().rstrip(",").strip())
    if not names:
        seg = ""
    elif len(names) == 1:
        seg = names[0]
    elif len(names) <= 20:
        seg = ", ".join(names[:-1]) + ", & " + names[-1]
    else:
        seg = names[0] + ", et al."
    year = f"({p['year']})" if p.get("year") else "(n.d.)"
    segs: list[tuple[str, bool]] = []
    if seg:
        if not seg.endswith("."):
            seg += "."
        segs.append((f"{seg} ", False))
    segs.append((f"{year}. {p.get('title') or '（无标题）'}. ", False))
    if p.get("journal"):
        segs.append((p["journal"], True))          # 刊名斜体
    vol, issue, pages = _vol_issue_pages(p)
    tail = []
    if vol:
        tail.append(vol + (f"({issue})" if issue else ""))
    if pages:
        tail.append(pages)
    if tail:
        segs.append((", " + ", ".join(tail) + ".", False))
    elif p.get("journal"):
        segs.append((".", False))
    if p.get("doi"):
        segs.append((f" https://doi.org/{p['doi']}.", False))
    elif segs and segs[-1][0].endswith("."):
        pass
    else:
        segs.append((".", False))
    return segs


def _mla(p: dict) -> list[tuple[str, bool]]:
    """MLA 9：Family, Given, et al. "Title." Journal, vol. X, no. Y, Year, pp. Z. DOI."""
    authors = _split_authors(p.get("authors") or "")
    if not authors:
        seg = ""
    elif len(authors) == 1:
        seg = _name_parts(authors[0])[0]
    elif len(authors) == 2:
        seg = f"{_name_parts(authors[0])[0]}, and {_name_parts(authors[1])[0]}"
    else:
        seg = f"{_name_parts(authors[0])[0]}, et al"
    vol, issue, pages = _vol_issue_pages(p)
    segs: list[tuple[str, bool]] = []
    if seg:
        segs.append((f"{seg}. ", False))
    segs.append((f'“{p.get("title") or "（无标题）"}.” ', False))
    if p.get("journal"):
        segs.append((p["journal"], True))          # 刊名斜体
    bits = []
    if vol:
        bits.append(f"vol. {vol}")
    if issue:
        bits.append(f"no. {issue}")
    if p.get("year"):
        bits.append(p["year"])
    if pages:
        bits.append(f"pp. {pages}")
    if bits:
        segs.append((", " + ", ".join(bits) + ".", False))
    else:
        segs.append((".", False))
    if p.get("doi"):
        segs.append((f" https://doi.org/{p['doi']}.", False))
    return segs


def _bibtex_key(p: dict) -> str:
    authors = _split_authors(p.get("authors") or "")
    fam = _name_parts(authors[0])[0] if authors else ""
    stem = re.sub(r"[^A-Za-z]", "", fam) or "anon"
    return f"{stem.lower()}{p.get('year') or ''}{re.sub(r'[^A-Za-z]', '', (p.get('title') or '')[:16])}"


def _bibtex(p: dict) -> list[tuple[str, bool]]:
    authors = _split_authors(p.get("authors") or "")
    vol, issue, pages = _vol_issue_pages(p)
    fields = [
        ("title", p.get("title") or ""),
        ("author", " and ".join(authors)),
        ("journal", p.get("journal") or ""),
        ("year", p.get("year") or ""),
        ("volume", vol),
        ("number", issue),
        ("pages", pages.replace("-", "--")),
        ("doi", p.get("doi") or ""),
    ]
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
    return [(f"@article{{{_bibtex_key(p)},\n{body}\n}}", False)]


_FORMATTERS = {"gbt7714": _gbt7714, "apa": _apa, "mla": _mla, "bibtex": _bibtex}


def _norm(paper: dict) -> dict:
    p = {k: (v if isinstance(v, str) else "") for k, v in dict(paper).items()}
    for k in ("title", "authors", "journal", "year", "doi", "volume", "issue", "pages"):
        p.setdefault(k, "")
        p[k] = (p[k] or "").strip()
    return p


def format_segments(paper: dict, style: str = DEFAULT_STYLE) -> list[tuple[str, bool]]:
    """引用文本片段 [(文本, 斜体?)]。未知样式退回 GB/T 7714。"""
    fn = _FORMATTERS.get((style or "").lower(), _gbt7714)
    return fn(_norm(paper))


def format_citation(paper: dict, style: str = DEFAULT_STYLE) -> str:
    """引用纯文本（复制用）。"""
    return "".join(t for t, _ in format_segments(paper, style))


def citation_html(paper: dict, style: str = DEFAULT_STYLE) -> str:
    """引用 HTML（预览用；刊名斜体）。"""
    out = []
    for text, italic in format_segments(paper, style):
        esc = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        out.append(f"<i>{esc}</i>" if italic else esc)
    return "".join(out)


def all_styles(paper: dict) -> dict[str, dict[str, str]]:
    """全部样式 → {style: {text, html}}（前端一次拿到，切换零延迟）。"""
    return {sid: {"text": format_citation(paper, sid), "html": citation_html(paper, sid)}
            for sid in STYLE_IDS}
