"""表格工作台（core/tables.py）：收割已解析论文的表格 → 网格化 → LLM 整理 → xlsx 导出。

原料全部来自 MinerU 解析产物：blocks 中 type='table' 的行自带完整 <table> HTML
（含 colspan/rowspan/<eq>）与原图裁剪（asset_path，images/page_N_table_M.jpg）。
收割是幂等的（src_hash = sha1(paper+caption+前3行)，重解析/重复收割不产生重复行）。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
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
def harvest(user_id: int, paper_ids: list[str] | None = None, is_admin: bool = False,
            batch: str | None = None) -> dict:
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
                    "caption, html, cells, src_hash, asset_name, batch) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (tid, user_id, b["paper_id"], b["page_index"],
                     caption[:300], html, json.dumps(grid, ensure_ascii=False), src,
                     (b["asset_path"] or "").rsplit("/", 1)[-1] or None, batch))
        except Exception:  # noqa: BLE001 —— 并发收割撞 UNIQUE：计跳过不 500
            skipped += 1
            continue
        inserted_ids.append(tid)
        inserted += 1
    return {"papers": len(papers_seen), "found": len(rows), "inserted": inserted,
            "skipped": skipped, "inserted_ids": inserted_ids}


# ---------------- LLM 整理 ----------------
_TIDY_SYSTEM = "你是论文表格数据整理助手，只输出 JSON。"

# 默认整理要求（表格设置弹层可按用户覆盖；硬性约束与输出 JSON 格式固定拼接，防改坏）
_TIDY_RULES_DEFAULT = (
    "1. 多级表头合并为一个表头行（数据集+指标拼进列头），单位并入列头（如 \"PSNR (dB)\"）\n"
    "2. 数字规范化：去千分位逗号；百分数/区间保留原形式；无法确定的保留原文\n"
    "3. 合并单元格展开产生的重复占位值：无语义的置 null\n"
    "4. 空值一律 null；修正明显的 OCR 错字（保持含义）")
_ROW_TOL_DEFAULT = 2   # mismatch 行容差：表头合并允许的最大减行数


def tidy_settings(user_id: int) -> dict:
    """per-user 表格整理设置（settings 表 tbl_tidy:{uid}；非法/缺省回落默认值）。"""
    rules, tol = _TIDY_RULES_DEFAULT, _ROW_TOL_DEFAULT
    row = db.one("SELECT value FROM settings WHERE key=?", (f"tbl_tidy:{user_id}",))
    if row:
        try:
            d = json.loads(row["value"])
            if isinstance(d, dict):
                rules = str(d.get("rules") or "").strip() or _TIDY_RULES_DEFAULT
                tol = max(0, min(10, int(d.get("row_tol", _ROW_TOL_DEFAULT))))
        except (ValueError, TypeError):
            pass
    return {"rules": rules, "row_tol": tol}


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
    st = tidy_settings(user_id)
    tol = st["row_tol"]
    prompt = (
        f"【表题】{te['caption'] or '（无）'}\n"
        f"【原始数据】{R} 行 × {C} 列：\n{json.dumps(grid, ensure_ascii=False)}\n\n"
        "整理为规范数据表：\n"
        f"{st['rules']}\n"
        f"硬性约束：每行必须恰好 {C} 列（一列不多不少）；除表头合并（最多减 {tol} 行）外"
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
    # 列数严格 =C；行数容许表头合并（多级表头 2-3 行并 1 行），数据行丢失即标红。
    # 容差与提示词「最多减 X 行」同一来源（tidy_settings），两处联动
    n = len(rows) if isinstance(rows, list) else -1
    cols_ok = isinstance(rows, list) and rows and all(
        isinstance(r, list) and len(r) == C for r in rows)
    if not cols_ok or not (2 <= n <= R and R - n <= tol):
        got = f"{n if n >= 0 else '?'} 行" + ("" if cols_ok else f"，列数不齐（需 {C} 列）")
        return {"ai_cells": None,
                "ai_note": f"模型输出与原表不一致（{got}，原表 {R}×{C}）——请人工核对整理",
                "ai_status": "mismatch"}
    return {"ai_cells": json.dumps(rows, ensure_ascii=False),
            "ai_note": (d.get("note") or "")[:300], "ai_status": "done"}


def regen_one(user_id: int, te, grid: list[list[str]], instruction: str) -> dict:
    """指令式重整（工作台 AI 页签问答框）。与 tidy_one 的差异：不约束行列守恒——
    转置/删行列/合并等指令合法，只要求输出矩形网格；且不落库，返回 {rows, note}
    由前端作为工作副本展示（保存仍走 PATCH → ai_cells，原始 cells 永不动）。
    未配 key 抛 NoKeyError（端点转 400）。"""
    R, C = len(grid), len(grid[0])
    cfg = resolve_llm(user_id, "chat")
    from .llm import LLMClient
    client = LLMClient(cfg, user_id=user_id)
    prompt = (
        f"【表题】{te['caption'] or '（无）'}\n"
        f"【当前表格】{R} 行 × {C} 列：\n{json.dumps(grid, ensure_ascii=False)}\n\n"
        f"【用户指令】{instruction}\n\n"
        "按指令重新生成该表格（转置/增删行列/合并/改写均可，以指令为准）。硬性约束：\n"
        "输出必须是矩形网格（每行列数一致）；数据本体来自当前表格，不得编造原表没有的数据。\n"
        '输出严格 JSON：{"rows": [[..], ..], "note": "一句话说明做了什么"}')
    raw = client.complete(
        [{"role": "system", "content": _TIDY_SYSTEM}, {"role": "user", "content": prompt}],
        max_tokens=3500)
    d = _parse_json_relaxed(raw)
    if d is None:
        return {"error": "模型输出无法解析"}
    rows = d.get("rows")
    ok = (isinstance(rows, list) and len(rows) >= 1 and len(rows) <= 500
          and all(isinstance(r, list) and 1 <= len(r) <= 100 and len(r) == len(rows[0]) for r in rows))
    if not ok:
        return {"error": "模型输出不是合法矩形网格（或超出 500×100 限制）"}
    return {"rows": rows, "note": (d.get("note") or "")[:300]}


# ---------------- 跨表 AI 合并（多表 → 一张汇总表） ----------------

_MERGE_MAX_SOURCES = 10      # 单次合成源表上限（prompt 尺寸有界）
_MERGE_MAX_ROWS = 100        # 每张源表最多带多少行进 prompt


def merge_one(user_id: int, tes: list, instruction: str) -> dict:
    """多表合成一张：全部源表内容 + 用户指令 → 一次 LLM 调用产出矩形网格。
    与 regen_one（单表指令重整）的区别：输入是多张表，要求跨表对齐/去重/汇总。
    输出 {"rows", "note"}；解析失败抛 ValueError（端点转 502）。"""
    parts = []
    for i, te in enumerate(tes, 1):
        grid = None
        if te["ai_cells"]:
            try:
                grid = json.loads(te["ai_cells"])
            except Exception:  # noqa: BLE001
                grid = None
        if not grid:
            try:
                grid = json.loads(te["cells"] or "[]")
            except Exception:  # noqa: BLE001
                grid = []
        if not grid:
            continue
        trimmed = grid[:_MERGE_MAX_ROWS]
        tail = f"\n（原表 {len(grid)} 行，仅展示前 {_MERGE_MAX_ROWS} 行）" if len(grid) > _MERGE_MAX_ROWS else ""
        parts.append(f"{i}. 「{te['caption'] or '（无表题）'}」{tail}\n{json.dumps(trimmed, ensure_ascii=False)}")
    if not parts:
        raise ValueError("所选表格没有可用数据")
    cfg = resolve_llm(user_id, "chat")
    from .llm import LLMClient
    client = LLMClient(cfg, user_id=user_id)
    prompt = (
        f"【源表清单（共 {len(parts)} 张）】\n" + "\n\n".join(parts) +
        f"\n\n【用户指令】{instruction}\n\n"
        "把以上多张表合成一张汇总表：相同主题的行列对齐合并，重复条目去重或并列并标注来源编号，"
        "数据冲突时全部保留并排展示。合成结果必须是矩形网格（每行列数一致），"
        "表头行清晰标注各列含义，数据不得编造。\n"
        '输出严格 JSON：{"rows": [[..], ..], "note": "一句话说明合并方式"}')
    raw = client.complete(
        [{"role": "system", "content": _TIDY_SYSTEM}, {"role": "user", "content": prompt}],
        max_tokens=6000)
    d = _parse_json_relaxed(raw)
    if d is None:
        raise ValueError("模型输出无法解析")
    rows = d.get("rows")
    ok = (isinstance(rows, list) and 1 <= len(rows) <= 500
          and all(isinstance(r, list) and 1 <= len(r) <= 100 and len(r) == len(rows[0]) for r in rows))
    if not ok:
        raise ValueError("模型输出不是合法矩形网格（或超出 500×100 限制）")
    return {"rows": rows, "note": (d.get("note") or "")[:300]}


def merge_create(user_id: int, te_ids: list, instruction: str) -> dict:
    """创建合并表：取源表 → merge_one → 落库（版本 v1）。同步 LLM 调用（端点 offload）。"""
    if len(te_ids) < 2:
        raise ValueError("至少选择 2 张表才能合并")
    if len(te_ids) > _MERGE_MAX_SOURCES:
        raise ValueError(f"一次最多合并 {_MERGE_MAX_SOURCES} 张源表")
    ph = ",".join("?" * len(te_ids))
    tes = [dict(r) for r in db.all(
        f"SELECT * FROM table_extracts WHERE user_id=? AND id IN ({ph}) AND review != 'deleted'",
        (user_id, *te_ids))]
    if len(tes) < 2:
        raise ValueError("可选源表不足 2 张（已剔除/不存在的表被忽略）")
    r = merge_one(user_id, tes, instruction)
    import secrets as _sec
    mid = "m" + _sec.token_hex(8)
    ver = {"v": 1, "grid": r["rows"], "note": r["note"],
           "ts": datetime.now().strftime("%m-%d %H:%M")}
    with db.write() as c:
        c.execute(
            "INSERT INTO table_merges(id,user_id,title,instruction,grid,note,source_ids,versions,cur_ver) "
            "VALUES(?,?,?,?,?,?,?,?,1)",
            (mid, user_id, (r["note"] or instruction)[:60], instruction,
             json.dumps(r["rows"], ensure_ascii=False), r["note"],
             json.dumps([t["id"] for t in tes]), json.dumps([ver], ensure_ascii=False)))
    return {"merge": db.one("SELECT * FROM table_merges WHERE id=?", (mid,))}


def merge_regen(user_id: int, mid: str, instruction: str) -> dict:
    """重新合成（改指令）：以源表 + 新指令再跑一次 → 追加版本（历史保留可回看）。"""
    m = db.one("SELECT * FROM table_merges WHERE id=? AND user_id=?", (mid, user_id))
    if m is None:
        raise ValueError("合并表不存在")
    src_ids = json.loads(m["source_ids"] or "[]")
    ph = ",".join("?" * len(src_ids)) if src_ids else None
    tes = [dict(r) for r in db.all(
        f"SELECT * FROM table_extracts WHERE user_id=? AND id IN ({ph}) AND review != 'deleted'",
        (user_id, *src_ids))] if src_ids else []
    r = merge_one(user_id, tes, instruction)
    versions = json.loads(m["versions"] or "[]")
    nv = (versions[-1]["v"] + 1) if versions else 1
    versions.append({"v": nv, "grid": r["rows"], "note": r["note"],
                     "ts": datetime.now().strftime("%m-%d %H:%M")})
    with db.write() as c:
        c.execute("UPDATE table_merges SET instruction=?, grid=?, note=?, versions=?, cur_ver=?, "
                  "updated_at=datetime('now') WHERE id=?",
                  (instruction, json.dumps(r["rows"], ensure_ascii=False), r["note"],
                   json.dumps(versions, ensure_ascii=False), nv, mid))
    return {"merge": db.one("SELECT * FROM table_merges WHERE id=?", (mid,))}


def merge_revert(user_id: int, mid: str, ver: int) -> dict:
    """回看/回滚：grid 与 note 切到指定版本（版本栈保留，可再切回）。"""
    m = db.one("SELECT * FROM table_merges WHERE id=? AND user_id=?", (mid, user_id))
    if m is None:
        raise ValueError("合并表不存在")
    versions = json.loads(m["versions"] or "[]")
    v = next((x for x in versions if x["v"] == ver), None)
    if v is None:
        raise ValueError(f"版本 v{ver} 不存在")
    with db.write() as c:
        c.execute("UPDATE table_merges SET grid=?, note=?, cur_ver=?, updated_at=datetime('now') WHERE id=?",
                  (json.dumps(v["grid"], ensure_ascii=False), v["note"], ver, mid))
    return {"merge": db.one("SELECT * FROM table_merges WHERE id=?", (mid,))}


# ---------------- 统计 ----------------
def by_paper_stats(user_id: int, scope_where: str = "", scope_args: tuple = ()) -> list[dict]:
    """按论文聚合（张数/已整理/需复核/已剔除）+ 论文属性（created_at/page_count/
    file_size）——卡片墙分组按侧栏同款键排序用（v1.12 侧栏合并后两侧顺序必须一致）。
    scope_where 供随选中的文献库/批次收窄：只收窄库/批次维度，review 口径与全量一致。"""
    return [dict(r) for r in db.all(
        "SELECT te.paper_id, p.title, p.created_at, p.page_count, p.file_size, COUNT(*) n, "
        "SUM(CASE WHEN te.ai_status='done' THEN 1 ELSE 0 END) done, "
        "SUM(CASE WHEN te.ai_status='mismatch' THEN 1 ELSE 0 END) mismatch, "
        "SUM(CASE WHEN te.review='deleted' THEN 1 ELSE 0 END) deleted "
        "FROM table_extracts te JOIN papers p ON p.id = te.paper_id "
        "WHERE te.user_id=? " + scope_where +
        " GROUP BY te.paper_id, p.title, p.created_at, p.page_count, p.file_size "
        " ORDER BY n DESC, p.title",
        (user_id, *scope_args))]


def stats(user_id: int) -> dict:
    counts = {"total": 0, "pending": 0, "queued": 0, "running": 0, "done": 0,
              "mismatch": 0, "failed": 0, "kept": 0, "deleted": 0}
    for r in db.all("SELECT review, ai_status, COUNT(*) n FROM table_extracts "
                    "WHERE user_id=? GROUP BY review, ai_status", (user_id,)):
        counts["total"] += r["n"]
        counts[r["review"]] = counts.get(r["review"], 0) + r["n"]
        counts[r["ai_status"]] = counts.get(r["ai_status"], 0) + r["n"]
    counts["working"] = counts.get("queued", 0) + counts.get("running", 0)
    by_paper = by_paper_stats(user_id)
    by_batch = [dict(r) for r in db.all(
        "SELECT batch, COUNT(*) n, "
        "SUM(CASE WHEN ai_status='done' THEN 1 ELSE 0 END) done, "
        "SUM(CASE WHEN review='deleted' THEN 1 ELSE 0 END) deleted, "
        "MAX(created_at) last_at "
        "FROM table_extracts WHERE user_id=? AND batch IS NOT NULL "
        "GROUP BY batch ORDER BY last_at DESC LIMIT 12", (user_id,))]
    # 按文献库聚合（表格随论文挂库；共享库同样计入——左栏「文献库」分组用）
    by_collection = by_collection_stats(user_id)
    return {"counts": counts, "by_paper": by_paper, "by_batch": by_batch,
            "by_collection": by_collection}


def by_collection_stats(user_id: int) -> list[dict]:
    """按文献库聚合 + 层级化：输出父在子前的树序（depth 缩进用），父库 subtree_n
    含全部子孙库（与「删库删整棵子树」语义一致）；has_children 供前端画展开箭头。
    只含有表格的库（内连接）——空库本就不进左栏。"""
    flat = [dict(r) for r in db.all(
        "SELECT pc.collection_id, c.name, c.parent_id, COUNT(DISTINCT te.id) n, "
        "CASE WHEN c.owner_id=? THEN 0 ELSE 1 END AS shared "
        "FROM table_extracts te "
        "JOIN paper_collections pc ON pc.paper_id = te.paper_id "
        "JOIN collections c ON c.id = pc.collection_id "
        "WHERE te.user_id=? GROUP BY pc.collection_id, c.name, c.parent_id, shared",
        (user_id, user_id))]
    by_id = {r["collection_id"]: r for r in flat}
    children: dict = {}
    for r in flat:
        children.setdefault(r["parent_id"], []).append(r)

    def rollup(cid, seen=()):
        r = by_id.get(cid)
        if r is None or cid in seen:   # seen 防脏数据环
            return 0
        n = r["n"]
        for ch in children.get(cid, []):
            n += rollup(ch["collection_id"], seen + (cid,))
        r["subtree_n"] = n
        r["has_children"] = bool(children.get(cid))
        return n

    out: list[dict] = []

    def emit(pid, depth):
        for r in sorted(children.get(pid, []), key=lambda x: (-x["n"], x["name"])):
            rollup(r["collection_id"])
            r["depth"] = depth
            out.append(r)
            emit(r["collection_id"], depth + 1)

    emit(None, 0)
    return out


# ---------------- 跨表聚合（对比大表） ----------------
def _norm_header(cells: list[list[str]]) -> tuple[str, ...]:
    """规范化表头签名（小写去空格符号）——同构表判定用。"""
    if not cells or not cells[0]:
        return tuple()
    return tuple(re.sub(r"[\s\W]+", "", c.lower()) for c in cells[0])


def merge_tables(items: list[dict], mode: str = "stack") -> dict:
    """N 张表 → 1 张对比大表。

    mode=stack：纵向堆叠——每源表前插入 [来源] 隔离行 + 各自表头行，数据保真可溯源。
    mode=aligned：同构合并——表头签名一致的表共享一个表头，数据行直接堆叠
                  （差异表的行用来源标记）；表头不一致的表按 stack 处理。
    返回 {grid, notes:[...], aligned_n, stacked_n}
    """
    if not items:
        return {"grid": [], "notes": ["没有选择任何表格"], "aligned_n": 0, "stacked_n": 0}
    notes: list[str] = []
    grid: list[list[str]] = []
    aligned_n = stacked_n = 0
    if mode == "aligned":
        groups: dict[tuple, list[dict]] = {}
        for it in items:
            groups.setdefault(_norm_header(it.get("grid") or []), []).append(it)
        aligned_groups = {k: v for k, v in groups.items() if k and len(v) >= 2}
        singles = [it for k, v in groups.items() if not k or len(v) < 2 for it in v]
        for hdr, group in aligned_groups.items():
            first = group[0]
            grid.append([f"【{first.get('paper_title') or ''}·p{(first.get('page_index') or 0)+1}】" ] +
                        first["grid"][0][1:] if False else list(first["grid"][0]))
            # 表头行后标注来源列说明
            for gi, it in enumerate(group):
                src = f"{it.get('paper_title') or '来源'}·p{(it.get('page_index') or 0)+1}"
                for r, row in enumerate(it["grid"][1:], 1):
                    grid.append([f"[{src}] {row[0]}" if r == 1 or not row[0] else row[0]] + row[1:])
                if gi < len(group) - 1:
                    grid.append(["—"] * len(hdr))
            aligned_n += len(group)
            notes.append(f"同构合并 {len(group)} 张（表头一致）")
        for it in singles:
            src = f"{it.get('paper_title') or '来源'}·p{(it.get('page_index') or 0)+1}"
            grid.append([f"━━ {src} ━━"] + [""] * max(0, len(grid[0]) - 1 if grid else 0))
            grid.extend(it["grid"])
            stacked_n += 1
        if singles:
            notes.append(f"{len(singles)} 张表头不一致 → 原样堆叠")
    else:
        for it in items:
            src = f"{it.get('paper_title') or '来源'}·p{(it.get('page_index') or 0)+1} · {it.get('caption') or ''}"
            grid.append([f"━━ {src[:80]} ━━"] + [""] * max(0, (len((it.get('grid') or [[]])[0]) - 1)))
            grid.extend(it.get("grid") or [])
            stacked_n += 1
    return {"grid": grid, "notes": notes, "aligned_n": aligned_n, "stacked_n": stacked_n}


def export_merged(items: list[dict], mode: str = "stack") -> bytes:
    """聚合大表 → 单 sheet xlsx。"""
    m = merge_tables(items, mode)
    return build_xlsx([{"paper_title": "跨表聚合", "page_index": 0,
                        "caption": f"对比大表（{m['aligned_n']} 张对齐 + {m['stacked_n']} 张堆叠）",
                        "grid": m["grid"]}])


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
                lens = [len(str(grid[r][c - 1]))
                        for r in range(min(3, len(grid)))
                        if c - 1 < len(grid[r]) and grid[r][c - 1] is not None]
                w = (max(lens) if lens else 0) + 4      # str/int 混合比较 TypeError（曾用 or "" 兜底反而引入）
                ws.column_dimensions[get_column_letter(c)].width = min(40, max(8, w))
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
