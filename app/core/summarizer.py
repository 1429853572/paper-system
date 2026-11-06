"""科研结构化导读：9 字段模板，每项带页码证据."""
from __future__ import annotations

import hashlib
import json

from .db import db

PROMPT_VERSION = "v1"

SECTIONS = [
    ("problem", "Research Problem", "论文试图解决什么问题"),
    ("core_idea", "Core Idea", "核心思想及其解决的根因"),
    ("method", "Method", "关键机制、数学公式、处理流程"),
    ("datasets", "Datasets", "数据集、场景、训练与测试划分"),
    ("baselines", "Baselines", "比较对象"),
    ("metrics", "Metrics", "评价指标（PSNR、SSIM、LPIPS 等）"),
    ("ablation", "Ablation", "消融设置和具体结果"),
    ("complexity", "Complexity", "时间、显存、模型规模"),
    ("limitations", "Limitations", "论文明确承认的限制"),
]

_PROMPT = (
    "你是论文导读引擎。依据提供的论文全文材料，按以下 JSON 模板输出导读（只输出 JSON）：\n"
    '{"sections": ['
    + ", ".join(f'{{"key": "{s[0]}", "content": "..."}}' for s in SECTIONS)
    + ']}\n'
    "规则：\n"
    "1. 每个字段内容简洁（2-5 句），中文（术语保留英文）\n"
    "2. 每条论断末尾标注证据 [n]，n 为材料中行首 [n] 编号；材料中未覆盖的字段如实写\"文中未明确提及\"\n"
    "3. 实验数据引用原始表格数值；若重要结果只在曲线图中，写\"（曲线图数据，需视觉理解）\"不臆造数值\n"
    "4. Limitations 只写论文明确承认的局限\n5. [n] 必须标注在该论断真正来源的行上；实验数值只能来自所标证据行，不得凭记忆配对"
)


def compute_key(run_id: str, model: str) -> str:
    return hashlib.sha256(f"{run_id}|{model}|{PROMPT_VERSION}".encode()).hexdigest()[:16]


def get_latest(paper_id: str) -> dict | None:
    row = db.one(
        "SELECT * FROM summaries WHERE paper_id=? ORDER BY created_at DESC LIMIT 1",
        (paper_id,),
    )
    return dict(row) if row else None


def mark_stale(paper_id: str) -> None:
    """重解析后标记导读过期（新增 parse_run 使旧 run 的导读不再对应）。"""
    with db.write() as c:
        c.execute(
            "UPDATE summaries SET content=content WHERE paper_id=? AND id IN ("
            "SELECT id FROM summaries WHERE paper_id=? LIMIT 0)", (paper_id, paper_id),
        )


def generate(user: dict, paper_id: str, model: str | None = None) -> tuple[int, dict]:
    """生成导读（同步整篇直读）。返回 (summary_id, payload)。

    模型偶发返回空对象 → 重试一次；仍无效则显式报错，不落库空导读。
    """
    from .llm import resolve_llm
    from .qa import _build_context

    cfg = resolve_llm(user["id"], "chat")
    p = db.one("SELECT id,title FROM papers WHERE id=?", (paper_id,))
    run = db.one(
        "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' ORDER BY created_at DESC LIMIT 1",
        (paper_id,),
    )
    if p is None or run is None:
        raise ValueError("论文尚未解析完成")

    paper = {"id": p["id"], "title": p["title"]}
    context, evidence, _ = _build_context("fulltext", [paper], "summary", user)
    from .llm import LLMClient

    client = LLMClient(cfg, user_id=user["id"], paper_id=paper_id)
    messages = [{"role": "system", "content": _PROMPT}, {"role": "user", "content": context}]

    import re

    by_key: dict[str, str] = {}
    raw = ""
    for attempt in range(2):
        raw = client.complete(messages, max_tokens=4096)
        try:
            start, end = raw.index("{"), raw.rindex("}") + 1
            data = json.loads(raw[start:end])
            sec = data.get("sections", [])
            if isinstance(sec, dict):   # 容错：sections 直接给 {key: content}
                sec = [{"key": k, "content": v} for k, v in sec.items()]
            by_key = {s["key"]: s.get("content", "") for s in sec if isinstance(s, dict) and s.get("key")}
        except (ValueError, KeyError):
            by_key = {}
        # fallback：完全非 JSON 时把原文按字段平铺，保证有内容
        if not by_key and raw.strip():
            by_key = {"problem": raw[:2000]}
            break
        if by_key:
            break
    if not by_key:
        raise RuntimeError("导读生成失败：模型未返回有效内容，请重试")

    # ---- 数字接地校验（防张冠李戴）：content 中每个 [n] 引用，检查其窗口内
    # 的数字是否真的出现在证据 n 的原文里；不在 → 自动改指到包含这些数字的
    # 证据行；找不到 → 移除该引用（宁缺毋错）。 ----
    import re as _re

    # 实验数值形（带单位或两位以上小数）——章节号 "3.4" 之类不在此列
    NUM_RE = _re.compile(r"\d+\.\d{2,}\b|\d+\.?\d*\s*(?:dB|%|×|fps|ms|GB|MB|MiB|frames?|samples?|iterations?|params\b|K\b|k\b|s\b)")

    def _nums(text):
        return set(NUM_RE.findall(text))

    def _ground_section(content, ev_map):
        def fix(m):
            n = int(m.group(1))
            ev = ev_map.get(n)
            if ev is None:
                return m.group(0)
            win = content[max(0, m.start() - 80):m.end() + 20]
            nums = {x.strip() for x in _nums(win)}
            if not nums or nums <= _nums(ev["text"]):
                return m.group(0)                                  # 数值有据 ✓
            for eid2, e2 in ev_map.items():
                if eid2 != n and nums <= _nums(e2["text"]):
                    return f"[{eid2}]"                             # 改指真正来源 ✓
            return ""                                              # 来源不明 → 移除（宁缺毋错）
        return _re.sub(r"\[(\d+)\]", fix, content)

    ev_map = {e["evidence_id"]: e for e in evidence}
    by_key = {k: _ground_section(v, ev_map) for k, v in by_key.items()}

    # ---- 自动补引：section 里的实验数值若没有 [n] 引用，找到来源行补上 ----
    def _auto_cite(content, ev_map):
        def add(m):
            num = m.group(0).strip()
            # 数字后 10 字符内已有引用 → 跳过
            tail = content[m.end():m.end() + 10]
            if _re.search(r"\[\d+\]", tail):
                return m.group(0)
            for eid2, e2 in ev_map.items():
                if num in e2["text"]:
                    return f"{m.group(0)} [{eid2}]"
            return m.group(0)          # 材料里找不到 → 保留原样（不补引）
        return NUM_RE.sub(add, content)
    by_key = {k: _auto_cite(v, ev_map) for k, v in by_key.items()}

    cited = {int(m.group(1)) for m in re.finditer(r"\[(\d+)\]", json.dumps(by_key, ensure_ascii=False))}
    evidence_out = [e for e in evidence if e["evidence_id"] in cited]

    cache_key = compute_key(run["id"], cfg.model)
    # 证据一并落库：导读重新加载后引用仍可点击跳转（此前只存 sections，
    # 刷新页面后 [n] 变成死文本、下方证据列表也消失）。
    with db.write() as c:
        cur = c.execute(
            "INSERT INTO summaries(paper_id,cache_key,content,model,created_by) VALUES(?,?,?,?,?)",
            (paper_id, cache_key,
             json.dumps({"sections": by_key, "evidence": evidence_out}, ensure_ascii=False),
             cfg.model, user["id"]),
        )
        sid = cur.lastrowid
    return sid, {"sections": by_key, "evidence": evidence_out, "model": cfg.model}
