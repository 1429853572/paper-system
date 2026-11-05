"""LLM 调用层：BYOK 解析（用户key > 公共池 > 拒绝）+ OpenAI/Anthropic 双协议 + 用量记录."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterator

import httpx

from . import auth
from .config import POOL_API_BASE, POOL_API_KEY, POOL_MODEL
from .db import db


class NoKeyError(Exception):
    pass


@dataclass
class LLMConfig:
    purpose: str          # chat | translate
    base_url: str
    api_key: str
    model: str
    api_type: str         # openai | anthropic
    key_source: str       # byok | pool


def resolve_llm(user_id: int, purpose: str) -> LLMConfig:
    """BYOK 优先；公共池默认关闭（admin 在设置中开启后经 POOL_* 生效）。"""
    user_llm = auth.get_user_llm(user_id) or {}
    cfg = user_llm.get(purpose)
    if cfg and cfg.get("key"):
        meta = cfg
        return LLMConfig(
            purpose=purpose,
            base_url=meta["base_url"],
            api_key=meta["key"],
            model=meta["model"],
            api_type=meta.get("api_type", "openai"),
            key_source="byok",
        )
    if POOL_API_KEY and POOL_API_BASE:
        return LLMConfig(
            purpose=purpose,
            base_url=POOL_API_BASE,
            api_key=POOL_API_KEY,
            model=POOL_MODEL,
            api_type="anthropic" if "/anthropic" in POOL_API_BASE else "openai",
            key_source="pool",
        )
    raise NoKeyError(f"未配置 {purpose} 使用的 LLM key——请在设置页配置或联系管理员开放公共池")


def _log_usage(user_id: int | None, cfg: LLMConfig, usage: dict, paper_id: str | None) -> None:
    with db.write() as c:
        c.execute(
            "INSERT INTO llm_calls(user_id,purpose,key_source,model,prompt_tokens,"
            "completion_tokens,paper_id) VALUES(?,?,?,?,?,?,?)",
            (user_id, cfg.purpose, cfg.key_source, cfg.model,
             int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
             int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
             paper_id),
        )


class LLMClient:
    """非流式 + 流式；带 429 指数退避。"""

    def __init__(self, cfg: LLMConfig, user_id: int | None = None, paper_id: str | None = None):
        self.cfg = cfg
        self.user_id = user_id
        self.paper_id = paper_id
        self._http = httpx.Client(timeout=300)

    # ---- OpenAI 协议 ----
    def _openai_body(self, messages: list[dict], max_tokens: int, stream: bool) -> dict:
        return {"model": self.cfg.model, "messages": messages,
                "max_tokens": max_tokens, "stream": stream}

    def _openai_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.cfg.api_key}"}

    # ---- Anthropic 协议 ----
    def _anthropic_body(self, messages: list[dict], max_tokens: int, stream: bool) -> dict:
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        rest = [m for m in messages if m["role"] != "system"]
        body: dict[str, Any] = {
            "model": self.cfg.model, "max_tokens": max_tokens, "messages": rest,
            # glm 等兼容端点默认开思维链，会挤占输出甚至吞掉 text 块 → 显式关闭
            "thinking": {"type": "disabled"},
        }
        if system:
            body["system"] = system
        if stream:
            body["stream"] = True
        return body

    def _anthropic_headers(self) -> dict:
        return {"x-api-key": self.cfg.api_key, "anthropic-version": "2023-06-01"}

    # ---- 统一入口 ----
    def _endpoint(self) -> str:
        base = self.cfg.base_url.rstrip("/")
        if self.cfg.api_type == "anthropic":
            # Anthropic 协议完整路径为 {base}/v1/messages（GLM Coding Plan 等兼容端点同构）
            if base.endswith("/messages"):
                base = base[: -len("/messages")]
            if not base.endswith("/v1"):
                base += "/v1"
            return base + "/messages"
        return base if base.endswith("/chat/completions") else f"{base}/chat/completions"

    def _request(self, messages: list[dict], max_tokens: int, stream: bool):
        if self.cfg.api_type == "anthropic":
            body = self._anthropic_body(messages, max_tokens, stream)
            headers = self._anthropic_headers()
        else:
            body = self._openai_body(messages, max_tokens, stream)
            headers = self._openai_headers()
        return self._http.build_request(
            "POST", self._endpoint(), json=body, headers={**headers, "Content-Type": "application/json"}
        )

    def _retry(self, attempt: int) -> float:
        return min(2 ** attempt * 2, 60)

    def complete(self, messages: list[dict], max_tokens: int = 4096) -> str:
        """非流式调用；429/5xx 指数退避重试 3 次。"""
        last_err = ""
        for attempt in range(4):
            req = self._request(messages, max_tokens, stream=False)
            try:
                r = self._http.send(req)
            except httpx.HTTPError as e:
                last_err = str(e)
                time_sleep = self._retry(attempt)
                import time; time.sleep(time_sleep)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                import time; time.sleep(self._retry(attempt))
                continue
            if r.status_code != 200:
                raise RuntimeError(f"LLM API {r.status_code}: {r.text[:300]}")
            d = r.json()
            if self.cfg.api_type == "anthropic":
                # 网关可能以 200 包装错误体——识别并显式报错，避免静默空结果
                if "error" in d or ("content" not in d and "type" not in d):
                    raise RuntimeError(f"LLM 返回异常: {r.text[:200]}")
                usage = d.get("usage", {})
                text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
            else:
                usage = d.get("usage", {}) or {}
                if "choices" not in d:
                    # OpenAI 兼容网关也可能以 200 包装错误体
                    raise RuntimeError(f"LLM 返回异常: {r.text[:200]}")
                text = d["choices"][0]["message"]["content"] if d.get("choices") else ""
            _log_usage(self.user_id, self.cfg, usage, self.paper_id)
            return text
        raise RuntimeError(f"LLM 调用重试后仍失败: {last_err or 'rate limited'}")

    def stream(self, messages: list[dict], max_tokens: int = 4096) -> Iterator[str]:
        """流式（SSE）； yielded 为文本增量。"""
        req = self._request(messages, max_tokens, stream=True)
        usage: dict = {}
        r = self._http.send(req, stream=True)
        try:
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"LLM API {r.status_code}")
            if r.status_code != 200:
                raise RuntimeError(f"LLM API {r.status_code}: {r.read()[:300]}")
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    d = json.loads(payload)
                except ValueError:
                    continue
                if self.cfg.api_type == "anthropic":
                    if d.get("type") == "content_block_delta":
                        delta = d.get("delta", {})
                        yield delta.get("text", "") or delta.get("content", "") or ""
                    elif d.get("type") == "message_delta":
                        usage = d.get("usage", usage)
                else:
                    delta = d.get("choices", [{}])[0].get("delta", {})
                    yield delta.get("content", "") or ""
                    if d.get("usage"):
                        usage = d["usage"]
        finally:
            r.close()
        if usage:
            _log_usage(self.user_id, self.cfg, usage, self.paper_id)


def test_connection(base_url: str, api_key: str, model: str, api_type: str) -> tuple[bool, str]:
    """设置页"测试连接"：最小请求验证凭据。"""
    import httpx as _hx

    try:
        if api_type == "anthropic":
            url = base_url.rstrip("/")
            if url.endswith("/messages"):
                url = url[: -len("/messages")]
            if not url.endswith("/v1"):
                url += "/v1"
            url += "/messages"
            r = _hx.post(url, headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                         json={"model": model, "max_tokens": 8,
                               "messages": [{"role": "user", "content": "hi"}]}, timeout=30)
        else:
            url = base_url.rstrip("/")
            url = url if url.endswith("/chat/completions") else f"{url}/chat/completions"
            r = _hx.post(url, headers={"Authorization": f"Bearer {api_key}"},
                         json={"model": model, "max_tokens": 8,
                               "messages": [{"role": "user", "content": "hi"}]}, timeout=30)
        if r.status_code == 200:
            return True, "连接成功"
        if r.status_code == 401:
            return False, "认证失败（401）——请检查 key"
        return False, f"HTTP {r.status_code}: {r.text[:150]}"
    except _hx.HTTPError as e:
        return False, f"网络错误: {e}"
