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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验产物是否最新")
    args = ap.parse_args()

    content = build()
    if args.check:
        cur = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if cur != content:
            print("✗ viewer.js 与 src/ 不同步——请运行 python3 scripts/build-webui.py")
            return 1
        print("✓ viewer.js 与 src/ 同步")
        return 0

    OUT.write_text(content, encoding="utf-8")
    n = len(content.split("\n"))
    print(f"✓ 构建 viewer.js（{n} 行，{len(list(SRC.glob('*.js')))} 个源分片）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
