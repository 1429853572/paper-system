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


def latest_run_id(paper_id: str) -> str | None:
    row = db.one(
        "SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
        "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    return row["id"] if row else None


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

    # 缓存命中：同 run+model+prompt 版本的导读直接复用（重复点击=重复全文 LLM 调用是纯浪费；
    # 批量路径已有此判断，单篇路径补齐）
    ck = compute_key(run["id"], cfg.model)
    cached = db.one("SELECT id, content FROM summaries WHERE paper_id=? AND cache_key=? "
                    "ORDER BY id DESC LIMIT 1", (paper_id, ck))
    if cached:
        try:
            data = json.loads(cached["content"])
            return cached["id"], {"sections": data.get("sections", {}),
                                  "evidence": data.get("evidence", []),
                                  "cite_map": data.get("cite_map", {}),
                                  "model": cfg.model, "cached": True}
        except Exception:  # noqa: BLE001 —— 缓存损坏则重新生成
            pass

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
    # 证据行；找不到 → 移除该引用（宁缺毋错）。
    # 死引用（编号不在证据集里）也一律移除——宁可少标，不可错标。 ----
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
                return ""                                          # 死引用 → 移除
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
    # 改写前（全局 evidence_id 编号）留一份：聊天记录里的导读用全局编号，
    # 因为那里的证据数组也是全局编号，两边必须一致，否则引用会张冠李戴。
    by_key_global = dict(by_key)

    # ---- 每字段独立编号 ----
    # 之前直接用证据集的全局序号（116、183、265…），读者无从对应，底部再铺
    # 一长串"证据: [5] 第1页 [12] 第2页 …"更是噪音。改为：每个字段内按出现
    # 顺序重新编号 1..N，cite_map 记录 字段 → 局部编号 → 全局 evidence_id，
    # 前端据此把 [n] 渲染成可悬停/可跳转的小标。 ----
    cite_map: dict[str, dict[str, int]] = {}
    for k, v in by_key.items():
        local: dict[str, int] = {}
        counter = [0]

        def _renum(m):
            gid = int(m.group(1))
            if gid not in ev_map:
                return ""                       # 死引用 → 去掉
            for i, g in local.items():
                if g == gid:
                    return f"[{i}]"
            counter[0] += 1
            local[str(counter[0])] = gid
            return f"[{counter[0]}]"

        by_key[k] = _re.sub(r"\[(\d+)\]", _renum, v)
        cite_map[k] = local

    used_ids = {gid for local in cite_map.values() for gid in local.values()}
    evidence_out = [e for e in evidence if e["evidence_id"] in used_ids]

    cache_key = compute_key(run["id"], cfg.model)
    # 证据一并落库：导读重新加载后引用仍可点击跳转（此前只存 sections，
    # 刷新页面后 [n] 变成死文本、下方证据列表也消失）。
    with db.write() as c:
        cur = c.execute(
            "INSERT INTO summaries(paper_id,cache_key,content,model,created_by) VALUES(?,?,?,?,?)",
            (paper_id, cache_key,
             json.dumps({"sections": by_key, "evidence": evidence_out, "cite_map": cite_map},
                        ensure_ascii=False),
             cfg.model, user["id"]),
        )
        sid = cur.lastrowid
    return sid, {"sections": by_key, "sections_global": by_key_global,
                 "evidence": evidence_out, "cite_map": cite_map,
                 "model": cfg.model}


# ================= 分层摘要（两段式问答用） =================

def _sections_of(blocks: list[dict]) -> dict[str, list[dict]]:
    """按 section_path 分组（保持页面顺序）。"""
    out: dict[str, list[dict]] = {}
    for b in blocks:
        d = dict(b)          # sqlite3.Row → dict（Row 无 .get）
        path = (d.get("section_path") or "").strip()
        if not path:
            continue
        out.setdefault(path, []).append(d)
    return out


def generate_section_summaries(user: dict, paper_id: str) -> int:
    """为论文生成章节级摘要（每节一段，供提问定位用）。返回生成条数。"""
    from .llm import LLMClient, resolve_llm

    cfg = resolve_llm(user["id"], "chat")
    run_id = latest_run_id(paper_id)
    if run_id is None:
        raise ValueError("论文尚未解析完成")
    blocks = db.all(
        "SELECT block_id, section_path, page_index, text FROM blocks WHERE parse_run_id=? "
        "ORDER BY page_index, block_index", (run_id,))
    groups = _sections_of(blocks)
    if not groups:
        return 0

    client = LLMClient(cfg, user_id=user["id"], paper_id=paper_id)
    rows = []
    for path, bs in groups.items():
        text = "\n".join(b["text"] for b in bs if (b["text"] or "").strip())
        if len(text.strip()) < 200:      # 太短的段落不值得摘要
            continue
        if len(text) > 12000:
            text = text[:12000]
        try:
            summary = client.complete([
                {"role": "system", "content":
                    "用中文概括这一节的核心内容：方法要点、关键结论、具体数字（如有）。"
                    "3~6 句，不要空话，保留术语与数值。"},
                {"role": "user", "content": f"章节：{path}\n\n{text}"},
            ], max_tokens=600).strip()
        except Exception:  # noqa: BLE001
            continue
        if summary:
            rows.append((paper_id, run_id, path, 1, summary))
    if rows:
        with db.write() as c:
            # 旧 run 的章节摘要一并清除（重解析后 section_path/内容可能变化，混喂会错配）
            c.execute("DELETE FROM section_summaries WHERE paper_id=? AND run_id<>?",
                      (paper_id, run_id))
            c.executemany(
                "INSERT OR REPLACE INTO section_summaries"
                "(paper_id,run_id,section_path,level,summary,embedding) VALUES(?,?,?,?,?,NULL)",
                rows)
        _embed_section_summaries(paper_id, run_id)
    return len(rows)


def _embed_section_summaries(paper_id: str, run_id: str) -> None:
    """给章节摘要算向量（用于提问时快速定位相关章节）。"""
    from .retrieval import embed_texts

    rows = db.all(
        "SELECT paper_id, section_path, summary FROM section_summaries "
        "WHERE paper_id=? AND run_id=? AND embedding IS NULL", (paper_id, run_id))
    if not rows:
        return
    try:
        vecs = embed_texts([r["summary"] for r in rows], batch_size=16)
    except Exception:  # noqa: BLE001
        return
    import struct
    with db.write() as c:
        for r, v in zip(rows, vecs):
            c.execute(
                "UPDATE section_summaries SET embedding=? WHERE paper_id=? AND run_id=? "
                "AND section_path=? AND level=1",
                (struct.pack(f"<{len(v)}f", *v), r["paper_id"], run_id, r["section_path"]))


def pick_relevant_sections(paper_id: str, question: str, top_k: int = 2,
                           qvec=None) -> list[dict]:
    """按问题向量选最相关的章节（无摘要时返回空 → 调用方回退）。

    只查最新 done run 的摘要（旧 run 残留会在 generate_section_summaries 时清除）。
    qvec: 调用方已算好的问题向量（多篇共享，免重复 embedding）。
    """
    import numpy as np

    from .retrieval import embed_texts

    run_id = latest_run_id(paper_id)
    if run_id is None:
        return []
    rows = db.all(
        "SELECT section_path, summary, embedding FROM section_summaries "
        "WHERE paper_id=? AND run_id=? AND level=1 AND embedding IS NOT NULL",
        (paper_id, run_id))
    if not rows:
        return []
    try:
        if qvec is None:
            qv = np.array(embed_texts([question])[0], dtype=np.float32)
        else:
            qv = np.asarray(qvec, dtype=np.float32)
    except Exception:  # noqa: BLE001
        return []
    qn = qv / (np.linalg.norm(qv) + 1e-9)
    mat = np.stack([np.array(_unpack(r["embedding"]), dtype=np.float32) for r in rows])
    mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    sims = mat @ qn
    order = np.argsort(-sims)[:top_k]
    return [{"section_path": rows[i]["section_path"], "summary": rows[i]["summary"],
             "score": float(sims[i])} for i in order]


def _unpack(blob: bytes):
    import struct
    return struct.unpack(f"<{len(blob) // 4}f", blob)
