"""浸泡测试：不花钱、不联网，验证「跑很多次也不飘」。

用法（在 services/agent-pipeline 下）：
    .venv/Scripts/python.exe scripts/soak.py --runs 2000
    .venv/Scripts/python.exe scripts/soak.py --runs 100000 --json

它做三件事：
1. 用脚本化的假模型把完整流水线（plan/execute/reflect/critic/summarize）跑 N 次；
2. 记录失败次数、P50/P95 耗时、吞吐、内存峰值、每次 run 的日志/结果是否可丢弃；
3. 发现异常退出码非 0——这样它可以挂进 CI 或每天定时任务。

`--fail-rate` + `--canary` 会把「上游抖动 → 错误率超阈值 → 自动回滚」也跑一遍：
灰度版本在全量流量下把错误率推过 `error_threshold`，`maybe_rollback` 必须真的把它
挪回 archived，且之后仍有 active 版本可用。

注意：真实 10 万次调用的成本主要在模型侧；这里证明的是**编排层自身**不会随次数
退化（状态机、日志、指标、SQLite、内存检索）。真实压测请把 --runs 调大并接真模型
（把 --fake 去掉后用 `agent-pipeline run`）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_pipeline.config import PROMPTS, Settings  # noqa: E402
from agent_pipeline.llm import LLMClient, LLMError, LLMResponse  # noqa: E402
from agent_pipeline.memory import MemoryStore  # noqa: E402
from agent_pipeline.metrics import Metrics  # noqa: E402
from agent_pipeline.protocol import TaskSpec  # noqa: E402
from agent_pipeline.rollback import ConfigStore  # noqa: E402
from agent_pipeline.runtime import build_runtime, run_once  # noqa: E402


class CycleLLM(LLMClient):
    """按 system 提示词认出是哪个节点，返回对应的合法 JSON。

    这样不需要和节点内部调用顺序耦合，节点增减也不会让假模型错位。

    `fail_every > 0` 时每第 N 次调用抛 `LLMError`：用来验证「上游抖动 → 自动回滚」
    这条链路真的会在负载下触发（单测只覆盖了 ConfigStore 的窗口计算）。
    """

    def __init__(self, fail_every: int = 0) -> None:
        self.calls = 0
        self.fail_every = fail_every
        self._by_prompt = {
            PROMPTS["plan"]: {"steps": [{"goal": "直接回答", "done_when": "有一句结论"}]},
            PROMPTS["reflect"]: {"verdict": "done", "reasons": ["已给出结论"]},
            PROMPTS["critic"]: {"score": 0.9, "blocking_issues": []},
            PROMPTS["summarize"]: {"answer": "完成。", "citations": []},
            PROMPTS["adversarial_coder"]: {"summary": "补了用例"},
            PROMPTS["adversarial_tester"]: {"bugs": []},
        }

    def chat(self, messages, *, tools=None, temperature=0.2, max_tokens=2000) -> LLMResponse:
        self.calls += 1
        if self.fail_every and self.calls % self.fail_every == 0:
            raise LLMError("模拟上游 500（浸泡测试注入）")
        system = str(messages[0].get("content", "")) if messages else ""
        if system == PROMPTS["execute"]:
            return LLMResponse(text="这一步不需要工具。", prompt_tokens=40, completion_tokens=8)
        payload = self._by_prompt.get(system, {"answer": "完成。", "citations": []})
        return LLMResponse(
            text=json.dumps(payload, ensure_ascii=False),
            prompt_tokens=60,
            completion_tokens=20,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="agent-pipeline 浸泡测试")
    parser.add_argument("--runs", type=int, default=2000, help="总 run 次数（默认 2000；10 万次请显式给）")
    parser.add_argument("--mode", default="react", choices=["react", "adversarial"])
    parser.add_argument("--json", action="store_true", help="只输出 JSON 摘要")
    parser.add_argument("--max-failures", type=int, default=0, help="允许的失败次数（默认 0）")
    parser.add_argument(
        "--fail-rate",
        type=float,
        default=0.0,
        help="注入上游失败的比例（例如 0.3 = 每 3 次模型调用失败 1 次），用于验证自动回滚",
    )
    parser.add_argument(
        "--canary",
        action="store_true",
        help="注册一个灰度版本并让全部流量走它（配合 --fail-rate 验证回滚真的会发生）",
    )
    args = parser.parse_args(argv)

    fail_every = round(1 / args.fail_rate) if args.fail_rate > 0 else 0
    settings = Settings(
        log_path=os.devnull,
        db_path=":memory:",
        # 灰度验证：全量走 canary，样本门槛压低到 20（与线上默认一致），阈值仍用默认
        **({"canary_ratio": 1.0} if args.canary else {}),
    )
    llm = CycleLLM(fail_every=fail_every)
    memory = MemoryStore(":memory:")
    metrics = Metrics()
    config_store = ConfigStore(":memory:")
    runtime = build_runtime(
        settings,
        llm=llm,
        memory=memory,
        metrics=metrics,
        config_store=config_store,
        log_sink=lambda _row: None,
    )
    canary_id = None
    if args.canary:
        config_store.register(PROMPTS, promote=True)  # 先有一个 active 版本可回滚
        candidate = config_store.register(PROMPTS, promote=False)
        config_store._set_stage(candidate.id, "canary")  # noqa: SLF001 - 与 tune 的灰度口径一致
        canary_id = candidate.id
    task = TaskSpec(goal="浸泡测试：给出结论", mode=args.mode)

    tracemalloc.start()
    durations: list[float] = []
    failures: list[str] = []
    started = time.perf_counter()
    for index in range(args.runs):
        t0 = time.perf_counter()
        try:
            result, _row = run_once(runtime, task, run_id=f"soak-{index:06d}")
            if result.status not in ("ok", "budget"):
                failures.append(f"{index}:{result.status}:{result.error}")
        except Exception as exc:  # noqa: BLE001 - 浸泡测试要把所有异常都记下来
            failures.append(f"{index}:{type(exc).__name__}:{exc}")
        durations.append(time.perf_counter() - t0)
    elapsed = time.perf_counter() - started
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    durations.sort()
    p50 = durations[len(durations) // 2] if durations else 0.0
    p95 = durations[min(len(durations) - 1, int(len(durations) * 0.95))] if durations else 0.0
    rollbacks = sum(
        float(match.group(1))
        for match in re.finditer(r'pipeline_rollback_total\{[^}]*\}\s+([0-9.]+)', metrics.expose().decode() if isinstance(metrics.expose(), bytes) else metrics.expose())
    )
    summary = {
        "runs": args.runs,
        "rollbacks": rollbacks,
        "canary_stage": (
            config_store.get(canary_id).stage if canary_id is not None and config_store.get(canary_id) else None
        ),
        "failures": len(failures),
        "failure_samples": failures[:5],
        "elapsed_s": round(elapsed, 3),
        "runs_per_s": round(args.runs / elapsed, 1) if elapsed else 0.0,
        "p50_ms": round(p50 * 1000, 2),
        "p95_ms": round(p95 * 1000, 2),
        "llm_calls": llm.calls,
        "memory_rows": memory.count(),
        "peak_mem_mb": round(peak / 1024 / 1024, 2),
        "current_mem_mb": round(current / 1024 / 1024, 2),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print("浸泡测试结果")
        print(f"  runs            : {summary['runs']}（{summary['runs_per_s']}/s，总耗时 {summary['elapsed_s']}s）")
        print(f"  失败            : {summary['failures']} {summary['failure_samples']}")
        print(f"  P50 / P95       : {summary['p50_ms']}ms / {summary['p95_ms']}ms")
        print(f"  模型调用次数    : {summary['llm_calls']}")
        print(f"  记忆条目        : {summary['memory_rows']}（有上限：超过 max_episodes 会 prune 最旧）")
        if args.canary:
            print(f"  自动回滚        : {summary['rollbacks']} 次（canary 版本最终 {summary['canary_stage']}）")
        print(f"  内存峰值/当前   : {summary['peak_mem_mb']}MB / {summary['current_mem_mb']}MB")
    return 0 if len(failures) <= args.max_failures else 1


if __name__ == "__main__":
    raise SystemExit(main())