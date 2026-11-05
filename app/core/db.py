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

from .config import DB_PATH

SCHEMA_VERSION = 6

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',   -- admin | member
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
    overrides TEXT NOT NULL DEFAULT '{}',            -- 按用户覆盖 limits.* 的 JSON
    daily_parse_used TEXT NOT NULL DEFAULT '',       -- 'YYYY-MM-DD:count' 取最新
    disk_used_bytes  INTEGER NOT NULL DEFAULT 0
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
    deleted_at  TEXT,                                -- 软删除（回收站）
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_hash ON papers(file_hash) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS collections (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parse_runs (
    id          TEXT PRIMARY KEY,                    -- run + 随机串（v1 形态）
    paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    tier        TEXT NOT NULL,
    mineru_task_id TEXT,                             -- 远程 task_id（仅存活期有效）
    status      TEXT NOT NULL DEFAULT 'running',     -- running|done|failed|stale
    result_dir  TEXT NOT NULL DEFAULT '',
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
    bbox         TEXT,                               -- 归一化 [x0,y0,x1,y1] JSON，可 null
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
    job_type   TEXT NOT NULL,                        -- parse|translate|embed_backfill|summary
    paper_id   TEXT,
    payload    TEXT NOT NULL DEFAULT '{}',           -- JSON
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
            # WAL 常开
            c.execute("PRAGMA journal_mode=WAL")

    def _migrate(self, c: sqlite3.Connection, from_v: int) -> None:
        if from_v < 4:
            c.executescript("""
                ALTER TABLE papers ADD COLUMN meta_source TEXT;
                ALTER TABLE papers ADD COLUMN meta_verified_at TEXT;
            """)
        if from_v < 6:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS block_notes (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    paper_id   TEXT NOT NULL,
                    block_id   TEXT NOT NULL,
                    note       TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY(user_id, block_id)
                );
            """)
        if from_v < 5:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS journal_ranks (
                    journal    TEXT PRIMARY KEY,
                    data       TEXT NOT NULL,
                    source     TEXT NOT NULL DEFAULT '',
                    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
            """)
        if from_v < 4:
            c.executescript("""
                ALTER TABLE papers ADD COLUMN journal TEXT;
                ALTER TABLE papers ADD COLUMN abstract TEXT;
                ALTER TABLE papers ADD COLUMN keywords TEXT;
                ALTER TABLE papers ADD COLUMN doi TEXT;
                CREATE TABLE IF NOT EXISTS paper_notes (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    importance INTEGER NOT NULL DEFAULT 0,
                    tags       TEXT NOT NULL DEFAULT '',
                    notes      TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY(user_id, paper_id)
                );
            """)
        if from_v < 2:
            # v2: 文献库（collections）+ papers.collection_id
            c.executescript("""
                CREATE TABLE IF NOT EXISTS collections (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                ALTER TABLE papers ADD COLUMN collection_id TEXT;
            """)
        c.execute("UPDATE schema_version SET version=?", (SCHEMA_VERSION,))

    # ---- 备份（在线一致性快照） ----
    def backup_to(self, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self.write() as c:
            c.execute("VACUUM INTO ?", (str(dest),))

    # ---- 常用辅助 ----
    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self.read() as c:
            return c.execute(sql, args).fetchone()

    def all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.read() as c:
            return c.execute(sql, args).fetchall()


db = Database()
