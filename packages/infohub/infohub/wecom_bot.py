from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import HOME, Config

DEFAULT_PORT = 8765
STATE_NAME = "wecom_bot.json"
LOG_NAME = "wecom_bot.log"
_HEADER = "X-Infohub-Token"


def credentials(cfg: Config) -> tuple[str, str]:
    push = cfg.push or {}
    bot_id = os.environ.get("INFOHUB_WECOM_BOT_ID") or str(push.get("wecom_bot_id") or "")
    secret = os.environ.get("INFOHUB_WECOM_BOT_SECRET") or str(push.get("wecom_bot_secret") or "")
    return bot_id.strip(), secret.strip()


def configured(cfg: Config) -> bool:
    return all(credentials(cfg))


def port(cfg: Config) -> int:
    try:
        return int((cfg.push or {}).get("wecom_bot_port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        return DEFAULT_PORT


def state_path(cfg: Config) -> Path:
    return cfg.data_dir / STATE_NAME


def log_path(cfg: Config) -> Path:
    return cfg.data_dir / LOG_NAME


def load_state(cfg: Config) -> dict:
    try:
        return json.loads(state_path(cfg).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(cfg: Config, state: dict) -> None:
    path = state_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def ensure_token(cfg: Config) -> str:
    state = load_state(cfg)
    if not state.get("token"):
        state["token"] = secrets.token_hex(16)
        save_state(cfg, state)
    return state["token"]


def _log(cfg: Config, message: str) -> None:
    path = log_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {message}\n")
    except OSError:
        pass


WELCOME = (
    "**InfoHub 已连接**\n"
    "> 之后整点简报会推到这里。\n"
    "> 需要手动推一次时，在界面点「推送到手机」或运行 `infohub digest --push`。"
)


class _SdkLogger:
    """把 SDK 日志收进同一个文件；DEBUG 丢弃，避免日志被刷屏。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def debug(self, message) -> None:
        return

    def info(self, message) -> None:
        _log(self.cfg, f"[sdk] {message}")

    def warn(self, message) -> None:
        _log(self.cfg, f"[sdk] {message}")

    def error(self, message) -> None:
        _log(self.cfg, f"[sdk] {message}")


class BotService:
    """持有唯一一条长连接；收到消息时记住会话，并可主动推送。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.state = load_state(cfg)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.client = None
        self.connected = False
        self.last_error = ""
        self.started_at = int(time.time())
        self._stopped = False
        self._auth: asyncio.Event | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        threading.Thread(target=self._run, name="wecom-bot", daemon=True).start()

    def _run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._auth = asyncio.Event()
        try:
            self.loop.run_until_complete(self._connect_forever())
            if not self._stopped:
                self.loop.run_forever()
        except Exception as exc:  # pragma: no cover - 后台线程兜底
            self.last_error = f"{type(exc).__name__}: {exc}"
            _log(self.cfg, f"后台线程退出：{self.last_error}")

    def _new_client(self):
        from aibot import WSClient, WSClientOptions

        bot_id, secret = credentials(self.cfg)
        # 重连由本模块的循环负责，避免 SDK 递归重连
        client = WSClient(
            WSClientOptions(
                bot_id=bot_id,
                secret=secret,
                max_reconnect_attempts=0,
                logger=_SdkLogger(self.cfg),
            )
        )
        client.on("authenticated", self._on_auth)
        client.on("disconnected", self._on_disconnect)
        client.on("error", self._on_error)
        client.on("message", self._on_message)
        return client

    async def _connect_forever(self) -> None:
        try:
            from aibot import WSClient  # noqa: F401 - 提前暴露缺依赖
        except ImportError as exc:  # pragma: no cover - 依赖缺失时给出明确提示
            self.last_error = f"缺依赖 wecom-aibot-python-sdk：{exc}"
            _log(self.cfg, self.last_error)
            return
        failures = 0
        while not self._stopped:
            if self.connected:
                await asyncio.sleep(5)
                continue
            if self.client is None:
                self.client = self._new_client()
                if self._auth is not None:
                    self._auth.clear()
                try:
                    await self.client.connect()
                except Exception as exc:
                    self.last_error = f"{type(exc).__name__}: {exc}"
                try:
                    await asyncio.wait_for(self._auth.wait(), 10)
                except TimeoutError:
                    pass
            if self.connected:
                failures = 0
                _log(self.cfg, "长连接就绪")
                await asyncio.sleep(5)
                continue
            failures += 1
            if failures == 1 or failures % 12 == 0:
                _log(self.cfg, f"暂未连上（第 {failures} 次）：{self.last_error or '认证无响应'}")
            try:
                if self.client is not None:
                    self.client.disconnect()
            except Exception:
                pass
            self.client = None
            await asyncio.sleep(5)

    def _on_auth(self) -> None:
        self.connected = True
        self.last_error = ""
        if self._auth is not None:
            self._auth.set()
        _log(self.cfg, "长连接已认证")

    def _on_disconnect(self, reason=None) -> None:
        self.connected = False
        self.client = None
        _log(self.cfg, f"长连接断开：{reason}")

    def _on_error(self, error) -> None:
        self.last_error = str(error)
        _log(self.cfg, f"连接错误：{error}")

    def _on_message(self, frame) -> None:
        body = (frame or {}).get("body") or {}
        from_user = (body.get("from") or {}).get("userid", "")
        chat_id = body.get("chatid") or from_user
        if not chat_id:
            return
        chat_type = 2 if str(body.get("chattype", "")).lower() == "group" else 1
        with self._lock:
            seen = list(self.state.get("welcomed") or [])
            welcome = chat_id not in seen
            # 单聊优先：群里的消息不把主动推送目标改成群
            if chat_type == 1 or not self.state.get("chat_id"):
                self.state.update(chat_id=chat_id, chat_type=chat_type, user_id=from_user)
            self.state["last_seen"] = int(time.time())
            self.state["welcomed"] = (seen + [chat_id])[-5:]
            self.state.setdefault("token", secrets.token_hex(16))
            save_state(self.cfg, self.state)
        _log(self.cfg, f"收到消息 type={body.get('msgtype')} chat_type={chat_type} 欢迎语={welcome}")
        if welcome and self.loop is not None:
            asyncio.ensure_future(self._welcome(chat_id, chat_type))

    async def _welcome(self, chat_id: str, chat_type: int) -> None:
        try:
            await self._send(chat_id, chat_type, WELCOME)
            with self._lock:
                self.state["last_sent"] = int(time.time())
                save_state(self.cfg, self.state)
            _log(self.cfg, "已发送欢迎语")
        except Exception as exc:
            _log(self.cfg, f"欢迎语发送失败：{exc}")

    async def _send(self, chat_id: str, chat_type: int, markdown: str) -> dict:
        if self.client is None:
            raise RuntimeError("长连接尚未建立")
        frame = await self.client.send_message(
            chat_id,
            {
                "chat_type": chat_type,
                "msgtype": "markdown",
                "markdown": {"content": markdown},
            },
        )
        return frame or {}

    def send_markdown(self, markdown: str, timeout: float = 12.0) -> tuple[bool, str]:
        if not self.connected or self.loop is None or self.client is None:
            return False, self.last_error or "长连接未就绪"
        chat_id = self.state.get("chat_id")
        if not chat_id:
            return False, "还没收到过你的消息：先在企业微信里给机器人发一条「你好」"
        future = asyncio.run_coroutine_threadsafe(
            self._send(chat_id, int(self.state.get("chat_type") or 1), markdown), self.loop
        )
        try:
            frame = future.result(timeout)
        except TimeoutError:
            return False, "等待企微回执超时"
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"
        errcode = frame.get("errcode")
        if errcode not in (0, None):
            return False, f"errcode={errcode} {frame.get('errmsg', '')}".strip()
        with self._lock:
            self.state["last_sent"] = int(time.time())
            save_state(self.cfg, self.state)
        return True, "已发送"

    def stop(self) -> None:
        self._stopped = True
        loop, client = self.loop, self.client
        if loop is None or loop.is_closed() or not loop.is_running():
            return

        async def _bye() -> None:
            try:
                if client is not None:
                    client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(0.3)

        try:
            asyncio.run_coroutine_threadsafe(_bye(), loop).result(3)
        except Exception:
            pass
        try:
            loop.call_soon_threadsafe(loop.stop)
        except RuntimeError:
            pass


def _handler_factory(cfg: Config, service: BotService, token: str):
    started = int(time.time())

    class Handler(BaseHTTPRequestHandler):
        server_version = "InfoHubBot/0.1"

        def _reply(self, code: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            self.wfile.write(data)

        def _authed(self) -> bool:
            return secrets.compare_digest(self.headers.get(_HEADER, ""), token)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/status":
                self._reply(404, {"ok": False, "detail": "not found"})
                return
            state = service.state
            self._reply(
                200,
                {
                    "ok": True,
                    "pid": os.getpid(),
                    "port": port(cfg),
                    "connected": service.connected,
                    "chat_known": bool(state.get("chat_id")),
                    "chat_type": state.get("chat_type", 0),
                    "welcomed": bool(state.get("welcomed")),
                    "last_seen": state.get("last_seen", 0),
                    "last_sent": state.get("last_sent", 0),
                    "last_error": service.last_error,
                    "uptime": int(time.time()) - started,
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            if path not in ("/send", "/shutdown"):
                self._reply(404, {"ok": False, "detail": "not found"})
                return
            if not self._authed():
                self._reply(403, {"ok": False, "detail": "token 不对"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._reply(400, {"ok": False, "detail": "body 不是 JSON"})
                return
            if path == "/shutdown":
                self._reply(200, {"ok": True, "detail": "bye"})

                def _shutdown() -> None:
                    service.stop()
                    self.server.shutdown()

                threading.Thread(target=_shutdown, daemon=True).start()
                return
            markdown = str(payload.get("markdown") or payload.get("text") or "")
            if not markdown.strip():
                self._reply(400, {"ok": False, "detail": "markdown 为空"})
                return
            try:
                ok, detail = service.send_markdown(markdown)
            except Exception as exc:  # pragma: no cover - 兜底，防止后台被一次推送打断
                ok, detail = False, f"{type(exc).__name__}: {exc}"
            self._reply(200 if ok else 502, {"ok": ok, "detail": detail})

        def log_message(self, *args) -> None:
            return

    return Handler


def make_server(cfg: Config, service: BotService, token: str) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port(cfg)), _handler_factory(cfg, service, token))


def serve(cfg: Config) -> int:
    bot_id, secret = credentials(cfg)
    if not (bot_id and secret):
        print("缺 wecom_bot_id / wecom_bot_secret，先在 config.json 的 push 里填")
        return 2
    token = ensure_token(cfg)
    service = BotService(cfg)
    try:
        server = make_server(cfg, service, token)
    except OSError as exc:
        print(f"端口 {port(cfg)} 被占用：{exc}")
        return 1
    service.start()
    print(f"InfoHub 机器人后台已启动 127.0.0.1:{port(cfg)}（Ctrl+C 退出）", flush=True)
    _log(cfg, f"后台启动 pid={os.getpid()} port={port(cfg)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.stop()
    return 0


def _spawn(cfg: Config) -> None:
    exe = Path(sys.executable)
    if os.name == "nt":
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.exists():
            exe = pythonw
    log_path(cfg).parent.mkdir(parents=True, exist_ok=True)
    kwargs: dict = {
        "cwd": str(HOME),
        "stdin": subprocess.DEVNULL,
        "stderr": subprocess.STDOUT,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    with log_path(cfg).open("ab") as log_file:
        subprocess.Popen([str(exe), "-m", "infohub", "bot", "--serve"], stdout=log_file, **kwargs)


def status(cfg: Config, timeout: float = 2.0) -> dict | None:
    url = f"http://127.0.0.1:{port(cfg)}/status"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - 本机回环
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def ensure_daemon(cfg: Config, wait: float = 12.0) -> dict | None:
    st = status(cfg)
    if st and st.get("ok"):
        return st
    if not configured(cfg):
        return None
    _spawn(cfg)
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.4)
        st = status(cfg)
        if st and st.get("ok"):
            return st
    return None


def _post(cfg: Config, path: str, payload: dict, timeout: float = 20.0) -> dict:
    url = f"http://127.0.0.1:{port(cfg)}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", _HEADER: load_state(cfg).get("token", "")},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - 本机回环
        return json.loads(resp.read().decode("utf-8"))


def wait_ready(cfg: Config, timeout: float = 12.0) -> dict | None:
    deadline = time.time() + timeout
    st = status(cfg)
    while st and not st.get("connected") and time.time() < deadline:
        time.sleep(0.5)
        st = status(cfg)
    return st


def push(cfg: Config, client_markdown: str):
    from .push import PushResult, clip_bytes

    st = ensure_daemon(cfg)
    if not st:
        return PushResult(False, "wecom_bot", f"后台没起来，看 {log_path(cfg)}")
    st = wait_ready(cfg) or st
    if not st.get("connected"):
        return PushResult(False, "wecom_bot", st.get("last_error") or "长连接未就绪，稍后再试")
    if not st.get("chat_known"):
        return PushResult(False, "wecom_bot", "先在企业微信里给机器人发一条消息，建立会话后才能主动推送")
    try:
        result = _post(cfg, "/send", {"markdown": clip_bytes(client_markdown, 4096)})
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return PushResult(False, "wecom_bot", f"{type(exc).__name__}: {exc}")
    detail = result.get("detail") or ""
    return PushResult(bool(result.get("ok")), "wecom_bot", detail)


def stop_daemon(cfg: Config) -> tuple[bool, str]:
    if status(cfg) is None:
        return False, "后台没在跑"
    try:
        result = _post(cfg, "/shutdown", {})
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"{type(exc).__name__}: {exc}"
    deadline = time.time() + 5
    while time.time() < deadline:
        if status(cfg, timeout=0.5) is None:
            return bool(result.get("ok")), "已退出"
        time.sleep(0.2)
    return False, "已发出停止指令，但进程还在，稍后再查"
