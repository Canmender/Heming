from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta

from . import llm as llm_mod
from .config import Config
from .store import Store

WINDOW_DAYS = 120
MAX_EVENTS_PER_MESSAGE = 4
# 一次增量最多处理多少条新消息；积压时下一轮继续
INCREMENT_BATCH = 200
AI_MAX_MESSAGES = 40
MARKETING_HINTS = (
    "塔斯汀", "瑞幸", "美团", "神券", "钱总", "外卖", "宠粉", "福利群",
    "秒杀", "特价", "肯德基", "麦当劳", "蜜雪",
)

WEEKDAY_CN = "一二三四五六日"
_WEEKDAY_INDEX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}

_FULL_DATE = re.compile(r"(?:(?P<y>\d{4})\s*年\s*)?(?P<m>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*[日号]")
_MD = re.compile(r"(?<![\d/])(?P<m>\d{1,2})/(?P<d>\d{1,2})(?![\d/])")
_WEEKDAY = re.compile(r"(?P<rel>下下|下个|下|本|这|这个)?\s*(?:周|星期|礼拜)\s*(?P<w>[一二三四五六日天])")
_REL_DAY = re.compile(r"(?P<w>今天|今日|今晚|今早|明天|明日|明早|明晚|后天|大后天)")
_TIME = re.compile(
    r"(?P<period>上午|早上|早晨|中午|下午|傍晚|晚上|晚|凌晨)?\s*"
    r"(?P<h>\d{1,2})\s*(?:[:：]\s*(?P<mi>\d{1,2})|点\s*(?:(?P<mi2>\d{1,2})\s*分?|(?P<half>半)|多)?)"
)

_ACTION = re.compile(
    r"截止|截至|之前|前完成|前提交|前上交|报名|提交|上交|缴纳|缴费|交费|交材料|交表|交齐|交到|交给|"
    r"完成|参加|开会|会议|"
    r"例会|大会|班会|团日|讲座|培训|典礼|面试|答辩|活动|比赛|大赛|考试|测验|测试|"
    r"补考|集合|签到|填报|填写|领取|排练|演出|晚会|运动会|体检|办理|"
    r"报送|上报|汇总|统计|收取|收集"
)
_STRONG = re.compile(
    r"截止|截至|报名|提交|上交|缴纳|缴费|交费|交材料|交表|填报|填写|领取|"
    r"例会|大会|班会|团日|讲座|培训|典礼|面试|答辩|活动|比赛|大赛|考试|测验|补考|"
    r"集合|签到|排练|演出|晚会|运动会|体检|办理|报送|上报|收取|收集"
)
_QUESTION = re.compile(
    r"[?？]|吗|呢|吧|啊|呀|嘛|要不要|有没有|是不是|能不能|可不可以|行不行|干嘛|几点|什么时候|哪天|怎么|咋|什么|ok不|问下"
)
_FILLER = re.compile(r"^(?:对了|然后|另外|还有|不过|但是|所以|就是|那个|其实|感觉|我觉得|刚才|刚刚)[\s，,]*")

_KIND_RULES = (
    ("exam", re.compile(r"考试|测验|测试|补考")),
    ("meeting", re.compile(r"会议|例会|开会|大会|班会|团日|讲座|培训|典礼|面试|答辩|汇报|座谈")),
    ("activity", re.compile(r"活动|比赛|大赛|运动会|志愿|排练|演出|晚会|集会|体检")),
    ("payment", re.compile(r"缴费|缴纳|交费|收费")),
    ("signup", re.compile(r"报名")),
)

_LIST_NOISE = re.compile(r"^\s*(?:\d{1,2}\s*[、.．)）]\s*)+")
_EMOJI_NOISE = re.compile(r"^[\W_]+")
_LEAD_VERB = re.compile(r"^(?:各位同学|请|需要|需|须|务必|记得|大家|各位|同学们|所有人|全体成员|之前|前|截止到|截止|截至)[\s，,]*")
_PAREN_WEEKDAY = re.compile(r"[（(]\s*(?:周|星期)[一二三四五六日天]\s*[)）]")
_QQ_EMOJI = re.compile(r"\s+(?:/[\u4e00-\u9fa5A-Za-z]{1,4})+$")

_SENTENCE_SPLIT = re.compile(r"[\n。；;]+")


@dataclass
class EventDraft:
    title: str
    detail: str
    due_ts: int
    due_text: str
    all_day: bool
    kind: str


def _resolve_md(anchor: date, month: int, day: int, year: int | None) -> date | None:
    try:
        if year:
            return date(year, month, day)
        cand = date(anchor.year, month, day)
    except ValueError:
        return None
    if (cand - anchor).days < -45:
        try:
            cand = date(anchor.year + 1, month, day)
        except ValueError:
            return None
    return cand


def _resolve_weekday(anchor: date, rel: str | None, name: str) -> date:
    idx = _WEEKDAY_INDEX[name]
    if rel in ("下", "下个"):
        offset = 7 + idx - anchor.weekday()
    elif rel == "下下":
        offset = 14 + idx - anchor.weekday()
    elif rel in ("本", "这", "这个"):
        offset = idx - anchor.weekday()
    else:
        offset = (idx - anchor.weekday()) % 7
    return anchor + timedelta(days=offset)


def _parse_time(segment: str) -> dtime | None:
    for m in _TIME.finditer(segment):
        hour = int(m.group("h"))
        minute = int(m.group("mi") or m.group("mi2") or (30 if m.group("half") else 0))
        period = m.group("period") or ""
        if period in ("下午", "傍晚", "晚上", "晚") and hour < 12:
            hour += 12
        elif period == "中午" and hour < 12:
            hour += 12
        elif period == "凌晨" and hour == 12:
            hour = 0
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return dtime(hour, minute)
    return None


def _kind_of(sentence: str) -> str:
    for kind, pattern in _KIND_RULES:
        if pattern.search(sentence):
            return kind
    return "task"


def _title_of(sentence: str) -> str:
    text = _PAREN_WEEKDAY.sub(" ", sentence)
    text = _LIST_NOISE.sub("", text)
    text = _EMOJI_NOISE.sub("", text)
    text = _LIST_NOISE.sub("", text)
    while True:
        stripped = _LEAD_VERB.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    while True:
        stripped = _FILLER.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    text = re.sub(r"\s+", " ", text).strip(" ，,。;；:：")
    text = _QQ_EMOJI.sub("", text).rstrip(" !！❗️").strip()
    text = re.sub(r"(?:之前|以前|前)$", "", text).strip()
    if len(text) > 46:
        head = text[:46]
        cut = max(head.rfind(sep) for sep in "，,、；;")
        if cut >= 20:
            text = head[:cut]
        else:
            text = head.rstrip("0123456789:：. ")
        text = text.rstrip(" ，,、；;：:") + "…"
    return text or "待办"


def _clause_around(sentence: str, start: int, end: int) -> str:
    left = max(sentence.rfind("，", 0, start), sentence.rfind(",", 0, start)) + 1
    rights = [p for p in (sentence.find("，", end), sentence.find(",", end)) if p != -1]
    right = min(rights) if rights else len(sentence)
    clause = sentence[left:right].strip()
    if len(clause) < 8 and right < len(sentence):
        clause = clause + "，" + re.split(r"[，,]", sentence[right + 1 :], maxsplit=1)[0]
    return clause


def _same_task(a: str, b: str) -> bool:
    na, nb = _title_key(a), _title_key(b)
    if not na or not nb:
        return False
    return na == nb or (min(len(na), len(nb)) >= 2 and (na in nb or nb in na))


def _title_for(sentence: str, start: int, end: int) -> str:
    clause = _clause_around(sentence, start, end)
    title = _title_of(clause)
    if len(_title_key(title)) >= 8:
        return title
    left = max(sentence.rfind("，", 0, start), sentence.rfind(",", 0, start))
    prev = max(sentence.rfind("，", 0, left), sentence.rfind(",", 0, left)) + 1
    rights = [p for p in (sentence.find("，", end), sentence.find(",", end)) if p != -1]
    right = min(rights) if rights else len(sentence)
    wider = _title_of(sentence[prev:right])
    return wider if len(_title_key(wider)) > len(_title_key(title)) else title


def _date_mentions(sentence: str, anchor: date) -> list[tuple[int, int, date, str, str]]:
    mentions: list[tuple[int, int, date, str, str]] = []
    for m in _FULL_DATE.finditer(sentence):
        year = int(m.group("y")) if m.group("y") else None
        day = _resolve_md(anchor, int(m.group("m")), int(m.group("d")), year)
        if day:
            mentions.append((m.start(), m.end(), day, m.group(0).strip(), "abs"))
    if not mentions:
        for m in _MD.finditer(sentence):
            day = _resolve_md(anchor, int(m.group("m")), int(m.group("d")), None)
            if day:
                mentions.append((m.start(), m.end(), day, m.group(0).strip(), "abs"))
    if not mentions:
        for m in _WEEKDAY.finditer(sentence):
            mentions.append(
                (
                    m.start(),
                    m.end(),
                    _resolve_weekday(anchor, m.group("rel"), m.group("w")),
                    m.group(0).strip(),
                    "weekday",
                )
            )
    if not mentions:
        for m in _REL_DAY.finditer(sentence):
            word = m.group("w")
            offset = 0 if word.startswith("今") else (1 if word.startswith("明") else (2 if word == "后天" else 3))
            mentions.append((m.start(), m.end(), anchor + timedelta(days=offset), word, "rel"))
    return mentions


def _merge_ranges(sentence: str, mentions: list[tuple]) -> list[tuple]:
    """把「10月26日—10月28日」这类区间合并成一个事件，取结束日。"""
    merged: list[tuple] = []
    i = 0
    while i < len(mentions):
        start, end, day, phrase, kind = mentions[i]
        if i + 1 < len(mentions):
            nxt = mentions[i + 1]
            gap = sentence[end : nxt[0]]
            if kind == "abs" and nxt[4] == "abs" and re.fullmatch(r"\s*[-—–~～至到]+\s*", gap):
                merged.append((start, nxt[1], nxt[2], sentence[start : nxt[1]].strip(), "abs"))
                i += 2
                continue
        merged.append((start, end, day, phrase, kind))
        i += 1
    return merged


def _is_deadline_near(sentence: str, start: int, end: int) -> bool:
    tail = sentence[end : end + 6]
    head = sentence[max(0, start - 6) : start]
    return "前" in tail or "之前" in tail or "截止" in tail + head or "截至" in tail + head


def extract(text: str, anchor_ts: int) -> list[EventDraft]:
    anchor_dt = datetime.fromtimestamp(int(anchor_ts))
    anchor = anchor_dt.date()
    drafts: list[EventDraft] = []
    seen: list[tuple[date, str, str]] = []
    for sentence in _SENTENCE_SPLIT.split(text or ""):
        sentence = sentence.strip()
        if len(sentence) < 4:
            continue
        if "「引用」" in sentence or "[回复消息]" in sentence or _QUESTION.search(sentence):
            continue
        if not _ACTION.search(sentence):
            continue
        mentions = _merge_ranges(sentence, _date_mentions(sentence, anchor))
        if not mentions:
            continue
        masked = sentence
        for start, end, _, _, _ in sorted(mentions, reverse=True):
            masked = masked[:start] + " " * (end - start) + masked[end:]
        for start, end, day, phrase, kind in mentions:
            if (day - anchor).days < -60 or (day - anchor).days > 400:
                continue
            has_deadline = _is_deadline_near(sentence, start, end)
            if not has_deadline and not _STRONG.search(sentence):
                continue
            if (day - anchor).days < -2 and not has_deadline:
                continue
            clock = _parse_time(masked[max(0, start - 10) : end + 32])
            period_near = bool(
                re.search(r"上午|早上|早晨|中午|下午|傍晚|晚上|晚|凌晨", masked[max(0, start - 6) : end + 20])
            )
            if kind == "weekday" and (
                not _STRONG.search(sentence) or not (clock or has_deadline or period_near)
            ):
                continue
            if kind == "rel" and clock is None and not has_deadline:
                continue
            due_ts = int(datetime.combine(day, clock or dtime(0, 0)).timestamp())
            title = _title_for(sentence, start, end)
            event_kind = _kind_of(sentence)
            if any(d == day and k == event_kind and _same_task(title, t) for d, k, t in seen):
                continue
            seen.append((day, event_kind, title))
            drafts.append(
                EventDraft(
                    title=title,
                    detail=sentence,
                    due_ts=due_ts,
                    due_text=phrase,
                    all_day=clock is None,
                    kind=event_kind,
                )
            )
            if len(drafts) >= MAX_EVENTS_PER_MESSAGE:
                return drafts
    return drafts


def _title_key(title: str) -> str:
    return re.sub(r"[\s，,。；;:：!！?？\-—…]", "", title).lower()


def rebuild(store: Store, days: int = WINDOW_DAYS, now_ts: int | None = None) -> dict:
    started = time.time()
    now_ts = int(now_ts or time.time())
    since = now_ts - days * 86400
    rows = store.messages_since(since)
    seen: dict[int, list[tuple[date, str, str]]] = {}
    global_seen: set[tuple[date, str, str]] = set()
    items: list[tuple] = []
    for row in rows:
        conv_id = int(row["conversation_id"])
        for draft in extract(row["content"], row["ts"]):
            day = datetime.fromtimestamp(draft.due_ts).date()
            known = seen.setdefault(conv_id, [])
            if any(d == day and k == draft.kind and _same_task(draft.title, t) for d, k, t in known):
                continue
            exact = (day, draft.kind, _title_key(draft.title))
            if exact in global_seen:
                continue
            known.append((day, draft.kind, draft.title))
            global_seen.add(exact)
            items.append(
                (
                    int(row["id"]),
                    conv_id,
                    draft.title,
                    draft.detail,
                    draft.due_ts,
                    draft.due_text,
                    int(draft.all_day),
                    draft.kind,
                )
            )
    inserted, total = store.replace_events(since, items)
    return {
        "scanned": len(rows),
        "matched": len(items),
        "inserted": inserted,
        "total": total,
        "elapsed": round(time.time() - started, 2),
    }


def _clip_text(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _excludes(cfg: Config) -> list[str]:
    kb = cfg.kb or {}
    return list(dict.fromkeys(
        list(kb.get("agenda_conv_exclude") or MARKETING_HINTS)
        + list((cfg.digest or {}).get("exclude_convs") or [])
    ))


def _ai_payload(rows, cfg: Config) -> list[dict]:
    """AI 只吃非本人、有文本、非营销会话的消息；按字符预算打包。"""
    budget = max(800, int(llm_mod.settings(cfg)["max_chars"]) - 600)
    excludes = _excludes(cfg)
    out: list[dict] = []
    used = 0
    for row in rows:
        if int(row["is_self"] or 0):
            continue
        text = str(row["content"] or "").strip()
        if len(text) < 4 or (text.startswith("[") and text.endswith("]")):
            continue
        conv = str(row["conv_name"] or "")
        if any(x and x in conv for x in excludes):
            continue
        moment = datetime.fromtimestamp(int(row["ts"]))
        item = {
            "id": int(row["id"]),
            "conv": conv,
            "sender": str(row["sender_name"] or ""),
            "time": f"{moment:%Y-%m-%d %H:%M}",
            "text": _clip_text(text, 220),
        }
        cost = len(json.dumps(item, ensure_ascii=False)) + 8
        if len(out) >= AI_MAX_MESSAGES or used + cost > budget:
            break
        used += cost
        out.append(item)
    return out


def _parse_due(value: str) -> datetime | None:
    raw = str(value or "").strip().replace("Z", "")
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def _ai_drafts(items: list[dict], rows_by_id: dict[int, object]) -> list[tuple]:
    drafts: list[tuple] = []
    for item in items:
        row = rows_by_id.get(int(item["id"]))
        if row is None:
            continue
        due = _parse_due(item["due"])
        if due is None:
            continue
        anchor = datetime.fromtimestamp(int(row["ts"]))
        if not (-60 <= (due.date() - anchor.date()).days <= 400):
            continue
        all_day = bool(item.get("all_day"))
        detail = item.get("detail") or _clip_text(row["content"], 200)
        drafts.append(
            (
                int(row["id"]),
                int(row["conversation_id"]),
                EventDraft(
                    title=item["title"],
                    detail=detail,
                    due_ts=int(due.timestamp()),
                    due_text=f"{due:%m-%d}" if all_day else f"{due:%m-%d %H:%M}",
                    all_day=all_day,
                    kind=item["kind"],
                ),
            )
        )
    return drafts


def _rule_drafts(rows) -> list[tuple]:
    drafts: list[tuple] = []
    for row in rows:
        for draft in extract(row["content"], row["ts"]):
            drafts.append((int(row["id"]), int(row["conversation_id"]), draft))
    return drafts


def _merge_drafts(store: Store, drafts: list[tuple]) -> list[tuple]:
    """和库内已有事件按「会话 + 日期 + 类型 + 标题」去重，再做全局精确去重。"""
    known: dict[int, list[tuple[date, str, str]]] = {}
    seen: set[tuple[date, str, str]] = set()
    for row in store.event_index():
        day = datetime.fromtimestamp(int(row["due_ts"])).date()
        known.setdefault(int(row["conversation_id"]), []).append(
            (day, row["kind"], row["title"])
        )
        seen.add((day, row["kind"], _title_key(row["title"])))
    items: list[tuple] = []
    for message_id, conv_id, draft in drafts:
        day = datetime.fromtimestamp(draft.due_ts).date()
        bucket = known.setdefault(conv_id, [])
        if any(d == day and k == draft.kind and _same_task(draft.title, t) for d, k, t in bucket):
            continue
        exact = (day, draft.kind, _title_key(draft.title))
        if exact in seen:
            continue
        bucket.append((day, draft.kind, draft.title))
        seen.add(exact)
        items.append(
            (
                message_id,
                conv_id,
                draft.title,
                draft.detail,
                draft.due_ts,
                draft.due_text,
                int(draft.all_day),
                draft.kind,
            )
        )
    return items


def update_agenda(store: Store, cfg: Config) -> dict | None:
    """只处理游标之后的新消息；AI 优先，失败或关闭时退回规则。"""
    started = time.time()
    cursor = store.agenda_cursor()
    max_id = store.max_message_id()
    if max_id <= 0:
        return None
    if cursor <= 0:
        # 首次迁移只做一次全量规则重建，之后严格按游标增量
        stats = rebuild(store)
        store.set_agenda_cursor(max_id, f"rebuild · 建库 {stats['total']} 项")
        stats.update({"mode": "rebuild", "ai_error": ""})
        return stats

    rows = store.messages_after_id(cursor, limit=INCREMENT_BATCH)
    if not rows:
        return None

    use_ai = (
        bool((cfg.agent or {}).get("agenda_ai", True))
        and llm_mod.available(cfg)
    )
    mode = "rules"
    ai_error = ""
    drafts: list[tuple]
    if use_ai:
        payload = _ai_payload(rows, cfg)
        if not payload:
            drafts, mode = [], "ai"
        else:
            ok, result = llm_mod.agenda_events(cfg, payload)
            if ok:
                drafts = _ai_drafts(result, {int(r["id"]): r for r in rows})
                mode = "ai"
                if result and not drafts:
                    drafts = _rule_drafts(rows)
                    ai_error = "AI 结果无法定位到原消息"
            else:
                drafts = _rule_drafts(rows)
                ai_error = str(result)
    else:
        drafts = _rule_drafts(rows)

    items = _merge_drafts(store, drafts)
    inserted, total = store.insert_events(items)
    store.set_agenda_cursor(
        int(rows[-1]["id"]), f"{mode} · 扫描 {len(rows)} · 新增 {inserted}"
    )
    return {
        "scanned": len(rows),
        "matched": len(items),
        "inserted": inserted,
        "total": total,
        "mode": mode,
        "ai_error": ai_error,
        "elapsed": round(time.time() - started, 2),
    }


def group_by_day(rows, now_ts: int | None = None) -> list[tuple[str, list]]:
    now_ts = int(now_ts or time.time())
    today = datetime.fromtimestamp(now_ts).date()
    groups: list[tuple[str, list]] = []
    current_label = None
    for row in rows:
        day = datetime.fromtimestamp(int(row["due_ts"])).date()
        label = f"{day:%m-%d} 周{WEEKDAY_CN[day.weekday()]}"
        if day < today:
            label += " · 已逾期"
        elif day == today:
            label += " · 今天"
        elif day == today + timedelta(days=1):
            label += " · 明天"
        if label != current_label:
            groups.append((label, []))
            current_label = label
        groups[-1][1].append(row)
    return groups


def due_label(row) -> str:
    dt = datetime.fromtimestamp(int(row["due_ts"]))
    return "全天" if int(row["all_day"]) else f"{dt:%H:%M}"


def summary(rows, now_ts: int | None = None) -> tuple[int, int, int]:
    now_ts = int(now_ts or time.time())
    today = datetime.fromtimestamp(now_ts).date()
    week_end = today + timedelta(days=7)
    overdue = tdy = week = 0
    for row in rows:
        day = datetime.fromtimestamp(int(row["due_ts"])).date()
        if day < today:
            overdue += 1
        elif day == today:
            tdy += 1
        elif day < week_end:
            week += 1
    return overdue, tdy, week


def _ics_escape(text: str) -> str:
    return (
        (text or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\n")
        .replace("\n", "\\n")
    )


def _ics_fold(line: str) -> str:
    out = []
    raw = line.encode("utf-8")
    limit = 74
    while len(raw) > limit:
        cut = limit
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(raw[:cut].decode("utf-8"))
        raw = b" " + raw[cut:]
        limit = 73
    out.append(raw.decode("utf-8"))
    return "\r\n".join(out)


def to_ics(rows) -> str:
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//InfoHub//Agenda//CN",
        "CALSCALE:GREGORIAN",
        "X-WR-CALNAME:InfoHub 日程",
    ]
    for row in rows:
        dt = datetime.fromtimestamp(int(row["due_ts"]))
        uid = hashlib.md5(
            f"{row['message_id']}|{row['due_ts']}|{row['title']}".encode("utf-8")
        ).hexdigest()
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{uid}@infohub.local")
        lines.append(f"DTSTAMP:{stamp}")
        if int(row["all_day"]):
            lines.append(f"DTSTART;VALUE=DATE:{dt:%Y%m%d}")
            lines.append(f"DTEND;VALUE=DATE:{(dt + timedelta(days=1)):%Y%m%d}")
        else:
            lines.append(f"DTSTART:{dt:%Y%m%dT%H%M%S}")
            lines.append(f"DTEND:{(dt + timedelta(hours=1)):%Y%m%dT%H%M%S}")
        lines.append("SUMMARY:" + _ics_escape(row["title"]))
        description = (
            f"来源：{row['conv_name']}（{row['sender_name']}）\n"
            f"原消息 {datetime.fromtimestamp(int(row['msg_ts'])):%Y-%m-%d %H:%M}\n"
            f"{str(row['content'])[:300]}"
        )
        lines.append("DESCRIPTION:" + _ics_escape(description))
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_ics_fold(line) for line in lines) + "\r\n"
