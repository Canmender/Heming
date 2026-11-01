"""本地语音转写：sherpa-onnx + SenseVoice，纯 CPU，不联网、不上传音频。

流程分三步，彼此独立：

1. **保原文**：把 QQ 缓存里的 `.amr` 复制到 ``data/media/voice/<md5>.amr``，
   并把 media.path 指到副本，QQ 清缓存也不会丢；
2. **转写**：ffmpeg 解码成 16k 单声道 → SenseVoice 识别，结果写 ``voice_cache``；
3. **回填**：把转写文本写回消息正文（``[语音] 文本``），检索能命中语音内容。

缓存按音频文件名（QQ 的 md5）去重，同一条语音多条转发只识别一次；下次同步
解析消息时会直接查到缓存文本，不会把正文覆盖回 ``[语音] Ns``。
"""

from __future__ import annotations

import array
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from .config import Config
from .models import SyncReport
from .store import Store

MODEL_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODEL_FILE = "model.int8.onnx"
TOKENS_FILE = "tokens.txt"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    f"{MODEL_NAME}.tar.bz2"
)
SAMPLE_RATE = 16000
ENGINE = "sensevoice"


def model_dir(cfg: Config) -> Path:
    voice = cfg.voice or {}
    return Path(voice.get("model_dir") or (cfg.data_dir / "models" / MODEL_NAME))


def model_paths(cfg: Config) -> tuple[Path, Path]:
    root = model_dir(cfg)
    return root / MODEL_FILE, root / TOKENS_FILE


def voice_dir(cfg: Config) -> Path:
    return cfg.data_dir / "media" / "voice"


def ready(cfg: Config) -> bool:
    model, tokens = model_paths(cfg)
    if not (model.is_file() and tokens.is_file()):
        return False
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return True


def _ffmpeg(cfg: Config) -> str:
    configured = str((cfg.voice or {}).get("ffmpeg") or "").strip()
    if configured:
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in ("E:/ffmpeg/bin/ffmpeg.exe", "C:/ffmpeg/bin/ffmpeg.exe"):
        if Path(candidate).is_file():
            return candidate
    return "ffmpeg"


def _is_silk(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            head = fh.read(10)
    except OSError:
        return False
    # QQ 的 .amr 其实是腾讯 SILK，前面可能带一个 0x02 标记
    return head.lstrip(b"\x02").startswith(b"#!SILK")


def _decode_silk(path: Path) -> array.array:
    try:
        import pilk
    except ImportError as exc:
        raise RuntimeError("缺少 pilk（SILK 解码）：pip install pilk") from exc
    fd, pcm = tempfile.mkstemp(suffix=".pcm", prefix="silk_")
    os.close(fd)
    try:
        pilk.decode(str(path), pcm, pcm_rate=SAMPLE_RATE)
        with open(pcm, "rb") as fh:
            raw = fh.read()
    finally:
        try:
            os.unlink(pcm)
        except OSError:
            pass
    shorts = array.array("h")
    shorts.frombytes(raw[: len(raw) // 2 * 2])
    return array.array("f", [s / 32768.0 for s in shorts])


def decode_audio(path: Path, ffmpeg: str) -> array.array:
    if _is_silk(path):
        return _decode_silk(path)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    proc = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-",
        ],
        capture_output=True,
        timeout=180,
        creationflags=flags,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail[:200] or "ffmpeg 解码失败")
    raw = proc.stdout[: len(proc.stdout) // 4 * 4]
    samples = array.array("f")
    samples.frombytes(raw)
    return samples


class Transcriber:
    def __init__(self, cfg: Config):
        import sherpa_onnx

        voice = cfg.voice or {}
        model, tokens = model_paths(cfg)
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(tokens),
            num_threads=int(voice.get("threads", 2)),
            use_itn=True,
            language=str(voice.get("language") or ""),
            debug=False,
        )
        self.ffmpeg = _ffmpeg(cfg)

    def transcribe(self, path: Path) -> str:
        samples = decode_audio(path, self.ffmpeg)
        if len(samples) < SAMPLE_RATE * 0.15:
            return ""
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        self.recognizer.decode_stream(stream)
        return (stream.result.text or "").strip()


def download_model(cfg: Config, progress=None) -> Path:
    """下载 SenseVoice 模型（约 230MB）并解压到 data/models。"""
    progress = progress or (lambda *a, **k: None)
    target = model_dir(cfg)
    model, tokens = model_paths(cfg)
    if model.is_file() and tokens.is_file():
        return target
    root = target.parent
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f"{MODEL_NAME}.tar.bz2"
    progress("下载语音模型", 0, 3)
    subprocess.run(
        ["curl", "-L", "--retry", "2", "--fail", "-o", str(archive), MODEL_URL],
        check=True,
    )
    progress("解压语音模型", 2, 3)
    import tarfile

    with tarfile.open(archive, "r:bz2") as tar:
        tar.extractall(root)
    archive.unlink(missing_ok=True)
    progress("语音模型就绪", 3, 3)
    if not (model.is_file() and tokens.is_file()):
        raise RuntimeError(f"模型解压后缺少 {MODEL_FILE} / {TOKENS_FILE}：{target}")
    return target


def preserve_audio(store: Store, cfg: Config, rows) -> int:
    """把语音原件复制进 data/media/voice，media.path 改指副本。"""
    target = voice_dir(cfg)
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for row in rows:
        src = Path(row["path"])
        key = src.stem.lower()
        if not key:
            continue
        dest = target / f"{key}{src.suffix.lower() or '.amr'}"
        try:
            if src.is_file() and src.resolve() != dest.resolve():
                if not dest.is_file() or dest.stat().st_size != src.stat().st_size:
                    shutil.copy2(src, dest)
        except OSError:
            continue
        if dest.is_file() and Path(row["path"]) != dest:
            store.conn.execute(
                "UPDATE media SET path = ? WHERE message_id = ?",
                (str(dest), int(row["message_id"])),
            )
            moved += 1
    store.conn.commit()
    return moved


def sync_voice(
    store: Store,
    cfg: Config,
    progress=None,
    rebuild: bool = False,
    limit: int = 0,
) -> SyncReport:
    started = time.time()
    progress = progress or (lambda *a, **k: None)
    report = SyncReport(source="voice")
    if not (cfg.voice or {}).get("enabled", True):
        report.elapsed = time.time() - started
        return report

    rows = store.voice_rows()
    report.scanned_files = len(rows)
    if not rows:
        report.elapsed = time.time() - started
        return report

    preserve_audio(store, cfg, rows)
    # path 可能刚被改成副本，重新取一遍
    rows = store.voice_rows()
    cache = store.voice_texts()

    jobs: dict[str, Path] = {}
    for row in rows:
        path = Path(row["path"])
        key = path.stem.lower()
        if not key or not path.is_file():
            continue
        if key in cache and not rebuild:
            report.skipped += 1
            continue
        jobs.setdefault(key, path)
    if limit > 0:
        jobs = dict(list(jobs.items())[:limit])

    if jobs:
        if not ready(cfg):
            store.record_source("voice", "idle", "语音模型未安装（infohub voice --download）")
        else:
            engine = Transcriber(cfg)
            total = len(jobs)
            for index, (key, path) in enumerate(jobs.items(), 1):
                progress(f"语音转写 · {path.name}", index, total)
                try:
                    text = engine.transcribe(path)
                except Exception as exc:  # noqa: BLE001
                    report.errors.append(f"{path.name}: {type(exc).__name__}: {exc}")
                    continue
                if not text:
                    report.errors.append(f"{path.name}: 没有识别出文字")
                    continue
                store.save_voice(key, text, engine=ENGINE, path=str(path))
                cache[key] = text
                report.added += 1

    pairs = []
    for row in rows:
        key = Path(row["path"]).stem.lower()
        text = cache.get(key)
        if not text:
            continue
        content = f"[语音] {text}"
        if (row["content"] or "") != content:
            pairs.append((int(row["id"]), content))
    if pairs:
        store.apply_voice_texts(pairs)
        report.updated = len(pairs)

    status = "partial" if report.errors else "ok"
    detail = f"转写 {len(cache)} 条" + (f"，{len(report.errors)} 个失败" if report.errors else "")
    store.record_source("voice", status, detail)
    report.elapsed = time.time() - started
    return report
