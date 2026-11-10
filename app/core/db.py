"""SQLite 数据层：WAL + 单写者串行化 + schema 迁移.

约定（计划评审结论）:
- 所有写操作经 DAO 的写锁串行化，读走独立连接 —— 规避 database is locked
- 备份一律 VACUUM INTO，禁止 cp 运行中的库
- FTS5 表冗余 owner_id/visibility 列，检索免 join
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import re as _re

from .config import DB_PATH

SCHEMA_VERSION = 18


def cjk_space(s: str) -> str:
    """CJK 字符两两加空格（latin 边界也断开）——FTS5 unicode61 不分词中文，
    连续汉字会整段成 token；空格化后逐字成 token，短语查询即可命中任意子串。"""
    if not s:
        return s
    s = _re.sub(r"([\u4e00-\u9fff]+)", lambda m: " " + " ".join(m.group(1)) + " ", s)
    return _re.sub(r"\s+", " ", s).strip()


def fts_query(q: str, max_tokens: int = 12) -> str:
    """查询侧同变换；含 CJK 的 token 加引号成短语（保序邻接），latin 原样。"""
    toks = (q or "").replace('"', "").split()[:max_tokens]
    return " ".join(
        ('"' + cjk_space(t) + '"' if _re.search(r"[\u4e00-\u9fff]", t) else t)
        for t in toks)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',   -- admin | member
    token_ver     INTEGER NOT NULL DEFAULT 0,       -- 会话吊销版本号（改密/登出所有设备 +1）
    disabled      INTEGER NOT NULL DEFAULT 0,       -- 1=禁用登录
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_llm_keys (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    chat_cipher    BLOB,
    chat_meta      TEXT NOT NULL DEFAULT '{}',       -- {base_url,model} 明文可回显
    translate_cipher BLOB,
    translate_meta TEXT NOT NULL DEFAULT '{}',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,
    created_by INTEGER NOT NULL REFERENCES users(id),
    used_by    INTEGER REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_quotas (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    overrides TEXT NOT NULL DEFAULT '{}'             -- 按用户覆盖 limits.* 的 JSON（用量全部现算，不留快照列）
);

CREATE TABLE IF NOT EXISTS papers (
    id          TEXT PRIMARY KEY,                    -- p + 随机串
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    visibility  TEXT NOT NULL DEFAULT 'shared',      -- shared | private
    file_hash   TEXT NOT NULL,                       -- sha256 去重键
    title       TEXT NOT NULL DEFAULT '',
    authors     TEXT NOT NULL DEFAULT '',
    year        TEXT NOT NULL DEFAULT '',
    page_count  INTEGER NOT NULL DEFAULT 0,
    file_size   INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL DEFAULT 'pending',    -- pending|parsing|parsed|failed
    collection_id TEXT,                              -- 所属文献库（NULL=未分库）
    journal     TEXT,                                -- 元数据校准后期刊
    abstract    TEXT,
    keywords    TEXT,                                -- JSON 数组
    doi         TEXT,
    volume      TEXT,
    issue       TEXT,
    pages       TEXT,
    meta_source TEXT,                                -- arxiv|s2|crossref|llm|manual
    meta_verified_at TEXT,
    deleted_at  TEXT,                                -- 软删除（回收站）
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collections (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  TEXT,                                  -- 三级库：NULL=顶层库
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parse_runs (
    id          TEXT PRIMARY KEY,                    -- run + 随机串（v1 形态）
    paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    tier        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',     -- running|done|failed|stale
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocks (
    id           INTEGER PRIMARY KEY,
    paper_id     TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    parse_run_id TEXT NOT NULL REFERENCES parse_runs(id) ON DELETE CASCADE,
    block_id     TEXT NOT NULL,                      -- {paper}-v{run}-b{n:05d}
    type         TEXT NOT NULL,                      -- text/title/equation/table/image/list/...
    section_path TEXT NOT NULL DEFAULT '',
    page_index   INTEGER NOT NULL,                   -- PDF 物理页序（0 基）
    block_index  INTEGER NOT NULL,
    bbox         TEXT,                               -- 归一化 [x0,y0,x1,y1] JSON，可 null；跨页/跨栏段落为 [[框],[框]]
    bbox_pages   TEXT,                               -- 与 bbox 框一一对应的页码 JSON 数组；null = 全在 page_index
    asset_path   TEXT,                               -- 图/表裁剪文件相对路径（figures/...）
    text         TEXT NOT NULL DEFAULT '',
    source_hash  TEXT NOT NULL DEFAULT '',
    UNIQUE(parse_run_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_paper ON blocks(paper_id, page_index);

CREATE TABLE IF NOT EXISTS chunks (
    id           INTEGER PRIMARY KEY,
    paper_id     TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    parse_run_id TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    block_ids    TEXT NOT NULL,                      -- JSON 数组：来源 block
    page_index   INTEGER NOT NULL,                   -- 首 block 页
    embedding    BLOB,                               -- float32 x 1024；未回填为 NULL
    UNIQUE(parse_run_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);

-- FTS5：冗余可见性列，检索免 join
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, paper_id UNINDEXED, owner_id UNINDEXED, visibility UNINDEXED, chunk_row UNINDEXED
);

CREATE TABLE IF NOT EXISTS translations (
    id            INTEGER PRIMARY KEY,
    paper_id      TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    parse_run_id  TEXT NOT NULL,
    cache_key     TEXT NOT NULL,   -- sha256(source_hash+model+prompt_ver+glossary_ver+lang)
    block_id      TEXT NOT NULL,
    text_zh       TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    created_by    INTEGER REFERENCES users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_translations_lookup
    ON translations(paper_id, block_id, created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
    id         INTEGER PRIMARY KEY,
    paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    cache_key  TEXT NOT NULL,
    content    TEXT NOT NULL,
    model      TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_scope TEXT NOT NULL DEFAULT '',            -- 逗号分隔 paper_id（单篇或多选）
    title      TEXT NOT NULL DEFAULT '新会话',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,                       -- user|assistant
    content     TEXT NOT NULL,
    evidence    TEXT NOT NULL DEFAULT '[]',          -- JSON: [{evidence_id,paper_id,page,block_id}]
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    job_type   TEXT NOT NULL,                        -- parse|translate|embed_backfill|summary|meta
    paper_id   TEXT,
    payload    TEXT NOT NULL DEFAULT '{}',           -- JSON
    batch_id   TEXT,                                 -- 批量中心批次号（单篇任务为 NULL）
    priority   TEXT NOT NULL DEFAULT 'interactive',  -- interactive | background
    status     TEXT NOT NULL DEFAULT 'queued',       -- queued|pending_gate|running|done|failed|canceled
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    remote_task_id TEXT,
    error      TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(job_type, priority, status, created_at);

CREATE TABLE IF NOT EXISTS glossary (
    id         INTEGER PRIMARY KEY,
    term       TEXT NOT NULL,
    target     TEXT NOT NULL,                        -- keep_en |指定译法| first_both
    value      TEXT NOT NULL DEFAULT '',             -- 指定译法时的译文
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(term)
);

CREATE TABLE IF NOT EXISTS llm_calls (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER,
    purpose    TEXT NOT NULL,                        -- chat|translate|summary|embed
    key_source TEXT NOT NULL DEFAULT 'byok',         -- byok | pool
    model      TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    paper_id   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS paper_notes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    importance INTEGER NOT NULL DEFAULT 0,
    tags       TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, paper_id)
);

CREATE TABLE IF NOT EXISTS journal_ranks (
    journal    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS section_summaries (
    paper_id   TEXT NOT NULL,
    run_id     TEXT NOT NULL,
    section_path TEXT NOT NULL,
    level      INTEGER NOT NULL DEFAULT 1,   -- 1=章 2=节
    summary    TEXT NOT NULL,
    embedding  BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(paper_id, run_id, section_path, level)
);

CREATE TABLE IF NOT EXISTS syntheses (
    id          TEXT PRIMARY KEY,                     -- syn+随机串
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '文献综述',
    paper_ids   TEXT NOT NULL,                        -- JSON 数组
    clusters    TEXT,                                 -- JSON [{name, paper_ids}]（聚类完成后）
    status      TEXT NOT NULL DEFAULT 'running',      -- running|done|failed
    stage       TEXT NOT NULL DEFAULT 'cluster',      -- cluster|group|final
    progress_done   INTEGER NOT NULL DEFAULT 0,       -- 以 LLM 调用为单位
    progress_total  INTEGER NOT NULL DEFAULT 0,
    report_md   TEXT,                                 -- 最终报告 Markdown
    matrix_csv  TEXT,                                 -- 全篇对比矩阵 CSV（本地拼装，零 LLM 成本）
    error       TEXT,
    model       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_syntheses_user ON syntheses(user_id, updated_at DESC);

-- 专题采集任务：关键词 → 检索候选 → 勾选下载入库 → 自动综述（可中断可恢复）
CREATE TABLE IF NOT EXISTS acq_tasks (
    id          TEXT PRIMARY KEY,               -- atk+随机串
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',      -- 专题名（同时作为综述的研究问题先验）
    query       TEXT NOT NULL DEFAULT '',
    site        TEXT NOT NULL DEFAULT 'chinaxiv',
    filters     TEXT NOT NULL DEFAULT '{}',     -- {year_from, year_to, source_type, max}
    status      TEXT NOT NULL DEFAULT 'draft', -- draft|searching|ready|downloading|ingested|reviewing|done|failed
    candidates  TEXT NOT NULL DEFAULT '[]',     -- [{title,authors,year,venue,summary,pdf_url,abs_url,doi,selected,dl_status,paper_id,error}]
    paper_ids   TEXT NOT NULL DEFAULT '[]',
    synthesis_id TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acq_tasks_user ON acq_tasks(user_id, updated_at DESC);
"""


class Database:
    """读多连接 + 单写者串行化。"""

    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._write_lock = threading.Lock()
        self._local = threading.local()
        self._init_schema()

    # ---- 连接管理 ----
    def _conn(self, *, write: bool = False) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = getattr(self._local, "ro", None)
        if conn is None:
            conn = sqlite3.connect(self._path, timeout=30, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.ro = conn
        return conn

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """所有写经此串行化：锁 + 显式事务。"""
        with self._write_lock:
            conn = sqlite3.connect(self._path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self._conn()
        yield conn

    # ---- 初始化与迁移 ----
    def _init_schema(self) -> None:
        with self.write() as c:
            c.executescript(_SCHEMA)
            row = c.execute("SELECT version FROM schema_version").fetchone()
            if row is None:
                c.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
            elif row["version"] < SCHEMA_VERSION:
                self._migrate(c, row["version"])
            self._ensure_columns(c)   # 幂等兜底：任何形态的库都补齐列（新装/老库/中途版本）
            # 依赖兜底列的索引放在列补齐之后建（任意形态旧库都不炸）
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_hash "
                      "ON papers(file_hash) WHERE deleted_at IS NULL")
            # 高频查询索引：文库列表排序 / statuses 按论文聚合 / 用量按论文聚合
            c.execute("CREATE INDEX IF NOT EXISTS idx_papers_list "
                      "ON papers(deleted_at, created_at DESC)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_paper "
                      "ON jobs(paper_id, job_type, status)")
            # 批量中心进度面板按批次聚合
            c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_batch "
                      "ON jobs(batch_id) WHERE batch_id IS NOT NULL")
            # 高频点查/排序索引（审计：parse_runs 按 paper 查 done run、summaries 按篇取最新、
            # jobs 列表按 updated_at 排序原先全表扫+sort）
            c.execute("CREATE INDEX IF NOT EXISTS idx_parse_runs_paper "
                      "ON parse_runs(paper_id, status)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_summaries_paper "
                      "ON summaries(paper_id, created_at DESC)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_llm_calls_paper "
                      "ON llm_calls(paper_id)")
            # 用量/配额高频聚合（体检批二）：llm_calls 按用户+时间（/api/me/quota、/api/usage、
            # admin/users）、jobs 活跃状态（调度 _next_job / badge / 每日配额 COUNT）、
            # chat_messages 按会话取消息、papers 按属主（部分索引，/api/me/quota 磁盘 SUM）
            c.execute("CREATE INDEX IF NOT EXISTS idx_llm_calls_user_time "
                      "ON llm_calls(user_id, created_at)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_active "
                      "ON jobs(job_type, status, created_at)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_session "
                      "ON chat_messages(session_id, id)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_papers_owner "
                      "ON papers(owner_id) WHERE deleted_at IS NULL")
            # WAL 常开
            c.execute("PRAGMA journal_mode=WAL")

    @staticmethod
    def _add_col(c: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        if col not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")

    def _ensure_columns(self, c: sqlite3.Connection) -> None:
        """列级兜底：全部走 _add_col 幂等判断，修复历史上『列只存在于迁移分支』的新装缺列问题。"""
        for col in ("collection_id", "journal", "abstract", "keywords", "doi",
                    "volume", "issue", "pages", "meta_source", "meta_verified_at", "deleted_at"):
            self._add_col(c, "papers", col, "TEXT")
        self._add_col(c, "collections", "parent_id", "TEXT")
        self._add_col(c, "blocks", "asset_path", "TEXT")
        self._add_col(c, "blocks", "bbox_pages", "TEXT")
        self._add_col(c, "users", "token_ver", "INTEGER NOT NULL DEFAULT 0")
        self._add_col(c, "users", "disabled", "INTEGER NOT NULL DEFAULT 0")
        self._add_col(c, "jobs", "batch_id", "TEXT")
        self._add_col(c, "papers", "acq_task_id", "TEXT")
        self._add_col(c, "syntheses", "evidence", "TEXT")
        # survey-writer 升级：冻结引用键表 / 双向校验结果 / 发起参数(axis/tier/style/purpose)
        self._add_col(c, "syntheses", "cite_table", "TEXT")
        self._add_col(c, "syntheses", "verification", "TEXT")
        self._add_col(c, "syntheses", "params", "TEXT")
        self._add_col(c, "syntheses", "frameworks", "TEXT")
        self._add_col(c, "syntheses", "cluster_data", "TEXT")   # 组比对全文（rewrite 复用）

    def _migrate(self, c: sqlite3.Connection, from_v: int) -> None:
        # 列级变更统一由 _ensure_columns 幂等处理；这里只做数据迁移与死表清理。
        # 已下线功能的残留表（block_notes 段落批注 / block_merges 段落合并）一律清除。
        c.execute("DROP TABLE IF EXISTS block_notes")
        c.execute("DROP TABLE IF EXISTS block_merges")
        if from_v < 18:
            # v18：死列清理——用量全部现算（user_quotas 快照列从未有读写，
            # parse_runs 的远程 id/目录实际记录在 jobs.remote_task_id 与 MinerU 侧）
            for tbl, col in (("user_quotas", "daily_parse_used"),
                             ("user_quotas", "disk_used_bytes"),
                             ("parse_runs", "mineru_task_id"),
                             ("parse_runs", "result_dir")):
                try:
                    c.execute(f"ALTER TABLE {tbl} DROP COLUMN {col}")
                except sqlite3.OperationalError:
                    pass   # 新装库的 schema 已无该列
        if from_v < 17:
            # v17：FTS 中文检索修复——索引文本 CJK 空格化，按 chunks 全量重建
            rows = c.execute(
                "SELECT c.parse_run_id, c.chunk_index, c.text, c.paper_id, "
                "p.owner_id, p.visibility FROM chunks c JOIN papers p ON p.id=c.paper_id"
            ).fetchall()
            c.execute("DELETE FROM chunks_fts")
            for r in rows:
                c.execute(
                    "INSERT INTO chunks_fts(text,paper_id,owner_id,visibility,chunk_row) "
                    "VALUES(?,?,?,?,?)",
                    (cjk_space(r["text"]), r["paper_id"], r["owner_id"], r["visibility"],
                     f"{r['parse_run_id']}:{r['chunk_index']}"))
        if from_v < 8:
            # 译文幂等：同 paper+cache_key+block 唯一（部分翻译重跑不再产生重复行）
            c.execute("DELETE FROM translations WHERE rowid NOT IN ("
                      "SELECT MIN(rowid) FROM translations GROUP BY paper_id, cache_key, block_id)")
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_trans_unique "
                      "ON translations(paper_id, cache_key, block_id)")
        c.execute("UPDATE schema_version SET version=?", (SCHEMA_VERSION,))

    # ---- 备份（在线一致性快照） ----
    def backup_to(self, dest: Path) -> None:
        """独立连接 + sqlite3 backup API：不占全局写锁（VACUUM INTO 会在
        写锁内执行，备份的数十秒里所有业务写全部阻塞）。"""
        dest.parent.mkdir(parents=True, exist_ok=True)
        src = sqlite3.connect(self._path, timeout=30)
        try:
            src.execute("PRAGMA busy_timeout=10000")
            dst = sqlite3.connect(str(dest))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()

    # ---- 常用辅助 ----
    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self.read() as c:
            return c.execute(sql, args).fetchone()

    def all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.read() as c:
            return c.execute(sql, args).fetchall()


db = Database()
