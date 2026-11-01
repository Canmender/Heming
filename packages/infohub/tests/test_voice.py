import tempfile
import unittest
from pathlib import Path

from infohub import voice
from infohub.config import Config
from infohub.models import Conversation, Message
from infohub.store import Store

KEY = "3314f7a9d322e08d8501d3358d16bdf8"


class VoiceCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "a.db")
        self.cfg = Config(
            raw={
                "data_dir": str(self.root),
                "voice": {"enabled": True, "model_dir": str(self.root / "no-model")},
            }
        )
        self.conv_id = self.store.upsert_conversation(
            Conversation(source="qq", account="", external_id="qq:group:1", name="金融2601班群", kind="group")
        )
        self.audio = self.root / "nt" / f"{KEY}.amr"
        self.audio.parent.mkdir()
        self.audio.write_bytes(b"amr-bytes")
        self.store.add_messages(
            self.conv_id,
            [
                Message(
                    external_id="m1",
                    ts=1000,
                    sender_name="叶老师",
                    content="[语音] 3s",
                    type_code=34,
                    type_label="语音",
                )
            ],
        )
        self.store.attach_media(
            self.conv_id, [("m1", "voice", str(self.audio), "voice.amr", "", 0, 0, 9, 0.0)]
        )
        self.message_id = int(
            self.store.conn.execute("SELECT id FROM messages WHERE external_id = 'm1'").fetchone()[0]
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def media_row(self):
        return self.store.media_for([self.message_id])[self.message_id]

    def test_preserves_audio_even_without_model(self):
        report = voice.sync_voice(self.store, self.cfg)
        copy = self.root / "media" / "voice" / f"{KEY}.amr"
        self.assertTrue(copy.is_file())
        self.assertEqual(Path(self.media_row()["path"]), copy)
        self.assertEqual(report.scanned_files, 1)
        self.assertEqual(report.added, 0)
        self.assertEqual(report.errors, [])

    def test_transcript_fills_message_and_is_idempotent(self):
        self.store.save_voice(KEY, "明天把材料交到班长处", engine="test")
        report = voice.sync_voice(self.store, self.cfg)
        self.assertEqual(report.updated, 1)
        content = self.store.conn.execute(
            "SELECT content FROM messages WHERE id = ?", (self.message_id,)
        ).fetchone()[0]
        self.assertEqual(content, "[语音] 明天把材料交到班长处")

        again = voice.sync_voice(self.store, self.cfg)
        self.assertEqual(again.updated, 0)
        self.assertEqual(again.skipped, 1)

    def test_voice_texts_lookup(self):
        self.store.save_voice(KEY, "收到", engine="test")
        self.assertEqual(self.store.voice_texts(), {KEY: "收到"})


if __name__ == "__main__":
    unittest.main()
