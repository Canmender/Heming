"""命令行入口：``run`` / ``serve`` / ``tune`` / ``doctor`` / ``ingest``。

    python -m agent_pipeline.runner run --goal "..." --mode adversarial --coverage-command "pytest --cov"
    python -m agent_pipeline.runner serve --port 8000
    python -m agent_pipeline.runner tune --log runs.jsonl --out tune-report.json
    python -m agent_pipeline.runner ingest docs/ README.md --prefix docs/
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
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
    if args.mode == "adversarial" and coverage_runner is None:
        # 和 HTTP 服务同一条口径：没有覆盖率命令时对抗环只能空转两轮，
        # 最后以「未达标」收场——看起来像任务没做成，其实是没接测试。
        print(
            "[run] 对抗模式需要 --coverage-command（例如 \"pytest --cov=src --cov-report=term-missing\"）："
            "没有它「覆盖率达标」无法验证，只会白跑两轮后报未达标。",
            file=sys.stderr,
        )
        return 2
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
        if result.stop_reason:
            # 预算用尽 / 对抗未达标 / 用户取消都是「正常结束但没达到目标」，
            # 只看「状态：ok」会让人以为任务真的做成了。
            print(f"收口原因：{result.stop_reason}")
        if result.coverage is not None:
            print(f"覆盖率：{result.coverage:.0%}")
        print("-" * 60)
        print(result.answer or "（没有答案）")
    return 0 if result.status == "ok" else 1


def _cmd_tune(args: argparse.Namespace) -> int:
    from .rollback import ConfigStore

    settings = Settings.from_env()
    # 「日志不存在」和「日志里没失败」是两件事：读空文件会打出一份 0 样本的报告，
    # 看起来调优跑了其实什么都没看。
    log_file = Path(args.log)
    if not log_file.exists():
        print(f"[tune] 找不到日志文件：{log_file}（先跑一次 run，或用 soak.py --log 生成）", file=sys.stderr)
        return 1
    store = ConfigStore(settings.db_path, outcome_limit=settings.outcome_limit)
    report = tune(
        log_path=args.log,
        out_path=args.out,
        since_hours=args.since_hours,
        config_store=store,
    )
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0


KNOWLEDGE_EXTENSIONS = (".md", ".txt", ".rst", ".py", ".ts", ".json", ".yaml", ".yml")
KNOWLEDGE_MAX_CHARS = 200_000  # 与 service 的 KnowledgeDoc.text 上限一致


def iter_knowledge_files(paths: list[str], extensions: tuple[str, ...] = KNOWLEDGE_EXTENSIONS):
    """把路径展开成 (根目录, 文件) 对；目录递归、按路径排序，保证同一份输入喂出同一份 doc_id。"""
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for child in sorted(item for item in path.rglob("*") if item.is_file()):
                if child.suffix.lower() in extensions:
                    yield path, child
        elif path.is_file():
            yield path.parent, path
        else:
            raise FileNotFoundError(f"知识库路径不存在：{raw}")


def ingest_paths(
    memory: Any,
    paths: list[str],
    *,
    prefix: str = "",
    extensions: tuple[str, ...] = KNOWLEDGE_EXTENSIONS,
    max_chars: int = KNOWLEDGE_MAX_CHARS,
) -> list[dict[str, Any]]:
    """把文件灌进知识库（同 doc_id 整体替换）。返回每个文件的处理结果，便于 CLI 打印/测试断言。"""
    results: list[dict[str, Any]] = []
    for root, file in iter_knowledge_files(paths, extensions):
        try:
            text = file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            results.append({"doc_id": "", "path": str(file), "skipped": "不是 UTF-8 文本"})
            continue
        if not text.strip():
            results.append({"doc_id": "", "path": str(file), "skipped": "空文件"})
            continue
        if len(text) > max_chars:
            # 截断而不是跳过：长文档的前半段通常仍然有用，且知识库有容量上限。
            text = text[:max_chars]
            trimmed = True
        else:
            trimmed = False
        relative = file.relative_to(root).as_posix()
        doc_id = f"{prefix}{relative}" if prefix else relative
        chunks = memory.add_document(doc_id, text, title=file.stem)
        results.append(
            {
                "doc_id": doc_id,
                "path": str(file),
                "chars": len(text),
                "chunks": len(chunks),
                "trimmed": trimmed,
                "skipped": "",
            }
        )
    return results


def _cmd_ingest(args: argparse.Namespace) -> int:
    from .memory import MemoryStore

    settings = Settings.from_env()
    extensions = tuple(ext.strip().lower() for ext in args.ext.split(",") if ext.strip())
    memory = MemoryStore(settings.db_path, max_episodes=settings.max_episodes, max_documents=settings.max_documents)
    try:
        results = ingest_paths(memory, args.paths, prefix=args.prefix, extensions=extensions)
        summary = {
            "files": len(results),
            "ingested": sum(1 for item in results if not item["skipped"]),
            "skipped": [item for item in results if item["skipped"]],
            "chunks": sum(int(item.get("chunks") or 0) for item in results),
            "stats": memory.count(),
            "db_path": str(Path(settings.db_path).resolve()),
        }
    finally:
        memory.close()
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print(f"知识库写入：{summary['ingested']}/{summary['files']} 个文件、{summary['chunks']} 个切片")
        for item in results:
            if item["skipped"]:
                print(f"  跳过 {item['path']}：{item['skipped']}")
        print(f"  当前规模：{summary['stats']}")
        print(f"  库文件：{summary['db_path']}")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .service import create_app

    settings = Settings.from_env()
    # 对抗模式的覆盖率命令：命令行给的值优先于环境变量，省得为了一个参数
    # 先把环境变量 export 一遍（容器里两者都支持，这里只是本机调试更顺手）。
    if getattr(args, "coverage_command", None):
        settings = replace(settings, coverage_command=args.coverage_command)
    app = create_app(settings)
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
        # 对抗模式没它跑不起来（服务端会 422、CLI 会退 2），所以要能在自检里一眼看到
        "coverage_command": settings.coverage_command or None,
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
    # 与 run 子命令同名：对抗模式的覆盖率命令（不写就只认 AGENT_COVERAGE_COMMAND）。
    serve.add_argument("--coverage-command", default=None)
    serve.set_defaults(func=_cmd_serve)

    tune_cmd = sub.add_parser("tune", help="日志驱动的每日调优")
    tune_cmd.add_argument("--log", default="runs.jsonl")
    tune_cmd.add_argument("--out", default=None)
    tune_cmd.add_argument("--since-hours", type=int, default=24)
    tune_cmd.set_defaults(func=_cmd_tune)

    ingest = sub.add_parser("ingest", help="把文档灌进知识库（RAG）")
    ingest.add_argument("paths", nargs="+", help="文件或目录（目录递归）")
    ingest.add_argument("--prefix", default="", help="doc_id 前缀，例如 docs/")
    ingest.add_argument("--ext", default=",".join(KNOWLEDGE_EXTENSIONS), help="按扩展名过滤（逗号分隔）")
    ingest.add_argument("--json", action="store_true")
    ingest.set_defaults(func=_cmd_ingest)

    doctor = sub.add_parser("doctor", help="自检（不调用模型）")
    doctor.set_defaults(func=_cmd_doctor)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())