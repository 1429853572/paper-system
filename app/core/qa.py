"""证据问答引擎.

路由（按"是否超上下文"一条规则）:
- 单篇: 全文直读（blocks 全量带标注喂入），质量优先
- 多篇(≤10): 字符预算内直接拼；超了 → 混合检索取证
- 引用受控: 检索/直读证据块分配 evidence_id，LLM 只能引用所给 ID；
  程序校验引用合法性（不做 LLM 二次事实校验）
"""
from __future__ import annotations

import json
import re
from typing import Any

from .config import config
from .db import db
from .retrieval import search

_CITE = re.compile(r"\[(\d{1,4})\]")   # 全文直读模式证据可达数百条



def _paper_blocks(paper_id: str) -> list[dict]:
    rows = db.all(
        "SELECT b.block_id, b.type, b.section_path, b.page_index, b.text "
        "FROM blocks b JOIN parse_runs r ON r.id=b.parse_run_id "
        "WHERE b.paper_id=? AND r.status='done' "
        "ORDER BY b.page_index, b.block_index",
        (paper_id,),
    )
    return [dict(r) for r in rows]


def _estimate_tokens(text: str | int) -> int:
    """字符串或字符数（int）均可；粗估 token 数。"""
    n = len(text) if isinstance(text, str) else int(text)
    return int(n / 3.5)


def _build_context(mode: str, papers: list[dict], question: str, user: dict,
                   blocks_by_paper: dict[str, list[dict]] | None = None,
                   qvec=None) -> tuple[str, list[dict], bool]:
    """返回 (context_text, evidence_list, truncated)。

    evidence: [{evidence_id, paper_id, title, page_index, block_id, text}]
    blocks_by_paper: 调用方已加载的 blocks 缓存（避免一次提问重复全量加载）；
    qvec: 问题向量（多篇 smart 模式只算一次 embedding）。
    """
    budget = int(config.get("qa", "context_char_budget"))
    if mode == "fulltext":
        # 全文直读预算跟随 fulltext_max_tokens（token→字符 ≈ ×3.5）；
        # 小上下文模型把 fulltext_max_tokens 调小即可整体降级，无需另配
        budget = int(int(config.get("qa", "fulltext_max_tokens")) * 3.5)
    evidence: list[dict] = []
    parts: list[str] = []
    used = 0
    truncated = False
    blocks_by_paper = blocks_by_paper or {}

    def _blocks(pid: str) -> list[dict]:
        blocks = blocks_by_paper.get(pid)
        if blocks is None:
            blocks = _paper_blocks(pid)
            blocks_by_paper[pid] = blocks
        return blocks

    def _add(p: dict, page_index: int, block_id: str, line: str, text: str) -> bool:
        """追加一条证据；超预算返回 False（调用方停止本篇）。"""
        nonlocal used
        eid = len(evidence) + 1
        evidence.append({
            "evidence_id": eid, "paper_id": p["id"], "title": p["title"],
            "page_index": page_index, "block_id": block_id,
            "text": text,
        })
        parts.append(line)
        used += len(line)
        return True

    if mode == "fulltext":
        for p in papers:
            parts.append(f"=== 论文: {p['title']} (paper_id={p['id']}) ===")
            for b in _blocks(p["id"]):
                t = b["text"].strip()
                if not t:
                    continue
                line = f"[{p['id']}|p{b['page_index'] + 1}|{b['block_id']}] ({b['section_path']}) {t}"
                if used + len(line) > budget:
                    truncated = True
                    break
                # 全文保留（done 事件只下发被引用项；数字接地需要全文）
                _add(p, b["page_index"], b["block_id"], line, t)
    elif mode == "smart":
        # 两段式：章节摘要定位 → 只喂命中章节的原文（质量≈全文，token≈检索）。
        # 注意 pick_relevant_sections 只查最新 done run 的摘要。
        from .summarizer import pick_relevant_sections
        top_secs = int(config.get("qa", "smart_top_sections") or 3)
        for p in papers:
            blocks = _blocks(p["id"])
            secs = pick_relevant_sections(p["id"], question, top_k=top_secs, qvec=qvec)
            chosen = {s["section_path"] for s in secs}
            sel = [b for b in blocks if (b["section_path"] or "").strip() in chosen]
            if not sel:   # 无命中章节（太短被跳过等）→ 单篇检索兜底
                hits = search(question, user_id=user["id"],
                              is_admin=user["role"] == "admin", paper_ids=[p["id"]], top_k=6)
                parts.append(f"=== 论文: {p['title']} (paper_id={p['id']}) ===")
                for h in hits:
                    line = f"[{p['id']}|p{h['page_index'] + 1}|{json.loads(h['block_ids'])[0]}] {h['text'][:800]}"
                    if used + len(line) > budget:
                        truncated = True
                        break
                    _add(p, h["page_index"], json.loads(h["block_ids"])[0], line, h["text"])
                continue
            parts.append(f"=== 论文: {p['title']} (paper_id={p['id']}) ===")
            for b in sel:
                t = b["text"].strip()
                if not t:
                    continue
                line = f"[{p['id']}|p{b['page_index'] + 1}|{b['block_id']}] ({b['section_path']}) {t}"
                if used + len(line) > budget:
                    truncated = True
                    break
                _add(p, b["page_index"], b["block_id"], line, t)
    else:  # retrieval
        paper_ids = [p["id"] for p in papers]
        per_paper = max(3, 12 // max(1, len(papers)))
        for p in papers:
            hits = search(question, user_id=user["id"], is_admin=user["role"] == "admin",
                          paper_ids=[p["id"]], top_k=per_paper)
            if not hits:
                parts.append(f"=== 论文: {p['title']} (paper_id={p['id']}) ===\n（未检索到相关证据）")
                continue
            paper_parts = [f"=== 论文: {p['title']} (paper_id={p['id']}) ==="]
            for h in hits:
                line = f"[{p['id']}|p{h['page_index'] + 1}|{h['block_ids'][0]}] {h['text'][:800]}"
                if used + len(line) > budget:
                    truncated = True
                    break
                eid = len(evidence) + 1
                evidence.append({
                    "evidence_id": eid, "paper_id": p["id"], "title": p["title"],
                    "page_index": h["page_index"],
                    "block_id": json.loads(h["block_ids"])[0],
                    "text": h["text"],
                })
                paper_parts.append(line)
                used += len(line)
            parts.extend(paper_parts)

    context = "\n\n".join(parts)
    # evidence_id 重新连续编号并回写 context 行首标号 → 用 [n] 简号给模型
    remap = {e["paper_id"] + f"|p{e['page_index'] + 1}|{e['block_id']}": e["evidence_id"]
             for e in evidence}
    def _renumber(m: re.Match) -> str:
        return f"[{remap.get(m.group(1), '?')}]"
    # block_id 格式随版本变化（可能含下划线/连字符）→ 用宽松匹配，避免重编号失效
    context = re.sub(r"\[([a-z0-9]+\|p\d+\|[^\]\s]+)\]", _renumber, context)
    return context, evidence, truncated


SYSTEM = (
    "你是学术论文问答助手。规则：\n"
    "1. 只依据提供的证据材料回答；证据不足时明确说\"材料中未找到\"，禁止编造\n"
    "2. 每个论断后标注证据编号 [n]（对应材料中给出的编号）\n"
    "3. 涉及数字、实验设置、指标时精确引用原文数值\n"
    "4. 用简体中文回答（术语可保留英文）\n"
    "5. 正文答完后另起一段收尾，只用一两句话：结合论文内容指出还值得深挖的方向或建议的下一步"
    "（例如先看某张图/某张表、复现某个实验、对比某个基线、或核实某个数值），"
    "并以问句询问用户是否需要继续；不要复述正文，也不要罗列多个问题"
)

# 多篇（≥2 篇）时附加的对比规则：按维度组织、明确异同、每篇立场分开说
COMPARE_ADDENDUM = (
    "\n6. 当前是多论文对比：按维度组织回答（如研究问题/方法/数据集与指标/主要结果/结论），"
    "不要逐篇流水账；每个论断明确指出是哪篇论文的（可结合其标题简称），"
    "异同分开表述——先说共识再说分歧；分歧处若因实验设置不同导致，点明原因\n"
    "7. 涉及效果比较时基于各自报告的数值，注明实验环境差异，不做无依据的优劣判断"
)



def answer(user: dict, question: str, paper_ids: list[str], mode: str = "auto") -> dict:
    """返回 {mode, evidence, truncated}；答案由上层流式接口消费。"""
    from .llm import NoKeyError, resolve_llm

    cfg = resolve_llm(user["id"], "chat")
    multi_max = int(config.get("qa", "multi_paper_max"))
    if len(paper_ids) > multi_max:
        raise ValueError(f"跨论文对比最多 {multi_max} 篇")

    papers = []
    blocks_by_paper: dict[str, list[dict]] = {}
    for pid in paper_ids:
        p = db.one(
            "SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL",
            (pid,),
        )
        if p is None:
            raise ValueError(f"论文 {pid} 不存在")
        if p["visibility"] == "private" and p["owner_id"] != user["id"] and user["role"] != "admin":
            raise ValueError(f"无权访问论文 {pid}")
        blocks = _paper_blocks(pid)
        if not blocks:
            raise ValueError(f"论文 {p['title']} 尚未解析完成")
        blocks_by_paper[pid] = blocks   # 一次加载，存在性检查/估算/构建上下文三处复用
        papers.append(dict(p))

    if mode == "auto":
        # 两段式优先（最新 done run 有章节摘要 → 只喂命中章节，省 60~80% token）；
        # 无摘要则全文直读（整体理解最好）；总量超预算再降级为检索取证
        latest_run = db.one(
            "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
            "ORDER BY created_at DESC LIMIT 1", (papers[0]["id"],))
        has_sum = bool(latest_run and db.one(
            "SELECT 1 FROM section_summaries WHERE paper_id=? AND run_id=? LIMIT 1",
            (papers[0]["id"], latest_run["id"])))
        mode = "smart" if has_sum else "fulltext"
    if mode == "fulltext":
        total = sum(len(b["text"]) for pid in paper_ids for b in blocks_by_paper[pid])
        if _estimate_tokens(total) > int(config.get("qa", "fulltext_max_tokens")):
            mode = "retrieval"

    qvec = None
    if mode == "smart":
        # 问题向量只算一次（多篇共享）；embedding 不可用 → 降级检索
        try:
            import numpy as np
            from .retrieval import embed_texts
            qvec = np.array(embed_texts([question])[0], dtype=np.float32)
        except Exception:  # noqa: BLE001
            mode = "retrieval"

    context, evidence, truncated = _build_context(mode, papers, question, user,
                                                  blocks_by_paper, qvec)
    # 多篇 → 附对比规则（副本，避免污染模块常量）
    system = SYSTEM + (COMPARE_ADDENDUM if len(papers) >= 2 else "")
    return {"cfg": cfg, "mode": mode, "context": context, "evidence": evidence,
            "truncated": truncated, "question": question, "system": system}


def validate_citations(answer_text: str, evidence: list[dict]) -> dict:
    """程序校验：引用编号合法（存在于本次证据集）。"""
    valid_ids = {e["evidence_id"] for e in evidence}
    cited = {int(m) for m in _CITE.findall(answer_text)}
    illegal = sorted(c for c in cited if c not in valid_ids)
    return {
        "cited": sorted(cited),
        "illegal": illegal,
        "ok": not illegal,
        "evidence": [e for e in evidence if e["evidence_id"] in cited],
    }
