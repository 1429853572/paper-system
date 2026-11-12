"""导出：原文/双语 Markdown + PDF + ZIP 组合打包."""
from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

from .config import DATA_DIR
from .db import db

PAPERS_DIR = DATA_DIR / "papers"

# ---------------- Markdown 组装 ----------------

def _paper(paper_id: str) -> dict:
    row = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    return dict(row) if row else {}


def _run_id(paper_id: str) -> str | None:
    row = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    return row["id"] if row else None


def _pairs(paper_id: str) -> list[dict]:
    from .translator import bilingual_pairs
    run = _run_id(paper_id)
    if not run:
        return []
    return bilingual_pairs(paper_id, run, None)


def original_md(paper_id: str) -> str:
    """原文 Markdown（解析产物原文）。"""
    run = _run_id(paper_id)
    if not run:
        return ""
    path = PAPERS_DIR / paper_id / "parse" / run / "markdown.md"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def bilingual_md(paper_id: str) -> str:
    """中英对照 Markdown：英文段落后跟中文译文."""
    pairs = _pairs(paper_id)
    if not pairs:
        return ""
    out = []
    section = ""
    for p in pairs:
        if p["section_path"] and p["section_path"] != section:
            section = p["section_path"]
            out.append(f"\n## {section}\n")
        en = (p.get("en") or "").strip()
        zh = (p.get("zh") or "").strip()
        if en:
            out.append(en)
        if zh:
            out.append(f"\n> {zh}\n")
        elif not en:
            continue
    return "\n".join(out)


def zh_md(paper_id: str) -> str:
    """纯中文 Markdown."""
    pairs = _pairs(paper_id)
    if not pairs:
        return ""
    out = []
    section = ""
    for p in pairs:
        zh = (p.get("zh") or "").strip()
        if not zh:
            continue
        if p["section_path"] and p["section_path"] != section:
            section = p["section_path"]
            out.append(f"\n## {section}\n")
        out.append(zh)
    return "\n".join(out)


def en_md(paper_id: str) -> str:
    """纯英文 Markdown（原文 md 去掉翻译块，解析产物本身即英文）."""
    return original_md(paper_id)


# ---------------- HTML 组装（用于 PDF） ----------------

_MATH = re.compile(r"\$\$(.+?)\$\$|\$([^$\n]+?)\$", re.S)


def _inline_images(md: str, base_dir: Path) -> str:
    """把 markdown 里的相对图片路径内联为 data URI（PDF 自包含，不丢图）。"""
    import base64
    import mimetypes

    def _repl(m):
        src = m.group(2)
        if src.startswith(("http://", "https://", "data:")):
            return m.group(0)
        p = (base_dir / src).resolve()
        if not p.exists() or base_dir.resolve() not in p.parents:
            return m.group(0)
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        data = base64.b64encode(p.read_bytes()).decode()
        return f'{m.group(1)}data:{mime};base64,{data}"'

    return re.sub(r'(!\[[^\]]*\]\()([^)]+)(\))', _repl, md)


def _md_to_html(md: str, title: str, base_dir: Path | None = None) -> str:
    import markdown as md_lib
    from .tools_runner import render_math

    if base_dir:
        md = _inline_images(md, base_dir)
    maths: list[str] = []
    def _collect(m):
        body = m.group(1) if m.group(1) else m.group(2)
        maths.append(body)
        return f"@@MATH{len(maths)-1}@@"
    text = _MATH.sub(_collect, md)
    html = md_lib.markdown(text, extensions=["extra", "tables", "fenced_code", "codehilite"])
    if maths:
        rendered = render_math(maths)
        for i, h in enumerate(rendered):
            html = html.replace(f"@@MATH{i}@@", h)
    return _HTML_SHELL.replace("{{title}}", title).replace("{{body}}", html)


_HTML_SHELL = """<!doctype html><html><head><meta charset="utf-8"><title>{{title}}</title>
<style>
@page {{ size: A4; margin: 16mm 14mm; }}
body {{ font-family: "Noto Serif CJK SC","Noto Sans CJK SC",serif; font-size: 10.5pt; line-height: 1.75; color:#111; }}
h1 {{ font-size: 16pt; margin: 14px 0 8px; }}
h2 {{ font-size: 13pt; margin: 14px 0 6px; border-bottom:1px solid #ddd; padding-bottom:3px; }}
h3 {{ font-size: 11.5pt; margin: 10px 0 4px; }}
p {{ margin: 5px 0; text-align: justify; }}
blockquote {{ margin: 3px 0 7px; padding: 5px 10px; background: #f2f6ff; border-left: 3px solid #4a6cf7; color:#223; }}
/* 中英对照双栏 */
table.bi {{ width:100%; border-collapse:separate; border-spacing:14px 0; margin:6px 0 12px; }}
table.bi td {{ vertical-align: top; width:50%; border:0; }}
table.bi td.en {{ color:#111; }}
table.bi td.zh {{ color:#16305c; background:#f7f9ff; border-left:3px solid #4a6cf7; padding:6px 10px; }}
table.bi tr > td:first-child {{ width:50%; }}
table {{ border-collapse: collapse; font-size: 9pt; margin: 8px 0; }}
th,td {{ border: 1px solid #bbb; padding: 3px 6px; }}
pre {{ background:#f5f6f8; padding:7px; overflow-x:auto; font-size:8.5pt; }}
code {{ font-family: "DejaVu Sans Mono", monospace; font-size:9pt; }}
img {{ max-width: 100%; }}
.katex-display {{ overflow-x: auto; }}
</style></head><body>{{body}}</body></html>"""


def _bilingual_html(pairs: list[dict], title: str, base_dir: Path | None = None) -> str:
    """中英对照 HTML：每段一行，左英文右中文（PDF 双栏）。"""
    import markdown as md_lib
    from .tools_runner import render_math

    maths: list[str] = []

    def _md(text: str) -> str:
        def _collect(m):
            body = m.group(1) if m.group(1) else m.group(2)
            maths.append(body)
            return f"@@MATH{len(maths)-1}@@"
        t = _MATH.sub(_collect, text or "")
        return md_lib.markdown(t, extensions=["extra", "tables", "fenced_code"])

    rows = []
    section = ""
    for p in pairs:
        en = (p.get("en") or "").strip()
        zh = (p.get("zh") or "").strip()
        if not en and not zh:
            continue
        if p.get("section_path") and p["section_path"] != section:
            section = p["section_path"]
            rows.append(f'<tr><td colspan="2"><h2>{_md(section)}</h2></td></tr>')
        rows.append(f'<tr><td class="en">{_md(en)}</td><td class="zh">{_md(zh)}</td></tr>')
    body = "".join(rows)
    if maths:
        rendered = render_math(maths)
        for i, h in enumerate(rendered):
            body = body.replace(f"@@MATH{i}@@", h)
    return _HTML_SHELL.replace("{{body}}", f'<table class="bi">{body}</table>').replace(
        "{{title}}", title)


def _parse_dir(paper_id: str) -> Path | None:
    """解析产物目录（含 images/），用于内联图片."""
    run = _run_id(paper_id)
    if not run:
        return None
    d = PAPERS_DIR / paper_id / "parse" / run
    return d if d.exists() else None


def bilingual_pdf(paper_id: str, title: str) -> bytes:
    """中英对照 PDF（双栏排版）。"""
    from .tools_runner import html_to_pdf
    pairs = _pairs(paper_id)
    if not pairs:
        raise RuntimeError("尚未翻译，无法导出中英对照 PDF")
    return html_to_pdf(_bilingual_html(pairs, title))


def md_to_pdf(md: str, title: str, base_dir: Path | None = None) -> bytes:
    from .tools_runner import html_to_pdf
    return html_to_pdf(_md_to_html(md, title, base_dir))


# ---------------- ZIP 组合 ----------------

def build_zip(paper_id: str, items: list[str]) -> tuple[bytes, str]:
    """按 items 组合打包。items 可含:
    pdf(原始PDF) md(原文md) bilingual_md(中英对照md) bilingual_pdf zh_pdf en_pdf
    返回 (zip 字节, zip 文件名)
    """
    p = _paper(paper_id)
    base = _zip_base_name(p)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        paper_dir = PAPERS_DIR / paper_id
        if "pdf" in items:
            src = paper_dir / "original.pdf"
            if src.exists():
                z.write(src, f"{base}.pdf")
        if "md" in items:
            md_text = original_md(paper_id)
            if md_text.strip():
                z.writestr(f"{base}.md", md_text)
        if "bilingual_md" in items:
            bi_text = bilingual_md(paper_id)
            if bi_text.strip():   # 未翻译论文此前写 0 字节空文件（解压后一堆无解释空 .md）
                z.writestr(f"{base}-双语对照.md", bi_text)
        base_dir = _parse_dir(paper_id)
        if "bilingual_pdf" in items:
            z.writestr(f"{base}-中英对照.pdf", bilingual_pdf(paper_id, p.get("title") or base))
        if "zh_pdf" in items:
            z.writestr(f"{base}-中文版.pdf", md_to_pdf(zh_md(paper_id), p.get("title") or base, base_dir))
        if "en_pdf" in items:
            z.writestr(f"{base}-English.pdf", md_to_pdf(en_md(paper_id), p.get("title") or base, base_dir))
    return buf.getvalue(), f"{base}.zip"


def _zip_base_name(p: dict) -> str:
    """文件名：首作者姓+年份+标题（与导出命名一致）."""
    import re as _re
    title = (p.get("title") or "paper").strip()
    authors = (p.get("authors") or "").strip()
    year = (p.get("year") or "").strip()
    surname = ""
    if authors:
        first = authors.split(",")[0].strip()
        toks = first.split()
        surname = toks[-1] if toks else first
    name = f"{surname}{year} {title}" if (surname or year) else title
    name = _re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name)
    return _re.sub(r"\s+", " ", name).strip()[:150]
