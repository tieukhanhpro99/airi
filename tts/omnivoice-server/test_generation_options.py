import unittest
from types import SimpleNamespace

from generation_options import build_omnivoice_generation_kwargs


class GenerationOptionsTest(unittest.TestCase):
    def test_builds_omnivoice_kwargs_from_openai_compatible_extensions(self):
        request = SimpleNamespace(
            input="Hello",
            speed=1.1,
            num_steps=32,
            language="en",
            guidance_scale=3.0,
            position_temperature=1.0,
            class_temperature=None,
            preprocess_prompt=False,
            postprocess_output=True,
            denoise=False,
            audio_chunk_duration=None,
            audio_chunk_threshold=None,
        )

        self.assertEqual(build_omnivoice_generation_kwargs(request, 16), {
            "text": "Hello",
            "num_step": 32,
            "speed": 1.1,
            "language": "en",
            "guidance_scale": 3.0,
            "position_temperature": 1.0,
            "preprocess_prompt": False,
            "postprocess_output": True,
            "denoise": False,
        })


if __name__ == "__main__":
    unittest.main()
