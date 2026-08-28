"""The ``llm()`` helper a python scorer may call.

A scorer often has to *run* the version under optimization — a prompt has
no score until a model answers with it — or to *judge* what the version
produced, text or rendered images alike. Rather than hand user code raw
provider credentials, the worker and the dry-run sandbox inject one
callable, ``llm(prompt, input=None, images=None, messages=None)``, bound to
the model chosen in the Scorer step. Its token usage is read back from the
wrapped ``dspy.LM`` so the run bills it alongside the reflection model.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

import dspy

from ....exceptions import ServiceError
from ....models.common import ModelConfig
from ...language_models import build_language_model

_MEDIA_TYPE_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
}
_MEDIA_TYPE_BY_MAGIC = (
    (b"\x89PNG", "image/png"),
    (b"\xff\xd8", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "image/webp"),
    (b"BM", "image/bmp"),
)
_IMAGES_HELP = (
    "llm(images=...) takes PNG/JPEG bytes, file paths, http(s) or data: URLs, "
    "base64 strings, PIL images or Image objects."
)


def _data_url(data: bytes, media_type: str) -> str:
    """Inline ``data`` as a base64 data URL.

    Args:
        data: Raw image bytes.
        media_type: Their MIME type.

    Returns:
        The ``data:`` URL.
    """
    return f"data:{media_type};base64,{base64.b64encode(data).decode('ascii')}"


def _sniff_media_type(data: bytes) -> str:
    """Guess an image MIME type from its leading bytes, defaulting to PNG.

    Args:
        data: Raw image bytes.

    Returns:
        The MIME type.
    """
    for magic, media_type in _MEDIA_TYPE_BY_MAGIC:
        if data.startswith(magic):
            return media_type
    return "image/png"


def image_content_part(image: Any) -> dict[str, Any]:
    """Turn one scorer-supplied image into an OpenAI ``image_url`` content part.

    Args:
        image: PNG/JPEG bytes, a file path, an http(s) or ``data:`` URL, a
            base64 string, a PIL image, an ``Image`` (anything with
            ``to_openai_content_part``) or an already-built content part.

    Returns:
        The content part to place in a chat message.

    Raises:
        ServiceError: When ``image`` is none of the accepted shapes.
    """
    if isinstance(image, dict) and image.get("type"):
        return image
    to_part = getattr(image, "to_openai_content_part", None)
    if callable(to_part):
        return dict(to_part())
    if isinstance(image, bytes | bytearray):
        data = bytes(image)
        return {"type": "image_url", "image_url": {"url": _data_url(data, _sniff_media_type(data))}}
    # PIL images are duck-typed so Pillow stays optional for the worker.
    if hasattr(image, "save") and hasattr(image, "mode"):
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return {"type": "image_url", "image_url": {"url": _data_url(buffer.getvalue(), "image/png")}}
    if isinstance(image, str):
        if image.startswith(("data:", "http://", "https://")):
            return {"type": "image_url", "image_url": {"url": image}}
        path = Path(image)
        if path.is_file():
            data = path.read_bytes()
            media_type = _MEDIA_TYPE_BY_EXTENSION.get(path.suffix.lower()) or _sniff_media_type(data)
            return {"type": "image_url", "image_url": {"url": _data_url(data, media_type)}}
        try:
            data = base64.b64decode(image, validate=True)
        except ValueError as exc:
            raise ServiceError(_IMAGES_HELP) from exc
        return {"type": "image_url", "image_url": {"url": _data_url(data, _sniff_media_type(data))}}
    raise ServiceError(_IMAGES_HELP)


def scorer_messages(prompt: Any, input: Any = None, images: Any = None) -> list[dict[str, Any]]:
    """Build the chat messages one ``llm()`` call sends.

    Args:
        prompt: The text to run; with ``input`` it is the system message
            (the prompt under optimization), alone it is the user message.
        input: The case's input, sent as the user message when given.
        images: Images attached to the user message, if any; a single image
            or a list of them.

    Returns:
        OpenAI-style chat messages.
    """
    if images is not None and not isinstance(images, list | tuple):
        images = [images]
    user_text = str(prompt) if input is None else str(input)
    content: Any = user_text
    if images:
        content = [{"type": "text", "text": user_text}, *(image_content_part(image) for image in images)]
    messages: list[dict[str, Any]] = [{"role": "user", "content": content}]
    if input is not None:
        messages.insert(0, {"role": "system", "content": str(prompt)})
    return messages


class ScorerLLM:
    """What the scorer sees as ``llm``: one chat completion per call."""

    def __init__(self, lm: dspy.LM) -> None:
        """Wrap a language model.

        Args:
            lm: The model the scorer's calls go to; exposed as ``lm`` so the
                run can harvest its usage.
        """
        self.lm = lm

    def __call__(
        self,
        prompt: Any = None,
        input: Any = None,
        *,
        images: Any = None,
        messages: list[dict[str, Any]] | None = None,
    ) -> str:
        """Complete ``prompt``, optionally over ``input`` and ``images``.

        Args:
            prompt: The text to run; with ``input`` it is the system message
                (the prompt under optimization), alone it is the user message.
            input: The case's input, sent as the user message when given.
            images: Images for a vision model to look at — rendered output,
                screenshots, plots — attached to the user message.
            messages: Ready-made chat messages (OpenAI format, image parts
                included); replaces ``prompt``/``input``/``images``.

        Returns:
            The model's first completion, as text.

        Raises:
            ServiceError: Without a prompt or messages, or with an image
                the helper cannot read.
        """
        if messages is None:
            if prompt is None:
                raise ServiceError("llm() needs a prompt, or messages=[...].")
            messages = scorer_messages(prompt, input, images)
        elif not isinstance(messages, list):
            raise ServiceError("llm(messages=...) takes a list of chat messages.")
        completions = self.lm(messages=messages)
        return str(completions[0]) if completions else ""


def build_scorer_llm(config: ModelConfig) -> ScorerLLM:
    """Build the scorer's ``llm`` helper over the chosen model.

    The client-side cache stays on: a scorer that runs the same version on
    the same case twice should see the same answer, and pay once.

    Args:
        config: The model chosen in the Scorer step.

    Returns:
        The helper to inject into the scorer namespace.
    """
    return ScorerLLM(build_language_model(config))
