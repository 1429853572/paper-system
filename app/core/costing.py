"""LLM 花费估算与月预算闸。

设计前提（用户明确要求）：
- **额度/余额是上游商家的事**——上游会自己报「余额不足」，系统只把错误原样透传，
  不重复造一个 token 面板；
- 本模块只解决另一件事：**在完全烧穿之前给一个可设的上限**（月预算 ¥N），
  超了就在发起 LLM 调用前拦下，避免"事后才发现这个月花超了"。

单价：config.yaml 的 `pricing` 表（每百万 token 的元价），按模型名匹配，
前缀匹配（如 "gpt-4o" 命中 "gpt-4o-mini" 的兜底），OpenAI 兼容厂商各家定价不同，
用户可在设置页按自己的实际单价覆盖（存 user_quotas.overrides.pricing）。
"""
from __future__ import annotations

from .config import config
from .db import db


class BudgetExceeded(Exception):
    """月预算耗尽——调用方应返回 402 并提示用户。"""

    def __init__(self, spent: float, budget: float, month: str = ""):
        self.spent = round(spent, 2)
        self.budget = round(budget, 2)
        self.month = month
        super().__init__(
            f"本月 LLM 预算已用尽（已花 ¥{self.spent} / 预算 ¥{self.budget}）"
            f"——可在「设置 → 我的用量」调整预算，或等待下月重置")


def _pricing_table(overrides: dict | None = None) -> dict[str, dict]:
    """默认单价表 + 用户覆盖（用户覆盖优先）。"""
    raw = config.section("pricing") or {}
    table = {k: dict(v) for k, v in raw.items() if isinstance(v, dict)}
    for k, v in ((overrides or {}).get("pricing") or {}).items():
        if isinstance(v, dict):
            table[k] = {**table.get(k, {}), **v}
    return table


def _unit_price(table: dict[str, dict], model: str) -> tuple[float, float]:
    """模型 → (prompt 元/百万, completion 元/百万)。未收录 → (0, 0)（不计费）。"""
    m = (model or "").strip()
    if not m:
        return 0.0, 0.0
    hit = table.get(m)
    if not hit:                      # 前缀/包含匹配：gpt-4o-mini → gpt-4o
        for name, price in table.items():
            if m.startswith(name) or name in m:
                hit = price
                break
    if not hit:
        return 0.0, 0.0
    return (float(hit.get("prompt") or 0), float(hit.get("completion") or 0))


def month_cost(user_id: int, overrides: dict | None = None) -> dict:
    """本月花费估算（按 model×purpose 折算）。返回:
    {total: 元, by_purpose: {purpose: 元}, calls: n, tokens: n, priced: bool}
    """
    table = _pricing_table(overrides)
    rows = db.all(
        "SELECT purpose, model, COUNT(*) AS calls, SUM(prompt_tokens) AS p, "
        "SUM(completion_tokens) AS c FROM llm_calls "
        "WHERE user_id=? AND created_at >= date('now','start of month') GROUP BY purpose, model",
        (user_id,))
    total = 0.0
    by_purpose: dict[str, float] = {}
    calls = tokens = 0
    priced = False
    for r in rows:
        calls += r["calls"] or 0
        tokens += (r["p"] or 0) + (r["c"] or 0)
        pp, cp = _unit_price(table, r["model"] or "")
        cost = ((r["p"] or 0) * pp + (r["c"] or 0) * cp) / 1_000_000
        if pp or cp:
            priced = True
        total += cost
        by_purpose[r["purpose"]] = round(by_purpose.get(r["purpose"], 0.0) + cost, 4)
    return {"total": round(total, 2), "by_purpose": by_purpose, "calls": calls,
            "tokens": tokens, "priced": priced}


def prev_month_cost(user_id: int, overrides: dict | None = None) -> float:
    """上月花费（对比用）。"""
    table = _pricing_table(overrides)
    rows = db.all(
        "SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c FROM llm_calls "
        "WHERE user_id=? AND created_at >= date('now','start of month','-1 month') "
        "AND created_at < date('now','start of month') GROUP BY model", (user_id,))
    total = 0.0
    for r in rows:
        pp, cp = _unit_price(table, r["model"] or "")
        total += ((r["p"] or 0) * pp + (r["c"] or 0) * cp) / 1_000_000
    return round(total, 2)


def self_budget(user_id: int) -> float:
    """成员自设预算（元）——存 settings（与 admin 的硬上限分开，取更严者）。"""
    row = db.one("SELECT value FROM settings WHERE key=?", (f"budget:{user_id}",))
    try:
        return float(row["value"]) if row else 0.0
    except (TypeError, ValueError):
        return 0.0


def budget_of(overrides: dict | None = None, user_id: int | None = None) -> float:
    """生效预算（元）：admin 硬上限与成员自设取更严者；0/未设 = 不设闸。"""
    try:
        admin_cap = float((overrides or {}).get("monthly_budget_cny") or 0)
    except (TypeError, ValueError):
        admin_cap = 0.0
    mine = self_budget(user_id) if user_id is not None else 0.0
    vals = [v for v in (admin_cap, mine) if v > 0]
    return min(vals) if vals else 0.0


def overrides_of(user_id: int) -> dict:
    """用户的配额覆盖（预算 + 自定义单价）。"""
    import json
    row = db.one("SELECT overrides FROM user_quotas WHERE user_id=?", (user_id,))
    try:
        return json.loads(row["overrides"]) if row and row["overrides"] else {}
    except (TypeError, ValueError):
        return {}


def check_budget(user_id: int, overrides: dict | None = None) -> None:
    """LLM 调用前的预算闸：超预算抛 BudgetExceeded。"""
    if overrides is None:
        overrides = overrides_of(user_id)
    budget = budget_of(overrides, user_id)
    if budget <= 0:
        return
    spent = month_cost(user_id, overrides)["total"]
    if spent >= budget:
        raise BudgetExceeded(spent, budget)


def synth_cost_estimate(user_id: int, calls: int, overrides: dict | None = None) -> dict:
    """综述费用预估：按用户历史实际均摊成本 × 预计调用数。

    比「按 token 猜」准：直接取该用户（或全站）purpose='synthesis' 的历史
    调用平均单价，乘以预计调用数。历史不足时退回全站均值，仍不足则给 0
    （宁可不显示，也不显示编造的数字）。
    返回 {cost: 元, per_call: 元, samples: n, priced: bool}
    """
    if overrides is None:
        overrides = overrides_of(user_id)
    table = _pricing_table(overrides)

    def avg(scope_sql: str, args: tuple) -> tuple[float, int]:
        rows = db.all(
            "SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, "
            "COUNT(*) AS n FROM llm_calls " + scope_sql + " GROUP BY model", args)
        tot = 0.0
        n = 0
        for r in rows:
            pp, cp = _unit_price(table, r["model"] or "")
            tot += (pp * (r["p"] or 0) + cp * (r["c"] or 0)) / 1_000_000
            n += r["n"] or 0
        return (tot / n if n else 0.0), n

    per_call, samples = avg("WHERE user_id=? AND purpose='synthesis'", (user_id,))
    if not samples:                      # 本人没跑过综述 → 用全站均值
        per_call, samples = avg("WHERE purpose='synthesis'", ())
    if not samples:                      # 全站也没有 → 用该用户全部调用的均值
        per_call, samples = avg("WHERE user_id=?", (user_id,))
    return {"cost": round(per_call * calls, 4), "per_call": round(per_call, 6),
            "samples": samples, "priced": bool(samples)}


def site_cost(overrides: dict | None = None) -> dict:
    """全站本月花费（admin 视角）。"""
    table = _pricing_table(overrides)
    rows = db.all(
        "SELECT user_id, model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c "
        "FROM llm_calls WHERE created_at >= date('now','start of month') GROUP BY user_id, model")
    per_user: dict[int, float] = {}
    for r in rows:
        pp, cp = _unit_price(table, r["model"] or "")
        per_user[r["user_id"]] = per_user.get(r["user_id"], 0.0) + (
            ((r["p"] or 0) * pp + (r["c"] or 0) * cp) / 1_000_000)
    return {uid: round(v, 2) for uid, v in per_user.items()}
