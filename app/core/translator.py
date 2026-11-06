"""结构化翻译引擎.

设计（计划定稿）:
- 最小对齐单位=自然段(block)；多个连续段合并为一次请求，携带稳定 block_id 要求按 ID 返回
- 完整性校验: 返回缺段 → 缺段重试；公式/LaTeX 原样保护；表格只译文本单元格
- 术语表全局共享 + 人工锁定（keep_en/指定译法/first_both）
- 缓存键 = sha256(source_hash + model + prompt_version + glossary_version + lang)
  → translations 表多版本并存；换模型显式重翻生成新版本
- 参考文献(References 之后)默认跳过
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .db import db
from .glossary import glossary_block, glossary_version

PROMPT_VERSION = "v1"

# 一次请求合并的目标字符数（~650 token 英文）
_BATCH_TARGET_CHARS = 850
_MAX_BATCH_BLOCKS = 8

_SKIP_TYPES = {"equation", "image", "chart"}   # 原样保留不翻译的块
_REF_HEADING = re.compile(r"^\s*(references|bibliography|works cited|参考文献)\s*$", re.I)
_FORMULA = re.compile(r"(\$\$?.*?\$\$|\\\(.*?\\\)|\\\[.*?\\\])", re.S)


def compute_cache_key(source_hashes: str, model: str, gl_ver: str, lang: str = "zh") -> str:
    h = hashlib.sha256()
    h.update(source_hashes.encode())
    h.update(f"|{model}|{PROMPT_VERSION}|{gl_ver}|{lang}".encode())
    return h.hexdigest()


_tb_cache: dict[str, list[dict]] = {}   # run_id → 可翻译块（done run 的 blocks 不可变，可长期缓存）


def invalidate_block_cache(run_id: str | None = None) -> None:
    """rebuild_from_stored 复用 run_id 重建 blocks 后调用（reindex 端点）。"""
    if run_id is None:
        _tb_cache.clear()
    else:
        _tb_cache.pop(run_id, None)


def _translatable_blocks(paper_id: str, run_id: str) -> list[dict]:
    """取可翻译块：跳过公式/图片；References 小节之后跳过。

    jobstate 轮询/批量翻译会高频调用——按 run_id 缓存（blocks 随 run 不可变）。
    """
    hit = _tb_cache.get(run_id)
    if hit is not None:
        return hit
    rows = db.all(
        "SELECT block_id, type, section_path, text, source_hash FROM blocks "
        "WHERE parse_run_id=? ORDER BY page_index, block_index",
        (run_id,),
    )
    out = []
    in_refs = False
    for r in rows:
        b = dict(r)
        if b["type"] == "title" and _REF_HEADING.match(b["text"] or ""):
            in_refs = True
            continue
        if in_refs:
            continue
        if b["type"] in _SKIP_TYPES or not (b["text"] or "").strip():
            continue
        if b["type"] == "title" and not b["text"].strip():
            continue
        out.append(b)
    _tb_cache[run_id] = out
    return out


def _protect_formulas(text: str) -> tuple[str, dict[str, str]]:
    """公式占位保护，避免模型改写 LaTeX。"""
    store: dict[str, str] = {}

    def repl(m: re.Match) -> str:
        key = f"\x00F{len(store)}\x00"
        store[key] = m.group(0)
        return key

    return _FORMULA.sub(repl, text), store


def _restore_formulas(text: str, store: dict[str, str]) -> str:
    for k, v in store.items():
        text = text.replace(k, v)
    return text


def _build_batches(blocks: list[dict]) -> list[list[dict]]:
    batches, cur, cur_len = [], [], 0
    for b in blocks:
        if cur and (cur_len + len(b["text"]) > _BATCH_TARGET_CHARS or len(cur) >= _MAX_BATCH_BLOCKS):
            batches.append(cur)
            cur, cur_len = [], 0
        cur.append(b)
        cur_len += len(b["text"])
    if cur:
        batches.append(cur)
    return batches


def _translate_batch(cfg, blocks: list[dict], glossary_txt: str) -> dict[str, str]:
    """一次请求翻译多个块；返回 {block_id: 中文}。缺段由调用方重试。"""
    protected = []
    stores: list[dict[str, str]] = []
    lines = []
    for i, b in enumerate(blocks):
        pt, store = _protect_formulas(b["text"])
        stores.append(store)
        protected.append((b, pt))
        lines.append(f"[{b['block_id']}] {pt}")
    src = "\n\n".join(lines)

    sys_prompt = (
        "你是学术论文翻译引擎。把用户给出的多个编号段落翻译成简体中文，规则：\n"
        "1. 严格保持每个 [block_id] 标号，逐段输出，格式为：[block_id] 译文\n"
        "2. 不合并、不拆分、不遗漏段落；不添加解释\n"
        "3. 占位符（如 \x00F0\x00）原样保留，不得翻译或改写\n"
        "4. Markdown 表格保持表格结构，仅翻译文本单元格，数值和列名中的变量不动\n"
        "5. 术语表具有最高优先级\n"
        + (f"术语表：\n{glossary_txt}\n" if glossary_txt else "")
    )
    from .llm import LLMClient
    client = LLMClient(cfg)
    raw = client.complete(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": src}],
        max_tokens=max(2048, len(src)),
    )
    out: dict[str, str] = {}
    for m in re.finditer(r"\[([a-z0-9\-]+)\]\s*(.+?)(?=\n\[|\Z)", raw, re.S):
        block_id, text = m.group(1), m.group(2).strip()
        for store in stores:
            text = _restore_formulas(text, store)
        out[block_id] = text
    return out


def translate_paper(user_id: int, paper_id: str, run_id: str,
                    force_new: bool = False, progress_cb=None,
                    cancel_check=None) -> int:
    """整篇翻译（跳过参考文献）。返回翻译块数。结果按缓存键版本化入库。

    同缓存键已有版本 → 复用（零成本）；force_new=True 强制用当前模型生成新版本。
    cancel_check(): 每批开始前调用，返回 True 表示任务已被外部取消 → 中止并保留已完成段落。
    """
    from .llm import resolve_llm

    cfg = resolve_llm(user_id, "translate")
    gl_ver = glossary_version()
    source_hashes = "|".join(b["source_hash"] for b in _translatable_blocks(paper_id, run_id))
    cache_key = compute_cache_key(source_hashes, cfg.model, gl_ver)

    # 已有该版本（完整覆盖）→ 直接复用（零成本）；取消留下的部分译文不视为可复用版本
    if not force_new:
        expected = len(_translatable_blocks(paper_id, run_id))
        existing = db.one(
            "SELECT COUNT(*) AS n FROM translations WHERE paper_id=? AND cache_key=?",
            (paper_id, cache_key),
        )
        if expected and existing and existing["n"] >= expected:
            return existing["n"]

    blocks = _translatable_blocks(paper_id, run_id)
    batches = _build_batches(blocks)
    gl_block = glossary_block()
    done = 0
    for bi, batch in enumerate(batches):
        if cancel_check and cancel_check():
            break  # 外部取消：保留已完成段落，退出
        got = _translate_batch(cfg, batch, gl_block)
        # 缺段重试（单段单独请求）
        missing = [b for b in batch if b["block_id"] not in got]
        for b in missing:
            try:
                got.update(_translate_batch(cfg, [b], gl_block))
            except Exception as e:  # noqa: BLE001
                import logging
                logging.getLogger("translator").warning(
                    "单段补译失败 %s: %s", b["block_id"], str(e)[:120])
            if b["block_id"] not in got:
                import logging
                logging.getLogger("translator").warning(
                    "段落未获得译文（保留原文）: %s", b["block_id"])
        # 每批立即落库（INSERT OR REPLACE 幂等）：中途异常/重启不丢已完成批次
        rows = [(paper_id, run_id, cache_key, b["block_id"], got.get(b["block_id"], ""),
                 cfg.model, user_id) for b in batch]
        with db.write() as c:
            c.executemany(
                "INSERT OR REPLACE INTO translations(paper_id,parse_run_id,cache_key,block_id,"
                "text_zh,model,created_by) VALUES(?,?,?,?,?,?,?)",
                rows,
            )
        done += len(batch)
        if progress_cb:
            progress_cb(done, len(blocks))

    return done


def bilingual_pairs(paper_id: str, run_id: str, cache_key: str | None = None) -> list[dict]:
    """双语段落交替视图：每块 {block_id, en, zh}。默认取最新版本。"""
    if cache_key is None:
        row = db.one(
            "SELECT cache_key FROM translations WHERE paper_id=? ORDER BY created_at DESC LIMIT 1",
            (paper_id,),
        )
        if row is None:
            return []
        cache_key = row["cache_key"]
    zh_map = {
        r["block_id"]: r["text_zh"]
        for r in db.all(
            "SELECT block_id, text_zh FROM translations WHERE paper_id=? AND cache_key=?",
            (paper_id, cache_key),
        )
    }
    pairs = []
    for r in db.all(
        "SELECT block_id, type, section_path, text, page_index, asset_path, bbox, bbox_pages FROM blocks "
        "WHERE parse_run_id=? ORDER BY page_index, block_index",
        (run_id,),
    ):
        pairs.append({
            "block_id": r["block_id"], "type": r["type"], "section_path": r["section_path"],
            "page_index": r["page_index"], "en": r["text"], "zh": zh_map.get(r["block_id"], ""),
            "asset_path": r["asset_path"], "bbox": r["bbox"], "bbox_pages": r["bbox_pages"],
        })
    return pairs


def translation_versions(paper_id: str) -> list[dict]:
    rows = db.all(
        "SELECT cache_key, model, MAX(created_at) AS at, COUNT(*) AS blocks "
        "FROM translations WHERE paper_id=? GROUP BY cache_key, model ORDER BY at DESC",
        (paper_id,),
    )
    return [dict(r) for r in rows]


def translation_status(paper_id: str) -> dict:
    """译文状态：期望段数 + 各版本完整度（前端按钮/批量跳过依据）."""
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if run is None:
        return {"expected": 0, "versions": [], "complete_any": False}
    expected = len(_translatable_blocks(paper_id, run["id"]))
    rows = db.all(
        "SELECT cache_key, model, COUNT(*) AS n, MAX(created_at) AS at FROM translations "
        "WHERE paper_id=? GROUP BY cache_key, model ORDER BY at DESC", (paper_id,))
    versions = [{"cache_key": r["cache_key"], "model": r["model"],
                 "blocks": r["n"], "complete": r["n"] >= expected} for r in rows]
    return {"expected": expected, "versions": versions,
            "complete_any": any(v["complete"] for v in versions)}
