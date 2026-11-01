import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

from infohub import push as push_mod
from infohub import wecom_bot
from infohub.config import Config


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _cfg(tmp_path, **push) -> Config:
    data = str(tmp_path)
    return Config(raw={"data_dir": data, "push": dict(push)}, path=tmp_path / "config.json")


@pytest.fixture()
def cfg(tmp_path):
    return _cfg(tmp_path, channel="wecom_bot", wecom_bot_port=_free_port())


def _request(cfg, path, payload=None, token=""):
    url = f"http://127.0.0.1:{wecom_bot.port(cfg)}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "X-Infohub-Token": token},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


@pytest.fixture()
def server(cfg):
    service = wecom_bot.BotService(cfg)
    token = wecom_bot.ensure_token(cfg)
    httpd = wecom_bot.make_server(cfg, service, token)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield service, token
    httpd.shutdown()
    httpd.server_close()


def test_state_roundtrip_and_stable_token(cfg):
    assert wecom_bot.load_state(cfg) == {}
    token = wecom_bot.ensure_token(cfg)
    assert token and wecom_bot.ensure_token(cfg) == token
    state = wecom_bot.load_state(cfg)
    state.update(chat_id="zhangsan", chat_type=1)
    wecom_bot.save_state(cfg, state)
    assert wecom_bot.load_state(cfg)["chat_id"] == "zhangsan"
    assert wecom_bot.state_path(cfg).name == "wecom_bot.json"


def test_status_reports_unready(cfg, server):
    _, _ = server
    data = _request(cfg, "/status")
    assert data["ok"] and data["connected"] is False
    assert data["chat_known"] is False
    assert data["port"] == wecom_bot.port(cfg)


def test_send_requires_token(cfg, server):
    service, _ = server
    service.state["chat_id"] = "zhangsan"
    with pytest.raises(urllib.error.HTTPError) as exc:
        _request(cfg, "/send", {"markdown": "hi"}, token="wrong")
    assert exc.value.code == 403


def test_send_reports_missing_chat(cfg, server):
    service, token = server
    service.connected = True
    service.loop = object()
    service.client = object()
    with pytest.raises(urllib.error.HTTPError) as exc:
        _request(cfg, "/send", {"markdown": "hi"}, token=token)
    assert exc.value.code == 502
    body = json.loads(exc.value.read().decode("utf-8"))
    assert "先在企业微信里给机器人发一条" in body["detail"]


def test_send_ok_with_token(cfg, server):
    service, token = server
    service.send_markdown = lambda markdown, timeout=12.0: (True, "已发送")
    data = _request(cfg, "/send", {"markdown": "**hi**"}, token=token)
    assert data == {"ok": True, "detail": "已发送"}


def test_message_records_chat(cfg):
    service = wecom_bot.BotService(cfg)
    frame = {
        "cmd": "aibot_msg_callback",
        "body": {
            "msgtype": "text",
            "chattype": "group",
            "chatid": "wr_group_1",
            "from": {"userid": "zhangsan"},
            "text": {"content": "你好"},
        },
    }
    service._on_message(frame)
    state = wecom_bot.load_state(cfg)
    assert state["chat_id"] == "wr_group_1"
    assert state["chat_type"] == 2
    assert state["user_id"] == "zhangsan"
    assert state["token"]


def test_single_chat_falls_back_to_userid(cfg):
    service = wecom_bot.BotService(cfg)
    service._on_message(
        {"body": {"msgtype": "text", "chattype": "single", "from": {"userid": "lisi"}}}
    )
    state = wecom_bot.load_state(cfg)
    assert state["chat_id"] == "lisi"
    assert state["chat_type"] == 1


def test_push_routes_to_daemon(cfg, monkeypatch):
    seen = {}

    monkeypatch.setattr(wecom_bot, "ensure_daemon", lambda c: {"ok": True})
    monkeypatch.setattr(
        wecom_bot,
        "wait_ready",
        lambda c, timeout=12.0: {
            "ok": True,
            "connected": True,
            "chat_known": True,
            "last_error": "",
        },
    )

    def fake_post(c, path, payload, timeout=20.0):
        seen["path"] = path
        seen["markdown"] = payload["markdown"]
        return {"ok": True, "detail": "已发送"}

    monkeypatch.setattr(wecom_bot, "_post", fake_post)
    result = wecom_bot.push(cfg, "很长的" * 2000)
    assert result.ok and result.channel == "wecom_bot"
    assert seen["path"] == "/send"
    assert len(seen["markdown"].encode("utf-8")) <= 4096


def test_push_explains_unknown_chat(cfg, monkeypatch):
    monkeypatch.setattr(wecom_bot, "ensure_daemon", lambda c: {"ok": True})
    monkeypatch.setattr(
        wecom_bot,
        "wait_ready",
        lambda c, timeout=12.0: {"ok": True, "connected": True, "chat_known": False},
    )
    result = wecom_bot.push(cfg, "hi")
    assert not result.ok
    assert "先在企业微信里给机器人发一条消息" in result.detail


def test_push_channel_dispatches_to_bot(cfg, monkeypatch):
    cfg.raw["push"].update(enabled=True, wecom_bot_id="id", wecom_bot_secret="secret")
    called = {}

    def fake(c, markdown):
        called["markdown"] = markdown
        return push_mod.PushResult(True, "wecom_bot", "已发送")

    monkeypatch.setattr(wecom_bot, "push", fake)
    result = push_mod.push(cfg, "subj", "plain", None, "**md**")
    assert result.ok
    assert called["markdown"] == "**md**"


def test_missing_bot_credentials(cfg):
    cfg.raw["push"].update(channel="wecom_bot", wecom_bot_id="", wecom_bot_secret="")
    assert push_mod.missing(cfg) == ["wecom_bot_id", "wecom_bot_secret"]
    assert not wecom_bot.configured(cfg)
