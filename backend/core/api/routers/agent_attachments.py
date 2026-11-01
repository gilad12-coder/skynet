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

from ...config import settings
from ...service_gateway.agents.attachments import (
    MAX_ATTACHMENT_BYTES,
    AttachmentReadersBusyError,
    read_attachment,
)
from ..auth import AuthenticatedUser, get_authenticated_user
from ..errors import DomainError
from ..rate_limit import RateLimiter, shared_redis_client


class AttachmentTextResponse(BaseModel):
    """Response body for ``POST /agent/attachments/extract``: the text the agent reads."""

    text: str


def create_agent_attachments_router() -> APIRouter:
    """Build the agent-attachment router.

    Returns:
        A configured :class:`APIRouter` exposing ``POST /agent/attachments/extract``.
    """
    router = APIRouter()

    # A sync handler, so FastAPI waits for the parsing child process in its thread pool.
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
                chats that host them, and the caller keys the hourly cap.
            file: The attached file, of any type.

        Returns:
            The extracted text, or a short note when the file cannot be read.

        Raises:
            DomainError: 429 when the caller is over the hourly attachment cap,
                or when this API process already reads its maximum number of files.
        """
        RateLimiter(shared_redis_client()).enforce(
            f"attachments:{user.username}",
            limit=settings.rate_limit_attachments_per_hour,
            window_seconds=3600,
        )
        data = file.file.read(MAX_ATTACHMENT_BYTES + 1)
        size = file.size if file.size is not None else len(data)
        try:
            text = read_attachment(file.filename or "file", file.content_type or "", data, size)
        except AttachmentReadersBusyError:
            raise DomainError("rate_limit.exceeded", status=429, params={"retry_after": 5}) from None
        return AttachmentTextResponse(text=text)

    return router
