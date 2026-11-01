from __future__ import annotations

import html
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
)

from .. import agent, kb
from ..config import Config

_STATUS = {
    "ok": ("完成", "#1f9d63"),
    "warn": ("提醒", "#b7791f"),
    "skip": ("跳过", "#8b929c"),
    "error": ("失败", "#d64545"),
}


class AgentDialog(QDialog):
    """查看最近一次流水线并手动触发。"""

    run_requested = Signal()

    def __init__(self, cfg: Config, parent=None):
        super().__init__(parent)
        self.cfg = cfg
        self.setWindowTitle("小时智能体")
        self.resize(620, 480)
        self.setModal(False)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 14)
        lay.setSpacing(8)

        title = QLabel("工作 QQ → 生活微信 → Obsidian → 日程 → 企微")
        title.setStyleSheet("font-size:14px;font-weight:600;")
        lay.addWidget(title)

        hint = QLabel(
            "每 5 分钟自动同步新消息；整点再执行 AI 按来源分析 → 写入 Obsidian → "
            "更新日程/通知 → 推送。手动运行不会改动定时器。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#6b7280;")
        lay.addWidget(hint)

        self.state = QLabel("")
        self.state.setWordWrap(True)
        self.state.setStyleSheet("color:#374151;")
        lay.addWidget(self.state)

        self.browser = QTextBrowser()
        self.browser.setOpenExternalLinks(False)
        self.browser.setStyleSheet("background:#f7f8fa;border:1px solid #e3e6eb;padding:8px;")
        lay.addWidget(self.browser, 1)

        row = QHBoxLayout()
        self.run_btn = QPushButton("立即运行")
        self.run_btn.setObjectName("primary")
        self.run_btn.clicked.connect(self.run_requested.emit)
        self.open_btn = QPushButton("打开归档目录")
        self.open_btn.clicked.connect(self._open_archive)
        self.log_btn = QPushButton("运行日志")
        self.log_btn.clicked.connect(self._open_logs)
        close = QPushButton("关闭")
        close.clicked.connect(self.close)
        row.addWidget(self.run_btn)
        row.addWidget(self.open_btn)
        row.addWidget(self.log_btn)
        row.addStretch(1)
        row.addWidget(close)
        lay.addLayout(row)

        self.refresh()

    def refresh(self, run=None) -> None:
        data = run.to_dict() if hasattr(run, "to_dict") else run
        if data is None:
            data = agent.latest_run(self.cfg)
        if not data:
            self.state.setText("还没有运行记录。整点会自动跑一次，也可以点「立即运行」。")
            self.browser.setHtml("<p style='color:#8b929c'>暂无步骤</p>")
            return
        started = int(data.get("started") or 0)
        when = datetime.fromtimestamp(started).strftime("%m-%d %H:%M:%S") if started else "—"
        ok = data.get("ok")
        self.state.setText(
            f"最近一次 {when} · {'完成' if ok else '有失败'} · {data.get('summary') or ''}"
            + (f" · {data.get('headline')}" if data.get("headline") else "")
        )
        rows = []
        for index, step in enumerate(data.get("steps") or [], 1):
            status = str(step.get("status") or "")
            label, color = _STATUS.get(status, (status, "#374151"))
            seconds = step.get("seconds") or 0
            rows.append(
                f"<p style='margin:4px 0'><b>{index}. {html.escape(str(step.get('label') or step.get('name') or ''))}</b>"
                f" <span style='color:{color}'>{label}</span>"
                f" <span style='color:#9aa1ab'>· {float(seconds):.2f}s</span><br>"
                f"<span style='color:#4b5563'>{html.escape(str(step.get('detail') or ''))}</span></p>"
            )
        self.browser.setHtml("".join(rows) or "<p style='color:#8b929c'>暂无步骤</p>")

    def set_running(self, running: bool) -> None:
        self.run_btn.setEnabled(not running)
        self.run_btn.setText("运行中…" if running else "立即运行")
        if running:
            self.state.setText("正在执行：同步 → AI 分析 → Obsidian → 日程 → 推送…")

    def _open_archive(self) -> None:
        vault = Path((self.cfg.kb or {}).get("vault") or kb.DEFAULT_VAULT)
        path = vault / agent.WORK_SUBDIR
        if not path.is_dir():
            path = vault
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))

    def _open_logs(self) -> None:
        path = agent.runs_dir(self.cfg)
        path.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))
