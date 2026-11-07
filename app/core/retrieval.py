"""检索层：分块 → embedding(BGE-M3 via Ollama) → FTS5 + 向量余弦 → RRF 融合.

设计依据（计划）：
- 千篇量级 ≈ 2.5万 chunks，numpy 暴力余弦毫秒级，不引向量库
- chunks.embedding 为 float32 BLOB；embedding NULL = 未回填
- FTS5 冗余 owner_id/visibility，检索免 join、按可见性过滤
- rerank 留接口（首版不启用）
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import struct
import time
from typing import Any

import httpx
import numpy as np

from .config import EMBED_DIMS, EMBED_MODEL, OLLAMA_BASE_URL, config
from .db import cjk_space, fts_query, db

# ---- 分块（入库时调用） ----

def _clean_text(t: str) -> str:
    """表格 HTML → 纯文本（避免 <table> 污染索引与检索展示）."""
    if not t or "<" not in t:
        return t
    t = re.sub(r"<\s*(br|/tr|/p|/div|/td|/th)[^>]*>", " ", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        t = t.replace(a, b)
    return re.sub(r"[ \t]+", " ", t).strip()


def build_chunks(paper_id: str, run_id: str, blocks: list) -> int:
    """按 block 边界聚合 chunk：~800 字符目标，重叠靠块级重复上一 chunk 尾块。

    返回 chunk 数。chunk.page_index 取首 block 页（0 基）。
    """
    _clean = _clean_text
    target = int(config.get("rag", "chunk_tokens")) * 1.3  # ≈字符数（英文 ~1.3 char/token）
    overlap_chars = int(config.get("rag", "overlap_tokens")) * 1.3
    chunks: list[tuple[str, str, int]] = []  # (text, block_ids_json, page_index)
    cur: list[Any] = []
    cur_len = 0

    def flush() -> None:
        nonlocal cur, cur_len
        if not cur:
            return
        text = "\n\n".join(_clean(b["text"]) for b in cur if b["text"].strip())
        if text.strip():
            chunks.append((
                text,
                json.dumps([b["block_id"] for b in cur]),
                int(cur[0]["page_index"]),
            ))
        # 重叠：保留尾部块直到 overlap 字符
        tail: list[Any] = []
        tlen = 0
        for b in reversed(cur):
            if tlen + len(b["text"]) > overlap_chars and tail:
                break
            tail.insert(0, b)
            tlen += len(b["text"])
        cur, cur_len = tail, tlen

    for row in blocks:
        b = dict(row)
        if cur and cur_len + len(b.get("text", "")) > target:
            flush()
        cur.append(b)
        cur_len += len(b.get("text", ""))
    # 引用列表单独成块时跳过索引价值有限——保持原样入库
    flush()
    # 尾部重叠残余并入
    if cur:
        text = "\n\n".join(_clean(b["text"]) for b in cur if b["text"].strip())
        if text.strip() and (not chunks or chunks[-1][0] != text):
            chunks.append((text, json.dumps([b["block_id"] for b in cur]), int(cur[0]["page_index"])))

    with db.write() as c:
        c.executemany(
            "INSERT OR REPLACE INTO chunks(paper_id,parse_run_id,chunk_index,text,block_ids,page_index) "
            "VALUES(?,?,?,?,?,?)",
            [(paper_id, run_id, i, t, bids, pg) for i, (t, bids, pg) in enumerate(chunks)],
        )
        # FTS 同步（冗余可见性列）
        paper = c.execute("SELECT owner_id, visibility FROM papers WHERE id=?", (paper_id,)).fetchone()
        c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (paper_id,))
        c.executemany(
            "INSERT INTO chunks_fts(text,paper_id,owner_id,visibility,chunk_row) VALUES(?,?,?,?,?)",
            [(cjk_space(t), paper_id, paper["owner_id"], paper["visibility"],
              f"{run_id}:{i}") for i, (t, bids, pg) in enumerate(chunks)],
        )
    return len(chunks)


# ---- embedding（Ollama OpenAI 兼容接口，本地无 key） ----

def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def _unpack(blob: bytes) -> np.ndarray:
    return np.array(struct.unpack(f"<{len(blob)//4}f", blob), dtype=np.float32)


def embed_texts(texts: list[str], batch_size: int | None = None) -> list[list[float]]:
    """批量调用本地 embedding 服务（xinference / Ollama 均可，OpenAI 兼容）."""
    bs = batch_size or int(config.get("scheduler", "embed_backfill_batch"))
    base = (os.environ.get("EMBED_BASE_URL") or EMBED_BASE_URL).rstrip("/")
    model = os.environ.get("EMBED_MODEL_NAME") or EMBED_MODEL
    out: list[list[float]] = []
    with httpx.Client(timeout=180) as http:
        for i in range(0, len(texts), bs):
            batch = [t[:6000] for t in texts[i:i + bs]]  # BGE-M3 8192 token，留余量
            r = http.post(f"{base}/v1/embeddings",
                         json={"model": model, "input": batch})
            r.raise_for_status()
            data = r.json()["data"]
            data.sort(key=lambda x: x["index"])
            out.extend(d["embedding"] for d in data)
    return out


def backfill_embeddings(paper_id: str, progress_cb=None) -> int:
    """为一个论文未回填的 chunks 计算 embedding。返回处理条数。"""
    rows = db.all(
        "SELECT id, text FROM chunks WHERE paper_id=? AND embedding IS NULL ORDER BY chunk_index",
        (paper_id,),
    )
    if not rows:
        return 0
    done = 0
    bs = int(config.get("scheduler", "embed_backfill_batch"))
    for i in range(0, len(rows), bs):
        part = rows[i:i + bs]
        vecs = embed_texts([r["text"] for r in part], batch_size=bs)
        with db.write() as c:
            for row, vec in zip(part, vecs):
                c.execute("UPDATE chunks SET embedding=? WHERE id=?", (_pack(vec), row["id"]))
        done += len(part)
        if progress_cb:
            progress_cb(done, len(rows))
    invalidate_vec_cache()
    return done


# ---- 向量矩阵缓存（检索热路径：免每次全库 SELECT + 逐条 unpack） ----
# key → (monotonic时间, 归一化矩阵, chunk_ids)；embedding 只在回填/重建时变化，
# TTL 兜底 + backfill/reindex 主动失效。
_vec_cache: dict[str, tuple[float, np.ndarray, np.ndarray]] = {}
_VEC_TTL = 600.0


def invalidate_vec_cache() -> None:
    """embedding 数据变化后调用，下次检索重建矩阵缓存。"""
    _vec_cache.clear()


def _load_matrix(scope_key: str, sql: str, args: tuple) -> tuple[np.ndarray, np.ndarray]:
    """按 scope 缓存归一化向量矩阵。返回 (ids, mat)。维度不符的行（换模型残留）跳过。"""
    hit = _vec_cache.get(scope_key)
    now = time.monotonic()
    if hit and now - hit[0] < _VEC_TTL:
        return hit[1], hit[2]
    rows = db.all(sql, args)
    kept_rows = [r for r in rows if len(r["embedding"]) == EMBED_DIMS * 4]
    if kept_rows:
        ids = np.array([int(r["id"]) for r in kept_rows], dtype=np.int64)
        mat = np.stack([np.frombuffer(r["embedding"], dtype="<f4") for r in kept_rows])
        mat = np.ascontiguousarray(mat, dtype=np.float32)
        mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    else:
        ids = np.array([], dtype=np.int64)
        mat = np.zeros((0, EMBED_DIMS), dtype=np.float32)
    _vec_cache[scope_key] = (now, mat, ids)
    return mat, ids


# ---- 检索 ----

def sync_block_edit(paper_id: str, run_id: str, block_id: str, new_text: str) -> int:
    """人工修正块文本后的索引同步（可视化修正）。

    blocks.text 更新 + 重建所有引用该块的 chunk（chunk 文本聚合规则与 build_chunks
    一致：块序 + _clean + 空行 join）+ FTS 行替换 + 重算 embedding。
    embedding 失败时置 NULL 交给 backfill 兜底（FTS 不受影响）。
    返回受影响 chunk 数。
    """
    import json as _json

    blk = db.one("SELECT text FROM blocks WHERE paper_id=? AND parse_run_id=? AND block_id=?",
                 (paper_id, run_id, block_id))
    if blk is None:
        return 0
    with db.write() as c:
        c.execute("UPDATE blocks SET text=? WHERE paper_id=? AND parse_run_id=? AND block_id=?",
                  (new_text, paper_id, run_id, block_id))
        # 派生失效（T2）：该块的旧译文立即作废（按新文本按需重译），
        # 章节摘要含旧数字 → 删除（smart 模式自动回退检索取证，meta 可再生）
        c.execute("DELETE FROM translations WHERE paper_id=? AND block_id=?", (paper_id, block_id))
        c.execute("DELETE FROM section_summaries WHERE paper_id=? AND parse_run_id=?",
                  (paper_id, run_id))
    chunks = db.all(
        "SELECT id, chunk_index, block_ids FROM chunks WHERE paper_id=? AND parse_run_id=? "
        "AND block_ids LIKE ?", (paper_id, run_id, f'%"{block_id}"%'))
    paper = db.one("SELECT owner_id, visibility FROM papers WHERE id=?", (paper_id,))
    if paper is None:
        return 0
    texts = {r["block_id"]: r["text"] for r in db.all(
        "SELECT block_id, text FROM blocks WHERE parse_run_id=?", (run_id,))}
    for ch in chunks:
        bids = _json.loads(ch["block_ids"])
        new_chunk_text = "\n\n".join(
            p for p in (_clean_text(texts.get(b, "")) for b in bids) if p.strip())
        try:
            vec = embed_texts([new_chunk_text], batch_size=1)[0]
            emb = _pack(vec)
        except Exception:  # noqa: BLE001 —— embedding 服务抖动不阻塞修正，NULL 交给 backfill
            emb = None
        with db.write() as c:
            c.execute("UPDATE chunks SET text=? WHERE id=?", (new_chunk_text, ch["id"]))
            c.execute("DELETE FROM chunks_fts WHERE paper_id=? AND chunk_row=?",
                      (paper_id, f"{run_id}:{ch['chunk_index']}"))
            c.execute("INSERT INTO chunks_fts(text,paper_id,owner_id,visibility,chunk_row) "
                      "VALUES(?,?,?,?,?)",
                      (cjk_space(new_chunk_text), paper_id, paper["owner_id"], paper["visibility"],
                       f"{run_id}:{ch['chunk_index']}"))
            c.execute("UPDATE chunks SET embedding=? WHERE id=?", (emb, ch["id"]))
    invalidate_vec_cache()
    return len(chunks)


def _rrf(rankings: list[list[int]], k: int = 60) -> dict[int, float]:
    """Reciprocal Rank Fusion：输入各路召回的 id 排名列表。"""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, cid in enumerate(ranking):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
    return scores


def search(query: str, *, user_id: int, is_admin: bool,
           paper_ids: list[str] | None = None, top_k: int | None = None) -> list[dict[str, Any]]:
    """混合检索（可见性过滤）。返回 [{chunk_id, paper_id, text, page_index, score}]。

    - 管理员可检索全部；普通用户限 shared + 自己的 private
    - paper_ids 限定范围（跨论文对比/单篇证据模式）
    """
    k = top_k or int(config.get("rag", "fts_top_k"))

    vis_clause, vis_args = "", []
    if not is_admin:
        vis_clause = " AND (visibility='shared' OR owner_id=?)"
        vis_args = [user_id]
    paper_clause, paper_args = "", []
    if paper_ids:
        paper_clause = f" AND paper_id IN ({','.join('?' * len(paper_ids))})"
        paper_args = list(paper_ids)

    # 1) FTS5 关键词
    fts_ids: list[int] = []
    try:
        q = fts_query(query)   # CJK 空格化短语（与索引同变换）
        rows = db.all(
            "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? "
            f"AND 1=1{vis_clause}{paper_clause} LIMIT ?",
            (q, *vis_args, *paper_args, k),
        )
        fts_ids = [r["rowid"] for r in rows]
    except Exception:
        fts_ids = []

    # 2) 向量余弦（矩阵缓存：同 scope 重复查询免反序列化）
    vec_ids: list[int] = []
    try:
        qvec = np.array(embed_texts([query])[0], dtype=np.float32)
        qn = qvec / (np.linalg.norm(qvec) + 1e-9)
        scope_src = ("all" if is_admin else f"u{user_id}") + "|" + ",".join(sorted(paper_ids or []))
        scope_key = hashlib.md5(scope_src.encode()).hexdigest()
        mat, ids = _load_matrix(
            scope_key,
            "SELECT c.id, c.embedding FROM chunks c JOIN papers p ON p.id=c.paper_id "
            f"WHERE c.embedding IS NOT NULL AND p.deleted_at IS NULL"
            f"{vis_clause.replace('visibility', 'p.visibility').replace('owner_id', 'p.owner_id')}{paper_clause}",
            (*vis_args, *paper_args),
        )
        if len(ids) and mat.shape[1] == len(qn):
            sims = mat @ qn
            order = np.argsort(-sims)[:k]
            vec_ids = [int(ids[i]) for i in order]
    except Exception:
        vec_ids = []

    # 3) RRF 融合
    merged = _rrf([fts_ids, vec_ids])
    ranked = sorted(merged.items(), key=lambda x: -x[1])[:k]
    if not ranked:
        return []
    placeholders = ",".join("?" * len(ranked))
    rows = db.all(
        f"SELECT c.id, c.paper_id, c.text, c.page_index, c.block_ids FROM chunks c "
        f"JOIN papers p ON p.id=c.paper_id WHERE c.id IN ({placeholders}) AND p.deleted_at IS NULL",
        tuple(cid for cid, _ in ranked),
    )
    score_map = dict(ranked)
    out = [dict(r) | {"score": score_map[r["id"]]} for r in rows]
    out.sort(key=lambda x: -x["score"])
    # 可选：交叉编码器重排（配置开启且服务可用时）
    if config.get("rerank", "enabled") and out:
        out = rerank_chunks(query, out,
                            int(config.get("rerank", "top_n")),
                            int(config.get("rerank", "keep")))
    return out


# ---- 库存/重建 ----

def index_version() -> str:
    return f"{EMBED_MODEL}:{EMBED_DIMS}:v1"


# ================= 交叉编码器重排（可选） =================
def rerank_available() -> bool:
    if not config.get("rerank", "enabled"):
        return False
    base = os.environ.get("RERANK_BASE_URL") or config.get("rerank", "base_url")
    if not base:
        return False
    try:
        r = httpx.get(f"{base.rstrip('/')}/health", timeout=3)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def rerank_chunks(query: str, chunks: list[dict], top_n: int, keep: int) -> list[dict]:
    """用交叉编码器对候选重排（失败则原样返回，不影响可用性）。"""
    if not chunks:
        return chunks
    base = (os.environ.get("RERANK_BASE_URL") or config.get("rerank", "base_url")).rstrip("/")
    model = config.get("rerank", "model")
    docs = [(c.get("text") or "")[:1200] for c in chunks]
    try:
        r = httpx.post(f"{base}/v1/rerank",
                       json={"model": model, "query": query, "documents": docs,
                             "top_n": min(top_n, len(docs))},
                       timeout=config.get("rerank", "timeout"))
        r.raise_for_status()
        results = r.json().get("results") or []
    except Exception as e:  # noqa: BLE001 —— 降级但留痕（否则静默失败难排查）
        import logging
        logging.getLogger("retrieval").warning("rerank 失败，降级为向量排序: %s", e)
        return chunks
    if not results:
        import logging
        logging.getLogger("retrieval").warning("rerank 返回空结果（model=%s, docs=%d）", model, len(docs))
    out = []
    for item in results:
        idx = item.get("index")
        if idx is None or idx >= len(chunks):
            continue
        c = dict(chunks[idx])
        c["score"] = float(item.get("relevance_score", c.get("score", 0.0)))
        c["reranked"] = True
        out.append(c)
    return out[:keep] if out else chunks
