"""Egress proxy for a local setup box: HTTPS ``CONNECT`` to allowlisted hosts only.

A local setup box sits on its own internal Docker network with no route out.
This proxy runs in a sidecar container on that network and on ``bridge``, and
is the box's only way out. It mirrors the Vercel allowlist: a tunnel opens only
to an exact allowlisted host on port 443, and only when every address the host
resolves to is a public one. That last check keeps the Mac itself out of reach
(Docker Desktop routes ``host.docker.internal`` and its 192.168.65.0/24 range to
services that listen only on the Mac's loopback), along with every private,
loopback and link-local range. The proxy connects to the address it checked,
so a second DNS answer cannot swap in a private one.

The sidecar runs this file with the image's own Python, so it must use the
standard library only. It is also importable for unit tests.

Usage: ``python3 -I -c <this file> <port> <lifetime seconds> <host> [<host> ...]``
"""

from __future__ import annotations

import contextlib
import ipaddress
import os
import socket
import sys
import threading

READY_MARKER = "skynet-egress-proxy-ready"
_ALLOWED_PORT = 443
_HEAD_LIMIT = 8192
_HANDSHAKE_SECONDS = 30.0
_CONNECT_SECONDS = 10.0
_IDLE_SECONDS = 300.0
_FORBIDDEN = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_BAD_GATEWAY = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_ESTABLISHED = b"HTTP/1.1 200 Connection Established\r\n\r\n"


def parse_connect(head: bytes) -> tuple[str, int] | None:
    """Read the target of a ``CONNECT host:port`` request head.

    Args:
        head: The request bytes up to and including the blank line.

    Returns:
        The lower-case host without a trailing dot and the port, or ``None``
        for any other method or a malformed line.
    """
    line = head.split(b"\r\n", 1)[0].decode("latin-1")
    parts = line.split()
    if len(parts) != 3 or parts[0] != "CONNECT" or not parts[2].startswith("HTTP/1."):
        return None
    host, sep, port = parts[1].rpartition(":")
    if not sep or not port.isdigit() or host.startswith("["):
        return None
    return host.rstrip(".").lower(), int(port)


def public_addresses(host: str, port: int) -> list[tuple[int, tuple]] | None:
    """Resolve ``host`` and keep the answer only when every address is public.

    Args:
        host: The allowlisted host name.
        port: The destination port.

    Returns:
        ``(family, sockaddr)`` pairs to connect to, or ``None`` when the name
        does not resolve or any answer is not a global address.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None
    addresses = []
    for family, _, _, _, sockaddr in infos:
        if not ipaddress.ip_address(sockaddr[0].split("%")[0]).is_global:
            return None
        addresses.append((family, sockaddr))
    return addresses or None


def target_allowed(target: tuple[str, int] | None, allowed: frozenset[str]) -> bool:
    """Decide whether a parsed ``CONNECT`` target may be tunnelled.

    Args:
        target: The parsed host and port, or ``None``.
        allowed: Exact allowlisted host names.

    Returns:
        Whether the host is allowlisted and the port is 443.
    """
    return target is not None and target[1] == _ALLOWED_PORT and target[0] in allowed


def _read_head(client: socket.socket) -> tuple[bytes, bytes] | None:
    """Read the request head and any bytes the client sent after it.

    Args:
        client: The accepted connection.

    Returns:
        The head and the remainder, or ``None`` when no full head arrives.
    """
    data = b""
    while b"\r\n\r\n" not in data:
        if len(data) > _HEAD_LIMIT:
            return None
        chunk = client.recv(4096)
        if not chunk:
            return None
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    return head + b"\r\n\r\n", rest


def _pipe(source: socket.socket, sink: socket.socket) -> None:
    """Copy bytes one way until either side closes or goes idle.

    Args:
        source: Socket to read from.
        sink: Socket to write to.
    """
    try:
        while chunk := source.recv(65536):
            sink.sendall(chunk)
    except OSError:
        pass
    finally:
        for side in (sink, source):
            with contextlib.suppress(OSError):
                side.shutdown(socket.SHUT_RDWR)


def _open_upstream(addresses: list[tuple[int, tuple]]) -> socket.socket | None:
    """Connect to the first checked address that answers.

    Args:
        addresses: Public ``(family, sockaddr)`` pairs.

    Returns:
        The connected socket, or ``None`` when none answers.
    """
    for family, sockaddr in addresses:
        upstream = socket.socket(family, socket.SOCK_STREAM)
        upstream.settimeout(_CONNECT_SECONDS)
        try:
            upstream.connect(sockaddr)
        except OSError:
            upstream.close()
            continue
        upstream.settimeout(_IDLE_SECONDS)
        return upstream
    return None


def handle(client: socket.socket, allowed: frozenset[str]) -> None:
    """Serve one client connection: refuse it, or tunnel it to its checked target.

    Args:
        client: The accepted connection.
        allowed: Exact allowlisted host names.
    """
    with client:
        client.settimeout(_HANDSHAKE_SECONDS)
        try:
            request = _read_head(client)
            if request is None:
                return
            head, rest = request
            target = parse_connect(head)
            addresses = public_addresses(*target) if target_allowed(target, allowed) else None
            if addresses is None:
                client.sendall(_FORBIDDEN)
                return
            upstream = _open_upstream(addresses)
            if upstream is None:
                client.sendall(_BAD_GATEWAY)
                return
            with upstream:
                client.sendall(_ESTABLISHED)
                if rest:
                    upstream.sendall(rest)
                client.settimeout(_IDLE_SECONDS)
                back = threading.Thread(target=_pipe, args=(upstream, client), daemon=True)
                back.start()
                _pipe(client, upstream)
                back.join()
        except OSError:
            return


def serve(listener: socket.socket, allowed: frozenset[str]) -> None:
    """Accept connections, one thread each, until the listener closes.

    A listener that fails stops the proxy, which leaves the box with no way
    out rather than an unchecked one.

    Args:
        listener: A bound, listening socket.
        allowed: Exact allowlisted host names.
    """
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=handle, args=(client, allowed), daemon=True).start()


def main(argv: list[str]) -> None:
    """Listen on every interface of the sidecar and exit when the box's lifetime ends.

    Args:
        argv: ``<port> <lifetime seconds> <host> [<host> ...]``.
    """
    port, lifetime, *hosts = argv
    allowed = frozenset(host.rstrip(".").lower() for host in hosts)
    listener = socket.create_server(("0.0.0.0", int(port)), backlog=128)
    timer = threading.Timer(float(lifetime), os._exit, args=(0,))
    timer.daemon = True
    timer.start()
    print(READY_MARKER, flush=True)
    serve(listener, allowed)


if __name__ == "__main__":
    main(sys.argv[1:])
