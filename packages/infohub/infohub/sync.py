from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable

from .config import Config, ensure_detected_config
from .models import SyncReport
from .sources.qq_qce import import_dir
from .sources.qqnt import find_db, sync_nt
from .sources.wechat import sync_wechat
from .store import Store
from .voice import sync_voice

Progress = Callable[[str, int, int], None]

WECHAT_MISSING = "没有找到微信数据目录，请确认微信已登录并产生过数据"
QQNT_MISSING = "没有找到 QQNT 消息库，请确认 QQ 已登录"
QQ_EXPORT_MISSING = "没有找到 QQ 导出目录，请确认导出目录存在（或改用 QQNT 模式）"


def open_store(cfg: Config) -> Store:
    return Store(cfg.archive_db)


def _missing_report(store: Store, source: str, message: str) -> SyncReport:
    """来源启用但目录没识别到：如实记一条错误，不静默跳过。"""
    report = SyncReport(source=source)
    report.errors.append(message)
    store.record_source(source, "error", message)
    return report


def sync_all(
    cfg: Config,
    store: Store | None = None,
    sources: Iterable[str] = ("qq", "wechat"),
    full: bool = False,
    progress: Progress | None = None,
) -> list:
    own = store is None
    store = store or open_store(cfg)
    progress = progress or (lambda *a, **k: None)
    # 采集前先补齐目录：用户没手填时用自动识别的结果（变更有写回，失败不崩）。
    ensure_detected_config(cfg)
    wanted = {s for s in sources}
    reports = []
    try:
        qq_cfg = cfg.qq or {}
        if "qq" in wanted and qq_cfg.get("enabled", True):
            mode = str(qq_cfg.get("mode") or "nt").lower()
            if mode == "qce":
                export_dir = str(qq_cfg.get("export_dir") or "").strip()
                if not export_dir:
                    reports.append(_missing_report(store, "qq", QQ_EXPORT_MISSING))
                else:
                    progress("扫描 QQ 导出目录…", 0, 1)
                    reports.append(
                        import_dir(store, export_dir, progress=progress, force=full)
                    )
            else:
                nt_db = str(qq_cfg.get("nt_db") or "").strip()
                account = str(qq_cfg.get("nt_account") or "").strip()
                # sync_nt 内部也会自动查找；这里先判一次，好给出可读错误而不是空报告。
                # 手填的路径失效时同样按「未识别」处理，避免只给一句笼统错误。
                if nt_db:
                    found = nt_db if Path(nt_db).is_file() else ""
                else:
                    found = str(find_db(account or None) or "")
                if not found:
                    reports.append(_missing_report(store, "qq", QQNT_MISSING))
                else:
                    progress("读取 QQNT 本地消息库…", 0, 1)
                    reports.append(sync_nt(store, cfg, progress=progress, full=full))
        if "wechat" in wanted and (cfg.wechat or {}).get("enabled", True):
            if not str((cfg.wechat or {}).get("db_dir") or "").strip():
                reports.append(_missing_report(store, "wechat", WECHAT_MISSING))
            else:
                reports.append(sync_wechat(store, cfg, progress=progress, full=full))
        if (cfg.voice or {}).get("enabled", True):
            voice_report = sync_voice(store, cfg, progress=progress)
            if voice_report.scanned_files or voice_report.errors:
                reports.append(voice_report)
    finally:
        if own:
            store.close()
    return reports
