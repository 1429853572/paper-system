"""入库管线：预检 → 去重 → 存储 → 解析产物 → blocks/chunks → 索引."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from pathlib import Path
from typing import Any

from pypdf import PdfReader

from .config import DATA_DIR, config
from .db import db

PAPERS_DIR = DATA_DIR / "papers"

# 预检：magic bytes
_PDF_MAGIC = b"%PDF-"
_IMG_MAGICS = (b"\x89PNG", b"\xff\xd8\xff")          # png / jpeg
_OFFICE_EXTS = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".html", ".txt"}


class PreflightError(Exception):
    pass


def preflight_doc(data: bytes, name: str, *, is_admin: bool, overrides: dict[str, Any]) -> tuple[int, str]:
    """返回 (页数, 类型 pdf|image|office)；不合规抛 PreflightError。MinerU 原生支持这三类."""
    max_mb = overrides.get("max_file_mb") if not is_admin else None
    max_pages = overrides.get("max_pages") if not is_admin else None
    max_mb = int(max_mb if max_mb is not None else config.get("limits", "max_file_mb"))
    max_pages = int(max_pages if max_pages is not None else config.get("limits", "max_pages"))

    if len(data) > max_mb * 1024 * 1024:
        raise PreflightError(f"文件超过 {max_mb}MB 限制")
    ext = "." + (name or "").rsplit(".", 1)[-1].lower() if "." in (name or "") else ""
    if data.startswith(_PDF_MAGIC):
        reader = PdfReader(__import__("io").BytesIO(data))
        if reader.is_encrypted:
            raise PreflightError("PDF 已加密，无法解析")
        pages = len(reader.pages)
        if not is_admin and pages > max_pages:
            raise PreflightError(f"页数 {pages} 超过 {max_pages} 页限制")
        return pages, "pdf"
    if data.startswith(_IMG_MAGICS):
        return 1, "image"
    if ext in _OFFICE_EXTS:
        return 0, "office"
    raise PreflightError("不支持的格式（PDF / 图片 / Office 文档）")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_paper_id() -> str:
    return "p" + secrets.token_hex(8)


def store_pdf(paper_id: str, data: bytes, name: str = "original.pdf") -> Path:
    """统一存为 original.<扩展名>（解析/预览端按该前缀定位；多格式保留真实扩展）."""
    d = PAPERS_DIR / paper_id
    d.mkdir(parents=True, exist_ok=True)
    ext = Path(name or "x.pdf").suffix.lower() or ".pdf"
    if ext not in (".pdf", ".png", ".jpg", ".jpeg", ".doc", ".docx",
                   ".ppt", ".pptx", ".xls", ".xlsx", ".html", ".txt"):
        ext = ".pdf"
    p = d / f"original{ext}"
    p.write_bytes(data)
    return p


def create_paper(user_id: int, file_hash: str, pages: int, size: int,
                 visibility: str, original_name: str) -> tuple[str, bool]:
    """返回 (paper_id, deduplicated)。同哈希未删除论文 → 复用不重复入库。"""
    exist = db.one(
        "SELECT id, owner_id, title FROM papers WHERE file_hash=? AND deleted_at IS NULL",
        (file_hash,),
    )
    if exist:
        return exist["id"], True

    paper_id = new_paper_id()
    title = Path(original_name).stem
    with db.write() as c:
        c.execute(
            "INSERT INTO papers(id,owner_id,visibility,file_hash,title,page_count,file_size) "
            "VALUES(?,?,?,?,?,?,?)",
            (paper_id, user_id, visibility, file_hash, title, pages, size),
        )
    return paper_id, False


# ---- 解析产物处理 ----
def new_parse_run(paper_id: str, tier: str) -> str:
    run_id = "v" + secrets.token_hex(4)
    with db.write() as c:
        c.execute(
            "INSERT INTO parse_runs(id,paper_id,tier,status) VALUES(?,?,?,'running')",
            (run_id, paper_id, tier),
        )
        c.execute("UPDATE papers SET parse_status='parsing' WHERE id=?", (paper_id,))
    return run_id


def save_parse_result(paper_id: str, run_id: str, files: dict[str, bytes]) -> Path:
    """安全解包结果 ZIP 内容到 parse/ 目录。"""
    d = PAPERS_DIR / paper_id / "parse" / run_id
    d.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        dest = (d / name).resolve()
        if not str(dest).startswith(str(d.resolve())):
            continue  # zip-slip 双保险
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
    return d


def _flatten_spans(spans: list[dict]) -> str:
    out = []
    for s in spans or []:
        t = s.get("type")
        if t == "text":
            out.append(s.get("content", ""))
        elif t == "equation_inline":
            out.append(f"${s.get('content', '')}$")
        elif t == "code_inline":
            out.append(f"`{s.get('content', '')}`")
        elif t == "hyperlink":
            inner = _flatten_spans(s.get("content") or [])
            out.append(f"{inner} ({s.get('url', '')})" if inner else s.get("url", ""))
    return "".join(out)


def _block_text(block: dict) -> str:
    """从 middle JSON block 提取纯文本（公式/表格/图片各自语义）。"""
    btype = block.get("type", "")
    content = block.get("content")
    if isinstance(content, str):  # equation/code_body/table_body/image_body/chart_body
        return content
    if isinstance(content, list):  # InlineSpans 或子 block
        if content and isinstance(content[0], dict) and "type" in content[0]:
            if content[0].get("type") in ("text", "equation_inline", "code_inline", "hyperlink"):
                return _flatten_spans(content)
            # 容器块（list/index 递归）
            parts = []
            for sub in content:
                if isinstance(sub, dict):
                    parts.append(_block_text(sub))
            return "\n".join(x for x in parts if x)
    return ""


def extract_title(middle_json: dict) -> str:
    """从 middle JSON 提取文档大标题：优先 doc_title（level 1），退化取首段标题。"""
    fallback = ""
    for page in middle_json.get("pages", [])[:2]:
        for block in page.get("blocks", []):
            if block.get("type") == "doc_title":
                text = _block_text(block).strip()
                if text:
                    return text[:200]
            if block.get("type") == "paragraph_title" and not fallback:
                fallback = _block_text(block).strip()[:200]
    return fallback


def build_blocks(paper_id: str, run_id: str, middle_json: dict) -> int:
    """从 middle JSON 生成 document_blocks。返回块数。

    依据 docs/next/middle-json/current-medium.md：
    - pages[].page_idx 0 基物理页序
    - 顶层 block.index 唯一严格递增；PDF 块带归一化 bbox [0,1]
    - 标题层级 doc_title=1, paragraph_title=2..6 → 维护 section_path

    跨栏续文合并：MinerU 用 block.continues_prev 标记「本块是上一段的续文」
    （双栏排版时同一段落被栏边界切开）。官网 markdown 渲染层据此把续文并回前一段，
    我们同样在入库时合并，否则同一段会显示成两段。
    合并后 bbox 变成多框列表 [[框1],[框2]]，前端 parseBoxes() 兼容。
    """
    rows: list[dict] = []
    section_stack: list[tuple[int, str]] = []  # (level, title)

    def current_section() -> str:
        return " > ".join(t for _, t in section_stack) if section_stack else ""

    for page in middle_json.get("pages", []):
        page_idx = int(page.get("page_idx", 0))
        for block in page.get("blocks", []):
            btype = block.get("type", "")
            idx = int(block.get("index", 0))
            text = _block_text(block)
            bbox = block.get("bbox")
            if btype in ("doc_title", "paragraph_title"):
                level = int(block.get("level", 2))
                if btype == "doc_title":
                    section_stack.clear()
                else:
                    while section_stack and section_stack[-1][0] >= level:
                        section_stack.pop()
                section_stack.append((level, text[:80]))
            normalized = "title" if btype in ("doc_title", "paragraph_title") else btype
            # 图表资产：image 块取裁剪图路径（正文内嵌渲染用）
            asset = None
            if btype in ("image", "table"):
                for sub in block.get("content", []) or []:
                    if isinstance(sub, dict) and sub.get("type") in ("image_body", "table_body"):
                        asset = sub.get("image_path") or None
                        break

            # ---- 跨栏续文 → 并入前一个正文块 ----
            anchored = bool((block.get("anchor") or "").strip())
            prev = rows[-1] if rows else None
            if (block.get("continues_prev") is True and not anchored
                    and btype == "text" and prev is not None
                    and prev["type"] == "text" and prev["page"] == page_idx):
                prev["text"] = (prev["text"] + " " + text).strip() if text else prev["text"]
                prev["source_hash"] = sha256_bytes(prev["text"].encode())[:16]
                if bbox:
                    prev["boxes"] = prev["boxes"] + [list(bbox)]
                continue

            # MinerU 的 index 每页独立编号 → block_id 含页号；不含 run → 重解析后译文/批注仍匹配
            rows.append({
                "paper_id": paper_id, "run_id": run_id,
                "block_id": f"{paper_id}-p{page_idx:03d}-b{idx:05d}",
                "type": normalized, "section": current_section(),
                "page": page_idx, "index": idx,
                "boxes": [list(bbox)] if bbox else [],
                "text": text, "source_hash": sha256_bytes(text.encode())[:16],
                "asset": asset,
            })

    db_rows = [
        (r["paper_id"], r["run_id"], r["block_id"], r["type"], r["section"],
         r["page"], r["index"],
         json.dumps(r["boxes"][0] if len(r["boxes"]) == 1 else r["boxes"]) if r["boxes"] else None,
         r["text"], r["source_hash"], r["asset"])
        for r in rows
    ]
    with db.write() as c:
        c.executemany(
            "INSERT OR REPLACE INTO blocks(paper_id,parse_run_id,block_id,type,section_path,"
            "page_index,block_index,bbox,text,source_hash,asset_path) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            db_rows,
        )
    return len(db_rows)


def rebuild_from_stored(paper_id: str) -> tuple[int, int]:
    """用已存的 middle.json 重建 blocks + chunks（不占 GPU、不重新解析）。

    用于解析产物结构的修复（如跨栏续文合并）。embedding 由 embed_backfill 任务回填。
    返回 (块数, 分块数)；无可用产物时返回 (0, 0)。
    """
    from .retrieval import build_chunks

    run = db.one(
        "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' ORDER BY created_at DESC LIMIT 1",
        (paper_id,),
    )
    if run is None:
        return (0, 0)
    run_id = run["id"]
    mj_path = PAPERS_DIR / paper_id / "parse" / run_id / "middle_json.json"
    if not mj_path.is_file():
        return (0, 0)
    middle = json.loads(mj_path.read_text(encoding="utf-8"))
    old_hash = {
        r["block_id"]: r["source_hash"]
        for r in db.all("SELECT block_id, source_hash FROM blocks WHERE parse_run_id=?", (run_id,))
    }
    with db.write() as c:
        c.execute("DELETE FROM blocks WHERE parse_run_id=?", (run_id,))
        c.execute("DELETE FROM chunks WHERE parse_run_id=?", (run_id,))
        c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (paper_id,))
    n_blocks = build_blocks(paper_id, run_id, middle)
    blocks = db.all(
        "SELECT block_id, text, page_index FROM blocks WHERE parse_run_id=? "
        "ORDER BY page_index, block_index", (run_id,),
    )
    n_chunks = build_chunks(paper_id, run_id, blocks)
    # 块结构变了（合并/拆分）→ 旧译文与新正文不再对应，删掉以免双语视图半段译文
    new_hash = {
        r["block_id"]: r["source_hash"]
        for r in db.all("SELECT block_id, source_hash FROM blocks WHERE parse_run_id=?", (run_id,))
    }
    stale = [bid for bid, h in new_hash.items() if old_hash.get(bid) != h]
    stale += [bid for bid in old_hash if bid not in new_hash]
    if stale:
        with db.write() as c:
            c.executemany(
                "DELETE FROM translations WHERE paper_id=? AND block_id=?",
                [(paper_id, bid) for bid in stale],
            )
    return (n_blocks, n_chunks)


def finish_parse_run(paper_id: str, run_id: str, ok: bool, error: str = "") -> None:
    with db.write() as c:
        c.execute(
            "UPDATE parse_runs SET status=? WHERE id=?",
            ("done" if ok else "failed", run_id),
        )
        c.execute(
            "UPDATE papers SET parse_status=? WHERE id=?",
            ("parsed" if ok else "failed", paper_id),
        )
    if error:
        with db.write() as c:
            c.execute("UPDATE jobs SET error=? WHERE paper_id=? AND job_type='parse'", (error, paper_id))


def latest_blocks(paper_id: str) -> list[sqlite3.Row]:  # noqa: F821
    run = db.one(
        "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' ORDER BY created_at DESC LIMIT 1",
        (paper_id,),
    )
    if run is None:
        return []
    return db.all(
        "SELECT * FROM blocks WHERE parse_run_id=? ORDER BY page_index, block_index", (run["id"],)
    )
