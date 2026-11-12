"""命令行入口：``run`` / ``serve`` / ``tune`` / ``doctor``。

    python -m agent_pipeline.runner run --goal "..." --mode adversarial --coverage-command "pytest --cov"
    python -m agent_pipeline.runner serve --port 8000
    python -m agent_pipeline.runner tune --log runs.jsonl --out tune-report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .config import Settings
from .protocol import TaskSpec
from .runtime import build_runtime, make_coverage_runner, run_once
from .tune import tune


def _cmd_run(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    if args.max_steps:
        settings = settings.with_budget(max_steps=args.max_steps)
    coverage_runner = None
    if args.coverage_command:
        coverage_runner = make_coverage_runner(args.coverage_command, cwd=args.cwd or None)
    runtime = build_runtime(settings, coverage_runner=coverage_runner)
    task = TaskSpec(
        goal=args.goal,
        cwd=args.cwd,
        constraints=list(args.constraint or []),
        mode=args.mode,
        coverage_target=args.coverage_target,
    )
    result, row = run_once(runtime, task)
    if args.json:
        print(json.dumps({"result": result.to_dict(), "log": row}, ensure_ascii=False, indent=2))
    else:
        print(f"状态：{result.status}")
        if result.error:
            print(f"错误：{result.error}")
        print(f"耗时 {row['duration_s']}s · 模型调用 {result.llm_calls} 次 · token {result.tokens}")
        if result.coverage is not None:
            print(f"覆盖率：{result.coverage:.0%}")
        print("-" * 60)
        print(result.answer or "（没有答案）")
    return 0 if result.status == "ok" else 1


def _cmd_tune(args: argparse.Namespace) -> int:
    from .rollback import ConfigStore

    settings = Settings.from_env()
    store = ConfigStore(settings.db_path, outcome_limit=settings.outcome_limit)
    report = tune(
        log_path=args.log,
        out_path=args.out,
        since_hours=args.since_hours,
        config_store=store,
    )
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .service import create_app

    app = create_app(Settings.from_env())
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    """不调用模型的连通性自检：工具、记忆、配置存储、日志路径。"""
    settings = Settings.from_env()
    runtime = build_runtime(settings, llm=_NoopLLM(), coverage_runner=None)
    info: dict[str, Any] = {
        "model": settings.model,
        "base_url": settings.base_url,
        "budget": settings.budget.__dict__,
        "tools": runtime.tools.registry.names(),
        "memory": runtime.memory.count(),
        "active_config": (runtime.config_store.active().id if runtime.config_store and runtime.config_store.active() else 0),
        "log_path": str(Path(settings.log_path).resolve()),
        "db_path": str(Path(settings.db_path).resolve()),
        "coverage_target": settings.coverage_target,
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


class _NoopLLM:
    def chat(self, messages, *, tools=None, temperature=0.2, max_tokens=2000):  # pragma: no cover - 只给 doctor 用
        raise RuntimeError("doctor 模式不调用模型")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent_pipeline", description="和鸣多智能体流水线")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="跑一次流水线")
    run.add_argument("--goal", required=True)
    run.add_argument("--cwd", default=".")
    run.add_argument("--mode", default="react", choices=["react", "adversarial"])
    run.add_argument("--coverage-command", default=None)
    run.add_argument("--coverage-target", type=float, default=None)
    run.add_argument("--constraint", action="append")
    run.add_argument("--max-steps", type=int, default=None)
    run.add_argument("--json", action="store_true")
    run.set_defaults(func=_cmd_run)

    serve = sub.add_parser("serve", help="起 HTTP 服务")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=_cmd_serve)

    tune_cmd = sub.add_parser("tune", help="日志驱动的每日调优")
    tune_cmd.add_argument("--log", default="runs.jsonl")
    tune_cmd.add_argument("--out", default=None)
    tune_cmd.add_argument("--since-hours", type=int, default=24)
    tune_cmd.set_defaults(func=_cmd_tune)

    doctor = sub.add_parser("doctor", help="自检（不调用模型）")
    doctor.set_defaults(func=_cmd_doctor)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())