#!/usr/bin/env python3
"""一次性样式归一（v1.2.0 视觉统一的一部分）：
1. 删除死 CSS 规则（选择器在 index.html/login.html/viewer.js 中零命中的 17 组）
2. 字号/圆角 token 化（styles.css 全部 + viewer.js 内联 style 的字号）
3. 硬编码颜色 → 语义变量（:root 已定义或本脚本新增）
用法：python3 scripts/normalize-css.py --apply   （不带 --apply 只输出 diff 统计）
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
APPLY = '--apply' in sys.argv

# ---- 死规则 kill list（选择器子串匹配）----
KILL = ['.qa-drawer', '.qa-head', '.qa-tabs', '.qa-summary', 'mode-summary',
        '.zh-line', '.en-line', '.ord-badge', '#ord-btn', '.lib-card.drag',
        '.bn-btn', '.bnote', '.fill-hint', '.sel-out', '.translatingNow',
        '.lib-tree', '#sel-toggle.primary', '.sidebar .filters', '.filters button',
        '.blk .tag', '#qa-session', '#qa-new']

FONT = {'10px': 'var(--fs-xs)', '11px': 'var(--fs-xs)', '11.5px': 'var(--fs-xs)',
        '12px': 'var(--fs-sm)', '12.5px': 'var(--fs-sm)',
        '13px': 'var(--fs-base)', '13.5px': 'var(--fs-base)',
        '14px': 'var(--fs-md)', '15px': 'var(--fs-lg)', '16px': 'var(--fs-lg)',
        '16.5px': 'var(--fs-lg)', '17px': 'var(--fs-xl)', '22px': 'var(--fs-h1)'}

RADIUS = {'4px': 'var(--r-xs)', '5px': 'var(--r-xs)', '6px': 'var(--r-sm)',
          '7px': 'var(--r-sm)', '8px': 'var(--r-md)', '9px': 'var(--r-md)',
          '10px': 'var(--r-lg)', '12px': 'var(--r-lg)',
          '14px': 'var(--r-pill)', '20px': 'var(--r-pill)'}

COLOR = {
    # 蓝系 tint
    '#eef1ff': 'var(--tint-primary)', '#e3e9ff': 'var(--tint-primary)',
    '#f6f8ff': 'var(--tint-primary)', '#e8edff': 'var(--tint-primary)',
    '#dbe3ff': 'var(--tint-primary-2)', '#c3ceff': 'var(--tint-primary-2)',
    '#5b4fd6': 'var(--primary)', '#3a56d4': 'var(--primary-dark)',
    # 深浅灰文字
    '#333': 'var(--text)', '#1a1a1a': 'var(--text)', '#1a2233': 'var(--text)',
    '#444': 'var(--text-2)', '#778': 'var(--muted)', '#ccc': 'var(--border)',
    '#8a93b0': 'var(--muted)', '#9aa3b8': 'var(--muted)', '#9aa3bd': 'var(--muted)',
    '#b6bdd6': 'var(--muted)',
    # 灰底/悬停
    '#f4f6fc': 'var(--hover)', '#f4f6fa': 'var(--hover)', '#f4f6fb': 'var(--hover)',
    '#f4f5f9': 'var(--hover)', '#f6f7fb': 'var(--hover)', '#f6f7f9': 'var(--hover)',
    '#f6f8fd': 'var(--hover)', '#f0f3fc': 'var(--hover)', '#f0f3fb': 'var(--hover)',
    '#f0f2f8': 'var(--bg-soft)', '#eef0f6': 'var(--bg-soft)',
    '#f8f9fc': 'var(--panel-soft)', '#f7f8fc': 'var(--panel-soft)',
    '#fafbfd': 'var(--panel-soft)', '#fbfcfe': 'var(--panel-soft)',
    '#f0f1f5': 'var(--line-soft)', '#f2f3f7': 'var(--line-soft)',
    '#eef0f5': 'var(--line-soft)',
    # 灰边框
    '#dfe3ec': 'var(--border)', '#d8dce6': 'var(--border)', '#d5d9e2': 'var(--border)',
    '#dfe3ee': 'var(--border)', '#c9d2ee': 'var(--border)', '#e8eaf2': 'var(--border)',
    '#cfd4e0': 'var(--border)', '#ccd3ea': 'var(--border)',
    # 绿系
    '#e2f5ea': 'var(--tint-ok)', '#eef7f1': 'var(--tint-ok)',
    '#f2fbf6': 'var(--tint-ok)', '#bfe3cf': 'var(--tint-ok-2)', '#7cc79c': 'var(--ok)',
    # 黄/橙系
    '#fff7d6': 'var(--tint-warn)', '#fff3c2': 'var(--tint-warn)',
    '#fff8e6': 'var(--tint-warn)', '#fff8dc': 'var(--tint-warn)',
    '#fff6e2': 'var(--tint-warn)',
    '#f0d878': 'var(--tint-warn-2)', '#f2ddb0': 'var(--tint-warn-2)',
    '#e6c34d': 'var(--tint-warn-2)',
    '#8a6116': 'var(--warn-ink)', '#6b5b1e': 'var(--warn-ink)',
    '#f5b301': 'var(--warn)', '#d99a1e': 'var(--warn)', '#e6a23c': 'var(--warn)',
    # 红系
    '#fdeaea': 'var(--tint-err)', '#f2c4c4': 'var(--tint-err-2)',
}

# 这些上下文保持字面量（PDF 深底 / JSON 深色调试块），跳过替换
KEEP_CTX = ('#525659', '#444;', '#2b2f3a', '#4a5064')


def split_top_blocks(css):
    """按顶层大括号切块，返回 [(header, body, start, end)]；处理注释与字符串。"""
    blocks, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j == -1:
            break
        header = css[i:j]
        if '}' in header and header.rsplit('}', 1)[1].strip() == '':
            i = j + 1
            continue
        depth, k = 1, j + 1
        while k < n and depth:
            c = css[k]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            k += 1
        blocks.append((header, css[j + 1:k - 1], i, k))
        i = k
    return blocks


def strip_dead(css):
    """删除 kill list 命中的顶层规则；@media 内部规则同样处理，空 @media 一并删除。"""
    out, removed = [], []
    for header, body, s, e in split_top_blocks(css):
        sel = header.strip()
        # 去掉块前的注释尾部，只看选择器部分
        sel_only = re.sub(r'/\*.*?\*/', '', sel, flags=re.S).strip()
        if sel_only.startswith('@media'):
            new_body, removed_in = strip_dead(body)
            if new_body.strip():
                out.append(css[s:s + len(header) + 1] + new_body + '}')
            else:
                removed.extend(removed_in)
        elif sel_only.startswith('@'):
            out.append(css[s:e])          # @keyframes 等原样保留
        elif any(k in sel_only for k in KILL):
            removed.append(re.sub(r'\s+', ' ', sel_only)[:80])
        else:
            out.append(css[s:e])
    return ''.join(out), removed


def map_values(css):
    stats = {'font': 0, 'radius': 0, 'color': 0}
    def font_repl(m):
        key = m.group(2) + 'px'
        stats['font'] += 1
        return m.group(1) + FONT[key]
    css = re.sub(r'(font-size:\s*)(10|11|11\.5|12|12\.5|13|13\.5|14|15|16|16\.5|17|22)(px\b)',
                 font_repl, css)

    def radius_repl(m):
        vals = m.group(2).split()
        mapped = [RADIUS.get(v, v) for v in vals]
        if mapped != vals:
            stats['radius'] += 1
        return m.group(1) + ' '.join(mapped) + ';'
    css = re.sub(r'(border-radius:\s*)([^;]+);', radius_repl, css)

    def color_repl(m):
        v = m.group(0)
        if v not in COLOR:
            return v          # #fff、PDF 深底、JSON 调试块等保持字面量
        stats['color'] += 1
        return COLOR[v]
    # :root 变量定义块保持字面量（否则 --bg: #f5f6fa 会变成自引用）
    root_m = re.search(r':root\s*\{[^}]*\}', css)
    root_block = root_m.group(0) if root_m else ''
    if root_block:
        css = css.replace(root_block, '@@ROOT@@')
    css = re.sub(r'#[0-9a-fA-F]{3,6}\b', color_repl, css)
    if root_block:
        css = css.replace('@@ROOT@@', root_block)
    return css, stats


def main():
    css_path = ROOT / 'app/webui/styles.css'
    js_path = ROOT / 'app/webui/viewer.js'
    css = css_path.read_text(encoding='utf-8')

    css2, removed = strip_dead(css)
    css3, stats = map_values(css2)

    js = js_path.read_text(encoding='utf-8')
    js3, stats2 = map_values(js)

    print(f'死规则删除 {len(removed)} 条:')
    for r in removed:
        print('   -', r)
    print(f'styles.css: 字号 {stats["font"]} 处, 圆角 {stats["radius"]} 处, 颜色 {stats["color"]} 处 → token')
    print(f'viewer.js : 字号 {stats2["font"]} 处, 圆角 {stats2["radius"]} 处, 颜色 {stats2["color"]} 处 → token')

    if css3.count('{') != css3.count('}'):
        sys.exit(f'大括号不平衡: {{ {css3.count("{")} vs }} {css3.count("}")} —— 中止')

    if APPLY:
        css_path.write_text(css3, encoding='utf-8')
        js_path.write_text(js3, encoding='utf-8')
        print('已写回文件')
    else:
        print('(dry-run，加 --apply 生效)')


if __name__ == '__main__':
    main()
