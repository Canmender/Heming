"""和鸣「聊天记录」插件自带引擎（第一方 bundle，随插件分发）。

与独立 InfoHub 桥的区别：这个进程**由插件清单声明、由宿主用内置 Python 拉起**，
不开端口、不收外部连接，只经 stdin/stdout 与宿主通信（协议与 infohub.bridge 一致）：

    请求  {"id": 1, "method": "conversations", "params": {...}}
    成功  {"id": 1, "ok": true, "result": ...}
    失败  {"id": 1, "ok": false, "error": {"type": "...", "message": "..."}}
    事件  {"event": "progress", "phase": "sync", "stage": "...", ...}

宿主下发的环境（见 packages/desktop/plugin-engine.js）：
    HEMING_PLUGIN_DATA_DIR  插件自己的数据目录（归档游标放这里，不动共享库的游标）
    HEMING_PLUGIN_SETTINGS  插件设置 JSON（可含 home / autoArchive）
    HEMING_CHAT             {baseUrl,key,model} —— 和鸣「后台任务模型」；只在本进程内存里
                            启用 LLM，绝不写回共享 config.json
    HEMING_KB_ROOTS         [{id,name,root,writeDirs}] —— 和鸣内置知识库；写入只落在
                            root/<writeDir>/InfoHub 下，尊重 writeDirs 边界

读类方法（会话/消息/检索/日程）直接复用随包发行的 infohub 核心；采集与入库由本文件
编排，模型走和鸣网关，落点走和鸣知识库。不引入智能体编排、不做企业微信推送。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# ── 协议输出：先抓住真正的 stdout，再把其余 print 全部改道 stderr ──────────────
_OUT = sys.stdout
try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    _OUT.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
sys.stdout = sys.stderr

HERE = Path(__file__).resolve().parent
# 宿主会把入口目录与 lib 加进 PYTHONPATH；这里再兜底一次，独立调试也能跑。
for _p in (HERE, HERE / "lib"):
    if _p.is_dir() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

PROTOCOL_VERSION = 1
PLUGIN_VERSION = "0.2.0"
MAX_LINE_BYTES = 4 * 1024 * 1024
#: 单次入库最多回看这么久；积压时多次调用逐步补齐，避免一次生成跨多日的巨型文件。
ARCHIVE_WINDOW = 24 * 3600

_ALLOWED_METHODS = {
    "ping",
    "status",
    "conversations",
    "messages",
    "search",
    "agenda",
    "sync",
    "config.summary",
    "config.detect",
    "kb.roots",
    "kb.archive",
    "shutdown",
}
_LONG_METHODS = {"sync", "kb.archive"}


def _emit(payload: dict) -> None:
    _OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    _OUT.flush()


def _error(request_id: Any, exc: BaseException) -> dict:
    message = str(exc) or exc.__class__.__name__
    if len(message) > 800:
        message = message[:800] + "…"
    return {"id": request_id, "ok": False, "error": {"type": exc.__class__.__name__, "message": message}}


def _json_env(name: str, default: Any) -> Any:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = json.loads(raw)
    except ValueError:
        return default
    return value if value is not None else default


def _bool_param(params: dict, name: str, default: bool = False) -> bool:
    value = params.get(name, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


# ── 运行目录：优先复用和鸣默认归档（~/Heming/infohub），让老用户装完即见已有聊天 ──
# 必须在 import infohub 之前定下来：infohub.config 在导入时就按 INFOHUB_HOME 算 HOME。
def _resolve_home() -> Path:
    env = os.environ.get("INFOHUB_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    settings = _json_env("HEMING_PLUGIN_SETTINGS", {})
    custom = str((settings or {}).get("home") or "").strip()
    if custom and Path(custom).is_absolute():
        return Path(custom).resolve()
    shared = Path.home() / "Heming" / "infohub"
    if (shared / "config.json").is_file() or (shared / "data" / "archive.db").is_file():
        return shared
    data_dir = os.environ.get("HEMING_PLUGIN_DATA_DIR", "").strip()
    base = Path(data_dir) if data_dir else HERE / ".data"
    return (base / "infohub").resolve()


HOME = _resolve_home()
os.environ["INFOHUB_HOME"] = str(HOME)

# ── 和鸣后台任务模型：只设进程环境 + 内存配置，不落盘 ──────────────────────────
_CHAT = _json_env("HEMING_CHAT", {})
CHAT_BASE_URL = str((_CHAT or {}).get("baseUrl") or "").strip()
CHAT_KEY = str((_CHAT or {}).get("key") or "")
CHAT_MODEL = str((_CHAT or {}).get("model") or "").strip()
if CHAT_BASE_URL:
    os.environ["INFOHUB_LLM_BASE_URL"] = CHAT_BASE_URL
if CHAT_KEY:
    os.environ["INFOHUB_LLM_API_KEY"] = CHAT_KEY
if CHAT_MODEL:
    os.environ["INFOHUB_LLM_MODEL"] = CHAT_MODEL

_KB_ROOTS = _json_env("HEMING_KB_ROOTS", [])
_SETTINGS = _json_env("HEMING_PLUGIN_SETTINGS", {})
_DATA_DIR = Path(os.environ.get("HEMING_PLUGIN_DATA_DIR", "").strip() or str(HERE / ".data"))
_STATE_FILE = _DATA_DIR / "state.json"

# 环境就绪后再导入核心（HOME 此时才正确）。读类依赖都很轻；采集/入库的重依赖延迟导入。
from infohub import __version__ as INFOHUB_VERSION  # noqa: E402
from infohub import agenda as agenda_mod  # noqa: E402
from infohub import llm as llm_mod  # noqa: E402
from infohub.bridge import Bridge as CoreBridge  # noqa: E402
from infohub.config import load_config  # noqa: E402
from infohub.store import Store  # noqa: E402


def _load_state() -> dict:
    try:
        data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STATE_FILE.with_name(f"{_STATE_FILE.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _STATE_FILE)


class _Progress:
    """把采集/入库进度节流成事件，避免密集回调塞满管道。"""

    def __init__(self, phase: str, min_interval: float = 0.1) -> None:
        self.phase = phase
        self.min_interval = min_interval
        self.last = 0.0

    def __call__(self, stage: str, current: int, total: int) -> None:
        now = time.monotonic()
        finished = total > 0 and current >= total
        if not finished and now - self.last < self.min_interval:
            return
        self.last = now
        _emit(
            {
                "event": "progress",
                "phase": self.phase,
                "stage": str(stage)[:200],
                "current": int(current),
                "total": int(total),
            }
        )


class PluginEngine:
    def __init__(self) -> None:
        self._core = CoreBridge()
        self._stop = False

    # ---------- 配置 / 知识库 ----------

    def _cfg(self, create: bool = False) -> Any:
        cfg = load_config(create=create)
        llm = cfg.raw.setdefault("llm", {})
        # 和鸣给了后台模型才启用；只改这份内存配置，共享 config.json 一字不动。
        llm["enabled"] = bool(CHAT_MODEL)
        if CHAT_MODEL:
            llm["allow_remote"] = True
        return cfg

    def _vaults(self) -> list[dict]:
        out = []
        for item in _KB_ROOTS if isinstance(_KB_ROOTS, list) else []:
            if not isinstance(item, dict):
                continue
            root = str(item.get("root") or "").strip()
            write_dirs = [str(d).strip() for d in (item.get("writeDirs") or []) if str(d).strip()]
            writable = bool(root and Path(root).is_absolute() and write_dirs)
            target = str(Path(root) / write_dirs[0] / "InfoHub") if writable else ""
            out.append(
                {
                    "id": str(item.get("id") or ""),
                    "name": str(item.get("name") or ""),
                    "root": root,
                    "writeDirs": write_dirs,
                    "writable": writable,
                    "target": target,
                }
            )
        return out

    def _pick_vault(self, vault_id: Any) -> dict:
        writable = [v for v in self._vaults() if v["writable"]]
        if not writable:
            raise ValueError("没有可写的知识库：请先在和鸣「知识库」里添加一个库（默认允许写入 inbox）")
        wanted = str(vault_id or "").strip()
        if wanted:
            for vault in writable:
                if vault["id"] == wanted:
                    return vault
            raise ValueError(f"知识库不存在或不可写：{wanted}")
        return writable[0]

    # ---------- 方法 ----------

    def ping(self, params: dict) -> dict:
        result = self._core.ping(params)
        result["app"] = "infohub-page"
        result["pluginVersion"] = PLUGIN_VERSION
        result["chat"] = {"model": CHAT_MODEL, "configured": bool(CHAT_MODEL and CHAT_BASE_URL)}
        result["kb"] = {"vaults": self._vaults()}
        return result

    def status(self, params: dict) -> dict:
        result = self._core.status(params)
        result["chat"] = {"model": CHAT_MODEL, "available": llm_mod.available(self._cfg())}
        state = _load_state()
        result["kb"] = {
            "vaults": self._vaults(),
            "archiveCursor": int(state.get("archiveCursor") or 0),
            "lastArchive": state.get("lastArchive"),
        }
        return result

    def conversations(self, params: dict) -> dict:
        return self._core.conversations(params)

    def messages(self, params: dict) -> dict:
        return self._core.messages(params)

    def search(self, params: dict) -> dict:
        return self._core.search(params)

    def agenda(self, params: dict) -> dict:
        return self._core.agenda(params)

    def config_summary(self, params: dict) -> dict:
        return self._core.config_summary(params)

    def config_detect(self, params: dict) -> dict:
        return self._core.config_detect(params)

    def kb_roots(self, params: dict) -> dict:
        return {"vaults": self._vaults()}

    def sync(self, params: dict) -> dict:
        raw_sources = params.get("sources")
        if raw_sources in (None, ""):
            sources = ["qq", "wechat"]
        elif isinstance(raw_sources, list) and all(s in ("qq", "wechat") for s in raw_sources):
            sources = list(dict.fromkeys(raw_sources))
        else:
            raise ValueError("sources 只能是 qq / wechat 的数组")
        full = _bool_param(params, "full")
        cfg = self._cfg(create=True)
        self._core.close()
        store = Store(cfg.archive_db)
        try:
            from infohub import sync as sync_mod  # 采集依赖延迟到真正采集时再导入

            reports = sync_mod.sync_all(cfg, store=store, sources=sources, full=full, progress=_Progress("sync"))
            agenda_changed = agenda_mod.update_agenda(store, cfg)
            auto_archive = bool((_SETTINGS or {}).get("autoArchive", True))
            kb_stats = None
            if _bool_param(params, "archive", auto_archive) and any(v["writable"] for v in self._vaults()):
                kb_stats = self._do_archive(cfg, store, params.get("vaultId"), None)
            return {
                "reports": [
                    {
                        "source": report.source,
                        "conversations": report.conversations,
                        "added": report.added,
                        "updated": report.updated,
                        "scannedFiles": report.scanned_files,
                        "skipped": report.skipped,
                        "errors": report.errors,
                        "elapsed": round(report.elapsed, 2),
                    }
                    for report in reports
                ],
                "agenda": agenda_changed,
                "kb": kb_stats,
            }
        except ImportError as exc:
            raise RuntimeError(f"缺少 InfoHub 采集依赖（wechatauto / zstandard / cryptography 等）：{exc}") from exc
        finally:
            store.close()
            self._core.close()

    def kb_archive(self, params: dict) -> dict:
        cfg = self._cfg(create=True)
        if not cfg.archive_db.is_file():
            raise ValueError("还没有归档库：请先点「采集」同步 QQ / 微信消息")
        self._core.close()
        store = Store(cfg.archive_db, readonly=True)
        try:
            return self._do_archive(cfg, store, params.get("vaultId"), params.get("hours"))
        finally:
            store.close()
            self._core.close()

    def _do_archive(self, cfg: Any, store: Store, vault_id: Any, hours: Any) -> dict:
        from infohub import agent as agent_mod  # 含采集依赖，延迟导入
        from infohub import digest as digest_mod
        from infohub import kb as kb_mod

        vault = self._pick_vault(vault_id)
        target = Path(vault["target"])
        target.mkdir(parents=True, exist_ok=True)
        # 核心按 cfg.kb.vault 写相对路径；把库根指到 root/<writeDir>/InfoHub，
        # 所有落点就都收在 writeDirs 边界内（不污染库根，也不越界）。
        cfg.raw.setdefault("kb", {})["vault"] = str(target)

        now_ts = int(time.time())
        state = _load_state()
        cursor = int(state.get("archiveCursor") or 0)
        try:
            window = int(float(hours) * 3600) if hours not in (None, "") else ARCHIVE_WINDOW
        except (TypeError, ValueError):
            window = ARCHIVE_WINDOW
        window = max(300, min(window, ARCHIVE_WINDOW))
        since = cursor if cursor > 0 else now_ts - window
        if now_ts - since > window:
            since = now_ts - window
        if since >= now_ts:
            since = now_ts - 60

        digest = digest_mod.build(store, cfg, since, now_ts)
        ai_ok = False
        ai_error = ""
        if not digest.empty and llm_mod.available(cfg):
            ok, result = llm_mod.report(cfg, digest.ai_input or digest_mod.to_text(digest))
            if ok:
                digest.ai_sections = result
                digest.ai = "\n".join(f"【{s['title']}】{' '.join(s['items'])}" for s in result if s["items"])
                ai_ok = True
            else:
                digest.ai_error = str(result)
                ai_error = str(result)

        stats = agent_mod.archive_messages(cfg, store, digest)
        brief = digest_mod.export_obsidian(cfg, digest)
        exported = kb_mod.export_all(
            cfg, store, parts=("agenda", "notices"), now_ts=now_ts, progress=_Progress("kb")
        )
        state["archiveCursor"] = now_ts
        state["lastArchive"] = {
            "ts": now_ts,
            "vault": vault["id"],
            "headline": digest_mod.headline(digest),
            "work": stats["work"],
            "life": stats["life"],
        }
        _save_state(state)
        return {
            "window": {"since": since, "until": now_ts},
            "vault": {"id": vault["id"], "name": vault["name"], "target": str(target)},
            "headline": digest_mod.headline(digest),
            "empty": digest.empty,
            "work": stats["work"],
            "life": stats["life"],
            "files": stats["files"],
            "brief": brief,
            "agenda": exported.get("agenda"),
            "notices": exported.get("notices"),
            "ai": {"enabled": bool(CHAT_MODEL), "ok": ai_ok, "error": ai_error},
        }

    def shutdown(self, params: dict) -> dict:
        self._stop = True
        return {"stopped": True}

    def close(self) -> None:
        self._core.close()


_DISPATCH = {
    "ping": "ping",
    "status": "status",
    "conversations": "conversations",
    "messages": "messages",
    "search": "search",
    "agenda": "agenda",
    "sync": "sync",
    "config.summary": "config_summary",
    "config.detect": "config_detect",
    "kb.roots": "kb_roots",
    "kb.archive": "kb_archive",
    "shutdown": "shutdown",
}


def main() -> int:
    engine = PluginEngine()
    _emit(
        {
            "event": "hello",
            "app": "infohub-page",
            "version": PLUGIN_VERSION,
            "infohub": INFOHUB_VERSION,
            "protocol": PROTOCOL_VERSION,
        }
    )
    try:
        while not engine._stop:
            line = sys.stdin.readline()
            if not line:
                break
            if len(line.encode("utf-8", "replace")) > MAX_LINE_BYTES:
                _emit({"id": None, "ok": False, "error": {"type": "ValueError", "message": "请求过大"}})
                continue
            text = line.strip()
            if not text:
                continue
            try:
                request = json.loads(text)
            except ValueError as exc:
                _emit({"id": None, "ok": False, "error": {"type": "JSONDecodeError", "message": str(exc)}})
                continue
            if not isinstance(request, dict):
                _emit({"id": None, "ok": False, "error": {"type": "ValueError", "message": "请求必须是对象"}})
                continue
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            if not isinstance(method, str) or not isinstance(params, dict):
                _emit({"id": request_id, "ok": False, "error": {"type": "ValueError", "message": "method/params 不合法"}})
                continue
            if method not in _ALLOWED_METHODS:
                _emit(_error(request_id, ValueError(f"未知方法：{method}")))
                continue
            try:
                handler = getattr(engine, _DISPATCH[method])
                result = handler(params)
                _emit({"id": request_id, "ok": True, "result": result})
            except Exception as exc:  # 单次请求失败不能拖垮整个引擎
                _emit(_error(request_id, exc))
            finally:
                if method not in _LONG_METHODS:
                    engine.close()
    finally:
        engine.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())