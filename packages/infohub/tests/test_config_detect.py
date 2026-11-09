"""信息目录自动识别（QQ / 微信）与配置写回测试。

所有用例都在 tmp_path 里造目录，并注入候选路径或 monkeypatch 环境变量，
**不扫描本机真实的微信/QQ 目录**：
    cd packages/infohub && python -m pytest tests/test_config_detect.py -q
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from infohub import bridge as bridge_mod
from infohub import config as config_mod
from infohub.config import (
    DEFAULTS,
    Config,
    detect_qq_export_dir,
    detect_qq_nt_db,
    detect_sources,
    detect_wechat_dir,
    ensure_detected_config,
    source_status,
)


def _wechat_tree(root: Path, account: str = "wxid_abc") -> Path:
    """造一个 4.x 风格的微信数据目录，返回含账号目录的那一层。"""
    layer = root / "xwechat_files"
    (layer / account / "db_storage").mkdir(parents=True)
    return layer


def _qq_db(base: Path, account: str, mtime: float | None = None) -> Path:
    db = base / account / "nt_qq" / "nt_db" / "nt_msg.db"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"SQLite header 3\x00")
    if mtime is not None:
        os.utime(db, (mtime, mtime))
    return db


def _raw() -> dict:
    raw = json.loads(json.dumps(DEFAULTS))
    raw["wechat"]["db_dir"] = ""
    raw["qq"]["nt_db"] = ""
    raw["qq"]["nt_account"] = ""
    raw["qq"]["export_dir"] = ""
    return raw


# ---------------------------------------------------------------- 微信


def test_wechat_detects_xwechat_files(tmp_path: Path) -> None:
    layer = _wechat_tree(tmp_path)
    assert detect_wechat_dir([tmp_path / "nope", layer]) == str(layer)


def test_wechat_detects_legacy_wechat_files(tmp_path: Path) -> None:
    layer = tmp_path / "WeChat Files"
    (layer / "wxid_legacy" / "Msg").mkdir(parents=True)
    (layer / "wxid_legacy" / "db_storage").mkdir()
    assert detect_wechat_dir([layer]) == str(layer)


def test_wechat_account_dir_returns_parent(tmp_path: Path) -> None:
    layer = _wechat_tree(tmp_path)
    assert detect_wechat_dir([layer / "wxid_abc"]) == str(layer)


def test_wechat_candidates_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """候选根来自 USERPROFILE / APPDATA，且不碰盘符扫描。"""
    profile = tmp_path / "profile"
    appdata = tmp_path / "appdata"
    layer = profile / "Documents" / "xwechat_files"
    (layer / "wxid_env" / "db_storage").mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(profile))
    monkeypatch.setenv("HOME", str(profile))
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(config_mod, "_drive_candidates", lambda: [])

    assert detect_wechat_dir() == str(layer)
    assert (appdata / "Tencent" / "xwechat_files") in config_mod._wechat_candidates()


def test_wechat_missing_returns_empty(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    assert detect_wechat_dir([tmp_path, tmp_path / "empty"]) == ""


# ---------------------------------------------------------------- QQNT


def test_qqnt_picks_newest_db_and_account(tmp_path: Path) -> None:
    old = _qq_db(tmp_path, "111111", mtime=time.time() - 3600)
    new = _qq_db(tmp_path, "222222", mtime=time.time())
    assert detect_qq_nt_db([tmp_path]) == str(new)
    assert old.is_file()

    detected = detect_sources(qq_roots=[tmp_path])
    assert detected["qq"]["nt_db"] == str(new)
    assert detected["qq"]["nt_account"] == "222222"
    assert detected["qq"]["detected"] is True


def test_qqnt_missing_returns_empty(tmp_path: Path) -> None:
    (tmp_path / "123456").mkdir()
    assert detect_qq_nt_db([tmp_path, tmp_path / "missing"]) == ""


def test_qq_export_dir_missing_returns_empty(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    assert detect_qq_export_dir([tmp_path / "empty"]) == ""


def test_qq_export_dir_detects_html(tmp_path: Path) -> None:
    export = tmp_path / "exports"
    export.mkdir()
    (export / "a.html").write_text("<html></html>", encoding="utf-8")
    assert detect_qq_export_dir([export]) == str(export)


# ---------------------------------------------------------------- detect_sources


def test_detect_sources_empty(tmp_path: Path) -> None:
    detected = detect_sources(
        wechat_candidates=[tmp_path / "nope"],
        qq_roots=[tmp_path],
        export_candidates=[tmp_path / "nope"],
    )
    assert detected["wechat"] == {"db_dir": "", "detected": False}
    assert detected["qq"]["nt_db"] == ""
    assert detected["qq"]["export_dir"] == ""
    assert detected["qq"]["detected"] is False


def test_detect_sources_reports_both_qq_paths(tmp_path: Path) -> None:
    _qq_db(tmp_path, "333333")
    export = tmp_path / "exports"
    export.mkdir()
    (export / "chat.txt").write_text("hi", encoding="utf-8")

    detected = detect_sources(
        wechat_candidates=[tmp_path / "nope"],
        qq_roots=[tmp_path],
        export_candidates=[export],
    )
    # QQNT 优先，但导出目录状态也如实返回
    assert detected["qq"]["detected"] is True
    assert detected["qq"]["export_detected"] is True
    assert detected["qq"]["export_dir"] == str(export)


# ---------------------------------------------------------------- 配置写回


def test_ensure_detected_config_writes_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    layer = _wechat_tree(tmp_path / "wx")
    db = _qq_db(tmp_path / "qq", "444444")
    export = tmp_path / "exports"
    export.mkdir()
    (export / "x.html").write_text("x", encoding="utf-8")
    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: str(layer))
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: str(db))
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: str(export))

    path = tmp_path / "config.json"
    cfg = Config(raw=_raw(), path=path)

    assert ensure_detected_config(cfg) is True
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["wechat"]["db_dir"] == str(layer)
    assert written["qq"]["nt_db"] == str(db)
    assert written["qq"]["nt_account"] == "444444"
    assert written["qq"]["export_dir"] == str(export)

    # 第二次调用没有变更：不再写盘（内容/时间戳都不动）。
    before = path.read_text(encoding="utf-8")
    assert ensure_detected_config(cfg) is False
    assert path.read_text(encoding="utf-8") == before


def test_ensure_detected_config_keeps_user_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: "D:/detected/wx")
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: "D:/detected/nt.db")
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: "D:/detected/qq")

    raw = _raw()
    raw["wechat"]["db_dir"] = "C:/mine/wx"
    cfg = Config(raw=raw, path=tmp_path / "config.json")

    assert ensure_detected_config(cfg) is True  # QQ 两项还是空的
    assert cfg.raw["wechat"]["db_dir"] == "C:/mine/wx"
    assert cfg.raw["qq"]["nt_db"] == "D:/detected/nt.db"


def test_ensure_detected_config_never_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "config.json"
    target.mkdir()  # 路径是目录：原子写必然失败
    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: "")
    cfg = Config(raw=_raw(), path=target)
    # 检测函数返回空 → 不写盘
    assert ensure_detected_config(cfg) is False

    # 强制产生变更，写盘失败也必须只回 False，不抛异常
    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: "D:/x")
    assert ensure_detected_config(cfg) is False
    assert cfg.raw["wechat"]["db_dir"] == "D:/x"


def test_source_status_uses_configured_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: "")
    layer = _wechat_tree(tmp_path)
    cfg = Config(raw=_raw(), path=tmp_path / "config.json")
    cfg.raw["wechat"]["db_dir"] = str(layer)
    cfg.raw["wechat"]["enabled"] = True
    cfg.raw["qq"]["enabled"] = True

    status = source_status(cfg)
    assert status["wechat"] == {"db_dir": str(layer), "detected": True}
    assert status["qq"]["detected"] is False


# ---------------------------------------------------------------- 采集前兜底

def test_sync_all_reports_missing_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """来源启用但目录没识别到：report 里要有明确 errors，不静默跳过。"""
    from infohub import sync as sync_mod
    from infohub.store import Store

    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: "")
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: "")
    monkeypatch.setattr(sync_mod, "find_db", lambda *a, **k: None)

    raw = _raw()
    raw["data_dir"] = str(tmp_path / "data")
    raw["voice"]["enabled"] = False
    cfg = Config(raw=raw, path=tmp_path / "config.json")
    store = Store(cfg.archive_db)
    try:
        reports = sync_mod.sync_all(cfg, store=store, sources=("qq", "wechat"))
    finally:
        store.close()

    by_source = {report.source: report for report in reports}
    assert sync_mod.QQNT_MISSING in by_source["qq"].errors
    assert sync_mod.WECHAT_MISSING in by_source["wechat"].errors


# ---------------------------------------------------------------- Bridge 方法
def test_bridge_config_detect_returns_sources_and_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    layer = _wechat_tree(tmp_path / "wx")
    db = _qq_db(tmp_path / "qq", "555555")
    path = tmp_path / "config.json"
    cfg = Config(raw=_raw(), path=path)

    monkeypatch.setattr(config_mod, "detect_wechat_dir", lambda *a, **k: str(layer))
    monkeypatch.setattr(config_mod, "detect_qq_nt_db", lambda *a, **k: str(db))
    monkeypatch.setattr(config_mod, "detect_qq_export_dir", lambda *a, **k: "")
    monkeypatch.setattr(bridge_mod, "load_config", lambda create=True: cfg)
    monkeypatch.setattr(
        bridge_mod,
        "detect_sources",
        lambda: {
            "wechat": {"db_dir": str(layer), "detected": True},
            "qq": {
                "nt_db": str(db),
                "nt_account": "555555",
                "export_dir": "",
                "export_detected": False,
                "detected": True,
            },
        },
    )

    result = bridge_mod.Bridge().config_detect({})
    assert result["applied"] is True
    assert result["sources"]["qq"]["nt_account"] == "555555"
    assert result["summary"]["wechat"]["detected"] is True
    assert result["summary"]["qq"]["detected"] is True
    assert result["summary"]["qq"]["ntDb"] == str(db)
    assert result["summary"]["autoSyncOnStart"] is True
    # 不得泄露任何口令/密钥字段
    assert "smtp_pass" not in json.dumps(result, ensure_ascii=False)
    assert "api_key" not in json.dumps(result, ensure_ascii=False)
