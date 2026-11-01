from __future__ import annotations

import html
import math
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QSize, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QFont, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QStyle,
    QSystemTrayIcon,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from .. import APP_TITLE
from .. import agent as agent_mod
from .. import daily as daily_mod
from ..agenda import due_label, group_by_day, summary, update_agenda
from ..config import load_config
from ..digest import headline, run as build_digest, to_html, to_text, to_wecom_markdown
from ..kb import export_all
from ..push import FIELD_LABEL
from ..push import configured as push_configured
from ..push import missing as push_missing
from ..push import push as send_push
from ..store import Store
from ..sync import open_store, sync_all
from .agent_dialog import AgentDialog
from .settings import SettingsDialog
from .theme import QSS

WEEK = "一二三四五六日"
SOURCE_LABEL = {"qq": "QQ", "wechat": "微信", "voice": "语音"}
SOURCE_COLOR = {"qq": "#2f6fed", "wechat": "#1f9d63"}
BUBBLE_LINE_CHARS = 50.0
BUBBLE_MAX_PCT = 78


def fmt_time(ts: int) -> str:
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%m-%d %H:%M")
    except (ValueError, OSError):
        return ""


def fmt_day(ts: int) -> str:
    try:
        d = datetime.fromtimestamp(int(ts))
        return f"{d.year}-{d.month:02d}-{d.day:02d} 周{WEEK[d.weekday()]}"
    except (ValueError, OSError):
        return ""


def linkify(text: str) -> str:
    escaped = html.escape(text or "")
    escaped = re.sub(
        r"(https?://[^\s<>\"]+)",
        lambda m: f'<a href="{m.group(1)}" style="color:#2f6fed">{m.group(1)}</a>',
        escaped,
    )
    return escaped.replace("\n", "<br>")


def make_snippet(content: str, query: str, width: int = 90) -> str:
    text = content or ""
    idx = text.lower().find(query.lower()) if query else -1
    if idx < 0:
        return html.escape(text[: width * 2])
    start = max(0, idx - width // 2)
    end = min(len(text), idx + len(query) + width)
    pre = "…" if start > 0 else ""
    post = "…" if end < len(text) else ""
    return (
        html.escape(pre + text[start:idx])
        + "<b>"
        + html.escape(text[idx : idx + len(query)])
        + "</b>"
        + html.escape(text[idx + len(query) : end] + post)
    )


def fts_snippet_html(snippet: str) -> str:
    if "<<" not in snippet or ">>" not in snippet:
        return html.escape(snippet)
    parts = re.split(r"(<<.*?>>)", snippet)
    out = []
    for part in parts:
        if part.startswith("<<") and part.endswith(">>"):
            out.append("<b>" + html.escape(part[2:-2]) + "</b>")
        else:
            out.append(html.escape(part))
    return "".join(out)


_MEDIA_HASH = re.compile(r"^\[(图片|视频|语音|表情):[^\]]+\]$")
_QCE_META_LINE = re.compile(
    r"^\s*(?:提及|资源)\s*[:：].*$|^\s*回复\s*[:：]\s*\d{2}-\d{2}\s+\d{2}:\d{2}.*$"
    r"|^\s*-\s*\w+\s*[:：].*$",
    re.M,
)


def display_content(text: str) -> str:
    s = (text or "").strip()
    lines = [
        ln for ln in _QCE_META_LINE.sub("", s.replace("[回复消息]", "")).splitlines() if ln.strip()
    ]
    body = re.sub(r"\n{2,}", "\n", "\n".join(lines)).strip()
    m = _MEDIA_HASH.match(body)
    if m and "\n" not in body:
        return f"[{m.group(1)}]"
    return body or s


def bubble_width_pct(content: str) -> int:
    units = 0.0
    for ch in content or "":
        units += 0.55 if ord(ch) < 0x2E80 else 1.0
    if units >= BUBBLE_LINE_CHARS:
        return BUBBLE_MAX_PCT
    return max(11, int(math.ceil((units + 3.0) / BUBBLE_LINE_CHARS * BUBBLE_MAX_PCT)))


class ListRow(QWidget):
    def __init__(self, title: str, subtitle: str, badge: str, color: str, detail: str = ""):
        super().__init__()
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(3)

        top = QHBoxLayout()
        top.setSpacing(6)
        self.title = QLabel(title)
        self.title.setStyleSheet("font-size:12px; font-weight:600; color:#1f2329; background:transparent;")
        badge_label = QLabel(badge)
        badge_label.setStyleSheet(
            f"color:{color}; border:1px solid {color}; border-radius:4px;"
            "padding:0px 4px; font-size:9px; background:transparent;"
        )
        badge_label.setFixedHeight(16)
        top.addWidget(self.title, 1)
        if detail:
            detail_label = QLabel(detail)
            detail_label.setStyleSheet("color:#a0a6af; font-size:9px; background:transparent;")
            top.addWidget(detail_label, 0)
        top.addWidget(badge_label, 0)
        layout.addLayout(top)

        self.subtitle = QLabel(subtitle)
        self.subtitle.setStyleSheet("color:#8b929c; font-size:10px; background:transparent;")
        self.subtitle.setTextFormat(Qt.RichText)
        layout.addWidget(self.subtitle)


class SyncWorker(QThread):
    progress = Signal(str, int, int)
    agenda = Signal(object)
    kb_done = Signal(object)
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, cfg, sources, full: bool = False):
        super().__init__()
        self.cfg = cfg
        self.sources = sources
        self.full = full

    def run(self) -> None:
        store = None
        try:
            store = open_store(self.cfg)
            reports = sync_all(
                self.cfg,
                store=store,
                sources=self.sources,
                full=self.full,
                progress=lambda s, i, t: self.progress.emit(s, i, t),
            )
            stats = update_agenda(store, self.cfg)
            if stats:
                self.agenda.emit(stats)
            if (self.cfg.kb or {}).get("auto_export"):
                kb_stats = export_all(
                    self.cfg,
                    store,
                    progress=lambda s, i, t: self.progress.emit(s, i, t),
                )
                self.kb_done.emit(kb_stats)
            self.done.emit(reports)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"{type(exc).__name__}: {exc}")
        finally:
            if store is not None:
                store.close()


class PushWorker(QThread):
    done = Signal(object)

    def __init__(self, cfg, subject, text, html, wecom):
        super().__init__()
        self.cfg = cfg
        self.subject = subject
        self.text = text
        self.html = html
        self.wecom = wecom

    def run(self) -> None:
        self.done.emit(send_push(self.cfg, self.subject, self.text, self.html, self.wecom))


class BotWorker(QThread):
    done = Signal(object)

    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg

    def run(self) -> None:
        from .. import wecom_bot

        try:
            self.done.emit(wecom_bot.ensure_daemon(self.cfg))
        except Exception:  # noqa: BLE001
            self.done.emit(None)


class BriefWorker(QThread):
    """简报要等大模型返回，放到后台线程，避免整点卡界面。"""

    done = Signal(object, str)

    def __init__(self, cfg, store, advance: bool = False, obsidian: bool = False):
        super().__init__()
        self.cfg = cfg
        self.store = store
        self.advance = advance
        self.obsidian = obsidian

    def run(self) -> None:
        try:
            digest = build_digest(
                self.store, self.cfg, advance=self.advance, obsidian=self.obsidian
            )
            self.done.emit(digest, "")
        except Exception as exc:  # noqa: BLE001
            self.done.emit(None, f"{type(exc).__name__}: {exc}")


class NoticeWorker(QThread):
    """每日通知：汇总 → 生成 → 推送，AI 最长要跑两分钟，必须离开主线程。"""

    done = Signal(object, str)

    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg

    def run(self) -> None:
        store = None
        try:
            store = open_store(self.cfg)
            notice = daily_mod.build(store, self.cfg)
            if notice is None:
                today = datetime.now().strftime("%Y-%m-%d")
                daily_mod.save_state(self.cfg, today, "empty", "今天没有可汇总的事务")
                self.done.emit(None, "")
                return
            result = daily_mod.push_notice(self.cfg, notice)
            daily_mod.save_state(
                self.cfg,
                notice.date,
                "sent" if result.ok else "failed",
                f"{result.channel}：{result.detail} · {notice.mode}",
                notice.items,
            )
            self.done.emit(notice, "" if result.ok else f"{result.channel}：{result.detail}")
        except Exception as exc:  # noqa: BLE001
            today = datetime.now().strftime("%Y-%m-%d")
            detail = f"{type(exc).__name__}: {exc}"
            daily_mod.save_state(self.cfg, today, "failed", detail)
            self.done.emit(None, detail)
        finally:
            if store is not None:
                store.close()


class AgentWorker(QThread):
    """智能体后台执行：默认整点流水线，也可只跑一轮 5 分钟同步。"""

    progress = Signal(str)
    done = Signal(object, object, str)

    def __init__(
        self,
        cfg,
        hours: float | None = None,
        plan: list[str] | None = None,
        log: bool = True,
        archive: bool | None = None,
        push: bool | None = None,
    ):
        super().__init__()
        self.cfg = cfg
        self.hours = hours
        self.plan = plan
        self.log = log
        self.archive = archive
        self.push = push

    def run(self) -> None:
        store = None
        try:
            store = open_store(self.cfg)
            run_log = agent_mod.run(
                self.cfg,
                store,
                hours=self.hours,
                plan=self.plan,
                log=self.log,
                archive=self.archive,
                push=self.push,
                progress=lambda text: self.progress.emit(text),
            )
            self.done.emit(run_log, run_log.digest, "")
        except Exception as exc:  # noqa: BLE001
            self.done.emit(None, None, f"{type(exc).__name__}: {exc}")
        finally:
            if store is not None:
                store.close()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.store: Store = open_store(self.cfg)
        self.worker: SyncWorker | None = None
        self.push_worker: PushWorker | None = None
        self.bot_worker: BotWorker | None = None
        self.brief_worker: BriefWorker | None = None
        self.notice_worker: NoticeWorker | None = None
        self._notice_try_ts = 0.0
        self.agent_worker: AgentWorker | None = None
        self.agent_sync_worker: AgentWorker | None = None
        self.agent_dialog: AgentDialog | None = None
        self.agent_retry = 0
        self._agent_manual = False
        self.settings_dialog: SettingsDialog | None = None
        self.manual_sync = False
        self.search_mode = False
        self.agenda_mode = False
        self.brief_mode = False
        self.last_digest = None
        self.tray: QSystemTrayIcon | None = None
        self.agenda_stats: dict | None = None
        self.kb_stats: dict | None = None
        self.current_conv_id: int | None = None
        self.loaded_messages: list = []
        self.oldest_ts: int | None = None
        self.loaded_count = 0
        self.page_size = int((self.cfg.ui or {}).get("page_size", 800))
        self.search_timer = QTimer(self)
        self.search_timer.setSingleShot(True)
        self.search_timer.setInterval(280)
        self.search_timer.timeout.connect(lambda: self.do_search(self.search_edit.text()))

        self.setWindowTitle(APP_TITLE)
        self.resize(1280, 820)
        self.setMinimumSize(960, 600)
        self.setStyleSheet(QSS)
        self._build_ui()
        self._setup_timers()
        self.reload_conversations()
        self.refresh_status()
        if (self.cfg.raw or {}).get("auto_sync_on_start", True):
            QTimer.singleShot(900, lambda: self.start_sync(["qq", "wechat"]))

    # ---------- UI ----------

    def _build_ui(self) -> None:
        central = QWidget()
        outer = QVBoxLayout(central)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        topbar = QFrame()
        topbar.setObjectName("topbar")
        top = QHBoxLayout(topbar)
        top.setContentsMargins(16, 10, 16, 10)
        top.setSpacing(8)

        brand = QLabel("InfoHub")
        brand.setObjectName("brand")
        top.addWidget(brand)

        self.sync_btn = QPushButton("同步全部")
        self.sync_btn.setObjectName("primary")
        self.sync_btn.clicked.connect(lambda: self.start_sync(["qq", "wechat"], manual=True))
        self.wx_btn = QPushButton("同步微信")
        self.wx_btn.clicked.connect(lambda: self.start_sync(["wechat"], manual=True))
        self.qq_btn = QPushButton("同步 QQ")
        self.qq_btn.clicked.connect(lambda: self.start_sync(["qq"], manual=True))
        self.agenda_btn = QPushButton("日程")
        self.agenda_btn.setCheckable(True)
        self.agenda_btn.clicked.connect(self._toggle_agenda)
        top.addWidget(self.sync_btn)
        top.addWidget(self.wx_btn)
        top.addWidget(self.qq_btn)
        top.addWidget(self.agenda_btn)

        self.brief_btn = QPushButton("简报")
        self.brief_btn.setCheckable(True)
        self.brief_btn.setToolTip("最近一小时的新消息、@我、新日程和资源")
        self.brief_btn.clicked.connect(self._toggle_brief)
        top.addWidget(self.brief_btn)

        self.agent_btn = QPushButton("智能体")
        self.agent_btn.setToolTip("整点流水线：同步 → AI 分析 → Obsidian 入库 → 日程 → 企微推送")
        self.agent_btn.clicked.connect(self.open_agent)
        top.addWidget(self.agent_btn)

        self.push_btn = QPushButton("推送到手机")
        self.push_btn.setToolTip("按 config.json 的 push 配置发到企业微信或邮箱")
        self.push_btn.clicked.connect(self.push_current_brief)
        self.push_btn.setVisible(False)
        top.addWidget(self.push_btn)

        top.addStretch(1)

        self.source_combo = QComboBox()
        self.source_combo.addItem("全部来源", None)
        self.source_combo.addItem("QQ", "qq")
        self.source_combo.addItem("微信", "wechat")
        self.source_combo.currentIndexChanged.connect(self._on_source_changed)
        top.addWidget(self.source_combo)

        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("搜索全部消息…")
        self.search_edit.setClearButtonEnabled(True)
        self.search_edit.setMinimumWidth(300)
        self.search_edit.textChanged.connect(self._on_search_text)
        top.addWidget(self.search_edit)

        config_btn = QPushButton("设置")
        config_btn.setToolTip("配置大模型、企业微信推送和本地采集")
        config_btn.clicked.connect(self.open_config)
        top.addWidget(config_btn)

        outer.addWidget(topbar)

        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(0)
        self.left_title = QLabel("会话")
        self.left_title.setObjectName("sectionTitle")
        self.left_title.setContentsMargins(14, 10, 14, 6)
        left_layout.addWidget(self.left_title)
        self.conv_list = QListWidget()
        self.conv_list.setUniformItemSizes(False)
        self.conv_list.setVerticalScrollMode(QListWidget.ScrollPerPixel)
        self.conv_list.itemClicked.connect(self._on_list_click)
        left_layout.addWidget(self.conv_list, 1)
        splitter.addWidget(left)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)

        header = QFrame()
        head_layout = QHBoxLayout(header)
        head_layout.setContentsMargins(20, 12, 20, 10)
        info = QVBoxLayout()
        info.setSpacing(2)
        self.conv_title = QLabel("选择左侧会话开始查看")
        self.conv_title.setObjectName("convTitle")
        self.conv_meta = QLabel("")
        self.conv_meta.setObjectName("convMeta")
        info.addWidget(self.conv_title)
        info.addWidget(self.conv_meta)
        head_layout.addLayout(info, 1)
        self.earlier_btn = QPushButton("加载更早")
        self.earlier_btn.setVisible(False)
        self.earlier_btn.clicked.connect(self.load_earlier)
        head_layout.addWidget(self.earlier_btn, 0)
        right_layout.addWidget(header)

        self.browser = QTextBrowser()
        self.browser.setOpenExternalLinks(True)
        self.browser.setContentsMargins(14, 0, 14, 0)
        self.browser.document().setDefaultStyleSheet(
            "body { background:#ffffff; } a { color:#2f6fed; text-decoration:none; }"
        )
        self.browser.setHtml(self._empty_html())
        right_layout.addWidget(self.browser, 1)
        splitter.addWidget(right)

        splitter.setSizes([320, 960])
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        outer.addWidget(splitter, 1)
        self.setCentralWidget(central)

        status = self.statusBar()
        self.stats_label = QLabel("")
        self.source_label = QLabel("")
        self.bot_label = QLabel("")
        self.progress = QProgressBar()
        self.progress.setFixedWidth(180)
        self.progress.setTextVisible(False)
        self.progress.setVisible(False)
        status.addWidget(self.stats_label)
        status.addPermanentWidget(self.bot_label)
        status.addPermanentWidget(self.source_label)
        status.addPermanentWidget(self.progress)

        shortcut = QShortcut(QKeySequence("Ctrl+F"), self)
        shortcut.activated.connect(self.search_edit.setFocus)

    def _setup_timers(self) -> None:
        qq = self.cfg.qq or {}
        self.qq_timer = QTimer(self)
        interval = max(15, int(qq.get("scan_interval_sec", 60))) * 1000
        self.qq_timer.setInterval(interval)
        self.qq_timer.timeout.connect(lambda: self.start_sync(["qq"]))
        qq_ready = str(qq.get("mode") or "nt").lower() != "qce" or bool(qq.get("export_dir"))
        if qq.get("enabled", True) and qq_ready:
            self.qq_timer.start()

        wx = self.cfg.wechat or {}
        self.wx_timer = QTimer(self)
        self.wx_timer.setInterval(max(5, int(wx.get("sync_interval_min", 30))) * 60 * 1000)
        self.wx_timer.timeout.connect(lambda: self.start_sync(["wechat"]))
        if wx.get("enabled", True):
            self.wx_timer.start()

        ag = self.cfg.agent or {}
        self.agent_sync_timer = QTimer(self)
        self.agent_sync_timer.setInterval(
            max(1, int(ag.get("sync_interval_min", 5))) * 60 * 1000
        )
        self.agent_sync_timer.timeout.connect(self.quick_sync)
        if ag.get("enabled", True):
            self.agent_sync_timer.start()

        dg = self.cfg.digest or {}
        self.brief_timer = QTimer(self)
        self.brief_timer.setInterval(max(5, int(dg.get("interval_min", 60))) * 60 * 1000)
        self.brief_timer.timeout.connect(self.hourly_brief)
        if dg.get("enabled", True):
            self.brief_timer.start()

        self.bot_timer = QTimer(self)
        self.bot_timer.setInterval(60 * 1000)
        self.bot_timer.timeout.connect(self.refresh_bot_status)
        if str((self.cfg.push or {}).get("channel") or "") == "wecom_bot":
            QTimer.singleShot(1500, self.start_bot)
            self.bot_timer.start()

        # 每日通知：每分钟检查一次，过了设定时间且今天没发过才发
        self.notice_timer = QTimer(self)
        self.notice_timer.setInterval(60 * 1000)
        self.notice_timer.timeout.connect(self.check_daily_notice)
        self.notice_timer.start()
        QTimer.singleShot(5000, self.check_daily_notice)

    # ---------- 企微长连接后台 ----------

    def start_bot(self) -> None:
        from .. import wecom_bot

        if not wecom_bot.configured(self.cfg):
            return
        if self.bot_worker is not None and self.bot_worker.isRunning():
            return
        self.bot_worker = BotWorker(self.cfg)
        self.bot_worker.done.connect(self._on_bot_ready)
        self.bot_worker.start()

    def _on_bot_ready(self, st) -> None:
        if not st:
            self.bot_label.setText("企微：后台未启动")
            self.bot_label.setToolTip("推送通道是 wecom_bot，但本地后台没起来")
            return
        self.refresh_bot_status()

    def refresh_bot_status(self) -> None:
        from .. import wecom_bot

        if str((self.cfg.push or {}).get("channel") or "") != "wecom_bot":
            self.bot_label.setText("")
            return
        if not wecom_bot.configured(self.cfg):
            self.bot_label.setText("企微：未填凭据")
            self.bot_label.setToolTip("点右上角「设置」填写 Bot ID 和 Secret")
            return
        st = wecom_bot.status(self.cfg, timeout=0.6)
        if not st or not st.get("ok"):
            self.bot_label.setText("企微：后台离线")
            self.bot_label.setToolTip("运行 `infohub bot` 或在界面重启一次")
            return
        if not st.get("connected"):
            self.bot_label.setText("企微：连接中")
            self.bot_label.setToolTip(st.get("last_error") or "长连接尚未认证")
            return
        if not st.get("chat_known"):
            self.bot_label.setText("企微：待你发消息")
            self.bot_label.setToolTip("企业微信里先给机器人发一条消息，InfoHub 才能主动推给你")
            return
        self.bot_label.setText("企微：已连接")
        tip = ""
        if st.get("last_seen"):
            tip = "上次收到 " + time.strftime("%m-%d %H:%M", time.localtime(int(st["last_seen"])))
        if st.get("last_sent"):
            tip += " · 上次发送 " + time.strftime("%m-%d %H:%M", time.localtime(int(st["last_sent"])))
        self.bot_label.setToolTip(tip.strip(" ·"))

    # ---------- data ----------

    def current_source(self) -> str | None:
        return self.source_combo.currentData()

    def _on_source_changed(self) -> None:
        if self.agenda_mode and not self.search_mode:
            self.show_agenda()
        elif self.brief_mode and not self.search_mode:
            self.show_brief()
        else:
            self.reload_conversations()

    def _toggle_agenda(self, checked: bool) -> None:
        self.agenda_mode = bool(checked)
        self.search_mode = False
        if checked:
            self.brief_btn.setChecked(False)
            self.brief_mode = False
            self.push_btn.setVisible(False)
            self.search_edit.blockSignals(True)
            self.search_edit.clear()
            self.search_edit.blockSignals(False)
            self.show_agenda()
        else:
            self.reload_conversations()

    def _toggle_brief(self, checked: bool) -> None:
        self.brief_mode = bool(checked)
        self.search_mode = False
        self.push_btn.setVisible(self.brief_mode)
        if checked:
            self.agenda_btn.setChecked(False)
            self.agenda_mode = False
            self.search_edit.blockSignals(True)
            self.search_edit.clear()
            self.search_edit.blockSignals(False)
            self.show_brief()
        else:
            self.reload_conversations()

    def show_brief(self, digest=None) -> None:
        self.search_mode = False
        if digest is None:
            if self.brief_worker is not None and self.brief_worker.isRunning():
                return
            self.left_title.setText("简报 · 正在生成…")
            self.conv_list.clear()
            self.conv_title.setText("简报")
            self.conv_meta.setText("正在生成…（启用大模型时会等接口返回）")
            self.browser.setHtml("<p style='color:#8b929c'>正在生成简报…</p>")
            self.brief_worker = BriefWorker(self.cfg, self.store)
            self.brief_worker.done.connect(self._on_show_brief)
            self.brief_worker.start()
            return
        self._render_brief(digest)

    def _on_show_brief(self, digest, error: str) -> None:
        if digest is None:
            self.left_title.setText("简报 · 生成失败")
            self.conv_meta.setText(f"简报生成失败：{error}")
            self.browser.setHtml("<p style='color:#c0392b'>简报生成失败，稍后再试。</p>")
            return
        if self.brief_mode:
            self._render_brief(digest)

    def _render_brief(self, digest) -> None:
        self.last_digest = digest
        self.left_title.setText(f"简报 · {fmt_time(digest.until)}")
        self.conv_list.clear()

        def add_header(text: str) -> None:
            item = QListWidgetItem()
            item.setFlags(Qt.NoItemFlags)
            item.setSizeHint(QSize(10, 28))
            label = QLabel(text)
            label.setContentsMargins(14, 8, 10, 4)
            label.setStyleSheet("color:#8b929c; font-size:10px; font-weight:600; background:transparent;")
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, label)

        def add_row(title: str, subtitle: str, color: str, conv_id: int, message_id: int) -> None:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, ("brief", int(conv_id), int(message_id)))
            widget = ListRow(title, subtitle, "→", color)
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)

        if digest.empty and not digest.upcoming:
            item = QListWidgetItem()
            widget = ListRow("这段时间没有新消息", "整点会自动再生成一版", "", "#999")
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)
        if digest.new_events or digest.mentions or digest.upcoming:
            add_header("要处理")
            for event in digest.new_events[:6]:
                add_row(
                    f"{event['due']}｜{event['title'][:24]}",
                    event["conv"],
                    "#d64545",
                    event["conv_id"],
                    event["message_id"],
                )
            for mention in digest.mentions[:4]:
                add_row(
                    f"@我 {mention['sender']}",
                    mention["text"][:60],
                    "#2f6fed",
                    mention["conv_id"],
                    mention["id"],
                )
            for event in digest.upcoming[:3]:
                add_row(
                    f"24h · {event['due']}｜{event['title'][:16]}",
                    event["conv"],
                    "#8a6d3b",
                    event["conv_id"],
                    event["message_id"],
                )
        if digest.convs:
            add_header("会话动态")
            for conv in digest.convs[:10]:
                add_row(
                    f"{conv['name']} · {conv['count']} 条",
                    conv["last"][:60],
                    SOURCE_COLOR.get(conv["source"], "#666"),
                    conv["id"],
                    conv["last_id"],
                )
        self.conv_title.setText("简报")
        self.conv_meta.setText(headline(digest))
        self.browser.setHtml(to_html(digest))

    # ---------- 5 分钟同步 ----------

    def quick_sync(self) -> None:
        if not (self.cfg.agent or {}).get("enabled", True):
            return
        if self.agent_sync_worker is not None and self.agent_sync_worker.isRunning():
            return
        if self._agent_busy():
            return
        self.agent_sync_worker = AgentWorker(
            self.cfg, plan=["sync"], log=False, archive=False, push=False
        )
        self.agent_sync_worker.done.connect(self._finish_quick_sync)
        self.agent_sync_worker.finished.connect(self._quick_sync_finished)
        self.agent_sync_worker.start()

    def _agent_busy(self) -> bool:
        return any(
            worker is not None and worker.isRunning()
            for worker in (self.worker, self.brief_worker, self.agent_worker)
        )

    def _finish_quick_sync(self, run_log, digest, error: str) -> None:
        if run_log is None:
            self.statusBar().showMessage(f"消息刷新失败：{error}", 8000)
            return
        detail = run_log.steps[0].detail if run_log.steps else ""
        self.statusBar().showMessage(
            f"消息已刷新 · {detail} · {time.strftime('%H:%M')}", 6000
        )
        if self.brief_mode or self.agenda_mode:
            return
        self.reload_conversations()
        if self.current_conv_id:
            self.open_conversation(self.current_conv_id)
        self.refresh_status()

    def _quick_sync_finished(self) -> None:
        if self.agent_sync_worker is not None:
            self.agent_sync_worker.deleteLater()
            self.agent_sync_worker = None

    def hourly_brief(self) -> None:
        if (self.cfg.agent or {}).get("enabled", True):
            self.run_agent()
            return
        if self.worker is not None and self.worker.isRunning():
            return
        if self.brief_worker is not None and self.brief_worker.isRunning():
            return
        self.brief_worker = BriefWorker(self.cfg, self.store, advance=True, obsidian=True)
        self.brief_worker.done.connect(self._finish_hourly_brief)
        self.brief_worker.start()

    # ---------- 每日通知（17:00） ----------

    def check_daily_notice(self, manual: bool = False) -> None:
        opts = self.cfg.notice or {}
        if not opts.get("enabled", True) and not manual:
            return
        if self.notice_worker is not None and self.notice_worker.isRunning():
            return
        now = datetime.now()
        if not manual and now.time() < daily_mod.target_time(self.cfg):
            return
        today = now.strftime("%Y-%m-%d")
        if not manual and daily_mod.done_today(self.cfg, today):
            return
        # 失败后 10 分钟内不重试，避免每分钟烧一次模型调用
        if not manual and time.time() - self._notice_try_ts < 600:
            return
        if not push_configured(self.cfg):
            self.statusBar().showMessage(
                "每日通知到点了，但推送通道还没配置（设置 → 推送）", 10000
            )
            daily_mod.save_state(self.cfg, today, "ready", "推送未配置")
            return
        self._notice_try_ts = time.time()
        self.statusBar().showMessage("每日通知：正在汇总今天要转达的班级事务…", 8000)
        self.notice_worker = NoticeWorker(self.cfg)
        self.notice_worker.done.connect(self._finish_notice)
        self.notice_worker.finished.connect(self._notice_finished)
        self.notice_worker.start()

    def _finish_notice(self, notice, error: str) -> None:
        if error:
            self.statusBar().showMessage(f"每日通知发送失败：{error}", 12000)
            return
        if notice is None:
            self.statusBar().showMessage("每日通知：今天没有需要转达的班级事务", 8000)
            return
        text = f"每日通知已推送：{notice.items} 条（{'AI' if notice.mode == 'ai' else '规则'}）"
        self.statusBar().showMessage(text, 12000)
        if self.tray is not None:
            self.tray.showMessage("InfoHub 每日通知", text, QSystemTrayIcon.Information, 9000)

    def _notice_finished(self) -> None:
        if self.notice_worker is not None:
            self.notice_worker.deleteLater()
            self.notice_worker = None

    # ---------- 小时智能体 ----------

    def open_agent(self) -> None:
        if self.agent_dialog is None:
            self.agent_dialog = AgentDialog(self.cfg, self)
            self.agent_dialog.run_requested.connect(lambda: self.run_agent(manual=True))
        else:
            self.agent_dialog.refresh()
        self.agent_dialog.show()
        self.agent_dialog.raise_()
        self.agent_dialog.activateWindow()

    def run_agent(self, manual: bool = False) -> None:
        if not (self.cfg.agent or {}).get("enabled", True):
            if manual:
                QMessageBox.information(self, "智能体已关闭", "config.json 里 agent.enabled = false。")
            return
        if self.agent_worker is not None and self.agent_worker.isRunning():
            self.statusBar().showMessage("智能体正在运行…", 5000)
            return
        busy = self._agent_busy() or (
            self.agent_sync_worker is not None and self.agent_sync_worker.isRunning()
        )
        if busy:
            if manual:
                self.statusBar().showMessage("正在同步，等这一轮结束再运行智能体", 6000)
            elif self.agent_retry < 5:
                self.agent_retry += 1
                QTimer.singleShot(30_000, self.hourly_brief)
            return
        self.agent_retry = 0
        self._agent_manual = manual
        self.statusBar().showMessage("智能体：同步 → AI 分析 → Obsidian → 日程 → 推送…", 8000)
        self.agent_worker = AgentWorker(self.cfg)
        self.agent_worker.progress.connect(lambda text: self.statusBar().showMessage(text, 5000))
        self.agent_worker.done.connect(self._finish_agent)
        self.agent_worker.finished.connect(self._agent_finished)
        if self.agent_dialog is not None and self.agent_dialog.isVisible():
            self.agent_dialog.set_running(True)
        self.agent_worker.start()

    def _finish_agent(self, run_log, digest, error: str) -> None:
        if self.agent_dialog is not None:
            self.agent_dialog.set_running(False)
            self.agent_dialog.refresh(run_log)
        if run_log is None:
            self.statusBar().showMessage(f"智能体失败：{error}", 10000)
            if getattr(self, "_agent_manual", False):
                QMessageBox.warning(self, "智能体运行失败", error)
            return
        if digest is not None:
            self.last_digest = digest
            if self.brief_mode:
                self._render_brief(digest)
            if self.agenda_mode:
                self.show_agenda()
            else:
                self.reload_conversations()
            self.refresh_status()
        failed = run_log.failed()
        text = f"智能体：{run_log.summary()}"
        if run_log.headline:
            text += f" · {run_log.headline}"
        if failed:
            text += f" · {failed[0].label}失败：{failed[0].detail}"
        self.statusBar().showMessage(text, 12000)

    def _agent_finished(self) -> None:
        if self.agent_worker is not None:
            self.agent_worker.deleteLater()
            self.agent_worker = None
        if self.agent_dialog is not None:
            self.agent_dialog.set_running(False)

    def _finish_hourly_brief(self, digest, error: str) -> None:
        if digest is None:
            self.statusBar().showMessage(f"简报生成失败：{error}", 8000)
            return
        self.last_digest = digest
        if self.brief_mode:
            self._render_brief(digest)
        self.notify(digest)
        push_opts = self.cfg.push or {}
        if push_opts.get("enabled") and push_configured(self.cfg):
            if not digest.empty or push_opts.get("send_empty"):
                self.start_push(digest)
        self.statusBar().showMessage(f"简报 {fmt_time(digest.until)}：{headline(digest)}", 8000)

    def notify(self, digest) -> None:
        if not (self.cfg.digest or {}).get("toast", True):
            return
        if self.tray is None:
            icon = self.style().standardIcon(QStyle.SP_MessageBoxInformation)
            self.tray = QSystemTrayIcon(icon, self)
            self.tray.setToolTip("InfoHub")
            self.tray.show()
        body = to_text(digest)
        if len(body) > 420:
            body = body[:419] + "…"
        self.tray.showMessage("InfoHub 简报", body, QSystemTrayIcon.Information, 9000)

    def push_current_brief(self) -> None:
        if not push_configured(self.cfg):
            miss = "、".join(FIELD_LABEL.get(n, n) for n in push_missing(self.cfg))
            QMessageBox.information(
                self,
                "推送未配置",
                f"还差：{miss}\n\n"
                "点右上角「设置」填写企业微信或邮箱；也可以直接改 config.json。\n"
                "填好后点「测试推送」或运行 `infohub push --test` 自检。",
            )
            return
        if not (self.cfg.push or {}).get("enabled"):
            answer = QMessageBox.question(
                self,
                "推送处于关闭状态",
                "凭据已填好，但 push.enabled = false。要打开推送并发送这一份简报吗？",
            )
            if answer != QMessageBox.Yes:
                return
            push_opts = self.cfg.raw.setdefault("push", {})
            push_opts["enabled"] = True
            self.cfg.save()
        digest = self.last_digest
        if digest is None:
            if self.brief_worker is not None and self.brief_worker.isRunning():
                return
            self.statusBar().showMessage("正在生成简报…", 5000)
            self.brief_worker = BriefWorker(self.cfg, self.store)
            self.brief_worker.done.connect(self._push_ready_brief)
            self.brief_worker.start()
            return
        self.start_push(digest)

    def _push_ready_brief(self, digest, error: str) -> None:
        if digest is None:
            QMessageBox.warning(self, "简报生成失败", error)
            return
        self.last_digest = digest
        if self.brief_mode:
            self._render_brief(digest)
        self.start_push(digest)

    def start_push(self, digest) -> None:
        if self.push_worker is not None and self.push_worker.isRunning():
            return
        subject = "InfoHub 简报 " + datetime.now().strftime("%m-%d %H:%M")
        self.push_worker = PushWorker(
            self.cfg, subject, to_text(digest), to_html(digest), to_wecom_markdown(digest)
        )
        self.push_worker.done.connect(self.on_push_done)
        self.push_worker.finished.connect(self.on_push_finished)
        self.push_worker.start()

    def on_push_done(self, result) -> None:
        self.statusBar().showMessage(
            f"推送[{result.channel}] {'成功' if result.ok else '失败'}：{result.detail}", 10000
        )
        if not result.ok:
            QMessageBox.warning(self, "推送失败", result.detail)

    def on_push_finished(self) -> None:
        if self.push_worker is not None:
            self.push_worker.deleteLater()
            self.push_worker = None

    def show_agenda(self) -> None:
        self.search_mode = False
        now = int(time.time())
        rows = self.store.agenda(now - 30 * 86400, now + 14 * 86400)
        source = self.current_source()
        if source:
            rows = [r for r in rows if r["source"] == source]
        overdue, today, week = summary(rows, now)
        self.left_title.setText(f"日程 · 今天 {today} · 未来 7 天 {week} · 逾期 {overdue}")
        self.conv_list.clear()
        if not rows:
            item = QListWidgetItem()
            widget = ListRow("还没有识别到日程", "同步后自动整理；也可运行 infohub agenda --rebuild", "", "#999")
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)
            return
        today_date = datetime.fromtimestamp(now).date()
        for label, group in group_by_day(rows, now):
            header = QListWidgetItem()
            header.setFlags(Qt.NoItemFlags)
            header.setSizeHint(QSize(10, 30))
            header_label = QLabel(label)
            header_label.setContentsMargins(14, 8, 10, 4)
            header_label.setStyleSheet("color:#8b929c; font-size:10px; font-weight:600; background:transparent;")
            self.conv_list.addItem(header)
            self.conv_list.setItemWidget(header, header_label)
            for row in group:
                item = QListWidgetItem()
                item.setData(
                    Qt.UserRole,
                    ("event", int(row["conversation_id"]), int(row["msg_ts"]), int(row["message_id"])),
                )
                title = row["title"] if len(row["title"]) <= 24 else row["title"][:24] + "…"
                sub = f"{row['conv_name']} · {row['sender_name'] or ''}"
                if not row["sender_name"] or row["sender_name"] == row["conv_name"]:
                    sub = row["conv_name"]
                overdue_row = datetime.fromtimestamp(int(row["due_ts"])).date() < today_date
                badge = SOURCE_LABEL.get(row["source"], row["source"])
                color = "#d64545" if overdue_row else SOURCE_COLOR.get(row["source"], "#666")
                widget = ListRow(title, sub, badge, color, detail=due_label(row))
                item.setSizeHint(widget.sizeHint())
                self.conv_list.addItem(item)
                self.conv_list.setItemWidget(item, widget)

    def reload_conversations(self) -> None:
        if self.search_mode or self.agenda_mode or self.brief_mode:
            return
        keep = self.current_conv_id
        rows = self.store.list_conversations(source=self.current_source())
        self.left_title.setText("会话")
        self.conv_list.clear()
        for row in rows:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, row["id"])
            sub = f"{fmt_time(row['last_ts'])} · {row['message_count']} 条"
            badge = SOURCE_LABEL.get(row["source"], row["source"])
            widget = ListRow(row["name"], sub, badge, SOURCE_COLOR.get(row["source"], "#666"))
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)
            if keep == row["id"]:
                self.conv_list.setCurrentItem(item)
        if self.conv_list.currentRow() < 0 and self.conv_list.count() and keep is None:
            self.conv_list.setCurrentRow(0)
            self._on_list_click(self.conv_list.item(0))
        if not rows:
            self.conv_title.setText("还没有数据")
            self.conv_meta.setText("点击右上角「同步全部」开始采集；QQ 需保持登录，微信需保持客户端运行。")
            self.browser.setHtml(self._empty_html())

    def _on_search_text(self, text: str) -> None:
        self.search_timer.start()

    def do_search(self, text: str) -> None:
        query = text.strip()
        if not query:
            if self.search_mode:
                self.search_mode = False
                if self.agenda_mode:
                    self.show_agenda()
                else:
                    self.reload_conversations()
            return
        self.search_mode = True
        self.left_title.setText(f"搜索结果 · {query}")
        rows = self.store.search(query, limit=300)
        self.conv_list.clear()
        for row in rows:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, ("hit", row["conversation_id"], row["ts"], row["id"]))
            snippet = row["snippet"] or row["content"]
            if "<<" in snippet and ">>" in snippet:
                sub = fts_snippet_html(snippet)
            else:
                sub = make_snippet(row["content"], query)
            badge = SOURCE_LABEL.get(row["source"], row["source"])
            widget = ListRow(
                f"{row['conv_name']} · {row['sender_name'] or ''}",
                sub,
                badge,
                SOURCE_COLOR.get(row["source"], "#666"),
                detail=fmt_time(row["ts"]),
            )
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)
        if not rows:
            item = QListWidgetItem()
            widget = ListRow("没有匹配的消息", "换一个关键词试试", "", "#999")
            item.setSizeHint(widget.sizeHint())
            self.conv_list.addItem(item)
            self.conv_list.setItemWidget(item, widget)

    def _on_list_click(self, item: QListWidgetItem) -> None:
        data = item.data(Qt.UserRole)
        if isinstance(data, tuple) and data:
            if data[0] == "hit":
                self.open_conversation(
                    data[1], highlight_ts=data[2], highlight_id=data[3]
                )
            elif data[0] == "event":
                self.open_conversation(
                    data[1], highlight_ts=data[2], highlight_id=data[3]
                )
            elif data[0] == "brief":
                ts = self.store.message_ts(data[2])
                self.open_conversation(data[1], highlight_ts=ts, highlight_id=data[2])
        elif isinstance(data, int):
            self.open_conversation(data)

    def open_conversation(
        self,
        conv_id: int,
        highlight_ts: int | None = None,
        highlight_id: int | None = None,
    ) -> None:
        row = self.store.get_conversation(conv_id)
        if row is None:
            return
        self.current_conv_id = conv_id
        self.conv_title.setText(row["name"])
        kind = "群聊" if row["kind"] == "group" else "私聊"
        self.conv_meta.setText(
            f"{SOURCE_LABEL.get(row['source'], row['source'])} · {kind} · "
            f"{row['message_count']} 条 · 最近 {fmt_time(row['last_ts'])}"
        )
        messages = self.store.get_messages(conv_id, limit=self.page_size)
        if highlight_ts and (not messages or int(messages[0]["ts"]) > highlight_ts):
            messages = self.store.messages_around(conv_id, highlight_ts)
        self.loaded_messages = messages
        self.loaded_count = len(messages)
        self.oldest_ts = messages[0]["ts"] if messages else None
        self.earlier_btn.setVisible(self.loaded_count < int(row["message_count"] or 0))
        self._render(
            messages, highlight_ts=highlight_ts, highlight_id=highlight_id, at_bottom=True
        )

    def load_earlier(self) -> None:
        if not self.current_conv_id or not self.oldest_ts:
            return
        boundary_id = self.loaded_messages[0]["id"] if self.loaded_messages else None
        older = self.store.get_messages(
            self.current_conv_id, limit=self.page_size, before_ts=self.oldest_ts
        )
        if not older:
            self.earlier_btn.setVisible(False)
            return
        self.loaded_messages = older + self.loaded_messages
        self.loaded_count = len(self.loaded_messages)
        self.oldest_ts = self.loaded_messages[0]["ts"]
        row = self.store.get_conversation(self.current_conv_id)
        self.earlier_btn.setVisible(self.loaded_count < int(row["message_count"] or 0))
        self._render(self.loaded_messages, anchor_id=boundary_id)

    def _render(
        self,
        messages,
        highlight_ts: int | None = None,
        highlight_id: int | None = None,
        anchor_id: int | None = None,
        at_bottom: bool = False,
    ) -> None:
        if not messages:
            self.browser.setHtml(self._empty_html("这个会话还没有消息"))
            return
        conv = self.store.get_conversation(messages[0]["conversation_id"])
        parts = [
            "<html><body style='margin:16px 20px; font-family:\"Microsoft YaHei UI\";'>"
        ]
        if self.loaded_count and conv and self.loaded_count < int(conv["message_count"] or 0):
            parts.append(
                f"<p style='color:#a0a6af; font-size:9pt; text-align:center;'>"
                f"已加载 {self.loaded_count} 条，可点「加载更早」继续</p>"
            )
        last_day = None
        media = self.store.media_for([m["id"] for m in messages])
        for msg in messages:
            day = fmt_day(msg["ts"])
            if day != last_day:
                parts.append(
                    f"<p style='color:#8b929c; font-size:9pt; text-align:center; margin:14px 0 10px 0;'>"
                    f"{day}</p>"
                )
                last_day = day
            sender = html.escape(msg["sender_name"] or "")
            is_system = (msg["type_code"] == 10000) or sender in ("系统消息", "系统")
            shown = display_content(msg["content"])
            content = linkify(shown)
            item = media.get(int(msg["id"]))
            width = bubble_width_pct(shown)
            if item and item["thumb"] and Path(item["thumb"]).is_file():
                shown = f"[{item['kind']}]"
                image_width = min(240, int(item["width"]) or 240)
                if int(item["height"]) > 2 * max(1, int(item["width"])):
                    image_width = min(image_width, 180)
                content = (
                    f"<a href='{Path(item['path']).as_uri()}'>"
                    f"<img src='{Path(item['thumb']).as_uri()}' width='{image_width}'></a>"
                )
                width = min(60, max(14, int(image_width * 100 / 900) + 4))
            elif item and item["path"] and Path(item["path"]).is_file():
                content = (
                    f"<a href='{Path(item['path']).as_uri()}' style='color:#2f6fed'>"
                    f"{html.escape(shown)}</a>"
                )
            if is_system:
                parts.append(
                    f"<p style='color:#8b929c; font-size:9pt; text-align:center; margin:8px 0;'>"
                    f"<a name='m{msg['id']}'></a>{content}</p>"
                )
                continue
            bg = "#e9f1ff" if msg["is_self"] else "#f4f5f7"
            tint = "#2f6fed" if msg["is_self"] else "#8b929c"
            side = "right" if msg["is_self"] else "left"
            bubble = (
                f"<td width='{width}%' bgcolor='{bg}' "
                f"style='padding:9px 12px; font-size:10.5pt; color:#1f2329;'>{content}</td>"
            )
            spacer = f"<td width='{100 - width}%'></td>"
            row = spacer + bubble if msg["is_self"] else bubble + spacer
            parts.append(
                "<table width='100%' cellspacing='0' cellpadding='0' style='margin-bottom:14px;'>"
                f"<tr><td colspan='2'><p style='text-align:{side}; color:{tint}; font-size:9pt;"
                f" margin:0 0 3px 0;'><a name='m{msg['id']}'></a>{sender} · {fmt_time(msg['ts'])}</p>"
                f"</td></tr><tr>{row}</tr></table>"
            )
        parts.append("</body></html>")
        self.browser.setHtml("".join(parts))
        if highlight_id is not None and any(int(m["id"]) == int(highlight_id) for m in messages):
            self.browser.scrollToAnchor(f"m{highlight_id}")
            return
        if highlight_ts:
            target = None
            for msg in messages:
                if msg["ts"] >= highlight_ts:
                    target = msg["id"]
                    break
            if target:
                self.browser.scrollToAnchor(f"m{target}")
                return
        if anchor_id:
            self.browser.scrollToAnchor(f"m{anchor_id}")
            return
        if at_bottom:
            bar = self.browser.verticalScrollBar()
            bar.setValue(bar.maximum())

    def _empty_html(self, message: str = "选择左侧会话，或先执行一次同步") -> str:
        return (
            "<html><body style='font-family:\"Microsoft YaHei UI\";'>"
            "<div style='margin-top:120px; text-align:center; color:#a0a6af;'>"
            f"<p style='font-size:13pt; color:#8b929c;'>{html.escape(message)}</p>"
            "<p style='font-size:10pt;'>微信：保持客户端登录，点「同步微信」<br>"
            "QQ：保持 QQ 登录，点「同步 QQ」即可直读本地消息库</p>"
            "</div></body></html>"
        )

    # ---------- sync ----------

    def start_sync(self, sources: list[str], full: bool = False, manual: bool = False) -> None:
        if self.worker is not None and self.worker.isRunning():
            return
        if self.agent_sync_worker is not None and self.agent_sync_worker.isRunning():
            if manual:
                self.statusBar().showMessage("智能体正在刷新消息，稍后再试", 5000)
            return
        self.manual_sync = manual
        self.agenda_stats = None
        self.kb_stats = None
        self.worker = SyncWorker(self.cfg, sources, full=full)
        self.worker.progress.connect(self.on_progress)
        self.worker.agenda.connect(self.on_agenda_done)
        self.worker.kb_done.connect(self.on_kb_done)
        self.worker.done.connect(self.on_sync_done)
        self.worker.failed.connect(self.on_sync_failed)
        self.worker.finished.connect(self.on_worker_finished)
        self._set_busy(True)
        self.worker.start()

    def _set_busy(self, busy: bool) -> None:
        for btn in (self.sync_btn, self.wx_btn, self.qq_btn, self.agenda_btn):
            btn.setEnabled(not busy)
        self.progress.setVisible(busy)
        if busy:
            self.progress.setRange(0, 0)

    def on_progress(self, stage: str, current: int, total: int) -> None:
        if total > 0:
            self.progress.setRange(0, total)
            self.progress.setValue(min(current, total))
        self.statusBar().showMessage(stage, 5000)

    def on_agenda_done(self, stats) -> None:
        self.agenda_stats = dict(stats)
        self.refresh_status()

    def on_kb_done(self, stats) -> None:
        self.kb_stats = dict(stats or {})
        if self.kb_stats.get("error"):
            self.statusBar().showMessage(f"知识库导出失败：{self.kb_stats['error']}", 8000)

    def on_sync_done(self, reports) -> None:
        parts = []
        errors = []
        for report in reports:
            if report.source == "voice":
                if report.added or report.updated:
                    parts.append(f"语音转写 {report.added} 条")
                errors.extend(report.errors[:3])
                continue
            parts.append(f"{SOURCE_LABEL.get(report.source, report.source)} 新增 {report.added}")
            errors.extend(report.errors[:3])
        if self.agenda_stats:
            parts.append(f"日程 {self.agenda_stats.get('total', 0)} 项")
        if self.kb_stats and self.kb_stats.get("error"):
            parts.append("知识库导出失败")
        elif self.kb_stats:
            notices = self.kb_stats.get("notices") or {}
            media = self.kb_stats.get("media") or {}
            parts.append(f"通知候选 {notices.get('candidates', 0)} 条")
            parts.append(f"资源新增 {media.get('new', 0)} 个")
        self.statusBar().showMessage("同步完成：" + "，".join(parts), 8000)
        if self.agenda_mode:
            self.show_agenda()
        else:
            self.reload_conversations()
        if self.current_conv_id:
            self.open_conversation(self.current_conv_id)
        if self.search_mode:
            self.do_search(self.search_edit.text())
        self.refresh_status()
        if errors and self.manual_sync:
            QMessageBox.warning(self, "同步提示", "\n".join(errors))

    def on_sync_failed(self, message: str) -> None:
        self.statusBar().showMessage("同步失败：" + message, 10000)
        if self.manual_sync:
            QMessageBox.critical(self, "同步失败", message)

    def on_worker_finished(self) -> None:
        self._set_busy(False)
        if self.worker is not None:
            self.worker.deleteLater()
            self.worker = None
        self.refresh_status()

    def refresh_status(self) -> None:
        try:
            stats = self.store.stats()
            events = self.store.event_count()
            transcripts = len(self.store.voice_texts())
        except Exception:  # noqa: BLE001
            return
        self.stats_label.setText(
            f"会话 {stats['conversations']} · 消息 {stats['messages']:,} · 日程 {events}"
            + (f" · 语音转写 {transcripts}" if transcripts else "")
        )
        states = self.store.source_states()
        chunks = []
        for source in ("wechat", "qq"):
            row = states.get(source)
            if row is None:
                chunks.append(f"{SOURCE_LABEL[source]} 未同步")
                continue
            stamp = fmt_time(row["last_run_ts"])
            if row["status"] == "ok":
                chunks.append(f"{SOURCE_LABEL[source]} {stamp} ✓")
            elif row["status"] == "partial":
                chunks.append(f"{SOURCE_LABEL[source]} {stamp} 部分成功")
            else:
                chunks.append(f"{SOURCE_LABEL[source]} {stamp} 失败")
        self.source_label.setText("   ".join(chunks))

    def open_config(self) -> None:
        dlg = SettingsDialog(self.cfg, self)
        dlg.saved.connect(self.on_settings_saved)
        dlg.synced.connect(self.on_settings_synced)
        self.settings_dialog = dlg
        dlg.exec()

    def on_settings_synced(self, ok: bool, detail: str) -> None:
        self.statusBar().showMessage(("✓ " if ok else "✗ ") + detail, 8000)
        QTimer.singleShot(600, self.refresh_bot_status)

    def on_settings_saved(self, bot_syncing: bool = False) -> None:
        from .. import wecom_bot

        channel = str((self.cfg.push or {}).get("channel") or "")
        if channel == "wecom_bot" and wecom_bot.configured(self.cfg):
            if not self.bot_timer.isActive():
                self.bot_timer.start()
            if bot_syncing:
                self.bot_label.setText("企微：正在重启后台…")
            else:
                QTimer.singleShot(500, self.refresh_bot_status)
        else:
            self.bot_timer.stop()
            self.bot_label.setText("")

    def closeEvent(self, event) -> None:
        self.qq_timer.stop()
        self.wx_timer.stop()
        self.brief_timer.stop()
        self.notice_timer.stop()
        if self.tray is not None:
            self.tray.hide()
        if self.settings_dialog is not None:
            self.settings_dialog.tasks_done(1200)
        if self.brief_worker is not None and self.brief_worker.isRunning():
            self.brief_worker.wait(3000)
        if self.notice_worker is not None and self.notice_worker.isRunning():
            self.notice_worker.wait(3000)
        if self.worker is not None and self.worker.isRunning():
            self.worker.wait(3000)
        self.store.close()
        super().closeEvent(event)


def run_app() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("InfoHub")
    app.setFont(QFont("Microsoft YaHei UI", 10))
    window = MainWindow()
    window.show()
    return app.exec()
