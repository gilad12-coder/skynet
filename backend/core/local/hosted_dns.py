"""Resolve the hosted API over DNS over HTTPS when the system DNS fails (SKY-235).

Some networks answer DNS for other sites but not for skynetml.com. Browsers
still work there because they use secure DNS, but ``getaddrinfo`` blocks for
about 30 s, and httpx timeouts do not cover that wait. This transport gives the
system resolver a short limit, then asks Cloudflare's DNS over HTTPS by IP and
connects to the answer with the real host name kept for TLS and the Host header.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from urllib.request import getproxies

import httpx

DOH_URL = "https://1.1.1.1/dns-query"
SYSTEM_WAIT_SECONDS = 2.0
_DOH_TIMEOUT = httpx.Timeout(3.0)
# The floor keeps a refresh resend off the DoH wait even for a zero TTL.
_MIN_ANSWER_TTL = 60.0
_MAX_ANSWER_TTL = 300.0
# After the system resolver fails for a host, later calls skip it for this long,
# so a refresh resend spends no time on DNS (see hosted_link's resend math).
_SYSTEM_FAILED_TTL = 300.0
_A_RECORD = 1

# A timed-out ``getaddrinfo`` cannot be cancelled; its thread runs out in the
# pool while the request goes on through DNS over HTTPS.
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="hosted-dns")
_LOCK = threading.Lock()
_ANSWERS: dict[str, tuple[str, float]] = {}
_SYSTEM_FAILED: dict[str, float] = {}
_clock = time.monotonic


def clear_cache() -> None:
    """Forget cached answers and system-resolver failures (tests start clean)."""
    with _LOCK:
        _ANSWERS.clear()
        _SYSTEM_FAILED.clear()


def system_lookup(host: str, port: int) -> None:
    """Resolve ``host`` with the system resolver.

    Args:
        host: Host name to resolve.
        port: Port of the request, passed through to ``getaddrinfo``.

    Raises:
        OSError: The system resolver has no answer.
    """
    socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def doh_lookup(host: str) -> tuple[str, float]:
    """Resolve ``host`` to one IPv4 address over DNS over HTTPS.

    Args:
        host: Host name to resolve.

    Returns:
        The first A-record address and its TTL in seconds.

    Raises:
        httpx.HTTPError: The DoH server cannot be reached or answers an error.
        LookupError: The answer has no A record.
    """
    response = httpx.get(
        DOH_URL,
        params={"name": host, "type": "A"},
        headers={"accept": "application/dns-json"},
        timeout=_DOH_TIMEOUT,
    )
    response.raise_for_status()
    # The answer can lead with CNAME records; only A records carry an address.
    for answer in response.json().get("Answer") or []:
        if answer.get("type") == _A_RECORD:
            return answer["data"], float(answer.get("TTL", 0))
    raise LookupError(f"no A record for {host}")


def proxy_configured() -> bool:
    """Return whether an HTTPS proxy applies, from the environment or macOS settings.

    httpx reads the same source only when a client gets no explicit transport,
    and a proxy resolves the host name itself, so callers skip this transport then.
    """
    proxies = getproxies()
    return bool(proxies.get("https") or proxies.get("all"))


def _is_literal(host: str) -> bool:
    """Return whether ``host`` needs no lookup (an IP address or localhost)."""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


class FallbackDnsTransport(httpx.BaseTransport):
    """Send requests with the system DNS, or with a DNS-over-HTTPS answer when it fails."""

    def __init__(
        self,
        inner: httpx.BaseTransport | None = None,
        system: Callable[[str, int], None] = system_lookup,
        doh: Callable[[str], tuple[str, float]] = doh_lookup,
    ) -> None:
        """Wrap a transport.

        Args:
            inner: Transport that sends the request; a default ``httpx.HTTPTransport`` when omitted.
            system: System resolver check; raises when the host has no answer.
            doh: DNS-over-HTTPS resolver; returns an address and its TTL.
        """
        self._inner = inner or httpx.HTTPTransport()
        self._system = system
        self._doh = doh

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Send ``request``, pointed at a DoH address when the system DNS fails.

        Args:
            request: The outgoing request.

        Returns:
            The inner transport's response.
        """
        host = request.url.host
        if _is_literal(host):
            return self._inner.handle_request(request)
        address = self._fallback_address(host, request.url.port or (443 if request.url.scheme == "https" else 80))
        if address is not None:
            # The Host header is already set; ``sni_hostname`` keeps the TLS name
            # and certificate check on the real host while the socket goes to the IP.
            request.url = request.url.copy_with(host=address)
            request.extensions = {**request.extensions, "sni_hostname": host}
        return self._inner.handle_request(request)

    def close(self) -> None:
        """Close the inner transport."""
        self._inner.close()

    def _fallback_address(self, host: str, port: int) -> str | None:
        """Return a DoH address for ``host``, or None when the system DNS answers.

        Args:
            host: Host name of the request.
            port: Port of the request.

        Returns:
            An IPv4 address to connect to, or None to keep the system resolver.
            None also when DNS over HTTPS fails, so the request reports the
            system resolver's own error.
        """
        now = _clock()
        with _LOCK:
            cached = _ANSWERS.get(host)
            if cached and cached[1] > now:
                return cached[0]
            system_failed = _SYSTEM_FAILED.get(host, 0.0) > now
        if not system_failed:
            try:
                _POOL.submit(self._system, host, port).result(timeout=SYSTEM_WAIT_SECONDS)
                return None
            except (OSError, FutureTimeout):
                with _LOCK:
                    _SYSTEM_FAILED[host] = _clock() + _SYSTEM_FAILED_TTL
        try:
            address, ttl = self._doh(host)
        except (httpx.HTTPError, LookupError, ValueError, KeyError):
            return None
        with _LOCK:
            _ANSWERS[host] = (address, _clock() + min(max(ttl, _MIN_ANSWER_TTL), _MAX_ANSWER_TTL))
        return address
