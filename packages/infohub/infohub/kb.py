"""把 InfoHub 的日程、通知候选和聊天资源写进 Obsidian 知识库。

三条落点（均为自动维护，重跑覆盖）：

- ``学院事务/日程安排.md``：只在 ``infohub:agenda`` 标记之间写入，手写内容一字不动
- ``学院事务/班级管理/InfoHub-通知候选.md``：通知候选池，勾选状态跨次保留
- ``知识库/学院事务/附件/InfoHub/`` + ``知识库/学院事务/InfoHub-资源索引.md``：
  聊天里的文件和图片按内容哈希去重归档，并生成索引页
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

from .agenda import due_label, group_by_day
from .config import Config
from .sources.media import make_preview
from .store import Store

AGENDA_START = "<!-- infohub:agenda:start -->"
AGENDA_END = "<!-- infohub:agenda:end -->"
DEFAULT_VAULT = "D:\\Obsidian"
SCHEDULE_REL = "学院事务/日程安排.md"
NOTICE_REL = "学院事务/班级管理/InfoHub-通知候选.md"
MEDIA_DIR_REL = "知识库/学院事务/附件/InfoHub"
MEDIA_INDEX_REL = "知识库/学院事务/InfoHub-资源索引.md"

DEFAULT_NOTICE_KEYWORDS = (
    "班群", "班团", "晚自习", "秘书处", "活动指导部", "叶老师", "导学员",
    "市调", "市场调查", "品牌策划", "商赛", "大广赛", "体委", "生活委员",
    "学生会", "学院", "金融2601", "金融2602", "金融2603", "国贸", "数字经济",
    "李旻晶", "客服", "体育部", "经院", "团支书", "学习委员",
)

# 商家促销群里的「活动时间」会被识别成日程，写进日程表只会添乱
DEFAULT_AGENDA_EXCLUDE = (
    "塔斯汀", "瑞幸", "美团", "神券", "钱总", "外卖", "宠粉", "福利群",
    "秒杀", "特价", "肯德基", "麦当劳", "蜜雪",
)

WEEKDAY_CN = "一二三四五六日"

_STRONG = re.compile(
    r"截止|截至|报名|提交|上交|缴纳|缴费|交费|领取|开会|会议|班会|讲座|培训|"
    r"考试|竞赛|大赛|选举|投票|档案|助学|评议|填报|核对|接龙|问卷|签到|"
    r"排练|汇总|统计|收取|通知|务必|请于|请各位|请各班|全体成员|材料"
)
_WEAK = re.compile(
    r"安排|要求|名单|表格|确认|完成|参加|时间|地点|教室|交到|报备|请假|申请|"
    r"负责|配合|注意|记得|带上|携带|发放|填写"
)
_QUESTION = re.compile(
    r"[?？]|吗|呢|吧|啊|呀|嘛|要不要|有没有|是不是|能不能|可不可以|行不行|几点|什么时候|怎么|什么"
)
_IMPERATIVE = re.compile(r"请|务必|须|需|通知|截止|截至|记得|要求|注意")
_SKIP = re.compile(
    r"撤回了一条消息|加入了?群聊|修改群名|领取了你的|红包|小程序|接龙成功|"
    r"^\s*\[(?:图片|表情|语音|视频|文件|位置|名片)\]|^\s*@全体成员\s*$"
)
_PRIVATE = re.compile(
    r"助学金|困难|家庭|身份证|选民|选票|名单|成绩|银行卡|手机号|电话|隐私|评议|个人|寝室"
)
_BAD_FILENAME = re.compile(r'[\\/:*?"<>|#\[\]^]')

# 这些行每次都变，比对时忽略，保证重复导出不产生无意义改动
_VOLATILE = re.compile(
    r"(?m)^(?:updated: .*|> 本次扫描.*|> 由 InfoHub 从工作类会话自动抽取.*"
    r"|## InfoHub 自动日程（.*更新）|# InfoHub 通知候选（.*）)$"
)


def detect_vault() -> str:
    env = os.environ.get("INFOHUB_VAULT")
    candidates = [Path(env)] if env else []
    candidates += [Path(DEFAULT_VAULT), Path.home() / "Obsidian"]
    for path in candidates:
        if (path / ".obsidian").is_dir():
            return str(path)
    return DEFAULT_VAULT


def _stable(text: str) -> str:
    return _VOLATILE.sub("", text).strip()


def _write_if_changed(path: Path, text: str) -> bool:
    if path.exists():
        try:
            old = path.read_text(encoding="utf-8")
        except OSError:
            old = ""
        if _stable(old) == _stable(text):
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def _cell(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).replace("|", "\\|").strip()


def _excerpt(text: str, limit: int = 160) -> str:
    flat = re.sub(r"\s+", " ", str(text or "")).strip()
    flat = re.sub(r"\[CQ:[^\]]+\]", "", flat)
    return flat if len(flat) <= limit else flat[:limit].rstrip() + "…"


def _fmt(ts: int) -> str:
    return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")


def _hm(ts: int) -> str:
    return datetime.fromtimestamp(int(ts)).strftime("%H:%M")


def _source_label(row) -> str:
    return "QQ" if row["source"] == "qq" else "微信"


# ---------- 日程区块 ----------


def render_agenda(rows, now_ts: int, overdue_days: int, future_days: int) -> str:
    stamp = datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M")
    lines = [
        AGENDA_START,
        f"## InfoHub 自动日程（{stamp} 更新）",
        "",
        f"> 由 InfoHub 从聊天记录自动识别，**只维护本区块**；窗口：逾期 {overdue_days} 天 / "
        f"未来 {future_days} 天，共 **{len(rows)}** 项。原文与跳转见 InfoHub 的「日程」面板。",
    ]
    if not rows:
        lines += ["", "> 当前窗口内没有识别到日程。"]
    else:
        now = int(now_ts)
        for label, group in group_by_day(rows, now):
            lines += ["", f"### {label}", "", "| 时间 | 事项 | 来源 |", "|---|---|---|"]
            for row in group:
                title = _cell(row["title"])
                if int(row["due_ts"]) < now:
                    title = f"⚠️ {title}"
                source = (
                    f"{_source_label(row)} · {_cell(row['conv_name'])} · "
                    f"{_cell(row['sender_name'] or '—')} · "
                    f"{datetime.fromtimestamp(int(row['msg_ts'])):%m-%d %H:%M}"
                )
                lines.append(f"| {due_label(row)} | {title} | {source} |")
    lines += [
        "",
        "> 本区块由 `infohub kb` 生成，手改会在下次导出时被覆盖；要改识别口径请调整 "
        "`infohub/agenda.py` 后执行 `infohub agenda --rebuild`。",
        AGENDA_END,
    ]
    return "\n".join(lines)


def _replace_block(text: str, block: str) -> str:
    if AGENDA_START in text and AGENDA_END in text:
        start = text.index(AGENDA_START)
        end = text.index(AGENDA_END, start) + len(AGENDA_END)
        head = text[:start].rstrip("\n")
        tail = text[end:].lstrip("\n")
        return head + "\n\n" + block + ("\n\n" + tail if tail else "\n")
    pos = text.find("\n## 相关")
    if pos == -1:
        return text.rstrip("\n") + "\n\n" + block + "\n"
    head = text[:pos].rstrip("\n")
    tail = text[pos:].lstrip("\n")
    return head + "\n\n" + block + "\n\n" + tail


def export_agenda(
    store: Store,
    vault: Path,
    now_ts: int,
    days: int = 30,
    overdue_days: int = 3,
    excludes=DEFAULT_AGENDA_EXCLUDE,
) -> dict:
    path = vault / SCHEDULE_REL
    rows = [
        row
        for row in store.agenda(now_ts - overdue_days * 86400, now_ts + days * 86400)
        if not any(x and x in (row["conv_name"] or "") for x in excludes)
    ]
    block = render_agenda(rows, now_ts, overdue_days, days)
    if not path.exists():
        text = "# 日程安排\n\n## 相关\n"
    else:
        text = path.read_text(encoding="utf-8")
    changed = _write_if_changed(path, _replace_block(text, block))
    return {"path": str(path), "rows": len(rows), "changed": changed}


# ---------- 通知候选 ----------


def is_notice_text(text: str) -> bool:
    raw = str(text or "").strip()
    if len(raw) < 16 or len(raw) > 4000:
        return False
    if _SKIP.search(raw):
        return False
    if "「引用」" in raw or "[回复消息]" in raw or "[转发消息" in raw:
        return False
    strong = len(set(_STRONG.findall(raw)))
    weak = len(set(_WEAK.findall(raw)))
    if _QUESTION.search(raw) and not _IMPERATIVE.search(raw):
        return False
    return strong >= 2 or (strong >= 1 and weak >= 2)


def suggest_channel(text: str) -> str:
    return "私发" if _PRIVATE.search(str(text or "")) else "群发"


def _is_work_conv(name: str, keywords, excludes) -> bool:
    if not name:
        return False
    if any(x and x in name for x in excludes):
        return False
    return any(k and k in name for k in keywords)


def pick_candidates(rows, keywords, excludes=(), limit: int = 150) -> list[dict]:
    picked: list[dict] = []
    for row in rows:
        if row["is_self"]:
            continue
        if (row["sender_name"] or "") in ("付梓杨", "林寸"):
            continue
        if not _is_work_conv(row["conv_name"] or "", keywords, excludes):
            continue
        if not is_notice_text(row["content"]):
            continue
        picked.append(
            {
                "id": int(row["id"]),
                "ts": int(row["ts"]),
                "conv": row["conv_name"] or "",
                "sender": row["sender_name"] or "",
                "source": row["source"],
                "content": row["content"] or "",
                "channel": suggest_channel(row["content"]),
            }
        )
    picked.sort(key=lambda item: -item["ts"])
    return picked[:limit]


def _checked_ids(text: str) -> set[int]:
    return {int(x) for x in re.findall(r"\[x\][^\n]*<!-- m:(\d+) -->", text, flags=re.I)}


def render_notices(
    picked: list[dict],
    now_ts: int,
    days: int,
    checked: set[int],
    total_scanned: int,
) -> str:
    stamp = datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M")
    group_count = sum(1 for c in picked if c["channel"] == "群发")
    private_count = len(picked) - group_count
    lines = [
        "---",
        "title: InfoHub 通知候选",
        "type: checklist",
        "owner: 付梓杨",
        f"updated: {stamp}",
        "tags: [院务, 班级管理, 在办]",
        "---",
        "",
        f"# InfoHub 通知候选（{stamp}）",
        "",
        f"> 由 InfoHub 从工作类会话自动抽取近 {days} 天消息（扫描 {total_scanned} 条），"
        f"命中 **{len(picked)}** 条：建议群发 {group_count} 条、建议私发 {private_count} 条。",
        "> **这里只放候选，不替你判断该不该发**。勾选状态会保留；`<!-- m:ID -->` 用于对齐原消息，勿删。",
        "> 定稿后把要发的条目并入 [[学院事务/班级管理/通知清单|通知清单]]，再按 [[学院事务/班级管理/私发清单|私发清单]] 的口径发送。",
    ]
    if not picked:
        lines += ["", "> 当前窗口内没有命中通知类消息。"]
    current_day = None
    for item in picked:
        day = datetime.fromtimestamp(item["ts"]).date()
        if day != current_day:
            current_day = day
            lines += ["", f"## {day:%m-%d} 周{WEEKDAY_CN[day.weekday()]}", ""]
        box = "x" if item["id"] in checked else " "
        channel = "**建议私发**" if item["channel"] == "私发" else "群发"
        lines.append(
            f"- [{box}] **{_hm(item['ts'])} · {_cell(item['conv'])} · "
            f"{_cell(item['sender'] or '—')}** · {channel} <!-- m:{item['id']} -->"
        )
        lines.append(f"  > {_excerpt(item['content'])}")
    lines += [
        "",
        "## 相关",
        "",
        "- [[学院事务/班级管理/通知清单|通知清单]]",
        "- [[学院事务/班级管理/私发清单|私发清单]]",
        "- [[学院事务/日程安排|日程安排]]",
        "- [[学院事务/班级管理/金融2601班|金融2601班]]",
        "",
    ]
    return "\n".join(lines)


def export_notices(
    store: Store,
    vault: Path,
    now_ts: int,
    days: int = 7,
    limit: int = 150,
    keywords=DEFAULT_NOTICE_KEYWORDS,
    excludes=(),
) -> dict:
    path = vault / NOTICE_REL
    since = now_ts - days * 86400
    rows = store.notice_messages(since, now_ts)
    picked = pick_candidates(rows, keywords, excludes, limit)
    checked = _checked_ids(path.read_text(encoding="utf-8")) if path.exists() else set()
    kept = len([item for item in picked if item["id"] in checked])
    text = render_notices(picked, now_ts, days, checked, len(rows))
    changed = _write_if_changed(path, text)
    return {
        "path": str(path),
        "candidates": len(picked),
        "checked": kept,
        "scanned": len(rows),
        "changed": changed,
    }


# ---------- 资源归档 ----------


def _sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _digest_cached(path: Path, cache: dict) -> str | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    hit = cache.get(str(path))
    if hit and hit.get("mtime") == stat.st_mtime_ns and hit.get("size") == stat.st_size:
        return hit.get("digest")
    digest = _sha1_file(path)
    cache[str(path)] = {"digest": digest, "mtime": stat.st_mtime_ns, "size": stat.st_size}
    return digest


def _safe_filename(row, digest: str) -> str:
    name = row["name"] or os.path.basename(row["path"] or "")
    stem, ext = os.path.splitext(name)
    ext = _BAD_FILENAME.sub("", ext)[:12]
    stem = _BAD_FILENAME.sub("_", stem).strip(" ._")
    if not stem or re.fullmatch(r"[0-9a-fA-F_\-]{18,}", stem):
        stem = f"{'图片' if row['kind'] == 'image' else '文件'}-{digest[:10]}"
    stem = re.sub(r"\s+", " ", stem)[:70].strip()
    return f"{datetime.fromtimestamp(int(row['ts'])):%Y%m%d}-{stem}{ext}"


def _human_size(size: int) -> str:
    units = ("B", "KB", "MB", "GB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def _wikilink(rel: str, alias: str) -> str:
    return f"[[{rel}|{_cell(alias)}]]"


def _load_manifest(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("files"), dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return {"version": 1, "created": datetime.now().strftime("%Y-%m-%d"), "files": {}}


def _save_manifest(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == text:
                return
        except OSError:
            pass
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _compress_legacy(vault: Path, manifest: dict, preview_dir: Path) -> tuple[int, int]:
    """把早期按原图归档的图片就地压成预览版，并按新内容哈希重新登记。

    返回 (压缩张数, 省下的字节)。源图已不在本机时也照样处理——档案里的那份
    往往是唯一副本，压完原文件才删除。
    """
    done = saved = 0
    for old_digest, entry in list(manifest["files"].items()):
        if entry.get("kind") == "file" or entry.get("variant") in ("preview", "source"):
            continue
        path = vault / str(entry.get("path") or "")
        if not path.is_file():
            continue
        preview = make_preview(path, preview_dir)
        if preview is None:
            entry["variant"] = "source"
            continue
        raw_size = int(entry.get("raw_size") or entry.get("size") or 0)
        new_digest = _sha1_file(preview)
        if new_digest == old_digest:
            entry["variant"] = "source"
            preview.unlink(missing_ok=True)
            continue
        existing = manifest["files"].get(new_digest)
        if existing is not None and existing is not entry:
            # 同一张图已经以新条目归档过，旧的原图副本可以丢掉
            path.unlink(missing_ok=True)
            del manifest["files"][old_digest]
            done += 1
            saved += max(0, raw_size - int(existing.get("size") or 0))
            preview.unlink(missing_ok=True)
            continue
        dest = path.with_suffix(".jpg")
        if dest.exists() and dest != path:
            dest = path.with_name(f"{path.stem}-{new_digest[:6]}.jpg")
        shutil.copy2(preview, dest)
        if dest != path:
            path.unlink(missing_ok=True)
        preview.unlink(missing_ok=True)
        del manifest["files"][old_digest]
        entry.update(
            {
                "path": dest.relative_to(vault).as_posix(),
                "name": os.path.splitext(entry.get("name") or path.name)[0] + ".jpg",
                "size": dest.stat().st_size,
                "raw_size": raw_size,
                "variant": "preview",
            }
        )
        manifest["files"][new_digest] = entry
        done += 1
        saved += max(0, raw_size - int(entry["size"]))
    return done, saved


def _archive_source(row, preview_dir: Path | None) -> tuple[Path, str]:
    src = Path(row["path"] or "")
    if row["kind"] == "file" or preview_dir is None:
        return src, "source"
    preview = make_preview(src, preview_dir)
    return (preview, "preview") if preview else (src, "source")


def export_media(
    store: Store,
    vault: Path,
    manifest_path: Path,
    now_ts: int,
    days: int = 0,
    progress=None,
    preview_dir: Path | None = None,
    voices: dict[str, str] | None = None,
    skip_bytes: int = 0,
) -> dict:
    media_root = vault / MEDIA_DIR_REL
    manifest = _load_manifest(manifest_path)
    digests = manifest.setdefault("sources", {})
    seen_sources: dict[str, dict] = {}
    since = now_ts - days * 86400 if days > 0 else 0
    rows = store.media_messages(since)
    total = len(rows)
    progress = progress or (lambda *a, **k: None)
    new = reused = missing = skipped = 0
    bytes_new = 0
    compressed, saved = (0, 0)
    if preview_dir is not None:
        legacy = [
            e
            for e in manifest["files"].values()
            if e.get("kind") != "file" and e.get("variant") not in ("preview", "source")
        ]
        if legacy and manifest_path.exists():
            # 动原图前留一份改动前的档案清单，出问题可对照恢复
            shutil.copy2(manifest_path, manifest_path.with_name("kb_manifest.backup.json"))
        progress("压缩历史归档图片", 0, 1)
        compressed, saved = _compress_legacy(vault, manifest, preview_dir)
    groups: dict[str, dict] = {}
    for index, row in enumerate(rows, 1):
        progress("归档聊天资源", index, total)
        if not row["path"] or not Path(row["path"]).is_file():
            missing += 1
            continue
        if skip_bytes and row["kind"] == "file":
            try:
                if Path(row["path"]).stat().st_size > skip_bytes:
                    skipped += 1
                    continue
            except OSError:
                missing += 1
                continue
        src, variant = _archive_source(row, preview_dir)
        digest = _digest_cached(src, digests)
        if digest is None:
            missing += 1
            continue
        seen_sources[str(src)] = digests[str(src)]
        raw_size = Path(row["path"]).stat().st_size
        group = groups.setdefault(
            digest,
            {
                "row": row,
                "src": src,
                "copies": 0,
                "size": src.stat().st_size,
                "raw": raw_size,
                "variant": variant,
            },
        )
        group["copies"] += 1
        if int(row["ts"]) >= int(group["row"]["ts"]):
            group["row"] = row
            group["src"] = src
            group["raw"] = raw_size
            group["variant"] = variant
    for digest, group in groups.items():
        row = group["row"]
        known = manifest["files"].get(digest)
        if known and (vault / known["path"]).is_file():
            reused += 1
        else:
            dest_dir = media_root / f"{datetime.fromtimestamp(int(row['ts'])):%Y-%m}"
            dest_dir.mkdir(parents=True, exist_ok=True)
            name = _safe_filename(row, digest)
            if group["variant"] == "preview":
                name = os.path.splitext(name)[0] + ".jpg"
            dest = dest_dir / name
            if dest.exists():
                stem, ext = os.path.splitext(name)
                dest = dest_dir / f"{stem}-{digest[:6]}{ext}"
            shutil.copy2(group["src"], dest)
            known = {
                "path": dest.relative_to(vault).as_posix(),
                "name": row["name"] if group["variant"] == "source" else dest.name,
                "kind": row["kind"],
                "size": int(group["size"]),
                "raw_size": int(group["raw"]),
                "message_id": int(row["message_id"]),
            }
            if preview_dir is not None:
                known["variant"] = group["variant"]
            manifest["files"][digest] = known
            new += 1
            bytes_new += int(group["size"])
            saved += max(0, int(group["raw"]) - int(group["size"]))
        known.update(
            {
                "ts": int(row["ts"]),
                "conv": row["conv_name"] or "",
                "sender": row["sender_name"] or "",
                "copies": int(group["copies"]),
                "raw_size": int(group["raw"]),
            }
        )
        if preview_dir is not None:
            known["variant"] = group["variant"]
        if row["kind"] == "voice" and voices:
            text = voices.get(Path(row["path"]).stem.lower())
            if text:
                known["text"] = text
    manifest["sources"] = seen_sources
    stale = [d for d, e in manifest["files"].items() if not (vault / e.get("path", "")).is_file()]
    for d in stale:
        manifest["files"].pop(d, None)
    _save_manifest(manifest_path, manifest)
    text = render_media_index(manifest, now_ts, new, reused, missing, len(rows), compressed, skipped)
    changed = _write_if_changed(vault / MEDIA_INDEX_REL, text)
    return {
        "path": str(vault / MEDIA_INDEX_REL),
        "scanned": total,
        "new": new,
        "reused": reused,
        "missing": missing,
        "skipped": skipped,
        "bytes": bytes_new,
        "compressed": compressed,
        "saved": saved,
        "unique": len(manifest["files"]),
        "changed": changed,
    }


def render_media_index(
    manifest: dict,
    now_ts: int,
    new: int,
    reused: int,
    missing: int,
    scanned: int,
    compressed: int = 0,
    skipped: int = 0,
) -> str:
    stamp = datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M")
    created = manifest.get("created") or datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d")
    entries = sorted(manifest["files"].values(), key=lambda e: -int(e.get("ts", 0)))
    docs = [e for e in entries if e.get("kind") == "file"]
    audio = [e for e in entries if e.get("kind") == "voice"]
    images = [e for e in entries if e.get("kind") not in ("file", "voice")]
    total_size = sum(int(e.get("size", 0)) for e in entries)
    raw_total = sum(int(e.get("raw_size") or e.get("size", 0)) for e in entries)
    lines = [
        "---",
        "title: InfoHub 资源索引",
        "type: index",
        "owner: 付梓杨",
        f"created: {created}",
        f"updated: {stamp}",
        "tags: [院务, 索引]",
        "---",
        "",
        "# InfoHub 资源索引",
        "",
        f"> 由 InfoHub 自动生成，重跑覆盖，勿手改。归档目录：`{MEDIA_DIR_REL}/`（按消息月份分文件夹）。",
        f"> 本次扫描 {scanned} 条媒体消息：新增 {new} 个、按哈希复用 {reused} 个、源文件缺失 {missing} 条。"
        + (f" 另把 {compressed} 张历史原图压成预览版。" if compressed else "")
        + (f" 跳过 {skipped} 个超过体积上限的大文件。" if skipped else ""),
        f"> 累计 **{len(entries)}** 个文件 / **{_human_size(total_size)}**"
        f"（原图共 {_human_size(raw_total)}，压缩省下 {_human_size(max(0, raw_total - total_size))}；"
        f"文档 {len(docs)} · 图片/视频 {len(images)} · 语音 {len(audio)}）。",
        "> 图片统一按 **≤1600px / JPEG 质量 80** 归档；QQ 原图仍留在本机缓存，点开 InfoHub 缩略图可看原图。",
        "",
        "## 文档",
        "",
    ]
    if docs:
        lines += ["| 文件 | 大小 | 来源 | 发送人 | 时间 |", "|---|---|---|---|---|"]
        for item in docs:
            alias = item.get("name") or Path(item["path"]).name
            extra = f" ×{item['copies']}" if int(item.get("copies", 1)) > 1 else ""
            lines.append(
                f"| {_wikilink(item['path'], alias)}{extra} | {_human_size(int(item.get('size', 0)))} "
                f"| {_cell(item.get('conv', ''))} | {_cell(item.get('sender', '') or '—')} "
                f"| {_fmt(item.get('ts', 0))} |"
            )
    else:
        lines.append("> 暂无文档。")
    lines += ["", "## 图片", ""]
    if images:
        lines += ["| 文件 | 大小 | 来源 | 时间 |", "|---|---|---|---|"]
        for item in images:
            alias = item.get("name") or Path(item["path"]).name
            extra = f" ×{item['copies']}" if int(item.get("copies", 1)) > 1 else ""
            lines.append(
                f"| {_wikilink(item['path'], alias)}{extra} | {_human_size(int(item.get('size', 0)))} "
                f"| {_cell(item.get('conv', ''))} | {_fmt(item.get('ts', 0))} |"
            )
    else:
        lines.append("> 暂无图片。")
    lines += ["", "## 语音", ""]
    if audio:
        lines += ["| 文件 | 时长/内容 | 来源 | 时间 |", "|---|---|---|---|"]
        for item in audio:
            alias = item.get("name") or Path(item["path"]).name
            extra = f" ×{item['copies']}" if int(item.get("copies", 1)) > 1 else ""
            text = _excerpt(item.get("text") or "", 60) or "（未转写）"
            lines.append(
                f"| {_wikilink(item['path'], alias)}{extra} | {_cell(text)} "
                f"| {_cell(item.get('conv', ''))} | {_fmt(item.get('ts', 0))} |"
            )
    else:
        lines.append("> 暂无语音。")
    lines += [
        "",
        "## 说明",
        "",
        "- 同一文件被多次转发只存一份，表格里的 `×N` 是出现次数。",
        "- 微信侧媒体未落盘时不进索引（InfoHub 只归档能拿到本地路径的文件）。",
        "- 原消息摘要请在 InfoHub 里检索文件名或发送人。",
        "",
        "## 相关",
        "",
        "- [[学院事务/日程安排|日程安排]]",
        "- [[学院事务/班级管理/InfoHub-通知候选|InfoHub 通知候选]]",
        "- [[学院事务/index|学院事务（知识库分支）]]",
        "",
    ]
    return "\n".join(lines)


# ---------- 总入口 ----------


def export_all(
    cfg: Config,
    store: Store,
    parts=("agenda", "notices", "media"),
    progress=None,
    now_ts: int | None = None,
) -> dict:
    kb = cfg.kb
    vault = Path(kb.get("vault") or DEFAULT_VAULT)
    if not vault.is_dir():
        return {"error": f"知识库目录不存在：{vault}", "elapsed": 0.0}
    now_ts = int(now_ts or time.time())
    started = time.time()
    result: dict = {}
    if "agenda" in parts:
        result["agenda"] = export_agenda(
            store,
            vault,
            now_ts,
            days=int(kb.get("agenda_days", 30)),
            overdue_days=int(kb.get("agenda_overdue_days", 3)),
            excludes=kb.get("agenda_conv_exclude") or DEFAULT_AGENDA_EXCLUDE,
        )
    if "notices" in parts:
        result["notices"] = export_notices(
            store,
            vault,
            now_ts,
            days=int(kb.get("notice_days", 7)),
            limit=int(kb.get("notice_limit", 150)),
            keywords=kb.get("notice_conv_keywords") or DEFAULT_NOTICE_KEYWORDS,
            excludes=kb.get("notice_conv_exclude") or (),
        )
    if "media" in parts:
        result["media"] = export_media(
            store,
            vault,
            cfg.data_dir / "kb_manifest.json",
            now_ts,
            days=int(kb.get("media_days", 0)),
            progress=progress,
            preview_dir=cfg.data_dir / "media" / "preview",
            voices=store.voice_texts(),
            skip_bytes=int(float(kb.get("media_skip_mb", 0)) * 1024 * 1024),
        )
    result["elapsed"] = round(time.time() - started, 2)
    result["vault"] = str(vault)
    return result
