"""LLM 客户端：OpenAI 兼容实现 + 可脚本化的假实现。

节点只依赖 ``LLMClient.chat`` 这一个方法，所以测试里完全不需要网络。
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


@dataclass
class LLMResponse:
    text: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    raw: dict[str, Any] | None = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMError(RuntimeError):
    """模型调用失败（网络、鉴权、限流、返回格式）。"""


class LLMClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2000,
    ) -> LLMResponse: ...


@dataclass
class FakeLLM:
    """按脚本返回响应；脚本用完就报错，避免测试里静默空转。

    ``script`` 的元素可以是：
    - ``dict``：直接当 LLMResponse 的字段（``{"text": "...", "tool_calls": [...]}``）；
    - ``str``：当作纯文本；
    - ``callable``：``fn(messages, tools) -> dict | str``，用于按上下文分支。
    """

    script: list[Any]
    model: str = "fake"
    calls: list[dict[str, Any]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        with self._lock:
            if not self.script:
                raise LLMError("FakeLLM 脚本已用尽（测试需要更多响应）")
            item = self.script.pop(0)
            self.calls.append({"messages": messages, "tools": tools, "item": item})
        if callable(item):
            item = item(messages, tools)
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise LLMError(f"FakeLLM 脚本元素类型不支持：{type(item).__name__}")
        text = str(item.get("text", ""))
        return LLMResponse(
            text=text,
            tool_calls=list(item.get("tool_calls") or []),
            prompt_tokens=int(item.get("prompt_tokens", max(1, len(json.dumps(messages, ensure_ascii=False)) // 4))),
            completion_tokens=int(item.get("completion_tokens", max(1, len(text) // 4))),
            model=self.model,
        )

    @property
    def remaining(self) -> int:
        return len(self.script)


class OpenAICompatClient:
    """OpenAI 兼容的 /chat/completions 客户端（DeepSeek、Moonshot、vLLM 都适用）。"""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        model: str = "deepseek-chat",
        timeout_s: float = 90.0,
        max_retries: int = 2,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get("AGENT_PIPELINE_API_KEY", "")
        self.model = model
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        import requests

        if not self.api_key:
            raise LLMError("缺少 API Key（设置 AGENT_PIPELINE_API_KEY 或传 api_key）")
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = requests.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=self.timeout_s,
                )
            except Exception as exc:  # noqa: BLE001 - 网络异常统一包装
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
                continue
            if response.status_code == 200:
                return _parse_response(response.json(), self.model)
            if response.status_code in (429, 500, 502, 503, 504):
                last_error = LLMError(f"HTTP {response.status_code}: {response.text[:300]}")
                time.sleep(0.5 * (attempt + 1))
                continue
            raise LLMError(f"HTTP {response.status_code}: {response.text[:300]}")
        raise LLMError(f"模型调用失败：{last_error}")


def _parse_response(data: dict[str, Any], model: str) -> LLMResponse:
    choices = data.get("choices") or []
    if not choices:
        raise LLMError(f"响应里没有 choices：{json.dumps(data, ensure_ascii=False)[:300]}")
    message = choices[0].get("message") or {}
    text = message.get("content") or ""
    if isinstance(text, list):  # 某些兼容实现会返回分段
        text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
    tool_calls = [
        {
            "id": call.get("id") or f"call_{index}",
            "name": (call.get("function") or {}).get("name", ""),
            "arguments": _parse_args((call.get("function") or {}).get("arguments")),
        }
        for index, call in enumerate(message.get("tool_calls") or [])
    ]
    usage = data.get("usage") or {}
    return LLMResponse(
        text=text,
        tool_calls=tool_calls,
        prompt_tokens=int(usage.get("prompt_tokens", 0)),
        completion_tokens=int(usage.get("completion_tokens", 0)),
        model=data.get("model", model),
        raw=data,
    )


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LLMError(f"工具参数不是合法 JSON：{raw[:200]}") from exc
    if not isinstance(value, dict):
        raise LLMError("工具参数必须是 JSON 对象")
    return value


def build_llm(settings: Any) -> LLMClient:
    """按配置造客户端；没有 Key 时直接报错，而不是偷偷降级成假模型。"""
    api_key = os.environ.get(settings.api_key_env, "")
    return OpenAICompatClient(base_url=settings.base_url, api_key=api_key, model=settings.model)