FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System deps + build tools (gcc, g++, cmake for llama-cpp-python; rust for sea-g2p)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev \
    git ffmpeg libsndfile1 \
    build-essential cmake \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Rust (needed by sea-g2p / maturin)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH"

# Create venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install PyTorch (CUDA 12.4)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Install llama-cpp-python with CUDA support (pre-built wheel avoids cmake issues)
RUN pip install --no-cache-dir llama-cpp-python==0.3.16 \
    --extra-index-url https://pnnbao97.github.io/llama-cpp-python-v0.3.16/cu124/

# Install both TTS engines + server deps
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
COPY generation_options.py /app/generation_options.py
COPY voice_refs.py /app/voice_refs.py

# Reference audio directory (mounted at runtime)
RUN mkdir -p /app/ref

EXPOSE 8100

ENV TTS_DEFAULT_MODEL=omnivoice
ENV TTS_DEVICE=cuda:0
ENV TTS_REF_AUDIO=/app/ref/me.wav
ENV TTS_NUM_STEPS=16
ENV TTS_VIENEU_EMOTION=natural

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
