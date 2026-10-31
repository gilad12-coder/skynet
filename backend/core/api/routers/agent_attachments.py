"""Read files attached in agent chats. [INTERNAL]

``POST /agent/attachments/extract`` — accept one file from a chat composer and
return the text the agent reads for it. Every agent chat sends plain-string
messages, so the composer puts this text into the message; see
:mod:`core.service_gateway.agents.attachments` for the formats.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel

from ...service_gateway.agents.attachments import MAX_ATTACHMENT_BYTES, extract_attachment_text
from ..auth import AuthenticatedUser, get_authenticated_user


class AttachmentTextResponse(BaseModel):
    """Response body for ``POST /agent/attachments/extract``: the text the agent reads."""

    text: str


def create_agent_attachments_router() -> APIRouter:
    """Build the agent-attachment router.

    Returns:
        A configured :class:`APIRouter` exposing ``POST /agent/attachments/extract``.
    """
    router = APIRouter()

    # A sync handler, so FastAPI runs the CPU-bound parsing in its thread pool.
    @router.post(
        "/agent/attachments/extract",
        response_model=AttachmentTextResponse,
        summary="Extract the text of a file attached in an agent chat",
    )
    def extract_attachment(
        user: Annotated[AuthenticatedUser, Depends(get_authenticated_user)],
        file: Annotated[UploadFile, File()],
    ) -> AttachmentTextResponse:
        """Return the agent-readable text of one attached file.

        Args:
            user: Authenticated caller; attachments are login-gated like the
                chats that host them.
            file: The attached file, of any type.

        Returns:
            The extracted text, or a short note when the file cannot be read.
        """
        del user
        data = file.file.read(MAX_ATTACHMENT_BYTES + 1)
        size = file.size if file.size is not None else len(data)
        text = extract_attachment_text(file.filename or "file", file.content_type or "", data, size)
        return AttachmentTextResponse(text=text)

    return router
