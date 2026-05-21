"""
OmniVoice OpenAI-compatible TTS server.

Supports both k2-fsa/OmniVoice (base) and kjanh/KhanhTTS-OmniVoice (VN fine-tune).
Switch models at runtime via the `model` field in the request body.

Endpoint: POST /v1/audio/speech
Compatible with AIRI's OpenAI-compatible speech provider.

Environment variables:
  OMNIVOICE_DEFAULT_MODEL  - HuggingFace model ID to load at startup.
                             Default: "k2-fsa/OmniVoice"
  OMNIVOICE_DEVICE         - "cuda:0", "cpu", etc. Default: "cuda:0"
  OMNIVOICE_REF_AUDIO      - Path to default reference audio for voice cloning.
  OMNIVOICE_REF_TEXT       - Transcript of the reference audio.
  OMNIVOICE_NUM_STEPS      - Diffusion steps (16=fast, 32=quality). Default: 16
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
logger = logging.getLogger("omnivoice-server")

app = FastAPI(title="OmniVoice TTS Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Configuration ─────────────────────────────────────────────────────────────

DEFAULT_MODEL = os.environ.get("OMNIVOICE_DEFAULT_MODEL", "k2-fsa/OmniVoice")
DEVICE = os.environ.get("OMNIVOICE_DEVICE", "cuda:0")
REF_AUDIO_PATH = os.environ.get("OMNIVOICE_REF_AUDIO", "/app/ref/me.wav")
REF_TEXT = os.environ.get("OMNIVOICE_REF_TEXT", "")
NUM_STEPS = int(os.environ.get("OMNIVOICE_NUM_STEPS", "16"))

# Known model aliases for convenience. Users can also pass full HF model IDs.
MODEL_ALIASES = {
    "omnivoice": "k2-fsa/OmniVoice",
    "khanhtts": "kjanh/KhanhTTS-OmniVoice",
    "khanhtts-omnivoice": "kjanh/KhanhTTS-OmniVoice",
}

# ── Model cache ───────────────────────────────────────────────────────────────
# We keep loaded models in memory so switching back doesn't require re-download.
# On 8GB VRAM only 1 model fits comfortably; the other gets offloaded to CPU RAM
# (32GB available) and swapped back on demand.

_models: dict[str, object] = {}
_active_model_id: str = ""


def _resolve_model_id(name: str) -> str:
    """Resolve alias or pass through as HuggingFace ID."""
    lower = name.lower().strip()
    return MODEL_ALIASES.get(lower, name)


def _get_model(model_id: str):
    """Load or retrieve a cached OmniVoice model."""
    global _active_model_id

    resolved = _resolve_model_id(model_id)

    if resolved in _models:
        model = _models[resolved]
        # Move to GPU if it was offloaded
        if _active_model_id != resolved:
            logger.info(f"Swapping active model to {resolved}")
            # Offload current active to CPU
            if _active_model_id and _active_model_id in _models:
                try:
                    _models[_active_model_id].model.to("cpu")
                    torch.cuda.empty_cache()
                except Exception:
                    pass
            # Move requested to GPU
            try:
                model.model.to(DEVICE)
            except Exception:
                pass
            _active_model_id = resolved
        return model

    # First load
    logger.info(f"Loading model: {resolved} on {DEVICE}...")
    from omnivoice import OmniVoice

    # Offload current active first
    if _active_model_id and _active_model_id in _models:
        try:
            _models[_active_model_id].model.to("cpu")
            torch.cuda.empty_cache()
        except Exception:
            pass

    model = OmniVoice.from_pretrained(
        resolved,
        device_map=DEVICE,
        dtype=torch.float16,
    )
    _models[resolved] = model
    _active_model_id = resolved
    logger.info(f"Model {resolved} loaded successfully.")
    return model


# ── Request / Response schemas ────────────────────────────────────────────────

class SpeechRequest(BaseModel):
    """OpenAI-compatible /v1/audio/speech request body."""
    model: str = Field(default="omnivoice", description="Model ID or alias (omnivoice, khanhtts)")
    input: str = Field(..., description="Text to synthesize")
    voice: str = Field(default="clone", description="Voice ID. 'clone' uses ref audio, or pass voice design instructions.")
    response_format: str = Field(default="mp3", description="Output format: mp3, wav, pcm, opus, flac, aac")
    speed: float = Field(default=1.0, ge=0.25, le=4.0, description="Speed factor")
    # Extensions (non-OpenAI standard but useful for AIRI)
    num_steps: Optional[int] = Field(default=None, description="Diffusion steps override (16=fast, 32=quality)")
    ref_audio: Optional[str] = Field(default=None, description="Path to reference audio (overrides server default)")
    ref_text: Optional[str] = Field(default=None, description="Transcript of reference audio")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    """Pre-load the default model so first request is fast."""
    try:
        _get_model(DEFAULT_MODEL)
        # Load ref text from file if not set via env
        global REF_TEXT
        if not REF_TEXT and os.path.exists(REF_AUDIO_PATH.replace(".wav", ".txt")):
            with open(REF_AUDIO_PATH.replace(".wav", ".txt"), "r", encoding="utf-8") as f:
                REF_TEXT = f.read().strip()
            logger.info(f"Loaded ref_text from file: {REF_TEXT[:80]}...")
    except Exception as e:
        logger.error(f"Failed to pre-load model: {e}")


@app.get("/v1/models")
async def list_models():
    """List available models (for AIRI provider model listing)."""
    return {
        "data": [
            {"id": "omnivoice", "object": "model", "owned_by": "k2-fsa"},
            {"id": "khanhtts", "object": "model", "owned_by": "kjanh"},
        ]
    }


@app.post("/v1/audio/speech")
async def create_speech(request: SpeechRequest):
    """Generate speech from text. OpenAI-compatible endpoint."""
    if not request.input or not request.input.strip():
        raise HTTPException(status_code=400, detail="Input text is empty")

    t0 = time.time()

    try:
        model = _get_model(request.model)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")

    # Resolve voice mode
    ref_audio = request.ref_audio or REF_AUDIO_PATH
    ref_text = request.ref_text or REF_TEXT
    instruct = None

    if request.voice and request.voice != "clone":
        # Treat voice field as voice design instruction if it's not "clone"
        # e.g. "female, young, high pitch" or a preset voice name
        instruct = request.voice
        ref_audio = None
        ref_text = None

    # Generate
    try:
        generate_kwargs = {
            "text": request.input,
            "num_step": request.num_steps or NUM_STEPS,
            "speed": request.speed,
        }

        if ref_audio and os.path.exists(ref_audio):
            generate_kwargs["ref_audio"] = ref_audio
            if ref_text:
                generate_kwargs["ref_text"] = ref_text
        elif instruct:
            generate_kwargs["instruct"] = instruct

        audio_arrays = model.generate(**generate_kwargs)

        if not audio_arrays or len(audio_arrays) == 0:
            raise HTTPException(status_code=500, detail="Model returned empty audio")

        # Concatenate if multiple arrays returned
        audio = np.concatenate(audio_arrays) if len(audio_arrays) > 1 else audio_arrays[0]

    except Exception as e:
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    t1 = time.time()
    duration_audio = len(audio) / 24000
    rtf = (t1 - t0) / duration_audio if duration_audio > 0 else 0
    logger.info(f"Generated {duration_audio:.2f}s audio in {t1-t0:.2f}s (RTF={rtf:.3f})")

    # Encode to requested format
    output_buffer = io.BytesIO()
    fmt = request.response_format.lower()

    if fmt == "wav":
        sf.write(output_buffer, audio, 24000, format="WAV", subtype="PCM_16")
        content_type = "audio/wav"
    elif fmt == "pcm":
        # Raw 24kHz s16le mono — no header
        pcm = (audio * 32767).astype(np.int16)
        output_buffer.write(pcm.tobytes())
        content_type = "audio/pcm"
    elif fmt == "flac":
        sf.write(output_buffer, audio, 24000, format="FLAC")
        content_type = "audio/flac"
    elif fmt in ("mp3", "opus", "aac"):
        # For mp3/opus/aac we write wav first then could transcode with ffmpeg,
        # but for simplicity we return wav and let the client handle it.
        # Most OpenAI-compat consumers (including AIRI) handle wav fine.
        sf.write(output_buffer, audio, 24000, format="WAV", subtype="PCM_16")
        content_type = "audio/wav"
    else:
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
        },
    )


@app.get("/health")
async def health():
    return {"status": "ok", "active_model": _active_model_id, "device": DEVICE}
