from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from voice_refs import list_voice_references, resolve_voice_reference


class VoiceReferenceTests(unittest.TestCase):
    def test_lists_supported_audio_reference_formats(self):
        with TemporaryDirectory() as temp_dir:
            ref_dir = Path(temp_dir)
            (ref_dir / "me.wav").write_bytes(b"wav")
            (ref_dir / "me.txt").write_text("hello", encoding="utf-8")
            (ref_dir / "neurosama.mp3").write_bytes(b"mp3")
            (ref_dir / "ignored.txt").write_text("not a voice", encoding="utf-8")

            voices = list_voice_references(str(ref_dir))

        self.assertEqual(voices, [
            {
                "id": "clone:me",
                "name": "me",
                "format": "wav",
                "has_reference_text": True,
            },
            {
                "id": "clone:neurosama",
                "name": "neurosama",
                "format": "mp3",
                "has_reference_text": False,
            },
        ])

    def test_resolves_bare_voice_name_for_clone_references(self):
        with TemporaryDirectory() as temp_dir:
            ref_dir = Path(temp_dir)
            (ref_dir / "neurosama.mp3").write_bytes(b"mp3")
            (ref_dir / "neurosama.txt").write_text("hello stream", encoding="utf-8")

            resolved = resolve_voice_reference(str(ref_dir), "NEUROSAMA")

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["name"], "neurosama")
        self.assertEqual(resolved["format"], "mp3")
        self.assertEqual(resolved["ref_text"], "hello stream")


if __name__ == "__main__":
    unittest.main()
