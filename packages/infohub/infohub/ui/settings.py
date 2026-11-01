from __future__ import annotations

import copy
import os
import time

from PySide6.QtCore import QTime, Qt, QThread, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTabWidget,
    QTimeEdit,
    QVBoxLayout,
    QWidget,
)

from .. import llm, wecom_bot
from ..config import CONFIG_PATH, Config
from ..push import push as send_push
from .theme import QSS

CHANNEL_ITEMS = (
    ("wecom_bot", "企业微信智能机器人（长连接，推荐）"),
    ("wecom", "企业微信群机器人（Webhook）"),
    ("smtp", "邮件 SMTP"),
    ("none", "不推送"),
)


class _Task(QThread):
    """把网络操作挪出 UI 线程；按钮在任务期间禁用。"""

    done = Signal(bool, str)

    def __init__(self, fn, parent=None):
        super().__init__(parent)
        self._fn = fn

    def run(self) -> None:
        try:
            ok, detail = self._fn()
        except Exception as exc:  # noqa: BLE001
            ok, detail = False, f"{type(exc).__name__}: {exc}"
        self.done.emit(bool(ok), str(detail))


def _hint(text: str) -> QLabel:
    label = QLabel(text)
    label.setObjectName("hint")
    label.setWordWrap(True)
    return label


def _stamp(ts) -> str:
    try:
        return time.strftime("%m-%d %H:%M", time.localtime(int(ts)))
    except (TypeError, ValueError, OSError):
        return ""


class SettingsDialog(QDialog):
    saved = Signal(bool)          # 参数：是否改动了机器人凭据/端口/通道
    synced = Signal(bool, str)    # 后台同步结果，交给主窗口状态栏

    def __init__(self, cfg: Config, parent=None):
        super().__init__(parent)
        self.cfg = cfg
        self._tasks: list[QThread] = []
        self.setWindowTitle("InfoHub 设置")
        self.setMinimumWidth(680)
        self.setStyleSheet(QSS)
        self._build()
        self._load()
        self._sync_channel()
        self._sync_llm_warning()
        self._status_timer = QTimer(self)
        self._status_timer.setInterval(3000)
        self._status_timer.timeout.connect(self._refresh_bot_state)
        self._status_timer.start()
        self.finished.connect(self._status_timer.stop)
        QTimer.singleShot(120, self._refresh_bot_state)

    # ---------- 构建 ----------

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 12)
        root.setSpacing(10)
        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_push_tab(), "企业微信 / 推送")
        self.tabs.addTab(self._build_llm_tab(), "大模型")
        root.addWidget(self.tabs, 1)

        foot = QHBoxLayout()
        open_btn = QPushButton("打开 config.json")
        open_btn.setToolTip(str(CONFIG_PATH))
        open_btn.clicked.connect(
            lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(CONFIG_PATH)))
        )
        foot.addWidget(open_btn)
        foot.addStretch(1)
        cancel = QPushButton("取消")
        cancel.clicked.connect(self.reject)
        save = QPushButton("保存")
        save.setObjectName("primary")
        save.setDefault(True)
        save.clicked.connect(self._save)
        foot.addWidget(cancel)
        foot.addWidget(save)
        root.addLayout(foot)

    def _build_push_tab(self) -> QWidget:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(4, 10, 4, 6)
        lay.setSpacing(10)

        top = QFormLayout()
        top.setLabelAlignment(Qt.AlignRight)
        top.setHorizontalSpacing(10)
        self.push_enabled = QCheckBox("整点简报生成后自动推送到手机（界面开着时）")
        top.addRow("", self.push_enabled)
        self.channel = QComboBox()
        for key, label in CHANNEL_ITEMS:
            self.channel.addItem(label, key)
        self.channel.currentIndexChanged.connect(self._sync_channel)
        top.addRow("通道", self.channel)
        lay.addLayout(top)

        self.notice_box = QGroupBox("每日通知")
        nf = QFormLayout(self.notice_box)
        nf.setLabelAlignment(Qt.AlignRight)
        nf.setHorizontalSpacing(10)
        self.notice_enabled = QCheckBox("每天到点把班级公共事务整理成可转发的通知并推送")
        self.notice_time = QTimeEdit()
        self.notice_time.setDisplayFormat("HH:mm")
        self.notice_time.setMaximumWidth(100)
        self.notice_class = QLineEdit()
        self.notice_class.setMaximumWidth(180)
        self.notice_max = QSpinBox()
        self.notice_max.setRange(1, 20)
        self.notice_max.setMaximumWidth(100)
        self.notice_ai = QCheckBox("用大模型合并成文（关闭则按规则拼接，标题质量较差）")
        nf.addRow("", self.notice_enabled)
        nf.addRow("发送时间", self.notice_time)
        nf.addRow("落款班级", self.notice_class)
        nf.addRow("最多条数", self.notice_max)
        nf.addRow("", self.notice_ai)
        nf.addRow("", _hint("同一天只发一次；正文另存到 data/daily/YYYY-MM-DD.txt。推送走上面的通道。"))
        lay.addWidget(self.notice_box)

        self.bot_box = QGroupBox("企业微信智能机器人")
        bf = QFormLayout(self.bot_box)
        bf.setLabelAlignment(Qt.AlignRight)
        bf.setHorizontalSpacing(10)
        self.bot_id = QLineEdit()
        self.bot_id.setPlaceholderText("aib…（企业微信管理后台的 Bot ID）")
        self.bot_secret = QLineEdit()
        self.bot_secret.setEchoMode(QLineEdit.EchoMode.Password)
        self.bot_secret.setPlaceholderText("只保存在本机 config.json")
        self.bot_port = QSpinBox()
        self.bot_port.setRange(1024, 65535)
        self.bot_port.setMaximumWidth(140)
        self.bot_state = QLabel("")
        self.bot_state.setObjectName("hint")
        self.bot_restart = QPushButton("重启后台")
        self.bot_restart.setToolTip("用已保存的配置重启本地长连接后台")
        self.bot_restart.clicked.connect(self._restart_bot)
        state_row = QHBoxLayout()
        state_row.addWidget(self.bot_state, 1)
        state_row.addWidget(self.bot_restart)
        bf.addRow("Bot ID", self.bot_id)
        bf.addRow("Secret", self.bot_secret)
        bf.addRow("本地端口", self.bot_port)
        bf.addRow("状态", state_row)
        env = [k for k in ("INFOHUB_WECOM_BOT_ID", "INFOHUB_WECOM_BOT_SECRET") if os.environ.get(k)]
        note = (
            "企业微信里先给机器人发一条消息，InfoHub 才能主动推送。"
            "长连接只有一个，重启后台后旧的连接会断开。"
        )
        if env:
            note += f"\n注意：环境变量 {'、'.join(env)} 会覆盖这里填的值。"
        bf.addRow("", _hint(note))
        lay.addWidget(self.bot_box)

        self.webhook_box = QGroupBox("企业微信群机器人")
        wf = QFormLayout(self.webhook_box)
        wf.setLabelAlignment(Qt.AlignRight)
        self.webhook = QLineEdit()
        self.webhook.setPlaceholderText("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…（只填 key 也行）")
        wf.addRow("Webhook", self.webhook)
        wf.addRow("", _hint("群里加机器人后复制地址；单条消息上限 4096 字节，每分钟最多 20 条。"))
        lay.addWidget(self.webhook_box)

        self.smtp_box = QGroupBox("邮件 SMTP")
        sf = QFormLayout(self.smtp_box)
        sf.setLabelAlignment(Qt.AlignRight)
        self.smtp_host = QLineEdit()
        self.smtp_port = QSpinBox()
        self.smtp_port.setRange(1, 65535)
        self.smtp_port.setMaximumWidth(140)
        self.smtp_user = QLineEdit()
        self.smtp_user.setPlaceholderText("发件邮箱")
        self.smtp_pass = QLineEdit()
        self.smtp_pass.setEchoMode(QLineEdit.EchoMode.Password)
        self.smtp_pass.setPlaceholderText("QQ 邮箱填授权码，不是登录密码")
        self.mail_to = QLineEdit()
        self.mail_to.setPlaceholderText("留空则发给自己")
        host_row = QHBoxLayout()
        host_row.addWidget(self.smtp_host, 1)
        host_row.addWidget(QLabel("端口"))
        host_row.addWidget(self.smtp_port)
        sf.addRow("服务器", host_row)
        sf.addRow("发件邮箱", self.smtp_user)
        sf.addRow("授权码", self.smtp_pass)
        sf.addRow("收件邮箱", self.mail_to)
        lay.addWidget(self.smtp_box)

        self.send_empty = QCheckBox("这一小时没有新消息也发一条")
        lay.addWidget(self.send_empty)

        test_row = QHBoxLayout()
        self.push_test_btn = QPushButton("测试推送")
        self.push_test_btn.clicked.connect(self._test_push)
        self.push_test_label = QLabel("")
        self.push_test_label.setWordWrap(True)
        test_row.addWidget(self.push_test_btn)
        test_row.addWidget(self.push_test_label, 1)
        lay.addLayout(test_row)
        lay.addWidget(
            _hint(
                "测试使用当前表单里的值，不会保存；机器人通道如果改了 Bot ID/Secret/端口，"
                "需要先保存再测试。"
            )
        )
        lay.addStretch(1)
        return tab

    def _build_llm_tab(self) -> QWidget:
        tab = QWidget()
        lay = QVBoxLayout(tab)
        lay.setContentsMargins(4, 10, 4, 6)
        lay.setSpacing(10)

        self.llm_enabled = QCheckBox("启用 AI 分析报告：大模型读简报后给出结论、待办、通知和风险")
        lay.addWidget(self.llm_enabled)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignRight)
        form.setHorizontalSpacing(10)
        self.llm_base = QLineEdit()
        self.llm_base.setPlaceholderText("https://…/v1（OpenAI 兼容地址，通常以 /v1 结尾）")
        self.llm_base.textChanged.connect(self._sync_llm_warning)
        self.llm_model = QLineEdit()
        self.llm_model.setPlaceholderText("qwen2.5:7b")
        self.llm_key = QLineEdit()
        self.llm_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.llm_key.setPlaceholderText("本机 Ollama 留空；云端填 API Key")
        self.llm_timeout = QSpinBox()
        self.llm_timeout.setRange(5, 600)
        self.llm_timeout.setSuffix(" 秒")
        self.llm_timeout.setMaximumWidth(140)
        self.llm_prompt = QLineEdit()
        self.llm_prompt.setPlaceholderText("额外要求，比如「重点写截稿时间」（可留空）")
        form.addRow("接口地址", self.llm_base)
        form.addRow("模型", self.llm_model)
        form.addRow("API Key", self.llm_key)
        form.addRow("超时", self.llm_timeout)
        form.addRow("额外要求", self.llm_prompt)
        form.addRow("", self.llm_remote_row())
        lay.addLayout(form)

        agent_head = QHBoxLayout()
        agent_head.addWidget(QLabel("系统提示词（身份 / 人物 / 群聊语境）"))
        agent_head.addStretch(1)
        self.agent_reset = QPushButton("恢复内置")
        self.agent_reset.setToolTip("用按本机归档整理的内置身份档案覆盖当前内容")
        self.agent_reset.clicked.connect(self._reset_agent_prompt)
        agent_head.addWidget(self.agent_reset)
        lay.addLayout(agent_head)
        self.llm_agent = QPlainTextEdit()
        self.llm_agent.setPlaceholderText("留空使用内置身份档案（付梓杨 / 金融2601班长 / 学院秘书处 + 关键人物）")
        self.llm_agent.setFixedHeight(120)
        lay.addWidget(self.llm_agent)
        lay.addWidget(_hint(
            "内置档案来自本机归档：班级职务、辅导员与班委、学生会与比赛队友。"
            "留空即用内置内容；勾选外部地址时它也会随简报一起发给模型。"
        ))

        self.llm_warn = QLabel("")
        self.llm_warn.setWordWrap(True)
        lay.addWidget(self.llm_warn)

        env = [k for k in ("INFOHUB_LLM_BASE_URL", "INFOHUB_LLM_MODEL", "INFOHUB_LLM_API_KEY") if os.environ.get(k)]
        note = (
            "推荐本机 Ollama：装好后运行 ollama serve，再 ollama pull qwen2.5:7b，"
            "地址填 http://127.0.0.1:11434/v1。\n"
            "只把简报文字交给大模型，不发图片、文件和聊天原库；"
            "默认只允许本机/内网地址，聊天数据不出本机。"
        )
        if env:
            note += f"\n注意：环境变量 {'、'.join(env)} 会覆盖这里填的值。"
        lay.addWidget(_hint(note))

        test_row = QHBoxLayout()
        self.llm_test_btn = QPushButton("测试连接")
        self.llm_test_btn.clicked.connect(self._test_llm)
        self.llm_test_label = QLabel("")
        self.llm_test_label.setWordWrap(True)
        test_row.addWidget(self.llm_test_btn)
        test_row.addWidget(self.llm_test_label, 1)
        lay.addLayout(test_row)
        lay.addWidget(_hint("测试使用当前表单里的值，不会保存，也不需要先勾选启用。"))
        lay.addStretch(1)
        return tab

    def llm_remote_row(self) -> QWidget:
        box = QWidget()
        row = QVBoxLayout(box)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(2)
        self.llm_remote = QCheckBox("接口不是本机地址时，允许把简报内容发到该地址")
        self.llm_remote.toggled.connect(self._sync_llm_warning)
        row.addWidget(self.llm_remote)
        row.addWidget(_hint("不收图片、文件；只发当小时的简报文字。"))
        return box

    # ---------- 载入 / 视图联动 ----------

    def _load(self) -> None:
        push = self.cfg.raw.get("push") or {}
        self.push_enabled.setChecked(bool(push.get("enabled")))
        index = self.channel.findData(str(push.get("channel") or "wecom_bot"))
        self.channel.setCurrentIndex(index if index >= 0 else 0)
        self.bot_id.setText(str(push.get("wecom_bot_id") or ""))
        self.bot_secret.setText(str(push.get("wecom_bot_secret") or ""))
        try:
            self.bot_port.setValue(int(push.get("wecom_bot_port") or wecom_bot.DEFAULT_PORT))
        except (TypeError, ValueError):
            self.bot_port.setValue(wecom_bot.DEFAULT_PORT)
        self.webhook.setText(str(push.get("wecom_webhook") or ""))
        self.smtp_host.setText(str(push.get("smtp_host") or ""))
        try:
            self.smtp_port.setValue(int(push.get("smtp_port") or 465))
        except (TypeError, ValueError):
            self.smtp_port.setValue(465)
        self.smtp_user.setText(str(push.get("smtp_user") or ""))
        self.smtp_pass.setText(str(push.get("smtp_pass") or ""))
        self.mail_to.setText(str(push.get("mail_to") or ""))
        self.send_empty.setChecked(bool(push.get("send_empty")))

        notice = self.cfg.notice or {}
        self.notice_enabled.setChecked(bool(notice.get("enabled", True)))
        hour, minute = 17, 0
        try:
            hour, minute = (int(x) for x in str(notice.get("time") or "17:00").split(":", 1))
        except (TypeError, ValueError):
            pass
        self.notice_time.setTime(QTime(max(0, min(23, hour)), max(0, min(59, minute))))
        self.notice_class.setText(str(notice.get("class_name") or "金融2601"))
        try:
            self.notice_max.setValue(int(notice.get("max_items") or 10))
        except (TypeError, ValueError):
            self.notice_max.setValue(10)
        self.notice_ai.setChecked(bool(notice.get("ai", True)))

        opts = dict(llm.DEFAULTS)
        opts.update(self.cfg.raw.get("llm") or {})
        self.llm_enabled.setChecked(bool(opts.get("enabled")))
        self.llm_base.setText(str(opts.get("base_url") or ""))
        self.llm_model.setText(str(opts.get("model") or ""))
        self.llm_key.setText(str(opts.get("api_key") or ""))
        try:
            self.llm_timeout.setValue(int(opts.get("timeout") or 60))
        except (TypeError, ValueError):
            self.llm_timeout.setValue(60)
        base = self.llm_base.text().strip()
        self.llm_remote.setChecked(bool(opts.get("allow_remote")) and not llm.is_local(base))
        self.llm_prompt.setText(str(opts.get("prompt") or ""))
        self.llm_agent.setPlainText(str(opts.get("agent_prompt") or ""))

    def _sync_channel(self) -> None:
        channel = self.channel.currentData()
        self.bot_box.setVisible(channel == "wecom_bot")
        self.webhook_box.setVisible(channel == "wecom")
        self.smtp_box.setVisible(channel == "smtp")
        self.send_empty.setEnabled(channel != "none")
        self.push_test_btn.setEnabled(channel != "none")
        self._refresh_bot_state()

    def _sync_llm_warning(self) -> None:
        base = self.llm_base.text().strip()
        remote = bool(base) and not llm.is_local(base)
        self.llm_remote.setEnabled(remote)
        if not remote:
            self.llm_remote.setChecked(False)
            self.llm_warn.setText("")
            self.llm_warn.setVisible(False)
            return
        self.llm_warn.setVisible(True)
        if self.llm_remote.isChecked():
            self.llm_warn.setText("已允许把简报文字发到这个地址；聊天原库、图片和文件仍然只留在本机。")
            self.llm_warn.setStyleSheet("color:#b26a00;")
        else:
            self.llm_warn.setText("这个地址不是本机/内网：勾选上面的确认项才能启用大模型。")
            self.llm_warn.setStyleSheet("color:#c0392b;")

    # ---------- 表单值 ----------

    def _push_values(self) -> dict:
        return {
            "enabled": self.push_enabled.isChecked(),
            "channel": str(self.channel.currentData() or "none"),
            "send_empty": self.send_empty.isChecked(),
            "wecom_bot_id": self.bot_id.text().strip(),
            "wecom_bot_secret": self.bot_secret.text().strip(),
            "wecom_bot_port": int(self.bot_port.value()),
            "wecom_webhook": self.webhook.text().strip(),
            "smtp_host": self.smtp_host.text().strip(),
            "smtp_port": int(self.smtp_port.value()),
            "smtp_user": self.smtp_user.text().strip(),
            "smtp_pass": self.smtp_pass.text(),
            "mail_to": self.mail_to.text().strip(),
        }

    def _notice_values(self) -> dict:
        return {
            "enabled": self.notice_enabled.isChecked(),
            "time": self.notice_time.time().toString("HH:mm"),
            "class_name": self.notice_class.text().strip() or "金融2601",
            "max_items": int(self.notice_max.value()),
            "ai": self.notice_ai.isChecked(),
        }

    def _reset_agent_prompt(self) -> None:
        self.llm_agent.setPlainText(llm.PROFILE_PROMPT.strip())

    def _llm_values(self) -> dict:
        return {
            "enabled": self.llm_enabled.isChecked(),
            "base_url": self.llm_base.text().strip(),
            "model": self.llm_model.text().strip(),
            "api_key": self.llm_key.text().strip(),
            "timeout": int(self.llm_timeout.value()),
            "allow_remote": self.llm_remote.isChecked(),
            "prompt": self.llm_prompt.text().strip(),
            "agent_prompt": self.llm_agent.toPlainText().strip(),
        }

    def _draft(self) -> Config:
        raw = copy.deepcopy(self.cfg.raw)
        raw["push"] = {**(raw.get("push") or {}), **self._push_values()}
        raw["notice"] = {**(raw.get("notice") or {}), **self._notice_values()}
        raw["llm"] = {**(raw.get("llm") or {}), **self._llm_values()}
        return Config(raw=raw, path=self.cfg.path)

    @staticmethod
    def _bot_key(push: dict) -> tuple[str, str, int, str]:
        try:
            port = int(push.get("wecom_bot_port") or wecom_bot.DEFAULT_PORT)
        except (TypeError, ValueError):
            port = wecom_bot.DEFAULT_PORT
        return (
            str(push.get("wecom_bot_id") or "").strip(),
            str(push.get("wecom_bot_secret") or "").strip(),
            port,
            str(push.get("channel") or ""),
        )

    def _validate(self) -> bool:
        base = self.llm_base.text().strip()
        if (
            self.llm_enabled.isChecked()
            and base
            and not llm.is_local(base)
            and not self.llm_remote.isChecked()
        ):
            QMessageBox.warning(
                self,
                "先确认数据去向",
                "大模型接口不是本机/内网地址。\n\n"
                "按「聊天数据只留在本机」的约定，需要勾选「允许把简报内容发到该地址」"
                "才会保存并启用；或者把地址改回 http://127.0.0.1:11434/v1。",
            )
            return False
        return True

    # ---------- 异步任务 ----------

    def _run(self, fn, on_done) -> None:
        task = _Task(fn, self)
        self._tasks.append(task)
        task.done.connect(on_done)
        task.finished.connect(lambda t=task: self._tasks.remove(t) if t in self._tasks else None)
        task.start()

    @staticmethod
    def _set_result(label: QLabel, ok: bool, text: str) -> None:
        label.setText(("成功：" if ok else "失败：") + (text or ""))
        label.setStyleSheet("color:#1f9d63;" if ok else "color:#c0392b;")

    def _commit(self) -> bool:
        push = dict(self.cfg.raw.get("push") or {})
        old_key = self._bot_key(push)
        values = self._push_values()
        self.cfg.raw["push"] = {**push, **values}
        self.cfg.raw["notice"] = {**(self.cfg.raw.get("notice") or {}), **self._notice_values()}
        self.cfg.raw["llm"] = {**(self.cfg.raw.get("llm") or {}), **self._llm_values()}
        self.cfg.save()
        return old_key != self._bot_key(self.cfg.raw["push"])

    def _save(self) -> None:
        if not self._validate():
            return
        changed = self._commit()
        self._run(lambda: self._sync_bot(changed), self._on_synced)
        self.saved.emit(changed)
        self.accept()

    def _sync_bot(self, restart: bool) -> tuple[bool, str]:
        want = (
            str((self.cfg.push or {}).get("channel") or "") == "wecom_bot"
            and wecom_bot.configured(self.cfg)
        )
        st = wecom_bot.status(self.cfg, timeout=0.8)
        running = bool(st and st.get("ok"))
        if not want:
            if running:
                _, detail = wecom_bot.stop_daemon(self.cfg)
                return True, f"企微后台已停止：{detail}"
            return True, "推送通道不是智能机器人，后台未运行"
        if running and restart:
            wecom_bot.stop_daemon(self.cfg)
            running = False
        if not running:
            st = wecom_bot.ensure_daemon(self.cfg)
            if not st:
                return False, "企微后台没起来，看 data/wecom_bot.log"
            return True, f"企微后台已启动（pid={st.get('pid')}）"
        return True, "企微后台已在运行"

    def _on_synced(self, ok: bool, detail: str) -> None:
        self.synced.emit(ok, detail)
        QTimer.singleShot(400, self._refresh_bot_state)

    def _restart_bot(self) -> None:
        if not self._validate():
            return
        self._commit()
        self.bot_restart.setEnabled(False)
        self.bot_state.setText("正在重启后台…")
        self._run(lambda: self._sync_bot(True), self._on_restarted)

    def _on_restarted(self, ok: bool, detail: str) -> None:
        self.bot_restart.setEnabled(True)
        self.synced.emit(ok, detail)
        QTimer.singleShot(400, self._refresh_bot_state)

    # ---------- 测试 ----------

    def _test_push(self) -> None:
        draft = self._draft()
        channel = str(draft.push.get("channel") or "none")
        if channel == "none":
            self._set_result(self.push_test_label, False, "通道是「不推送」")
            return
        if channel == "wecom_bot" and self._bot_key(draft.push) != self._bot_key(self.cfg.push or {}):
            self._set_result(self.push_test_label, False, "机器人凭据或端口有改动，先点「保存」再测试")
            return
        draft.raw["push"]["enabled"] = True
        stamp = time.strftime("%m-%d %H:%M")
        label = self.channel.currentText()
        subject = f"InfoHub 推送测试 {stamp}"
        text = f"这是一条测试消息。\n时间：{stamp}\n通道：{label}\n收到说明投递链路已经打通。"
        wecom = (
            f"**InfoHub 推送测试**\n> 时间：{stamp}\n> 通道：{label}\n"
            "> 收到说明投递链路已经打通。"
        )
        self.push_test_btn.setEnabled(False)
        self.push_test_label.setStyleSheet("color:#8b929c;")
        self.push_test_label.setText("测试中…")
        self._run(
            lambda: self._push_job(draft, subject, text, wecom),
            self._on_push_tested,
        )

    @staticmethod
    def _push_job(draft: Config, subject: str, text: str, wecom: str) -> tuple[bool, str]:
        result = send_push(draft, subject, text, None, wecom)
        return bool(result.ok), result.detail

    def _on_push_tested(self, ok: bool, detail: str) -> None:
        self.push_test_btn.setEnabled(self.channel.currentData() != "none")
        self._set_result(self.push_test_label, ok, detail)
        QTimer.singleShot(300, self._refresh_bot_state)

    def _test_llm(self) -> None:
        draft = self._draft()
        draft.raw["llm"]["enabled"] = True
        self.llm_test_btn.setEnabled(False)
        self.llm_test_label.setStyleSheet("color:#8b929c;")
        self.llm_test_label.setText("测试中…")
        self._run(lambda: llm.test(draft), self._on_llm_tested)

    def _on_llm_tested(self, ok: bool, detail: str) -> None:
        self.llm_test_btn.setEnabled(True)
        self._set_result(self.llm_test_label, ok, detail)

    # ---------- 机器人状态 ----------

    def _refresh_bot_state(self) -> None:
        if self.channel.currentData() != "wecom_bot":
            self.bot_state.setText("")
            self.bot_state.setToolTip("")
            return
        bot_id = self.bot_id.text().strip()
        secret = self.bot_secret.text().strip()
        if not (bot_id and secret):
            self.bot_state.setText("未填 Bot ID / Secret")
            self.bot_state.setToolTip("填好后点保存，会启动本地长连接后台")
            return
        st = wecom_bot.status(self._draft(), timeout=0.4)
        if not st or not st.get("ok"):
            self.bot_state.setText("后台未运行")
            self.bot_state.setToolTip("点「重启后台」，或运行 infohub bot")
            return
        tip = f"pid={st.get('pid')} · 已运行 {int(st.get('uptime') or 0) // 60} 分钟"
        if st.get("last_seen"):
            tip += " · 上次收到 " + _stamp(st["last_seen"])
        if st.get("last_sent"):
            tip += " · 上次发送 " + _stamp(st["last_sent"])
        if not st.get("connected"):
            self.bot_state.setText("后台已启动，正在连接…")
            tip = (st.get("last_error") or "长连接尚未认证") + "\n" + tip
        elif not st.get("chat_known"):
            self.bot_state.setText("已连接，等你给机器人发一条消息")
            tip = "在企业微信里找到机器人发任意一条消息，InfoHub 就能主动推送\n" + tip
        else:
            self.bot_state.setText("已连接 · 已记住会话")
        self.bot_state.setToolTip(tip)

    def tasks_done(self, timeout: int = 1500) -> None:
        for task in list(self._tasks):
            task.wait(timeout)
