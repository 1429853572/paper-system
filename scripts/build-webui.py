#!/usr/bin/env python3
"""把 app/webui/src/*.js 按序拼接成 app/webui/viewer.js（单文件交付）。

为什么是「拼接」而不是「原生 ES module 多文件」：
  · viewer.js 以 <script type="module"> 加载，但测试用 jsdom 的 window.eval(js)
    单次 eval 全文——模块作用域下 const 不跨 eval 共享，多文件直出会让
    9 套回归全部失效；
  · 拼接后浏览器端仍是「一个文件、一个模块作用域」，语义与拆分前完全一致
    （声明提升、window 挂载、内联 onclick 求值时机都不变）；
  · 源码按域拆分后，改一个功能只动一个文件——这正是本项目反复出错的根因
    （6227 行单文件里做字符串替换，锚点匹配极易误伤）。

用法:
  python3 scripts/build-webui.py          # 构建
  python3 scripts/build-webui.py --check  # 只校验产物是否为最新（CI 用）
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "webui" / "src"
OUT = ROOT / "app" / "webui" / "viewer.js"

BANNER = """/* ============================================================
 * paper-system 前端主文件 —— 由 app/webui/src/*.js 拼接生成
 *   构建：python3 scripts/build-webui.py
 *   请勿直接编辑本文件；改 app/webui/src/ 下的分片后重新构建。
 * ============================================================ */
"""


def build() -> str:
    if not SRC.is_dir():
        raise SystemExit(f"源目录不存在: {SRC}")
    parts = sorted(SRC.glob("*.js"))
    if not parts:
        raise SystemExit(f"源目录为空: {SRC}")
    chunks = [BANNER]
    for p in parts:
        chunks.append(p.read_text(encoding="utf-8").rstrip("\n"))
        chunks.append("\n")
    return "".join(chunks)



def check_css_balance() -> bool:
    """styles.css 括号必须平衡——一条未闭合规则会杀死其后全部样式（真机踩过：
    多行规则被部分替换后丢掉闭合 }，全站界面散架）。"""
    import re as _re
    css = (ROOT / "app" / "webui" / "styles.css").read_text(encoding="utf-8")
    css = _re.sub(r"/\*.*?\*/", "", css, flags=_re.S)
    depth, neg = 0, 0
    for ch in css:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                neg += 1
                depth = 0
    ok = depth == 0 and neg == 0
    print(("✓ styles.css 括号平衡" if ok else f"✗ styles.css 括号不平衡（余 {depth}，负 {neg}）——"
          "未闭合规则会使其后全部样式失效"))
    return ok


def find_terser() -> str | None:
    """定位 terser：PATH → node 全局 bin 常见位置。都没有则压缩步骤优雅跳过。"""
    import glob as _glob
    import shutil
    found = shutil.which("terser")
    if found:
        return found
    for pat in ("/opt/node*/bin/terser", "/usr/local/bin/terser", str(Path.home() / ".npm-global/bin/terser")):
        hits = sorted(_glob.glob(pat))
        if hits:
            return hits[-1]
    return None


def try_minify() -> bool:
    """可选压缩（专项轮 R5，见 docs/web-quality-report.md §12）：terser 可用才产出
    viewer.min.js + map；不可用则保持纯拼接交付，行为与旧版完全一致。
    不用打包器——只做单文件压缩 + sourcemap，保持「改 src → 重建」的最小工作流。
    服务端（main.py index）只在 min 比 viewer.js 新时才改指，防止 terser 缺席时
    旧 min 文件 stale 上线。压缩不改语义：mangle 不碰 window.* 属性名（内联
    onclick 引用不受影响），源内无 eval/new Function（已核）。"""
    t = find_terser()
    if not t:
        print("· terser 不可用——跳过压缩（viewer.js 原样交付）")
        return False
    import subprocess
    out_min = OUT.with_name("viewer.min.js")
    r = subprocess.run(
        [t, str(OUT), "--module", "--compress", "--mangle",
         "--source-map", f"url='viewer.min.js.map'", "--output", str(out_min)],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0 or not out_min.exists():
        print(f"✗ terser 压缩失败（{r.stderr.strip()[:200]}）——viewer.js 原样交付")
        return False
    a, b = OUT.stat().st_size, out_min.stat().st_size
    print(f"✓ 压缩 viewer.min.js（{a//1024}KB → {b//1024}KB，-{round((1-b/a)*100)}%）+ sourcemap")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验产物是否最新")
    args = ap.parse_args()

    content = build()
    css_ok = check_css_balance()
    if args.check:
        cur = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if cur != content:
            print("✗ viewer.js 与 src/ 不同步——请运行 python3 scripts/build-webui.py")
            return 1
        print("✓ viewer.js 与 src/ 同步")
        return 0 if css_ok else 1

    if not css_ok:
        print("✗ styles.css 括号不平衡——拒绝写入产物，先修复样式")
        return 1
    OUT.write_text(content, encoding="utf-8")
    n = len(content.split("\n"))
    print(f"✓ 构建 viewer.js（{n} 行，{len(list(SRC.glob('*.js')))} 个源分片）")
    try_minify()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
