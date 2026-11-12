"""运行配置：预算、阈值、版本化 Prompt 注册表。

所有阈值都能用环境变量覆盖（便于容器里调参），但**默认值必须是保守的**：
预算偏小、阈值偏严格，出错时宁可提前收口，也不要静默烧 token。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Any


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


DEFAULT_PLAN_PROMPT = """你是一个规划者（Planner）。把用户任务拆成 3-7 个可执行步骤。
要求：
1. 每一步都要写清「做什么」与「怎样算完成」（done_when）；
2. 只能使用给定工具清单里的工具，工具名必须完全一致；
3. 不要写代码，不要执行，只输出计划。
只输出 JSON：{"steps":[{"goal":"...","tools_hint":["tool"],"done_when":"..."}]}"""

DEFAULT_EXECUTE_PROMPT = """你是执行者（Executor）。按当前步骤调用工具完成任务。
- 只做当前这一步，不要提前做后面的步骤；
- 需要信息就调用工具，不要凭空假设；
- 工具返回的观测值才是事实。
只输出 JSON：{"thought":"...","tool_calls":[{"name":"...","arguments":{}}]}；不需要工具时 tool_calls 为空数组。"""

DEFAULT_REFLECT_PROMPT = """你是反思者（Reflector）。对照步骤的 done_when 判断当前进展。
只输出 JSON：{"verdict":"continue|done|replan|abort","reasons":["..."],"next_step":1}。
- done：所有步骤的 done_when 都已由观测值证明；
- replan：计划有结构性错误，需要重新规划（说明原因）；
- abort：任务无法完成（说明原因，不得编造）。"""

DEFAULT_CRITIC_PROMPT = """你是评审者（Critic）。评审当前产物。
只输出 JSON：{"score":0.0,"blocking_issues":["..."],"suggestions":["..."]}。
score 取 0-1；blocking_issues 只写确实会导致交付失败的问题。"""

DEFAULT_ADVERSARIAL_CODER_PROMPT = """你是实现者（Coder）。根据评审/测试给出的问题修改产物。
只输出 JSON：{"summary":"改了什么","patch":"完整文件内容或 unified diff"}。"""

DEFAULT_ADVERSARIAL_TESTER_PROMPT = """你是测试者（Tester）。找出产物里的缺陷并给出覆盖率。
只输出 JSON：{"bugs":[{"case":"...","expected":"...","actual":"..."}],"coverage":0.0,"command":"跑过的命令"}。
coverage 必须来自真实命令输出，取不到就填 null，不要猜。"""

DEFAULT_SUMMARIZE_PROMPT = """你是摘要者（Summarizer）。汇总本次任务。
只输出 JSON：{"answer":"给用户的答复","citations":[{"doc_id":"...","chunk":0}]}。
只能引用给定材料里出现过的事实，禁止新增。"""


PROMPTS: dict[str, str] = {
    "plan": DEFAULT_PLAN_PROMPT,
    "execute": DEFAULT_EXECUTE_PROMPT,
    "reflect": DEFAULT_REFLECT_PROMPT,
    "critic": DEFAULT_CRITIC_PROMPT,
    "adversarial_coder": DEFAULT_ADVERSARIAL_CODER_PROMPT,
    "adversarial_tester": DEFAULT_ADVERSARIAL_TESTER_PROMPT,
    "summarize": DEFAULT_SUMMARIZE_PROMPT,
}


@dataclass(frozen=True)
class Budget:
    """一次 run 的硬上限。任何一个耗尽都立即收口。"""

    max_steps: int = 8
    max_llm_calls: int = 40
    max_tokens: int = 120_000
    max_wall_clock_s: float = 600.0
    step_tool_budget: int = 6
    max_replans: int = 2
    max_adversarial_rounds: int = 2


@dataclass(frozen=True)
class Settings:
    """服务级配置（不含 Prompt；Prompt 走版本化注册表）。"""

    budget: Budget = field(default_factory=Budget)
    # 上下文装配
    max_observation_chars: int = 2000
    max_memory_items: int = 5
    # 记忆容量上限（超限删最旧；0 = 不限制，只建议测试里用）
    max_episodes: int = 5_000
    max_documents: int = 2_000
    # 评审与对抗
    critic_threshold: float = 0.6
    coverage_target: float = 0.9
    # 工具
    tool_timeout_s: float = 20.0
    tool_retries: int = 1
    circuit_threshold: int = 5
    circuit_cooldown_s: float = 30.0
    idempotency_ttl_s: float = 600.0
    # 工具审批（HITL）：off = 不拦；write = 非只读工具执行前等用户裁决
    approval_mode: str = "off"
    approval_timeout_s: float = 300.0
    # 服务
    max_concurrent_runs: int = 4
    # 回滚
    canary_ratio: float = 0.1
    error_threshold: float = 0.2
    latency_threshold_s: float = 120.0
    min_samples_for_rollback: int = 20
    # 调优
    tune_eval_budget: int = 20
    tune_enabled: bool = False          # 服务里是否启动每日调优线程
    tune_interval_s: float = 86_400.0   # 一天一次；测试里可以调小
    tune_window_hours: int = 24
    tune_out_path: str = ""             # 每轮报告的落盘位置；空 = 不落盘
    tune_eval_enabled: bool = False     # 用「回放 A/B」做真评测（开销 2 × tune_eval_budget 次流水线）
    # 模型
    model: str = field(default_factory=lambda: os.environ.get("AGENT_PIPELINE_MODEL", "deepseek-chat"))
    base_url: str = field(default_factory=lambda: os.environ.get("AGENT_PIPELINE_BASE_URL", "https://api.deepseek.com/v1"))
    api_key_env: str = "AGENT_PIPELINE_API_KEY"
    log_path: str = field(default_factory=lambda: os.environ.get("AGENT_PIPELINE_LOG", "runs.jsonl"))
    db_path: str = field(default_factory=lambda: os.environ.get("AGENT_PIPELINE_DB", "agent-pipeline.db"))

    @classmethod
    def from_env(cls) -> "Settings":
        budget = Budget(
            max_steps=_env_int("AGENT_MAX_STEPS", Budget.max_steps),
            max_llm_calls=_env_int("AGENT_MAX_LLM_CALLS", Budget.max_llm_calls),
            max_tokens=_env_int("AGENT_MAX_TOKENS", Budget.max_tokens),
            max_wall_clock_s=_env_float("AGENT_MAX_WALL_CLOCK_S", Budget.max_wall_clock_s),
            step_tool_budget=_env_int("AGENT_STEP_TOOL_BUDGET", Budget.step_tool_budget),
            max_replans=_env_int("AGENT_MAX_REPLANS", Budget.max_replans),
            max_adversarial_rounds=_env_int("AGENT_MAX_ADVERSARIAL_ROUNDS", Budget.max_adversarial_rounds),
        )
        return cls(
            budget=budget,
            coverage_target=_env_float("AGENT_COVERAGE_TARGET", cls.coverage_target),
            critic_threshold=_env_float("AGENT_CRITIC_THRESHOLD", cls.critic_threshold),
            max_concurrent_runs=_env_int("AGENT_MAX_CONCURRENCY", cls.max_concurrent_runs),
            canary_ratio=_env_float("AGENT_CANARY_RATIO", cls.canary_ratio),
            error_threshold=_env_float("AGENT_ERROR_THRESHOLD", cls.error_threshold),
            latency_threshold_s=_env_float("AGENT_LATENCY_THRESHOLD_S", cls.latency_threshold_s),
            min_samples_for_rollback=_env_int("AGENT_MIN_SAMPLES", cls.min_samples_for_rollback),
            tool_timeout_s=_env_float("AGENT_TOOL_TIMEOUT_S", cls.tool_timeout_s),
            approval_mode=os.environ.get("AGENT_APPROVAL_MODE", cls.approval_mode),
            approval_timeout_s=_env_float("AGENT_APPROVAL_TIMEOUT_S", cls.approval_timeout_s),
            max_episodes=_env_int("AGENT_MAX_EPISODES", cls.max_episodes),
            max_documents=_env_int("AGENT_MAX_DOCUMENTS", cls.max_documents),
            tune_enabled=_env_bool("AGENT_TUNE_ENABLED", cls.tune_enabled),
            tune_interval_s=_env_float("AGENT_TUNE_INTERVAL_S", cls.tune_interval_s),
            tune_window_hours=_env_int("AGENT_TUNE_WINDOW_HOURS", cls.tune_window_hours),
            tune_out_path=os.environ.get("AGENT_TUNE_OUT", cls.tune_out_path),
            tune_eval_enabled=_env_bool("AGENT_TUNE_EVAL", cls.tune_eval_enabled),
        )

    def with_budget(self, **kwargs: Any) -> "Settings":
        return replace(self, budget=replace(self.budget, **kwargs))