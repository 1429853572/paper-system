"""文献追踪：订阅巡逻 → 去重 → 四层筛选 → 富化（core/tracker.py）。

article_tracker 思路的原生移植：arXiv 关键词/分类 + 顶刊期刊两条采集链，
DOI→arXiv ID→标题相似度三路去重，core/proxy/eco 分层 + 不足补足，
LLM 中文摘要富化（复用 llm.py 的预算闸与用量记账）。patrol 由 jobs.py 的
tracker_loop 守护线程按订阅的 frequency_hours 周期触发，也可手动立即执行。
"""
import difflib
import json
import re
import secrets
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import httpx

from . import journal, llm
from .db import db

_ARXIV_API = "https://export.arxiv.org/api/query"
_OPENALEX_API = "https://api.openalex.org/works"
_S2_API = "https://api.semanticscholar.org/graph/v1/paper/search"
_TITLE_SIM = 0.85          # 标题相似度去重阈值（article_tracker 同值）
_FALLBACK_MIN = 10         # core+proxy 不足此数时从 eco 补足并标 is_fallback
_MAX_PER_PATROL = 100      # 单源单轮上限（arXiv max_results 同值）
_ENRICH_BUDGET = 8         # 单轮 patrol 最多自动 LLM 富化的条数（控预算）
_HTTP = httpx.Client(timeout=30, headers={"User-Agent": "paper-system-tracker/1.0"})
_ATOM = {"a": "http://www.w3.org/2005/Atom"}


def _sid(prefix: str) -> str:
    return prefix + secrets.token_hex(8)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------- 查询构造（纯函数，供测试快照） ----------------
def arxiv_search_query(sub: dict, lookback_hours: int) -> str | None:
    """arXiv search_query：分类 AND 关键词 ANDNOT 排除。无任何条件返回 None。"""
    cats = [c for c in (sub["categories"] or "").split() if c.strip()]
    kws = [k.strip() for k in (sub["keywords"] or "").split(",") if k.strip()]
    exc = [k.strip() for k in (sub["exclude"] or "").split(",") if k.strip()]
    if not cats and not kws:
        return None
    groups = []
    if cats:
        groups.append("(" + " OR ".join(f"cat:{c}" for c in cats) + ")")
    if kws:
        groups.append("(" + " OR ".join(f'(ti:"{k}" OR abs:"{k}")' for k in kws) + ")")
    q = " AND ".join(groups)
    if exc:
        q += " ANDNOT (" + " OR ".join(f'(ti:"{k}" OR abs:"{k}")' for k in exc) + ")"
    return q


# ---------------- 采集：arXiv Atom ----------------
def fetch_arxiv(sub: dict, lookback_hours: int) -> list[dict]:
    q = arxiv_search_query(sub, lookback_hours)
    if not q:
        return []
    r = _HTTP.get(_ARXIV_API, params={
        "search_query": q, "start": 0, "max_results": _MAX_PER_PATROL,
        "sortBy": "submittedDate", "sortOrder": "descending",
    })
    r.raise_for_status()
    root = ET.fromstring(r.text)
    cutoff = datetime.now(timezone.utc).timestamp() - lookback_hours * 3600
    out = []
    for e in root.findall("a:entry", _ATOM):
        raw_id = (e.findtext("a:id", "", _ATOM) or "").rsplit("/", 1)[-1]
        arxiv_id = re.sub(r"v\d+$", "", raw_id)
        published = e.findtext("a:published", "", _ATOM) or ""
        try:
            ts = datetime.fromisoformat(published).timestamp()
            if ts < cutoff:          # 客户端日期过滤（分类检索会带出同分类旧文）
                continue
        except ValueError:
            pass
        pdf_url = ""
        for link in e.findall("a:link", _ATOM):
            if link.get("title") == "pdf":
                pdf_url = link.get("href") or ""
                break
        if not pdf_url and arxiv_id:
            pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
        out.append({
            "title": re.sub(r"\s+", " ", e.findtext("a:title", "", _ATOM)).strip(),
            "authors": ", ".join(a.findtext("a:name", "", _ATOM)
                                 for a in e.findall("a:author", _ATOM)),
            "abstract": re.sub(r"\s+", " ", e.findtext("a:summary", "", _ATOM) or "").strip(),
            "doi": (e.findtext("a:doi", "", _ATOM) or
                    (f"10.48550/arXiv.{arxiv_id}" if arxiv_id else "")).strip(),
            "arxiv_id": arxiv_id,
            "pdf_url": pdf_url,
            "venue": "arXiv",
            "published": published[:10],
        })
    return [x for x in out if x["title"]]


# ---------------- 采集：顶刊（OpenAlex，免 key） ----------------
def _oa_abstract(inv: dict) -> str:
    """OpenAlex abstract_inverted_index → 原文（词→位置重建）。"""
    if not inv:
        return ""
    pos = {}
    for w, idxs in inv.items():
        for i in idxs:
            pos[i] = w
    return " ".join(pos[i] for i in sorted(pos))


def resolve_source_ids(journals: list[str]) -> dict:
    """期刊名（模糊）→ OpenAlex source id。显示名与查询名相似度≥0.6 才采纳。"""
    out = {}
    for j in journals:
        try:
            r = _HTTP.get("https://api.openalex.org/sources",
                          params={"search": j, "per-page": 1})
            r.raise_for_status()
            res = (r.json() or {}).get("results") or []
            if not res:
                continue
            s0 = res[0]
            name = s0.get("display_name") or ""
            if difflib.SequenceMatcher(None, j.lower(), name.lower()).ratio() >= 0.6:
                out[j] = (s0.get("id") or "").rsplit("/", 1)[-1]   # S…id
        except httpx.HTTPError:
            continue
        time.sleep(0.3)
    return out


def fetch_journal_articles(sub: dict, lookback_hours: int) -> list[dict]:
    journals = [j.strip() for j in (sub["journals"] or "").split(",") if j.strip()]
    if not journals:
        return []
    date_from = datetime.now(timezone.utc).timestamp() - lookback_hours * 3600
    date_str = datetime.fromtimestamp(date_from, timezone.utc).strftime("%Y-%m-%d")
    kws = [k.strip() for k in (sub["keywords"] or "").split(",") if k.strip()]
    src_ids = resolve_source_ids(journals)
    if not src_ids:
        return []
    id_pipe = "|".join(src_ids.values())
    filt = f"primary_location.source.id:{id_pipe},from_publication_date:{date_str}"
    params = {"filter": filt, "sort": "publication_date:desc", "per-page": 50}
    if kws:
        params["filter"] += ",title_and_abstract.search:" + "|".join(kws)
    try:
        r = _HTTP.get(_OPENALEX_API, params=params)
        r.raise_for_status()
    except httpx.HTTPError:
        return []
    id2name = {v: k for k, v in src_ids.items()}
    out = []
    for w in (r.json() or {}).get("results", []):
        loc = w.get("best_oa_location") or w.get("primary_location") or {}
        src = (w.get("primary_location") or {}).get("source") or {}
        sid = (src.get("id") or "").rsplit("/", 1)[-1]
        doi = (w.get("doi") or "").replace("https://doi.org/", "")
        out.append({
            "title": (w.get("display_name") or "").strip(),
            "authors": ", ".join(a.get("author", {}).get("display_name", "")
                                 for a in (w.get("authorships") or [])[:12]),
            "abstract": _oa_abstract(w.get("abstract_inverted_index")),
            "doi": doi,
            "arxiv_id": ((w.get("ids") or {}).get("arxiv") or "").rsplit("/", 1)[-1],
            "pdf_url": loc.get("pdf_url") or "",
            "venue": src.get("display_name") or id2name.get(sid) or "",
            "published": (w.get("publication_date") or "")[:10],
            "cited_by": w.get("cited_by_count") or 0,
        })
        time.sleep(1)         # 礼貌延迟
    seen, dedup = set(), []
    for x in out:
        if not x["title"] or x["title"].lower() in seen:
            continue
        seen.add(x["title"].lower())
        dedup.append(x)
    return dedup


def fetch_cited_by(item: dict) -> int | None:
    """缺被引数时：OpenAlex 主源（cited_by_count）→ S2 备源 → None。
    429/5xx/超时各给一次补试（2s 间隔）；确定性 404 不重试。"""
    if not item.get("doi"):
        return None
    doi = item["doi"]
    for attempt in (1, 2):
        try:
            r = _HTTP.get("https://api.openalex.org/works/doi:" + doi)
            if r.status_code == 200:
                w = r.json() or {}
                if w.get("cited_by_count") is not None:
                    return int(w["cited_by_count"])
                break                          # OpenAlex 收录但无被引字段 → 不再查 S2
            if r.status_code == 404:
                break                          # OpenAlex 未收录 → 试 S2
            if r.status_code in (429, 500, 502, 503, 504) and attempt == 1:
                time.sleep(2)
                continue
            break
        except httpx.HTTPError:
            if attempt == 1:
                time.sleep(2)
                continue
            break
    for attempt in (1, 2):
        try:
            r = _HTTP.get("https://api.semanticscholar.org/graph/v1/paper/DOI:" + doi,
                          params={"fields": "citationCount"})
            if r.status_code == 200:
                c = (r.json() or {}).get("citationCount")
                return int(c) if c is not None else None
            if r.status_code in (429, 500, 502, 503, 504) and attempt == 1:
                time.sleep(2)
                continue
            return None
        except httpx.HTTPError:
            if attempt == 1:
                time.sleep(2)
                continue
            return None
    return None


# ---------------- 去重 ----------------
def _title_sim(a: str, b: str) -> float:
    a, b = (a or "").lower().strip(), (b or "").lower().strip()
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def merge_round(items: list[dict]) -> list[dict]:
    """轮内去重：DOI 相同 / arXiv ID 相同 / 标题相似度≥0.85 视为同一篇，
    保留非空字段更多的一条，并把另一条的非空字段补进空位（article_tracker 合并语义）。"""
    _FIELDS = ("title", "authors", "abstract", "doi", "arxiv_id", "pdf_url", "code_url", "venue", "published")
    out: list[dict] = []
    for it in items:
        hit = None
        for kept in out:
            if ((it.get("doi") and it["doi"] == kept.get("doi"))
                    or (it.get("arxiv_id") and it["arxiv_id"] == kept.get("arxiv_id"))
                    or _title_sim(it["title"], kept["title"]) >= _TITLE_SIM):
                hit = kept
                break
        if hit is None:
            out.append(dict(it))
            continue
        if sum(1 for f in _FIELDS if it.get(f)) > sum(1 for f in _FIELDS if hit.get(f)):
            hit, it = it, hit          # hit 指向字段更全者；it 变为补充源
        for f in _FIELDS:
            if not hit.get(f) and it.get(f):
                hit[f] = it[f]
    return out


def library_hit(c, user_id: int, it: dict):
    """系统已入库判定：DOI 精确 / 标题相似（本人名下任何可见性）。"""
    if it.get("doi"):
        row = c.execute("SELECT id, title FROM papers WHERE owner_id=? AND doi=? AND deleted_at IS NULL",
                        (user_id, it["doi"])).fetchone()
        if row:
            return row
    for row in c.execute("SELECT id, title FROM papers WHERE owner_id=? AND deleted_at IS NULL",
                         (user_id,)).fetchall():
        if _title_sim(it["title"], row["title"]) >= _TITLE_SIM:
            return row
    return None


# ---------------- 分层 ----------------
def classify(item: dict, sub: dict) -> str:
    """core=标题命中关键词或期刊命中；proxy=仅摘要命中；eco=其余（分类/期刊-only 带回）。"""
    kws = [k.strip().lower() for k in (sub["keywords"] or "").split(",") if k.strip()]
    journals = [j.strip().lower() for j in (sub["journals"] or "").split(",") if j.strip()]
    title, absm = (item.get("title") or "").lower(), (item.get("abstract") or "").lower()
    if journals and any(j in (item.get("venue") or "").lower() for j in journals):
        return "core"
    if kws and any(k in title for k in kws):
        return "core"
    if kws and any(k in absm for k in kws):
        return "proxy"
    return "eco"


def fill_fallback(items: list[dict], minimum: int = _FALLBACK_MIN) -> None:
    """core+proxy 不足 minimum 时按发表时间从 eco 补足并标 is_fallback（原位修改）。"""
    strong = sum(1 for x in items if x["tier"] in ("core", "proxy"))
    if strong >= minimum:
        return
    for x in sorted((x for x in items if x["tier"] == "eco"),
                    key=lambda x: x.get("published") or "", reverse=True):
        if strong >= minimum:
            return
        x["tier"], x["is_fallback"] = "eco", 1
        strong += 1


# ---------------- 富化 ----------------
def enrich_abstract(item: dict) -> str:
    """缺摘要三源回退：S2 → OpenAlex → Crossref（返回找到的摘要或空串）。"""
    if item.get("abstract"):
        return item["abstract"]
    try:
        if item.get("doi"):
            r = _HTTP.get("https://api.semanticscholar.org/graph/v1/paper/DOI:" + item["doi"],
                          params={"fields": "abstract"})
            if r.status_code == 200 and (r.json() or {}).get("abstract"):
                return r.json()["abstract"]
        if item.get("doi"):
            r = _HTTP.get("https://api.openalex.org/works/doi:" + item["doi"])
            if r.status_code == 200:
                ab = _oa_abstract((r.json() or {}).get("abstract_inverted_index"))
                if ab:
                    return ab
            r = _HTTP.get(f"https://api.crossref.org/works/{item['doi']}")
            if r.status_code == 200:
                ab = ((r.json().get("message") or {}).get("abstract") or "")
                ab = re.sub(r"<[^>]+>", " ", ab)
                return re.sub(r"\s+", " ", ab).strip()
    except httpx.HTTPError:
        pass
    return ""


def extract_code_url(abstract: str) -> str:
    m = re.search(r"https?://(?:www\.)?github\.com/[\w.-]+/[\w.-]+", abstract or "")
    return m.group(0) if m else ""


def llm_enrich(user_id: int, item: dict) -> dict | None:
    """中文一段话总结 + 中文标题。预算闸/用量记账由 LLMClient 自带；无 key 返回 None。"""
    try:
        cfg = llm.resolve_llm(user_id, "chat")
    except llm.NoKeyError:
        return None
    client = llm.LLMClient(cfg, user_id=user_id)
    prompt = (
        "你是学术论文助手。阅读以下论文信息，输出严格 JSON（不要代码围栏）：\n"
        '{"zh_summary": "不超过120字的中文一段话总结（问题/方法/结果）", '
        '"zh_title": "中文标题翻译"}\n\n'
        f"标题：{item.get('title')}\n作者：{item.get('authors')}\n"
        f"摘要：{(item.get('abstract') or '')[:2500]}")
    try:
        text = client.complete([{"role": "user", "content": prompt}], max_tokens=400)
        m = re.search(r"\{.*\}", text, re.S)
        import json as _json
        d = _json.loads(m.group(0)) if m else {}
        return {"zh_summary": (d.get("zh_summary") or "").strip() or None,
                "zh_title": (d.get("zh_title") or "").strip() or None}
    except Exception:  # noqa: BLE001 —— 单条富化失败不阻断巡逻
        return None


# ---------------- 巡逻编排 ----------------
def patrol(sub: dict, is_admin: bool = True, email_fn=None) -> dict:
    """跑一轮订阅。返回 {new, total, skipped_dup}。email_fn(sub, new_items) 由调用方注入。"""
    user_id = sub["user_id"]
    lookback = max(int(sub["frequency_hours"] or 24), 24) + 24   # 频率 + 24h 缓冲
    fresh: list[dict] = []
    error = ""
    try:
        fresh += fetch_arxiv(sub, lookback)
    except Exception as e:  # noqa: BLE001
        error = f"arXiv: {e}"
    try:
        jr = fetch_journal_articles(sub, lookback)
        fresh += jr
    except Exception as e:  # noqa: BLE001
        error = (error + "; " if error else "") + f"journals: {e}"
    fresh = merge_round(fresh)

    with db.read() as c:
        known_arxiv = {r["arxiv_id"] for r in c.execute(
            "SELECT arxiv_id FROM tracker_items WHERE sub_id=? AND arxiv_id IS NOT NULL",
            (sub["id"],)).fetchall()}
        for it in fresh:
            it["tier"] = classify(it, sub)
        fill_fallback(fresh)

        new_rows, dup_lib, dup_round = [], 0, 0
        for it in fresh:
            if it.get("arxiv_id") and it["arxiv_id"] in known_arxiv:
                dup_round += 1
                continue
            hit = library_hit(c, user_id, it)
            if hit:
                dup_lib += 1
                continue
            new_rows.append(it)

    # 分区/被引/摘要富化全部在写事务外（get_journal_rank 内部自带写锁——
    # 嵌套在 with db.write() 里 = 非重入锁自死锁，v1.7.0 的 P0 老坑）
    rank_cache: dict = {}
    for it in new_rows:
        it["abstract"] = enrich_abstract(it) or it.get("abstract") or ""
        it["code_url"] = extract_code_url(it["abstract"])
        if it.get("cited_by") is None:
            it["cited_by"] = fetch_cited_by(it)
        venue = (it.get("venue") or "").strip()
        if venue and venue.lower() != "arxiv" and venue not in rank_cache:
            r = journal.get_journal_rank(venue)
            rank_cache[venue] = (json.dumps(
                {k: r.get(k) for k in ("cas", "jcr", "impact_factor")}, ensure_ascii=False)
                if r.get("found") else None)

    inserted = []
    with db.write() as c:
        for it in new_rows:
            rank_json = rank_cache.get((it.get("venue") or "").strip())
            iid = _sid("ti")
            try:
                c.execute(
                    "INSERT INTO tracker_items(id, sub_id, user_id, title, authors, abstract, "
                    "zh_summary, doi, arxiv_id, pdf_url, code_url, venue, published, tier, is_fallback, "
                    "rank, cited_by, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new')",
                    (iid, sub["id"], user_id, it["title"], it.get("authors") or "", it.get("abstract") or "",
                     None, it.get("doi") or None, it.get("arxiv_id") or None, it.get("pdf_url") or None,
                     it.get("code_url") or None, it.get("venue") or None, it.get("published") or None,
                     it["tier"], 1 if it.get("is_fallback") else 0, rank_json,
                     it.get("cited_by") if it.get("cited_by") is not None else None))
                inserted.append({**it, "id": iid})
            except Exception:  # noqa: BLE001 —— 唯一性冲突等单条失败跳过
                continue

    # LLM 富化：按订阅档位，封顶 _ENRICH_BUDGET 条（无 key/预算尽自动跳过）
    if sub["llm_auto"] != "off" and inserted:
        want = [x for x in inserted if x["tier"] == "core"] \
            if sub["llm_auto"] == "core" else inserted
        for x in want[:_ENRICH_BUDGET]:
            r = llm_enrich(user_id, x)
            if r and (r["zh_summary"] or r["zh_title"]):
                with db.write() as c:
                    c.execute("UPDATE tracker_items SET zh_summary=?, zh_title=? WHERE id=?",
                              (r["zh_summary"], r["zh_title"], x["id"]))
                x["zh_summary"], x["zh_title"] = r["zh_summary"], r["zh_title"]

    with db.write() as c:
        c.execute("UPDATE tracker_subs SET last_run_at=?, last_error=? WHERE id=?",
                  (_now(), error or None, sub["id"]))

    new_count = len(inserted)
    if new_count and sub["email_enabled"] and sub["email_to"] and email_fn:
        try:
            email_fn(sub, inserted)
        except Exception:  # noqa: BLE001 —— 邮件失败不影响巡逻结果
            pass
    return {"new": new_count, "fetched": len(fresh), "dup_library": dup_lib, "dup_round": dup_round,
            "error": error or None}


def _is_due(sub, now=None) -> bool:
    """到期判定：设了 run_at_time（HH:MM，服务器本地时区）→ 每天到点且今天未跑；
    未设 → 按 frequency_hours 间隔滚动。last_run_at 存 UTC，统一转时区后比较。"""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    last = sub.get("last_run_at")
    last_dt = None
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    rt = (sub.get("run_at_time") or "").strip()
    if re.match(r"^\d{1,2}:\d{2}$", rt):
        hh, mm = map(int, rt.split(":"))
        now_loc = now.astimezone()                          # 服务器本地时区
        target_loc = now_loc.replace(hour=min(hh, 23), minute=min(mm, 59), second=0, microsecond=0)
        if now_loc < target_loc:
            return False                                    # 今天时刻未到
        if last_dt is not None and last_dt.astimezone() >= target_loc:
            return False                                    # 今天的点已跑过
        return True
    if last_dt is None:
        return True
    return (now - last_dt).total_seconds() / 3600 >= int(sub.get("frequency_hours") or 24)


def run_due(email_fn=None) -> list[dict]:
    """tracker_loop 周期入口：跑所有到期且启用的订阅（SSE 广播由调用方做）。"""
    with db.read() as c:
        rows = c.execute("SELECT * FROM tracker_subs WHERE enabled=1").fetchall()
    rows = [r for r in rows if _is_due(dict(r))]
    results = []
    for sub in rows:
        try:
            results.append({"sub_id": sub["id"], "user_id": sub["user_id"], **patrol(sub, email_fn=email_fn)})
        except Exception as e:  # noqa: BLE001 —— 单订阅失败不影响其余
            with db.write() as c:
                c.execute("UPDATE tracker_subs SET last_run_at=?, last_error=? WHERE id=?",
                          (_now(), str(e)[:300], sub["id"]))
            results.append({"sub_id": sub["id"], "user_id": sub["user_id"], "error": str(e)})
        time.sleep(2)
    return results
