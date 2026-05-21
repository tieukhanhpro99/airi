OMNIVOICE_OPTION_FIELDS = (
    ("language", "language"),
    ("guidance_scale", "guidance_scale"),
    ("position_temperature", "position_temperature"),
    ("class_temperature", "class_temperature"),
    ("preprocess_prompt", "preprocess_prompt"),
    ("postprocess_output", "postprocess_output"),
    ("denoise", "denoise"),
    ("audio_chunk_duration", "audio_chunk_duration"),
    ("audio_chunk_threshold", "audio_chunk_threshold"),
)


def build_omnivoice_generation_kwargs(request, default_num_steps: int) -> dict:
    kwargs = {
        "text": request.input,
        "num_step": request.num_steps or default_num_steps,
        "speed": request.speed,
    }

    for request_field, omnivoice_field in OMNIVOICE_OPTION_FIELDS:
        value = getattr(request, request_field, None)
        if value is not None and value != "":
            kwargs[omnivoice_field] = value

    return kwargs
