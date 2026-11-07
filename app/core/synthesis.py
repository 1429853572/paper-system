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
    """单篇 → 结构化摘要卡（供组内比对与 CSV 矩阵）。"""
    fields = {k: "" for k in _DIGEST_KEYS}
    if summary_row is not None:
        try:
            sec = (json.loads(summary_row["content"] or "{}") or {}).get("sections", {})
            if isinstance(sec, dict):
                for k in _DIGEST_KEYS:
                    fields[k] = re.sub(r"\[\d+\]", "", sec.get(k) or "").strip()
        except Exception:  # noqa: BLE001
            pass
    for k in _DIGEST_KEYS:
        if not fields[k] and paper_row["abstract"]:
            # 无导读时从摘要兜底，保证组内比对不至于空手
            fields[k] = (paper_row["abstract"] or "").strip()[:300]
    return {"id": paper_row["id"], "title": paper_row["title"] or paper_row["id"],
            "year": paper_row["year"] or "", "journal": paper_row["journal"] or "",
            "has_summary": summary_row is not None, **fields}


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

def run(user: dict, synthesis_id: str, job_update=None, topic: str = "") -> None:
    """执行综述流水线。job_update(**fields) 用于同步 jobs 行进度（SSE 面板）。

    topic: 专题名/研究问题先验——参与聚类分组（弱相关论文另置一组）并注入组内比对
           与跨组综合提示词。
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

    from .llm import LLMClient, resolve_llm
    from .summarizer import generate  # 缺导读补齐（有缓存复用）

    cfg = resolve_llm(user["id"], "chat")
    client = LLMClient(cfg, user_id=user["id"], paper_id=None)
    total = row["progress_total"] or 1

    try:
        # ---- 阶段一：补齐导读 + 摘要卡 ----
        digests: list[dict] = []
        for pid in paper_ids:
            p = db.one("SELECT * FROM papers WHERE id=?", (pid,))
            if p is None:
                continue
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

        # ---- 阶段三：组内精读比对（每组 1 次调用，顺带产出组名） ----
        for gi, gids in enumerate(clusters_ids):
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
            cluster_jsons.append(parsed)
            progress(1)

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
                "规则：论文名用「标题（年份）」；只依据材料不编造；数值必须来自材料原文。"},
            {"role": "user", "content": "\n\n".join(gsections)[:60000]},
        ], max_tokens=6000)

        csv_text = build_matrix_csv(digests, cluster_jsons)
        with db.write() as c:
            c.execute(
                "UPDATE syntheses SET status='done', stage='final', report_md=?, matrix_csv=?, "
                "model=?, error=NULL, progress_done=progress_total, updated_at=datetime('now') "
                "WHERE id=?", (report, csv_text, cfg.model, synthesis_id))
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
