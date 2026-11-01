import os
import struct
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from infohub.sources.qqnt import (
    NT_HEADER,
    PAGE_SIZE,
    SQLITE_MAGIC,
    decrypt_bytes,
    read_meta,
    verify_key,
)

KEY = bytes(range(32))


def _enc(key: bytes, iv: bytes, data: bytes) -> bytes:
    e = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return e.update(data) + e.finalize()


def _plain_pages(count: int, reserve: int) -> list[bytes]:
    pages = []
    for i in range(count):
        body = bytes((7 * i + j) % 251 for j in range(PAGE_SIZE - reserve))
        pages.append(body + b"\x00" * reserve)
    head = bytearray(
        SQLITE_MAGIC + struct.pack(">H", PAGE_SIZE) + b"\x01\x01" + bytes([reserve]) + b"\x40\x20\x20"
    )
    head += struct.pack(">I", 1) + struct.pack(">I", count)
    head += b"\x00" * (PAGE_SIZE - reserve - len(head))
    pages[0] = bytes(head) + b"\x00" * reserve
    return pages


def _encrypt(pages: list[bytes], key: bytes, reserve: int, salt: bytes) -> bytes:
    buf = bytearray(b"SQLite header 3\x00" + b"\x00" * (NT_HEADER - 16))
    end = PAGE_SIZE - reserve
    for i, page in enumerate(pages):
        iv = os.urandom(16)
        pt = page[16:end] if i == 0 else page[:end]
        if i == 0:
            buf += salt
        buf += _enc(key, iv, pt) + iv + b"\x00" * (reserve - 16)
    return bytes(buf)


class QqntCryptoTest(unittest.TestCase):
    def test_roundtrip_both_reserves(self):
        for reserve in (80, 48):
            with self.subTest(reserve=reserve):
                salt = os.urandom(16)
                pages = _plain_pages(4, reserve)
                blob = _encrypt(pages, KEY, reserve, salt)
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "nt_msg.db"
                    path.write_bytes(blob)
                    meta = read_meta(path)
                    self.assertEqual(meta.page_size, PAGE_SIZE)
                    self.assertEqual(meta.pages, 4)
                    self.assertEqual(meta.salt, salt)

                    page1 = blob[NT_HEADER:NT_HEADER + PAGE_SIZE]
                    hit = verify_key(page1, KEY)
                    self.assertIsNotNone(hit)
                    self.assertEqual(hit[0], reserve)
                    self.assertIsNone(verify_key(page1, bytes(32)))
                    self.assertIsNone(verify_key(page1, KEY[::-1]))

                    self.assertEqual(decrypt_bytes(blob, KEY, reserve), b"".join(pages))

    def test_rejects_non_qq_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plain.db"
            path.write_bytes(b"SQLite format 3\x00" + b"\x00" * 5000)
            with self.assertRaises(ValueError):
                read_meta(path)


if __name__ == "__main__":
    unittest.main()
