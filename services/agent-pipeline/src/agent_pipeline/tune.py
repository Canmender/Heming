"""日志驱动的每日 Prompt / Few-shot 调优。

流程（全部可离线跑，不调用外部服务）：
1. 读过去 N 小时的 run 日志（JSONL，一 run 一行）；
2. 挑出「失败 / 低分 / 回滚 / 预算耗尽」的样本，按失败模式聚类；
3. 为每类生成候选修改（提示词补丁 + few-shot 示例），并给出**可评测的候选目录**；
4. 调评测器打分；达标才注册新配置版本（灰度），否则只写报告。

红线：**绝不在线上直接改提示词**；所有候选都是版本化对象，可回滚。
"""

from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

FAILURE_REASONS = {
    "max_steps": "规划太长或执行绕圈：建议把任务拆细，或在 Plan 提示词里要求「每步可独立验证」。",
    "max_replans": "反复重规划：说明 Reflect 的 done_when 不可验证，建议要求 Planner 写出可观测的完成条件。",
    "coverage_gap": "覆盖率不达标：建议在 Tester 提示词里强制「先跑真实命令再汇报」，并给 Coder 一个最小改动约束。",
    "critic_blocked": "评审反复阻断：建议补充该任务的验收标准 few-shot。",
    "tokens": "token 预算耗尽：建议缩短 observation 渲染长度或减少工具调用。",
    "llm_calls": "模型调用次数耗尽：建议在 Execute 提示词里要求一次多调（并行工具），减少往返。",
    "wall_clock": "端到端超时：建议缩小单次任务范围，或提高工具超时前先检查慢工具。",
    "reflect_abort": "模型判定无法完成：需要补充领域知识（RAG 文档）或改写任务。",
    "error": "运行报错：先看 error 字段，再决定是提示词问题还是工具/线路问题。",
}


@dataclass
class TuneReport:
    window_hours: int
    total_runs: int
    failed_runs: int
    failure_modes: dict[str, int] = field(default_factory=dict)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    few_shots: list[dict[str, str]] = field(default_factory=list)
    applied_version: int | None = None
    baseline_score: float | None = None
    candidate_score: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "window_hours": self.window_hours,
            "total_runs": self.total_runs,
            "failed_runs": self.failed_runs,
            "failure_modes": self.failure_modes,
            "candidates": self.candidates,
            "few_shots": self.few_shots,
            "applied_version": self.applied_version,
            "baseline_score": self.baseline_score,
            "candidate_score": self.candidate_score,
            "generated_at": time.time(),
        }


def read_logs(path: str | Path, *, since_hours: int = 24, now: float | None = None) -> list[dict[str, Any]]:
    file = Path(path)
    if not file.exists():
        return []
    now = now if now is not None else time.time()
    cutoff = now - since_hours * 3600
    rows: list[dict[str, Any]] = []
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and float(row.get("finished_at", 0)) >= cutoff:
            rows.append(row)
    return rows


def classify(row: dict[str, Any]) -> str | None:
    # stop_reason 更能说明「为什么没跑完」，优先于笼统的 status=error/budget。
    if row.get("stop_reason"):
        return str(row["stop_reason"])
    if row.get("status") not in ("ok", None):
        return "error"
    critiques = row.get("critiques") or []
    if critiques and float(critiques[-1].get("score", 1.0)) < 0.6:
        return "critic_low_score"
    if row.get("rolled_back"):
        return "rolled_back"
    return None


def build_candidates(rows: list[dict[str, Any]]) -> tuple[dict[str, int], list[dict[str, Any]], list[dict[str, str]]]:
    modes: Counter[str] = Counter()
    failed: list[dict[str, Any]] = []
    for row in rows:
        reason = classify(row)
        if reason:
            modes[reason] += 1
            failed.append(row)

    candidates: list[dict[str, Any]] = []
    for mode, count in modes.most_common():
        hint = FAILURE_REASONS.get(mode, "人工复核这一类失败样本。")
        candidates.append(
            {
                "mode": mode,
                "count": count,
                "action": "prompt_patch",
                "suggestion": hint,
                "evidence": [
                    {"run_id": row.get("run_id"), "stop_reason": row.get("stop_reason"), "error": row.get("error")}
                    for row in failed
                    if classify(row) == mode
                ][:5],
            }
        )

    # few-shot 从成功样本里挑「描述清楚、工具调用少」的，作为下一版示例。
    few_shots: list[dict[str, str]] = []
    for row in rows:
        if classify(row) is not None:
            continue
        observations = row.get("observations") or []
        if not isinstance(observations, list) or len(observations) > 4:
            continue
        goal = str((row.get("task") or {}).get("goal") or "").strip()
        answer = str(row.get("answer") or "").strip()
        if len(goal) >= 8 and len(answer) >= 20:
            few_shots.append({"input": goal[:200], "output": answer[:400]})
        if len(few_shots) >= 3:
            break
    return dict(modes), candidates, few_shots


def tune(
    *,
    log_path: str | Path,
    out_path: str | Path | None = None,
    since_hours: int = 24,
    now: float | None = None,
    evaluator: Callable[[dict[str, Any]], float | None] | None = None,
    config_store: Any = None,
    current_payload: dict[str, Any] | None = None,
    min_improvement: float = 0.02,
) -> TuneReport:
    rows = read_logs(log_path, since_hours=since_hours, now=now)
    modes, candidates, few_shots = build_candidates(rows)
    report = TuneReport(
        window_hours=since_hours,
        total_runs=len(rows),
        failed_runs=sum(1 for row in rows if classify(row) is not None),
        failure_modes=modes,
        candidates=candidates,
        few_shots=few_shots,
    )

    if evaluator is not None and candidates:
        proposal = {"candidates": candidates, "few_shots": few_shots}
        baseline = evaluator({"candidates": [], "few_shots": [], "kind": "baseline"})
        candidate_score = evaluator({**proposal, "kind": "candidate"})
        report.baseline_score = baseline
        report.candidate_score = candidate_score
        improved = (
            candidate_score is not None
            and baseline is not None
            and candidate_score >= baseline + min_improvement
        )
        if improved and config_store is not None:
            payload = dict(current_payload or {})
            payload.setdefault("prompts", {})
            payload["tuning"] = {
                "few_shots": few_shots,
                "actions": [c["suggestion"] for c in candidates],
                "score": candidate_score,
            }
            version = config_store.register(payload, promote=False)
            # 不 promote：先灰度。灰度期由 canary 指标决定是否转正/回滚。
            config_store._set_stage(version.id, "canary")  # noqa: SLF001 - 内部方法，语义在这里刚好
            report.applied_version = version.id

    if out_path is not None:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return report