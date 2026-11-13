"""表格工作台（core/tables.py）：收割已解析论文的表格 → 网格化 → LLM 整理 → xlsx 导出。

原料全部来自 MinerU 解析产物：blocks 中 type='table' 的行自带完整 <table> HTML
（含 colspan/rowspan/<eq>）与原图裁剪（asset_path，images/page_N_table_M.jpg）。
收割是幂等的（src_hash = sha1(paper+caption+前3行)，重解析/重复收割不产生重复行）。
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from html.parser import HTMLParser

from .db import db
from .llm import NoKeyError, resolve_llm


def _tid(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ---------------- HTML → 网格（stdlib，无 bs4 依赖） ----------------
class _TableParser(HTMLParser):
    """解析 <table> 行结构：每个 td/th 记 (文本, colspan, rowspan)。
    标签内容（含 MinerU 自定义 <eq>）作为文本收集——HTMLParser 默认把
    非标准标签间的 data 正常回调，实体经 convert_charrefs 自动解码。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[list[tuple[str, int, int]]] = []
        self._depth = 0
        self._row: list[tuple[str, int, int]] | None = None
        self._cell: list[str] | None = None
        self._cs = self._rs = 1

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            return
        if self._depth > 1:
            return                            # 嵌套表：内层 tr/td 忽略（保外层行完整）
        if tag == "tr":
            self._flush_row()
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._flush_cell()                     # 新格开而旧格未闭 → 先落袋（残缺 HTML 兜底）
            self._cell = []
            a = dict(attrs)
            try:
                self._cs = max(1, int(a.get("colspan", 1)))
                self._rs = max(1, int(a.get("rowspan", 1)))
            except ValueError:
                self._cs = self._rs = 1

    def _flush_cell(self):
        if self._cell is not None and self._row is not None:
            self._row.append((_tid("".join(self._cell)), self._cs, self._rs))
            self._cell = None

    def _flush_row(self):
        self._flush_cell()
        if self._row is not None and self._row:
            self.rows.append(self._row)
        self._row = None

    def close(self):
        super().close()
        self._flush_row()                          # 整体结束仍悬着的行/格补闭合

    def handle_endtag(self, tag):
        if tag == "table":
            self._depth = max(0, self._depth - 1)
            return
        if self._depth > 1:
            return
        if tag in ("td", "th"):
            self._flush_cell()
        elif tag == "tr":
            self._flush_row()
        elif tag == "br":
            self._cell_append(" ") if self._cell is not None else None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def _cell_append(self, text):
        if self._cell is not None:
            self._cell.append(text)


def html_to_grid(html: str) -> list[list[str]]:
    """表格 HTML → 规则二维网格。colspan/rowspan 拍平=值复制进每个被合并格
    （每行自洽，便于数据使用与 LLM 整理）；空洞补 ''；返回矩形网格。"""
    if not html or "<table" not in html.lower():
        return []
    # MinerU 偶发未闭合 <td>：补上再解析（残缺表也比丢表好）
    closed = re.sub(r"<(td|th)([^>]*)>([^<]*)$", r"<\1\2>\3</\1>", html.strip(), flags=re.I)
    p = _TableParser()
    try:
        p.feed(closed)
        p.close()
    except Exception:  # noqa: BLE001 —— 解析器炸了说明 HTML 烂到读不了
        return []
    if not p.rows:
        return []
    occupied: dict[tuple[int, int], bool] = {}
    grid: dict[tuple[int, int], str] = {}
    n_cols = 0
    for r, cells in enumerate(p.rows):
        c = 0
        for text, cs, rs in cells:
            while occupied.get((r, c)):
                c += 1
            for dr in range(rs):
                for dc in range(cs):
                    pos = (r + dr, c + dc)
                    occupied[pos] = True
                    grid[pos] = text
            n_cols = max(n_cols, c + cs)
            c += cs
    n_rows = max(r for r, _ in occupied) + 1 if occupied else 0
    return [[grid.get((r, c), "") for c in range(n_cols)] for r in range(n_rows)]


def split_caption(block_text: str) -> tuple[str, str]:
    """blocks.text = caption行 + '<table>...'（_block_text 拼接形态）。拆成 (caption, html)。"""
    m = re.search(r"<table[\s>]", block_text or "", re.I)
    if not m:
        return _tid(block_text or ""), ""
    return _tid(block_text[: m.start()]), block_text[m.start():]


# ---------------- 收割（幂等） ----------------
def harvest(user_id: int, paper_ids: list[str] | None = None, is_admin: bool = False) -> dict:
    """扫描 table 块入工作台。先查 UNIQUE 键再插入（幂等）；
    paper_ids=None → 全部已解析论文。返回 {papers, found, inserted, skipped}。"""
    # 可见性口径与 /api/tables/sources 一致：admin 全见，成员=shared+本人；
    # parse_status='parsed' 防收割解析中的半成品；只取最新 done run 的块
    # （旧 run 的 blocks 不删——不过滤会把同一物理表收成新旧两份）
    vis = "" if is_admin else " AND (p.visibility='shared' OR p.owner_id=?)"
    vargs: tuple = () if is_admin else (user_id,)
    if paper_ids:
        marks = ",".join("?" * len(paper_ids))
        rows = db.all(
            f"SELECT b.paper_id, b.page_index, b.text, b.asset_path FROM blocks b "
            f"JOIN papers p ON p.id = b.paper_id "
            f"WHERE b.type='table' AND b.paper_id IN ({marks}) AND p.deleted_at IS NULL "
            f"AND p.parse_status='parsed' AND b.parse_run_id = "
            f"(SELECT r.id FROM parse_runs r WHERE r.paper_id = b.paper_id AND r.status='done' "
            f"ORDER BY r.created_at DESC LIMIT 1){vis}",
            (*paper_ids, *vargs))
    else:
        rows = db.all(
            "SELECT b.paper_id, b.page_index, b.text, b.asset_path FROM blocks b "
            "JOIN papers p ON p.id = b.paper_id "
            "WHERE b.type='table' AND p.deleted_at IS NULL AND p.parse_status='parsed' "
            "AND b.parse_run_id = (SELECT r.id FROM parse_runs r WHERE r.paper_id = b.paper_id "
            "AND r.status='done' ORDER BY r.created_at DESC LIMIT 1)" + vis, vargs)
    inserted = skipped = 0
    inserted_ids: list[str] = []
    papers_seen: set[str] = set()
    for b in rows:
        papers_seen.add(b["paper_id"])
        caption, html = split_caption(b["text"] or "")
        grid = html_to_grid(html)
        if not grid or len(grid) < 2 or len(grid[0]) < 2:
            skipped += 1
            continue
        head = "|".join((grid[1][:3] if len(grid) > 1 else [])) or "|".join(grid[0][:3])
        src = hashlib.sha1(f"{b['paper_id']}|{caption}|{head}".encode()).hexdigest()[:16]
        dup = db.one("SELECT 1 FROM table_extracts WHERE user_id=? AND paper_id=? AND src_hash=?",
                     (user_id, b["paper_id"], src))
        if dup:
            skipped += 1
            continue
        tid = "tb" + secrets.token_hex(8)
        try:
            with db.write() as c:
                c.execute(
                    "INSERT INTO table_extracts(id, user_id, paper_id, page_index, "
                    "caption, html, cells, src_hash, asset_name) VALUES(?,?,?,?,?,?,?,?,?)",
                    (tid, user_id, b["paper_id"], b["page_index"],
                     caption[:300], html, json.dumps(grid, ensure_ascii=False), src,
                     (b["asset_path"] or "").rsplit("/", 1)[-1] or None))
        except Exception:  # noqa: BLE001 —— 并发收割撞 UNIQUE：计跳过不 500
            skipped += 1
            continue
        inserted_ids.append(tid)
        inserted += 1
    return {"papers": len(papers_seen), "found": len(rows), "inserted": inserted,
            "skipped": skipped, "inserted_ids": inserted_ids}


# ---------------- LLM 整理 ----------------
_TIDY_SYSTEM = "你是论文表格数据整理助手，只输出 JSON。"


def _parse_json_relaxed(raw: str) -> dict | None:
    """宽容解 JSON：裸 JSON → 首{...}尾切片 → ``` 围栏（模型三种形态都会出）。"""
    t = (raw or "").strip()
    if not t:
        return None
    if t.startswith("```"):
        t = t[t.find("\n") + 1:] if "\n" in t else t.lstrip("`json \n")
        t = t.rstrip().removesuffix("```").strip()
    try:
        d = json.loads(t)
        return d if isinstance(d, dict) else None
    except ValueError:
        pass
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        d = json.loads(t[i:j + 1])
        return d if isinstance(d, dict) else None
    except ValueError:
        return None


def tidy_one(user_id: int, te) -> dict:
    """单表 LLM 整理。返回 {ai_cells, ai_note, ai_status}；未配 key 抛 NoKeyError。
    硬约束：输出行列数与原表一致——不一致返回 ai_status='mismatch'（不入 ai_cells）。"""
    grid = json.loads(te["cells"] or "[]")
    if not grid:
        return {"ai_cells": None, "ai_note": "原始提取为空", "ai_status": "failed"}
    R, C = len(grid), len(grid[0])
    prompt = (
        f"【表题】{te['caption'] or '（无）'}\n"
        f"【原始数据】{R} 行 × {C} 列：\n{json.dumps(grid, ensure_ascii=False)}\n\n"
        "整理为规范数据表：\n"
        "1. 多级表头合并为一个表头行（数据集+指标拼进列头），单位并入列头（如 \"PSNR (dB)\"）\n"
        "2. 数字规范化：去千分位逗号；百分数/区间保留原形式；无法确定的保留原文\n"
        "3. 合并单元格展开产生的重复占位值：无语义的置 null\n"
        "4. 空值一律 null；修正明显的 OCR 错字（保持含义）\n"
        f"硬性约束：每行必须恰好 {C} 列（一列不多不少）；除表头合并（最多减 2 行）外"
        "不得增删任何数据行。\n"
        '输出严格 JSON：{"rows": [[..], ..], "note": "一句话说明主要调整"}')
    cfg = resolve_llm(user_id, "chat")
    from .llm import LLMClient
    client = LLMClient(cfg, user_id=user_id)
    raw = client.complete(
        [{"role": "system", "content": _TIDY_SYSTEM}, {"role": "user", "content": prompt}],
        max_tokens=3500)
    d = _parse_json_relaxed(raw)
    if d is None:
        return {"ai_cells": None, "ai_note": "模型输出无法解析", "ai_status": "mismatch"}
    rows = d.get("rows")
    # 列数严格 =C；行数容许表头合并（多级表头 2-3 行并 1 行），数据行丢失即标红
    n = len(rows) if isinstance(rows, list) else -1
    cols_ok = isinstance(rows, list) and rows and all(
        isinstance(r, list) and len(r) == C for r in rows)
    if not cols_ok or not (2 <= n <= R and R - n <= 2):
        got = f"{n if n >= 0 else '?'} 行" + ("" if cols_ok else f"，列数不齐（需 {C} 列）")
        return {"ai_cells": None,
                "ai_note": f"模型输出与原表不一致（{got}，原表 {R}×{C}）——请人工核对整理",
                "ai_status": "mismatch"}
    return {"ai_cells": json.dumps(rows, ensure_ascii=False),
            "ai_note": (d.get("note") or "")[:300], "ai_status": "done"}


# ---------------- 统计 ----------------
def stats(user_id: int) -> dict:
    counts = {"total": 0, "pending": 0, "queued": 0, "running": 0, "done": 0,
              "mismatch": 0, "failed": 0, "kept": 0, "deleted": 0}
    for r in db.all("SELECT review, ai_status, COUNT(*) n FROM table_extracts "
                    "WHERE user_id=? GROUP BY review, ai_status", (user_id,)):
        counts["total"] += r["n"]
        counts[r["review"]] = counts.get(r["review"], 0) + r["n"]
        counts[r["ai_status"]] = counts.get(r["ai_status"], 0) + r["n"]
    counts["working"] = counts.get("queued", 0) + counts.get("running", 0)
    by_paper = [dict(r) for r in db.all(
        "SELECT te.paper_id, p.title, COUNT(*) n, "
        "SUM(CASE WHEN te.ai_status='done' THEN 1 ELSE 0 END) done, "
        "SUM(CASE WHEN te.ai_status='mismatch' THEN 1 ELSE 0 END) mismatch, "
        "SUM(CASE WHEN te.review='deleted' THEN 1 ELSE 0 END) deleted "
        "FROM table_extracts te JOIN papers p ON p.id = te.paper_id "
        "WHERE te.user_id=? GROUP BY te.paper_id, p.title ORDER BY n DESC, p.title",
        (user_id,))]
    return {"counts": counts, "by_paper": by_paper}


# ---------------- xlsx 导出 ----------------
_SHEET_BAD = re.compile(r"[\\/*?:\[\]]")


def _num(v):
    """'1.23'→1.23；'1,234'→1234；其余原样字符串。"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return v


def build_xlsx(items: list[dict]) -> bytes:
    """items: [{caption, paper_title, page_index, grid(list[list])}] → xlsx bytes。
    每表一 sheet；表头行加粗+冻结；数字串转数值单元格。"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)
    used: set[str] = set()
    header_font = Font(bold=True)
    header_fill = PatternFill("solid", fgColor="EEF1F6")
    for it in items:
        base = _SHEET_BAD.sub(" ", f"{(it.get('paper_title') or '表')[:12]}·p{(it.get('page_index') or 0) + 1}"
                              f"·{(it.get('caption') or '')[:10]}").strip() or "表"
        name = base[:28]
        k = 2
        while name.lower() in used:
            suffix = f"({k})"
            name = base[: 28 - len(suffix)] + suffix
            k += 1
        used.add(name.lower())
        ws = wb.create_sheet(title=name)
        grid = it.get("grid") or []
        for r, row in enumerate(grid, 1):
            for c, v in enumerate(row, 1):
                cell = ws.cell(row=r, column=c, value=_num(v))
                if r == 1:
                    cell.font = header_font
                    cell.fill = header_fill
        ws.freeze_panes = "A2"
        if grid:
            width = max(len(r) for r in grid)
            for c in range(1, width + 1):
                w = max(len(str(grid[r][c - 1] if c - 1 < len(grid[r]) else "")) or ""
                        for r in range(min(3, len(grid)))) + 4
                ws.column_dimensions[get_column_letter(c)].width = min(40, max(8, w))
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
