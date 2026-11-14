"""追踪日报邮件（core/tracker_mail.py）。

发件 SMTP 是管理员在管理后台配置一次的全局账号（settings 表 `smtp_global`，
授权码 Fernet 加密）；普通用户只在订阅里填收件邮箱。
"""
import html
import json
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from . import auth
from .db import db

SMTP_KEY = "smtp_global"
_TIER_LABEL = {"core": "核心", "proxy": "相关", "eco": "生态"}


def get_smtp_config() -> dict | None:
    row = db.one("SELECT value FROM settings WHERE key=?", (SMTP_KEY,))
    if not row:
        return None
    try:
        d = json.loads(row["value"])
    except Exception:  # noqa: BLE001
        return None
    if not d.get("host") or not d.get("sender"):
        return None
    d["password"] = ""
    if d.get("pass_enc"):
        try:
            d["password"] = auth.decrypt_key(bytes.fromhex(d["pass_enc"]))
        except Exception:  # noqa: BLE001
            pass
    return d


def smtp_configured() -> bool:
    cfg = get_smtp_config()
    return bool(cfg and cfg.get("password"))


def save_smtp_config(host: str, port: int, sender: str, password: str, sender_name: str = "") -> None:
    """密码留空 = 保留已存密码（编辑其他字段不动授权码）。"""
    payload = {"host": host.strip(), "port": int(port or 465),
               "sender": sender.strip(), "sender_name": sender_name.strip() or "paper-system"}
    old = get_smtp_config() or {}
    if password:
        payload["pass_enc"] = auth.encrypt_key(password).hex()
    elif old.get("pass_enc"):
        payload["pass_enc"] = old["pass_enc"]
    with db.write() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (SMTP_KEY, json.dumps(payload)))


def _send_html(to: str, subject: str, html: str) -> None:
    cfg = get_smtp_config()
    if not cfg:
        raise RuntimeError("全局发件邮箱未配置（管理后台 → 邮件发送）")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((cfg.get("sender_name") or "paper-system", cfg["sender"]))
    msg["To"] = to
    msg.attach(MIMEText(html, "html", "utf-8"))
    port = int(cfg.get("port") or 465)
    if port == 465:
        smtp = smtplib.SMTP_SSL(cfg["host"], port, timeout=25)
    else:
        smtp = smtplib.SMTP(cfg["host"], port, timeout=25)
    try:
        if port != 465:
            smtp.starttls(context=ssl.create_default_context())   # 失败即报错——不降级明文续传
        smtp.login(cfg["sender"], cfg.get("password") or "")
        smtp.sendmail(cfg["sender"], [to], msg.as_string())
    finally:
        smtp.quit()


def test_send(to: str) -> None:
    if not to or "@" not in to:
        raise ValueError("收件邮箱格式不正确")
    _send_html(to, "paper-system 邮件发送测试",
               "<p>这是一封测试邮件——配置成功后，文献追踪的巡逻日报会发到这个地址。</p>")


def _digest_html(sub: dict, items: list[dict]) -> str:
    """巡逻日报 HTML：tier 分组 + 中文摘要 + 链接。"""
    order = {"core": 0, "proxy": 1, "eco": 2}
    color = {"core": "#1a7f4b", "proxy": "#8a6d1f", "eco": "#6b7280"}
    def _if(x):
        try:
            return float((json.loads(x.get("rank") or "{}")).get("impact_factor") or 0)
        except Exception:  # noqa: BLE001
            return 0.0
    # 分层内按影响因子降序（Stork 惯例：好期刊的排前面）
    rows = sorted(items, key=lambda x: (order.get(x.get("tier"), 3), -_if(x)))
    blocks = []
    for it in rows:
        t = _TIER_LABEL.get(it.get("tier"), it.get("tier"))
        zh = f"<div style='color:#374151;margin-top:6px'>{it['zh_summary']}</div>" if it.get("zh_summary") else ""
        code = (f" · <a href='{it['code_url']}' style='color:#4a6cf7'>代码</a>" if it.get("code_url") else "")
        pdf = f"<a href='{it['pdf_url']}' style='color:#4a6cf7'>PDF</a>" if it.get("pdf_url") else ""
        fb = "<span style='color:#9aa3b0'>（补足）</span> " if it.get("is_fallback") else ""
        e = html.escape
        blocks.append(f"""
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin:10px 0">
          <div><span style="background:{color.get(it.get('tier'), '#6b7280')};color:#fff;border-radius:6px;
               padding:1px 8px;font-size:12px">{t}</span> {fb}
            <b style="font-size:15px">{e(it.get('title', ''))}</b></div>
          {f"<div style='color:#6b7280;font-size:13px;margin-top:2px'>{e(it['zh_title'])}</div>" if it.get('zh_title') else ""}
          <div style="color:#6b7280;font-size:13px;margin-top:4px">{e(it.get('authors', '')[:120])}
            · {e(it.get('published', ''))} · {e(it.get('venue', ''))}</div>
          {zh}
          <div style="margin-top:6px;font-size:13px">{pdf}{code}
            {" · " if pdf or code else ""}<span style="color:#9aa3b0">登录 paper-system → 追踪 → 收进文献库</span></div>
        </div>""")
    head = (f"<h2 style='margin:0 0 4px'>文献追踪日报 · {html.escape(sub.get('name', ''))}</h2>"
            f"<p style='color:#6b7280;margin:0 0 14px'>本轮新增 {len(items)} 篇</p>")
    return (f"<div style='font-family:-apple-system,Segoe UI,sans-serif;max-width:720px'>"
            f"{head}{''.join(blocks)}</div>")


def send_digest(sub: dict, items: list[dict]) -> bool:
    to = (sub.get("email_to") or "").strip()
    if not to or "@" not in to or not items:
        return False
    _send_html(to, f"文献追踪日报 · {sub.get('name', '')}（{len(items)} 篇新）", _digest_html(sub, items))
    return True
