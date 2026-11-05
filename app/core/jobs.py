"""持久化任务调度器.

核心设计（计划评审定稿）：
- 公平轮转: interactive > background 两层；层内按用户 round-robin——单人千篇批量不阻塞他人
- 通道: 解析 worker×1（GPU 串行）；embedding 回填×1（后台）；翻译池（里程碑3）
- health gate: mineru /health 不过 → 任务挂 pending_gate，不标失败（vLLM 重启期无雪崩）
- 恢复: 启动扫描 running 任务——远程 404（服务端任务仅存内存）→ 清 task_id 重新排队
- SSE: EventBus 广播任务进度
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
import queue
import threading
import time
from typing import Any, Callable, Iterator

from . import ingest, retrieval
from .config import config
from .db import db
from .mineru_client import MinerUError, mineru

log = logging.getLogger("jobs")


# ---------------- EventBus（SSE） ----------------
class EventBus:
    def __init__(self) -> None:
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


bus = EventBus()


def _emit(job_row: Any) -> None:
    bus.publish({
        "job_id": job_row["id"],
        "user_id": job_row["user_id"],
        "job_type": job_row["job_type"],
        "paper_id": job_row["paper_id"],
        "status": job_row["status"],
        "done": job_row["progress_done"],
        "total": job_row["progress_total"],
        "error": job_row["error"],
    })


# ---------------- 调度器 ----------------
class Scheduler:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._last_user: dict[str, int] = {}  # job_type -> 上次服务的 user_id（轮转指针）
        self._paused_types: set[str] = set()  # 暂停的批量类型（parse/translate）
        self._translate_slots: dict[int, int] = {}  # user_id -> 在跑翻译数

    # ---- 启动 ----
    def start(self) -> None:
        self.recover()
        for name, fn in (
            ("parse-worker", self._parse_loop),
            ("embed-worker", self._embed_loop),
            ("meta-worker", self._meta_loop),
            ("translate-worker", self._translate_loop),
            ("janitor", self._janitor_loop),
        ):
            t = threading.Thread(target=fn, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()

    # ---- 恢复（幂等） ----
    def recover(self) -> None:
        """启动扫描：running 的 parse 任务查远程；404 → 清 task_id 重排队。"""
        rows = db.all("SELECT * FROM jobs WHERE status IN ('running','pending_gate')")
        for r in rows:
            if r["job_type"] == "parse" and r["remote_task_id"]:
                try:
                    mineru.poll(r["remote_task_id"])
                    # 远程还在：保持 running，由 parse 循环接管
                except MinerUError as e:
                    if e.code == "task_not_found":
                        with db.write() as c:
                            c.execute(
                                "UPDATE jobs SET status='queued', remote_task_id=NULL,"
                                "error=NULL WHERE id=?",
                                (r["id"],),
                            )
                        log.info("job %s 远程任务失效，已重排队", r["id"])
            elif r["job_type"] in ("embed_backfill", "translate"):
                with db.write() as c:
                    c.execute("UPDATE jobs SET status='queued' WHERE id=?", (r["id"],))

    # ---- 入队（服务层调用） ----
    def enqueue(self, user_id: int, job_type: str, paper_id: str | None,
                payload: dict, priority: str = "interactive",
                progress_total: int = 0) -> int:
        with db.write() as c:
            cur = c.execute(
                "INSERT INTO jobs(user_id,job_type,paper_id,payload,priority,progress_total) "
                "VALUES(?,?,?,?,?,?)",
                (user_id, job_type, paper_id, json.dumps(payload), priority, progress_total),
            )
            job_id = cur.lastrowid
        self._notify_queue(job_id)
        return int(job_id)

    def _notify_queue(self, job_id: int) -> None:
        # 唤醒 worker（简化：worker 轮询 + 事件队列双保险）
        self._wake.set()

    _wake = threading.Event()

    # ---- 公平取任务 ----
    def _next_job(self, job_type: str) -> Any:
        """两层优先级 + 层内按用户 round-robin。"""
        rows = db.all(
            "SELECT * FROM jobs WHERE job_type=? AND status='queued' "
            "ORDER BY created_at LIMIT 400",
            (job_type,),
        )
        if not rows:
            return None
        interactive = [r for r in rows if r["priority"] == "interactive"]
        background = [r for r in rows if r["priority"] != "interactive"]
        last = self._last_user.get(job_type, -1)
        for layer in (interactive, background):
            if layer and job_type not in self._paused_types:
                # round-robin: 各用户各取一个，从上次服务用户的下一个开始
                by_user: dict[int, list] = {}
                for r in layer:
                    by_user.setdefault(r["user_id"], []).append(r)
                users = sorted(by_user)
                if last in users:
                    users = users[users.index(last) + 1:] + users[:users.index(last) + 1]
                for uid in users:
                    self._last_user[job_type] = uid
                    return by_user[uid][0]
        return None

    def _claim(self, job_id: int, status: str = "running") -> bool:
        """原子认领：仅当仍为 queued 时置为运行态。"""
        with db.write() as c:
            cur = c.execute(
                "UPDATE jobs SET status=?, updated_at=datetime('now') "
                "WHERE id=? AND status='queued'",
                (status, job_id),
            )
            return cur.rowcount == 1

    def _update(self, job_id: int, **fields: Any) -> None:
        sets = ", ".join(f"{k}=?" for k in fields)
        with db.write() as c:
            c.execute(
                f"UPDATE jobs SET {sets}, updated_at=datetime('now') WHERE id=?",
                (*fields.values(), job_id),
            )
        row = db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if row:
            _emit(row)

    # ================= 解析 worker（GPU 串行） =================
    def _parse_loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=int(config.get("scheduler", "poll_interval_sec")))
            self._wake.clear()
            if self._stop.is_set():
                return
            # health gate
            if not mineru.healthy():
                # 所有 queued parse 任务挂起提示（只改状态不改队）
                with db.write() as c:
                    c.execute(
                        "UPDATE jobs SET status='pending_gate' "
                        "WHERE job_type='parse' AND status='queued'"
                    )
                time.sleep(15)
                continue
            # gate 恢复：pending_gate 回 queued
            with db.write() as c:
                c.execute(
                    "UPDATE jobs SET status='queued' WHERE job_type='parse' AND status='pending_gate'"
                )
            job = self._next_job("parse")
            if job is None:
                continue
            if not self._claim(job["id"]):
                continue
            try:
                self._run_parse(job)
            except Exception as e:  # noqa: BLE001
                log.exception("parse job %s 异常", job["id"])
                self._fail_or_retry(job, str(e)[:500])

    def _run_parse(self, job: Any) -> None:
        payload = json.loads(job["payload"] or "{}")
        paper_id = job["paper_id"]
        tier = payload.get("tier", "standard")
        paper = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
        if paper is None:
            self._update(job["id"], status="failed", error="论文不存在")
            return

        # 原始文件（pdf/图片/office）；URL 导入无本地文件
        url = payload.get("url")
        data = b""
        fname = f"{paper_id}.pdf"
        if not url:
            import os
            base = ingest.PAPERS_DIR / paper_id
            for f in sorted(os.listdir(base)) if base.exists() else []:
                if f.startswith("original."):
                    data = (base / f).read_bytes()
                    fname = f
                    break
            if not data:
                raise RuntimeError("原始文件缺失")

        # 幂等：有未失效远程任务则先续查；否则新建
        task_id: str | None = None
        receipt = None
        if job["remote_task_id"]:
            try:
                snapshot = mineru.poll(job["remote_task_id"])
                task_id = job["remote_task_id"]
                receipt = None
            except MinerUError as e:
                if e.code != "task_not_found":
                    raise
                task_id = None
        if task_id is None:
            run_id = payload.get("run_id") or ingest.new_parse_run(paper_id, tier)
            if run_id != payload.get("run_id"):
                payload = {**payload, "run_id": run_id}   # 同步本地，轮询后使用
                self._update(job["id"], payload=json.dumps(payload))
            if url:
                fname = Path(url.split('?')[0]).name or "doc.pdf"
                if not fname.lower().endswith(('.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx',
                                               '.ppt', '.pptx', '.xls', '.xlsx', '.html', '.txt')):
                    fname += ".pdf"   # 无已知扩展名（arxiv ID 含点也会命中）默认按 PDF
            receipt = mineru.create_task(fname,
                                         None if url else data, tier=tier, url=url)
            task_id = receipt.task_id
            self._update(job["id"], remote_task_id=task_id)
            if not url:
                mineru.upload(receipt, data)

        # 轮询到终态
        run_id = payload.get("run_id")
        while True:
            if self._stop.is_set():
                return  # SIGTERM：远程任务保留，重启后 recover 接续
            snap = mineru.poll(task_id)
            f = snap["files"][0]
            status = f["status"]
            prog = snap.get("progress", {})
            self._update(job["id"], progress_done=int(prog.get("completed", 0)),
                         progress_total=int(prog.get("total", 1)))
            if status == "completed":
                break
            if status in ("failed", "canceled"):
                err = f.get("error") or snap.get("error") or {"message": status}
                raise RuntimeError(f"MinerU {status}: {err.get('message', '')[:300]}")
            time.sleep(5)

        # 下载产物 → blocks → chunks → embed 回填入队
        files = mineru.download_zip(f["result_url"])
        ingest.save_parse_result(paper_id, run_id, files)
        middle = json.loads((files.get("middle_json.json") or b"{}").decode("utf-8", "replace"))
        n_blocks = ingest.build_blocks(paper_id, run_id, middle)
        blocks = db.all(
            "SELECT block_id, text, page_index FROM blocks WHERE parse_run_id=? "
            "ORDER BY page_index, block_index", (run_id,)
        )
        n_chunks = retrieval.build_chunks(paper_id, run_id, blocks)
        ingest.finish_parse_run(paper_id, run_id, ok=True)

        # 元数据：标题优先 doc_title；摘要走规则提取（无 LLM 成本）
        title = ingest.extract_title(middle)
        if title:
            with db.write() as c:
                c.execute("UPDATE papers SET title=? WHERE id=?", (title, paper_id))
        from .meta import extract_abstract_from_blocks
        abs_blocks = db.all("SELECT type, section_path, text FROM blocks WHERE parse_run_id=?", (run_id,))
        abstract = extract_abstract_from_blocks(abs_blocks)
        if abstract:
            with db.write() as c:
                c.execute("UPDATE papers SET abstract=? WHERE id=?", (abstract, paper_id))

        self._update(job["id"], status="done", progress_done=1, progress_total=1)
        log.info("paper %s 解析完成: %d blocks, %d chunks", paper_id, n_blocks, n_chunks)
        # embedding 回填 + 元数据自动校准/补全 入队（background）
        self.enqueue(job["user_id"], "embed_backfill", paper_id, {"run_id": run_id},
                     priority="background")
        self.enqueue(job["user_id"], "meta", paper_id, {}, priority="background")

    def _fail_or_retry(self, job: Any, error: str) -> None:
        retry_max = int(config.get("scheduler", "retry_max"))
        retries = job["retry_count"]
        if retries < retry_max and job["status"] != "failed":
            delay = min(2 ** retries * 5, 120)
            self._update(job["id"], status="queued", retry_count=retries + 1, error=error)
            log.warning("job %s 第 %d 次重试（%ds 后）: %s", job["id"], retries + 1, delay, error)
            threading.Timer(delay, self._wake.set).start()
        else:
            self._update(job["id"], status="failed", error=error)
            if job["job_type"] == "parse" and job["paper_id"]:
                ingest.finish_parse_run(job["paper_id"],
                                        json.loads(job["payload"] or "{}").get("run_id", ""),
                                        ok=False, error=error)

    # ================= embedding 回填 worker =================
    def _embed_loop(self) -> None:
        while not self._stop.is_set():
            job = self._next_job("embed_backfill")
            if job is None:
                time.sleep(5)
                continue
            if not self._claim(job["id"]):
                continue
            try:
                paper_id = job["paper_id"]
                total_rows = db.one(
                    "SELECT COUNT(*) AS n FROM chunks WHERE paper_id=? AND embedding IS NULL",
                    (paper_id,),
                )
                total = total_rows["n"] if total_rows else 0
                self._update(job["id"], progress_total=total)

                def cb(done: int, tot: int) -> None:
                    self._update(job["id"], progress_done=done, progress_total=tot)

                retrieval.backfill_embeddings(paper_id, progress_cb=cb)
                self._update(job["id"], status="done")
            except Exception as e:  # noqa: BLE001
                log.exception("embed job %s 异常", job["id"])
                self._fail_or_retry(job, str(e)[:500])

    # ================= 元数据 worker（校准→AI补空，不占GPU） =================
    def _meta_loop(self) -> None:
        while not self._stop.is_set():
            job = self._next_job("meta")
            if job is None:
                time.sleep(8)
                continue
            if not self._claim(job["id"]):
                continue
            try:
                paper_id = job["paper_id"]
                # ① 联网校准（arXiv→S2→CrossRef；无需 LLM key）
                from .meta import verify_meta_online
                try:
                    verify_meta_online(paper_id)
                except Exception as e:  # noqa: BLE001
                    log.warning("meta verify %s: %s", paper_id, e)
                # ② AI 补全缺失字段（用发起人 chat key；无 key 静默跳过）
                row = db.one("SELECT authors, journal, year, abstract, keywords FROM papers WHERE id=?",
                             (paper_id,))
                missing = row and any(not (row[k] or "").strip() for k in row.keys())
                if missing:
                    try:
                        from .meta import extract_meta_llm
                        extract_meta_llm(job["user_id"], paper_id)
                    except Exception as e:  # noqa: BLE001
                        log.info("meta AI补全 %s 跳过: %s", paper_id, str(e)[:120])
                self._update(job["id"], status="done")
            except Exception as e:  # noqa: BLE001
                log.exception("meta job %s 异常", job["id"])
                self._update(job["id"], status="failed", error=str(e)[:300])

    # ================= 翻译池（里程碑3填充处理器） =================
    translate_handler: Callable[[Any], None] | None = None

    def _translate_loop(self) -> None:
        while not self._stop.is_set():
            if self.translate_handler is None or "translate" in self._paused_types:
                time.sleep(5)
                continue
            job = self._next_job("translate")
            if job is None:
                time.sleep(5)
                continue
            per_user_limit = int(config.get("limits", "translate_concurrency"))
            if self._translate_slots.get(job["user_id"], 0) >= per_user_limit:
                time.sleep(3)
                continue
            if not self._claim(job["id"]):
                continue
            self._translate_slots[job["user_id"]] = self._translate_slots.get(job["user_id"], 0) + 1
            t = threading.Thread(target=self._run_translate, args=(job,), daemon=True)
            t.start()

    def _run_translate(self, job: Any) -> None:
        try:
            if self.translate_handler:
                self.translate_handler(job)
        except Exception as e:  # noqa: BLE001
            log.exception("translate job %s 异常", job["id"])
            self._fail_or_retry(job, str(e)[:500])
        finally:
            self._translate_slots[job["user_id"]] = max(
                0, self._translate_slots.get(job["user_id"], 1) - 1
            )
            self._wake.set()

    # ================= 管家：回收站清理 =================
    def _janitor_loop(self) -> None:
        while not self._stop.is_set():
            try:
                days = int(config.get("retention", "trash_days"))
                rows = db.all(
                    "SELECT id FROM papers WHERE deleted_at IS NOT NULL "
                    "AND deleted_at < datetime('now', ?)",
                    (f"-{days} days",),
                )
                for r in rows:
                    self.hard_delete_paper(r["id"])
            except Exception:  # noqa: BLE001
                log.exception("janitor 异常")
            time.sleep(3600)

    def hard_delete_paper(self, paper_id: str) -> None:
        """彻底删除：文件 + 级联行（FK ON DELETE CASCADE 处理表内引用）。"""
        import shutil

        d = ingest.PAPERS_DIR / paper_id
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        with db.write() as c:
            c.execute("DELETE FROM chunks_fts WHERE paper_id=?", (paper_id,))
            c.execute("DELETE FROM papers WHERE id=?", (paper_id,))

    # ---- 管理 ----
    def pause_resume(self, job_type: str, pause: bool) -> None:
        if pause:
            self._paused_types.add(job_type)
        else:
            self._paused_types.discard(job_type)
            self._wake.set()


scheduler = Scheduler()
