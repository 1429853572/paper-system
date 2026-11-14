"""系统健康指标（core/health.py）：磁盘/备份/任务积压/解析失败/邮件。

采集纯读库 + shutil，无外部依赖；阈值判定输出 ok/warn/err 三档。
告警邮件由 tracker_mail 的全局 SMTP 发送（admin 配置一次全站共用），
仅给 admin 发——成员侧不涉及。
"""
import json
import shutil
import time

from . import journal  # noqa: F401 占位避免误删（后续健康项可能用）
from .db import db


def _disk_pct() -> float:
    """数据盘使用率（DATA_DIR 所在分区）。"""
    try:
        from .config import DATA_DIR
        total, used, free = shutil.disk_usage(DATA_DIR)
        return round(used / total * 100, 1)
    except Exception:  # noqa: BLE001
        return 0.0


def collect(user_id: int | None = None, is_admin: bool = False) -> dict:
    """采集全部健康指标。admin 附带全站项（备份/失败任务/邮箱），成员仅个人项。"""
    out = {"ts": time.strftime("%Y-%m-%d %H:%M:%S")}

    # 任务积压（admin=全站，成员=自己的）
    where = "" if is_admin else " AND user_id=" + str(user_id)
    active = db.one(f"SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','pending_gate','running'){where}")["n"]
    out["jobs_active"] = active

    # 解析失败（未清理的失败任务）
    failed = db.one(f"SELECT COUNT(*) n FROM jobs WHERE status='failed'{where}")["n"]
    out["jobs_failed"] = failed

    # 磁盘
    disk_pct = _disk_pct()
    out["disk_pct"] = disk_pct
    out["disk_level"] = "err" if disk_pct >= 90 else ("warn" if disk_pct >= 80 else "ok")

    if is_admin:
        # 备份：今日备份是否存在 + backups 目录体积
        from .config import DATA_DIR
        bdir = DATA_DIR / "backups"
        today = time.strftime("%Y-%m-%d")
        today_db = (bdir / f"db-{today}.db").exists()
        today_papers = (bdir / f"papers-{today}.tar.gz").exists()
        out["backup_today"] = bool(today_db and today_papers)
        bk_size = 0
        bk_count = 0
        for f in bdir.glob("*"):
            try:
                bk_size += f.stat().st_size
                bk_count += 1
            except OSError:
                pass
        out["backup_size_gb"] = round(bk_size / 1073741824, 1)
        out["backup_count"] = bk_count
        out["backup_level"] = "err" if not out["backup_today"] else (
            "warn" if out["backup_size_gb"] > 15 else "ok")
        out["smtp_ready"] = _smtp_ready()

        # 失败任务样本（最多 5 条给健康卡展示）
        out["failed_jobs"] = [dict(r) for r in db.all(
            "SELECT j.id, j.job_type, j.error, j.updated_at, u.username FROM jobs j "
            "LEFT JOIN users u ON u.id=j.user_id WHERE j.status='failed' "
            "ORDER BY j.updated_at DESC LIMIT 5")]
    return out


def _smtp_ready() -> bool:
    try:
        from .tracker_mail import smtp_configured
        return smtp_configured()
    except Exception:  # noqa: BLE001
        return False


def alerts(out: dict) -> list[dict]:
    """阈值判定 → 告警列表 [{level: warn|err, msg}]。"""
    al = []
    if out.get("disk_level") == "warn":
        al.append({"level": "warn", "msg": f"磁盘使用率 {out['disk_pct']}%（≥80%）——建议清理回收站或旧备份"})
    if out.get("disk_level") == "err":
        al.append({"level": "err", "msg": f"磁盘使用率 {out['disk_pct']}%（≥90%）——即将写满，立即清理！"})
    if out.get("backup_level") == "err":
        al.append({"level": "err", "msg": "今日备份缺失——检查 janitor/备份 cron 是否正常"})
    if out.get("backup_level") == "warn":
        al.append({"level": "warn", "msg": f"备份目录 {out['backup_size_gb']}GB（>15GB）——轮转可能失效"})
    if out.get("jobs_failed", 0) > 0:
        al.append({"level": "warn", "msg": f"{out['jobs_failed']} 个失败任务未处理——任务中心查看并重试"})
    if out.get("jobs_active", 0) > 50:
        al.append({"level": "warn", "msg": f"任务积压 {out['jobs_active']} 个——队列过载"})
    return al


def alert_email_html(al: list[dict], out: dict) -> str:
    import html
    items = "".join(
        f"<li style='margin:6px 0'><b style='color:{'#c0392b' if a['level'] == 'err' else '#b8860b'}'>"
        f"{'[严重] ' if a['level'] == 'err' else '[警告] '}{html.escape(a['msg'])}</b></li>"
        for a in al)
    return (f"<div style='font-family:-apple-system,Segoe UI,sans-serif;max-width:680px'>"
            f"<h2 style='margin:0 0 6px'>paper-system 系统告警</h2>"
            f"<p style='color:#6b7280;margin:0 0 12px'>{out.get('ts', '')} · 磁盘 {out.get('disk_pct', '?')}% · "
            f"任务积压 {out.get('jobs_active', '?')} · 失败 {out.get('jobs_failed', '?')}</p>"
            f"<ul style='padding-left:18px'>{items}</ul></div>")
