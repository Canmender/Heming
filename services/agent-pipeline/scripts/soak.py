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
import random
import re
import queue
import statistics
import sys
import threading
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

    def __init__(self, fail_every: int = 0, *, tools: bool = False) -> None:
        self.calls = 0
        self.fail_every = fail_every
        # tools=True 时，每个步骤的第一次 execute 轮发一个工具调用（走真实的
        # ToolRuntime：schema 校验 → 幂等缓存 → 断路器 → 超时 → Observation），
        # 第二次才说「不需要工具」。这样工具链路（含审批闸）真的会在浸泡里被压。
        self.tools = tools
        self.tool_name = "knowledge_search"
        self._lock = threading.Lock()
        self._by_prompt = {
            PROMPTS["plan"]: {"steps": [{"goal": "直接回答", "done_when": "有一句结论"}]},
            PROMPTS["reflect"]: {"verdict": "done", "reasons": ["已给出结论"]},
            PROMPTS["critic"]: {"score": 0.9, "blocking_issues": []},
            PROMPTS["summarize"]: {"answer": "完成。", "citations": []},
            PROMPTS["adversarial_coder"]: {"summary": "补了用例"},
            PROMPTS["adversarial_tester"]: {"bugs": []},
        }

    def chat(self, messages, *, tools=None, temperature=0.2, max_tokens=2000) -> LLMResponse:
        # 并发浸泡时会多线程同时调模型：计数必须原子，否则 fail_every 的节拍会漂。
        with self._lock:
            self.calls += 1
            calls = self.calls
        if self.fail_every and calls % self.fail_every == 0:
            raise LLMError("模拟上游 500（浸泡测试注入）")
        system = str(messages[0].get("content", "")) if messages else ""
        if system == PROMPTS["execute"]:
            if self.tools:
                # execute 的 user 消息里带「本步骤剩余工具调用预算：N」：
                # N 等于满额就说明这一步还没调过工具 → 发一个调用；否则收尾。
                tail = str(messages[-1].get("content", "")) if messages else ""
                match = re.search(r"剩余工具调用预算：(\d+)", tail)
                if match and int(match.group(1)) >= 6:
                    name = self.tool_name
                    return LLMResponse(
                        text="",
                        tool_calls=[
                            {
                                "id": f"call-{calls}",
                                "name": name,
                                # 参数带上调用序号：否则幂等缓存会命中，工具根本没真的跑
                                # （浸泡就变成了「只测缓存」，测不到 ToolRuntime 与 SQLite）。
                                "arguments": (
                                    {"query": f"安装器 通用外壳 {calls}"}
                                    if name == "knowledge_search"
                                    else {"command": f"echo soak {calls}"}
                                ),
                            }
                        ],
                        prompt_tokens=40,
                        completion_tokens=8,
                    )
            return LLMResponse(text="这一步不需要工具。", prompt_tokens=40, completion_tokens=8)
        payload = self._by_prompt.get(system, {"answer": "完成。", "citations": []})
        return LLMResponse(
            text=json.dumps(payload, ensure_ascii=False),
            prompt_tokens=60,
            completion_tokens=20,
        )


def _escalating_coverage():
    """对抗模式用的假覆盖率：第 1 轮 0.5、第 2 轮 0.95，之后维持 0.95。

    以前 `--mode adversarial` 不接覆盖率，`adversarial_node` 每轮都拿 None、
    两轮后以 `coverage_command_failed` 收口——浸泡照样报 0 失败，但对抗环其实
    一次都没验到「覆盖率达标」。现在给一个会攀升的假数字，第 2 轮就能真的通过。
    """
    state = {"n": 0}
    lock = threading.Lock()

    def runner() -> dict:
        with lock:
            state["n"] += 1
            round_no = state["n"]
        coverage = 0.5 if round_no == 1 else 0.95
        return {"coverage": coverage, "output": f"TOTAL {int(coverage * 100)}%", "ok": True}

    return runner


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
        "--concurrency",
        type=int,
        default=1,
        help="并发跑 run 的工作线程数（默认 1 = 顺序；用来验证状态机/SQLite/指标在并发下不互相踩）",
    )
    parser.add_argument(
        "--tools",
        action="store_true",
        help="每个步骤真的调用一次工具（knowledge_search；配合 --approval 走写工具），验证工具链路在负载下不飘",
    )
    parser.add_argument(
        "--approval",
        action="store_true",
        help="开启工具审批闸并自动批准（验证 HITL 挂起/裁决在负载下可用）",
    )
    parser.add_argument(
        "--cancel-rate",
        type=float,
        default=0.0,
        help="按比例模拟「用户中途取消」（例如 0.1 = 每 10 个 run 取消 1 个），验证取消收口在负载下不漏线程/不漏日志",
    )
    parser.add_argument(
        "--canary",
        action="store_true",
        help="注册一个灰度版本并让全部流量走它（配合 --fail-rate 验证回滚真的会发生）",
    )
    parser.add_argument(
        "--log",
        default="",
        metavar="PATH",
        help="把每个 run 的 JSONL 写到这个文件（默认丢弃）：有了它，`agent-pipeline tune --log PATH` 可以直接拿浸泡日志做调优输入",
    )
    args = parser.parse_args(argv)

    fail_every = round(1 / args.fail_rate) if args.fail_rate > 0 else 0
    if args.approval:
        os.environ["AGENT_PIPELINE_ALLOW_COMMANDS"] = "1"  # 只为--approval 打开 run_command（命令固定 echo）
    log_path = os.devnull
    if args.log:
        log_file = Path(args.log).expanduser()
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_path = str(log_file)
    settings = Settings(
        log_path=log_path,
        db_path=":memory:",
        # 灰度验证：全量走 canary，样本门槛压低到 20（与线上默认一致），阈值仍用默认
        **({"canary_ratio": 1.0} if args.canary else {}),
    )
    llm = CycleLLM(fail_every=fail_every, tools=args.tools)
    if args.approval:
        llm.tool_name = "run_command"  # 写工具才会挂审批闸
    memory = MemoryStore(":memory:")
    if args.tools:
        # 知识库里有真文档，knowledge_search 才会命中并带引用（否则只测到「空结果」）。
        memory.add_document(
            "doc-soak",
            "和鸣安装器的通用外壳：双击后读更新服务器上的 latest.yml，安装包已就绪再静默安装内层包。",
            title="浸泡知识",
        )
    metrics = Metrics()
    config_store = ConfigStore(":memory:")
    runtime = build_runtime(
        settings,
        llm=llm,
        memory=memory,
        metrics=metrics,
        config_store=config_store,
        # 对抗模式必须接一个真实（这里是会攀升的假）覆盖率：否则两轮都拿不到数字，
        # 会以 coverage_command_failed 收口，看起来「0 失败」其实什么都没验到。
        coverage_runner=_escalating_coverage() if args.mode == "adversarial" else None,
        # 不写文件时才丢弃；写了文件就走 runtime 的落盘路径，tune 才能读到
        log_sink=None if args.log else (lambda _row: None),
    )
    gate = None
    approver_stop = threading.Event()
    approved_lock = threading.Lock()
    approved_count = {"n": 0}
    if args.approval:
        from agent_pipeline.approval import ApprovalGate

        gate = ApprovalGate(timeout_s=30.0)
        runtime.approval = gate

        approved_count = {"n": 0}

        def _auto_approve() -> None:
            """模拟用户一直点「允许」：把挂起的裁决立刻批准，避免浸泡卡在超时上。"""
            while not approver_stop.is_set():
                for item in gate.pending():
                    if gate.resolve(item["run_id"], item["call_id"], True):
                        with approved_lock:
                            approved_count["n"] += 1
                approver_stop.wait(0.005)

        threading.Thread(target=_auto_approve, daemon=True).start()

    canary_id = None
    if args.canary:
        config_store.register(PROMPTS, promote=True)  # 先有一个 active 版本可回滚
        candidate = config_store.register(PROMPTS, promote=False)
        config_store._set_stage(candidate.id, "canary")  # noqa: SLF001 - 与 tune 的灰度口径一致
        canary_id = candidate.id
    cancel_flags: dict[str, threading.Event] = {}
    cancel_lock = threading.Lock()
    if args.cancel_rate > 0:
        # 协作式取消：节点入口检查这个标志；取消后 summarize 仍会跑，给出「取消前已完成的内容」。
        runtime.cancel = lambda rid: bool(
            (flag := cancel_flags.get(rid)) is not None and flag.is_set()
        )
    task = TaskSpec(goal="浸泡测试：给出结论", mode=args.mode)

    tracemalloc.start()
    durations: list[float] = []
    failures: list[str] = []
    result_lock = threading.Lock()
    cancelled_count = {"n": 0}
    # 收口原因分布：只看「失败数」不够——`stop_reason` 才是「为什么停」，
    # 比如对抗模式以前全落在 coverage_command_failed 却仍算 0 失败。
    stop_reasons: dict[str, int] = {}
    work: queue.Queue[int] = queue.Queue()
    for index in range(args.runs):
        work.put(index)

    def _worker() -> None:
        while True:
            try:
                index = work.get_nowait()
            except queue.Empty:
                return
            run_id = f"soak-{index:06d}"
            t0 = time.perf_counter()
            timer = None
            if args.cancel_rate > 0 and random.random() < args.cancel_rate:
                flag = threading.Event()
                with cancel_lock:
                    cancel_flags[run_id] = flag
                # 5~15ms 后取消：足够让 run 已经进了节点（否则取消会落到第一轮之前，测不到中途取消）。
                timer = threading.Timer(random.uniform(0.005, 0.015), flag.set)
                timer.daemon = True
                timer.start()
            try:
                result, row = run_once(runtime, task, run_id=run_id)
                cancelled = result.status == "aborted" and row.get("stop_reason") == "cancelled"
                with result_lock:
                    reason = str(result.stop_reason or "done")
                    stop_reasons[reason] = stop_reasons.get(reason, 0) + 1
                if cancelled:
                    with result_lock:
                        cancelled_count["n"] += 1
                elif result.status not in ("ok", "budget"):
                    with result_lock:
                        failures.append(f"{index}:{result.status}:{result.error}")
            except Exception as exc:  # noqa: BLE001 - 浸泡测试要把所有异常都记下来
                with result_lock:
                    failures.append(f"{index}:{type(exc).__name__}:{exc}")
            finally:
                if timer is not None:
                    timer.cancel()
                    with cancel_lock:
                        cancel_flags.pop(run_id, None)
            with result_lock:
                durations.append(time.perf_counter() - t0)

    workers = max(1, args.concurrency)
    started = time.perf_counter()
    threads = [threading.Thread(target=_worker, daemon=True) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
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
    metrics_text = metrics.expose().decode() if isinstance(metrics.expose(), bytes) else metrics.expose()
    tool_calls = sum(
        float(match.group(1)) for match in re.finditer(r'pipeline_tool_calls_total\{[^}]*\}\s+([0-9.]+)', metrics_text)
    )
    summary = {
        "runs": args.runs,
        "tool_calls": int(tool_calls),
        "approvals": approved_count["n"],
        "concurrency": max(1, args.concurrency),
        "rollbacks": rollbacks,
        "canary_stage": (
            config_store.get(canary_id).stage if canary_id is not None and config_store.get(canary_id) else None
        ),
        "cancelled": cancelled_count["n"],
        "stop_reasons": dict(sorted(stop_reasons.items())),
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
        print(
            f"  runs            : {summary['runs']}（并发 {summary['concurrency']}，"
            f"{summary['runs_per_s']}/s，总耗时 {summary['elapsed_s']}s）"
        )
        print(f"  失败            : {summary['failures']} {summary['failure_samples']}")
        print(f"  收口原因        : {summary['stop_reasons']}")
        print(f"  P50 / P95       : {summary['p50_ms']}ms / {summary['p95_ms']}ms")
        if args.cancel_rate > 0:
            print(f"  中途取消        : {summary['cancelled']} 个 run（协作式收口，仍出「取消前已完成的内容」）")
        print(f"  模型调用次数    : {summary['llm_calls']}")
        if args.tools:
            print(
                f"  工具调用次数    : {summary['tool_calls']}"
                f"（审批{'开启，自动批准 ' + str(summary['approvals']) + ' 次' if args.approval else '关闭'}）"
            )
        print(f"  记忆条目        : {summary['memory_rows']}（有上限：超过 max_episodes 会 prune 最旧）")
        if args.canary:
            print(f"  自动回滚        : {summary['rollbacks']} 次（canary 版本最终 {summary['canary_stage']}）")
        print(f"  内存峰值/当前   : {summary['peak_mem_mb']}MB / {summary['current_mem_mb']}MB")
    approver_stop.set()
    # --log 的「静默成功」是最坑的：跑完说 0 失败，结果日志一份没写，
    # 后面 tune 读空文件出「0 个失败样本」的报告看起来也正常。
    if args.log:
        written = 0
        log_file = Path(args.log).expanduser()
        if log_file.exists():
            try:
                written = sum(1 for line in log_file.read_text(encoding="utf-8").splitlines() if line.strip())
            except OSError:
                written = 0
        if written < args.runs:
            print(
                f"[soak] 警告：--log 只写进 {written}/{args.runs} 行（{log_file}）；"
                f"runtime.log_failures={runtime.log_failures}，最后一个错误：{runtime.log_last_error}",
                file=sys.stderr,
            )
            return 1
    return 0 if len(failures) <= args.max_failures else 1


if __name__ == "__main__":
    raise SystemExit(main())