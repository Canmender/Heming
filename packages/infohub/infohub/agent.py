from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import digest as digest_mod
from . import kb
from . import push as push_mod
from .agenda import update_agenda
from .config import Config
from .store import Store
from .sync import sync_all

PLAN_DEFAULT = ("sync", "analyze", "archive", "agenda", "push")
WORK_SUBDIR = "学院事务/消息归档"
LIFE_SUBDIR = "个人生活/消息归档"
ARCHIVE_PER_CONV = 30
ARCHIVE_MAX_LINES = 600
# 群昵称是 QQ 号、又没备注的营销群，不进 Obsidian
_VIRTUAL = digest_mod.VIRTUAL_PREFIXES

Progress = Callable[[str], None]


@dataclass
class Step:
    name: str
    label: str
    status: str = "ok"  # ok / warn / skip / error
    detail: str = ""
    seconds: float = 0.0

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "status": self.status,
            "detail": self.detail,
            "seconds": self.seconds,
        }


@dataclass
class Run:
    started: int
    finished: int = 0
    steps: list[Step] = field(default_factory=list)
    headline: str = ""
    path: str = ""
    push: dict | None = None
    digest: digest_mod.Digest | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return bool(self.steps) and all(step.status != "error" for step in self.steps)

    def failed(self) -> list[Step]:
        return [step for step in self.steps if step.status == "error"]

    def summary(self) -> str:
        works = [step for step in self.steps if step.status in ("ok", "warn", "error")]
        done = len([step for step in works if step.status in ("ok", "warn")])
        return f"{done}/{len(works)} 步完成" + ("，有失败" if self.failed() else "")

    def to_dict(self) -> dict:
        return {
            "started": self.started,
            "finished": self.finished,
            "ok": self.ok,
            "headline": self.headline,
            "summary": self.summary(),
            "push": self.push,
            "steps": [step.to_dict() for step in self.steps],
        }


@dataclass
class Context:
    cfg: Config
    store: Store
    hours: float | None = None
    do_archive: bool = True
    do_push: bool = True
    progress: Progress | None = None
    digest: digest_mod.Digest | None = None
    push_result: push_mod.PushResult | None = None

    def say(self, text: str) -> None:
        if self.progress:
            self.progress(text)


def _yes(value, default: bool = True) -> bool:
    if value is None:
        return default
    return bool(value)


def _sync(ctx: Context) -> tuple[str, str]:
    ctx.say("同步 QQ / 微信…")
    reports = sync_all(
        ctx.cfg,
        store=ctx.store,
        progress=lambda stage, i, t: ctx.say(f"{stage} {i}/{t}" if t else stage),
    )
    added = sum(int(getattr(r, "added", 0) or 0) for r in reports)
    errors = [err for r in reports for err in getattr(r, "errors", []) or []]
    agenda = update_agenda(ctx.store, ctx.cfg)
    detail = f"新增 {added} 条"
    if agenda:
        detail += f"，日程 {agenda['total']} 项（{agenda['mode']}）"
    if errors:
        detail += f"；{len(errors)} 个采集错误（{errors[0][:60]}）"
        return "warn", detail
    if agenda and agenda.get("ai_error"):
        return "warn", detail + f"；AI 日程识别失败，已用规则（{agenda['ai_error'][:50]}）"
    return "ok", detail


def _analyze(ctx: Context) -> tuple[str, str]:
    ctx.say("生成简报与 AI 分析…")
    d = digest_mod.run(
        ctx.store, ctx.cfg, hours=ctx.hours, advance=False, obsidian=False, ai=True
    )
    ctx.digest = d
    ctx.store.set_digest_cursor(d.until)
    if d.empty:
        return "skip", "这段时间没有新消息"
    detail = digest_mod.headline(d)
    if d.ai_error:
        return "warn", f"{detail}；AI 失败：{d.ai_error}"
    if d.ai_sections:
        detail += "；AI 报告已生成"
    return "ok", detail


def _cut(text: str, limit: int = 160) -> str:
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    return raw if len(raw) <= limit else raw[: limit - 1] + "…"


def _render_archive(digest: digest_mod.Digest, rows, source: str) -> str:
    label = "工作" if source == "qq" else "生活"
    span = digest_mod._span(digest.since, digest.until)
    stamp = datetime.fromtimestamp(int(digest.since))
    lines = [
        "---",
        f"title: {label}消息归档 {span}",
        "type: infohub-message-archive",
        f"source: {source}",
        f"domain: {'work' if source == 'qq' else 'life'}",
        f"date: {stamp:%Y-%m-%d}",
        f"messages: {len(rows)}",
        f"created: {stamp:%Y-%m-%d}",
        "tags: [院务, 消息归档]" if source == "qq" else "tags: [个人, 消息归档]",
        "---",
        "",
        f"# {label}消息 {span}",
        "",
        f"> {digest_mod.headline(digest)}",
        "",
    ]
    blocks = digest_mod._ai_blocks(digest)
    want = "工作 ·" if source == "qq" else "生活 ·"
    if blocks and any(name.startswith(("工作 ·", "生活 ·")) for name, _ in blocks):
        blocks = [(name, items) for name, items in blocks if name.startswith(want)]
    if blocks:
        lines.extend(["## AI 分析", ""])
        for name, items in blocks:
            if len(items) == 1:
                lines.append(f"- **{name}**：{items[0]}")
            else:
                lines.append(f"- **{name}**")
                lines.extend(f"  - {item}" for item in items)
        lines.append("")
    elif digest.ai_error:
        lines.extend([f"> AI 分析失败：{digest.ai_error}", ""])

    grouped: dict[int, dict] = {}
    for row in rows:
        conv = grouped.setdefault(
            int(row["conv_id"]),
            {"name": digest_mod.mask_phone(row["conv_name"] or ""), "ts": 0, "rows": []},
        )
        conv["rows"].append(row)
        conv["ts"] = max(conv["ts"], int(row["ts"]))

    lines.extend(["## 会话", ""])
    used = 0
    truncated = 0
    for conv in sorted(grouped.values(), key=lambda c: -c["ts"]):
        if used >= ARCHIVE_MAX_LINES:
            truncated += 1
            continue
        ordered = sorted(conv["rows"], key=lambda r: int(r["ts"]))
        older = max(0, len(ordered) - ARCHIVE_PER_CONV)
        block = [f"### {conv['name']}（{len(ordered)} 条）"]
        if older:
            block.append(f"…（更早 {older} 条略）")
        for row in ordered[-ARCHIVE_PER_CONV:]:
            if used + len(block) >= ARCHIVE_MAX_LINES:
                break
            who = "我" if row["is_self"] else digest_mod.mask_phone(row["sender_name"] or "未知")
            body = digest_mod.mask_phone(_cut(row["content"]))
            block.append(f"- {digest_mod._fmt_hm(row['ts'])} {who}：{body}")
        lines.extend(block)
        lines.append("")
        used += len(block)
    if truncated:
        lines.append(f"…（另有 {truncated} 个会话未展开）")
    index_link = (
        "[[学院事务/消息归档/index|消息归档索引]]"
        if source == "qq"
        else "[[个人生活/消息归档/index|消息归档索引]]"
    )
    lines.extend(["", "## 相关", "", f"- {index_link}"])
    return "\n".join(lines).rstrip() + "\n"


def _refresh_archive_index(vault: Path, subdir: str, title: str, tags: str, related: str) -> Path | None:
    root = vault / subdir
    if not root.is_dir():
        return None
    files = sorted(root.glob("*/*.md"), reverse=True)
    lines = [
        "---",
        f"title: {title}",
        f"created: {datetime.now():%Y-%m-%d}",
        f"tags: {tags}",
        "---",
        "",
        f"# {title}",
        "",
        "> 由 InfoHub 按小时自动归档并维护本索引，重跑覆盖，勿手改。",
        "",
        "## 归档",
        "",
    ]
    if files:
        for p in files:
            rel = p.relative_to(vault).with_suffix("").as_posix()
            lines.append(f"- [[{rel}|{p.stem}]]")
    else:
        lines.append("> 暂无归档。")
    lines.extend(["", "## 相关", "", f"- {related}", ""])
    index_path = root / "index.md"
    kb._write_if_changed(index_path, "\n".join(lines))
    return index_path


def archive_messages(cfg: Config, store: Store, digest: digest_mod.Digest) -> dict:
    """把这一小时的消息按工作/生活写进 Obsidian，重复运行覆盖同一小时文件。"""
    vault = Path((cfg.kb or {}).get("vault") or kb.DEFAULT_VAULT)
    if not vault.is_dir():
        raise FileNotFoundError(f"知识库目录不存在：{vault}")
    rows = store.window_messages(digest.since, digest.until)
    excludes = list(dict.fromkeys(
        list(kb.DEFAULT_AGENDA_EXCLUDE)
        + list((cfg.kb or {}).get("agenda_conv_exclude") or [])
        + list((cfg.digest or {}).get("exclude_convs") or [])
    ))
    rows = [
        row for row in rows
        if str(row["content"] or "").strip()
        and not (row["conv_name"] or "").startswith(_VIRTUAL)
        and not any(x and x in (row["conv_name"] or "") for x in excludes)
    ]
    start = datetime.fromtimestamp(int(digest.since))
    end = datetime.fromtimestamp(int(digest.until))
    # 按小时取整命名：同一小时的重复运行覆盖同一文件
    name = f"{start:%H}00-{end:%H}00"
    day = start.strftime("%Y-%m-%d")
    out = {"files": [], "work": 0, "life": 0, "changed": 0}
    for source, subdir, key in (("qq", WORK_SUBDIR, "work"), ("wechat", LIFE_SUBDIR, "life")):
        source_rows = [row for row in rows if row["source"] == source]
        if not source_rows:
            continue
        label = "工作" if source == "qq" else "生活"
        path = vault / subdir / day / f"{name} {label}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        changed = kb._write_if_changed(path, _render_archive(digest, source_rows, source))
        out["files"].append(str(path))
        out[key] = len(source_rows)
        out["changed"] += int(changed)
    _refresh_archive_index(
        vault, WORK_SUBDIR, "学院事务消息归档", "[院务, 消息归档]",
        "[[学院事务/00-总览|学院事务总览]]",
    )
    _refresh_archive_index(
        vault, LIFE_SUBDIR, "个人生活消息归档", "[个人, 消息归档]",
        "[[首页|首页]]",
    )
    return out


def _archive(ctx: Context) -> tuple[str, str]:
    d = ctx.digest
    if d is None:
        return "error", "还没有简报，无法入库"
    if not ctx.do_archive:
        return "skip", "本次跳过 Obsidian 入库"
    if d.empty:
        return "skip", "没有新消息"
    if not Path((ctx.cfg.kb or {}).get("vault") or kb.DEFAULT_VAULT).is_dir():
        return "error", "知识库目录不存在，检查 kb.vault"
    ctx.say("写入 Obsidian 归档…")
    stats = archive_messages(ctx.cfg, ctx.store, d)
    brief = digest_mod.export_obsidian(ctx.cfg, d)
    day = datetime.fromtimestamp(int(d.since)).strftime("%Y-%m-%d")
    detail = f"工作 {stats['work']} 条 / 生活 {stats['life']} 条"
    subs = []
    if stats["work"]:
        subs.append(f"{WORK_SUBDIR}/{day}")
    if stats["life"]:
        subs.append(f"{LIFE_SUBDIR}/{day}")
    if subs:
        detail += " → " + " + ".join(subs)
    detail += f"；简报页 {'更新' if brief['changed'] else '无变化'}"
    return "ok", detail


def _agenda(ctx: Context) -> tuple[str, str]:
    if not ctx.do_archive:
        return "skip", "本次跳过知识库导出"
    vault = Path((ctx.cfg.kb or {}).get("vault") or kb.DEFAULT_VAULT)
    if not vault.is_dir():
        return "error", "知识库目录不存在，检查 kb.vault"
    ctx.say("导出日程与通知候选…")
    stats = kb.export_all(
        ctx.cfg,
        ctx.store,
        parts=("agenda", "notices"),
        now_ts=(ctx.digest.until if ctx.digest else int(time.time())),
    )
    if stats.get("error"):
        return "error", str(stats["error"])
    agenda = stats.get("agenda") or {}
    notices = stats.get("notices") or {}
    return "ok", f"日程 {agenda.get('rows', 0)} 项，通知候选 {notices.get('candidates', 0)} 条"


def _push(ctx: Context) -> tuple[str, str]:
    if not ctx.do_push:
        return "skip", "本次跳过推送"
    d = ctx.digest
    if d is None:
        return "skip", "没有简报可推"
    opts = ctx.cfg.push or {}
    if not opts.get("enabled"):
        return "skip", "推送未启用（push.enabled = false）"
    if d.empty and not opts.get("send_empty"):
        return "skip", "没有新消息"
    missing = push_mod.missing(ctx.cfg)
    if missing:
        return "warn", "推送缺：" + "、".join(missing)
    ctx.say("推送到企业微信…")
    subject = "InfoHub 简报 " + datetime.fromtimestamp(int(d.until)).strftime("%m-%d %H:%M")
    markdown = digest_mod.to_wecom_markdown(d)
    result = push_mod.push(
        ctx.cfg,
        subject,
        digest_mod.to_text(d),
        digest_mod.to_html(d),
        markdown,
    )
    ctx.push_result = result
    schedules = sum(len(items) for _, items in digest_mod._wecom_agenda(d))
    size = len(markdown.encode("utf-8")) / 1024
    return ("ok" if result.ok else "error"), (
        f"{result.channel}：{result.detail} · 日程 {schedules} 条 · {size:.1f} KB"
    )


TOOLS = {
    "sync": ("同步采集", _sync),
    "analyze": ("简报与 AI 分析", _analyze),
    "archive": ("消息入库 Obsidian", _archive),
    "agenda": ("日程与通知导出", _agenda),
    "push": ("企微/邮件推送", _push),
}


def runs_dir(cfg: Config) -> Path:
    return cfg.data_dir / "agent" / "runs"


def save_run(cfg: Config, run: Run) -> str:
    path = runs_dir(cfg) / (
        datetime.fromtimestamp(int(run.started)).strftime("%Y%m%d-%H%M%S") + ".json"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(run.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def latest_run(cfg: Config) -> dict | None:
    files = sorted(runs_dir(cfg).glob("*.json"))
    if not files:
        return None
    try:
        return json.loads(files[-1].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def run(
    cfg: Config,
    store: Store,
    hours: float | None = None,
    archive: bool | None = None,
    push: bool | None = None,
    plan: list[str] | None = None,
    progress: Progress | None = None,
    log: bool = True,
) -> Run:
    """按计划逐步执行；单步失败不中断，默认最后写一份运行日志。"""
    opts = cfg.raw.get("agent") or {}
    plan = list(plan or opts.get("plan") or PLAN_DEFAULT)
    ctx = Context(
        cfg=cfg,
        store=store,
        hours=hours,
        do_archive=_yes(archive, _yes(opts.get("archive"), True)),
        do_push=_yes(push, _yes(opts.get("push"), True)),
        progress=progress,
    )
    run_log = Run(started=int(time.time()))
    for name in plan:
        entry = TOOLS.get(name)
        if entry is None:
            run_log.steps.append(Step(name, name, "skip", "没有这个工具"))
            continue
        label, handler = entry
        ctx.say(f"{label}…")
        started = time.time()
        try:
            status, detail = handler(ctx)
        except Exception as exc:  # noqa: BLE001
            status, detail = "error", f"{type(exc).__name__}: {exc}"
        step = Step(name, label, status, str(detail), round(time.time() - started, 2))
        run_log.steps.append(step)
        ctx.say(f"{label}：{detail}")
    run_log.finished = int(time.time())
    if ctx.push_result is not None:
        run_log.push = {
            "ok": bool(ctx.push_result.ok),
            "channel": ctx.push_result.channel,
            "detail": ctx.push_result.detail,
        }
    run_log.digest = ctx.digest
    if ctx.digest is not None:
        run_log.headline = digest_mod.headline(ctx.digest)
    if log:
        run_log.path = save_run(cfg, run_log)
    return run_log
