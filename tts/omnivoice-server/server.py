"""
Unified TTS Server — OmniVoice + VieNeu in one process.

One Docker container, one port (8100), switch models via the `model` field.
AIRI just changes the model name in Settings → Speech → Model, no restart needed.

Models available:
  - "omnivoice"  → k2-fsa/OmniVoice (multilingual, non-verbal tags, voice design)
  - "khanhtts"   → kjanh/KhanhTTS-OmniVoice (Vietnamese fine-tune of OmniVoice)
  - "vieneu"     → VieNeu-TTS v2 Standard (Vietnamese specialist, storytelling mode)
  - "vieneu-turbo" → VieNeu-TTS v2 Turbo (CPU-optimized, fastest, lower quality)

All models share the same OpenAI-compatible endpoint: POST /v1/audio/speech

Environment variables:
  TTS_DEFAULT_MODEL   - Model to pre-load at startup. Default: "omnivoice"
  TTS_DEVICE          - "cuda:0", "cpu", etc. Default: "cuda:0"
  TTS_REF_AUDIO       - Path to default reference audio for voice cloning.
  TTS_REF_TEXT        - Transcript of the reference audio (auto-loaded from .txt).
  TTS_NUM_STEPS       - OmniVoice diffusion steps (16=fast, 32=quality). Default: 16
  TTS_VIENEU_EMOTION  - VieNeu emotion mode: "natural" or "storytelling". Default: "natural"
"""

from __future__ import annotations

import io
import os
import time
import logging
from typing import Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-server")

app = FastAPI(title="Unified TTS Server", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Configuration ─────────────────────────────────────────────────────────────

DEFAULT_MODEL = os.environ.get("TTS_DEFAULT_MODEL", "omnivoice")
DEVICE = os.environ.get("TTS_DEVICE", "cuda:0")
REF_AUDIO_PATH = os.environ.get("TTS_REF_AUDIO", "/app/ref/me.wav")
REF_TEXT = os.environ.get("TTS_REF_TEXT", "")
NUM_STEPS = int(os.environ.get("TTS_NUM_STEPS", "16"))
VIENEU_EMOTION = os.environ.get("TTS_VIENEU_EMOTION", "natural")

# ── Model Registry ────────────────────────────────────────────────────────────

MODEL_REGISTRY = {
    "omnivoice": {"type": "omnivoice", "hf_id": "k2-fsa/OmniVoice"},
    "khanhtts": {"type": "omnivoice", "hf_id": "kjanh/KhanhTTS-OmniVoice"},
    "khanhtts-omnivoice": {"type": "omnivoice", "hf_id": "kjanh/KhanhTTS-OmniVoice"},
    "vieneu": {"type": "vieneu", "mode": "standard"},
    "vieneu-standard": {"type": "vieneu", "mode": "standard"},
    "vieneu-turbo": {"type": "vieneu", "mode": "turbo"},
}

# ── Runtime State ─────────────────────────────────────────────────────────────

_active_engine: str = ""  # "omnivoice" or "vieneu"
_active_model_key: str = ""
_omnivoice_instance = None
_vieneu_instance = None


def _unload_current():
    """Offload whatever is currently on GPU to free VRAM."""
    global _omnivoice_instance, _vieneu_instance, _active_engine, _active_model_key

    if _active_engine == "omnivoice" and _omnivoice_instance is not None:
        try:
            _omnivoice_instance.model.to("cpu")
            torch.cuda.empty_cache()
            logger.info("OmniVoice offloaded to CPU")
        except Exception as e:
            logger.warning(f"Failed to offload OmniVoice: {e}")

    elif _active_engine == "vieneu" and _vieneu_instance is not None:
        # VieNeu (GGUF) doesn't have a .to() method; just delete the instance
        try:
            del _vieneu_instance
            _vieneu_instance = None
            torch.cuda.empty_cache()
            logger.info("VieNeu instance released")
        except Exception as e:
            logger.warning(f"Failed to release VieNeu: {e}")

    _active_engine = ""
    _active_model_key = ""


def _load_omnivoice(hf_id: str):
    """Load an OmniVoice-family model onto GPU."""
    global _omnivoice_instance, _active_engine, _active_model_key

    _unload_current()

    logger.info(f"Loading OmniVoice model: {hf_id} on {DEVICE}...")
    from omnivoice import OmniVoice

    _omnivoice_instance = OmniVoice.from_pretrained(
        hf_id,
        device_map=DEVICE,
        dtype=torch.float16,
    )
    _active_engine = "omnivoice"
    _active_model_key = hf_id
    logger.info(f"OmniVoice {hf_id} loaded.")


def _load_vieneu(mode: str):
    """Load a VieNeu-TTS model."""
    global _vieneu_instance, _active_engine, _active_model_key

    _unload_current()

    logger.info(f"Loading VieNeu-TTS mode={mode}...")
    from vieneu import Vieneu

    _vieneu_instance = Vieneu(mode=mode, emotion=VIENEU_EMOTION)
    _active_engine = "vieneu"
    _active_model_key = f"vieneu-{mode}"
    logger.info(f"VieNeu-TTS ({mode}) loaded.")


def _ensure_model(model_key: str):
    """Ensure the requested model is loaded and active on GPU."""
    global _active_model_key

    key = model_key.lower().strip()
    if key not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {key}. Available: {list(MODEL_REGISTRY.keys())}")

    spec = MODEL_REGISTRY[key]

    # Already loaded?
    if spec["type"] == "omnivoice" and _active_engine == "omnivoice" and _active_model_key == spec["hf_id"]:
        return
    if spec["type"] == "vieneu" and _active_engine == "vieneu" and _active_model_key == f"vieneu-{spec['mode']}":
        return

    # Need to load
    if spec["type"] == "omnivoice":
        _load_omnivoice(spec["hf_id"])
    else:
        _load_vieneu(spec["mode"])


# ── Request Schema ────────────────────────────────────────────────────────────

class SpeechRequest(BaseModel):
    model: str = Field(default="omnivoice", description="Model key: omnivoice, khanhtts, vieneu, vieneu-turbo")
    input: str = Field(..., description="Text to synthesize")
    voice: str = Field(default="clone", description="'clone' for ref audio, or voice design instructions")
    response_format: str = Field(default="wav", description="Output: wav, pcm, mp3, flac")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    # Extensions
    num_steps: Optional[int] = Field(default=None, description="OmniVoice diffusion steps")
    ref_audio: Optional[str] = Field(default=None, description="Override ref audio path")
    ref_text: Optional[str] = Field(default=None, description="Override ref text")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global REF_TEXT
    # Load ref text from companion .txt file
    txt_path = REF_AUDIO_PATH.replace(".wav", ".txt")
    if not REF_TEXT and os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            REF_TEXT = f.read().strip()
        logger.info(f"Loaded ref_text: {REF_TEXT[:80]}...")

    # Pre-load default model
    try:
        _ensure_model(DEFAULT_MODEL)
    except Exception as e:
        logger.error(f"Failed to pre-load default model: {e}")


@app.get("/v1/models")
async def list_models():
    return {
        "data": [
            {"id": key, "object": "model", "owned_by": spec.get("hf_id", "vieneu")}
            for key, spec in MODEL_REGISTRY.items()
        ]
    }


@app.post("/v1/audio/speech")
async def create_speech(request: SpeechRequest):
    if not request.input or not request.input.strip():
        raise HTTPException(status_code=400, detail="Input text is empty")

    t0 = time.time()

    try:
        _ensure_model(request.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")

    # Route to the appropriate engine
    spec = MODEL_REGISTRY[request.model.lower().strip()]

    if spec["type"] == "omnivoice":
        audio = _generate_omnivoice(request)
    else:
        audio = _generate_vieneu(request)

    t1 = time.time()
    duration_audio = len(audio) / 24000
    rtf = (t1 - t0) / duration_audio if duration_audio > 0 else 0
    logger.info(f"[{request.model}] {duration_audio:.2f}s audio in {t1-t0:.2f}s (RTF={rtf:.3f})")

    # Encode output
    output_buffer = io.BytesIO()
    fmt = request.response_format.lower()

    if fmt == "pcm":
        pcm = (audio * 32767).astype(np.int16)
        output_buffer.write(pcm.tobytes())
        content_type = "audio/pcm"
    elif fmt == "flac":
        sf.write(output_buffer, audio, 24000, format="FLAC")
        content_type = "audio/flac"
    else:
        # wav (and mp3/opus fallback to wav for simplicity)
        sf.write(output_buffer, audio, 24000, format="WAV", subtype="PCM_16")
        content_type = "audio/wav"

    output_buffer.seek(0)
    return Response(
        content=output_buffer.read(),
        media_type=content_type,
        headers={
            "X-Audio-Duration": f"{duration_audio:.3f}",
            "X-Generation-Time": f"{t1-t0:.3f}",
            "X-RTF": f"{rtf:.4f}",
            "X-Model": request.model,
        },
    )


def _generate_omnivoice(request: SpeechRequest) -> np.ndarray:
    """Generate audio using OmniVoice engine."""
    ref_audio = request.ref_audio or REF_AUDIO_PATH
    ref_text = request.ref_text or REF_TEXT
    instruct = None

    if request.voice and request.voice != "clone":
        instruct = request.voice
        ref_audio = None
        ref_text = None

    kwargs = {
        "text": request.input,
        "num_step": request.num_steps or NUM_STEPS,
        "speed": request.speed,
    }

    if ref_audio and os.path.exists(ref_audio):
        kwargs["ref_audio"] = ref_audio
        if ref_text:
            kwargs["ref_text"] = ref_text
    elif instruct:
        kwargs["instruct"] = instruct

    audio_arrays = _omnivoice_instance.generate(**kwargs)

    if not audio_arrays or len(audio_arrays) == 0:
        raise HTTPException(status_code=500, detail="OmniVoice returned empty audio")

    return np.concatenate(audio_arrays) if len(audio_arrays) > 1 else audio_arrays[0]


def _generate_vieneu(request: SpeechRequest) -> np.ndarray:
    """Generate audio using VieNeu-TTS engine."""
    ref_audio = request.ref_audio or REF_AUDIO_PATH
    ref_text = request.ref_text or REF_TEXT

    kwargs = {"text": request.input}

    # Voice cloning
    if request.voice == "clone" and ref_audio and os.path.exists(ref_audio):
        voice_data = _vieneu_instance.encode_reference(ref_audio)
        kwargs["voice"] = voice_data
        # VieNeu standard mode needs ref_text for cloning; turbo doesn't
        if ref_text and _active_model_key == "vieneu-standard":
            kwargs["ref_text"] = ref_text
    elif request.voice and request.voice != "clone" and request.voice != "default":
        # Try to use as preset voice name
        try:
            voices = _vieneu_instance.list_preset_voices()
            match = next((v for desc, v in voices if v == request.voice or desc == request.voice), None)
            if match:
                kwargs["voice"] = _vieneu_instance.get_preset_voice(match)
        except Exception:
            pass

    audio = _vieneu_instance.infer(**kwargs)

    if audio is None:
        raise HTTPException(status_code=500, detail="VieNeu returned empty audio")

    # VieNeu returns numpy array at 24kHz
    if isinstance(audio, np.ndarray):
        return audio

    # Some versions return bytes or other formats
    return np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32767.0


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "active_engine": _active_engine,
        "active_model": _active_model_key,
        "device": DEVICE,
        "available_models": list(MODEL_REGISTRY.keys()),
    }
