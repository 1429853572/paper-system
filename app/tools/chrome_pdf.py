"""HTML → PDF：调用容器内 chrome-headless-shell 打印."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

CHROME = os.environ.get("CHROME_BIN", "/opt/chrome/chrome-headless-shell")


async def _print(html: str, out_pdf: Path) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html)
        src = Path(f.name)
    cmd = [
        CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=8000",
        f"--print-to-pdf={out_pdf}", src.as_uri(),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()
    src.unlink(missing_ok=True)
    if not out_pdf.exists() or out_pdf.stat().st_size < 500:
        raise RuntimeError("PDF 生成失败")


def html_to_pdf(html: str) -> bytes:
    """同步接口：返回 PDF 字节。"""
    if not os.path.exists(CHROME):
        raise RuntimeError("chrome-headless-shell 未安装")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.pdf"
        asyncio.run(_print(html, out))
        return out.read_bytes()
