"""Memory ↔ Tool 交互协议。

节点之间**只传这些结构**，不传裸字符串：这样 run log 可重放、指标可聚合、
上下文装配有统一的截断规则，也不会出现「模型看到的东西和记录不一致」。

约定：
- 每条 ``Observation`` 由一次 ``ToolRequest`` 产生，``call_id`` 一一对应；
- 每条 ``MemoryRecord`` 都带 ``run_id`` 与 ``citations``，没有来源就不入库；
- 进模型上下文的工具结果一律走 ``Observation.render()``。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Literal

Risk = Literal["read", "write", "net"]
Status = Literal["ok", "error", "aborted", "budget"]


class ProtocolError(ValueError):
    """协议结构不合法（参数缺失、字段类型不对、引用不存在）。"""


def _require(cond: bool, message: str) -> None:
    if not cond:
        raise ProtocolError(message)


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_args(arguments: dict[str, Any]) -> str:
    """幂等键用：同一份 arguments 必须得到同一个串。"""
    return json_dumps(arguments or {})


def idempotency_key(tool: str, arguments: dict[str, Any]) -> str:
    digest = hashlib.sha256(f"{tool}:{canonical_args(arguments)}".encode("utf-8")).hexdigest()
    return f"{tool}:{digest[:32]}"


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json_object(text: str) -> dict[str, Any]:
    """从模型输出里取出 JSON 对象；容忍 ```json 包裹与前后闲聊。"""
    _require(isinstance(text, str) and text.strip() != "", "模型没有返回任何内容")
    candidate = text.strip()
    match = _JSON_FENCE.search(candidate)
    if match:
        candidate = match.group(1).strip()
    if not candidate.startswith("{"):
        start = candidate.find("{")
        end = candidate.rfind("}")
        _require(start >= 0 and end > start, f"模型输出里没有 JSON 对象：{text[:200]}")
        candidate = candidate[start : end + 1]
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:  # pragma: no cover - 错误路径靠测试覆盖
        raise ProtocolError(f"JSON 解析失败：{exc}；原文：{text[:200]}") from exc
    _require(isinstance(data, dict), "模型输出的 JSON 顶层必须是对象")
    return data


@dataclass
class Citation:
    doc_id: str
    chunk: int
    quote: str = ""

    def __post_init__(self) -> None:
        _require(bool(self.doc_id), "citation.doc_id 不能为空")
        _require(self.chunk >= 0, "citation.chunk 不能为负")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TaskSpec:
    goal: str
    cwd: str = "."
    constraints: list[str] = field(default_factory=list)
    mode: Literal["react", "adversarial"] = "react"
    coverage_target: float | None = None
    tools_allowed: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        _require(bool(self.goal.strip()), "task.goal 不能为空")
        if self.coverage_target is not None:
            _require(0.0 <= self.coverage_target <= 1.0, "coverage_target 必须在 0-1 之间")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PlanStep:
    id: int
    goal: str
    done_when: str
    tools_hint: list[str] = field(default_factory=list)
    status: Literal["pending", "running", "done", "failed"] = "pending"

    def __post_init__(self) -> None:
        _require(bool(self.goal.strip()), "plan step.goal 不能为空")
        _require(bool(self.done_when.strip()), f"计划第 {self.id} 步缺少 done_when")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ToolRequest:
    call_id: str
    name: str
    arguments: dict[str, Any]
    risk: Risk = "read"

    def __post_init__(self) -> None:
        _require(bool(self.call_id), "tool request.call_id 不能为空")
        _require(bool(self.name), "tool request.name 不能为空")
        _require(isinstance(self.arguments, dict), "tool request.arguments 必须是对象")
        _require(self.risk in ("read", "write", "net"), f"未知风险等级：{self.risk}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Observation:
    call_id: str
    tool: str
    ok: bool
    result: Any = None
    error: str | None = None
    duration_ms: int = 0
    citations: list[Citation] = field(default_factory=list)
    dropped_chars: int = 0

    def __post_init__(self) -> None:
        _require(bool(self.call_id), "observation.call_id 不能为空")
        _require(bool(self.tool), "observation.tool 不能为空")
        if self.ok:
            _require(self.error is None, "成功的 observation 不该带 error")

    def render(self, max_chars: int = 2000) -> str:
        """给模型看的视图：结构化、可截断，并显式标注被截断。"""
        body = self.result if self.error is None else f"ERROR: {self.error}"
        if not isinstance(body, str):
            body = json_dumps(body)
        if len(body) > max_chars:
            self.dropped_chars = len(body) - max_chars
            body = body[:max_chars] + f"…[截断 {self.dropped_chars} 字符]"
        state = "ok" if self.ok else "error"
        cites = "".join(f"[{c.doc_id}#{c.chunk}]" for c in self.citations)
        return f"observation({self.tool}, {state}, {self.duration_ms}ms){cites}\n{body}"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["citations"] = [c.to_dict() for c in self.citations]
        return data


@dataclass
class Reflection:
    verdict: Literal["continue", "done", "replan", "abort"]
    reasons: list[str] = field(default_factory=list)
    next_step: int | None = None
    lessons: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        _require(self.verdict in ("continue", "done", "replan", "abort"), f"未知 verdict：{self.verdict}")
        _require(isinstance(self.reasons, list), "reasons 必须是数组")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Critique:
    score: float
    blocking_issues: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        _require(0.0 <= self.score <= 1.0, "critique.score 必须在 0-1 之间")

    @property
    def blocking(self) -> bool:
        return self.score < 0.6 or bool(self.blocking_issues)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MemoryRecord:
    kind: Literal["episodic", "semantic", "lesson"]
    text: str
    run_id: str
    citations: list[Citation] = field(default_factory=list)
    importance: float = 0.5
    score: float = 0.0

    def __post_init__(self) -> None:
        _require(self.kind in ("episodic", "semantic", "lesson"), f"未知记忆类型：{self.kind}")
        _require(bool(self.text.strip()), "记忆内容不能为空")
        _require(bool(self.run_id), "记忆必须带 run_id")
        _require(0.0 <= self.importance <= 1.0, "importance 必须在 0-1 之间")

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "citations": [c.to_dict() for c in self.citations]}


@dataclass
class RunResult:
    run_id: str
    status: Status
    answer: str = ""
    plan: list[PlanStep] = field(default_factory=list)
    observations: list[Observation] = field(default_factory=list)
    reflections: list[Reflection] = field(default_factory=list)
    critiques: list[Critique] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    coverage: float | None = None
    llm_calls: int = 0
    tokens: int = 0
    config_version: int = 0
    error: str | None = None
    dropped_context: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "answer": self.answer,
            "plan": [s.to_dict() for s in self.plan],
            "observations": [o.to_dict() for o in self.observations],
            "reflections": [r.to_dict() for r in self.reflections],
            "critiques": [c.to_dict() for c in self.critiques],
            "citations": [c.to_dict() for c in self.citations],
            "coverage": self.coverage,
            "llm_calls": self.llm_calls,
            "tokens": self.tokens,
            "config_version": self.config_version,
            "error": self.error,
            "dropped_context": self.dropped_context,
        }


@dataclass
class ContextPack:
    text: str
    included: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)


def build_context(
    *,
    system: str,
    task: TaskSpec,
    plan: list[PlanStep],
    observations: Iterable[Observation],
    memories: Iterable[MemoryRecord],
    max_chars: int = 12_000,
    max_observations: int = 8,
) -> ContextPack:
    """按固定优先级装配上下文，超预算时先丢低价值内容并如实记录。

    优先级：system > task > plan > 最近 observation > 记忆（低分先丢）。
    """
    obs = list(observations)[-max_observations:]
    mem = sorted(memories, key=lambda m: m.score, reverse=True)

    # (预算优先级, 展示顺序, label, text)：预算先给固定项，再给最新观测，最后给记忆。
    entries: list[tuple[float, float, str, str]] = []
    entries.append((0.0, 0.0, "system", system))
    task_line = f"任务：{task.goal}"
    if task.constraints:
        task_line += "\n约束：" + "；".join(task.constraints)
    if task.cwd and task.cwd != ".":
        task_line += f"\n工作目录：{task.cwd}"
    entries.append((1.0, 1.0, "task", task_line))
    if plan:
        lines = [f"{s.id}. [{s.status}] {s.goal}（完成条件：{s.done_when}）" for s in plan]
        entries.append((2.0, 2.0, "plan", "计划：\n" + "\n".join(lines)))
    for display, item in enumerate(obs):
        # 越新的观测优先级越高；展示时仍按时间顺序。
        entries.append(
            (
                10.0 + float(len(obs) - 1 - display),
                3.0 + float(display),
                f"obs:{item.call_id}",
                item.render(max_chars // 2),
            )
        )
    for rank, record in enumerate(mem):
        entries.append((100.0 + float(rank), 1000.0 + float(rank), f"memory:{record.kind}", record.text))

    included: list[str] = []
    dropped: list[str] = []
    budget = max_chars
    accepted: list[tuple[float, str, str]] = []
    for _, display, label, text in sorted(entries, key=lambda item: (item[0], item[1])):
        if len(text) <= budget:
            accepted.append((display, label, text))
            included.append(label)
            budget -= len(text)
        else:
            dropped.append(label)
    accepted.sort(key=lambda item: item[0])
    chunks = [f"## {label}\n{text}" for _, label, text in accepted]
    # system 永远不能被丢：真丢不起就硬截断，但要显式标注。
    if "system" in dropped:
        dropped.remove("system")
        chunks.insert(0, f"## system\n{system[: max_chars // 2]}\n…[系统提示被截断]")
        included.insert(0, "system")
    return ContextPack(text="\n\n".join(chunks), included=included, dropped=dropped)