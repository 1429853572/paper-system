#!/usr/bin/env python3
"""papersys — paper-system 命令行客户端.

经 HTTP API 调用（token 见 .env PAPERSYS_API_TOKEN），不直接打开 SQLite/Chroma。
宿主机可用 wrapper: ./psys
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx

BASE = os.environ.get("PAPERSYS_URL", "http://127.0.0.1:8001")
TOKEN = os.environ.get("PAPERSYS_API_TOKEN", "")


def client() -> httpx.Client:
    if not TOKEN:
        die("未设置 PAPERSYS_API_TOKEN（在 .env 中查看）")
    return httpx.Client(base_url=BASE, timeout=600,
                        headers={"Authorization": f"Bearer {TOKEN}"})


def die(msg: str, code: int = 1) -> None:
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(code)


def out(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


# ---------------- 命令 ----------------
def cmd_add(args):
    paths = [Path(p) for p in args.paths]
    files = []
    for p in paths:
        if p.is_dir():
            files.extend(sorted(x for x in p.iterdir() if x.suffix.lower() == ".pdf"))
        elif p.suffix.lower() == ".pdf":
            files.append(p)
    if not files:
        die("未找到 PDF 文件")
    visibility = "private" if args.private else "shared"
    http = client()
    results = []
    for f in files:  # 逐文件上传以显示进度
        with open(f, "rb") as fh:
            r = http.post(f"/api/papers/upload?visibility={visibility}",
                          files={"files": (f.name, fh, "application/pdf")})
        if r.status_code != 200:
            results.append({"name": f.name, "status": "error", "detail": r.text[:200]})
        else:
            results.extend(r.json()["results"])
    out(results)
    failed = [r for r in results if r.get("status") in ("rejected", "error")]
    if failed:
        sys.exit(2)


def cmd_list(args):
    params = {"q": args.q or "", "status": args.status or "", "trash": args.trash}
    out(client().get("/api/papers", params=params).json())


def cmd_translate(args):
    body = {"paper_ids": args.paper_ids.split(","),
            "force_new_version": args.retranslate}
    out(client().post("/api/papers/translate", json=body).json())


def cmd_ask(args):
    body = {"question": args.question, "paper_ids": args.papers.split(","),
            "mode": args.mode}
    with httpx.stream("POST", f"{BASE}/api/chat/stream", json=body,
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=300) as r:
        evidence = None
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev.get("type") == "delta":
                print(ev["text"], end="", flush=True)
            elif ev.get("type") == "done":
                evidence = ev.get("evidence") or []
                illegal = ev.get("citations", {}).get("illegal") or []
                print()
                if illegal:
                    print(f"⚠ 无效引用: {illegal}", file=sys.stderr)
            elif ev.get("type") == "error":
                print(f"\n[错误] {ev.get('message')}", file=sys.stderr)
        if evidence and not args.no_evidence:
            print("\n--- 引用 ---")
            for e in evidence:
                print(f"[{e['evidence_id']}] {e['title']} · 第{e['page_index'] + 1}页")


def cmd_search(args):
    r = client().post("/api/search", json={"query": args.query, "top_k": args.k})
    out(r.json())


def cmd_summary(args):
    r = client().post(f"/api/papers/{args.paper_id}/summary")
    if r.status_code != 200:
        die(r.json().get("detail", r.text[:200]))
    d = r.json()
    for k, content in d["sections"].items():
        print(f"## {k}\n{content}\n")


def cmd_rm(args):
    for pid in args.paper_ids.split(","):
        r = client().delete(f"/api/papers/{pid}")
        print(pid, "→", "已入回收站" if r.status_code == 200 else r.json().get("detail"))


def cmd_restore(args):
    r = client().post(f"/api/papers/{args.paper_id}/restore")
    print("恢复" if r.status_code == 200 else r.json().get("detail"))


def cmd_queue(args):
    action = args.action
    r = client().post(f"/api/queue/parse/{'pause' if action == 'pause' else 'resume'}")
    print("解析队列", "已暂停" if action == "pause" else "已恢复" if r.status_code == 200 else r.text)


def cmd_jobs(args):
    out(client().get("/api/jobs", params={"limit": args.limit}).json())


def cmd_user(args):
    if args.action == "invite":
        out(client().post("/api/admin/invite", params={"days": args.days}).json())
    elif args.action == "list":
        out(client().get("/api/admin/users").json())
    elif args.action == "usage":
        out(client().get("/api/usage").json())
    else:
        die(f"未知 user 子命令: {args.action}")


def cmd_serve(args):
    os.execvp("docker", ["docker", "compose", "up", "-d"])


def cmd_backup(args):
    """立即备份（数据库快照 + 论文归档）。注意：容器内无 scripts/——请用宿主机 ./psys backup。"""
    import subprocess
    cmd = ["bash", "scripts/backup.sh"]
    if str(args.keep) != "0":        # 0=用脚本/配置默认；传 "0" 会被轮转逻辑当作保留 0 份
        cmd.append(str(args.keep))
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout or r.stderr)


def cmd_restore_backup(args):
    """从备份恢复（宿主机请直接用 ./psys restore，容器内无 scripts/）。"""
    import subprocess
    cmd = ["bash", "scripts/restore.sh"]
    if args.date:
        cmd.append(args.date)
    r = subprocess.run(cmd, text=True)
    sys.exit(r.returncode)


def cmd_export_images(args):
    """离线部署：导出全部镜像 tar。"""
    dest = Path(args.out)
    dest.mkdir(parents=True, exist_ok=True)
    print("提示: install.sh --offline 读取的是 deploy/offline/，建议 --out deploy/offline")
    # 镜像清单与 compose.yml 对齐（xinference 的 digest 从 compose 读取，不再硬编码）
    images = ["mineru:4.1.6", "papersys-app:v1", "caddy:2.11.7-alpine"]
    compose = (Path(__file__).parent.parent / "compose.yml").read_text()
    m = re.search(r"image:\s*(docker\.1ms\.run/xprobe/xinference@\S+)", compose)
    if m:
        images.append(m.group(1))
    for img in images:
        f = dest / (img.replace("/", "_").replace(":", "_") + ".tar")
        print(f"导出 {img} → {f}")
        os.system(f"docker save {img} -o {f}")


def cmd_export_bundle(args):
    """数据迁移：data/ 备份 tar（models 单独导）。"""
    dest = Path(args.out)
    dest.mkdir(parents=True, exist_ok=True)
    os.system(f"tar czf {dest}/data-bundle.tar.gz -C {Path(__file__).parent.parent} data/")
    print(f"数据包: {dest}/data-bundle.tar.gz（models/ 用 rsync 单独迁移）")


def main() -> None:
    ap = argparse.ArgumentParser(prog="papersys")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add", help="导入 PDF（文件或目录，多路径）")
    p.add_argument("paths", nargs="+")
    p.add_argument("--private", action="store_true", help="仅自己可见")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("list", help="文库列表")
    p.add_argument("--q", default="")
    p.add_argument("--status", default="")
    p.add_argument("--trash", action="store_true")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("translate", help="翻译（逗号分隔多篇；--retranslate 强制新版本）")
    p.add_argument("paper_ids")
    p.add_argument("--retranslate", action="store_true")
    p.set_defaults(fn=cmd_translate)

    p = sub.add_parser("ask", help="问答（--papers 单篇或多篇）")
    p.add_argument("question")
    p.add_argument("--papers", required=True)
    p.add_argument("--mode", default="auto", choices=["auto", "fulltext", "retrieval"])
    p.add_argument("--no-evidence", action="store_true")
    p.set_defaults(fn=cmd_ask)

    p = sub.add_parser("search", help="文库全文搜索")
    p.add_argument("query")
    p.add_argument("-k", type=int, default=10)
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("summary", help="生成科研导读")
    p.add_argument("paper_id")
    p.set_defaults(fn=cmd_summary)

    p = sub.add_parser("rm", help="软删除（回收站）")
    p.add_argument("paper_ids")
    p.set_defaults(fn=cmd_rm)

    p = sub.add_parser("restore", help="从回收站恢复")
    p.add_argument("paper_id")
    p.set_defaults(fn=cmd_restore)

    p = sub.add_parser("queue", help="队列管理 pause|resume")
    p.add_argument("action", choices=["pause", "resume"])
    p.set_defaults(fn=cmd_queue)

    p = sub.add_parser("jobs", help="任务列表")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(fn=cmd_jobs)

    p = sub.add_parser("user", help="用户管理 invite|list|usage")
    p.add_argument("action")
    p.add_argument("--days", type=int, default=7)
    p.set_defaults(fn=cmd_user)

    sub.add_parser("serve", help="启动服务(docker compose up -d)").set_defaults(fn=cmd_serve)

    p = sub.add_parser("backup", help="立即备份（数据库+论文）")
    p.add_argument("--keep", type=int, default=0, help="保留份数（0=用配置默认）")
    p.set_defaults(fn=cmd_backup)

    p = sub.add_parser("restore-backup", help="从备份恢复（默认最近一份；回收站恢复见 restore）")
    p.add_argument("--date", default="", help="指定备份日期 YYYY-MM-DD")
    p.set_defaults(fn=cmd_restore_backup)

    p = sub.add_parser("export-images", help="导出镜像 tar（离线部署）")
    p.add_argument("--out", default="offline-images")
    p.set_defaults(fn=cmd_export_images)

    p = sub.add_parser("export-bundle", help="导出数据迁移包")
    p.add_argument("--out", default=".")
    p.set_defaults(fn=cmd_export_bundle)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
