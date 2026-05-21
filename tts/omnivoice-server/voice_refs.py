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


def resolve_voice_reference(ref_dir: str, name: str) -> dict[str, object] | None:
    """Resolve a voice clone reference by name, case-insensitively."""
    requested_name = name.strip()
    if not requested_name or not os.path.isdir(ref_dir):
        return None

    requested_key = requested_name.lower()
    matched: tuple[str, str, str] | None = None
    matched_priority = 999

    for filename in sorted(os.listdir(ref_dir)):
        file_name, ext = os.path.splitext(filename)
        normalized_ext = ext.lower()
        if normalized_ext not in SUPPORTED_REF_AUDIO_EXTS:
            continue
        if file_name.lower() != requested_key:
            continue

        priority = _EXT_PRIORITY[normalized_ext]
        if matched and matched_priority <= priority:
            continue

        matched = (file_name, normalized_ext, os.path.join(ref_dir, filename))
        matched_priority = priority

    if not matched:
        return None

    resolved_name, resolved_ext, audio_path = matched
    txt_path = f"{os.path.splitext(audio_path)[0]}.txt"
    ref_text = ""
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as file:
            ref_text = file.read().strip()

    return {
        "name": resolved_name,
        "audio_path": audio_path,
        "format": resolved_ext[1:],
        "ref_text": ref_text,
        "has_reference_text": bool(ref_text),
    }
