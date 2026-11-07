"""和鸣随包的 InfoHub 本机 MCP 服务（「采集桥」）：把归档能力以 MCP 暴露给本机客户端。

为什么要一个独立 HTTP 端点，而不是复用桌面端的 stdio 桥：
- stdio 桥的生命周期绑在拉起它的主进程上，只有和鸣桌面端能用；
- 浏览器版和鸣、以及第三方插件（d.96「信息采集中枢」）都需要一个稳定地址——
  插件的 `mcpServers` 只声明 http(s)，端点必须由和鸣自己随包提供。

本模块的两个硬约束：

1. **协议层只用标准库**。模块顶层只 import 标准库（json / sys / time / datetime /
   http.server / pathlib / urllib），store / config / sync / agenda 一律在函数内懒加载。
   这样「服务能起来、能握手、能列工具」和「采集依赖装没装好」解耦：缺 cryptography /
   zstandard 时工具报一句人话错误，而不是整个采集桥起不来。
2. **本机回环就是边界**（与 InfoHub 桌面端一致，不加 token）。所以：只监听 127.0.0.1
   （`run()` 也拒绝非回环地址）、Host 头白名单（127.0.0.1 / localhost / [::1]，防 DNS
   rebinding）、CORS 预检放行（浏览器版需要）、请求体 ≤256KB、`allow_reuse_address=False`
   （Windows 上端口被占就如实失败，不静默抢端口）。写操作（`infohub_sync` /
   `infohub_agenda_rebuild`）仍由和鸣按工具名判风险、走人工确认；本服务不做二次确认，
   也绝不静默重扫。

协议：MCP Streamable HTTP 的**最小可用子集**（不引入任何依赖）：

    POST /mcp  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
    → 200 {"jsonrpc":"2.0","id":1,"result":{...}}
    GET  /health → 200 {"name":"infohub-mcp","version":"0.1.0"}

支持 initialize / notifications/initialized / ping / tools/list / tools/call；通知（无 id）
回 202 空体；响应一律 application/json，客户端不必开 SSE。异常一律收口成中文错误内容，
traceback 只进 stderr，绝不给模型看栈。

归档口径：配置用 `load_config(create=False)`（读操作不该顺手写 config.json）；归档目录由
`INFOHUB_HOME` 决定（与 stdio 桥一致）；只读工具用 `Store(..., readonly=True)`（`mode=ro`、
不建表不写库），写工具才用可写 `Store(...)`。
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SERVER_NAME = "infohub-mcp"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2025-06-18"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8776

#: 单次请求体上限：工具参数都很小，超了直接拒绝，避免被当成上传通道。
MAX_BODY_BYTES = 256 * 1024
#: 检索 / 读会话 / 列会话的单次上限（防止一次把整库塞进模型上下文）。
MAX_SEARCH_LIMIT = 50
MAX_MESSAGES_LIMIT = 100
MAX_CONVERSATIONS_LIMIT = 200
#: 日程窗口上限：往前看逾期 365 天、往后看 60 天已经够用；重扫窗口再宽松一些。
MAX_AGENDA_DAYS = 60
MAX_AGENDA_OVERDUE = 365
MAX_REBUILD_DAYS = 90
ALLOWED_SOURCES = ("qq", "wechat")
EXCERPT_CHARS = 120

#: 顺序是契约的一部分（和鸣插件技能按顺序介绍工具，测试也会钉住），别随手重排。
TOOLS: list[dict[str, Any]] = [
    {
        "name": "infohub_status",
        "description": (
            "查看本机 InfoHub 采集状态：归档里的会话数 / 消息数、各来源最近一次采集时间与结果。"
            "只读；在回答「最近采过吗 / 有多少消息」之前先调用它。"
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "infohub_sync",
        "description": (
            "增量采集本机 QQ / 微信消息并写入 InfoHub 归档。**写操作**：会读取本机聊天数据库，"
            "调用前应由用户确认来源与范围。可选 sources=[\"qq\"]/[\"wechat\"]，"
            "缺省使用 InfoHub 配置里已启用的来源。不重扫日程、不导出知识库、不推送；"
            "新采集的消息要补日程，请另行调用 infohub_agenda_rebuild（同样是写操作）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sources": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(ALLOWED_SOURCES)},
                    "description": "要采集的来源；缺省用配置里已启用的来源",
                },
                "full": {
                    "type": "boolean",
                    "description": "全量重读（忽略增量游标），默认 false",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "infohub_archive_search",
        "description": (
            "在本机 QQ / 微信归档里全文检索消息，返回命中的会话名、时间、发信人与片段。只读；"
            "引用时请注明「来自本机归档」。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索词（至少 1 个字）"},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SEARCH_LIMIT,
                    "description": f"最多返回几条（1–{MAX_SEARCH_LIMIT}，默认 20）",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "infohub_archive_read",
        "description": (
            "按会话 id 读取本机归档里的最近消息（只读）。会话 id 可从检索结果或会话列表拿到；"
            "返回顺序为时间正序。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "conversationId": {"type": "integer", "minimum": 1, "description": "归档里的会话 id"},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_MESSAGES_LIMIT,
                    "description": f"最多返回多少条（1–{MAX_MESSAGES_LIMIT}，默认 30）",
                },
            },
            "required": ["conversationId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "infohub_archive_agenda",
        "description": (
            "查看从本机消息里识别出的日程（逾期 / 今天 / 本周）。只读；适合回答「最近有什么要办的」。"
            "刚采集完还没有日程时，需要先调用 infohub_agenda_rebuild 补扫。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_AGENDA_DAYS,
                    "description": f"往后看多少天（1–{MAX_AGENDA_DAYS}，默认 14）",
                },
                "overdue": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_AGENDA_OVERDUE,
                    "description": f"往前看多少天的逾期（1–{MAX_AGENDA_OVERDUE}，默认 30）",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "infohub_conversations",
        "description": (
            "列出本机归档里的会话（id / 名称 / 来源 / 最近消息时间 / 消息数），按最近消息时间倒序。"
            "只读；回答「最近有哪些群 / 会话」或拿会话 id 去 infohub_archive_read 之前调用它。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "enum": list(ALLOWED_SOURCES),
                    "description": "只看某个来源（qq / wechat）；缺省都看",
                },
                "keyword": {
                    "type": "string",
                    "description": "按会话名做子串过滤（可空）",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_CONVERSATIONS_LIMIT,
                    "description": f"最多返回几个会话（1–{MAX_CONVERSATIONS_LIMIT}，默认 30）",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "infohub_agenda_rebuild",
        "description": (
            "重扫最近 N 天的本机消息并重建日程。**写操作**：会改写归档里的 events 表，"
            "调用前应由用户确认窗口天数。`infohub_sync` 刻意不重扫日程，所以采集完需要补日程时用它；"
            "与内置模块的 infohub_agenda_rebuild 同名同语义。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_REBUILD_DAYS,
                    "description": f"重扫最近多少天的消息（1–{MAX_REBUILD_DAYS}，默认 14）",
                },
            },
            "additionalProperties": False,
        },
    },
]

TOOL_NAMES = {tool["name"] for tool in TOOLS}


class McpError(Exception):
    """可回给客户端的错误（参数错、工具失败等），不外泄 traceback。"""


# ---------------------------------------------------------------- 工具实现


def _config() -> Any:
    """读配置：`create=False`，只读工具不该顺手在用户目录写 config.json。"""
    from .config import load_config

    return load_config(create=False)


def _open_store(readonly: bool = True) -> Any:
    """打开归档库。

    - 只读工具（status / search / read / agenda / conversations）走 `readonly=True`：URI
      `mode=ro`，不建表、不建 FTS、不写库——浏览与检索绝不动用户的归档；
    - 写工具（sync / agenda_rebuild）才走可写 Store。
    """
    from .store import Store

    cfg = _config()
    db = Path(cfg.archive_db)
    if readonly and not db.is_file():
        # mode=ro 打不开不存在的库（SQLite 会报 "unable to open database file"），
        # 这里提前给一句能照着做的话，而不是把英文异常丢给模型。
        raise McpError(
            f"本机归档还不存在：{db}；请先在和鸣信息中枢页完成一次采集（infohub_sync）。"
        )
    return Store(db, readonly=readonly)


def _fmt_ts(ts: Any) -> str:
    try:
        value = int(ts or 0)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    return datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M")


def _row_to_dict(row: Any) -> dict[str, Any]:
    try:
        return {key: row[key] for key in row.keys()}
    except AttributeError:
        return dict(row)


def _int_arg(args: dict[str, Any], name: str, default: int, low: int, high: int) -> int:
    raw = args.get(name, default)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, (int, str)):
        raise McpError(f"{name} 必须是整数")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise McpError(f"{name} 必须是整数") from None
    if value < low or value > high:
        raise McpError(f"{name} 必须在 {low}–{high} 之间")
    return value


def _bool_arg(args: dict[str, Any], name: str, default: bool = False) -> bool:
    raw = args.get(name, default)
    if raw is None:
        return default
    if not isinstance(raw, bool):
        raise McpError(f"{name} 必须是布尔值（true / false）")
    return raw


def _enabled_sources(cfg: Any) -> list[str]:
    return [
        name
        for name in ALLOWED_SOURCES
        if (getattr(cfg, name, None) or {}).get("enabled", True)
    ]


def tool_status(args: dict[str, Any]) -> str:
    cfg = _config()
    store = _open_store(readonly=True)
    try:
        stats = store.stats()
        states = store.source_states()
    finally:
        store.close()
    enabled = _enabled_sources(cfg)
    sources = []
    for name in ALLOWED_SOURCES:
        row = states.get(name)
        data = _row_to_dict(row) if row is not None else {}
        sources.append(
            {
                "source": name,
                "enabled": name in enabled,
                "lastRunAt": _fmt_ts(data.get("last_run_ts")),
                "status": data.get("status", "idle"),
                "detail": (data.get("detail") or "")[:200],
            }
        )
    return json.dumps(
        {
            "conversations": stats.get("conversations", 0),
            "messages": stats.get("messages", 0),
            "perSource": stats.get("per_source", {}),
            "sources": sources,
            "note": "只读统计；采集请调用 infohub_sync（写操作）。",
        },
        ensure_ascii=False,
    )


def tool_sync(args: dict[str, Any]) -> str:
    raw_sources = args.get("sources")
    if raw_sources is None:
        sources = list(ALLOWED_SOURCES)
    elif isinstance(raw_sources, list) and all(isinstance(item, str) for item in raw_sources):
        unknown = [item for item in raw_sources if item not in ALLOWED_SOURCES]
        if unknown:
            raise McpError(f"未知来源：{'、'.join(unknown)}（只支持 qq / wechat）")
        sources = [item for item in ALLOWED_SOURCES if item in raw_sources]
        if not sources:
            raise McpError("sources 不能为空")
    else:
        raise McpError("sources 必须是数组，例如 [\"qq\"]")

    full = _bool_arg(args, "full", False)
    # 懒加载：采集链路依赖 cryptography / zstandard 等可选依赖，协议层不该被它们拖住。
    from .sync import open_store as open_sync_store
    from .sync import sync_all

    cfg = _config()
    store = open_sync_store(cfg)
    started = time.time()
    try:
        reports = sync_all(cfg, store=store, sources=tuple(sources), full=full)
    finally:
        store.close()
    payload = {
        "requestedSources": sources,
        "full": full,
        "elapsedSeconds": round(time.time() - started, 2),
        "reports": [
            {
                "source": report.source,
                "conversations": report.conversations,
                "added": report.added,
                "updated": report.updated,
                "scannedFiles": report.scanned_files,
                "skipped": report.skipped,
                "errors": report.errors,
                "elapsedSeconds": round(report.elapsed, 2),
            }
            for report in reports
        ],
        "note": (
            "采集完成；未重扫日程、未导出知识库、未推送。"
            "需要补日程请另行调用 infohub_agenda_rebuild（写操作）。"
        ),
    }
    return json.dumps(payload, ensure_ascii=False)


def tool_search(args: dict[str, Any]) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise McpError("query 不能为空")
    limit = _int_arg(args, "limit", 20, 1, MAX_SEARCH_LIMIT)
    store = _open_store(readonly=True)
    try:
        rows = store.search(query, limit=limit)
    finally:
        store.close()
    hits = []
    for row in rows:
        data = _row_to_dict(row)
        hits.append(
            {
                "conversationId": data.get("conversation_id"),
                "conversation": data.get("conv_name", ""),
                "source": data.get("source", ""),
                "at": _fmt_ts(data.get("ts")),
                "from": data.get("sender_name", ""),
                "excerpt": (data.get("snippet") or data.get("content") or "")[:EXCERPT_CHARS],
            }
        )
    return json.dumps(
        {"query": query, "count": len(hits), "hits": hits, "note": "来自本机归档，引用时请注明。"},
        ensure_ascii=False,
    )


def tool_read(args: dict[str, Any]) -> str:
    if "conversationId" not in args:
        raise McpError("缺少 conversationId")
    raw = args["conversationId"]
    if isinstance(raw, bool) or not isinstance(raw, (int, str)):
        raise McpError("conversationId 必须是整数")
    try:
        conv_id = int(raw)
    except (TypeError, ValueError):
        raise McpError("conversationId 必须是整数") from None
    if conv_id < 1:
        raise McpError("conversationId 必须是正整数")
    limit = _int_arg(args, "limit", 30, 1, MAX_MESSAGES_LIMIT)
    store = _open_store(readonly=True)
    try:
        conv = store.get_conversation(conv_id)
        if conv is None:
            raise McpError(f"归档里没有 id={conv_id} 的会话")
        rows = store.get_messages(conv_id, limit=limit)
    finally:
        store.close()
    messages = []
    for row in rows:
        data = _row_to_dict(row)
        messages.append(
            {
                "at": _fmt_ts(data.get("ts")),
                "from": data.get("sender_name", ""),
                "text": (data.get("content") or "")[:1000],
            }
        )
    conv_data = _row_to_dict(conv)
    return json.dumps(
        {
            "conversationId": conv_id,
            "conversation": conv_data.get("name", ""),
            "source": conv_data.get("source", ""),
            "messages": messages,
            "note": "来自本机归档的只读副本。",
        },
        ensure_ascii=False,
    )


def tool_agenda(args: dict[str, Any]) -> str:
    days = _int_arg(args, "days", 14, 1, MAX_AGENDA_DAYS)
    overdue = _int_arg(args, "overdue", 30, 1, MAX_AGENDA_OVERDUE)
    # 日程汇总只用到纯规则，但仍在函数内导入，保持「协议层不依赖业务模块」的口径。
    from . import agenda as agenda_mod

    store = _open_store(readonly=True)
    try:
        now_ts = int(time.time())
        rows = store.agenda(now_ts - overdue * 86400, now_ts + days * 86400)
        overdue_n, today_n, week_n = agenda_mod.summary(rows, now_ts)
        events = []
        for row in rows:
            data = _row_to_dict(row)
            events.append(
                {
                    "title": data.get("title", ""),
                    "dueAt": _fmt_ts(data.get("due_ts")),
                    "kind": data.get("kind", ""),
                    "conversation": data.get("conv_name", ""),
                    "source": data.get("source", ""),
                    "from": data.get("sender_name", ""),
                }
            )
    finally:
        store.close()
    return json.dumps(
        {
            "window": {"days": days, "overdueDays": overdue},
            "counts": {"overdue": overdue_n, "today": today_n, "thisWeek": week_n},
            "events": events,
            "note": "日程由本机消息识别；只读。刚采集完还没有日程时，请先调用 infohub_agenda_rebuild。",
        },
        ensure_ascii=False,
    )


def tool_conversations(args: dict[str, Any]) -> str:
    source = args.get("source")
    if source in (None, ""):
        source = None
    elif not isinstance(source, str) or source not in ALLOWED_SOURCES:
        raise McpError(f"未知来源：{source}（只支持 qq / wechat）")
    keyword = args.get("keyword")
    if keyword is None:
        keyword = ""
    if not isinstance(keyword, str):
        raise McpError("keyword 必须是字符串")
    keyword = keyword.strip()[:100]
    limit = _int_arg(args, "limit", 30, 1, MAX_CONVERSATIONS_LIMIT)
    store = _open_store(readonly=True)
    try:
        rows = store.list_conversations(source=source, keyword=keyword)
    finally:
        store.close()
    items = []
    for row in rows[:limit]:
        data = _row_to_dict(row)
        items.append(
            {
                "conversationId": data.get("id"),
                "name": data.get("name", ""),
                "source": data.get("source", ""),
                "lastAt": _fmt_ts(data.get("last_ts")),
                "messages": int(data.get("message_count") or 0),
            }
        )
    payload: dict[str, Any] = {
        "count": len(items),
        "conversations": items,
        "note": "来自本机归档的只读列表；用 conversationId 调 infohub_archive_read 读消息。",
    }
    if len(rows) > len(items):
        payload["truncated"] = len(rows) - len(items)
    return json.dumps(payload, ensure_ascii=False)


def tool_agenda_rebuild(args: dict[str, Any]) -> str:
    days = _int_arg(args, "days", 14, 1, MAX_REBUILD_DAYS)
    from . import agenda as agenda_mod

    now_ts = int(time.time())
    started = time.time()
    # 写工具：这里必须是可写 Store，rebuild 会 replace_events。
    store = _open_store(readonly=False)
    try:
        stats = agenda_mod.rebuild(store, days=days, now_ts=now_ts)
    finally:
        store.close()
    return json.dumps(
        {
            "window": {
                "days": days,
                "since": _fmt_ts(now_ts - days * 86400),
                "until": "now",
            },
            "scanned": stats.get("scanned", 0),
            "matched": stats.get("matched", 0),
            "inserted": stats.get("inserted", 0),
            "total": stats.get("total", 0),
            "elapsedSeconds": round(time.time() - started, 2),
            "note": f"写操作：已重扫最近 {days} 天的消息并重建日程表（窗口外未来日程保持不变）。",
        },
        ensure_ascii=False,
    )


HANDLERS = {
    "infohub_status": tool_status,
    "infohub_sync": tool_sync,
    "infohub_archive_search": tool_search,
    "infohub_archive_read": tool_read,
    "infohub_archive_agenda": tool_agenda,
    "infohub_conversations": tool_conversations,
    "infohub_agenda_rebuild": tool_agenda_rebuild,
}


def call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """执行一个工具；失败转成 isError 内容（不把 traceback 交给模型）。"""
    handler = HANDLERS.get(name)
    if handler is None:
        raise McpError(f"未知工具：{name}")
    try:
        text = handler(args)
    except McpError:
        raise
    except Exception as exc:  # noqa: BLE001 - 本机服务：任何异常都收口成人话
        print(f"[infohub-mcp] 工具 {name} 失败：{exc!r}", file=sys.stderr)
        raise McpError(f"{name} 执行失败：{exc}") from exc
    return {"content": [{"type": "text", "text": text}], "isError": False}


# ---------------------------------------------------------------- JSON-RPC


def _ok(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_rpc(message: Any) -> dict[str, Any] | None:
    """处理单条 JSON-RPC；通知返回 None（HTTP 层回 202）。"""
    if not isinstance(message, dict):
        return _error(None, -32600, "请求必须是 JSON 对象")
    request_id = message.get("id")
    method = message.get("method")
    if not isinstance(method, str) or not method:
        return _error(request_id, -32600, "缺少 method")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    try:
        if method == "initialize":
            return _ok(
                request_id,
                {
                    "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            )
        if method in ("notifications/initialized", "initialized"):
            return None
        if method == "ping":
            return _ok(request_id, {})
        if method == "tools/list":
            return _ok(request_id, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if not isinstance(name, str) or not name:
                return _error(request_id, -32602, "tools/call 缺少工具名")
            if not isinstance(arguments, dict):
                return _error(request_id, -32602, "arguments 必须是对象")
            if name not in TOOL_NAMES:
                return _error(request_id, -32602, f"未知工具：{name}")
            try:
                result = call_tool(name, arguments)
            except McpError as exc:
                # 参数错 / 工具失败属于「调用失败」而非「协议错误」：回 isError 内容，
                # 让模型能读到原因并自我修正，而不是把整次 tools/call 判成协议异常。
                result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
            return _ok(request_id, result)
        return _error(request_id, -32601, f"不支持的方法：{method}")
    except Exception as exc:  # noqa: BLE001
        print(f"[infohub-mcp] 处理 {method} 失败：{exc!r}", file=sys.stderr)
        return _error(request_id, -32603, "服务内部错误")


# ---------------------------------------------------------------- HTTP 层


def _is_loopback_host(value: str) -> bool:
    """Host 头只接受本机名字（含端口）；防 DNS rebinding。"""
    host = (value or "").strip()
    if not host:
        return False
    if host.startswith("["):
        return host.startswith("[::1]")
    name = host.split(":", 1)[0]
    return name in ("127.0.0.1", "localhost")


class McpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "infohub-mcp/0.1.0"

    # 静默默认访问日志（只留错误），别把每条请求刷到终端上
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    def _cors_headers(self) -> None:
        # 浏览器版和鸣要从 pages 源跨源访问本机服务，必须放行预检。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "content-type, mcp-protocol-version, mcp-session-id",
        )
        self.send_header("Access-Control-Expose-Headers", "mcp-session-id")

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self._cors_headers()
        self.end_headers()

    def _path(self) -> str:
        return urlsplit(self.path).path.rstrip("/") or "/"

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server 约定
        self._empty(204)

    def do_GET(self) -> None:  # noqa: N802
        if self._path() == "/health":
            self._json(200, {"name": SERVER_NAME, "version": SERVER_VERSION})
            return
        self._json(405, {"error": "MCP 只接受 POST /mcp"})

    def _reject(self, status: int, payload: Any) -> None:
        """拒绝请求后关连接：没读掉的请求体不能再被当成下一条请求解析。"""
        self.close_connection = True
        self._json(status, payload)

    def do_POST(self) -> None:  # noqa: N802
        if not _is_loopback_host(self.headers.get("Host", "")):
            self._reject(403, {"error": "只接受本机回环地址访问"})
            return
        if self._path() != "/mcp":
            self._reject(404, {"error": "没有这个地址；MCP 端点是 POST /mcp"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._reject(400, {"error": "Content-Length 不合法"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._reject(413 if length > MAX_BODY_BYTES else 400, {"error": "请求体为空或过大"})
            return
        raw = self.rfile.read(length)
        try:
            message = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, _error(None, -32700, "不是合法 JSON"))
            return
        if isinstance(message, list):
            # JSON-RPC 批量：逐条处理，通知不回；全是通知时回 202。
            replies = []
            for item in message:
                reply = handle_rpc(item)
                if reply is not None:
                    replies.append(reply)
            if not replies:
                self._empty(202)
                return
            self._json(200, replies)
            return
        reply = handle_rpc(message)
        if reply is None:
            self._empty(202)
            return
        self._json(200, reply)


def run(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:  # pragma: no cover - 进程入口
    """启动采集桥；只允许回环地址（和鸣桌面端按需拉起，退出时整树回收）。"""
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(
            "采集桥只允许监听本机回环地址（127.0.0.1 / localhost / ::1），拒绝 " + str(host)
        )

    class _Server(ThreadingHTTPServer):
        # Windows 上 SO_REUSEADDR 会让第二个进程也「绑定成功」，请求被谁接走不确定；
        # 这里关掉复用，端口被占（比如用户自己已经在跑 `infohub mcp`）就启动失败、直说。
        allow_reuse_address = False

    server = _Server((host, port), McpHandler)
    server.daemon_threads = True
    print(f"MCP 服务已启动：http://{host}:{port}/mcp", file=sys.stderr)
    print("按 Ctrl+C 停止。", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - 进程入口
    """`python -m infohub.mcp_server [--host 127.0.0.1] [--port 8776]`。

    桌面端 infohub-mcp-host.js 就是用这个入口拉进程的，参数必须能解析。
    """
    import argparse

    parser = argparse.ArgumentParser(prog="infohub.mcp_server", description="InfoHub 本机 MCP 采集桥")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（只允许回环）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 8776）")
    args = parser.parse_args(argv)
    run(host=args.host, port=args.port)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
