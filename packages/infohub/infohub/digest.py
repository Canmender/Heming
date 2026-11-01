from __future__ import annotations

import html
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import kb
from .agenda import due_label
from .store import Store

WEEKDAY_CN = "一二三四五六日"
BRIEF_REL = "学院事务/班级管理/InfoHub-小时简报.md"
MAX_SECTIONS = 24
SNIPPET_CHARS = 64
VIRTUAL_PREFIXES = ("gh_", "@openim", "fmessage", "medianote", "newsapp", "weixin", "notifymessage")
SOURCE_LABEL = {"qq": "QQ", "wechat": "微信"}
DOMAIN_LABEL = {"qq": "工作（QQ）", "wechat": "生活（微信）"}
KIND_LABEL = {"image": "图片", "file": "文件", "voice": "语音", "video": "视频"}
AI_INPUT_CHARS = 6000
AI_PER_CONV = 20
BROADCAST = ("所有人", "全体成员", "全体")

_MENTION = re.compile(r"@([^\s@,，。:：;；]{1,24})")
_PHONE = re.compile(r"(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)")


@dataclass
class Digest:
    since: int
    until: int
    total: int = 0
    by_source: dict[str, int] = field(default_factory=dict)
    convs: list[dict] = field(default_factory=list)
    mentions: list[dict] = field(default_factory=list)
    broadcasts: list[dict] = field(default_factory=list)
    notices: list[dict] = field(default_factory=list)
    new_events: list[dict] = field(default_factory=list)
    upcoming: list[dict] = field(default_factory=list)
    overdue: list[dict] = field(default_factory=list)
    media: dict[str, int] = field(default_factory=dict)
    transcripts: int = 0
    ai: str = ""
    ai_sections: list[dict] = field(default_factory=list)
    ai_error: str = ""
    ai_input: str = ""

    @property
    def empty(self) -> bool:
        return self.total == 0 and not self.media and not self.transcripts


def _clip(text: str, limit: int = SNIPPET_CHARS) -> str:
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    return raw if len(raw) <= limit else raw[: limit - 1] + "…"


def mask_phone(text: str) -> str:
    """群昵称常带手机号，归档和模型输入都只留掩码。"""
    return _PHONE.sub(r"\1****\2", str(text or ""))


def _fmt_hm(ts: int) -> str:
    return datetime.fromtimestamp(int(ts)).strftime("%H:%M")


def _fmt_md_hm(ts: int) -> str:
    d = datetime.fromtimestamp(int(ts))
    return f"{d.month}-{d.day} {d:%H:%M}"


def _span(since: int, until: int) -> str:
    start = datetime.fromtimestamp(int(since))
    end = datetime.fromtimestamp(int(until))
    if start.date() == end.date():
        return f"{start.month}-{start.day} {start:%H:%M}–{end:%H:%M}"
    return f"{_fmt_md_hm(since)} – {_fmt_md_hm(until)}"


_PLACEHOLDER = re.compile(r"^\[(?:图片|表情|语音|视频|文件|链接|卡片|位置|名片|转发消息)\](?:\s.*)?$")


def _meaningful(text: str) -> bool:
    raw = str(text or "").strip()
    return bool(raw) and not _PLACEHOLDER.match(raw) and raw not in ("[回复]",)


def _is_marketing(name: str, excludes) -> bool:
    return any(word and word in (name or "") for word in excludes)


def _mention_hits(content: str, aliases: list[str]) -> tuple[bool, bool]:
    """返回 (是否@了本人, 是否@全体)。"""
    body = content or ""
    if "@" not in body:
        return False, False
    names = {name for name in _MENTION.findall(body)}
    broadcast = any(any(word in name for word in BROADCAST) for name in names)
    for name in names:
        for alias in aliases:
            if not alias:
                continue
            if alias in name or name in alias:
                return True, broadcast
    return False, broadcast


def _event_row(row) -> dict:
    return {
        "id": int(row["id"]),
        "message_id": int(row["message_id"]),
        "conv_id": int(row["conversation_id"]),
        "title": row["title"],
        "due_ts": int(row["due_ts"]),
        "due": due_label(row),
        "conv": row["conv_name"] or "",
        "source": row["source"],
        "sender": row["sender_name"] or "",
        "status": row["status"],
    }


def _ai_input(rows, since: int, until: int, excludes, budget: int = AI_INPUT_CHARS) -> str:
    """按「工作 / 生活」分组的原文摘录，给大模型看，不是全量记录。"""
    sources = []
    for source in ("qq", "wechat"):
        usable = [
            row for row in rows
            if row["source"] == source
            and not (row["conv_name"] or "").startswith(VIRTUAL_PREFIXES)
            and not _is_marketing(row["conv_name"] or "", excludes)
            and str(row["content"] or "").strip()
        ]
        if usable:
            sources.append((source, usable))
    if not sources:
        return ""
    share = max(500, budget // len(sources))
    blocks = []
    for source, usable in sources:
        grouped: dict[int, dict] = {}
        for row in usable:
            conv = grouped.setdefault(
                int(row["conv_id"]),
                {"name": mask_phone(row["conv_name"] or ""), "ts": 0, "rows": []},
            )
            conv["rows"].append(row)
            conv["ts"] = max(conv["ts"], int(row["ts"]))
        chunks = [f"## {DOMAIN_LABEL.get(source, source)}"]
        used = len(chunks[0]) + 1
        skipped = 0
        for conv in sorted(grouped.values(), key=lambda c: -c["ts"]):
            if used >= share:
                skipped += len(conv["rows"])
                continue
            body = []
            rows_sorted = sorted(conv["rows"], key=lambda r: int(r["ts"]))
            older = max(0, len(rows_sorted) - AI_PER_CONV)
            for row in rows_sorted[-AI_PER_CONV:]:
                text = mask_phone(_clip(row["content"], 160))
                if not text:
                    continue
                who = "我" if row["is_self"] else mask_phone(row["sender_name"] or "未知")
                line = f"{_fmt_hm(row['ts'])} {who}：{text}"
                room = share - used - len(body) - 1
                if len(line) + 1 > room:
                    skipped += 1
                    continue
                body.append(line)
            if not body:
                skipped += len(rows_sorted)
                continue
            head = f"### {conv['name']}（{len(rows_sorted)} 条）"
            block = [head]
            if older:
                block.append(f"…（更早 {older} 条略）")
            block.extend(body)
            cost = sum(len(x) + 1 for x in block)
            if used + cost > share:
                skipped += len(body)
                continue
            chunks.extend(block)
            used += cost
        if skipped:
            chunks.append(f"…（另有 {skipped} 条未展开）")
        if len(chunks) > 1:
            blocks.append("\n".join(chunks))
    return "\n\n".join(blocks)


def build(store: Store, cfg, since: int, until: int | None = None) -> Digest:
    until = int(until or time.time())
    since = int(since)
    self_aliases = list(dict.fromkeys(
        [str(x) for x in (cfg.digest or {}).get("self_names", []) or []]
        + store.self_aliases()
    ))
    excludes = (
        list((cfg.kb or {}).get("agenda_conv_exclude") or [])
        + list((cfg.digest or {}).get("exclude_convs") or [])
    )
    work_keywords = list((cfg.kb or {}).get("notice_conv_keywords") or [])

    rows = store.window_messages(since, until)
    digest = Digest(since=since, until=until, total=len(rows))
    grouped: dict[int, dict] = {}
    for row in rows:
        digest.by_source[row["source"]] = digest.by_source.get(row["source"], 0) + 1
        conv = grouped.setdefault(
            int(row["conv_id"]),
            {
                "id": int(row["conv_id"]),
                "name": row["conv_name"] or "",
                "source": row["source"],
                "kind": row["conv_kind"],
                "count": 0,
                "last": "",
                "last_id": 0,
                "last_ts": 0,
                "sender": "",
                "mention": False,
            },
        )
        conv["count"] += 1
        if _meaningful(row["content"]) or not conv["last"]:
            conv["last"] = row["content"] or ""
            conv["last_id"] = int(row["id"])
            conv["last_ts"] = int(row["ts"])
            conv["sender"] = row["sender_name"] or ""
        if row["is_self"]:
            continue
        hit, broadcast = _mention_hits(row["content"], self_aliases)
        if hit:
            conv["mention"] = True
            digest.mentions.append(
                {
                    "id": int(row["id"]),
                    "conv_id": int(row["conv_id"]),
                    "ts": int(row["ts"]),
                    "conv": row["conv_name"] or "",
                    "sender": row["sender_name"] or "",
                    "source": row["source"],
                    "text": _clip(row["content"], 90),
                }
            )
        elif broadcast:
            digest.broadcasts.append(
                {
                    "ts": int(row["ts"]),
                    "conv": row["conv_name"] or "",
                    "sender": row["sender_name"] or "",
                    "source": row["source"],
                    "text": _clip(row["content"], 90),
                }
            )

    digest.convs = sorted(grouped.values(), key=lambda c: (-c["count"], -c["last_ts"]))
    digest.convs = [c for c in digest.convs if not _is_marketing(c["name"], excludes)] or digest.convs

    seen: set[str] = set()
    for row in sorted(rows, key=lambda r: -int(r["ts"])):
        if row["is_self"] or not row["content"]:
            continue
        if (row["conv_name"] or "").startswith(VIRTUAL_PREFIXES):
            continue
        if _is_marketing(row["conv_name"], excludes) or not kb.is_notice_text(row["content"]):
            continue
        if work_keywords and not any(k and k in (row["conv_name"] or "") for k in work_keywords):
            continue
        text = _clip(row["content"], 120)
        if text in seen:
            continue
        seen.add(text)
        digest.notices.append(
            {
                "id": int(row["id"]),
                "conv_id": int(row["conv_id"]),
                "ts": int(row["ts"]),
                "conv": row["conv_name"] or "",
                "sender": row["sender_name"] or "",
                "source": row["source"],
                "text": text,
            }
        )
        if len(digest.notices) >= 6:
            break

    digest.new_events = [
        _event_row(row) for row in store.events_between(since, until) if row["status"] != "done"
    ]
    now_ts = int(time.time())
    fresh_ids = {event["id"] for event in digest.new_events}
    digest.upcoming = [
        _event_row(r) for r in store.agenda(now_ts, now_ts + 86400) if int(r["id"]) not in fresh_ids
    ]
    digest.overdue = [
        _event_row(r) for r in store.agenda(now_ts - 3 * 86400, now_ts) if int(r["id"]) not in fresh_ids
    ]
    digest.media = store.media_counts(since, until)
    digest.transcripts = store.transcripts_since(since)
    try:
        budget = int((cfg.raw.get("llm") or {}).get("max_chars") or AI_INPUT_CHARS)
    except (TypeError, ValueError):
        budget = AI_INPUT_CHARS
    archive_excludes = list(dict.fromkeys(list(kb.DEFAULT_AGENDA_EXCLUDE) + excludes))
    digest.ai_input = _ai_input(
        rows, since, until, archive_excludes, max(1000, budget - 200)
    )
    return digest


def headline(digest: Digest) -> str:
    if digest.empty:
        return "这段时间没有新消息"
    parts = [f"新消息 {digest.total}"]
    if digest.by_source:
        parts[0] += "（" + " / ".join(
            f"{SOURCE_LABEL.get(k, k)} {v}" for k, v in digest.by_source.items()
        ) + "）"
    if digest.convs:
        parts.append(f"{len(digest.convs)} 个会话")
    if digest.mentions:
        parts.append(f"@我 {len(digest.mentions)}")
    if digest.new_events:
        parts.append(f"新日程 {len(digest.new_events)}")
    media_total = sum(digest.media.values())
    if media_total:
        parts.append(f"资源 {media_total}")
    return " · ".join(parts)


def _actions(digest: Digest, events: int = 4, mentions: int = 3, soon: int = 3) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for event in digest.new_events[:events]:
        items.append(("event", f"{event['due']}｜{_clip(event['title'], 32)}（{event['conv']}）"))
    for mention in digest.mentions[:mentions]:
        items.append(("mention", f"@我 {mention['sender']}（{mention['conv']}）：{_clip(mention['text'], 60)}"))
    for event in digest.upcoming[:soon]:
        items.append(("soon", f"{event['due']}｜{_clip(event['title'], 32)}（{event['conv']}）"))
    return items


def _resources(digest: Digest) -> str:
    extras = [f"{KIND_LABEL.get(k, k)} {v}" for k, v in digest.media.items()]
    if digest.transcripts:
        extras.append(f"语音转写 {digest.transcripts}")
    return " · ".join(extras)


def _ai_blocks(digest: Digest) -> list[tuple[str, list[str]]]:
    if digest.ai_sections:
        return [
            (str(section.get("title") or ""), [str(x) for x in section.get("items") or []])
            for section in digest.ai_sections
            if section.get("items")
        ]
    if digest.ai:
        return [("小结", [line for line in digest.ai.splitlines() if line.strip()])]
    return []


def _empty_note(digest: Digest) -> str:
    if not digest.upcoming:
        return "这段时间没有新消息。"
    first = digest.upcoming[0]
    more = f"，另 {len(digest.upcoming) - 1} 项" if len(digest.upcoming) > 1 else ""
    return (
        "这段时间没有新消息。"
        f"24 小时内：{first['due']}｜{_clip(first['title'], 24)}（{first['conv']}）{more}"
    )


def to_text(digest: Digest, notice_limit: int = 3) -> str:
    """纯文本，给系统通知 / 邮件正文用。"""
    title = f"InfoHub 简报 {_span(digest.since, digest.until)}"
    if digest.empty:
        return f"{title}\n{_empty_note(digest)}"
    lines = [title, headline(digest), ""]
    blocks = _ai_blocks(digest)
    if blocks:
        lines.append("AI 分析报告")
        for name, items in blocks:
            if len(items) == 1:
                lines.append(f"【{name}】{items[0]}")
            else:
                lines.append(f"【{name}】")
                lines.extend(f"· {item}" for item in items)
        lines.append("")
    actions = _actions(digest)
    if not actions:
        actions = [(n["conv"], f"{n['conv']}｜{n['sender']}：{_clip(n['text'], 50)}") for n in digest.notices[:notice_limit]]
    if actions:
        lines.append("要处理")
        lines.extend(f"· {text}" for _, text in actions)
        lines.append("")
    lines.append("会话")
    for conv in digest.convs[:6]:
        tag = "@我 " if conv["mention"] else ""
        lines.append(
            f"· {conv['name']}（{SOURCE_LABEL.get(conv['source'], conv['source'])} {conv['count']}）"
            f"{tag}：{_clip(conv['last'], 48)}"
        )
    resources = _resources(digest)
    if resources:
        lines.extend(["", f"资源：{resources}"])
    return "\n".join(lines).strip()


def to_markdown(digest: Digest, top: int = 8) -> str:
    title = f"## {_span(digest.since, digest.until)}"
    if digest.empty:
        return f"{title}\n\n> 这段时间没有新消息。\n"
    out = [title, "", f"> {headline(digest)}", ""]
    blocks = _ai_blocks(digest)
    if blocks:
        out.extend(["**AI 分析报告**", ""])
        for name, items in blocks:
            if len(items) == 1:
                out.append(f"- **{name}**：{items[0]}")
            else:
                out.append(f"- **{name}**")
                out.extend(f"  - {item}" for item in items)
        out.append("")
    actions = _actions(digest, events=6, mentions=4, soon=4)
    if actions:
        out.extend(["**要处理**", ""])
        out.extend(f"- {text}" for _, text in actions)
        out.append("")
    if digest.broadcasts or digest.notices:
        out.extend(["**通知候选**", ""])
        for item in (digest.broadcasts + digest.notices)[:4]:
            out.append(
                f"- {_fmt_hm(item['ts'])} {item['conv']}｜{item['sender']}：{_clip(item['text'], 90)}"
            )
        out.append("")
    if digest.convs:
        out.extend(["**会话动态**", ""])
        for conv in digest.convs[:top]:
            tag = " · @我" if conv["mention"] else ""
            out.append(
                f"- {conv['name']}（{SOURCE_LABEL.get(conv['source'], conv['source'])} {conv['count']}{tag}）"
                f"：{_clip(conv['last'])}"
            )
        out.append("")
    resources = _resources(digest)
    if resources:
        out.extend([f"**资源**：{resources}", ""])
    return "\n".join(out).rstrip() + "\n"


WECOM_LIMIT = 4000
WECOM_CONVS = 8


AGENDA_BUCKETS = ("已逾期", "今天", "明天", "未来 7 天", "之后")
AGENDA_CAPS = {"已逾期": 3, "今天": 4, "明天": 3, "未来 7 天": 5, "之后": 2}


def _wecom_agenda(digest: Digest) -> list[tuple[str, list[tuple[str, str]]]]:
    """按紧急度分档：已逾期 → 今天 → 明天 → 未来 7 天 → 之后。"""
    now = datetime.fromtimestamp(int(digest.until))
    today = now.date()
    groups: dict[str, list[tuple[str, str]]] = {name: [] for name in AGENDA_BUCKETS}
    seen: set[tuple[str, int]] = set()
    for event in sorted(digest.overdue + digest.new_events + digest.upcoming, key=lambda e: e["due_ts"]):
        key = (str(event["title"]), int(event["due_ts"]))
        if key in seen:
            continue
        seen.add(key)
        due = datetime.fromtimestamp(int(event["due_ts"]))
        hm = "全天" if event.get("due") == "全天" else f"{due:%H:%M}"
        day = due.date()
        if day < today:
            # 每小时都推，两天前的旧截止只会变成噪音
            if int(event["due_ts"]) < int(digest.until) - 86400:
                continue
            bucket, tag = "已逾期", f"{due:%m-%d} {hm}"
        elif day == today:
            bucket, tag = "今天", hm
        elif (day - today).days == 1:
            bucket, tag = "明天", hm
        elif (day - today).days <= 7:
            bucket, tag = "未来 7 天", f"{due:%m-%d} {hm}"
        else:
            bucket, tag = "之后", f"{due:%m-%d} {hm}"
        groups[bucket].append((tag, f"{_clip(event['title'], 32)}（{_clip(event['conv'], 14)}）"))
    return [(name, groups[name]) for name in AGENDA_BUCKETS if groups[name]]


def _wecom_agenda_lines(groups: list[tuple[str, list[tuple[str, str]]]]) -> list[str]:
    """分档渲染，日程跨档连续编号，逾期和当天用警示色。"""
    lines: list[str] = []
    seq = 0
    for name, items in groups:
        shown = items[: AGENDA_CAPS[name]]
        lines.extend(["", f"**{name}（{len(shown)}）**"])
        for tag, text in shown:
            seq += 1
            if name in ("已逾期", "今天"):
                lines.append(f'> <font color="warning">{seq}. {tag}</font>｜{text}')
            else:
                lines.append(f"> {seq}. {tag}｜{text}")
    return lines


def _wecom_ai(digest: Digest) -> tuple[list, list, list]:
    """工作/生活分开返回；旧四段报告退化为通用块。"""
    blocks = _ai_blocks(digest)
    work, life = [], []
    for name, items in blocks:
        if name.startswith("工作 ·"):
            work.append((name[4:].strip(" ·"), items))
        elif name.startswith("生活 ·"):
            life.append((name[4:].strip(" ·"), items))
    if work or life:
        return work, life, []
    return [], [], blocks


def _append_ai(lines: list[str], blocks: list) -> None:
    for title, items in blocks:
        if not items:
            continue
        if len(items) == 1:
            lines.append(f"> **{title}**：{items[0]}")
        else:
            lines.append(f"> **{title}**")
            lines.extend(f"> · {item}" for item in items)


def to_wecom_markdown(digest: Digest) -> str:
    """企业微信 markdown：按紧急度分块、每条独占一行、4096 字节内。"""
    lines = [f"**InfoHub 简报 · {_span(digest.since, digest.until)}**", f"> {headline(digest)}"]
    if not digest.empty:
        lines.extend(_wecom_agenda_lines(_wecom_agenda(digest)))
        if digest.mentions:
            lines.extend(["", "**@我**"])
            for mention in digest.mentions[:3]:
                lines.append(
                    f"> {mention['sender']}（{_clip(mention['conv'], 14)}）"
                    f"：{_clip(mention['text'], 48)}"
                )

        work, life, legacy = _wecom_ai(digest)
        if work or life or legacy:
            lines.extend(["", "**AI 分析报告**"])
            if work:
                lines.extend(["", "**工作**", ""])
                _append_ai(lines, work)
            if life:
                lines.extend(["", "**生活**", ""])
                _append_ai(lines, life)
            if legacy:
                _append_ai(lines, legacy)

        if digest.convs:
            lines.extend(["", "**会话**"])
            for conv in digest.convs[:WECOM_CONVS]:
                tag = " · @我" if conv["mention"] else ""
                label = SOURCE_LABEL.get(conv["source"], conv["source"])
                lines.append(f"> {mask_phone(conv['name'])} · {label} · {conv['count']} 条{tag}")
            extra = len(digest.convs) - WECOM_CONVS
            if extra > 0:
                lines.append(f"> 另有 {extra} 个会话")
        resources = _resources(digest)
        if resources:
            lines.extend(["", f"**资源**：{resources}"])

    raw = "\n".join(lines).encode("utf-8")
    while len(raw) > WECOM_LIMIT and len(lines) > 4:
        lines.pop()
        while lines and (not lines[-1].strip() or lines[-1].startswith("**")):
            lines.pop()
        raw = "\n".join(lines).encode("utf-8")
    return raw.decode("utf-8")


def to_html(digest: Digest) -> str:
    title = f"InfoHub 简报 {_span(digest.since, digest.until)}"
    if digest.empty:
        return f"<p>{html.escape(title)}</p><p>{html.escape(_empty_note(digest))}</p>"
    out = [f"<h3>{html.escape(title)}</h3>", f"<p style='color:#666'>{html.escape(headline(digest))}</p>"]
    blocks = _ai_blocks(digest)
    if blocks:
        out.append("<h4>AI 分析报告</h4>")
        body = []
        for index, (name, items) in enumerate(blocks):
            if index:
                body.append("<br>")
            if len(items) == 1:
                body.append(f"<b>{html.escape(name)}</b>：{html.escape(items[0])}")
            else:
                body.append(f"<b>{html.escape(name)}</b>")
                body.extend(f"· {html.escape(item)}" for item in items)
        out.append(
            "<p style='margin:2px 0;background:#f4f6fb;padding:8px 10px'>"
            + "<br>".join(body)
            + "</p>"
        )
    elif digest.ai_error:
        out.append(
            "<p style='margin:2px 0;color:#c0392b'>AI 报告生成失败："
            + html.escape(digest.ai_error)
            + "</p>"
        )
    actions = _actions(digest, events=6, mentions=4, soon=4)
    if actions:
        out.append("<h4>要处理</h4>")
        out.extend(f"<p style='margin:2px 0'>&#183; {html.escape(text)}</p>" for _, text in actions)
    if digest.convs:
        out.append("<h4>会话动态</h4>")
        for conv in digest.convs[:8]:
            out.append(
                f"<p style='margin:2px 0'>&#183; {html.escape(conv['name'])}（{conv['count']}）："
                f"{html.escape(_clip(conv['last'], 70))}</p>"
            )
    resources = _resources(digest)
    if resources:
        out.append(f"<p style='color:#666'>资源：{html.escape(resources)}</p>")
    return "".join(out)


def export_obsidian(cfg, digest: Digest, sections: int = MAX_SECTIONS) -> dict:
    vault = Path((cfg.kb or {}).get("vault") or kb.DEFAULT_VAULT)
    path = vault / BRIEF_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = to_markdown(digest)
    if path.exists():
        text = path.read_text(encoding="utf-8")
    else:
        text = (
            "---\ntitle: InfoHub 小时简报\ntype: hourly-brief\ntags: [院务, 每日简报]\n---\n\n"
            "# InfoHub 小时简报\n\n"
            "> 每小时自动追加；只保留最近 24 条。手动内容请写在文件末尾。\n\n"
            "<!-- infohub:hourly:start -->\n<!-- infohub:hourly:end -->\n"
        )
    block = _replace_hourly(text, fresh, sections)
    changed = kb._write_if_changed(path, block)
    return {"path": str(path), "changed": changed}


_HEAD = "<!-- infohub:hourly:start -->"
_TAIL = "<!-- infohub:hourly:end -->"


def _replace_hourly(text: str, fresh: str, sections: int) -> str:
    if _HEAD not in text or _TAIL not in text:
        return text.rstrip() + "\n\n" + _HEAD + "\n" + fresh.strip() + "\n" + _TAIL + "\n"
    head, rest = text.split(_HEAD, 1)
    body, tail = rest.split(_TAIL, 1)
    chunks = [c.strip() for c in re.split(r"(?m)^(?=## )", body.strip()) if c.strip()]
    fresh = fresh.strip()
    if not chunks or chunks[0] != fresh:
        chunks = [fresh] + chunks
    chunks = chunks[:sections]
    inner = "\n\n".join(chunks)
    return f"{head.rstrip()}\n\n{_HEAD}\n{inner}\n{_TAIL}{tail}"


def run(store: Store, cfg, hours: float | None = None, advance: bool = True,
        obsidian: bool = True, ai: bool = True) -> Digest:
    now_ts = int(time.time())
    window = int(float(hours if hours is not None else (cfg.digest or {}).get("hours", 1)) * 3600)
    since = max(0, now_ts - max(60, window))
    cursor = store.digest_cursor()
    if 0 < cursor < since and now_ts - cursor <= 86400:
        # 关了很久再打开：把空档一次补齐，最多回看 24 小时
        since = cursor
    digest = build(store, cfg, since, now_ts)
    if ai and not digest.empty:
        from . import llm

        if llm.available(cfg):
            # 给模型看按来源分组的原文，而不是只看每个会话最后一句
            ok, result = llm.report(cfg, digest.ai_input or to_text(digest))
            if ok:
                digest.ai_sections = result
                digest.ai = "\n".join(
                    f"【{s['title']}】{' '.join(s['items'])}" for s in result if s["items"]
                )
            else:
                digest.ai_error = str(result)
    if advance:
        store.set_digest_cursor(now_ts)
    if obsidian and (cfg.digest or {}).get("obsidian", True):
        try:
            export_obsidian(cfg, digest)
        except OSError:
            pass
    return digest
