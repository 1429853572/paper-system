"""调用外部工具（node 渲染公式 / chrome 打印 PDF）."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

NODE_BIN = os.environ.get("NODE_BIN", "node")
CHROME_BIN = os.environ.get("CHROME_BIN", "/opt/chrome/chrome-headless-shell")
KATEX_RENDER = Path(__file__).parent.parent / "tools" / "katex_render.mjs"


def render_math(maths: list[str]) -> list[str]:
    """用 KaTeX 服务端渲染公式；失败则返回原文（不阻断导出）。"""
    if not maths:
        return []
    try:
        with tempfile.TemporaryDirectory() as td:
            inp = Path(td) / "in.json"
            out = Path(td) / "out.json"
            inp.write_text(json.dumps({"maths": maths}), encoding="utf-8")
            subprocess.run([NODE_BIN, str(KATEX_RENDER), str(inp), str(out)],
                           check=True, timeout=120, capture_output=True)
            return json.loads(out.read_text(encoding="utf-8")).get("rendered", [])
    except Exception:  # noqa: BLE001
        return maths


def html_to_pdf(html: str) -> bytes:
    from .tools.chrome_pdf import html_to_pdf as _impl
    return _impl(html)
