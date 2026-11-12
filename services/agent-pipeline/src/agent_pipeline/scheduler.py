"""每日调优调度器：把 `tune()` 从「手动跑一次」变成「服务自己每天跑一次」。

为什么要单独一层：
- `tune()` 本身是纯函数（读日志 → 出候选 → 评测 → 注册灰度版本），适合 CLI 和测试；
- 但用户要的是「根据日志**每天**自动微调」，这就需要有人按时间叫它，还要在服务里
  留下可观测的痕迹（跑过几次、成功没成功），否则没人知道它是否还活着。

红线不变：**绝不在线上直接改提示词**。调度器只调用 `tune()`，而 `tune()` 只在评测
有提升时注册一个 canary 版本，转正/回滚仍旧走 ConfigStore 的灰度窗口。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .config import PROMPTS, Settings
from .metrics import Metrics
from .nodes import Runtime
from .protocol import TaskSpec
from .rollback import ConfigStore
from .tune import TuneReport, classify, read_logs, tune


@dataclass
class ScheduleResult:
    """一次定时调优的结果：成功时 report 有值，失败时 error 有值，二者必有一个。"""

    report: TuneReport | None = None
    error: str | None = None
    ran_at: float = 0.0


class DailyTuner:
    """按 `settings.tune_interval_s` 周期跑 `tune()` 的后台线程。

    线程是 daemon：进程退出不会被它拖住；`stop()` 用 Event 让当前 sleep 立刻结束，
    这样测试和容器优雅停机都不用等满一天。
    """

    def __init__(
        self,
        *,
        settings: Settings,
        config_store: Any = None,
        log_path: str | None = None,
        out_path: str | None = None,
        evaluator: Callable[[dict[str, Any]], float | None] | None = None,
        metrics: Any = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self.config_store = config_store
        self.log_path = log_path or settings.log_path
        self.out_path = out_path or (settings.tune_out_path or None)
        self.evaluator = evaluator
        self.metrics = metrics
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last: ScheduleResult | None = None

    # ---- 单次 ---------------------------------------------------------------

    def run_once(self, *, since_hours: int | None = None, now: float | None = None) -> ScheduleResult:
        """跑一次调优，任何异常都收成 `ScheduleResult.error`（后台任务不能把异常抛出去）。"""
        window = since_hours if since_hours is not None else self.settings.tune_window_hours
        try:
            report = tune(
                log_path=self.log_path,
                out_path=self.out_path,
                since_hours=window,
                now=now if now is not None else self._clock(),
                evaluator=self.evaluator,
                config_store=self.config_store,
                current_payload={"prompts": dict(PROMPTS)},
            )
        except Exception as exc:  # noqa: BLE001 - 调度器必须活到下一次
            result = ScheduleResult(error=f"{type(exc).__name__}: {exc}", ran_at=self._clock())
            self.last = result
            if self.metrics is not None:
                self.metrics.record_tune("error")
            return result

        result = ScheduleResult(report=report, ran_at=self._clock())
        self.last = result
        if self.metrics is not None:
            self.metrics.record_tune("ok")
            self.metrics.set_tune_candidates(len(report.candidates), report.applied_version)
        return result

    # ---- 周期 ---------------------------------------------------------------

    @property
    def interval_s(self) -> float:
        return max(1.0, float(self.settings.tune_interval_s))

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="agent-pipeline-tuner", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread.is_alive():
            thread.join(timeout)

    def _loop(self) -> None:
        # 先跑一次再等：容器刚起来时昨天的日志已经该调了，没必要空等一整个周期。
        while not self._stop.is_set():
            self.run_once()
            if self._stop.wait(self.interval_s):
                break


# ---- 评测器：让「自动调优」真的能判断好坏 ---------------------------------


def _shadow_runtime(runtime: Runtime) -> Runtime:
    """A/B 评测用的影子 runtime：外部世界全换成内存。

    关键：评测会跑完整流水线，绝不能污染线上那套东西——日志文件、配置版本/灰度、
    指标、记忆都要隔离，否则「调优」本身会改变被调优的对象。
    """
    from .memory import MemoryStore  # 局部导入，避免模块级循环

    return Runtime(
        settings=runtime.settings,
        llm=runtime.llm,
        tools=runtime.tools,
        memory=MemoryStore(":memory:"),
        metrics=Metrics(),
        prompts=dict(PROMPTS),
        config_store=ConfigStore(":memory:"),
        coverage_runner=runtime.coverage_runner,
        log_sink=lambda row: None,
    )


def _prompts_with_proposal(proposal: dict[str, Any]) -> dict[str, str]:
    """把候选（Prompt 补丁建议 + few-shot）落成一份可执行的提示词集合。"""
    prompts = dict(PROMPTS)
    if proposal.get("kind") != "candidate":
        return prompts

    shots = [shot for shot in proposal.get("few_shots") or [] if shot.get("input")]
    if shots:
        lines = ["参考示例（照着这个粒度写结论，不要只复述工具输出）："]
        for shot in shots[:3]:
            lines.append(f"任务：{shot.get('input', '')}")
            lines.append(f"做法：{shot.get('output', '')}")
        prompts["execute"] = prompts["execute"] + "\n\n" + "\n".join(lines) + "\n"

    actions = [str(item.get("suggestion", "")).strip() for item in proposal.get("candidates") or []]
    actions = [action for action in actions if action]
    if actions:
        prompts["plan"] = prompts["plan"] + "\n\n这次特别注意：\n" + "\n".join(f"- {a}" for a in actions[:5]) + "\n"
    return prompts


def build_replay_evaluator(
    runtime: Runtime,
    *,
    log_path: str,
    window_hours: int | None = None,
    sample_size: int | None = None,
    clock: Callable[[], float] = time.time,
) -> Callable[[dict[str, Any]], float | None]:
    """用日志里最近的失败任务做回放 A/B，给 `tune` 一个真实可用的评测器。

    做法：同一批（最多 `sample_size` 个）失败任务，跑两遍完整流水线——
    - baseline：现状提示词；
    - candidate：现状 + 失败模式建议 + few-shot 示例。
    得分 = 成功率。没有失败样本时返回 None（tune 会因此不注册新版本）。

    开销是 2 × sample_size 次完整流水线，所以服务里默认关闭（`AGENT_TUNE_EVAL=1` 才接）。
    """
    limit = sample_size or runtime.settings.tune_eval_budget
    window = window_hours if window_hours is not None else runtime.settings.tune_window_hours

    def _sample_tasks() -> list[TaskSpec]:
        rows = read_logs(log_path, since_hours=window, now=clock())
        failed = [row for row in rows if classify(row) is not None]
        tasks: list[TaskSpec] = []
        for row in failed[-max(1, limit):]:
            raw = row.get("task") or {}
            goal = str(raw.get("goal") or "").strip()
            if not goal:
                continue
            mode = str(raw.get("mode") or "react")
            tasks.append(
                TaskSpec(
                    goal=goal,
                    cwd=str(raw.get("cwd") or "."),
                    constraints=[str(item) for item in raw.get("constraints") or []],
                    mode="adversarial" if mode == "adversarial" else "react",
                )
            )
        return tasks

    def evaluate(proposal: dict[str, Any]) -> float | None:
        from .runtime import run_once  # 局部导入：scheduler 不被 runtime 反向依赖

        tasks = _sample_tasks()
        if not tasks:
            return None
        shadow = _shadow_runtime(runtime)
        prompts = _prompts_with_proposal(proposal)
        passed = 0
        for index, task in enumerate(tasks):
            result, _row = run_once(shadow, task, run_id=f"tune-{proposal.get('kind', 'x')}-{index}", prompts=prompts)
            if result.status == "ok":
                passed += 1
        return passed / len(tasks)

    return evaluate