"""工具层：注册表、JSON Schema 校验、Function Calling、幂等、超时、断路器。

一次调用的顺序是固定的，任何一步失败都要落成 ``Observation(ok=False, ...)``
（不抛给上层，避免一次工具失败把整个 run 打炸）：

    schema 校验 → 幂等命中 → 断路器 → 执行（超时） → 记录指标
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from .protocol import Citation, Observation, Risk, ToolRequest, idempotency_key


class ToolError(Exception):
    """工具执行失败（会变成 Observation.error）。"""


class SchemaError(ToolError):
    """参数不符合 JSON Schema。"""


@dataclass
class ToolSpec:
    name: str
    description: str
    schema: dict[str, Any]
    risk: Risk
    handler: Callable[[dict[str, Any]], Any]
    timeout_s: float = 20.0
    idempotent: bool = True

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.schema,
            },
        }


_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "null": type(None),
}


def validate_schema(value: Any, schema: dict[str, Any], path: str = "$") -> None:
    """轻量 JSON Schema 校验：只支持本项目用到的子集，但**严格**（未知字段报错）。"""
    expected = schema.get("type")
    if expected:
        types = expected if isinstance(expected, list) else [expected]
        py_types = tuple(_TYPES[t] for t in types if t in _TYPES)
        # bool 是 int 的子类，integer 要排除 bool
        if py_types and isinstance(value, bool) and bool not in py_types:
            raise SchemaError(f"{path} 期望 {expected}，收到 boolean")
        if py_types and not isinstance(value, py_types):
            raise SchemaError(f"{path} 期望 {expected}，收到 {type(value).__name__}")
    if isinstance(value, dict):
        properties: dict[str, Any] = schema.get("properties") or {}
        required: list[str] = schema.get("required") or []
        for key in required:
            if key not in value:
                raise SchemaError(f"{path}.{key} 是必填字段")
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(properties)
            if extra:
                raise SchemaError(f"{path} 出现未知字段：{sorted(extra)}")
        for key, sub in properties.items():
            if key in value:
                validate_schema(value[key], sub, f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            validate_schema(item, schema["items"], f"{path}[{index}]")
    enum = schema.get("enum")
    if enum is not None and value not in enum:
        raise SchemaError(f"{path} 必须是 {enum} 之一，收到 {value!r}")


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}
        self._lock = threading.RLock()

    def register(self, spec: ToolSpec) -> ToolSpec:
        with self._lock:
            if spec.name in self._tools:
                raise ValueError(f"工具重复注册：{spec.name}")
            self._tools[spec.name] = spec
        return spec

    def tool(
        self,
        *,
        name: str,
        description: str,
        schema: dict[str, Any],
        risk: Risk = "read",
        timeout_s: float = 20.0,
        idempotent: bool = True,
    ) -> Callable[[Callable[[dict[str, Any]], Any]], Callable[[dict[str, Any]], Any]]:
        def decorator(fn: Callable[[dict[str, Any]], Any]) -> Callable[[dict[str, Any]], Any]:
            self.register(
                ToolSpec(
                    name=name,
                    description=description,
                    schema=schema,
                    risk=risk,
                    handler=fn,
                    timeout_s=timeout_s,
                    idempotent=idempotent,
                )
            )
            return fn

        return decorator

    def get(self, name: str) -> ToolSpec:
        with self._lock:
            spec = self._tools.get(name)
        if spec is None:
            raise ToolError(f"没有这个工具：{name}")
        return spec

    def names(self) -> list[str]:
        with self._lock:
            return sorted(self._tools)

    def openai_tools(self, allow: Iterable[str] | None = None) -> list[dict[str, Any]]:
        allow_set = set(allow) if allow is not None else None
        with self._lock:
            specs = [s for s in self._tools.values() if allow_set is None or s.name in allow_set]
        return [s.openai_schema() for s in sorted(specs, key=lambda s: s.name)]

    def describe(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {"name": s.name, "description": s.description[:200], "risk": s.risk}
                for s in sorted(self._tools.values(), key=lambda s: s.name)
            ]


@dataclass
class _Breaker:
    failures: int = 0
    opened_at: float | None = None
    half_open: bool = False

    def is_open(self, threshold: int, cooldown_s: float, now: float) -> bool:
        if self.opened_at is None:
            return False
        if now - self.opened_at >= cooldown_s:
            self.half_open = True
            return False
        return True


@dataclass
class ToolStats:
    calls: int = 0
    errors: int = 0
    short_circuits: int = 0
    timeouts: int = 0
    cache_hits: int = 0
    total_ms: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "calls": self.calls,
            "errors": self.errors,
            "short_circuits": self.short_circuits,
            "timeouts": self.timeouts,
            "cache_hits": self.cache_hits,
            "total_ms": self.total_ms,
        }


def _citations_of(result: Any) -> list[Citation]:
    """工具结果里可以带 ``citations``（RAG 检索的来源）：转成 Citation，字段坏的丢掉。"""
    if not isinstance(result, dict):
        return []
    raw = result.get("citations")
    if not isinstance(raw, list):
        return []
    out: list[Citation] = []
    for item in raw[:16]:
        if not isinstance(item, dict):
            continue
        doc_id = str(item.get("doc_id", "") or "")
        chunk = item.get("chunk", 0)
        if not doc_id or not isinstance(chunk, int):
            continue
        out.append(Citation(doc_id=doc_id, chunk=chunk, quote=str(item.get("quote", ""))[:400]))
    return out


class ToolRuntime:
    """执行工具，并把所有异常路径收敛成 Observation。"""

    def __init__(
        self,
        registry: ToolRegistry,
        *,
        circuit_threshold: int = 5,
        circuit_cooldown_s: float = 30.0,
        idempotency_ttl_s: float = 600.0,
        idempotency_max_entries: int = 1000,
        default_timeout_s: float = 20.0,
        metrics_hook: Callable[[str, str, float], None] | None = None,
    ) -> None:
        self.registry = registry
        self.circuit_threshold = circuit_threshold
        self.circuit_cooldown_s = circuit_cooldown_s
        # 幂等缓存只按 TTL 过期在真实流量下不够：10 万次调用里参数几乎不重复，
        # 600 秒窗口内就能堆几万条 Observation（每条都带结果文本）。所以同时给条数封顶。
        self.idempotency_ttl_s = idempotency_ttl_s
        self.idempotency_max_entries = idempotency_max_entries
        self.default_timeout_s = default_timeout_s
        self.metrics_hook = metrics_hook
        self._cache: dict[str, tuple[float, Observation]] = {}
        self._breakers: dict[str, _Breaker] = {}
        self._stats: dict[str, ToolStats] = {}
        # 指标标签是有界的：tool 名来自模型输出（可能被幻觉成任意字符串），
        # 直接当 label 会让 Prometheus 的时序数随调用量无限涨。
        self._metric_labels: set[str] = set()
        self._lock = threading.RLock()
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tool")

    # ---- 对外 -------------------------------------------------------------

    MAX_TOOL_METRIC_LABELS = 32

    def _metric_label(self, name: str) -> str:
        """把工具名压到有界的标签集合里。

        模型可能调用不存在的工具（``fs__lisst_dir`` 这种），每次幻觉都是一个新名字；
        直接当 label 会给 Prometheus 造出无上限的时序（内存和抓取时间都会涨）。
        已注册的工具名是代码里写死的、天然有界；其余归到 ``other``。
        """
        try:
            self.registry.get(name)
        except ToolError:
            return "unknown"
        if name in self._metric_labels:
            return name
        if len(self._metric_labels) < self.MAX_TOOL_METRIC_LABELS:
            self._metric_labels.add(name)
            return name
        return "other"

    def execute(self, request: ToolRequest) -> Observation:
        started = time.monotonic()
        stats = self._stats.setdefault(request.name, ToolStats())
        with self._lock:
            stats.calls += 1

        try:
            spec = self.registry.get(request.name)
        except ToolError as exc:
            return self._observe(request, started, ok=False, error=str(exc), stats=stats)

        # 1. schema
        try:
            validate_schema(request.arguments, spec.schema)
        except SchemaError as exc:
            return self._observe(request, started, ok=False, error=f"参数不合法：{exc}", stats=stats)

        # 2. 幂等
        key = idempotency_key(request.name, request.arguments)
        if spec.idempotent:
            with self._lock:
                hit = self._cache.get(key)
                if hit and time.monotonic() - hit[0] <= self.idempotency_ttl_s:
                    stats.cache_hits += 1
                    cached = hit[1]
                    if self.metrics_hook is not None:
                        # 单独记 cached：缓存命中不是一次真实执行，混进 ok 会让
                        # 「工具到底调了几次」和「真的跑了几次」分不清。
                        self.metrics_hook(self._metric_label(request.name), "cached", 0.0)
                    return Observation(
                        call_id=request.call_id,
                        tool=cached.tool,
                        ok=cached.ok,
                        result=cached.result,
                        error=cached.error,
                        duration_ms=0,
                        citations=list(cached.citations),
                    )

        # 3. 断路器
        breaker = self._breakers.setdefault(request.name, _Breaker())
        now = time.monotonic()
        if breaker.is_open(self.circuit_threshold, self.circuit_cooldown_s, now):
            with self._lock:
                stats.short_circuits += 1
            return self._observe(
                request,
                started,
                ok=False,
                error=f"工具 {request.name} 熔断中（连续失败过多，稍后重试）",
                stats=stats,
            )

        # 4. 执行
        timeout = spec.timeout_s or self.default_timeout_s
        try:
            future = self._pool.submit(spec.handler, dict(request.arguments))
            result = future.result(timeout=timeout)
        except FutureTimeout:
            with self._lock:
                stats.timeouts += 1
            self._trip(breaker, success=False)
            return self._observe(
                request, started, ok=False, error=f"工具超时（>{timeout:g}s）", stats=stats
            )
        except ToolError as exc:
            self._trip(breaker, success=False)
            return self._observe(request, started, ok=False, error=str(exc), stats=stats)
        except Exception as exc:  # noqa: BLE001 - 工具异常一律转成观测值
            self._trip(breaker, success=False)
            return self._observe(
                request, started, ok=False, error=f"{type(exc).__name__}: {exc}", stats=stats
            )

        self._trip(breaker, success=True)
        observation = self._observe(request, started, ok=True, result=result, stats=stats)
        if spec.idempotent:
            self._store_cached(key, observation)
        return observation

    def _store_cached(self, key: str, observation: Observation) -> None:
        """写幂等缓存，并把它控制在 `idempotency_max_entries` 条以内（先清过期、再按插入序丢最旧）。"""
        with self._lock:
            self._cache[key] = (time.monotonic(), observation)
            limit = self.idempotency_max_entries
            if limit <= 0:
                return
            if len(self._cache) <= limit:
                return
            now = time.monotonic()
            for stale in [k for k, (at, _) in self._cache.items() if now - at > self.idempotency_ttl_s]:
                self._cache.pop(stale, None)
            while len(self._cache) > limit:
                oldest = next(iter(self._cache))
                self._cache.pop(oldest, None)

    # ---- 内部 -------------------------------------------------------------

    def _trip(self, breaker: _Breaker, *, success: bool) -> None:
        with self._lock:
            if success:
                breaker.failures = 0
                breaker.opened_at = None
                breaker.half_open = False
                return
            breaker.failures += 1
            if breaker.failures >= self.circuit_threshold and breaker.opened_at is None:
                breaker.opened_at = time.monotonic()

    def _observe(
        self,
        request: ToolRequest,
        started: float,
        *,
        ok: bool,
        result: Any = None,
        error: str | None = None,
        stats: ToolStats,
    ) -> Observation:
        duration_ms = int((time.monotonic() - started) * 1000)
        with self._lock:
            if not ok:
                stats.errors += 1
            stats.total_ms += duration_ms
        if self.metrics_hook is not None:
            self.metrics_hook(self._metric_label(request.name), "ok" if ok else "error", duration_ms / 1000)
        return Observation(
            call_id=request.call_id,
            tool=request.name,
            ok=ok,
            result=result,
            error=error,
            duration_ms=duration_ms,
            citations=_citations_of(result),
        )

    def stats(self) -> dict[str, dict[str, int]]:
        with self._lock:
            return {name: s.to_dict() for name, s in self._stats.items()}

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------------------
# 内置工具：够用就好，危险动作（写盘/执行命令）默认走命令白名单。
# ---------------------------------------------------------------------------


def build_default_registry(*, allow_commands: bool = False, memory: Any = None) -> ToolRegistry:
    registry = ToolRegistry()

    @registry.tool(
        name="http_get",
        description="对给定 URL 发起 GET 请求，返回状态码与截断后的正文。",
        risk="net",
        schema={
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "timeout_s": {"type": "number"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    )
    def http_get(args: dict[str, Any]) -> Any:
        import requests

        url = str(args["url"])
        if not url.startswith(("http://", "https://")):
            raise ToolError("只支持 http/https")
        response = requests.get(url, timeout=float(args.get("timeout_s", 15)), headers={"User-Agent": "agent-pipeline/0.1"})
        body = response.text[:8000]
        return {"status": response.status_code, "body": body}

    @registry.tool(
        name="run_command",
        description="在工作目录执行一条命令并返回退出码与输出（默认禁用，需要显式开启白名单）。",
        risk="write",
        schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_s": {"type": "number"},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
        idempotent=False,
    )
    def run_command(args: dict[str, Any]) -> Any:
        if not allow_commands:
            raise ToolError("run_command 未启用（服务端需显式开启）")
        return run_shell(str(args["command"]), timeout_s=float(args.get("timeout_s", 60)))

    if memory is not None:
        # RAG：让模型能主动翻知识库（而不是只能靠 plan 阶段被动注入的记忆）。
        # 返回里带 citations，摘要阶段只保留「观测里真的出现过」的来源，避免编造出处。
        @registry.tool(
            name="knowledge_search",
            description="在知识库里检索相关片段，返回命中文本与来源编号。",
            risk="read",
            schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        )
        def knowledge_search(args: dict[str, Any]) -> Any:
            query = str(args["query"]).strip()
            if not query:
                raise ToolError("query 不能为空")
            limit = int(args.get("limit", 5))
            limit = max(1, min(10, limit))
            hits = memory.search(query, limit=limit)
            return {
                "hits": [
                    {
                        "text": hit.text[:600],
                        "kind": hit.kind,
                        "citations": [c.to_dict() for c in hit.citations],
                    }
                    for hit in hits
                ],
                "citations": [
                    citation
                    for hit in hits
                    for citation in (c.to_dict() for c in hit.citations)
                ],
            }

    return registry


def run_shell(command: str, *, cwd: str | None = None, timeout_s: float = 60.0) -> dict[str, Any]:
    """执行命令；失败也返回结构化结果（由调用方决定是否算 error）。"""
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "code": None,
            "timed_out": True,
            "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr": f"命令超时（>{timeout_s:g}s）",
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    return {
        "code": completed.returncode,
        "timed_out": False,
        "stdout": completed.stdout[-8000:],
        "stderr": completed.stderr[-4000:],
        "duration_ms": int((time.monotonic() - started) * 1000),
    }