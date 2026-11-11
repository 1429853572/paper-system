"""科研结构化导读：9 字段模板，每项带页码证据."""
from __future__ import annotations

import hashlib
import json
import logging

from .db import db

log = logging.getLogger(__name__)

PROMPT_VERSION = "v2"   # v2：prompt 加固（禁围栏/明确格式）+ max_tokens 提升 → 旧缓存失效

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
    ("followups", "Followups", "针对本文的 2-3 个具体追问（供读者继续深挖）"),
]

# 流式生成用：每段以 <<<key>>> 开头（比 JSON 更适合增量解析，模型也不易加围栏跑偏）
_PROMPT_STREAM = (
    "你是论文导读引擎。依据提供的论文全文材料，逐段输出结构化导读。\n"
    "【输出格式】每段先写 <<<字段名>>> 再写内容，字段名只能是："
    + "、".join(k for k, _, _ in SECTIONS) + "。\n"
    "示例：\n<<<problem>>>\n本文针对……\n<<<core_idea>>>\n我们提出……\n"
    "规则：\n"
    "1. 每个字段内容简洁（2-5 句），中文（术语保留英文）\n"
    "2. 每条论断末尾标注证据 [n]，n 为材料中行首 [n] 编号；材料未覆盖的字段如实写\"文中未明确提及\"\n"
    "3. 实验数据引用原始表格数值；重要结果只在曲线图中时写\"（曲线图数据，需视觉理解）\"不臆造\n"
    "4. limitations 只写论文明确承认的局限\n"
    "5. [n] 必须标注在该论断真正来源的行上；实验数值只能来自所标证据行\n"
    "6. followups 给 2-3 个**针对本文具体内容**的追问（能用本文内容作答），不得是通用问题"
)

_PROMPT = (
    "你是论文导读引擎。依据提供的论文全文材料，按以下 JSON 模板输出导读。\n"
    "【输出格式硬要求】只输出一个 JSON 对象，不要任何解释文字，"
    "不要用 ``` 代码围栏包裹，不要在 JSON 前后加任何字符。\n"
    '{"sections": ['
    + ", ".join(f'{{"key": "{s[0]}", "content": "..."}}' for s in SECTIONS)
    + ']}\n'
    "规则：\n"
    "1. 每个字段内容简洁（2-5 句），中文（术语保留英文）\n"
    "2. 每条论断末尾标注证据 [n]，n 为材料中行首 [n] 编号；材料中未覆盖的字段如实写\"文中未明确提及\"\n"
    "3. 实验数据引用原始表格数值；若重要结果只在曲线图中，写\"（曲线图数据，需视觉理解）\"不臆造数值\n"
    "4. Limitations 只写论文明确承认的局限\n5. [n] 必须标注在该论断真正来源的行上；实验数值只能来自所标证据行，不得凭记忆配对\n"
    "6. followups 字段给 2-3 个**针对本文具体内容**的追问（要能用本文内容作答，"
    "例如「本文的 XX 模块为什么必须用 YY 而不是 ZZ？」），不得是放之四海皆准的通用问题"
)


_SECTION_KEYS = {k for k, _, _ in SECTIONS}


def _unwrap_json_text(text: str) -> dict | None:
    """文本里裹着 ```json {...} → 解出内层 dict（非则 None）。"""
    t = (text or "").strip()
    if not t.startswith("```") or "{" not in t:
        return None
    if t.startswith("```json"):
        t = t[t.find("\n") + 1:] if "\n" in t else t[7:]
    else:
        t = t[3:]
    t = t.rstrip()
    if t.endswith("```"):
        t = t[:-3]
    t = t.strip()
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        data = json.loads(t[i:j + 1])
        return data if isinstance(data, dict) else None
    except ValueError:
        return None


_MARK_RE = None


def parse_marked_sections(text: str) -> dict:
    """解析 <<<key>>> 分段格式 → {key: content}（非标记格式返回 {}）。"""
    import re as _re
    global _MARK_RE
    if _MARK_RE is None:
        keys = "|".join(_re.escape(k) for k, _, _ in SECTIONS)
        _MARK_RE = _re.compile(r"<<<\s*(" + keys + r")\s*>>>", _re.I)
    out: dict[str, str] = {}
    marks = list(_MARK_RE.finditer(text or ""))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out[m.group(1).lower()] = text[m.end():end].strip()
    return out


_KEY_RE = None


def salvage_fields(raw: str) -> dict:
    """从非完整/非法 JSON 文本里抢救字段（max_tokens 截断时模型输出常缺尾括号）。

    例：'{"problem": "……", "method": "1) x 2) y"'（缺右括号）→ 取到前两个字段。
    """
    import re as _re
    global _KEY_RE
    if _KEY_RE is None:
        keys = "|".join(_re.escape(k) for k, _, _ in SECTIONS)
        _KEY_RE = _re.compile(r'"(' + keys + r')"\s*:\s*"((?:[^"\\]|\\.)*)"')
    out: dict[str, str] = {}
    for m in _KEY_RE.finditer(raw or ""):
        try:
            out[m.group(1)] = json.loads('"' + m.group(2) + '"')
        except ValueError:
            out[m.group(1)] = m.group(2)
    return out


def normalize_sections(data: dict) -> tuple[dict, dict]:
    """把 LLM 返回规整成 {字段: 内容} + cite_map。

    兼容三种返回：
      A 标准 {"sections": [{"key":..., "content":...}]}
      B {"sections": {"problem": "...", ...}}
      C 扁平 {"problem": "...", ...}（模型常直接给字段名）
    并处理"整个 JSON 被 ```json 围栏裹住塞进某个字段"的坏形态——那是历史版本
    解析失败走 fallback 的产物（界面直接显示 JSON 源码）。
    扁平/坏形态的 cite_map 从原 problem 的全局映射继承（各字段的 [n] 同源）。
    """
    import re as _re
    secs = data.get("sections")
    by_key: dict[str, str] = {}
    cm = data.get("cite_map") or {}
    if isinstance(secs, list) and secs:
        by_key = {x["key"]: x.get("content", "") for x in secs
                  if isinstance(x, dict) and x.get("key") in _SECTION_KEYS}
    elif isinstance(secs, dict) and secs:
        by_key = {k: v for k, v in secs.items() if k in _SECTION_KEYS and isinstance(v, str)}
    else:
        by_key = {k: v for k, v in data.items() if k in _SECTION_KEYS and isinstance(v, str)}

    # 坏形态：某个字段的内容其实是裹着围栏的整份 JSON → 展开它
    for k in list(by_key):
        inner = _unwrap_json_text(by_key[k])
        if inner and any(x in _SECTION_KEYS for x in inner):
            inner_secs = {x: v for x, v in inner.items()
                          if x in _SECTION_KEYS and isinstance(v, str)}
            by_key.pop(k)
            by_key.update(inner_secs)
            break
        else:
            # 展开失败（多半是 max_tokens 截断导致 JSON 不完整）→ 逐字段抢救
            salv = salvage_fields(by_key[k])
            if len(salv) >= 2:
                by_key.pop(k)
                by_key.update(salv)
                break

    if not by_key:
        return {}, cm
    # cite_map：各字段的 [n] 从全局（problem）映射继承
    glob = cm.get("problem") or {}
    new_cm: dict[str, dict] = {}
    for k, txt in by_key.items():
        own = cm.get(k) or {}
        nums = set(_re.findall(r"\[(\d{1,3})\]", txt))
        merged = {n: own[n] for n in nums if n in own}
        merged.update({n: glob[n] for n in nums if n not in merged and n in glob})
        new_cm[k] = merged
    return by_key, new_cm


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
    truncated = False
    raw = ""
    for attempt in range(2):
        raw = client.complete(messages, max_tokens=6144)
        try:
            start, end = raw.index("{"), raw.rindex("}") + 1
            data = json.loads(raw[start:end])
            by_key, _cm_fix = normalize_sections(data)
            truncated = False
        except (ValueError, KeyError):
            # JSON 不完整（多半 max_tokens 截断）→ 逐字段抢救，不丢弃已生成内容
            by_key = salvage_fields(raw[start:end] if "{" in raw else raw)
            truncated = True
            if by_key:
                log.warning("导读 JSON 解析失败，已抢救 %d 个字段（疑似输出截断）", len(by_key))
        # fallback：完全非 JSON 时把原文按字段平铺，保证有内容
        if not by_key and raw.strip():
            txt = raw.strip()
            if txt.startswith("```"):          # 剥 markdown 围栏（模型爱加）
                txt = txt.split("\n", 1)[-1] if "\n" in txt else txt
                if txt.rstrip().endswith("```"):
                    txt = txt.rstrip()[:-3]
            try:                                # 再宽松试一次 JSON
                by_key, _ = normalize_sections(json.loads(txt))
            except ValueError:
                by_key = {"problem": txt[:2000]}
            break
        if by_key:
            break
    if not by_key:
        raise RuntimeError("导读生成失败：模型未返回有效内容，请重试")

def _postprocess(by_key: dict, evidence: list, run_id: str, cfg, user_id: int,
                  paper_id: str, truncated: bool = False) -> tuple[int, dict]:
    """接地校验 + 跨字段连续编号 + 落库（非流式与流式共用）。"""
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
    counter = [0]                 # 跨字段共享 → 整篇连续编号（读者能顺着 [1][2][3] 读下来）
    global_num: dict[int, int] = {}   # gid → 已分配的编号（同一证据复用）
    for k, v in by_key.items():
        local: dict[str, int] = {}

        def _renum(m):
            gid = int(m.group(1))
            if gid not in ev_map:
                return ""                       # 死引用 → 去掉
            if gid in global_num:
                n = global_num[gid]
                local[str(n)] = gid
                return f"[{n}]"
            counter[0] += 1
            n = counter[0]
            global_num[gid] = n
            local[str(n)] = gid
            return f"[{n}]"

        by_key[k] = _re.sub(r"\[(\d+)\]", _renum, v)
        cite_map[k] = local

    used_ids = {gid for local in cite_map.values() for gid in local.values()}
    evidence_out = [e for e in evidence if e["evidence_id"] in used_ids]

    cache_key = compute_key(run_id, cfg.model)
    # 证据一并落库：导读重新加载后引用仍可点击跳转（此前只存 sections，
    # 刷新页面后 [n] 变成死文本、下方证据列表也消失）。
    with db.write() as c:
        cur = c.execute(
            "INSERT INTO summaries(paper_id,cache_key,content,model,created_by) VALUES(?,?,?,?,?)",
            (paper_id, cache_key,
             json.dumps({"sections": by_key, "evidence": evidence_out, "cite_map": cite_map,
                        "truncated": truncated},
                        ensure_ascii=False),
             cfg.model, user_id),
        )
        sid = cur.lastrowid
    return sid, {"sections": by_key, "sections_global": by_key_global,
                 "evidence": evidence_out, "cite_map": cite_map,
                 "model": cfg.model}


    return _postprocess(by_key, evidence, run["id"], cfg, user["id"], paper_id, truncated)


def generate_stream(user: dict, paper_id: str, model: str | None = None):
    """流式生成导读：逐段 yield 事件，完成后落地（含接地校验与连续编号）。

    事件：
      {"type": "section", "key": k, "content": v}  —— 一段写完（前端即时上屏）
      {"type": "done", "sections":…, "evidence":…, "cite_map":…}
      {"type": "error", "message": …}
    """
    import re as _re
    from .llm import resolve_llm
    from .qa import _build_context
    cfg = resolve_llm(user["id"], "chat")
    p = db.one("SELECT id, title FROM papers WHERE id=?", (paper_id,))
    run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' "
                 "ORDER BY created_at DESC LIMIT 1", (paper_id,))
    if p is None or run is None:
        raise ValueError("论文尚未解析完成")
    paper = {"id": p["id"], "title": p["title"]}
    # 缓存命中：直接回放已有导读（不重复全文 LLM 调用）
    ck = compute_key(run["id"], cfg.model)
    cached = db.one("SELECT id, content FROM summaries WHERE paper_id=? AND cache_key=? "
                    "ORDER BY id DESC LIMIT 1", (paper_id, ck))
    if cached:
        try:
            data = json.loads(cached["content"])
            yield {"type": "done", "sections": data.get("sections", {}),
                   "evidence": data.get("evidence", []), "cite_map": data.get("cite_map", {}),
                   "cached": True, "model": cfg.model}
            return
        except Exception:  # noqa: BLE001 —— 缓存损坏则重新生成
            pass
    context, evidence, _ = _build_context("fulltext", [paper], "summary", user)
    from .llm import LLMClient
    client = LLMClient(cfg, user_id=user["id"], paper_id=paper_id)
    messages = [{"role": "system", "content": _PROMPT_STREAM},
                {"role": "user", "content": context}]
    keys = "|".join(_re.escape(k) for k, _, _ in SECTIONS)
    marks = _re.compile(r"<<<\s*(" + keys + r")\s*>>>", _re.I)

    buf = ""
    cur_key = None
    cur_parts: list[str] = []
    lead = ""              # 第一个标记前的说明文字（并入首段）
    sections: dict[str, str] = {}

    def _emit(key, content):
        content = (content or "").strip()
        if not content or key in sections:
            return None
        sections[key] = content
        return {"type": "section", "key": key, "content": content}

    try:
        for delta in client.stream(messages, max_tokens=6144):
            buf += delta
            while True:
                mk = marks.search(buf)
                if not mk:
                    break
                seg = buf[:mk.start()]
                if cur_key:
                    ev = _emit(cur_key, "".join(cur_parts) + seg)
                    if ev:
                        yield ev
                    cur_parts = []
                elif seg.strip():
                    lead = seg.strip()
                cur_key = mk.group(1).lower()
                buf = buf[mk.end():]
        if cur_key:
            ev = _emit(cur_key, "".join(cur_parts) + buf)
            if ev:
                yield ev
        elif buf.strip():
            ev = _emit("problem", buf)
            if ev:
                yield ev
    except Exception as e:  # noqa: BLE001
        yield {"type": "error", "message": str(e)[:300]}
        return

    if not sections:
        yield {"type": "error", "message": "模型未返回有效内容，请重试"}
        return
    if lead and sections:
        first = next(iter(sections))
        sections[first] = lead + "\n" + sections[first]
    try:
        sid, payload = _postprocess(sections, evidence, run["id"], cfg, user["id"], paper_id)
    except Exception as e:  # noqa: BLE001
        yield {"type": "error", "message": str(e)[:300]}
        return
    yield {"type": "done", "sections": payload["sections"],
           "evidence": payload["evidence"], "cite_map": payload["cite_map"],
           "summary_id": sid, "model": cfg.model}


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
