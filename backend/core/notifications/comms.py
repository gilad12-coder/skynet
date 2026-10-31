"""SMTP transport for registered-user notifications."""

from __future__ import annotations

import logging

from ..api.email_sender import send_email

logger = logging.getLogger(__name__)


def resolve_email(username: str) -> str | None:
    """Return a registered email identity as a notification address.

    Args:
        username: Registered Skynet account identity.

    Returns:
        The normalized recipient address, or ``None`` for a non-email identity.
    """
    address = username.strip().lower()
    if address.count("@") != 1:
        return None
    local, domain = address.split("@", 1)
    if not local or not domain:
        return None
    return address


# Domains no mail relay delivers to: ".local" is multicast DNS only (RFC 6762),
# and the Mac app's default user is ``local@skynet.local``.
_UNMAILABLE_SUFFIXES = (".local", ".localhost")


def mailable(address: str) -> bool:
    """Return whether a mail relay can deliver to ``address``.

    Args:
        address: A normalized address from :func:`resolve_email`.

    Returns:
        ``False`` for a ``.local`` or ``localhost`` domain.
    """
    domain = address.rsplit("@", 1)[-1]
    return domain != "localhost" and not domain.endswith(_UNMAILABLE_SUFFIXES)


def send_mail(to: str, subject: str, html_body: str, *, text_body: str | None = None) -> bool:
    """Send an HTML notification through the configured SMTP relay.

    Delivery failures are logged and returned as ``False`` so notifications
    cannot break the request or job that triggered them.

    Args:
        to: Registered recipient email address.
        subject: Mail subject line.
        html_body: RTL HTML message body.
        text_body: Plain-text alternative; ``None`` falls back to the subject.

    Returns:
        ``True`` when the SMTP relay accepted the message, otherwise ``False``.
    """
    try:
        send_email(to, subject, text_body or subject, html_body=html_body)
        logger.info("Notification email sent to %s", to)
        return True
    except Exception as exc:  # A notification failure must never fail its job or request.
        logger.warning("Failed to send notification email to %s: %s", to, exc)
        return False
