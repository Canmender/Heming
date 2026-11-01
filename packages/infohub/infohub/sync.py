from __future__ import annotations

from typing import Callable, Iterable

from .config import Config
from .sources.qq_qce import import_dir
from .sources.qqnt import sync_nt
from .sources.wechat import sync_wechat
from .store import Store
from .voice import sync_voice

Progress = Callable[[str, int, int], None]


def open_store(cfg: Config) -> Store:
    return Store(cfg.archive_db)


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
    wanted = {s for s in sources}
    reports = []
    try:
        if "qq" in wanted and (cfg.qq or {}).get("enabled", True):
            if str((cfg.qq or {}).get("mode") or "nt").lower() == "qce":
                progress("扫描 QQ 导出目录…", 0, 1)
                reports.append(
                    import_dir(
                        store,
                        (cfg.qq or {}).get("export_dir", ""),
                        progress=progress,
                        force=full,
                    )
                )
            else:
                progress("读取 QQNT 本地消息库…", 0, 1)
                reports.append(sync_nt(store, cfg, progress=progress, full=full))
        if "wechat" in wanted and (cfg.wechat or {}).get("enabled", True):
            reports.append(sync_wechat(store, cfg, progress=progress, full=full))
        if (cfg.voice or {}).get("enabled", True):
            voice_report = sync_voice(store, cfg, progress=progress)
            if voice_report.scanned_files or voice_report.errors:
                reports.append(voice_report)
    finally:
        if own:
            store.close()
    return reports
