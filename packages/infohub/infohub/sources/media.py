from __future__ import annotations

import hashlib
import re
from pathlib import Path

IMAGE_PLACEHOLDER = re.compile(r"^\[(?:图片|视频|语音|表情):([^\]\n]+)\]")
FILE_PLACEHOLDER = re.compile(r"^\[文件:([^\]\n]+)\]")

THUMB_MAX_EDGE = 480
THUMB_QUALITY = 82

PREVIEW_MAX_EDGE = 1600
PREVIEW_QUALITY = 80
# 小图重压后往往反而更大，低于这个体积且不超尺寸就直接沿用原图
PREVIEW_SKIP_BYTES = 200 * 1024
PREVIEW_SKIP_SUFFIX = {".gif", ".svg", ".ico"}


def _image_keys(filename: str) -> list[str]:
    stem = filename.rsplit(".", 1)[0]
    keys = [stem.lower()]
    if "_" in stem:
        head, _, tail = stem.partition("_")
        keys.extend([head.lower(), tail.lower()])
    return [k for k in keys if k]


def _make_thumb(path: Path, thumb_dir: Path) -> tuple[int, int, str]:
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QImageReader
    except ImportError:
        return 0, 0, ""
    reader = QImageReader(str(path))
    reader.setAutoTransform(True)
    image = reader.read()
    if image.isNull():
        return 0, 0, ""
    width, height = image.width(), image.height()
    thumb_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(str(path).lower().encode("utf-8")).hexdigest()[:16]
    dest = thumb_dir / f"{digest}.jpg"
    if not dest.exists() or dest.stat().st_mtime < path.stat().st_mtime:
        scaled = image.scaled(
            THUMB_MAX_EDGE,
            THUMB_MAX_EDGE,
            Qt.KeepAspectRatio,
            Qt.SmoothTransformation,
        )
        if not scaled.save(str(dest), "JPG", THUMB_QUALITY):
            return width, height, ""
    return width, height, str(dest)


def make_preview(path: Path, preview_dir: Path) -> Path | None:
    """把图片压成 ≤1600px 的 JPEG 预览，用于知识库归档。

    命中缓存（预览比原图新）直接返回；压缩后反而更大、动图、无法解码时返回 None，
    调用方继续用原图。预览按源路径哈希命名，源文件改了才会重做。
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    path = Path(path)
    if path.suffix.lower() in PREVIEW_SKIP_SUFFIX:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    preview_dir = Path(preview_dir)
    digest = hashlib.md5(str(path).lower().encode("utf-8")).hexdigest()[:16]
    dest = preview_dir / f"{digest}.jpg"
    try:
        if dest.is_file() and dest.stat().st_mtime >= stat.st_mtime:
            return dest
    except OSError:
        pass
    preview_dir.mkdir(parents=True, exist_ok=True)
    tmp = preview_dir / f"{digest}.tmp"
    try:
        with Image.open(path) as im:
            if getattr(im, "n_frames", 1) > 1:
                return None
            width, height = im.size
            if width <= 0 or height <= 0:
                return None
            if max(width, height) <= PREVIEW_MAX_EDGE and stat.st_size <= PREVIEW_SKIP_BYTES:
                return None
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                canvas = Image.new("RGB", im.size, (255, 255, 255))
                canvas.paste(im, mask=im.split()[-1])
                im = canvas
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.LANCZOS)
            im.save(tmp, "JPEG", quality=PREVIEW_QUALITY, optimize=True, progressive=True)
        if tmp.stat().st_size >= stat.st_size:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(dest)
    except (OSError, ValueError, Image.DecompressionBombError):
        tmp.unlink(missing_ok=True)
        return None
    return dest


class MediaIndex:
    """把 `[图片:xxx.jpg]` / `[文件:yyy.pdf]` 映射到 QCE 落盘的真实文件。"""

    def __init__(self, export_dir: str | Path, thumb_dir: str | Path):
        self.root = Path(export_dir)
        self.thumb_dir = Path(thumb_dir)
        self.images: dict[str, Path] = {}
        self.files: dict[str, Path] = {}
        self._built = False

    def build(self) -> None:
        self._built = True
        for sub, table in (("images", self.images), ("files", self.files)):
            folder = self.root / "resources" / sub
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                if not path.is_file():
                    continue
                if sub == "images":
                    for key in _image_keys(path.name):
                        table.setdefault(key, path)
                else:
                    name = path.name.partition("_")[2] or path.name
                    table.setdefault(name.lower(), path)
                    table.setdefault(path.name.lower(), path)

    def resolve(self, content: str, make_thumb: bool = True) -> tuple | None:
        if not content:
            return None
        text = content.strip()
        match = IMAGE_PLACEHOLDER.match(text)
        if match:
            return self._resolve_image(match.group(1), make_thumb)
        match = FILE_PLACEHOLDER.match(text)
        if match:
            return self._resolve_file(match.group(1))
        return None

    def _resolve_image(self, token: str, make_thumb: bool) -> tuple | None:
        if not self._built:
            self.build()
        token = token.strip()
        candidates = [token.lower()]
        candidates.extend(_image_keys(token))
        path = next((self.images[k] for k in candidates if k in self.images), None)
        if path is None:
            return None
        width = height = 0
        thumb = ""
        if make_thumb:
            width, height, thumb = _make_thumb(path, self.thumb_dir)
        stat = path.stat()
        return ("image", str(path), path.name, thumb, width, height, stat.st_size, stat.st_mtime)

    def _resolve_file(self, name: str) -> tuple | None:
        if not self._built:
            self.build()
        name = name.strip()
        path = self.files.get(name.lower())
        if path is None:
            lowered = name.lower()
            path = next((p for k, p in self.files.items() if k.endswith(lowered)), None)
        if path is None:
            return None
        stat = path.stat()
        return ("file", str(path), name, "", 0, 0, stat.st_size, stat.st_mtime)
