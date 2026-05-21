from __future__ import annotations

import os

SUPPORTED_REF_AUDIO_EXTS = (".wav", ".mp3", ".flac", ".ogg")

_EXT_PRIORITY = {ext: index for index, ext in enumerate(SUPPORTED_REF_AUDIO_EXTS)}


def list_voice_references(ref_dir: str) -> list[dict[str, object]]:
    """List voice clone references available in ref_dir."""
    if not os.path.isdir(ref_dir):
        return []

    voices_by_name: dict[str, dict[str, object]] = {}

    for filename in sorted(os.listdir(ref_dir)):
        name, ext = os.path.splitext(filename)
        normalized_ext = ext.lower()
        if normalized_ext not in SUPPORTED_REF_AUDIO_EXTS:
            continue

        current = voices_by_name.get(name)
        current_priority = _EXT_PRIORITY.get(f".{current['format']}", 999) if current else 999
        if current and current_priority <= _EXT_PRIORITY[normalized_ext]:
            continue

        txt_path = os.path.join(ref_dir, f"{name}.txt")
        voices_by_name[name] = {
            "id": f"clone:{name}",
            "name": name,
            "format": normalized_ext[1:],
            "has_reference_text": os.path.exists(txt_path),
        }

    return [voices_by_name[name] for name in sorted(voices_by_name)]
