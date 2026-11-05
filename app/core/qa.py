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

_CITE = re.compile(r"\[(\d{1,2})\]")

PRESET_QUESTIONS = [
    "这篇论文的核心贡献是什么？",
    "方法的关键机制和整体流程是怎样的？",
    "实验用了哪些数据集、基线和评价指标？主要结果如何？",
    "论文承认的局限性有哪些？",
]


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


def _build_context(mode: str, papers: list[dict], question: str,
                   user: dict) -> tuple[str, list[dict], bool]:
    """返回 (context_text, evidence_list, truncated)。

    evidence: [{evidence_id, paper_id, title, page_index, block_id, text}]
    """
    budget = int(config.get("qa", "context_char_budget"))
    evidence: list[dict] = []
    parts: list[str] = []
    used = 0
    truncated = False

    if mode == "fulltext":
        for p in papers:
            blocks = _paper_blocks(p["id"])
            paper_used = 0
            paper_parts = [f"=== 论文: {p['title']} (paper_id={p['id']}) ==="]
            for b in blocks:
                t = b["text"].strip()
                if not t:
                    continue
                line = f"[{p['id']}|p{b['page_index'] + 1}|{b['block_id']}] ({b['section_path']}) {t}"
                if used + paper_used + len(line) > budget:
                    truncated = True
                    break
                eid = len(evidence) + 1
                evidence.append({
                    "evidence_id": eid, "paper_id": p["id"], "title": p["title"],
                    "page_index": b["page_index"], "block_id": b["block_id"], "text": t[:300],
                })
                paper_parts.append(line)
                paper_used += len(line)
            parts.extend(paper_parts)
            used += paper_used
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
                    "text": h["text"][:300],
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
    context = re.sub(r"\[([a-z0-9]+\|p\d+\|[a-z0-9\-v]+)\]", _renumber, context)
    return context, evidence, truncated


SYSTEM = (
    "你是学术论文问答助手。规则：\n"
    "1. 只依据提供的证据材料回答；证据不足时明确说\"材料中未找到\"，禁止编造\n"
    "2. 每个论断后标注证据编号 [n]（对应材料中给出的编号）\n"
    "3. 涉及数字、实验设置、指标时精确引用原文数值\n"
    "4. 用简体中文回答（术语可保留英文）"
)


def answer(user: dict, question: str, paper_ids: list[str], mode: str = "auto") -> dict:
    """返回 {mode, evidence, truncated}；答案由上层流式接口消费。"""
    from .llm import NoKeyError, resolve_llm

    cfg = resolve_llm(user["id"], "chat")
    multi_max = int(config.get("qa", "multi_paper_max"))
    if len(paper_ids) > multi_max:
        raise ValueError(f"跨论文对比最多 {multi_max} 篇")

    papers = []
    for pid in paper_ids:
        p = db.one(
            "SELECT id, title, owner_id, visibility FROM papers WHERE id=? AND deleted_at IS NULL",
            (pid,),
        )
        if p is None:
            raise ValueError(f"论文 {pid} 不存在")
        if p["visibility"] == "private" and p["owner_id"] != user["id"] and user["role"] != "admin":
            raise ValueError(f"无权访问论文 {pid}")
        if not _paper_blocks(pid):
            raise ValueError(f"论文 {p['title']} 尚未解析完成")
        papers.append(dict(p))

    if mode == "auto":
        mode = "fulltext" if len(papers) == 1 else "retrieval"
    if mode == "fulltext" and len(papers) == 1:
        total = sum(len(b["text"]) for b in _paper_blocks(papers[0]["id"]))
        if _estimate_tokens(total) > int(config.get("qa", "fulltext_max_tokens")):
            mode = "retrieval"

    context, evidence, truncated = _build_context(mode, papers, question, user)
    return {"cfg": cfg, "mode": mode, "context": context, "evidence": evidence,
            "truncated": truncated, "question": question}


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
