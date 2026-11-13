#!/usr/bin/env python3
"""宿主浏览器采集服务（中文文献获取）。

为什么在宿主跑：知网/chinaxiv/期刊官网普遍软封（403「系统正在维护中」、
滑块验证码、CAJ 私有格式），纯 HTTP 拿不到；真实浏览器 + 人工过一次验证码
+ Cookie 复用是唯一可行路径。容器内不装 Chromium（避免 1GB 镜像与慢构建），
与 render-service.py 完全同构。

启动: python3 scripts/acquire-service.py --port 8802
接口（均需 X-Acquire-Token 头，与 render-service 同款鉴权）：
  POST /search   {"site":"cnki|chinaxiv|nstl", "query":"...", "page":1, "limit":20}
                → {"results":[{"title","authors","year","venue","doi","url","pdf_url","summary"}]}
  POST /fetch    {"url":"https://..."}          → 下载任意 URL（走浏览器会话，带 Cookie）
                → {"content_base64","content_type","filename"}
  GET  /status                           → {"browser":true,"playwright":true,"cookie":bool}
鉴权：设置 PAPERSYS_ACQUIRE_TOKEN（.env，经 systemd EnvironmentFile 注入）时，
      请求必须带同值 X-Acquire-Token 头——否则局域网内任何人可驱动宿主浏览器
      访问任意站点（SSRF/内网探测跳板）。未设置时保持无鉴权（向后兼容）。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ACQUIRE_TOKEN = ""
CHROME = "/usr/bin/google-chrome"
STATE_FILE = os.path.expanduser("~/.cnki_acquire_state.json")

# Playwright 的同步 API 只能在创建它的线程里用。本服务用「单线程 HTTPServer +
# 常驻浏览器」：请求串行处理（采集是低频重活，串行足够），浏览器只启动一次，
# 登录态靠 Cookie 持久化（STATE_FILE）跨进程复用。
# （早期版本用 ThreadingHTTPServer + 每请求建浏览器：Playwright 的 greenlet
#   事件循环在请求线程结束时被销毁，会连带静默杀掉整个服务进程。）
_lock = threading.Lock()   # 防御性：保证同一时刻只有一个浏览器操作
_pw = None                 # playwright 实例
_browser = None            # 常驻浏览器
_context = None            # 常驻上下文（Cookie 复用）


# 允许下载的域名白名单（防 SSRF：浏览器能带宿主身份访问内网/任意站，必须限源）
ALLOWED_HOSTS = [
    h.strip().lower() for h in
    (os.environ.get("CNKI_ALLOWED_HOSTS") or
     "chinaxiv.org,kns.cnki.net,www.cnki.net,cnki.net,navi.cnki.net,"
     "arxiv.org,export.arxiv.org,doi.org,dx.doi.org,*.cnki.net").split(",")
    if h.strip()
]


def _host_allowed(host: str) -> bool:
    host = (host or "").split(":")[0].lower()
    for pat in ALLOWED_HOSTS:
        p = pat.lower()
        if p.startswith("*."):
            if host == p[2:] or host.endswith(p[1:]):
                return True
        elif host == p:
            return True
    return False


def _playwright():
    """返回（必要时启动）playwright 实例。"""
    global _pw
    if _pw is None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError("宿主未安装 playwright：pip install playwright") from e
        _pw = sync_playwright().start()
    return _pw


def _browser_ctx(pw, headless: bool = True):
    """返回（必要时创建）常驻浏览器上下文：复用已保存 Cookie。"""
    global _browser, _context
    if _context is not None:
        return _browser, _context
    # 复用系统已装的 Chrome，不必让 playwright 再下 300MB Chromium
    launch = {"headless": headless, "args": ["--no-sandbox", "--disable-dev-shm-usage",
                                           "--disable-blink-features=AutomationControlled"]}
    if os.path.exists(CHROME):
        launch["executable_path"] = CHROME
    _browser = pw.chromium.launch(**launch)
    _context = _browser.new_context(
        user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
        locale="zh-CN",
        accept_downloads=True,
    )
    if os.path.exists(STATE_FILE):
        try:
            _context.add_cookies(json.load(open(STATE_FILE, encoding="utf-8")))
        except Exception:  # noqa: BLE001
            pass
    return _browser, _context


def save_state(ctx) -> None:
    try:
        json.dump(ctx.cookies(), open(STATE_FILE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:  # noqa: BLE001
        pass


# ---------------- 各站点的检索/解析 ----------------

def _search_chinaxiv(ctx, query: str, page: int, limit: int) -> list[dict]:
    """中国科学院科技论文预印本平台（chinaxiv）：中文预印本免费全文 + BibTeX。"""
    url = "https://chinaxiv.org/user/search.htm?" + urllib.parse.urlencode(
        {"search": query, "page": page})
    pg = ctx.new_page()
    pg.goto(url, wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(1500)
    # 用 DOM 抽取（正则对中文期刊页的层级太脆）：标题/分类/提交时间/作者/摘要
    items = pg.evaluate(
        """(limit) => {
      const out = [];
      for (const li of document.querySelectorAll('li')) {
        const h3 = li.querySelector('h3');
        const absA = h3 && h3.querySelector('a');
        const dlA = li.querySelector('a[href*="download.htm"]');
        if (!absA || !dlA) continue;
        const abs = absA.getAttribute('href');
        const uuid = (dlA.getAttribute('href') || '').match(/uuid=([0-9a-f]+)/);
        if (!uuid) continue;
        const full = li.innerText || '';
        // 按行取（知网预印本页是「标签：值」逐行结构，正则跨行易错）
        const lines = full.split('\\n').map(s => s.trim()).filter(Boolean);
        const after = (label) => {
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l.startsWith(label)) {
              const inline = l.slice(label.length).replace(/^\\s*[:：]\\s*/, '').trim();
              if (inline) return inline;
              return (lines[i + 1] || '').trim();
            }
          }
          return '';
        };
        // 作者：页面用 <span class="name"> 承载（无标签文本）
        const nameEl = li.querySelector('span.name, .name');
        const authors = nameEl ? (nameEl.innerText || '').replace(/\s+/g, ' ').trim() : after('作者');
        const summary = after('摘要');
        const cat = after('分类');
        const tm = full.match(/提交时间\\s*[:：]?\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
        out.push({title: (absA.textContent || '').trim(),
                  abs_url: 'https://chinaxiv.org' + abs,
                  pdf_url: 'https://chinaxiv.org/user/download.htm?uuid=' + uuid[1],
                  bib_url: 'https://chinaxiv.org/user/download.htm?uuid=' + uuid[1] + '&filetype=bib',
                  authors: authors, summary: summary, category: cat,
                  year: tm ? tm[1].slice(0, 4) : '',
                  venue: 'ChinaXiv 预印本', source: 'chinaxiv', doi: ''});
        if (out.length >= limit) break;
      }
      return out;
    }""", limit)
    pg.close()
    return items


_cnki_slider_streak = 0          # 连续被滑块拦截次数（≥2 视为 cookie 失效）


def _drag_slider(pg) -> bool:
    """检测并拟人化拖动知网滑块（尽力而为）：先快后慢 + 微抖 + 轻微过冲。
    成功返回 True（页面已过验证）；检测不到滑块或拖动失败返回 False。"""
    import random
    handle = pg.query_selector("#nc_1_n1z, .nc_iconfont.btn_slide, span.btn_slide, [id*='nc_1'][style*='block'] .btn")
    if not handle:
        # 兜底：页面上任何可见的滑块状小按钮
        for cand in pg.query_selector_all("span[class*='slide'], div[class*='slide']"):
            bb = cand.bounding_box()
            if bb and 30 <= bb["width"] <= 80 and 10 <= bb["height"] <= 60:
                handle = cand
                break
    if not handle:
        return False
    hb = handle.bounding_box()
    if not hb:
        return False
    # 滑轨宽度：取父容器，无则按窗口宽估算
    track_w = 300
    pel = handle.evaluate_handle("el => el.parentElement").as_element()
    try:
        pb = pel.bounding_box() if pel else None
        if pb and pb["width"] > hb["width"] * 1.5:
            track_w = pb["width"]
    except Exception:
        pass
    x = hb["x"] + hb["width"] / 2
    y = hb["y"] + hb["height"] / 2
    total = track_w - hb["width"] * 0.4 + random.uniform(15, 30)   # 轻微过冲
    pg.mouse.move(x, y)
    pg.wait_for_timeout(random.randint(180, 420))                   # 按下前的“犹豫”
    pg.mouse.down()
    moved = 0.0
    while moved < total:
        remain = total - moved
        step = min(remain, random.uniform(4, 16) * (0.55 if moved > total * 0.75 else 1.0))
        moved += step
        pg.mouse.move(x + moved, y + random.uniform(-1.5, 1.5), steps=1)
        pg.wait_for_timeout(random.randint(6, 22))
    pg.wait_for_timeout(random.randint(80, 220))                    # 过冲后的停顿
    pg.mouse.move(x + total - random.uniform(8, 18), y, steps=4)    # 回落到轨内
    pg.wait_for_timeout(300)
    pg.mouse.up()
    pg.wait_for_timeout(1800)
    return True


def _search_cnki(ctx, query: str, page: int, limit: int) -> list[dict]:
    """知网 kns8s 检索（浏览器会话，Cookie 复用；滑块出现时先尝试拟人化拖动，
    两次未过则抛错交人工——有头模式人工过一次后 Cookie 继续复用）。

    仅做「列表页解析」；下载走 dbname+filename 直链模式（与 jasminum 同思路）。
    """
    global _cnki_slider_streak
    url = "https://kns.cnki.net/kns8s/defaultresult/index?" + urllib.parse.urlencode(
        {"kw": query, "korder": "TI", "page": page})
    for attempt in (1, 2):
        pg = ctx.new_page()
        try:
            pg.goto(url, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_timeout(2500)
            html = pg.content()
            if "验证码" not in html and "滑块" not in html:
                _cnki_slider_streak = 0
                break
            # 滑块挑战：先尝试拟人化拖动（尽力而为——知网升级验证则必失效）
            try:
                dragged = _drag_slider(pg)
            except Exception:
                dragged = False
            if dragged:
                pg.wait_for_timeout(1800)
                html = pg.content()
                if "验证码" not in html and "滑块" not in html:
                    _cnki_slider_streak = 0
                    save_state(ctx)
                    break
            if attempt == 1:
                time.sleep(2)                  # 换页重试一次
                continue
            _cnki_slider_streak += 1
            save_state(ctx)
            if _cnki_slider_streak >= 2:
                _cnki_slider_streak = 0
                try:
                    os.remove(STATE_FILE)      # 连续两次被拦：cookie 大概率已失效
                except OSError:
                    pass
            raise RuntimeError("知网滑块验证未通过（自动拖动失败）——请在有头模式人工完成一次验证，"
                               "完成后 Cookie 会自动复用；稍后再试")
        finally:
            pg.close()                         # 所有路径都关页（break/continue/raise）
    out = []
    for m in re.finditer(
            r'<a class="fz14" href="[^"]*?dbcode=([A-Z]+)&filename=([0-9A-Za-z_\-]+)"[^>]*>(.*?)</a>',
            html, re.S):
        dbcode, filename, title = m.group(1), m.group(2), re.sub(r"<[^>]+>", "", m.group(3))
        title = title.strip()
        if not title:
            continue
        out.append({"title": title, "dbcode": dbcode, "filename": filename,
                    "pdf_url": (f"https://kns.cnki.net/KXReader/Detail?dbcode={dbcode}"
                                f"&filename={filename}&uid=&p=&cflag=overlay"),
                    "source": "cnki"})
        if len(out) >= limit:
            break
    pg.close()
    return out


SEARCHERS = {"chinaxiv": _search_chinaxiv, "cnki": _search_cnki}


def do_search(site: str, query: str, page: int, limit: int) -> list[dict]:
    fn = SEARCHERS.get(site)
    if fn is None:
        raise ValueError(f"不支持的站点: {site}（可用: {', '.join(SEARCHERS)}）")
    with _lock:
        pw = _playwright()
        _browser, ctx = _browser_ctx(pw)
        return fn(ctx, query, page, limit)


def do_fetch(url: str, timeout: int = 90) -> tuple[bytes, str, str]:
    """经浏览器会话下载 URL（带 Cookie / 反爬头），返回 (内容, content_type, 文件名)。

    只允许白名单域名——浏览器带着宿主身份访问任意 URL 是 SSRF/内网探测跳板。
    """
    if not url.startswith(("http://", "https://")):
        raise ValueError("仅支持 http/https URL")
    if any(ch in url for ch in ("\\", "@", " ", "\t", "\n")):
        raise ValueError("URL 含非法字符（\ @ 空白）")
    host = urllib.parse.urlparse(url).hostname or ""
    if not _host_allowed(host):
        raise ValueError(f"域名不在白名单内（拒绝访问 {host}）")
    with _lock:
        pw = _playwright()
        _browser, ctx = _browser_ctx(pw)
        pg = ctx.new_page()
        try:
            # ①页面内 fetch：带完整浏览器指纹 + Cookie，是唯一能过软封的路径
            #   （ctx.request 无指纹 → 403；页面导航会触发下载事件 → goto 抛错）
            origin = urllib.parse.urlparse(url)
            try:
                pg.goto(origin.scheme + "://" + origin.netloc + "/", wait_until="domcontentloaded",
                        timeout=timeout * 1000)
                res = pg.evaluate(
                    """async (u) => {
                      const r = await fetch(u, {credentials: 'include'});
                      const buf = await r.arrayBuffer();
                      const u8 = new Uint8Array(buf);
                      let bin = '';
                      const CH = 0x8000;
                      for (let i = 0; i < u8.length; i += CH)
                        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
                      return {status: r.status, ct: r.headers.get('content-type') || '',
                              len: u8.length, b64: btoa(bin)};
                    }""", url)
                if res and res.get("status") == 200 and res.get("len"):
                    data = base64.b64decode(res["b64"])
                    name = os.path.basename(origin.path) or "download.bin"
                    if "uuid" in (origin.query or ""):
                        name = "download.pdf"
                    return data, res.get("ct") or "application/octet-stream", name
            except Exception as e:  # noqa: BLE001 —— 回退到导航下载
                log_msg = f"[acquire] 页面 fetch 失败，回退导航: {str(e)[:120]}"
                print(log_msg, flush=True)
            # ②回退：导航下载事件
            with pg.expect_download(timeout=timeout * 1000) as dl_info:
                pg.goto(url, wait_until="commit", timeout=timeout * 1000)
            path = dl_info.value.path()
            data = Path(path).read_bytes()
            name = dl_info.value.suggested_filename or os.path.basename(path)
            return data, "application/pdf", name
        finally:
            pg.close()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        if ACQUIRE_TOKEN and self.headers.get("X-Acquire-Token") != ACQUIRE_TOKEN:
            self._send(401, json.dumps({"error": "invalid token"}).encode(), "application/json")
            return False
        return True

    def do_POST(self):  # noqa: N802
        if not self._auth():
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/search":
                res = do_search(req.get("site") or "chinaxiv", req.get("query") or "",
                                int(req.get("page") or 1), int(req.get("limit") or 20))
                out = json.dumps({"results": res}, ensure_ascii=False).encode()
                self._send(200, out, "application/json; charset=utf-8")
                return
            if self.path == "/fetch":
                data, ctype, name = do_fetch(req.get("url") or "")
                out = json.dumps({"content_base64": base64.b64encode(data).decode(),
                                  "content_type": ctype, "filename": name}).encode()
                self._send(200, out, "application/json; charset=utf-8")
                return
            self._send(404, json.dumps({"error": "not found"}).encode(), "application/json")
        except Exception as e:  # noqa: BLE001
            self._send(502, json.dumps({"error": str(e)[:400]}).encode(),
                        "application/json; charset=utf-8")

    def do_GET(self):  # noqa: N802
        if self.path == "/status":
            has_cookie = os.path.exists(STATE_FILE)
            out = json.dumps({"browser": os.path.exists(CHROME),
                              "playwright": _playwright_ok(),
                              "cookie_state": has_cookie,
                              "cnki_slider_streak": _cnki_slider_streak,
                              "sites": list(SEARCHERS)}).encode()
            self._send(200, out, "application/json; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def log_message(self, fmt, *args):  # 降噪
        print("[acquire] " + fmt % args, flush=True)


def _playwright_ok() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    global ACQUIRE_TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8802)
    ap.add_argument("--token", default="")   # 缺省读 PAPERSYS_ACQUIRE_TOKEN
    ap.add_argument("--allow-no-auth", action="store_true",
                    help="显式允许无鉴权（仅限完全隔离的内网；默认拒绝启动）")
    args = ap.parse_args()
    ACQUIRE_TOKEN = args.token or os.environ.get("PAPERSYS_ACQUIRE_TOKEN", "")
    if not ACQUIRE_TOKEN and not args.allow_no_auth:
        print("[acquire] 拒绝启动：未设置 PAPERSYS_ACQUIRE_TOKEN。"
              "本服务可驱动宿主浏览器访问外网，必须鉴权。"
              "请在 .env 设置该 token（install.sh 会自动生成），"
              "确需无鉴权请显式加 --allow-no-auth。", flush=True)
        raise SystemExit(2)
    srv = HTTPServer(("0.0.0.0", args.port), Handler)   # 单线程：Playwright sync API 只能在创建它的线程用
    print(f"[acquire] 采集服务启动 http://0.0.0.0:{args.port} "
          f"（鉴权{'开' if ACQUIRE_TOKEN else '关'}）", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
