from __future__ import annotations

import json
import os
import smtplib
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from .config import Config

CHANNELS = ("none", "smtp", "wecom", "wecom_bot")
FIELD_LABEL = {
    "smtp_host": "smtp_host",
    "smtp_user": "smtp_user（发件邮箱）",
    "smtp_pass": "smtp_pass（QQ 邮箱授权码）",
    "mail_to": "mail_to（收件邮箱）",
    "wecom_webhook": "wecom_webhook（群机器人地址）",
    "wecom_bot_id": "wecom_bot_id（智能机器人 Bot ID）",
    "wecom_bot_secret": "wecom_bot_secret（智能机器人 Secret）",
    "channel": "channel（wecom_bot / wecom / smtp）",
}


@dataclass
class PushResult:
    ok: bool
    channel: str
    detail: str = ""

    def __bool__(self) -> bool:
        return self.ok


WECOM_LIMIT = 4096  # markdown 单条上限，按 UTF-8 字节算，不是字数
WECOM_HINTS = {
    93000: "webhook 地址无效，回群里重新复制完整地址",
    45009: "触发频率限制：每个机器人每分钟最多 20 条",
    40001: "消息内容为空或格式错误",
    40058: "参数错误，检查 webhook 与消息体",
    60020: "来源 IP 不在可信 IP 列表（只有自建应用消息才会遇到）",
}


def clip_bytes(text: str, limit: int) -> str:
    """按 UTF-8 字节截断，中文一个字 3 字节，不能直接用字符数。"""
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text
    tail = "…"
    budget = limit - len(tail.encode("utf-8"))
    return data[:budget].decode("utf-8", "ignore").rstrip() + tail


def _webhook(value: str) -> str:
    """允许只填机器人 key，自动补成完整 webhook 地址。"""
    value = (value or "").strip()
    if not value or value.startswith(("http://", "https://")):
        return value
    return f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={value}"


def settings(cfg: Config) -> dict:
    """配置 + 环境变量覆盖；密码优先读环境变量，避免明文落盘。"""
    raw = dict(cfg.push or {})
    raw["channel"] = str(raw.get("channel") or "none").lower()
    raw["wecom_webhook"] = _webhook(os.environ.get("INFOHUB_WECOM_WEBHOOK") or raw.get("wecom_webhook", ""))
    raw["wecom_bot_id"] = (os.environ.get("INFOHUB_WECOM_BOT_ID") or raw.get("wecom_bot_id", "")).strip()
    raw["wecom_bot_secret"] = (os.environ.get("INFOHUB_WECOM_BOT_SECRET") or raw.get("wecom_bot_secret", "")).strip()
    raw["smtp_pass"] = os.environ.get("INFOHUB_SMTP_PASS") or raw.get("smtp_pass", "")
    raw["smtp_user"] = os.environ.get("INFOHUB_SMTP_USER") or raw.get("smtp_user", "")
    raw["mail_to"] = os.environ.get("INFOHUB_MAIL_TO") or raw.get("mail_to", "") or raw["smtp_user"]
    return raw


def missing(cfg: Config) -> list[str]:
    """还缺哪些字段才能推送；空列表表示已配好。"""
    opts = settings(cfg)
    if opts["channel"] == "wecom":
        return [] if opts.get("wecom_webhook") else ["wecom_webhook"]
    if opts["channel"] == "wecom_bot":
        return [n for n in ("wecom_bot_id", "wecom_bot_secret") if not opts.get(n)]
    if opts["channel"] == "smtp":
        return [n for n in ("smtp_host", "smtp_user", "smtp_pass", "mail_to") if not opts.get(n)]
    return ["channel"]


def configured(cfg: Config) -> bool:
    return not missing(cfg)


def send_wecom(webhook: str, markdown: str, timeout: float = 15.0) -> PushResult:
    if not webhook:
        return PushResult(False, "wecom", "未配置 wecom_webhook")
    body = json.dumps(
        {"msgtype": "markdown", "markdown": {"content": clip_bytes(markdown, WECOM_LIMIT)}},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        webhook,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - 用户显式配置的 webhook
            payload = resp.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return PushResult(False, "wecom", f"{type(exc).__name__}: {exc}")
    try:
        data = json.loads(payload)
    except ValueError:
        return PushResult(False, "wecom", f"返回不是 JSON：{payload[:120]}")
    code = int(data.get("errcode", -1))
    if code == 0:
        return PushResult(True, "wecom", "已发送")
    hint = WECOM_HINTS.get(code)
    detail = f"errcode={code} {data.get('errmsg', '')}".strip()
    return PushResult(False, "wecom", f"{detail}（{hint}）" if hint else detail)


def build_mail(opts: dict, subject: str, text: str, html: str | None = None) -> MIMEMultipart:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = opts.get("smtp_user", "")
    msg["To"] = opts.get("mail_to", "")
    msg.attach(MIMEText(text, "plain", "utf-8"))
    if html:
        msg.attach(MIMEText(html, "html", "utf-8"))
    return msg


def send_smtp(opts: dict, subject: str, text: str, html: str | None = None,
              timeout: float = 25.0) -> PushResult:
    host = str(opts.get("smtp_host") or "")
    port = int(opts.get("smtp_port") or 465)
    user = str(opts.get("smtp_user") or "")
    password = str(opts.get("smtp_pass") or "")
    to_addr = str(opts.get("mail_to") or user)
    if not (host and user and password and to_addr):
        return PushResult(False, "smtp", "SMTP 未配置完整（host/user/pass/to）")
    msg = build_mail(opts, subject, text, html)
    try:
        context = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=timeout, context=context) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=timeout) as smtp:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.login(user, password)
                smtp.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        return PushResult(False, "smtp", f"{type(exc).__name__}: {exc}")
    return PushResult(True, "smtp", f"已发送到 {to_addr}")


def push(cfg: Config, subject: str, text: str, html: str | None = None,
         wecom_text: str | None = None) -> PushResult:
    opts = settings(cfg)
    channel = opts["channel"]
    if not (cfg.push or {}).get("enabled") or channel == "none":
        return PushResult(False, channel or "none", "推送未启用（push.enabled = false）")
    if channel == "smtp" and not opts.get("smtp_pass"):
        return PushResult(False, "smtp", "缺 smtp_pass：QQ 邮箱要填授权码，不是登录密码")
    if channel == "wecom" and not opts.get("wecom_webhook"):
        return PushResult(False, "wecom", "缺 wecom_webhook：企业微信群里加机器人后复制 webhook 地址")
    if channel == "wecom_bot":
        from . import wecom_bot

        if not opts.get("wecom_bot_id") or not opts.get("wecom_bot_secret"):
            return PushResult(False, "wecom_bot", "缺 wecom_bot_id / wecom_bot_secret")
        return wecom_bot.push(cfg, wecom_text or text)
    if channel == "wecom":
        return send_wecom(opts.get("wecom_webhook", ""), wecom_text or text)
    if channel == "smtp":
        return send_smtp(opts, subject, text, html)
    return PushResult(False, channel, f"未知通道：{channel}")
