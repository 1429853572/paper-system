"""MinerU V1 Tasks API 客户端.

契约来源: MinerU 4.1 docs/en/usage/tasks.md（锁定实测）
- POST /v1/tasks          → 202 {task_id, files:[{file_id, upload:{url,headers}}]}
- PUT upload.url          → 原始字节直传
- GET /v1/tasks/{id}      → {status, progress{completed,failed,total}, files:[{status,result_url?,error?}]}
- GET result_url          → ZIP 二进制 (markdown.md + middle_json.json + structured_content.json + images/)
- POST /v1/tasks/{id}/cancel

要点（恢复语义）:
- 服务端任务记录仅存内存——容器重启后 task_id 失效（轮询 404）
- 上传链接 3600s 过期；不要重复成功 PUT；丢失响应后先查状态再决定动作
"""
from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .config import MINERU_BASE_URL


class MinerUError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.status = status


@dataclass
class TaskReceipt:
    task_id: str
    file_id: str
    upload_url: str | None
    upload_headers: dict[str, str]


class MinerUClient:
    def __init__(self, base_url: str = MINERU_BASE_URL, timeout: float = 60.0):
        self.base = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)

    # ---- health gate ----
    def healthy(self) -> bool:
        try:
            r = self._client.get(f"{self.base}/v1/health", timeout=10)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    # ---- 创建任务（单文件） ----
    def create_task(self, file_name: str, file_bytes: bytes, tier: str = "standard") -> TaskReceipt:
        sha = hashlib.sha256(file_bytes).hexdigest()
        r = self._client.post(
            f"{self.base}/v1/tasks",
            json={
                "files": [{"file_name": Path(file_name).name, "bytes": len(file_bytes), "sha256sum": sha}],
                "tier": tier,
                "output_formats": ["default"],
            },
        )
        if r.status_code != 202:
            self._raise(r)
        d = r.json()
        f = d["files"][0]
        upload = f.get("upload") or {}
        return TaskReceipt(
            task_id=d["task_id"],
            file_id=f["file_id"],
            upload_url=upload.get("url"),
            upload_headers=upload.get("headers") or {},
        )

    # ---- 上传（PUT 原始字节；成功后不再重复） ----
    def upload(self, receipt: TaskReceipt, file_bytes: bytes) -> None:
        if not receipt.upload_url:
            return
        r = self._client.put(
            receipt.upload_url,
            content=file_bytes,
            headers={**receipt.upload_headers, "Content-Type": "application/octet-stream"},
        )
        if r.status_code not in (200, 201, 202):
            self._raise(r)

    # ---- 轮询状态 ----
    def poll(self, task_id: str) -> dict[str, Any]:
        """返回完整 task 快照；404 时抛 MinerUError('task_not_found')（服务端重启导致）。"""
        r = self._client.get(f"{self.base}/v1/tasks/{task_id}")
        if r.status_code == 404:
            raise MinerUError("task_not_found", "远程任务已失效（服务端重启）", 404)
        if r.status_code != 200:
            self._raise(r)
        return r.json()

    # ---- 取消 ----
    def cancel(self, task_id: str) -> None:
        try:
            self._client.post(f"{self.base}/v1/tasks/{task_id}/cancel")
        except httpx.HTTPError:
            pass  # 尽力取消

    # ---- 下载结果 ZIP 并安全解包 ----
    def download_zip(self, result_url: str) -> dict[str, bytes]:
        """返回 {相对路径: 内容}；防 zip-slip——只接受无 ../ 前缀的常规文件。"""
        r = self._client.get(result_url, timeout=600)
        if r.status_code != 200:
            self._raise(r)
        files: dict[str, bytes] = {}
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = info.filename
                p = Path(name)
                if p.is_absolute() or ".." in p.parts:
                    continue  # 路径穿越防护
                files[name] = zf.read(info)
        return files

    def _raise(self, r: httpx.Response) -> None:
        try:
            err = r.json().get("error", {})
            raise MinerUError(err.get("code", "unknown"), err.get("message", r.text[:200]), r.status_code)
        except (ValueError, KeyError):
            raise MinerUError("http_error", f"HTTP {r.status_code}: {r.text[:200]}", r.status_code)


mineru = MinerUClient()
