"""知网中文元数据候选（jasminum 式中文源校准，best-effort）。

search.cnki.com.cn（旧版公开搜索）对无登录态请求相对宽容；
kns.cnki.net 需要登录态不做。反爬/验证码/结构变化 → 抛异常，
前端明确提示「被拦截/未解析到」，绝不假装成功。
"""
from __future__ import annotations

import re

import httpx

_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def search(title: str, limit: int = 8) -> list[dict]:
    """返回 [{title, authors, journal, year}]；解析不到/被拦截抛异常。"""
    r = httpx.get("https://search.cnki.com.cn/Search/Result",
                  params={"content": title},
                  headers={"User-Agent": _UA},
                  timeout=15, follow_redirects=True)
    r.raise_for_status()
    html = r.text
    if "验证码" in html or "verify" in html.lower()[:2000]:
        raise RuntimeError("知网要求验证码（反爬拦截）")
    items: list[dict] = []
    # 结果块：新版搜索页 <div class="list-item"> 内含标题链接 + 来源行
    for block in re.findall(r'<div class="list-item">.*?<a[^>]*href="[^"]*"[^>]*>(.*?)</a>(.*?)(?=<div class="list-item">|$)',
                            html, re.S)[:limit * 2]:
        t = _strip_tags(block[0])
        rest = _strip_tags(block[1])
        if not t or len(t) < 4:
            continue
        # 来源行形如 "《期刊名》 2024年第x期 或 作者1,作者2 - 期刊名, 年"
        journal = ""
        m = re.search(r"《([^》]+)》", rest)
        if m:
            journal = m.group(1)
        year = ""
        y = re.search(r"(19|20)\d{2}", rest)
        if y:
            year = y.group(0)
        authors = ""
        am = re.match(r"([^《》-]{2,40}?)\s*[-,，]\s*", rest)
        if am and "年" not in am.group(1):
            authors = am.group(1).strip()
        if any(i["title"] == t for i in items):
            continue
        items.append({"title": t, "authors": authors, "journal": journal, "year": year})
        if len(items) >= limit:
            break
    if not items:
        raise RuntimeError("未从知网页面解析到候选（结构可能变化或被拦截）")
    return items
