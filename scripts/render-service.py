#!/usr/bin/env python3
"""宿主 PDF 渲染服务（HTML → PDF，用宿主 google-chrome 打印）。

app 容器通过 HTTP 调用本服务渲染 PDF（容器内不装 Chrome，避免 1GB 镜像与慢构建）。
启动: python3 scripts/render-service.py --port 8801
接口: POST /render  {"html": "<...>"} → application/pdf
鉴权: 设置了 PAPERSYS_RENDER_TOKEN（.env，经 systemd EnvironmentFile 注入）时，
      POST /render 必须带同值 X-Render-Token 头——否则局域网内任何人可让宿主
      Chrome 渲染任意 HTML（SSRF/内网探测跳板）。未设置时保持无鉴权（向后兼容）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CHROME = "/usr/bin/google-chrome"
RENDER_TOKEN = ""   # main() 里赋值


def render_pdf(html: str, timeout: int = 90) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.html"
        out = Path(td) / "out.pdf"
        src.write_text(html, encoding="utf-8")
        proc = subprocess.run(
            [CHROME, "--headless", "--no-sandbox", "--disable-gpu",
             "--disable-dev-shm-usage", "--no-pdf-header-footer",
             "--run-all-compositor-stages-before-draw", "--virtual-time-budget=10000",
             f"--print-to-pdf={out}", src.as_uri()],
            capture_output=True, timeout=timeout)
        if not out.exists() or out.stat().st_size < 500:
            raise RuntimeError(f"chrome 渲染失败: {proc.stderr.decode()[:300]}")
        return out.read_bytes()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        if self.path != "/render":
            return self._send(404, b"not found", "text/plain")
        if RENDER_TOKEN and self.headers.get("X-Render-Token") != RENDER_TOKEN:
            return self._send(403, b"forbidden", "text/plain")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n) or b"{}")
            pdf = render_pdf(data.get("html", ""))
            self._send(200, pdf, "application/pdf")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def log_message(self, fmt, *args):  # 静默
        pass


def main():
    global RENDER_TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--token", default="")   # 缺省读 PAPERSYS_RENDER_TOKEN
    args = ap.parse_args()
    RENDER_TOKEN = args.token or os.environ.get("PAPERSYS_RENDER_TOKEN", "")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"render-service 监听 {args.host}:{args.port}（POST /render，"
          f"鉴权{'开' if RENDER_TOKEN else '关'}）", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
