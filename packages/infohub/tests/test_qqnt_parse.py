import os
import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from infohub.sources import qqnt

PAGE = 4096
RESERVE = 48


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field(num: int, value) -> bytes:
    if isinstance(value, int):
        return _varint(num << 3) + _varint(value)
    return _varint((num << 3) | 2) + _varint(len(value)) + value


def _element(kind: int, **fields) -> bytes:
    body = _field(45002, kind)
    for num, value in fields.items():
        body += _field(int(num), value)
    return body


def _message(*elements: bytes) -> bytes:
    return b"".join(_field(40800, el) for el in elements)


class ElementTests(unittest.TestCase):
    def test_text(self):
        raw = _message(_element(1, **{"45101": "明天开班会".encode()}))
        self.assertEqual(qqnt.decode_elements(raw), ("明天开班会", 1, "文本"))

    def test_image_and_file(self):
        image = _message(_element(2, **{"45402": b"a.jpg"}))
        self.assertEqual(qqnt.decode_elements(image), ("[图片]", 3, "图片"))
        doc = _message(_element(3, **{"45402": "策划案.pdf".encode(), "45405": 153600}))
        self.assertEqual(qqnt.decode_elements(doc), ("[文件] 策划案.pdf 150KB", 6, "文件"))

    def test_reply_quote(self):
        quoted = _element(1, **{"45101": "原消息".encode()})
        reply = _element(7, **{"47423": quoted})
        text = _element(1, **{"45101": "收到".encode()})
        self.assertEqual(qqnt.decode_elements(_message(reply, text)), ("[回复] 原消息\n收到", 1, "文本"))

    def test_sticker_and_empty(self):
        sticker = _message(_element(11, **{"80900": "[摸头]".encode()}))
        self.assertEqual(qqnt.decode_elements(sticker), ("[表情] [摸头]", 47, "表情"))
        self.assertIsNone(qqnt.decode_elements(b""))
        self.assertIsNone(qqnt.decode_elements(_message(_element(21, **{"48153": b"x"}))))

    def test_xml_card(self):
        xml = "<msg brief=\"[聊天记录]\"><title>群聊的聊天记录</title></msg>".encode()
        self.assertEqual(qqnt.decode_elements(_message(_element(16, **{"48602": xml}))), ("群聊的聊天记录", 49, "链接"))


class MediaRefTest(unittest.TestCase):
    def test_image_ref(self):
        md5 = bytes.fromhex("ad5016fef2bebf1f9a5dc59441426ae3")
        raw = _message(
            _element(
                2,
                **{
                    "45402": b"AD5016FEF2BEBF1F9A5DC59441426AE3.jpg",
                    "45406": md5,
                    "45411": 405,
                    "45412": 425,
                    "45405": 17411,
                },
            )
        )
        text, code, label, ref = qqnt.decode_message(raw)
        self.assertEqual((text, code, label), ("[图片]", 3, "图片"))
        self.assertEqual(ref.kind, "image")
        self.assertEqual(ref.md5, "ad5016fef2bebf1f9a5dc59441426ae3")
        self.assertEqual((ref.width, ref.height, ref.size), (405, 425, 17411))

    def test_file_ref_and_voice_duration(self):
        doc = _message(
            _element(
                3,
                **{
                    "45402": "策划案.pdf".encode(),
                    "45403": r"::NTOSFull::D:\Work\策划案.pdf".encode(),
                    "45405": 153600,
                },
            )
        )
        text, code, label, ref = qqnt.decode_message(doc)
        self.assertEqual(text, "[文件] 策划案.pdf 150KB")
        self.assertEqual(ref.kind, "file")
        self.assertEqual(ref.path, r"::NTOSFull::D:\Work\策划案.pdf")
        voice = _message(_element(4, **{"45906": 3}))
        self.assertEqual(qqnt.decode_message(voice)[0], "[语音] 3s")

    def test_voice_uses_cached_transcript(self):
        md5 = bytes.fromhex("3314f7a9d322e08d8501d3358d16bdf8")
        voice = _message(_element(4, **{"45406": md5, "45906": 3}))
        text, code, label, ref = qqnt.decode_message(
            voice, {"3314f7a9d322e08d8501d3358d16bdf8": "明天把材料交到班长处"}
        )
        self.assertEqual(text, "[语音] 明天把材料交到班长处")
        self.assertEqual((code, label), (34, "语音"))
        self.assertEqual(ref.md5, "3314f7a9d322e08d8501d3358d16bdf8")


class MediaLocatorTest(unittest.TestCase):
    MD5 = "f57cedfa7badc13ec04dc6f9a1f599f4"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "nt_qq"
        data = self.root / "nt_data"

        def touch(*parts: str) -> Path:
            path = data.joinpath(*parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
            return path

        self.ori = touch("Pic", "2026-10", "Ori", f"{self.MD5}.jpg")
        touch("Pic", "2026-10", "Thumb", f"{self.MD5}_0.jpg")
        self.thumb = touch("Pic", "2026-10", "Thumb", f"{self.MD5}_720.jpg")
        self.emoji = touch("Emoji", "emoji-recv", "2026-10", "Ori", "00ff060552553cbe7e1d4f11fb463a11.jpg")
        self.voice = touch("Ptt", "2026-10", "Ori", "3314f7a9d322e08d8501d3358d16bdf8.amr")
        self.video = touch("Video", "2026-09", "Ori", "73776e0df83abb973889a9cb72e3f35b.mp4")
        self.video_thumb = touch("Video", "2026-09", "Thumb", "73776e0df83abb973889a9cb72e3f35b_0.png")
        self.doc = Path(self.tmp.name) / "策划案.pdf"
        self.doc.write_bytes(b"pdf")
        self.locator = qqnt.MediaLocator(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_prefers_720_thumb(self):
        row = self.locator.resolve(qqnt.MediaRef("image", md5=self.MD5, width=1400, height=1920))
        self.assertEqual(row[0], "image")
        self.assertEqual(Path(row[1]), self.ori)
        self.assertEqual(Path(row[3]), self.thumb)
        self.assertEqual((row[4], row[5]), (1400, 1920))

    def test_emoji_and_ptt(self):
        emoji = self.locator.resolve(qqnt.MediaRef("image", md5="00ff060552553cbe7e1d4f11fb463a11"))
        self.assertEqual(Path(emoji[1]), self.emoji)
        voice = self.locator.resolve(qqnt.MediaRef("voice", md5="3314f7a9d322e08d8501d3358d16bdf8"))
        self.assertEqual(Path(voice[1]), self.voice)
        self.assertEqual(voice[3], "")

    def test_video_and_file(self):
        video = self.locator.resolve(qqnt.MediaRef("video", md5="73776e0df83abb973889a9cb72e3f35b"))
        self.assertEqual(Path(video[1]), self.video)
        self.assertEqual(Path(video[3]), self.video_thumb)
        doc = self.locator.resolve(
            qqnt.MediaRef("file", name="策划案.pdf", path="::NTOSFull::" + str(self.doc))
        )
        self.assertEqual(Path(doc[1]), self.doc)
        self.assertEqual(doc[2], "策划案.pdf")

    def test_missing(self):
        self.assertIsNone(self.locator.resolve(None))
        self.assertIsNone(self.locator.resolve(qqnt.MediaRef("image", md5="deadbeef")))
        self.assertIsNone(self.locator.resolve(qqnt.MediaRef("file", path=r"::NTOSFull::D:\nope.pdf")))



def _encrypt_page(plain: bytes, key: bytes) -> bytes:
    iv = os.urandom(16)
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    body = enc.update(plain[: PAGE - RESERVE]) + enc.finalize()
    return body + iv + b"\x00" * (RESERVE - 16)


def _wal(pages: list[tuple[int, int, bytes]], salt: bytes) -> bytes:
    head = (
        struct.pack(">I", 0x377F0682)
        + struct.pack(">I", 3007000)
        + struct.pack(">I", PAGE)
        + struct.pack(">I", 1)
        + salt
        + b"\x00" * 8
    )
    out = bytearray(head)
    for pageno, commit, page in pages:
        out += struct.pack(">II", pageno, commit) + salt + b"\x00" * 8 + page
    return bytes(out)


class WalTests(unittest.TestCase):
    def test_replay_and_truncate(self):
        key = os.urandom(32)
        salt = os.urandom(8)
        db = b"\x11" * (PAGE * 4)
        new2 = bytes([0x22]) * PAGE
        wal = _wal(
            [
                (2, 0, _encrypt_page(new2, key)),
                (2, 2, _encrypt_page(new2, key)),
                (3, 0, _encrypt_page(b"\x33" * PAGE, key)),
            ],
            salt,
        )
        out = qqnt.apply_wal(db, wal, key, RESERVE)
        self.assertEqual(len(out), PAGE * 2)
        self.assertEqual(out[PAGE:PAGE + PAGE - RESERVE], new2[: PAGE - RESERVE])

    def test_ignores_non_wal(self):
        db = b"\x11" * (PAGE * 2)
        self.assertEqual(qqnt.apply_wal(db, b"junk", os.urandom(32), RESERVE), db)

    def test_salt_mismatch_stops(self):
        key = os.urandom(32)
        wal = _wal([(2, 2, _encrypt_page(b"\x22" * PAGE, key))], os.urandom(8))
        wal = bytearray(wal)
        wal[32 + 8:32 + 16] = os.urandom(8)
        self.assertEqual(
            qqnt.apply_wal(b"\x11" * (PAGE * 2), bytes(wal), key, RESERVE),
            b"\x11" * (PAGE * 2),
        )


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "nt_msg.db"
        con = sqlite3.connect(self.db)
        con.executescript(
            """
            CREATE TABLE nt_uid_mapping_table("48902" TEXT, "1002" INTEGER);
            CREATE TABLE recent_contact_v3_table("40021" TEXT, "40094" TEXT, "40095" TEXT, "40093" TEXT);
            CREATE TABLE c2c_msg_table("40001" INTEGER, "40010" INTEGER, "40020" TEXT,
                "40021" TEXT, "40033" INTEGER, "40050" INTEGER, "40800" BLOB);
            CREATE TABLE group_msg_table("40001" INTEGER, "40010" INTEGER, "40020" TEXT,
                "40021" TEXT, "40033" INTEGER, "40050" INTEGER, "40800" BLOB, "40090" TEXT);
            """
        )
        con.execute("INSERT INTO nt_uid_mapping_table VALUES('u_self', 10001)")
        con.execute("INSERT INTO nt_uid_mapping_table VALUES('u_peer', 20002)")
        con.execute("INSERT INTO recent_contact_v3_table VALUES('u_peer', '对方昵称', '对方备注', '客服')")
        con.execute("INSERT INTO recent_contact_v3_table VALUES('888888', '测试群', '最后发言人', '我的群名片')")
        text = _element(1, **{"45101": "hi".encode()})
        con.execute(
            'INSERT INTO c2c_msg_table VALUES(1, 1, "u_self", "u_peer", 10001, 1000, ?)', (_message(text),)
        )
        con.execute(
            'INSERT INTO c2c_msg_table VALUES(2, 1, "u_peer", "u_peer", 20002, 1001, ?)', (_message(text),)
        )
        con.execute(
            'INSERT INTO group_msg_table VALUES(3, 2, "u_peer", "888888", 20002, 1002, ?, "群名片")',
            (_message(text),),
        )
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_mapping(self):
        bundles = {conv.external_id: (conv, msgs) for conv, msgs in qqnt.read_conversations(self.db, 0, "10001")}
        self.assertEqual(set(bundles), {"qq:private:20002", "qq:group:888888"})
        conv, msgs = bundles["qq:private:20002"]
        self.assertEqual(conv.name, "对方备注")
        self.assertEqual([(m.is_self, m.sender_name) for m in msgs], [(True, "我"), (False, "对方备注")])
        conv, msgs = bundles["qq:group:888888"]
        self.assertEqual(conv.name, "测试群")
        self.assertEqual(msgs[0].sender_name, "群名片")
        self.assertFalse(msgs[0].is_self)


if __name__ == "__main__":
    unittest.main()
