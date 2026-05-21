FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Create venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install PyTorch (CUDA 12.4)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Install both TTS engines + server deps
# OmniVoice: pip install omnivoice
# VieNeu: pip install vieneu (with llama-cpp pre-built for Linux)
RUN pip install --no-cache-dir \
    omnivoice \
    vieneu \
    fastapi \
    uvicorn[standard] \
    soundfile \
    numpy

# Copy server code
WORKDIR /app
COPY server.py /app/server.py

# Reference audio directory (mounted at runtime)
RUN mkdir -p /app/ref

EXPOSE 8100

# Default: load OmniVoice, 16 diffusion steps, natural emotion for VieNeu
ENV TTS_DEFAULT_MODEL=omnivoice
ENV TTS_DEVICE=cuda:0
ENV TTS_REF_AUDIO=/app/ref/me.wav
ENV TTS_NUM_STEPS=16
ENV TTS_VIENEU_EMOTION=natural

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
