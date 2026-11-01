"""每日通知：把班级公共事务整理成可转发到班群的固定格式。

数据源只有两处：events 表里未来 N 天未完成的日程，以及近期工作类会话里的
通知原文。先交给大模型合并同主题、按截止时间排序并写成通知；模型不可用或
输出不合格式时退回规则渲染。
"""

from __future__ import annotations

import html as htmllib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, time as clock_time
from difflib import SequenceMatcher
from pathlib import Path

from . import kb
from . import llm as llm_mod
from . import push as push_mod
from .config import Config
from .store import Store

WEEKDAY_CN = "一二三四五六日"
DEFAULT_CLASS = "金融2601"
DEFAULT_TIME = "17:00"
DEFAULT_DAYS_AHEAD = 14
DEFAULT_LOOKBACK_DAYS = 3
DEFAULT_MAX_ITEMS = 10
NOTICE_LIMIT = 4000  # 企微 markdown 4096 字节，留一点余量
ITEM_RE = re.compile(r"(?m)^\s*(\d+)\s*[、.．]\s*")
STATE_NAME = "sent.json"


@dataclass
class DailyNotice:
    date: str
    text: str
    items: int
    mode: str
    ai_error: str = ""
    path: str = ""


# ---------- 过滤 ----------


def _filters(cfg: Config) -> tuple[list[str], list[str]]:
    opts = cfg.notice or {}
    kb_cfg = cfg.kb or {}
    keywords = list(
        dict.fromkeys(
            list(kb_cfg.get("notice_conv_keywords") or kb.DEFAULT_NOTICE_KEYWORDS)
            + list(opts.get("conv_keywords") or [])
            + ["2601"]
        )
    )
    excludes = list(
        dict.fromkeys(
            list(kb.DEFAULT_AGENDA_EXCLUDE)
            + list(kb_cfg.get("agenda_conv_exclude") or [])
            + list((cfg.digest or {}).get("exclude_convs") or [])
            + list(opts.get("exclude_convs") or [])
            + ["我的设备"]
        )
    )
    return keywords, excludes


def _conv_ok(name: str, keywords: list[str], excludes: list[str]) -> bool:
    name = name or ""
    if not name or any(x and x in name for x in excludes):
        return False
    return any(k and k in name for k in keywords)


def _clip(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _norm(text: str) -> str:
    return re.sub(r"[\s，,。.；;：:、!！?？（）()【】\[\]“”\"']", "", str(text or ""))


# ---------- 候选 ----------


def _event_items(store: Store, cfg: Config, now_ts: int) -> list[dict]:
    opts = cfg.notice or {}
    days_ahead = int(opts.get("days_ahead") or DEFAULT_DAYS_AHEAD)
    keywords, excludes = _filters(cfg)
    start = datetime.fromtimestamp(now_ts).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = store.agenda(int(start.timestamp()), int(start.timestamp()) + days_ahead * 86400)
    items: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for row in rows:
        conv = row["conv_name"] or ""
        if not _conv_ok(conv, keywords, excludes):
            continue
        key = (_norm(row["title"]), int(row["due_ts"]))
        if key in seen:
            continue
        seen.add(key)
        due = datetime.fromtimestamp(int(row["due_ts"]))
        all_day = bool(int(row["all_day"] or 0))
        items.append(
            {
                "title": str(row["title"] or "").strip(),
                "due": f"{due:%m-%d} 全天" if all_day else f"{due:%m-%d %H:%M}",
                "due_ts": int(row["due_ts"]),
                "conv": conv,
                "source": row["source"],
                "text": str(row["detail"] or row["content"] or "").strip(),
                "content": str(row["content"] or "").strip(),
            }
        )
    items.sort(key=lambda item: item["due_ts"])
    return items


def _notice_items(store: Store, cfg: Config, now_ts: int) -> list[dict]:
    opts = cfg.notice or {}
    days = int(opts.get("lookback_days") or DEFAULT_LOOKBACK_DAYS)
    keywords, excludes = _filters(cfg)
    rows = store.notice_messages(now_ts - days * 86400, now_ts)
    picked = kb.pick_candidates(rows, keywords, excludes, limit=40)
    items: list[dict] = []
    seen: set[str] = set()
    for row in picked:
        key = _norm(row["content"])[:48]
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "date": datetime.fromtimestamp(int(row["ts"])).strftime("%m-%d"),
                "conv": row["conv"],
                "source": row["source"],
                "text": row["content"],
            }
        )
    return items


def collect(store: Store, cfg: Config, now_ts: int) -> tuple[list[dict], list[dict]]:
    events = _event_items(store, cfg, now_ts)
    notices = _notice_items(store, cfg, now_ts)
    # 同一通知常被抽成日程又留在原文里；先剔掉与日程重复的原文，减少模型负担
    known = [f"{event['title']}{event.get('content') or ''}" for event in events]
    notices = [item for item in notices if not _covered(item["text"], known)]
    return events, notices


def _covered(text: str, corpus: list[str]) -> bool:
    target = _norm(text)
    if not target:
        return True
    for other in corpus:
        source = _norm(other)
        if not source:
            continue
        match = SequenceMatcher(None, target, source).find_longest_match(0, len(target), 0, len(source))
        if match.size >= 12:
            return True
    return False


# ---------- 渲染 ----------


def title_line(cfg: Config, date: datetime) -> str:
    name = str((cfg.notice or {}).get("class_name") or DEFAULT_CLASS).strip()
    return f"{name} 每日通知（{date.month} 月 {date.day} 日）"


def _clean_body(text: str, limit: int = 260) -> str:
    raw = str(text or "").strip()
    lines = [re.sub(r"^[\s·•\-*#>]+", "", line).strip() for line in raw.splitlines()]
    body = "".join(line for line in lines if line)
    return _clip(body, limit)


def _rule_title(text: str) -> str:
    first = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    first = re.sub(r"^【[^】]*】", "", first)
    first = re.sub(r"^(?:通知|重要通知)[:：]\s*", "", first)
    first = first.strip(" ，,。.；;：:")
    return _clip(first or "通知", 30)


def _important(text: str) -> bool:
    return bool(re.search(r"重要|务必|逾期|视为放弃|截止", str(text or "")))


def _rule_items(events: list[dict], notices: list[dict], max_items: int) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for event in events:
        title = _rule_title(event["title"])
        key = _norm(title)
        if not title or key in seen:
            continue
        seen.add(key)
        body = _clean_body(event.get("text") or event.get("content") or "")
        if not body:
            body = f"截止时间：{event['due']}。"
        if _important(event.get("content") or "") and "（重要）" not in title:
            title += "（重要）"
        items.append({"title": title, "body": body})
    for notice in notices:
        title = _rule_title(notice["text"])
        key = _norm(title)
        if not title or key in seen:
            continue
        seen.add(key)
        body = _clean_body(notice["text"])
        if _important(notice["text"]) and "（重要）" not in title:
            title += "（重要）"
        items.append({"title": title, "body": body})
    return items[:max_items]


def render(title: str, items: list[dict]) -> str:
    blocks = [title, ""]
    for index, item in enumerate(items, 1):
        blocks.append(f"{index}、{_clip(item['title'], 40)}")
        if item.get("body"):
            blocks.append(_clean_body(item["body"]))
        blocks.append("")
    text = "\n".join(blocks).strip() + "\n"
    while len(text.encode("utf-8")) > NOTICE_LIMIT and len(items) > 1:
        items = items[:-1]
        text = render(title, items)
    if len(text.encode("utf-8")) > NOTICE_LIMIT:
        text = push_mod.clip_bytes(text, NOTICE_LIMIT)
    return text


def parse_ai_items(text: str, max_items: int) -> list[dict] | None:
    """把模型输出拆成条目；认不出编号返回 None。标题行重新生成，不采用模型的。"""
    raw = re.sub(r"(?m)^\s*```.*$", "", text or "").replace("**", "").replace("##", "")
    lines = [line.strip() for line in raw.splitlines()]
    start = next((i for i, line in enumerate(lines) if ITEM_RE.match(line)), None)
    if start is None:
        return None
    items: list[dict] = []
    current: dict | None = None
    for line in lines[start:]:
        match = ITEM_RE.match(line)
        if match:
            if current is not None:
                items.append(current)
            current = {"title": line[match.end():].strip(), "body": []}
        elif current is not None and line:
            current["body"].append(line)
    if current is not None:
        items.append(current)
    cleaned = []
    for item in items:
        title = _clip(item["title"].strip(" ，,。.；;：:"), 40)
        if not title:
            continue
        body = _clean_body("".join(item["body"]))
        cleaned.append({"title": title, "body": body})
    if not cleaned:
        return None
    return cleaned[:max_items]


# ---------- 生成 ----------


def _material(
    events: list[dict],
    notices: list[dict],
    cfg: Config,
    date: datetime,
    event_cap: int = 8,
    notice_cap: int = 8,
) -> str:
    try:
        budget = int((cfg.raw.get("llm") or {}).get("max_chars") or 6000)
    except (TypeError, ValueError):
        budget = 6000
    budget = max(1500, budget - 800)
    deadlines = []
    used = 0
    for event in events[:event_cap]:
        item = {
            "title": _clip(event["title"], 40),
            "due": event["due"],
            "conv": event["conv"],
            "text": _clip(event.get("content") or event.get("text") or "", 420),
        }
        used += len(json.dumps(item, ensure_ascii=False))
        if used > budget:
            break
        deadlines.append(item)
    notes = []
    for notice in notices[:notice_cap]:
        item = {
            "date": notice["date"],
            "conv": notice["conv"],
            "text": _clip(notice["text"], 360),
        }
        used += len(json.dumps(item, ensure_ascii=False))
        if used > budget:
            break
        notes.append(item)
    payload = {
        "today": f"{date:%Y-%m-%d} 星期{WEEKDAY_CN[date.weekday()]}",
        "deadlines": deadlines,
        "notices": notes,
    }
    return json.dumps(payload, ensure_ascii=False)


def build(
    store: Store,
    cfg: Config,
    now_ts: int | None = None,
) -> DailyNotice | None:
    now_ts = int(now_ts or time.time())
    date = datetime.fromtimestamp(now_ts)
    opts = cfg.notice or {}
    max_items = max(1, int(opts.get("max_items") or DEFAULT_MAX_ITEMS))
    events, notices = collect(store, cfg, now_ts)
    if not events and not notices:
        return None
    title = title_line(cfg, date)
    mode = "rules"
    ai_error = ""
    items: list[dict] | None = None
    if opts.get("ai", True) and llm_mod.available(cfg):
        # 推理模型偶尔把上限全花在思考上：第二次缩小材料再试一次
        attempts = ((8, 8, 8192, 240.0), (5, 5, 8192, 240.0))
        for event_cap, notice_cap, tokens, timeout in attempts:
            ok, result = llm_mod.daily_notice(
                cfg,
                _material(events, notices, cfg, date, event_cap, notice_cap),
                class_name=str(opts.get("class_name") or DEFAULT_CLASS),
                month=date.month,
                day=date.day,
                max_items=max_items,
                max_tokens=tokens,
                timeout=timeout,
            )
            if ok:
                items = parse_ai_items(result, max_items)
                if items:
                    mode = "ai"
                    ai_error = ""
                    break
                ai_error = "AI 输出没有可识别的编号条目"
            else:
                ai_error = str(result)
    if not items:
        items = _rule_items(events, notices, max_items)
        mode = "rules"
    if not items:
        return None
    text = render(title, items)
    path = save_text(cfg, date.strftime("%Y-%m-%d"), text)
    return DailyNotice(
        date=date.strftime("%Y-%m-%d"),
        text=text,
        items=len(items),
        mode=mode,
        ai_error=ai_error,
        path=str(path),
    )


# ---------- 落地 ----------


def daily_dir(cfg: Config) -> Path:
    return cfg.data_dir / "daily"


def save_text(cfg: Config, date: str, text: str) -> Path:
    path = daily_dir(cfg) / f"{date}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")
    return path


def state_path(cfg: Config) -> Path:
    return daily_dir(cfg) / STATE_NAME


def load_state(cfg: Config) -> dict:
    path = state_path(cfg)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(cfg: Config, date: str, status: str, detail: str = "", items: int = 0) -> None:
    path = state_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {"date": date, "status": status, "detail": detail, "items": items, "ts": int(time.time())}
    path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def done_today(cfg: Config, date: str) -> bool:
    state = load_state(cfg)
    return state.get("date") == date and state.get("status") in ("sent", "empty", "ready")


def push_notice(cfg: Config, notice: DailyNotice) -> push_mod.PushResult:
    subject = notice.text.splitlines()[0] if notice.text else "每日通知"
    return push_mod.push(cfg, subject, notice.text, _to_html(notice.text), notice.text)


def _to_html(text: str) -> str:
    parts = []
    for block in text.strip().split("\n\n"):
        body = htmllib.escape(block).replace("\n", "<br>")
        parts.append(f"<p style='margin:6px 0'>{body}</p>")
    return "".join(parts)


# ---------- 调度 ----------


def target_time(cfg: Config) -> clock_time:
    raw = str((cfg.notice or {}).get("time") or DEFAULT_TIME).strip()
    try:
        hour, minute = raw.split(":", 1)
        return clock_time(int(hour), int(minute))
    except (ValueError, TypeError):
        return clock_time(17, 0)
