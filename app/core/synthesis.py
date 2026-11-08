"""多文献综述流水线：聚类 → 组内精读比对 → 跨组综合。

规模策略（90 篇场景的成本护栏）：
- ≥2 篇起，≤90 篇硬顶（上下文与费用护栏，超出提示分卷）
- ≤10 篇单层：全部导读合喂一次组内比对 + 一次综合
- >10 篇分层：导读文本 embedding + 余弦 k-means 聚 4~12 组 → 每组一次精读比对 → 一次跨组综合
- LLM 调用数 = 缺失导读数（逐篇补齐，已有 summaries 缓存零成本复用）+ 组数 + 1
- 对比矩阵 CSV 由各篇导读字段本地拼装，零 LLM 成本
- 组名由组内精读调用顺带产出，不单独花钱
"""
from __future__ import annotations

import csv
import io
import json
import re
import uuid

from .db import db

MAX_PAPERS = 90
MIN_PAPERS = 2

# 9 字段导读 → 综述关心 6 项
_DIGEST_KEYS = ("problem", "core_idea", "method", "datasets", "metrics", "limitations")
_DIGEST_LABELS = {"problem": "问题", "core_idea": "思想", "method": "方法",
                  "datasets": "数据", "metrics": "指标", "limitations": "局限"}


def n_groups_for(n: int) -> int:
    if n <= 10:
        return 1
    return min(12, max(4, round(n / 7)))


def estimate(paper_ids: list[str]) -> dict:
    """成本预估：有效篇数 / 缺导读数 / 组数 / 预计 LLM 调用数。"""
    ids = list(dict.fromkeys(paper_ids))[:MAX_PAPERS]
    valid, missing, no_parse = [], 0, []
    for pid in ids:
        run = db.one("SELECT id FROM parse_runs WHERE paper_id=? AND status='done' LIMIT 1", (pid,))
        if run is None:
            no_parse.append(pid)
            continue
        valid.append(pid)
        if db.one("SELECT id FROM summaries WHERE paper_id=? LIMIT 1", (pid,)) is None:
            missing += 1
    n = len(valid)
    groups = n_groups_for(n) if n >= MIN_PAPERS else 0
    return {"valid": valid, "missing_summaries": missing, "no_parse": no_parse,
            "groups": groups, "calls": missing + groups + 1 if groups else 0}


def _digest_of(paper_row, summary_row) -> dict:
    """单篇 → 结构化摘要卡（供组内比对与 CSV 矩阵）。

    evidence：该篇导读引用过的原文证据（block_id/page/text）——随综述全程传递，
    最终写进报告的 evidence 字段，前端渲染可点击跳原文（评审 P0 证据链）。
    """
    fields = {k: "" for k in _DIGEST_KEYS}
    evidence = []
    if summary_row is not None:
        try:
            content = json.loads(summary_row["content"] or "{}")
            sec = content.get("sections", {})
            if isinstance(sec, dict):
                for k in _DIGEST_KEYS:
                    fields[k] = re.sub(r"\[\d+\]", "", sec.get(k) or "").strip()
            evidence = content.get("evidence") or []
        except Exception:  # noqa: BLE001
            pass
    for k in _DIGEST_KEYS:
        if not fields[k] and paper_row["abstract"]:
            # 无导读时从摘要兜底，保证组内比对不至于空手
            fields[k] = (paper_row["abstract"] or "").strip()[:300]
    return {"id": paper_row["id"], "title": paper_row["title"] or paper_row["id"],
            "year": paper_row["year"] or "", "journal": paper_row["journal"] or "",
            "has_summary": summary_row is not None,
            "evidence": evidence[:20],   # 上限防爆上下文；导读证据通常 ≤30 条
            **fields}


def _digest_block(d: dict, cap: int = 700) -> str:
    lines = [f"[{d['id']}] {d['title']}（{d['year']}{'，' + d['journal'] if d['journal'] else ''}）"]
    for k in _DIGEST_KEYS:
        v = (d.get(k) or "").strip()
        if v:
            lines.append(f"{_DIGEST_LABELS[k]}: {v[:cap]}")
    return "\n".join(lines)


# ---------------- 聚类（纯本地计算，零 LLM 成本） ----------------

def cluster_papers(digests: list[dict], k: int, topic: str = "") -> list[list[str]]:
    """导读文本 embedding + 余弦 k-means → 组的 paper_id 列表。

    topic 非空时：额外计算「论文摘要 ↔ 专题问题」的相似度，把明显偏离专题的论文
    单独分到一组（弱相关组），并在组内让模型做取舍——解决纯 embedding 聚类
    「同领域不同问题混在一组」的问题（专题本身是用户已知的研究问题，是强先验）。
    """
    import numpy as np

    from .retrieval import embed_texts

    if len(digests) <= 10 or k <= 1:
        return [[d["id"] for d in digests]]
    texts = [f"{d['title']}\n{d.get('problem', '')}\n{d.get('core_idea', '')}\n{d.get('method', '')}"
             for d in digests]
    try:
        vecs = np.array(embed_texts(texts), dtype=np.float32)
    except Exception:  # noqa: BLE001 —— embedding 服务不可用：按年份分桶降级，流程不断
        digests_sorted = sorted(digests, key=lambda d: d["year"] or "0")
        size = max(1, (len(digests) + k - 1) // k)
        return [[d["id"] for d in digests_sorted[i:i + size]]
                for i in range(0, len(digests_sorted), size)]
    norm = np.linalg.norm(vecs, axis=1, keepdims=True)
    norm[norm == 0] = 1
    mat = vecs / norm
    k = max(1, min(k, len(digests)))
    rng = np.random.default_rng(42)
    cent = mat[rng.choice(len(mat), size=k, replace=False)].copy()
    assign = np.zeros(len(mat), dtype=int)
    for _ in range(30):
        assign = (mat @ cent.T).argmax(axis=1)
        for j in range(k):
            members = mat[assign == j]
            if len(members):
                c = members.mean(axis=0)
                n = np.linalg.norm(c)
                cent[j] = c / n if n else c
    # 空组回收：把空组号重新指给最近的非空成员
    groups: dict[int, list[str]] = {}
    for d, a in zip(digests, assign):
        groups.setdefault(int(a), []).append(d["id"])
    out = [g for g in groups.values() if g]

    # 专题先验：与专题问题明显无关的论文单独成组（避免污染主线综述）
    if topic and len(out) > 1:
        try:
            import numpy as np
            from .retrieval import embed_texts
            qv = np.array(embed_texts([topic])[0], dtype=np.float32)
            qn = qv / (np.linalg.norm(qv) + 1e-9)
            rel = {}
            for d, m in zip(digests, mat):
                sim = float(np.dot(m, qn))
                rel[d["id"]] = sim
            vals = list(rel.values())
            thr = float(np.median(vals)) - 0.06      # 明显低于中位数 → 视为弱相关
            weak = [i for i, v in rel.items() if v < thr]
            if weak and len(weak) < len(digests):
                out = [[i for i in g if i not in weak] for g in out]
                out = [g for g in out if g]
                out.append(weak)
        except Exception:  # noqa: BLE001 —— embedding 不可用时退回纯聚类
            pass
    return out


# ---------------- 流水线主体（worker 调用） ----------------

def run(user: dict, synthesis_id: str, job_update=None, topic: str = "",
        params: dict | None = None) -> None:
    """执行综述流水线。job_update(**fields) 用于同步 jobs 行进度（SSE 面板）。

    topic: 专题名/研究问题先验——参与聚类分组（弱相关论文另置一组）并注入组内比对
           与跨组综合提示词。
    params: {axis, tier(quick|standard|deep), style(author_year|numeric), purpose}
            —— survey-writer 升级参数；axis 与 topic 同源（专题名）或用户填写。
    纯 embedding 聚会把「同领域不同问题」的论文混在一组（评审提出的「聚类≠科研分类」），
    而专题本身是用户已知的研究问题，用它做过滤约束能显著提升分组与归纳的针对性。
    """

    def progress(done_inc: int = 1, **fields) -> None:
        row = db.one("SELECT progress_done, progress_total FROM syntheses WHERE id=?", (synthesis_id,))
        if row is None:
            return
        done = row["progress_done"] + done_inc
        with db.write() as c:
            c.execute("UPDATE syntheses SET progress_done=?, updated_at=datetime('now') "
                      "WHERE id=?", (min(done, row["progress_total"] or done), synthesis_id))
        if job_update:
            job_update(progress_done=min(done, row["progress_total"] or done), **fields)

    row = db.one("SELECT * FROM syntheses WHERE id=?", (synthesis_id,))
    if row is None:
        raise ValueError("综述任务不存在")
    paper_ids = json.loads(row["paper_ids"])
    # rewrite（换框架重写）：复用已存的组比对结果，跳过组内 LLM 调用（零重复消化成本）
    cached_clusters = None
    if (params or {}).get("rewrite"):
        try:
            cached_clusters = json.loads(row["cluster_data"] or "[]") or None
        except Exception:  # noqa: BLE001
            cached_clusters = None

    from .llm import LLMClient, resolve_llm
    from .summarizer import generate  # 缺导读补齐（有缓存复用）

    cfg = resolve_llm(user["id"], "chat")
    client = LLMClient(cfg, user_id=user["id"], paper_id=None)
    total = row["progress_total"] or 1

    try:
        # ---- 阶段一：补齐导读 + 摘要卡 ----
        digests: list[dict] = []
        paper_rows: list[dict] = []
        for pid in paper_ids:
            p = db.one("SELECT * FROM papers WHERE id=?", (pid,))
            if p is None:
                continue
            paper_rows.append(dict(p))
            s = db.one("SELECT * FROM summaries WHERE paper_id=? ORDER BY created_at DESC LIMIT 1", (pid,))
            if s is None:
                try:
                    generate({"id": user["id"]}, pid)
                    s = db.one("SELECT * FROM summaries WHERE paper_id=? ORDER BY created_at DESC LIMIT 1", (pid,))
                except Exception as e:  # noqa: BLE001 —— 单篇导读失败不拖垮整卷，用摘要兜底
                    with db.write() as c:
                        c.execute(
                            "UPDATE syntheses SET error=? WHERE id=?",
                            (f"《{(p['title'] or '')[:40]}》导读失败改用摘要兜底: {str(e)[:120]}",
                             synthesis_id))
            digests.append(_digest_of(p, s))
            progress(1)

        # ---- 阶段二：聚类 ----
        ids = [d["id"] for d in digests]
        k = n_groups_for(len(ids))
        clusters_ids = cluster_papers(digests, k, topic=topic)
        by_id = {d["id"]: d for d in digests}
        cluster_jsons: list[dict] = []

        # ---- 阶段三：组内精读比对（每组 1 次调用，顺带产出组名；rewrite 复用缓存） ----
        for gi, gids in (enumerate(clusters_ids) if not cached_clusters else []):
            g_digests = [by_id[i] for i in gids if i in by_id]
            if not g_digests:
                continue
            body = "\n\n".join(_digest_block(d) for d in g_digests)
            topic_line = (f"\n本次综述的研究问题（专题）：{topic}。只讨论与之直接相关的论文；"
                          f"与该问题无关的论文请在 points 中明确标注「与专题弱相关」。\n") if topic else ""
            raw = ""
            parsed = None
            for _attempt in range(2):
                raw = client.complete([
                    {"role": "system", "content":
                        "你是文献综述引擎。下面是同一研究主题下几篇论文的结构化摘要卡。"
                        + topic_line +
                        "输出 JSON（只输出 JSON）：\n"
                        '{"group_name": "本组研究主题名（10字内）", '
                        '"papers": [{"id": "论文id原样保留", "points": "该篇在本主题下的定位与贡献，2句"}], '
                        '"similarities": ["组内共识要点（含具体方法/数值）"], '
                        '"differences": ["组内分歧或互补要点（说明谁与谁不同）"]}\n'
                        "规则：只依据材料，不臆造数值；differences 必须点名是哪些论文之间的差异。"},
                    {"role": "user", "content": body},
                ], max_tokens=3000)
                try:
                    parsed = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
                    if isinstance(parsed, dict) and parsed.get("papers"):
                        break
                except (ValueError, KeyError):
                    parsed = None
            if parsed is None:   # JSON 失败兜底：原文直接入组，报告阶段降级可用
                parsed = {"group_name": f"主题组 {gi + 1}", "papers":
                          [{"id": d["id"], "points": (d.get("core_idea") or d["title"])[:200]}
                           for d in g_digests],
                          "similarities": [], "differences": [], "_raw": raw[:1500]}
            parsed["_ids"] = [d["id"] for d in g_digests]
            # 证据链：把本组论文的原文证据挂到组结果上（跨组综合与最终报告取用）
            ev_map = {}
            for d in g_digests:
                for e in d.get("evidence", []):
                    ev_map[e.get("evidence_id")] = e
            parsed["_evidence"] = list(ev_map.values())
            cluster_jsons.append(parsed)
            progress(1)

        if cached_clusters:
            cluster_jsons = cached_clusters
        with db.write() as c:
            c.execute("UPDATE syntheses SET clusters=?, stage='final', updated_at=datetime('now') "
                      "WHERE id=?", (json.dumps(
                          [{"name": cj.get("group_name") or f"组 {i + 1}", "paper_ids": cj["_ids"]}
                           for i, cj in enumerate(cluster_jsons)], ensure_ascii=False), synthesis_id))

        # ---- 阶段四：跨组综合（1 次调用） ----
        name_of = {d["id"]: d["title"] for d in digests}
        gsections = []
        for i, cj in enumerate(cluster_jsons):
            papers_txt = "\n".join(
                f"- {name_of.get(pp['id'], pp['id'])}: {pp.get('points', '')[:220]}"
                for pp in cj.get("papers", []))
            sims = "\n".join(f"- {s}" for s in cj.get("similarities", [])[:6]) or "-（材料未给出）"
            diffs = "\n".join(f"- {s}" for s in cj.get("differences", [])[:6]) or "-（材料未给出）"
            gsections.append(f"### 组 {i + 1}: {cj.get('group_name', '')}\n{papers_txt}\n共识:\n{sims}\n差异:\n{diffs}")
        topic_note = (f"本次综述聚焦的研究问题：{topic}。报告应围绕该问题组织，"
                      f"与该问题弱相关的材料单独归入「外围工作」一小节，不混入主线结论。\n") if topic else ""
        # ---- 冻结引用键表（survey-writer 防线①：正文引用只出自此表）----
        pr = params or {}
        tier = pr.get("tier") or "quick"
        style = pr.get("style") or "author_year"
        from . import citekey as ck
        table = ck.build_table(paper_rows, api_check=(tier != "quick"))
        citable = ck.citable_entries(table)
        uncited_allowed = ck.need_manual(table)
        key_lines = [f"- {e['key']} = 《{str(e['title'])[:44]}》" for e in citable]
        key_prompt = ("\n可用引用键（提及某论文时句末标注对应键，英文如 (Wang et al., 2025a)，"
                      "中文如（刘晓悦等，2026）；只允许使用以下键，禁止自造）：\n"
                      + "\n".join(key_lines[:80])) if key_lines else ""
        # 证据编号表：E1/E2/… → 原文证据（跨组统一编号，报告里引用；前端可点击跳原文）
        ev_flat = []
        for cj in cluster_jsons:
            for e in cj.get("_evidence", []):
                ev_flat.append(e)
        seen = set()
        ev_uniq = []
        for e in ev_flat:
            k = (e.get("paper_id"), e.get("block_id"))
            if k in seen:
                continue
            seen.add(k)
            ev_uniq.append(e)
        ev_index = {e["evidence_id"]: i + 1 for i, e in enumerate(ev_uniq)}
        ev_lines = []
        for eid, n in sorted(ev_index.items(), key=lambda x: x[1]):
            e = ev_uniq[n - 1]
            title = e.get("title") or e.get("paper_id")
            ev_lines.append(f"E{n} = 《{str(title)[:40]}》第{(e.get('page_index') or 0) + 1}页")
        ev_prompt = ("\n可用证据编号（重要论断句末用 [E<n>] 标注，只允许使用列出的编号）：\n"
                     + "\n".join(ev_lines[:60])) if ev_lines else ""
        axis = topic or pr.get("axis") or ""
        digest_by_id = {d["id"]: d for d in digests}
        key_of_pid = {e["id"]: e["key"] for e in citable}

        if tier == "quick":
            report = client.complete([
                {"role": "system", "content":
                    "你是学术综述撰写人。依据提供的分组比对材料写一篇中文文献综述报告（Markdown）。"
                    + topic_note +
                    "结构固定：\n"
                    "# 文献综述\n## 一、总体概览（材料范围、主题分布，3~5 句）\n"
                    "## 二、分主题梳理（每个主题一小节：代表性工作+演进关系）\n"
                    "## 三、跨组共识（列表，每条注明来自哪些论文）\n"
                    "## 四、主要分歧（列表，说明双方立场与各自证据）\n"
                    "## 五、研究机会与局限（材料中反复出现的 gap）\n"
                    "规则：只依据材料不编造；数值必须来自材料原文；"
                    "**重要论断句末标注证据编号如 [E3]**（编号表见材料末尾），"
                    "没有对应证据的论断不标注、且措辞须弱化（如「可能」「有待验证」）。"
                    + key_prompt + ev_prompt},
                {"role": "user", "content": "\n\n".join(gsections)[:60000]},
            ], max_tokens=6000)
        else:
            # ---- 框架设计（survey-writer：分类是综述的灵魂；2-3 候选，自动选+一键换）----
            # rewrite 复用已存框架（保证「换 X 重写」就是用户看到的那个 X，不重新生成漂移）
            fw_data = None
            if pr.get("rewrite"):
                try:
                    fw_data = json.loads(row["frameworks"] or "null")
                    if not (isinstance(fw_data, dict) and fw_data.get("frameworks")):
                        fw_data = None
                except Exception:  # noqa: BLE001
                    fw_data = None
            for _att in range(2) if fw_data is None else []:
                fw_raw = client.complete([
                    {"role": "system", "content":
                     "你是综述架构师。依据分组材料设计 2-3 个**互不相同**的综述组织框架"
                     "（分类轴各异，如按方法范式/按问题类型/按技术路线）。输出 JSON（只输出 JSON）：\n"
                     '{"frameworks": [{"name": "框架名(10字内)", "rationale": "为何这样分(1句)", '
                     '"outline": [{"section": "章节标题", "budget_chars": 1200, '
                     '"groups": [1,2], "core": false, "brief": "本章写什么(1句)"}]}], '
                     '"recommended": 0, "reason": "推荐理由(1句)"}\n'
                     f"约束：总字数预算≈{8000 if tier == 'standard' else 16000}；"
                     "outline 须含引言与结语章；core=true 标注 1-2 个核心章；"
                     "groups 用材料中的组编号；末章固定为「研究机会与局限」。"},
                    {"role": "user", "content": "\n\n".join(gsections)[:40000]},
                ], max_tokens=2500)
                try:
                    fw_data = json.loads(fw_raw[fw_raw.index("{"):fw_raw.rindex("}") + 1])
                    if isinstance(fw_data, dict) and len(fw_data.get("frameworks") or []) >= 2:
                        break
                    fw_data = None
                except (ValueError, KeyError):
                    fw_data = None
            if fw_data is None:   # 框架解析失败兜底：固定五段
                fw_data = {"frameworks": [{"name": "经典五段式", "rationale": "按概览-主题-共识-分歧-机会组织",
                             "outline": [
                                 {"section": "总体概览", "budget_chars": 1000, "groups": list(range(1, len(cluster_jsons) + 1)), "core": False, "brief": "范围与主题分布"},
                                 {"section": "分主题梳理", "budget_chars": 3500, "groups": list(range(1, len(cluster_jsons) + 1)), "core": True, "brief": "逐组展开"},
                                 {"section": "跨组共识与分歧", "budget_chars": 2000, "groups": list(range(1, len(cluster_jsons) + 1)), "core": False, "brief": "共识与分歧"},
                                 {"section": "研究机会与局限", "budget_chars": 1200, "groups": list(range(1, len(cluster_jsons) + 1)), "core": False, "brief": "gap"}]}],
                           "recommended": 0, "reason": "解析失败回退"}
            pick = pr.get("framework")
            fws = fw_data["frameworks"]
            if not isinstance(pick, int) or not (0 <= pick < len(fws)):
                pick = fw_data.get("recommended") or 0
            fw = fws[pick]
            with db.write() as c:
                c.execute("UPDATE syntheses SET frameworks=?, cluster_data=? WHERE id=?",
                          (json.dumps(fw_data, ensure_ascii=False),
                           json.dumps(cluster_jsons, ensure_ascii=False), synthesis_id))
            progress(1)

            # ---- 深读回原文（核心章定量数字必须出自原文块）----
            core_secs = [s for s in fw["outline"] if s.get("core")]
            core_pids: list[str] = []
            for s in core_secs:
                for gi in (s.get("groups") or []):
                    gi0 = int(gi) - 1
                    if 0 <= gi0 < len(cluster_jsons):
                        for pid in cluster_jsons[gi0].get("_ids", []):
                            if pid not in core_pids:
                                core_pids.append(pid)
            core_pids = core_pids[:25]
            core_text = ""
            if core_pids and axis:
                try:
                    from . import retrieval as _rt
                    role = (db.one("SELECT role FROM users WHERE id=?", (user["id"],)) or {}).get("role")
                    hits = _rt.search(axis, user_id=user["id"], is_admin=(role == "admin"),
                                     paper_ids=core_pids, top_k=40)
                    core_text = "\n\n".join(
                        f"[{h['paper_id']}|p{(h.get('page_index') or 0) + 1}] "
                        f"{(h.get('text') or '')[:500]}" for h in hits)[:20000]
                except Exception:  # noqa: BLE001 —— 检索不可用则核心章仅用 digest 数字
                    core_text = ""

            # ---- 逐章写作（每章独立调用 + 章级幻影校验早发现）----
            # 覆盖率防线：框架 outline 可能漏选若干组（如弱相关组），把它们追加到
            # 最后一章材料里——否则这些论文的键永远不会出现在写作上下文 → 缺漏。
            assigned = {int(g) - 1 for sec in fw["outline"]
                        for g in (sec.get("groups") or [])
                        if str(g).isdigit() and 0 <= int(g) - 1 < len(cluster_jsons)}
            orphan = [i for i in range(len(cluster_jsons)) if i not in assigned]
            outline_eff = list(fw["outline"])
            if orphan:
                tail = (f"相关工作速览（未入主线的组）："
                        + "；".join(f"组 {i + 1} {cluster_jsons[i].get('group_name', '')}"
                                    for i in orphan))
                if outline_eff:
                    outline_eff[-1]["brief"] = (outline_eff[-1].get("brief", "") + "；" + tail)[:300]
                    outline_eff[-1]["groups"] = sorted(set(
                        (outline_eff[-1].get("groups") or []) + [i + 1 for i in orphan]))
                else:
                    outline_eff.append({"section": "相关工作速览", "budget_chars": 2000,
                                        "groups": [i + 1 for i in orphan],
                                        "core": False, "brief": tail})
            chapters: list[str] = []
            __import__("logging").getLogger("synthesis").warning(
                "章节化开始：%d 章", len(outline_eff))
            for s_i, sec in enumerate(outline_eff):
                __import__("logging").getLogger("synthesis").warning(
                    "写第 %d/%d 章：%s", s_i + 1, len(outline_eff), sec['section'][:30])
                gidx = [int(g) - 1 for g in (sec.get("groups") or [])
                        if str(g).isdigit() and 0 <= int(g) - 1 < len(cluster_jsons)]
                sec_materials = [gsections[i] for i in gidx]
                sec_pids = [pid for i in gidx for pid in cluster_jsons[i].get("_ids", [])]
                sec_digests = "\n\n".join(_digest_block(digest_by_id[pid])
                                           for pid in sec_pids if pid in digest_by_id)[:24000]
                sec_keys = "\n".join(f"- {key_of_pid[pid]} = 《{digest_by_id[pid]['title'][:40]}》"
                                     for pid in sec_pids if pid in key_of_pid)[:1500]
                sec_mat = "\n\n".join(sec_materials)[:24000]
                core_note = (f"【原文深读块（定量数字优先取自此处的原文）】\n{core_text}\n"
                             if sec.get("core") and core_text else "")
                # 本章组内键不足时补全量 citable 键（覆盖率优先；幻影由章级校验拦）
                sec_keys_eff = (sec_keys or "\n".join(
                    f"- {e['key']} = 《{str(e['title'])[:40]}》" for e in citable)[:1500])
                keys_note = ("\n【本章可用引用键（只用这些，禁止自造）】\n"
                             + sec_keys_eff + "\n")
                ctx = (f"【综述主题/组织轴】{axis or '（未指定）'}\n"
                       f"【采用框架】{fw['name']}：{fw.get('rationale', '')}\n"
                       f"【本章】{sec['section']}（预算约 {sec.get('budget_chars', 1500)} 字）"
                       f"——{sec.get('brief', '')}\n"
                       f"【本章材料·分组比对】\n{sec_mat}\n"
                       f"【本章材料·论文摘要卡】\n{sec_digests}\n"
                       + core_note + keys_note + ev_prompt)
                if chapters:   # 已写章节摘要（保连贯）
                    ctx += ("\n【已写章节】" + "；".join(
                        f"{fw['outline'][j]['section']}：{chapters[j][:120]}…" for j in range(max(0, len(chapters) - 2), len(chapters))))
                sys_prompt = ("你是综述章节撰写人。只写这一章的正文（以 ## 章节标题开头），"
                     "不要参考文献、不要总标题。规则：论断句末标注引用键（英文 (Wang et al., 2025a)、"
                     "中文（刘晓悦等，2026），只用给定键；重要论断标 [E<n>] 证据编号；"
                     "数值必须来自材料（深读块/摘要卡），禁止凭记忆编数字；无证据措辞弱化。"
                     + ("本章为核心章：须包含一张 Markdown 方法/维度对比表（类型×代表工作×关键机制×适用条件）。"
                        if sec.get("core") else ""))
                ch = ""
                _lg = __import__("logging").getLogger("synthesis")
                for _try in range(3):        # 空响应重试 + 异常留痕
                    try:
                        ch = client.complete([
                            {"role": "system", "content": sys_prompt},
                            {"role": "user", "content": ctx[:60000]},
                        ], max_tokens=3000).strip()
                        if len(ch) > 200:
                            break
                    except BaseException as e:  # noqa: BLE001 —— 诊断留痕
                        _lg.warning("第 %d 章尝试 %d 异常: %s: %s",
                                    s_i + 1, _try + 1, type(e).__name__, str(e)[:200])
                if not ch:
                    _lg.warning("第 %d 章「%s」三次尝试均空/过短", s_i + 1, sec['section'][:30])
                    raise RuntimeError(f"章节「{sec['section']}」三次尝试均为空响应")
                # 章级幻影校验（只查文有表无，早发现早修）
                sec_ver = ck.verify_report(ch, table, style, "quick")
                if sec_ver["phantom"]:
                    ph = "、".join(sec_ver["phantom"][:8])
                    ch = client.complete([
                        {"role": "system", "content":
                         f"修订该章：以下引用键不存在，删除或替换为材料中列出的正确键：{ph}。"
                         "其余内容保持原样，只输出修订后的整章。"},
                        {"role": "user", "content": ch},
                    ], max_tokens=3000)
                chapters.append(ch.strip())
                __import__("logging").getLogger("synthesis").warning(
                    "第 %d 章完成：%d 字", s_i + 1, len(ch))
                progress(1)

            alts = "、".join(f"「{f['name']}」" for i, f in enumerate(fws) if i != pick)
            report = (f"# 文献综述\n\n> **组织轴**：{axis or '—'}  \n"
                      f"> **采用框架**：{fw['name']}——{fw.get('rationale', '')}"
                      + (f"  \n> *候选框架（可一键换）*：{alts}" if alts else "")
                      + "\n\n" + "\n\n".join(chapters))

        csv_text = build_matrix_csv(digests, cluster_jsons)
        evidence_out = json.dumps(
            [{**e, "n": ev_index.get(e["evidence_id"], 0)} for e in ev_uniq],
            ensure_ascii=False)

        # ---- 参考文献机械渲染 + 双向校验（survey-writer 防线③：PASS 才交付）----
        def _assemble(body_md: str) -> str:
            return body_md.rstrip() + "\n\n## 参考文献\n" + ck.render_references(table, style)

        report = _assemble(report)
        ver = ck.verify_report(report, table, style, tier)
        if tier != "quick" and not ver["pass"] and ver["phantom"]:
            # 幻影引用少 → 交给 LLM 定点修订（改错成本低，输出小）
            body_only = report.split("\n\n## 参考文献")[0]
            try:
                fixed_body = client.complete([
                    {"role": "system", "content":
                        "你是综述修订编辑。只做一类修改：以下引用键不在键表中（幻影），"
                        f"删除或替换为材料中的正确键：{ver['phantom'][:20]}。"
                        "其余内容、结构、证据编号 [E<n>] 保持原样；只输出修订后的完整正文。"},
                    {"role": "user", "content": body_only[:60000]},
                ], max_tokens=8000)
                report = _assemble(fixed_body)
            except Exception:  # noqa: BLE001 —— 修复失败沿用原报告
                pass

        # 覆盖率机械补齐（survey-writer 铁律：N/N 是硬前提，不靠 LLM 自觉）：
        # 未被正文引用的论文 → 按 key 字母序机械追加一段一句话介绍到
        # 「## 参考文献」之前（标题/作者/年份/来源全部来自键表，零幻觉）。
        # 教训：曾用 LLM 全文重写补织，max_tokens 截断吃掉后 3 章——机械追加是唯一可靠路径。
        ver = ck.verify_report(report, table, style, tier)
        missing_now = ver.get("missing") or []
        if missing_now and style != "numeric":
            key2e = {e["key"]: e for e in citable}
            add_lines = []
            for k in missing_now:
                e = key2e.get(k)
                if not e:
                    continue
                authors = "、".join((e.get("authors") or [])[:3]) or "—"
                bits = [f"- **{k}**《{e['title']}》"]
                meta = [x for x in (authors, e.get("year"), e.get("venue")) if x]
                if meta:
                    bits.append("（" + "，".join(meta) + "）")
                add_lines.append("".join(bits))
            if add_lines:
                block = ("\n\n## 补充文献速览\n\n"
                         "以下文献与综述主题相关但未在上文展开，列出供延伸阅读：\n\n"
                         + "\n".join(add_lines))
                report = report.replace("\n\n## 参考文献", block + "\n\n## 参考文献", 1)
            ver = ck.verify_report(report, table, style, tier)
        ver_out = json.dumps(ver, ensure_ascii=False)

        status = "done"
        err = None
        if tier != "quick" and not ver["pass"]:
            status = "needs_fix"       # 前端显示缺漏/幻影清单，可一键重写
            err = f"引用校验未通过：缺漏 {len(ver['missing'])} / 幻影 {len(ver['phantom'])}"

        with db.write() as c:
            c.execute(
                "UPDATE syntheses SET status=?, stage='final', report_md=?, matrix_csv=?, "
                "evidence=?, cite_table=?, verification=?, params=?, model=?, error=?, "
                "progress_done=progress_total, updated_at=datetime('now') WHERE id=?",
                (status, report, csv_text, evidence_out,
                 json.dumps(table, ensure_ascii=False), ver_out,
                 json.dumps({**pr, "axis": topic or pr.get("axis", "")}, ensure_ascii=False),
                 cfg.model, err, synthesis_id))
        if job_update:
            job_update(progress_done=total)
    except Exception as e:  # noqa: BLE001
        with db.write() as c:
            c.execute("UPDATE syntheses SET status='failed', error=?, updated_at=datetime('now') "
                      "WHERE id=?", (str(e)[:500], synthesis_id))
        raise


# ---------------- 对比矩阵（本地拼装） ----------------

def build_matrix_csv(digests: list[dict], cluster_jsons: list[dict]) -> str:
    group_of: dict[str, str] = {}
    for cj in cluster_jsons:
        for pid in cj.get("_ids", []):
            group_of[pid] = cj.get("group_name") or ""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["主题组", "标题", "年份", "期刊", "研究问题", "核心思想", "方法要点",
                "数据集", "主要指标", "局限", "导读"])
    for d in digests:
        w.writerow([group_of.get(d["id"], ""), d["title"], d["year"], d["journal"],
                    d.get("problem", ""), d.get("core_idea", ""), d.get("method", ""),
                    d.get("datasets", ""), d.get("metrics", ""), d.get("limitations", ""),
                    "有" if d.get("has_summary") else "摘要兜底"])
    return buf.getvalue()


def create(user_id: int, paper_ids: list[str], est: dict) -> str:
    """建综述行（worker 由调用方入队）。返回 synthesis_id。"""
    sid = "syn" + uuid.uuid4().hex[:10]
    with db.write() as c:
        c.execute(
            "INSERT INTO syntheses(id,user_id,title,paper_ids,status,stage,progress_total,model) "
            "VALUES(?,?,?,?,'running','cluster',?,'')",
            (sid, user_id, f"文献综述 · {len(est['valid'])} 篇",
             json.dumps(est["valid"], ensure_ascii=False), est["calls"]))
    return sid
