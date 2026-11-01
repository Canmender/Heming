"""QQ NT 本地消息库（nt_msg.db）只读采集。

QQNT 的 *db 文件 = 1024 字节自定义头 + 标准 SQLCipher 页。
密钥由客户端在运行时通过 nt_sqlite3_key_v2 传入，不落盘，只在打开库期间
存在于进程内存里；这里通过只读内存扫描 + 页 1 结构校验把它取出来。
解密后的库只落在临时目录，读完即删；归档进 InfoHub 自己的 archive.db。

全程不注入、不 Hook、不写 QQ 的任何文件，也不产生任何网络行为。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import struct
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from ..models import Conversation, Message, SyncReport
from ..store import _content_hash
from .media import _make_thumb

NT_HEADER = 1024
PAGE_SIZE = 4096
SQLITE_MAGIC = b"SQLite format 3\x00"
# SQLCipher 4 预留 80 字节（16 IV + 64 HMAC），SQLCipher 3 预留 48 字节（20 HMAC 向上取整）
RESERVES = (80, 48)
PAYLOAD_FRACTIONS = b"\x40\x20\x20"
# QQ 把 salt 放在页 1 的密文前，页 1 的 SQLite 头由解密方自己补
NTHDR = NT_HEADER

__all__ = [
    "DbMeta",
    "KeyCapture",
    "find_db",
    "read_meta",
    "verify_key",
    "decrypt_file",
    "decrypt_bytes",
    "apply_wal",
    "materialize",
    "snapshot",
    "capture_key",
    "key_for",
    "decode_elements",
    "sync_nt",
]


@dataclass
class DbMeta:
    path: Path
    size: int
    page_size: int
    pages: int
    salt: bytes

    @property
    def usable(self) -> int:
        return self.size - NT_HEADER


class KeyCapture(RuntimeError):
    pass


def find_db(account: str | None = None, root: Path | None = None) -> Path | None:
    base = root or Path(os.environ.get("USERPROFILE", "")) / "Documents" / "Tencent Files"
    if not base.is_dir():
        return None
    pattern = f"{account}/nt_qq/nt_db/nt_msg.db" if account else "*/nt_qq/nt_db/nt_msg.db"
    hits = sorted(base.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0] if hits else None


def read_meta(path: str | Path) -> DbMeta:
    p = Path(path)
    size = p.stat().st_size
    with open(p, "rb") as f:
        head = f.read(NT_HEADER + PAGE_SIZE)
    if head[:16] != b"SQLite header 3\x00":
        raise ValueError(f"不是 QQNT 数据库：{p}")
    body = head[NT_HEADER:]
    page_size = PAGE_SIZE
    while page_size > 512 and (size - NT_HEADER) % page_size:
        page_size //= 2
    pages = (size - NT_HEADER) // page_size
    return DbMeta(p, size, page_size, pages, body[:16])


def verify_key(page1: bytes, key: bytes, page_size: int = PAGE_SIZE) -> tuple[int, bytes] | None:
    """用页 1 的确定性结构判断密钥是否正确，命中返回 (reserve, 明文页 1 正文)。"""
    blob = page1
    if len(key) != 32 or len(blob) < page_size:
        return None
    for reserve in RESERVES:
        end = page_size - reserve
        ct = blob[16:end]
        iv = blob[end:end + 16]
        if not ct or len(ct) % 16:
            continue
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        pt = dec.update(ct) + dec.finalize()
        if len(pt) < 16:
            continue
        if struct.unpack(">H", pt[0:2])[0] != page_size:
            continue
        if pt[5:8] != PAYLOAD_FRACTIONS:
            continue
        pages = struct.unpack(">I", pt[12:16])[0]
        if not 1 <= pages <= 100_000_000:
            continue
        return reserve, pt
    return None


def decrypt_bytes(blob: bytes, key: bytes, reserve: int, page_size: int = PAGE_SIZE) -> bytes:
    """把 SQLCipher 页还原成普通 SQLite 文件。

    头 20 字节的 reserved 必须保持原值：SQLite 用它定位每页末尾的溢出指针，
    清 0 会让溢出页链错位、报 "database disk image is malformed"。
    """
    pages = (len(blob) - NT_HEADER) // page_size
    out = bytearray()
    for i in range(pages):
        page = blob[NT_HEADER + i * page_size:NT_HEADER + (i + 1) * page_size]
        end = page_size - reserve
        iv = page[end:end + 16]
        dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        if i == 0:
            body = dec.update(page[16:end]) + dec.finalize()
            head = bytearray(SQLITE_MAGIC + body)
            out += head
            out += b"\x00" * (page_size - len(head))
        else:
            body = dec.update(page[:end]) + dec.finalize()
            out += body
            out += b"\x00" * (page_size - len(body))
    return bytes(out)


def decrypt_file(src: str | Path, dst: str | Path, key: bytes, reserve: int) -> Path:
    blob = Path(src).read_bytes()
    meta = read_meta(src)
    if meta.page_size != PAGE_SIZE:
        raise ValueError(f"暂不支持的页大小：{meta.page_size}")
    if not verify_key(blob[NT_HEADER:NT_HEADER + meta.page_size], key, meta.page_size):
        raise ValueError("密钥校验失败")
    Path(dst).write_bytes(decrypt_bytes(blob, key, reserve))
    return Path(dst)


def snapshot(path: str | Path, workdir: str | Path | None = None) -> Path:
    """拷贝一份库文件（含 -wal），避免与 QQ 争用。"""
    p = Path(path)
    dest_dir = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix="qqnt_"))
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / p.name
    shutil.copyfile(p, dest)
    for suffix in ("-wal", "-shm"):
        side = p.with_name(p.name + suffix)
        if side.exists():
            shutil.copyfile(side, dest_dir / side.name)
    return dest


# ---------------------------------------------------------------- wal / plain

WAL_MAGIC = (0x377F0682, 0x377F0683)
WAL_HEADER = 32
FRAME_HEADER = 24


def _decrypt_page(page: bytes, pageno: int, key: bytes, reserve: int, page_size: int) -> bytes:
    end = page_size - reserve
    iv = page[end:end + 16]
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    body = dec.update(page[16:end] if pageno == 1 else page[:end]) + dec.finalize()
    if pageno == 1:
        body = SQLITE_MAGIC + body
    return body + b"\x00" * (page_size - len(body))


def apply_wal(db: bytes, wal: bytes, key: bytes, reserve: int, page_size: int = PAGE_SIZE) -> bytes:
    """把 -wal 里的已提交帧重放到明文库，拿到最新一分钟的消息。"""
    if len(wal) < WAL_HEADER + FRAME_HEADER + page_size:
        return db
    if struct.unpack(">I", wal[0:4])[0] not in WAL_MAGIC:
        return db
    if struct.unpack(">I", wal[8:12])[0] != page_size:
        return db
    salt = wal[16:24]
    frames: list[tuple[int, int, bytes]] = []
    off = WAL_HEADER
    while off + FRAME_HEADER + page_size <= len(wal):
        pageno = struct.unpack(">I", wal[off:off + 4])[0]
        commit = struct.unpack(">I", wal[off + 4:off + 8])[0]
        if wal[off + 8:off + 16] != salt or pageno == 0:
            break
        frames.append((pageno, commit, wal[off + FRAME_HEADER:off + FRAME_HEADER + page_size]))
        off += FRAME_HEADER + page_size
    last = max((i for i, (_, commit, _) in enumerate(frames) if commit), default=-1)
    if last < 0:
        return db
    out = bytearray(db)
    for pageno, _commit, data in frames[:last + 1]:
        start = (pageno - 1) * page_size
        page = _decrypt_page(data, pageno, key, reserve, page_size)
        if pageno == 1 and struct.unpack(">H", page[16:18])[0] != page_size:
            return db
        if start >= len(out):
            out += b"\x00" * (start + page_size - len(out))
        out[start:start + page_size] = page
    limit = frames[last][1] * page_size
    if limit < len(out):
        del out[limit:]
    return bytes(out)


def materialize(db_path: str | Path, workdir: str | Path, key: bytes, reserve: int) -> Path:
    """解密库文件并把 WAL 合进来，产出临时明文库。"""
    meta = read_meta(db_path)
    if meta.page_size != PAGE_SIZE:
        raise ValueError(f"暂不支持的页大小：{meta.page_size}")
    snap = snapshot(db_path, workdir)
    raw = snap.read_bytes()
    if not verify_key(raw[NT_HEADER:NT_HEADER + meta.page_size], key, meta.page_size):
        raise ValueError("密钥校验失败")
    plain = decrypt_bytes(raw, key, reserve, meta.page_size)
    wal = snap.with_name(snap.name + "-wal")
    if wal.exists():
        plain = apply_wal(plain, wal.read_bytes(), key, reserve, meta.page_size)
    dest = Path(workdir) / "nt_msg_plain.db"
    dest.write_bytes(plain)
    return dest


# ---------------------------------------------------------------- key cache

_KEY_CACHE: dict[str, tuple[bytes, int]] = {}


def key_for(meta: DbMeta, timeout: float = 20.0) -> tuple[bytes, int]:
    """解密密钥随登录态存在，进程内缓存；校验失败（QQ 重登）时重新抓取。"""
    cache_key = f"{meta.path}|{meta.salt.hex()}"
    cached = _KEY_CACHE.get(cache_key)
    if cached and verify_key(_page1_bytes(meta), cached[0], meta.page_size):
        return cached
    key, reserve, _how = capture_key(meta, timeout=timeout)
    _KEY_CACHE[cache_key] = (key, reserve)
    return key, reserve


# ---------------------------------------------------------------- memory scan

_PROCESS_VM_READ = 0x0010
_PROCESS_QUERY_INFORMATION = 0x0400
_MEM_COMMIT = 0x1000
_PAGE_GUARD = 0x100
_READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}


class _MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("PartitionId", wt.WORD),
        ("_pad", wt.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("_pad2", wt.DWORD),
    ]


def _kernel32():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = wt.HANDLE
    k.ReadProcessMemory.argtypes = [
        wt.HANDLE,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    return k


def _qq_pids() -> list[int]:
    import psutil

    rows = []
    for proc in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            if (proc.info["name"] or "").lower() == "qq.exe":
                rows.append((proc.info["memory_info"].rss, proc.info["pid"]))
        except Exception:  # noqa: BLE001
            continue
    return [pid for _, pid in sorted(rows, reverse=True)]


def _regions(k, handle):
    addr = 0
    mbi = _MBI()
    while addr < 0x7FFFFFFF_FFFF:
        if not k.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            return
        size = mbi.RegionSize
        if not size:
            return
        if mbi.State == _MEM_COMMIT and (mbi.Protect & 0xFF) in _READABLE and not (mbi.Protect & _PAGE_GUARD):
            yield addr, size
        addr += size


def capture_key(meta: DbMeta, timeout: float = 90.0, interval: float = 0.5) -> tuple[bytes, int, str]:
    """扫描 QQ 进程内存取回数据库密钥；密钥只在 QQ 打开库期间存在，所以需要重试。"""
    if os.name != "nt":
        raise KeyCapture("密钥抓取仅支持 Windows")
    k = _kernel32()
    salt = meta.salt
    page1 = _page1_bytes(meta)
    forms = [salt, bytes(b ^ 0x3A for b in salt), salt.hex().encode(), salt.hex().encode("utf-16-le")]
    deadline = time.time() + timeout
    while time.time() < deadline:
        for pid in _qq_pids():
            handle = k.OpenProcess(_PROCESS_VM_READ | _PROCESS_QUERY_INFORMATION, False, pid)
            if not handle:
                continue
            try:
                for addr, size in _regions(k, handle):
                    buf = ctypes.create_string_buffer(size)
                    got = ctypes.c_size_t(0)
                    if not (
                        k.ReadProcessMemory(handle, ctypes.c_void_p(addr), buf, size, ctypes.byref(got))
                        and got.value
                    ):
                        continue
                    data = buf.raw[: got.value]
                    at = -1
                    for form in forms:
                        at = data.find(form)
                        if at >= 0:
                            break
                    if at < 0:
                        continue
                    ctx = data[max(0, at - 640): at + 640]
                    for off in range(0, len(ctx) - 32):
                        cand = ctx[off:off + 32]
                        if len(set(cand)) < 20:
                            continue
                        hit = verify_key(page1, cand)
                        if hit:
                            return cand, hit[0], f"raw pid={pid}"
                    for m in re.finditer(rb"[0-9a-fA-F]{64}", ctx):
                        cand = bytes.fromhex(m.group().decode())
                        hit = verify_key(page1, cand)
                        if hit:
                            return cand, hit[0], f"hex64 pid={pid}"
                    for m in re.finditer(rb"[ -~]{8,64}", ctx):
                        pw = m.group()
                        for alg in ("sha512", "sha1"):
                            cand = hashlib.pbkdf2_hmac(alg, pw, salt, 4000, 32)
                            hit = verify_key(page1, cand)
                            if hit:
                                return cand, hit[0], f"pbkdf2-{alg} pid={pid}"
            finally:
                k.CloseHandle(handle)
        time.sleep(interval)
    raise KeyCapture("未能在 QQ 进程内存中找到密钥（QQ 是否已登录并打开消息库？）")


def _page1_bytes(db: DbMeta) -> bytes:
    with open(db.path, "rb") as f:
        f.seek(NT_HEADER)
        return f.read(db.page_size)


# ---------------------------------------------------------------- elements

ELEMENT_TEXT = 1
ELEMENT_IMAGE = 2
ELEMENT_FILE = 3
ELEMENT_VOICE = 4
ELEMENT_VIDEO = 5
ELEMENT_FACE = 6
ELEMENT_REPLY = 7
ELEMENT_ARK = 8
ELEMENT_STRUCT = 9
ELEMENT_ARK_JSON = 10
ELEMENT_STICKER = 11
ELEMENT_FLASH = 14
ELEMENT_XML = 16
ELEMENT_TIP = 21

_MSG_COLUMNS_C2C = ("40001", "40010", "40020", "40021", "40033", "40050", "40800")
_MSG_COLUMNS_GROUP = _MSG_COLUMNS_C2C + ("40090",)


@dataclass
class MediaRef:
    """元素里能定位本地文件的线索：md5 / 原始落盘路径 / 尺寸。"""

    kind: str
    name: str = ""
    md5: str = ""
    path: str = ""
    width: int = 0
    height: int = 0
    size: int = 0


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _hex16(value) -> str:
    return value.hex() if isinstance(value, bytes) else ""


def _stem(name: str) -> str:
    return name.rsplit(".", 1)[0].strip().lower()



def _varint(buf: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while i < len(buf):
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7
        if shift > 63:
            break
    raise ValueError("varint 越界")


def _fields(buf: bytes) -> list[tuple[int, int | bytes]]:
    out: list[tuple[int, int | bytes]] = []
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        f, w = key >> 3, key & 7
        if not f or f > 100000:
            raise ValueError("字段号异常")
        if w == 0:
            v, i = _varint(buf, i)
            out.append((f, v))
        elif w == 2:
            n, i = _varint(buf, i)
            if n > len(buf) - i:
                raise ValueError("长度越界")
            out.append((f, buf[i:i + n]))
            i += n
        elif w == 1:
            out.append((f, buf[i:i + 8]))
            i += 8
        elif w == 5:
            out.append((f, buf[i:i + 4]))
            i += 4
        else:
            raise ValueError("不支持的 wire type")
    return out


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if value is None:
        return ""
    return str(value)


def _size_label(size) -> str:
    try:
        n = int(size)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    if n < 1024:
        return f" {n}B"
    if n < 1024 * 1024:
        return f" {n / 1024:.0f}KB"
    return f" {n / 1024 / 1024:.1f}MB"


def _ark_text(value) -> str:
    raw = _text(value).strip()
    if not raw:
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:80]
    if isinstance(data, dict):
        for key in ("prompt", "desc", "title", "summary"):
            item = data.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        items = data.get("items")
        if isinstance(items, list):
            texts = [
                it["txt"].strip()
                for it in items
                if isinstance(it, dict) and isinstance(it.get("txt"), str) and it["txt"].strip()
            ]
            if texts:
                return " ".join(texts)
        meta = data.get("meta")
        if isinstance(meta, dict):
            for item in meta.values():
                if isinstance(item, dict):
                    for key in ("title", "desc", "text"):
                        val = item.get(key)
                        if isinstance(val, str) and val.strip():
                            return val.strip()
    return "[卡片]"


def _xml_text(xml: str) -> str:
    for pattern in (r"<title[^>]*>(.*?)</title>", r'brief="([^"]*)"'):
        m = re.search(pattern, xml, re.S)
        if m:
            import html as _html

            text = _html.unescape(m.group(1)).strip()
            if text:
                return text
    return "[链接卡片]"


def _quote_of(value) -> str:
    """回复元素 47423 里嵌着被引用消息的完整元素，取其中的文本。"""
    if not isinstance(value, bytes):
        return ""
    try:
        nested = dict(_fields(value))
    except ValueError:
        return ""
    return _text(nested.get(45101)).strip()


def decode_elements(raw: bytes) -> tuple[str, int, str] | None:
    """把消息的 elements protobuf 渲染成可读文本 + (type_code, type_label)。"""
    decoded = decode_message(raw)
    return decoded[:3] if decoded else None


def decode_message(
    raw: bytes, voices: dict[str, str] | None = None
) -> tuple[str, int, str, MediaRef | None] | None:
    """voices: 语音 md5 → 转写文本，命中时正文直接带文字，重新同步不会覆盖已转写的内容。"""
    if not raw:
        return None
    try:
        top = _fields(raw)
    except ValueError:
        return None
    parts: list[str] = []
    media: tuple[int, str] | None = None
    ref: MediaRef | None = None
    has_text = False
    for field_id, blob in top:
        if field_id != 40800 or not isinstance(blob, bytes):
            continue
        try:
            elem = dict(_fields(blob))
        except ValueError:
            continue
        kind = elem.get(45002)
        if not isinstance(kind, int):
            continue
        if kind == ELEMENT_TEXT:
            text = _text(elem.get(45101)).strip()
            if text:
                parts.append(text)
                has_text = True
        elif kind == ELEMENT_IMAGE:
            parts.append("[图片]")
            media = media or (3, "图片")
            if ref is None:
                name = _text(elem.get(45402)).strip()
                ref = MediaRef(
                    kind="image",
                    name=name,
                    md5=_hex16(elem.get(45406)) or _stem(name),
                    width=_int(elem.get(45411)),
                    height=_int(elem.get(45412)),
                    size=_int(elem.get(45405)),
                )
        elif kind == ELEMENT_FILE:
            name = _text(elem.get(45402)).strip()
            parts.append(f"[文件] {name}{_size_label(elem.get(45405))}".strip())
            media = media or (6, "文件")
            if ref is None:
                ref = MediaRef(
                    kind="file",
                    name=name,
                    md5=_hex16(elem.get(45406)) or _hex16(elem.get(45407)),
                    path=_text(elem.get(45403)).strip(),
                    size=_int(elem.get(45405)),
                )
        elif kind == ELEMENT_VOICE:
            name = _text(elem.get(45402)).strip()
            md5 = _hex16(elem.get(45406)) or _stem(name)
            speech = _text(elem.get(45923)).strip()
            if not speech and voices and md5:
                speech = (voices.get(md5.lower()) or "").strip()
            seconds = _int(elem.get(45906))
            parts.append(f"[语音] {speech or (f'{seconds}s' if seconds else '')}".strip())
            media = media or (34, "语音")
            if ref is None:
                ref = MediaRef(
                    kind="voice",
                    name=name,
                    md5=md5,
                    size=_int(elem.get(45405)),
                )
        elif kind == ELEMENT_VIDEO:
            parts.append("[视频]")
            media = media or (43, "视频")
            if ref is None:
                name = _text(elem.get(45402)).strip()
                ref = MediaRef(
                    kind="video",
                    name=name,
                    md5=_hex16(elem.get(45406)) or _stem(name),
                    path=_text(elem.get(45403)).strip(),
                    width=_int(elem.get(45411)),
                    height=_int(elem.get(45412)),
                    size=_int(elem.get(45405)),
                )
        elif kind == ELEMENT_FACE:
            name = _text(elem.get(47602)).strip()
            parts.append(f"[表情] {name}".strip())
            media = media or (47, "表情")
        elif kind == ELEMENT_REPLY:
            quote = _quote_of(elem.get(47423))
            if quote:
                parts.append(f"[回复] {quote}")
        elif kind in (ELEMENT_ARK, ELEMENT_ARK_JSON):
            text = _ark_text(elem.get(48271) if kind == ELEMENT_ARK else elem.get(47901))
            if text:
                parts.append(f"[卡片] {text}" if not text.startswith("[") else text)
                media = media or (49, "链接")
        elif kind == ELEMENT_STRUCT:
            parts.append("[消息]")
        elif kind == ELEMENT_STICKER:
            name = _text(elem.get(80900)).strip()
            parts.append(f"[表情] {name}".strip())
            media = media or (47, "表情")
        elif kind == ELEMENT_FLASH:
            title = _text(elem.get(48705)).strip()
            parts.append(f"[闪传] {title}".strip())
            media = media or (6, "文件")
        elif kind == ELEMENT_XML:
            parts.append(_xml_text(_text(elem.get(48602))))
            media = media or (49, "链接")
        elif kind == ELEMENT_TIP:
            continue
    if not parts:
        return None
    code, label = (1, "文本") if has_text else (media or (1, "文本"))
    return "\n".join(parts), code, label, ref


# ---------------------------------------------------------------- media

NTOS_PREFIXES = ("::NTOSFull::", "::NTOS::")
IMAGE_FOLDERS = ("Pic", "Emoji/emoji-recv", "Emoji/personal_emoji")


def _local_file(raw: str) -> Path | None:
    for prefix in NTOS_PREFIXES:
        if raw.startswith(prefix):
            raw = raw[len(prefix):]
            break
    raw = raw.strip()
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_file() else None


class MediaLocator:
    """把 MediaRef 里的 md5 / 原始路径映射到 nt_qq/nt_data 下真实落盘的文件。

    QQNT 的图片/表情存在 `Pic/<月>/Ori`、`Emoji/emoji-recv/<月>/Ori`、
    `Emoji/personal_emoji/Ori`，语音在 `Ptt/<月>/Ori`，视频在 `Video/<月>/Ori`，
    文件名就是内容 md5；收到的文件则落在元素自带的 NTOSFull 路径里。
    """

    def __init__(self, nt_root: str | Path, thumb_dir: str | Path | None = None):
        self.data = Path(nt_root) / "nt_data"
        self.thumb_dir = Path(thumb_dir) if thumb_dir else None
        self._ori: dict[str, dict[str, Path]] = {"image": {}, "voice": {}, "video": {}}
        self._thumb: dict[str, dict[str, Path]] = {}
        self._built = False

    def _scan(self, roots: list[Path], pattern: str) -> dict[str, tuple[int, Path]]:
        best: dict[str, tuple[int, Path]] = {}
        for root in roots:
            if not root.is_dir():
                continue
            for folder in root.rglob(pattern):
                if "Temp" in folder.name:
                    continue
                for path in folder.iterdir():
                    if not path.is_file():
                        continue
                    stem, _, tail = path.stem.partition("_")
                    quality = int(tail) if tail.isdigit() else 0
                    key = stem.lower()
                    if key and (key not in best or quality > best[key][0]):
                        best[key] = (quality, path)
        return best

    def build(self) -> None:
        if self._built:
            return
        self._built = True
        images = [self.data / sub for sub in IMAGE_FOLDERS]
        self._ori["image"] = {
            k: p for k, (_, p) in self._scan(images, "Ori*").items()
        }
        self._thumb = {
            "image": {k: p for k, (_, p) in self._scan(images, "Thumb*").items()},
            "video": {
                k: p
                for k, (_, p) in self._scan([self.data / "Video"], "Thumb*").items()
            },
        }
        self._ori["voice"] = {
            k: p for k, (_, p) in self._scan([self.data / "Ptt"], "Ori*").items()
        }
        self._ori["video"] = {
            k: p for k, (_, p) in self._scan([self.data / "Video"], "Ori*").items()
        }

    def resolve(self, ref: MediaRef | None) -> tuple | None:
        """返回 attach_media 需要的 (kind, path, name, thumb, width, height, size, mtime)。"""
        if ref is None:
            return None
        if ref.kind == "file":
            path = _local_file(ref.path)
            if path is None:
                return None
            stat = path.stat()
            return ("file", str(path), ref.name or path.name, "", 0, 0, stat.st_size, stat.st_mtime)
        self.build()
        md5 = (ref.md5 or _stem(ref.name)).lower()
        if not md5:
            return None
        ori = self._ori.get(ref.kind, {}).get(md5)
        thumb = self._thumb.get(ref.kind, {}).get(md5)
        if ori is None:
            ori = thumb
        if ori is None:
            return None
        width, height = ref.width, ref.height
        if thumb is None and ref.kind == "image" and self.thumb_dir is not None:
            width, height, made = _make_thumb(ori, self.thumb_dir)
            thumb = Path(made) if made else None
        stat = ori.stat()
        return (
            ref.kind,
            str(ori),
            ref.name or ori.name,
            str(thumb or ""),
            width,
            height,
            stat.st_size,
            stat.st_mtime,
        )


# ---------------------------------------------------------------- reader

def _load_uid_map(con: sqlite3.Connection) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for uid, uin in con.execute('SELECT "48902","1002" FROM nt_uid_mapping_table'):
            if uid and uin:
                out[str(uid)] = str(uin)
    except sqlite3.Error:
        pass
    return out


def _load_names(con: sqlite3.Connection) -> tuple[dict[str, str], dict[str, str]]:
    """返回 ({群号: 群名}, {uid: 备注/昵称})。

    recent_contact 里 40090 是最后发言人的群名片、40093 是本人在群里的昵称、
    40094 才是会话名（群名/对方昵称），40095 是对方备注。
    """
    groups: dict[str, str] = {}
    friends: dict[str, str] = {}
    try:
        rows = con.execute(
            'SELECT "40021","40094","40095","40093" FROM recent_contact_v3_table'
        )
        for cid, conv_name, remark, self_card in rows:
            key = str(cid or "")
            if not key:
                continue
            if key.startswith("u_"):
                chosen = next(
                    (
                        str(x).strip()
                        for x in (remark, conv_name)
                        if isinstance(x, str) and x.strip() and x.strip() != "客服"
                    ),
                    "",
                )
                if chosen and key not in friends:
                    friends[key] = chosen
            else:
                chosen = str(conv_name).strip() if isinstance(conv_name, str) else ""
                if chosen and key not in groups:
                    groups[key] = chosen
    except sqlite3.Error:
        pass
    return groups, friends


def _account_of(db: Path) -> str:
    for parent in db.parents:
        if parent.name.isdigit():
            return parent.name
    return ""


def read_conversations(
    plain_db: str | Path,
    since_ts: int = 0,
    account: str = "",
    voices: dict[str, str] | None = None,
) -> list[tuple[Conversation, list[Message]]]:
    con = sqlite3.connect(f"{Path(plain_db).resolve().as_uri()}?mode=ro", uri=True)
    try:
        uid_map = _load_uid_map(con)
        groups, friends = _load_names(con)
        self_uid = next((uid for uid, uin in uid_map.items() if uin == account), "")
        bundles: dict[str, tuple[Conversation, list[Message]]] = {}
        for table, kind in (("c2c_msg_table", "private"), ("group_msg_table", "group")):
            cols = _MSG_COLUMNS_GROUP if kind == "group" else _MSG_COLUMNS_C2C
            sql = (
                f'SELECT {",".join(chr(34) + c + chr(34) for c in cols)} FROM "{table}" '
                f'WHERE "40050" >= ? AND "40010" IN (1, 2) ORDER BY "40050"'
            )
            try:
                rows = con.execute(sql, (int(since_ts),))
            except sqlite3.Error:
                continue
            for row in rows:
                data = dict(zip(cols, row))
                decoded = decode_message(data.get("40800") or b"", voices)
                if decoded is None:
                    continue
                text, code, label, media_ref = decoded
                ts = int(data.get("40050") or 0)
                if ts <= 0:
                    continue
                sender_uid = str(data.get("40020") or "")
                sender_uin = str(data.get("40033") or "")
                is_self = bool((self_uid and sender_uid == self_uid) or (account and sender_uin == account))
                if kind == "group":
                    gid = str(data.get("40021") or "")
                    if not gid:
                        continue
                    name = groups.get(gid) or f"群 {gid}"
                    card = str(data.get("40090") or "").strip()
                    sender_name = card or ("我" if is_self else sender_uin or "成员")
                    ext = f"qq:group:{gid}"
                    meta = {"group_code": gid, "self_uid": self_uid, "self_uin": account, "nt": True}
                else:
                    peer = str(data.get("40021") or "")
                    if not peer:
                        continue
                    name = friends.get(peer) or ("我的设备" if peer == self_uid else peer)
                    sender_name = "我" if is_self else name
                    ext = f"qq:private:{uid_map.get(peer, peer)}"
                    meta = {"peer_uid": peer, "self_uid": self_uid, "self_uin": account, "nt": True}
                msg = Message(
                    external_id=str(data.get("40001") or ""),
                    ts=ts,
                    sender_id=sender_uid or sender_uin,
                    sender_name=sender_name,
                    is_self=is_self,
                    type_code=code,
                    type_label=label,
                    content=text,
                    media=media_ref,
                )
                if not msg.external_id:
                    continue
                entry = bundles.get(ext)
                if entry is None:
                    conv = Conversation(
                        source="qq",
                        account="",
                        external_id=ext,
                        name=name,
                        kind=kind,
                        last_ts=ts,
                        meta=meta,
                    )
                    entry = (conv, [])
                    bundles[ext] = entry
                entry[0].last_ts = max(entry[0].last_ts, ts)
                entry[1].append(msg)
        return list(bundles.values())
    finally:
        con.close()


# ---------------------------------------------------------------- sync

def _fingerprint(db: Path) -> str:
    parts = []
    for suffix in ("", "-wal", "-shm"):
        p = db.with_name(db.name + suffix)
        try:
            st = p.stat()
        except OSError:
            parts.append("-")
            continue
        parts.append(f"{st.st_size}:{st.st_mtime_ns}")
    return "|".join(parts)


def _state(store, source: str) -> dict:
    try:
        row = store.source_states().get(source)
    except Exception:  # noqa: BLE001
        return {}
    if not row:
        return {}
    try:
        return json.loads(row["detail"] or "{}")
    except json.JSONDecodeError:
        return {}


def sync_nt(store, cfg, progress=None, full: bool = False) -> SyncReport:
    started = time.time()
    progress = progress or (lambda *a, **k: None)
    report = SyncReport(source="qq")
    qq = cfg.qq or {}
    db_arg = str(qq.get("nt_db") or "").strip()
    db = Path(db_arg) if db_arg else find_db(str(qq.get("nt_account") or "").strip() or None)
    if db is None or not db.is_file():
        report.errors.append("没有找到 QQNT 消息库（QQ 是否已登录？）")
        store.record_source("qq", "error", report.errors[-1])
        report.elapsed = time.time() - started
        return report

    fp = _fingerprint(db)
    state = _state(store, "qqnt")
    cursor = int(state.get("cursor") or 0)
    if not full and cursor and state.get("fp") == fp:
        report.skipped = 1
        report.conversations = 0
        store.record_source("qqnt", "ok", json.dumps({"cursor": cursor, "fp": fp}))
        store.record_source("qq", "ok", "无变化")
        report.elapsed = time.time() - started
        return report

    since = 0 if (full or not cursor) else max(0, cursor - 3 * 86400)
    account = str(qq.get("nt_account") or "").strip() or _account_of(db)
    timeout = float(qq.get("key_timeout") or 20)
    workdir = Path(tempfile.mkdtemp(prefix="qqnt_"))
    try:
        progress("QQNT · 读取密钥", 1, 4)
        meta = read_meta(db)
        try:
            key, reserve = key_for(meta, timeout=timeout)
        except KeyCapture as exc:
            report.errors.append(str(exc))
            store.record_source("qq", "error", str(exc))
            report.elapsed = time.time() - started
            return report
        progress("QQNT · 解密消息库", 2, 4)
        plain = materialize(db, workdir, key, reserve)
        progress("QQNT · 解析消息", 3, 4)
        bundles = read_conversations(
            plain, since_ts=since, account=account, voices=store.voice_texts()
        )
    except Exception as exc:  # noqa: BLE001
        report.errors.append(f"{type(exc).__name__}: {exc}")
        store.record_source("qq", "error", report.errors[-1])
        report.elapsed = time.time() - started
        return report
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    total = len(bundles)
    newest = cursor
    first_run = not state
    locator = MediaLocator(db.parent.parent, cfg.data_dir / "media" / "thumbs")
    for index, (conv, messages) in enumerate(bundles, 1):
        progress(f"QQNT · {conv.name}", index, max(total, 1))
        messages.sort(key=lambda m: m.ts)
        newest = max(newest, messages[-1].ts if messages else 0)
        old = store.conn.execute(
            "SELECT id, name, message_count FROM conversations "
            "WHERE source = 'qq' AND account = '' AND external_id = ?",
            (conv.external_id,),
        ).fetchone()
        if old is not None:
            if conv.kind == "private" and old["name"] and conv.name != "我的设备":
                conv.name = old["name"]
            if first_run and int(old["message_count"] or 0) <= len(messages):
                # 首次直读时用 NTQQ 全量历史替换旧的导出数据，避免同一条消息两份
                store.conn.execute("DELETE FROM events WHERE conversation_id = ?", (old["id"],))
                store.conn.execute(
                    "DELETE FROM media WHERE message_id IN "
                    "(SELECT id FROM messages WHERE conversation_id = ?)",
                    (old["id"],),
                )
                store.conn.execute("DELETE FROM messages WHERE conversation_id = ?", (old["id"],))
                store.conn.execute(
                    "UPDATE conversations SET message_count = 0 WHERE id = ?", (old["id"],)
                )
                store.conn.commit()
        conv_id = store.upsert_conversation(conv)
        report.conversations += 1
        min_ts = min(m.ts for m in messages)
        max_ts = messages[-1].ts
        existing = store.content_keys(conv_id, min_ts - 1, max_ts + 1)
        fresh = []
        for msg in messages:
            key_tuple = (msg.ts, _content_hash(msg.content))
            if key_tuple in existing:
                continue
            existing.add(key_tuple)
            fresh.append(msg)
        added, _ = store.add_messages(conv_id, fresh)
        report.added += added
        media_items = []
        for msg in messages:
            row = locator.resolve(msg.media)
            if row is not None:
                media_items.append((msg.external_id, *row))
        if media_items:
            store.attach_media(conv_id, media_items)

    progress("QQNT · 完成", 4, 4)
    status = "partial" if report.errors else "ok"
    store.record_source("qqnt", status, json.dumps({"cursor": newest, "fp": fp}))
    store.record_source("qq", status, report.summary() or "无新消息")
    report.elapsed = time.time() - started
    return report
