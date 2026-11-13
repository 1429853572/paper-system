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
    # batch_id 以列为准（summary 完成时会整体覆写 payload，JSON 里可能已丢）
    batch_id = job_row["batch_id"]
    if batch_id is None:
        try:
            batch_id = json.loads(job_row["payload"] or "{}").get("batch_id")
        except Exception:
            batch_id = None
    bus.publish({
        "job_id": job_row["id"],
        "user_id": job_row["user_id"],
        "job_type": job_row["job_type"],
        "paper_id": job_row["paper_id"],
        "batch_id": batch_id,
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
        # 全局翻译并发上限（scheduler.translate_workers；per-user 上限另由 translate_concurrency 控制）
        self._translate_sem = threading.Semaphore(int(config.get("scheduler", "translate_workers")))

    # ---- 启动 ----
    def start(self) -> None:
        self.recover()
        for name, fn in (
            ("parse-worker", self._parse_loop),
            ("embed-worker", self._embed_loop),
            ("meta-worker", self._meta_loop),
            ("translate-worker", self._translate_loop),
            ("summary-worker", self._summary_loop),
            ("synthesis-worker", self._synthesis_loop),
            ("acquire-worker", self._acquire_loop),
            ("janitor", self._janitor_loop),
            ("tracker", self._tracker_loop),
            ("table-tidy", self._table_tidy_loop),
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
            elif r["job_type"] in ("embed_backfill", "translate", "synthesis", "acquire"):
                with db.write() as c:
                    c.execute("UPDATE jobs SET status='queued' WHERE id=?", (r["id"],))

    # ---- 入队（服务层调用） ----
    def enqueue(self, user_id: int, job_type: str, paper_id: str | None,
                payload: dict, priority: str = "interactive",
                progress_total: int = 0) -> int:
        # 批量任务：payload.batch_id 同步落到列上（进度面板按列聚合，SSE 从 payload 透传）
        batch_id = payload.get("batch_id") if isinstance(payload, dict) else None
        with db.write() as c:
            cur = c.execute(
                "INSERT INTO jobs(user_id,job_type,paper_id,payload,batch_id,priority,progress_total) "
                "VALUES(?,?,?,?,?,?,?)",
                (user_id, job_type, paper_id, json.dumps(payload), batch_id, priority, progress_total),
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
            try:
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
                # gate 恢复：pending_gate 回 queued（有行才写——空闲时省一次空写事务/fsync）
                if db.one("SELECT 1 FROM jobs WHERE job_type='parse' AND status='pending_gate' LIMIT 1"):
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
            except Exception:  # noqa: BLE001 —— 瞬时锁错误/意外异常不能让 worker 静默死亡
                log.exception("parse worker 循环异常（继续运行）")
                time.sleep(5)

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
            # 进度节流：变化 <10% 且距上次 emit <15s 跳过（每 5s 一 UPDATE+SELECT+SSE 广播，
            # 89 篇批量时前端 badge 又被每个事件触发拉全量 jobs——雪上加霜）
            _new_d, _new_t = int(prog.get("completed", 0)), int(prog.get("total", 1))
            _last = getattr(self, "_last_prog", {})
            _key = (job["id"], "d")
            _last_d, _last_ts = _last.get((job["id"], "d"), -1), _last.get((job["id"], "ts"), 0.0)
            small = (_last_d >= 0 and _new_t > 0 and
                     (_new_d - _last_d) / _new_t < 0.10 and time.time() - _last_ts < 15)
            if not small:
                _last[(job["id"], "d")] = _new_d
                _last[(job["id"], "ts")] = time.time()
                self._update(job["id"], progress_done=_new_d, progress_total=_new_t)
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
        from .meta import extract_abstract_blocks
        abs_blocks = db.all("SELECT block_id, type, section_path, text FROM blocks WHERE parse_run_id=?", (run_id,))
        abstract, abs_ids = extract_abstract_blocks(abs_blocks)
        if abstract:
            with db.write() as c:
                c.execute("UPDATE papers SET abstract=?, abstract_src=? WHERE id=?",
                          (abstract, json.dumps(abs_ids), paper_id))

        self._update(job["id"], status="done", progress_done=1, progress_total=1)
        log.info("paper %s 解析完成: %d blocks, %d chunks", paper_id, n_blocks, n_chunks)
        # embedding 回填 + 元数据自动校准/补全 入队（background）
        self.enqueue(job["user_id"], "embed_backfill", paper_id, {"run_id": run_id},
                     priority="background")
        self.enqueue(job["user_id"], "meta", paper_id, {}, priority="background")

    def _fail_or_retry(self, job: Any, error: str) -> None:
        retry_max = int(config.get("scheduler", "retry_max"))
        retries = job["retry_count"]
        if "预算已用尽" in error:      # 预算闸：重试无意义（等到下月只会继续失败）
            self._update(job["id"], status="failed", error=error)
            return
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
            try:
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
            except Exception:  # noqa: BLE001
                log.exception("embed worker 循环异常（继续运行）")
                time.sleep(5)

    # ================= 元数据 worker（校准→AI补空，不占GPU） =================
    def _meta_loop(self) -> None:
        while not self._stop.is_set():
            try:
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
                        # 章节摘要（两段式问答用；失败不影响其他功能）
                        try:
                            from .summarizer import generate_section_summaries
                            n = generate_section_summaries(job["user_id"], paper_id)
                            log.info("章节摘要 %s: %d 节", paper_id, n)
                        except Exception as e:  # noqa: BLE001
                            log.info("章节摘要 %s 跳过: %s", paper_id, str(e)[:120])
                    self._update(job["id"], status="done")
                except Exception as e:  # noqa: BLE001
                    log.exception("meta job %s 异常", job["id"])
                    self._update(job["id"], status="failed", error=str(e)[:300])
            except Exception:  # noqa: BLE001
                log.exception("meta worker 循环异常（继续运行）")
                time.sleep(5)

    # ================= 翻译池（里程碑3填充处理器） =================
    translate_handler: Callable[[Any], None] | None = None

    def _translate_loop(self) -> None:
        while not self._stop.is_set():
            try:
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
                if not self._translate_sem.acquire(blocking=False):
                    time.sleep(3)
                    continue
                if not self._claim(job["id"]):
                    self._translate_sem.release()
                    continue
                self._translate_slots[job["user_id"]] = self._translate_slots.get(job["user_id"], 0) + 1
                t = threading.Thread(target=self._run_translate, args=(job,), daemon=True)
                t.start()
            except Exception:  # noqa: BLE001
                log.exception("translate worker 循环异常（继续运行）")
                time.sleep(5)

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
            self._translate_sem.release()
            self._wake.set()

    # ================= 导读 worker（LLM 同步调用，单并发） =================
    def _summary_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._next_job("summary")
                if job is None:
                    time.sleep(3)
                    continue
                if not self._claim(job["id"]):
                    continue
                try:
                    from . import summarizer
                    user = {"id": job["user_id"]}
                    sid, payload = summarizer.generate(user, job["paper_id"])
                    self._update(job["id"], status="done", progress_done=1, progress_total=1,
                                 payload=json.dumps({"summary_id": sid}, ensure_ascii=False))
                    log.info("导读生成完成 paper=%s", job["paper_id"])
                except Exception as e:  # noqa: BLE001
                    log.exception("summary job %s 异常", job["id"])
                    self._update(job["id"], status="failed", error=str(e)[:300])
            except Exception:  # noqa: BLE001
                log.exception("summary worker 循环异常（继续运行）")
                time.sleep(5)

    # ================= 综述 worker（LLM 长任务，单并发） =================
    def _synthesis_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._next_job("synthesis")
                if job is None:
                    time.sleep(3)
                    continue
                if not self._claim(job["id"]):
                    continue
                try:
                    from . import synthesis
                    payload = json.loads(job["payload"] or "{}")
                    synthesis.run({"id": job["user_id"]}, payload.get("synthesis_id"),
                                  job_update=lambda **f: self._update(job["id"], **f),
                                  topic=payload.get("topic") or "",
                                  params=payload.get("params") or {})
                    # 用户删除综述 → syntheses 行已删，SynthesisCanceled 中止：
                    # 此前 worker 无条件写回 done（假完成），且单线程被「已删任务」占住数小时
                    if db.one("SELECT 1 FROM syntheses WHERE id=?",
                              (payload.get("synthesis_id"),)) is None:
                        self._update(job["id"], status="canceled",
                                     error="综述已被用户删除，任务中止")
                        log.info("综述 %s 已删除，任务中止", payload.get("synthesis_id"))
                    else:
                        self._update(job["id"], status="done", progress_done=1, progress_total=1)
                    # 专题任务闭环：综述完成 → 专题状态置「已完成」
                    tid = payload.get("task_id")
                    if tid:
                        try:
                            from core import acqtask
                            acqtask.update(tid, status="done", error=None)
                        except Exception as e:  # noqa: BLE001
                            log.warning("专题 %s 状态更新失败: %s", tid, str(e)[:120])
                    log.info("综述完成 %s", payload.get("synthesis_id"))
                except synthesis.SynthesisCanceled:
                    self._update(job["id"], status="canceled", error="综述已被用户删除，任务中止")
                    log.info("综述取消检查点命中 %s", payload.get("synthesis_id"))
                except Exception as e:  # noqa: BLE001
                    log.exception("synthesis job %s 异常", job["id"])
                    self._update(job["id"], status="failed", error=str(e)[:300])
                    # 综述失败 → 专题回滚为 failed 并清空 synthesis_id（否则永久卡「综述中」且无法重跑）
                    try:
                        payload2 = json.loads(job["payload"] or "{}")
                        if payload2.get("task_id"):
                            from core import acqtask
                            acqtask.update(payload2["task_id"], status="failed",
                                           error=str(e)[:300], synthesis_id=None)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                log.exception("synthesis worker 循环异常（继续运行）")
                time.sleep(5)

    # ================= 采集 worker（专题下载；串行+礼貌延时+断点续传） =================
    def _acquire_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._next_job("acquire")
                if job is None:
                    time.sleep(5)
                    continue
                if not self._claim(job["id"]):
                    continue
                try:
                    self._run_acquire(job)
                except Exception as e:  # noqa: BLE001
                    log.exception("acquire job %s 异常", job["id"])
                    self._update(job["id"], status="failed", error=str(e)[:300])
                    try:   # 专题状态一并回滚（否则永远显示「下载中」并被前端轮询）
                        from core import acqtask
                        payload = json.loads(job["payload"] or "{}")
                        if payload.get("task_id"):
                            acqtask.update(payload["task_id"], status="failed",
                                           error=str(e)[:300])
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                log.exception("acquire worker 循环异常（继续运行）")
                time.sleep(5)

    def _run_acquire(self, job: Any) -> None:
        """逐篇下载勾选候选 → 入库 → 解析入队。

        知网/出版方有风控：串行 + 每篇随机延时 1.5~3s + 失败退避重试（最多 3 次），
        省掉这步会被限 IP/账号，反而拿不到文献。
        """
        import random
        import time as _t

        from core import acqtask, acquire, ingest

        payload = json.loads(job["payload"] or "{}")
        tid = payload.get("task_id") or ""
        batch_id = payload.get("batch_id") or ""
        task = acqtask.get(tid)
        if task is None:
            self._update(job["id"], status="done")
            return
        todo = [c for c in (task.get("candidates") or [])
                if c.get("selected") and c.get("dl_status") != "done"]
        total = max(1, len(todo))
        done = 0
        for c in todo:
            if self._stop.is_set():
                return
            url = c.get("pdf_url") or ""
            title = c.get("title") or "未命名"
            if not url:
                acqtask.mark_candidate(tid, url, dl_status="skipped", error="无下载链接")
                continue
            data = None
            err = ""
            for attempt in range(3):
                try:
                    data, _ct, fname = acquire.fetch(url)
                    if data:
                        break
                    err = "下载内容为空"
                except ValueError as e:
                    err = str(e)[:150]
                _t.sleep(2 ** attempt * 3)          # 退避：3s / 6s / 12s
            if not data:
                acqtask.mark_candidate(tid, url, dl_status="failed", error=err or "下载失败")
                done += 1
                self._update(job["id"], progress_done=done, progress_total=total)
                continue
            # 非 PDF（CAJ 等）→ 尝试转换
            if data[:5] != b"%PDF-":
                from core import caj as caj_mod
                try:
                    data = caj_mod.convert_bytes(data, fname or "paper.pdf")
                except caj_mod.ConvertError as e:
                    acqtask.mark_candidate(tid, url, dl_status="failed",
                                           error=f"非 PDF 且转换失败: {str(e)[:110]}")
                    done += 1
                    self._update(job["id"], progress_done=done, progress_total=total)
                    continue
            try:
                pages, _k = ingest.preflight_doc(data, fname or "paper.pdf",
                                                 is_admin=True, overrides={})
            except Exception as e:  # noqa: BLE001
                acqtask.mark_candidate(tid, url, dl_status="failed", error=str(e)[:120])
                done += 1
                self._update(job["id"], progress_done=done, progress_total=total)
                continue
            fh = ingest.sha256_bytes(data)
            paper_id, dup = ingest.create_paper(job["user_id"], fh, pages, len(data),
                                                "shared", fname or "paper.pdf")
            if dup:
                # 已在库的同内容论文：仅当**本人可见**时才计入本专题，
                # 否则会把别人的私有论文挂进我的专题并写进综述报告。
                visible = db.one("SELECT id FROM papers WHERE id=? AND deleted_at IS NULL "
                                 "AND (visibility='shared' OR owner_id=?)",
                                 (paper_id, job["user_id"]))
                acqtask.mark_candidate(tid, url, dl_status="done",
                                       paper_id=paper_id if visible else None,
                                       error=None if visible else "内容与库中他人私有文献重复，未计入")
                if visible:
                    acqtask.attach_papers(tid, [paper_id])
                    ingest.attach_to_collection(paper_id, ingest.default_collection(job["user_id"]))
                done += 1
                self._update(job["id"], progress_done=done, progress_total=total)
                continue
            with db.write() as c2:
                c2.execute("UPDATE papers SET title=COALESCE(NULLIF(title,''),?) WHERE id=?",
                           (title, paper_id))
                c2.execute("UPDATE papers SET acq_task_id=? WHERE id=?", (tid, paper_id))
                c2.execute("UPDATE papers SET meta_source=COALESCE(meta_source,'acquire') WHERE id=?",
                           (paper_id,))
                for col, val in (("authors", c.get("authors")), ("year", c.get("year")),
                                 ("abstract", c.get("summary")), ("doi", c.get("doi"))):
                    if val:
                        c2.execute(f"UPDATE papers SET {col}=? WHERE id=?", (str(val)[:3000], paper_id))
            ingest.store_pdf(paper_id, data, "original.pdf")
            # 挂进用户默认分库（与 /api/acquire/import、MCP acquire_cnki 同口径；
            # 此前漏挂 → 专题下载的论文全部落「未分库」）
            ingest.attach_to_collection(paper_id, ingest.default_collection(job["user_id"]))
            self.enqueue(job["user_id"], "parse", paper_id,
                          {"tier": "standard", "original_name": fname or "paper.pdf",
                           "source_url": url, "batch_id": batch_id},
                          priority="background")
            acqtask.mark_candidate(tid, url, dl_status="done", paper_id=paper_id, error=None)
            acqtask.attach_papers(tid, [paper_id])
            done += 1
            self._update(job["id"], progress_done=done, progress_total=total)
            _t.sleep(1.5 + random.random() * 1.5)   # 礼貌间隔
        # 收尾：有成功入库才置「已入库」；全失败则置失败（否则显示「已入库 0 篇」）
        papers = acqtask.get(tid).get("paper_ids") or []
        if papers:
            acqtask.update(tid, status="ingested", error=None)
        else:
            acqtask.update(tid, status="failed", error="没有成功下载的文献")
        self._update(job["id"], status="done", progress_done=total, progress_total=total)

    # ================= 管家：回收站清理 + 每日备份 =================
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
                self._daily_backup()
            except Exception:  # noqa: BLE001
                log.exception("janitor 异常")
            time.sleep(3600)

    # ================= 表格整理 worker（LLM 同步调用，单并发，批内逐表） =================
    @staticmethod
    def _chunked(ids: list, size: int = 500) -> list[list]:
        return [ids[i:i + size] for i in range(0, len(ids), size)]

    def _revert_tidy_state(self, user_id: int, ids: list) -> None:
        """批量收工：未处理到的 queued/running 回到 none（待整理——「继续整理」可再圈）。"""
        for chunk in self._chunked(ids):
            marks = ",".join("?" * len(chunk))
            with db.write() as c:
                c.execute(f"UPDATE table_extracts SET ai_status='none' WHERE user_id=? "
                          f"AND id IN ({marks}) AND ai_status IN ('queued','running')",
                          (user_id, *chunk))

    def _table_tidy_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._next_job("table_tidy")
                if job is None:
                    time.sleep(3)
                    continue
                if not self._claim(job["id"]):
                    continue
                self._run_table_tidy(job)
            except Exception:  # noqa: BLE001
                log.exception("table_tidy worker 异常")
                time.sleep(3)

    def _run_table_tidy(self, job: Any) -> None:
        """一个 job = 一批表（payload.ids）。逐表 LLM 整理：
        预算尽/无 key → 剩余回「待整理」提前收工（job 不算失败）；单表异常隔离。"""
        from . import tables as tables_mod
        from .costing import BudgetExceeded
        from .llm import NoKeyError
        ids = (json.loads(job["payload"] or "{}").get("ids") or [])
        uid = job["user_id"]
        total, done = len(ids), 0
        self._update(job["id"], status="running", progress_total=total, progress_done=0)
        for chunk in self._chunked(ids):
            marks = ",".join("?" * len(chunk))
            with db.write() as c:
                c.execute(f"UPDATE table_extracts SET ai_status='queued', updated_at=datetime('now') "
                          f"WHERE user_id=? AND id IN ({marks})", (uid, *chunk))
        no_key = budget_stop = False
        for tid in ids:
            te = db.one("SELECT * FROM table_extracts WHERE id=? AND user_id=?", (tid, uid))
            if te is None or te["review"] == "deleted" or te["ai_status"] == "done":
                done += 1
                continue
            with db.write() as c:
                c.execute("UPDATE table_extracts SET ai_status='running' WHERE id=?", (tid,))
            try:
                r = tables_mod.tidy_one(uid, te)
                with db.write() as c:
                    c.execute("UPDATE table_extracts SET ai_cells=?, ai_note=?, ai_status=?, "
                              "updated_at=datetime('now') WHERE id=?",
                              (r["ai_cells"], r["ai_note"], r["ai_status"], tid))
            except NoKeyError:
                no_key = True
                break
            except BudgetExceeded:
                budget_stop = True
                break
            except Exception as e:  # noqa: BLE001 —— 单表失败不拖垮整批
                with db.write() as c:
                    c.execute("UPDATE table_extracts SET ai_status='failed', ai_note=? WHERE id=?",
                              (str(e)[:200], tid))
            done += 1
            self._update(job["id"], progress_done=done)
        self._revert_tidy_state(uid, ids)
        if no_key:
            self._update(job["id"], status="failed", progress_done=done,
                         error="未配置 LLM key——AI 整理需要可用模型（设置页配置或联系管理员）")
        else:
            self._update(job["id"], status="done", progress_done=done,
                         error=("预算已用尽——剩余表保持待整理，可稍后「继续整理」" if budget_stop else None))
        bus.publish({"type": "data", "entity": "tables", "user_id": None})

    def _tracker_loop(self) -> None:
        """文献追踪巡逻：30 分钟醒一次，跑所有到期的订阅；有新条目则 SSE 广播。"""
        while not self._stop.is_set():
            try:
                from . import tracker, tracker_mail   # 延迟导入：避开 jobs↔tracker 环
                res = tracker.run_due(email_fn=tracker_mail.send_digest)
                if any(r.get("new") for r in res):
                    bus.publish({"type": "data", "entity": "tracker", "user_id": None})
            except Exception:  # noqa: BLE001
                log.exception("tracker 巡逻异常")
            time.sleep(1800)

    def _daily_backup(self) -> None:
        """每日自动备份：DB 快照（VACUUM INTO）+ papers/ 文件目录打包；按 backup_keep 轮转."""
        import shutil

        from .config import DATA_DIR

        today = time.strftime("%Y-%m-%d")
        bdir = DATA_DIR / "backups"
        bdir.mkdir(parents=True, exist_ok=True)
        done = (bdir / f"db-{today}.db").exists() and (bdir / f"papers-{today}.tar.gz").exists()
        if done:
            return
        if not (bdir / f"db-{today}.db").exists():
            db.backup_to(bdir / f"db-{today}.db")
        papers_dir = DATA_DIR / "papers"
        papers_tar = bdir / f"papers-{today}.tar.gz"
        if papers_dir.is_dir() and not papers_tar.exists():
            # papers/ 文件目录与 DB 必须配套备份——只有 DB 快照无法复原。
            # 归档布局与 backup.sh 一致（data/papers/…，仓库根解包即到位）——
            # 此前 root_dir=DATA_DIR+base_dir=papers 产出 papers/… 布局，
            # restore.sh 恢复这份会解错位置（数据没丢但没恢复到位）。
            shutil.make_archive(str(papers_tar)[:-7], "gztar",
                                root_dir=DATA_DIR.parent, base_dir="data/papers")
        # 清单 + 哈希：恢复时先验完整性，而不是只看"备份成功"
        import hashlib
        import json
        manifest = {"created": today, "files": {}}
        for f in [bdir / f"db-{today}.db", bdir / f"papers-{today}.tar.gz"]:
            if f.exists():
                manifest["files"][f.name] = {
                    "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                    "size": f.stat().st_size}
        (bdir / f"manifest-{today}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        keep = int(config.get("retention", "backup_keep"))
        # 轮转覆盖全部备份形态（db/papers/审计快照），按日期名排序
        for pattern in ("db-*.db", "papers-*.tar.gz", "pre-audit-*.db", "manifest-*.json"):
            backups = sorted(bdir.glob(pattern))
            for old in backups[:-keep]:
                try:
                    old.unlink()
                    log.info("轮转删除过期备份 %s", old.name)
                except OSError:
                    pass
        log.info("每日备份完成: db/papers 各保留 %d 份", keep)

    def hard_delete_paper(self, paper_id: str) -> None:
        """彻底删除：文件 + 级联行（FK CASCADE 之外的无外键表显式清理）。"""
        import shutil

        d = ingest.PAPERS_DIR / paper_id
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        with db.write() as c:
            # chunks_fts 的 paper_id 是 UNINDEXED 列——直接 DELETE WHERE paper_id 是
            # 全 FTS 扫（janitor/hard_delete 持写锁时间随库规模恶化）→ 先取 rowid 按行删
            from .retrieval import clear_fts_by_paper
            clear_fts_by_paper(c, paper_id)
            c.execute("DELETE FROM llm_calls WHERE paper_id=?", (paper_id,))
            # 无外键的两张表：孤儿行会永久泄漏并污染统计
            c.execute("DELETE FROM section_summaries WHERE paper_id=?", (paper_id,))
            c.execute("DELETE FROM jobs WHERE paper_id=?", (paper_id,))
            c.execute("DELETE FROM papers WHERE id=?", (paper_id,))
        from .retrieval import invalidate_vec_cache
        invalidate_vec_cache()

    # ---- 管理 ----
    def pause_resume(self, job_type: str, pause: bool) -> None:
        if pause:
            self._paused_types.add(job_type)
        else:
            self._paused_types.discard(job_type)
            self._wake.set()


scheduler = Scheduler()
