from __future__ import annotations

import hashlib
import html as html_lib
import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from ..models import Conversation, Message, SyncReport
from ..store import _content_hash, _norm_text
from .media import MediaIndex

_BS = "\\"
_QUOTE = '"'

_FNAME = re.compile(r"^(friend|group)_(.*)_(\d{5,12})_(\d{8}_?\d{6,12})\.(txt|html)$", re.I)
_META = re.compile(r"QCE_METADATA: (\{.*?\}) -->")
_TXT_HEAD_NAME = re.compile(r"^聊天名称:\s*(.+)$", re.M)
_TXT_HEAD_TYPE = re.compile(r"^聊天类型:\s*(.+)$", re.M)
_TXT_BLOCK = re.compile(
    r"^(?P<sender>[^\n]+?):\n时间: (?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\n内容: ",
    re.M,
)


@dataclass
class ParsedChat:
    conversation: Conversation
    messages: list[Message]
    source_file: str
    kind: str = "html"
    warnings: list[str] = field(default_factory=list)


def _slice(text: str, start: int, open_ch: str, close_ch: str) -> str:
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == _BS:
                esc = True
            elif ch == _QUOTE:
                in_str = False
            continue
        if ch == _QUOTE:
            in_str = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("括号不匹配")


def _json_after(text: str, marker: str, open_ch: str = "{") -> dict | None:
    idx = text.find(marker)
    if idx < 0:
        return None
    start = text.find(open_ch, idx + len(marker))
    if start < 0:
        return None
    try:
        return json.loads(_slice(text, start, open_ch, "}" if open_ch == "{" else "]"))
    except (ValueError, json.JSONDecodeError):
        return None


def _chunk_messages(text: str) -> list[dict]:
    messages: list[dict] = []
    for m in re.finditer(r"window\.__QCE_CHUNK__\s*&&\s*window\.__QCE_CHUNK__\(\s*\{", text):
        key = text.find("messages:[", m.end())
        if key < 0:
            continue
        start = text.find("[", key)
        try:
            arr = json.loads(_slice(text, start, "[", "]"))
        except (ValueError, json.JSONDecodeError):
            continue
        if isinstance(arr, list):
            messages.extend(x for x in arr if isinstance(x, dict))
    return messages


_CONTENT_OPEN = re.compile(r'<div\s+class="content"\s*>', re.I)


def _content_block(raw: str) -> str:
    m = _CONTENT_OPEN.search(raw or "")
    if not m:
        return raw or ""
    start = m.end()
    depth = 1
    for tag in re.finditer(r"<div\b[^>]*>|</div\s*>", raw[start:], re.I):
        depth += -1 if tag.group(0).startswith("</") else 1
        if depth == 0:
            return raw[start : start + tag.start()]
    return raw[start:]


def _img_placeholder(tag: str) -> str:
    src = re.search(r'src="([^"]*)"', tag, re.I)
    if src and "resources/images/" in src.group(1):
        return f"[图片:{src.group(1).rsplit('/', 1)[-1]}]"
    alt = re.search(r'alt="([^"]*)"', tag, re.I)
    return alt.group(1) if alt and alt.group(1).strip() else "[图片]"


def _html_text(raw: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    s = re.sub(r"<img[^>]*>", lambda m: _img_placeholder(m.group(0)), s, flags=re.I)
    s = re.sub(r"<(audio|video)[^>]*>.*?</\1>", "[媒体]", s, flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html_lib.unescape(s)
    s = re.sub(r"\d{4}-\d{2}-\d{2}(\s*周[一二三四五六日天])?", " ", s)
    s = re.sub(r"\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?", " ", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def infer_type(content: str) -> tuple[int, str]:
    text = (content or "").lstrip()
    if text.startswith("[图片"):
        return 3, "图片"
    if text.startswith("[文件"):
        return 6, "文件"
    if text.startswith("[语音"):
        return 34, "语音"
    if text.startswith("[视频"):
        return 43, "视频"
    if text.startswith("[表情") or text.startswith("[动画表情"):
        return 47, "表情"
    if text.startswith("[链接"):
        return 49, "链接"
    if text.startswith("[系统") or text.startswith("[通知"):
        return 10000, "系统消息"
    return 1, "文本"


def parse_html(path: Path) -> ParsedChat:
    text = path.read_text(encoding="utf-8", errors="replace")
    meta = {}
    m = _META.search(text)
    if m:
        try:
            meta = json.loads(m.group(1))
        except json.JSONDecodeError:
            meta = {}
    manifest = _json_after(text, "window.__QCE_MANIFEST__ && window.__QCE_MANIFEST__(") or {}
    chat = manifest.get("chat") or {}
    raw_messages = _chunk_messages(text)
    if not raw_messages:
        raise ValueError("HTML 中没有找到消息数据（可能是旧版单文件导出）")

    chat_type = str(chat.get("type") or meta.get("chatType") or "private").lower()
    kind = "group" if chat_type in {"group", "groups", "discuss"} else "private"
    uin = str(chat.get("peerUin") or meta.get("peerUin") or chat.get("peerUid") or meta.get("peerUid") or "")
    if not uin:
        fm = _FNAME.match(path.name)
        uin = fm.group(3) if fm else path.stem
    name = str(chat.get("name") or meta.get("chatName") or uin)
    avatar = str(chat.get("avatar") or meta.get("avatarUrl") or "")
    self_uid = str(chat.get("selfUid") or "")
    self_name = str(chat.get("selfName") or "我")
    account = str(chat.get("selfUin") or "")

    messages: list[Message] = []
    for raw in raw_messages:
        ts = int(raw.get("ts") or 0)
        ts = ts // 1000 if ts > 10_000_000_000 else ts
        content = (raw.get("text") or "").strip()
        if not content:
            content = _html_text(_content_block(raw.get("html") or "")) or "[媒体消息]"
        sender_uid = str(raw.get("uid") or "")
        sender_name = str(raw.get("name") or "") or ("我" if sender_uid and sender_uid == self_uid else "未知成员")
        type_code, type_label = infer_type(content)
        external_id = str(raw.get("id") or "")
        if not external_id:
            external_id = "h:" + hashlib.md5(
                f"{ts}|{sender_name}|{content}".encode("utf-8", "replace")
            ).hexdigest()[:20]
        messages.append(
            Message(
                external_id=external_id,
                ts=max(ts, 0),
                sender_id=sender_uid,
                sender_name=sender_name,
                is_self=(sender_uid == self_uid) if self_uid else None,
                type_code=type_code,
                type_label=type_label,
                content=content,
            )
        )
    messages.sort(key=lambda x: x.ts)
    last_ts = messages[-1].ts if messages else 0
    conv = Conversation(
        source="qq",
        account="",
        external_id=f"qq:{kind}:{uin}",
        name=name,
        kind=kind,
        avatar=avatar,
        last_ts=last_ts,
        meta={"peer_uid": chat.get("peerUid") or "", "self_name": self_name, "self_uin": account},
    )
    return ParsedChat(conversation=conv, messages=messages, source_file=str(path), kind="html")


def parse_txt(path: Path) -> ParsedChat:
    text = path.read_text(encoding="utf-8", errors="replace")
    text = re.split(r"\n=+\s*\n\s*导出完成", text)[0]
    m = _FNAME.match(path.name)
    file_kind = (m.group(1).lower() if m else "friend")
    file_uin = m.group(3) if m else path.stem
    kind = "group" if file_kind == "group" else "private"
    name_match = _TXT_HEAD_NAME.search(text)
    name = (name_match.group(1).strip() if name_match else path.stem)
    type_match = _TXT_HEAD_TYPE.search(text)
    if type_match and "群" in type_match.group(1):
        kind = "group"

    blocks = list(_TXT_BLOCK.finditer(text))
    if not blocks:
        raise ValueError("TXT 中没有找到消息块")
    messages: list[Message] = []
    for index, block in enumerate(blocks):
        start = block.end()
        end = blocks[index + 1].start() if index + 1 < len(blocks) else len(text)
        content = text[start:end].strip()
        sender = block.group("sender").strip()
        try:
            ts = int(datetime.strptime(block.group("ts"), "%Y-%m-%d %H:%M:%S").timestamp())
        except ValueError:
            continue
        content = re.sub(r"\n{3,}", "\n\n", content)
        content = "\n".join(
            line for line in content.splitlines() if set(line.strip()) != {"="}
        ).strip()
        type_code, type_label = infer_type(content)
        digest = hashlib.md5(f"{ts}|{sender}|{content}".encode("utf-8", "replace")).hexdigest()[:20]
        messages.append(
            Message(
                external_id=f"t:{digest}",
                ts=ts,
                sender_id=sender,
                sender_name=sender,
                is_self=None,
                type_code=type_code,
                type_label=type_label,
                content=content,
            )
        )
    if not messages:
        raise ValueError("TXT 中没有解析出消息")
    last_ts = messages[-1].ts
    conv = Conversation(
        source="qq",
        account="",
        external_id=f"qq:{kind}:{file_uin}",
        name=name,
        kind=kind,
        last_ts=last_ts,
        meta={},
    )
    return ParsedChat(conversation=conv, messages=messages, source_file=str(path), kind="txt")


def parse_export(path: Path) -> ParsedChat:
    suffix = path.suffix.lower()
    if suffix == ".html":
        return parse_html(path)
    if suffix == ".txt":
        return parse_txt(path)
    raise ValueError(f"不支持的文件类型：{suffix}")


def _norm_sender(name: str | None) -> str:
    return re.sub(r"\s+", "", name or "")


_REPLY_HEAD = re.compile(r"^\[回复消息\]")
_QUOTE_LINE = re.compile(r"^回复\s*[:：]\s*(?:.*?\s-\s)?(.*)$")


def _sender_match(a: str, b: str) -> bool:
    return bool(a and b) and (a == b or a in b or b in a)


def _txt_duplicate(msg: Message, candidates) -> bool:
    """TXT 会改写引用/提及，正文常是 HTML 版正文的超集，按包含关系判定重复。"""
    raw = (msg.content or "").strip()
    norm = _norm_text(raw)
    placeholder = norm == "[json消息]"
    if len(norm) < 2 and not placeholder:
        return False
    sender = _norm_sender(msg.sender_name)
    parts: list[str] | None = None
    if raw.startswith("[回复消息]"):
        body = _norm_text(_REPLY_HEAD.sub("", raw))
        quote = ""
        for line in raw.splitlines():
            m = _QUOTE_LINE.match(line.strip())
            if m:
                quote = _norm_text(m.group(1))
        parts = [p for p in (body, quote) if len(p) >= 2]
    for cand, cand_sender in candidates:
        if not _sender_match(sender, cand_sender):
            continue
        if placeholder:
            return bool(cand)
        if parts is not None:
            if parts and all(p in cand for p in parts):
                return True
            continue
        if len(cand) >= 2 and (norm in cand or cand in norm):
            return True
    return False


def _unique_files(export_dir: Path) -> list[Path]:
    files = []
    for pattern in ("*.html", "*.txt"):
        files.extend(export_dir.glob(pattern))
    files = [f for f in files if f.is_file() and _FNAME.match(f.name)]
    files.sort(key=lambda p: (0 if p.suffix.lower() == ".html" else 1, p.stat().st_mtime))
    return files


def import_dir(store, export_dir: str | Path, progress=None, force: bool = False) -> SyncReport:
    started = time.time()
    report = SyncReport(source="qq")
    progress = progress or (lambda *a, **k: None)
    root = Path(export_dir)
    if not root.is_dir():
        report.errors.append(f"QQ 导出目录不存在：{root}")
        store.record_source("qq", "error", report.errors[-1])
        return report

    files = _unique_files(root)
    report.scanned_files = len(files)
    seen_convs: set[int] = set()
    media = MediaIndex(root, Path(store.path).parent / "media" / "thumbs")
    total = len(files)
    for index, path in enumerate(files, 1):
        name = path.name
        progress(f"QQ · {name}", index, total)
        try:
            stat = path.stat()
        except OSError as exc:
            report.errors.append(f"{name}: {exc}")
            continue
        if not force and store.file_unchanged(str(path), stat.st_size, stat.st_mtime):
            report.skipped += 1
            continue
        try:
            parsed = parse_export(path)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"{name}: {exc}")
            store.note_file(str(path), stat.st_size, stat.st_mtime, 0, "error", str(exc))
            continue

        conv_id = store.upsert_conversation(parsed.conversation)
        seen_convs.add(conv_id)
        messages = parsed.messages
        if messages:
            min_ts = min(m.ts for m in messages)
            max_ts = max(m.ts for m in messages)
            existing = store.content_keys(conv_id, min_ts - 1, max_ts + 1)
            near: dict[int, list[tuple[str, str]]] = {}
            for row in store.recent_contents(conv_id, min_ts - 1, max_ts + 1):
                near.setdefault(int(row["ts"]), []).append(
                    (_norm_text(row["content"]), _norm_sender(row["sender_name"]))
                )
            is_txt = path.suffix.lower() == ".txt"
            filtered = []
            for msg in messages:
                key = (msg.ts, _content_hash(msg.content))
                if key in existing:
                    continue
                if is_txt and _txt_duplicate(msg, near.get(msg.ts, ())):
                    continue
                existing.add(key)
                near.setdefault(msg.ts, []).append(
                    (_norm_text(msg.content), _norm_sender(msg.sender_name))
                )
                filtered.append(msg)
            messages = filtered
        added, _ = store.add_messages(conv_id, messages)
        report.added += added
        media_items = []
        for msg in parsed.messages:
            found = media.resolve(msg.content)
            if found:
                media_items.append((msg.external_id, *found))
        if media_items:
            store.attach_media(conv_id, media_items)
        store.note_file(
            str(path), stat.st_size, stat.st_mtime, added, "ok", f"{parsed.kind} {len(parsed.messages)} 条"
        )

    report.conversations = len(seen_convs)
    if report.errors:
        store.record_source("qq", "partial", f"{report.summary()}；例：{report.errors[0][:120]}")
    else:
        store.record_source("qq", "ok", report.summary())
    report.elapsed = time.time() - started
    return report
