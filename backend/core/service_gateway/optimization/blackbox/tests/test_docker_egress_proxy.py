"""Tests for the egress proxy that is a local setup box's only way out."""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator

import pytest

from .. import docker_egress_proxy as proxy


@pytest.mark.parametrize(
    ("head", "target"),
    [
        (b"CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n", ("pypi.org", 443)),
        (b"CONNECT PyPI.org.:443 HTTP/1.0\r\n\r\n", ("pypi.org", 443)),
        (b"GET http://pypi.org/ HTTP/1.1\r\n\r\n", None),
        (b"CONNECT pypi.org HTTP/1.1\r\n\r\n", None),
        (b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n", None),
        (b"CONNECT pypi.org:443\r\n\r\n", None),
    ],
)
def test_parse_connect_reads_only_well_formed_connect_lines(head: bytes, target: tuple[str, int] | None) -> None:
    """Only a ``CONNECT host:port HTTP/1.x`` line names a target."""
    assert proxy.parse_connect(head) == target


@pytest.mark.parametrize(
    ("target", "allowed"),
    [
        (("pypi.org", 443), True),
        (("pypi.org", 80), False),
        (("evil.pypi.org", 443), False),
        (("host.docker.internal", 443), False),
        (None, False),
    ],
)
def test_target_allowed_needs_an_exact_host_on_443(target: tuple[str, int] | None, allowed: bool) -> None:
    """Match hosts exactly, as the Vercel allowlist does, and only on port 443."""
    assert proxy.target_allowed(target, frozenset({"pypi.org"})) is allowed


def _answers(*ips: str) -> list[tuple]:
    """Build ``getaddrinfo`` answers for ``ips``.

    Args:
        *ips: IPv4 or IPv6 addresses.

    Returns:
        Answers shaped like ``socket.getaddrinfo``'s.
    """
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]


@pytest.mark.parametrize(
    ("ips", "public"),
    [
        (("151.101.0.223",), True),
        (("151.101.0.223", "2a04:4e42::223"), True),
        (("192.168.65.254",), False),
        (("151.101.0.223", "127.0.0.1"), False),
        (("10.0.0.5",), False),
        (("172.17.0.1",), False),
        (("169.254.169.254",), False),
        (("::1",), False),
        (("fe80::1%eth0",), False),
        (("100.64.0.1",), False),
    ],
)
def test_public_addresses_refuse_any_private_answer(
    monkeypatch: pytest.MonkeyPatch, ips: tuple[str, ...], public: bool
) -> None:
    """One private answer, the Docker host range included, refuses the whole host."""
    monkeypatch.setattr(proxy.socket, "getaddrinfo", lambda *args, **kwargs: _answers(*ips))
    result = proxy.public_addresses("pypi.org", 443)
    assert (result is not None) is public


def test_public_addresses_refuse_a_name_that_does_not_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    """A lookup failure refuses the tunnel instead of raising."""

    def fail(*args: object, **kwargs: object) -> list[tuple]:
        """Fail like a missing name.

        Raises:
            socket.gaierror: Always.
        """
        raise socket.gaierror("no such name")

    monkeypatch.setattr(proxy.socket, "getaddrinfo", fail)
    assert proxy.public_addresses("pypi.org", 443) is None


@pytest.fixture
def running_proxy() -> Iterator[int]:
    """Serve the proxy on a loopback port for one test.

    Yields:
        The proxy's port.
    """
    listener = socket.create_server(("127.0.0.1", 0))
    thread = threading.Thread(target=proxy.serve, args=(listener, frozenset({"pypi.org", "localhost"})), daemon=True)
    thread.start()
    try:
        yield listener.getsockname()[1]
    finally:
        listener.close()


def _request(port: int, head: bytes, extra: bytes = b"") -> tuple[socket.socket, bytes]:
    """Send one request head to the proxy and read its status line.

    Args:
        port: The proxy's port.
        head: The request head.
        extra: Bytes sent right after the head, before any answer.

    Returns:
        The open client socket and the proxy's first answer.
    """
    client = socket.create_connection(("127.0.0.1", port), timeout=5)
    client.sendall(head + extra)
    answer = b""
    while b"\r\n\r\n" not in answer:
        chunk = client.recv(1024)
        if not chunk:
            break
        answer += chunk
    return client, answer


@pytest.mark.parametrize(
    "head",
    [
        b"CONNECT example.com:443 HTTP/1.1\r\n\r\n",
        b"CONNECT pypi.org:80 HTTP/1.1\r\n\r\n",
        b"CONNECT localhost:443 HTTP/1.1\r\n\r\n",
        b"GET http://pypi.org/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n",
    ],
)
def test_proxy_refuses_other_hosts_ports_methods_and_loopback(running_proxy: int, head: bytes) -> None:
    """An allowlisted name that resolves to loopback is refused like any other host."""
    client, answer = _request(running_proxy, head)
    with client:
        assert answer.startswith(b"HTTP/1.1 403 ")


def test_proxy_tunnels_an_allowed_host_to_its_checked_address(
    running_proxy: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bytes flow both ways, including bytes the client sent before the answer."""
    upstream = socket.create_server(("127.0.0.1", 0))
    seen: list[bytes] = []

    def echo() -> None:
        """Echo one connection back in upper case until it closes."""
        connection, _ = upstream.accept()
        with connection:
            while chunk := connection.recv(1024):
                seen.append(chunk)
                connection.sendall(chunk.upper())

    threading.Thread(target=echo, daemon=True).start()
    checked = [(socket.AF_INET, upstream.getsockname())]
    monkeypatch.setattr(proxy, "public_addresses", lambda host, port: checked if host == "pypi.org" else None)

    client, answer = _request(running_proxy, b"CONNECT pypi.org:443 HTTP/1.1\r\n\r\n", b"early")
    with client, upstream:
        assert answer.startswith(b"HTTP/1.1 200 ")
        client.sendall(b"-late")
        echoed = b""
        while len(echoed) < len(b"early-late"):
            echoed += client.recv(1024)
        assert echoed == b"EARLY-LATE"
