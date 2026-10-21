"""Prove the per-turn codex auth proxy keeps the real login outside the turn."""

from __future__ import annotations

import base64
import contextlib
import http.client
import http.server
import json
import logging
import socket
import ssl
import threading
import time
from collections.abc import Iterator

import pytest

from core.billing import codex_auth_proxy
from core.billing.codex_auth_proxy import (
    PLACEHOLDER_ACCOUNT,
    UPSTREAM_HOST,
    CodexAuthProxy,
    jwt_claims,
    placeholder_login,
)
from core.local.cli_probe import codex_subscription_login

REAL_ACCESS = "real-access-" + "a" * 40
REAL_ACCOUNT = "real-account-0000-1111"
PLACEHOLDER = "placeholder-" + "p" * 40


class _Upstream(http.server.BaseHTTPRequestHandler):
    """A stub of the provider: records each request and streams a short SSE answer."""

    protocol_version = "HTTP/1.1"
    seen: list[dict] = []
    release = threading.Event()
    expired = False
    empty_status: int | None = None

    def do_POST(self) -> None:
        """Record the request, then stream two events with a pause the test controls."""
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("set-cookie", "session=upstream-cookie")
        self.end_headers()
        for index, event in enumerate((b"data: first\n\n", b"data: second\n\n")):
            if index == 1:
                type(self).release.wait(10)
            self.wfile.write(f"{len(event):x}\r\n".encode() + event + b"\r\n")
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")

    def do_GET(self) -> None:
        """Record the request and answer with a small JSON body."""
        type(self).seen.append({"path": self.path, "headers": dict(self.headers.items()), "body": b""})
        if type(self).empty_status is not None:
            self.send_response(type(self).empty_status)
            self.end_headers()
            return
        if type(self).expired:
            payload = b'{"error": {"code": "token_expired"}}'
            self.send_response(401)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        payload = b'{"models": []}'
        if "accounts/check" in self.path:
            # The real answer names the account in its id, default, ordering and user id.
            payload = json.dumps(
                {
                    "accounts": [{"id": REAL_ACCOUNT, "account_user_id": f"user-1__{REAL_ACCOUNT}"}],
                    "default_account_id": REAL_ACCOUNT,
                    "account_ordering": [REAL_ACCOUNT],
                }
            ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_: object) -> None:
        """Keep the stub quiet."""


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[_Upstream]]:
    """Run the stub provider and point the proxy's upstream connection at it."""
    _Upstream.seen = []
    _Upstream.release = threading.Event()
    _Upstream.expired = False
    _Upstream.empty_status = None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        codex_auth_proxy, "_upstream_connection", lambda: http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    )
    try:
        yield _Upstream
    finally:
        _Upstream.release.set()
        server.shutdown()
        server.server_close()


@pytest.fixture
def proxy(upstream: type[_Upstream]) -> Iterator[CodexAuthProxy]:
    """A started proxy with a fake real login and a fake placeholder."""
    with CodexAuthProxy(access_token=REAL_ACCESS, account_id=REAL_ACCOUNT, placeholder=PLACEHOLDER) as running:
        yield running


def _request(
    proxy: CodexAuthProxy, method: str, path: str, *, token: str = PLACEHOLDER, body: bytes = b"{}"
) -> http.client.HTTPResponse:
    """Send one request to the proxy the way codex does.

    Args:
        proxy: The running proxy.
        method: HTTP method.
        path: Request path.
        token: The bearer token codex read from its login copy.
        body: Request body for a POST.

    Returns:
        The open response.
    """
    context = ssl.create_default_context(cadata=proxy.ca_pem.decode())
    connection = http.client.HTTPSConnection("127.0.0.1", proxy.port, timeout=10, context=context)
    headers = {
        "authorization": f"Bearer {token}",
        "chatgpt-account-id": "placeholder-account",
        "cookie": "turn=cookie",
        "content-type": "application/json",
    }
    connection.request(method, path, body=body if method == "POST" else None, headers=headers)
    return connection.getresponse()


def _raw_post(proxy: CodexAuthProxy, framing: bytes, payload: bytes) -> bytes:
    """Send one POST with hand-written body framing and read the answer's head.

    Args:
        proxy: The running proxy.
        framing: The body-framing header line, with its CRLF.
        payload: The bytes after the blank line.

    Returns:
        The bytes up to the end of the answer's headers, or what came before a 5-second silence.
    """
    context = ssl.create_default_context(cadata=proxy.ca_pem.decode())
    with (
        socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as raw,
        context.wrap_socket(raw, server_hostname="127.0.0.1") as secured,
    ):
        secured.sendall(
            b"POST /backend-api/codex/responses HTTP/1.1\r\nHost: x\r\n"
            + f"Authorization: Bearer {PLACEHOLDER}\r\n".encode()
            + framing
            + b"\r\n"
            + payload
        )
        secured.settimeout(5)
        answer = b""
        # A proxy that waits for the rest of a body it misread sends nothing, so the
        # test ends on the timeout instead of hanging.
        with contextlib.suppress(TimeoutError):
            while b"\r\n\r\n" not in answer and (chunk := secured.recv(65536)):
                answer += chunk
    return answer


def _jwt(claims: dict) -> str:
    """Build an unsigned JWT-shaped token.

    Args:
        claims: The payload.

    Returns:
        ``header.payload.signature``.
    """

    def part(value: dict) -> str:
        """Encode one JWT part."""
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'RS256'})}.{part(claims)}.c2ln"


@pytest.mark.parametrize("token", ["", "wrong", PLACEHOLDER + "x", REAL_ACCESS])
def test_request_without_the_turn_secret_is_refused(
    token: str, proxy: CodexAuthProxy, upstream: type[_Upstream]
) -> None:
    """Only the placeholder token of this turn opens the proxy, and a refused call never leaves the Mac.

    Args:
        token: A bearer token that is not this turn's placeholder.
    """
    response = _request(proxy, "POST", "/backend-api/codex/responses", token=token)

    assert response.status == 403
    assert upstream.seen == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/backend-api/ps/plugins/list"),
        ("POST", "/backend-api/codex/analytics-events/events"),
        ("GET", "/backend-api/codex/responses"),
        ("POST", "/backend-api/codex/responses/../../wham/tasks"),
        ("POST", "http://evil.example/backend-api/codex/responses"),
        ("GET", "/v1/models"),
    ],
)
def test_only_the_model_paths_reach_the_provider(
    method: str, path: str, proxy: CodexAuthProxy, upstream: type[_Upstream]
) -> None:
    """A path or method outside the allow-list gets 404 and is not forwarded.

    Args:
        method: HTTP method.
        path: Request target.
    """
    response = _request(proxy, method, path)

    assert response.status == 404
    assert upstream.seen == []


@pytest.mark.parametrize(
    "length", ["-1", "+5", "0x5", "1_0", "5.0", "5 5", "five", "\u00b2"], ids=lambda value: value.encode().hex()
)
def test_content_length_that_is_not_plain_digits_is_refused(
    length: str, proxy: CodexAuthProxy, upstream: type[_Upstream]
) -> None:
    """A Content-Length other than ASCII digits gets 400 and is not forwarded, so no read skips the size limit.

    Args:
        length: A malformed Content-Length value.
    """
    answer = _raw_post(proxy, f"Content-Length: {length}\r\n".encode("latin-1"), b"A" * 4096)

    assert answer.startswith(b"HTTP/1.1 400 ")
    assert upstream.seen == []


@pytest.mark.parametrize("size_line", [b"-1", b"+5", b"0x5", b"1_0", b"", b"5 5", b"g"])
def test_chunk_size_that_is_not_plain_hex_is_refused(
    size_line: bytes, proxy: CodexAuthProxy, upstream: type[_Upstream]
) -> None:
    """A chunk size other than hex digits gets 400 and is not forwarded, so no read skips the size limit.

    Args:
        size_line: A malformed chunk-size line, without its CRLF.
    """
    answer = _raw_post(proxy, b"Transfer-Encoding: chunked\r\n", size_line + b"\r\n" + b"A" * 4096)

    assert answer.startswith(b"HTTP/1.1 400 ")
    assert upstream.seen == []


def test_chunked_body_with_extensions_is_forwarded(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """Chunk extensions after ';' are ignored, as RFC 9112 allows, and the body arrives whole."""
    upstream.release.set()
    answer = _raw_post(
        proxy, b"Transfer-Encoding: chunked\r\n", b"5;name=value\r\nhello\r\nA ; x\r\n0123456789\r\n0\r\n\r\n"
    )

    assert answer.startswith(b"HTTP/1.1 200 ")
    assert [call["body"] for call in upstream.seen] == [b"hello0123456789"]


@pytest.mark.parametrize("status", [204, 304])
def test_answer_without_a_body_keeps_the_connection_in_step(
    status: int, proxy: CodexAuthProxy, upstream: type[_Upstream]
) -> None:
    """A 204 or 304 answer carries no body bytes, so the next answer on the same connection parses correctly.

    Args:
        status: An upstream status that has no body.
    """
    upstream.empty_status = status
    context = ssl.create_default_context(cadata=proxy.ca_pem.decode())
    request = f"GET /backend-api/codex/models HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {PLACEHOLDER}\r\n\r\n"
    with (
        socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as raw,
        context.wrap_socket(raw, server_hostname="127.0.0.1") as secured,
    ):
        reader = secured.makefile("rb")
        secured.sendall(request.encode())
        first = [reader.readline()]
        while first[-1] not in (b"\r\n", b""):
            first.append(reader.readline())
        upstream.empty_status = None
        secured.sendall(request.encode())
        # A client that follows RFC 9112 reads no body after a 204 or 304, so the next
        # bytes on the connection must start the second answer.
        second = reader.readline()
        reader.close()

    assert first[0].startswith(f"HTTP/1.1 {status} ".encode())
    assert not any(line.lower().startswith(b"transfer-encoding") for line in first)
    assert second.startswith(b"HTTP/1.1 200 ")
    assert len(upstream.seen) == 2


def test_proxy_swaps_in_the_real_login_and_drops_cookies(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """The provider gets the real token and account; the turn's cookie and the provider's cookie stay out."""
    upstream.release.set()

    response = _request(proxy, "POST", "/backend-api/codex/responses?x=1", body=b'{"input": "hi"}')
    body = response.read()

    assert response.status == 200
    assert body == b"data: first\n\ndata: second\n\n"
    assert response.getheader("set-cookie") is None
    [seen] = upstream.seen
    headers = {name.lower(): value for name, value in seen["headers"].items()}
    assert seen["path"] == "/backend-api/codex/responses?x=1"
    assert seen["body"] == b'{"input": "hi"}'
    assert headers["authorization"] == f"Bearer {REAL_ACCESS}"
    assert headers["chatgpt-account-id"] == REAL_ACCOUNT
    assert headers["host"] == UPSTREAM_HOST
    assert "cookie" not in headers


def test_models_list_and_account_check_are_forwarded(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """Codex needs the model list and the workspace check; the check names only the placeholder account.

    Codex picks the workspace whose id matches the login's account, so the
    proxy swaps the real id for the placeholder the login copy holds.
    """
    models = _request(proxy, "GET", "/backend-api/codex/models?client_version=0.163.0")
    assert models.status == 200
    assert models.read() == b'{"models": []}'
    check = _request(proxy, "GET", "/backend-api/wham/accounts/check")
    assert check.status == 200
    assert json.loads(check.read()) == {
        "accounts": [{"id": PLACEHOLDER_ACCOUNT, "account_user_id": f"user-1__{PLACEHOLDER_ACCOUNT}"}],
        "default_account_id": PLACEHOLDER_ACCOUNT,
        "account_ordering": [PLACEHOLDER_ACCOUNT],
    }

    assert [seen["path"] for seen in upstream.seen] == [
        "/backend-api/codex/models?client_version=0.163.0",
        "/backend-api/wham/accounts/check",
    ]


def test_streamed_events_pass_through_as_they_arrive(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """The first SSE event reaches codex while the provider still holds back the second."""
    response = _request(proxy, "POST", "/backend-api/codex/responses")

    first = response.read1(64)
    assert first.startswith(b"data: first")
    upstream.release.set()
    rest = response.read()

    assert first + rest == b"data: first\n\ndata: second\n\n"


def test_closed_proxy_accepts_no_connection(upstream: type[_Upstream]) -> None:
    """At turn end the port closes, so no new connection after the turn can use the login."""
    with CodexAuthProxy(access_token=REAL_ACCESS, account_id=REAL_ACCOUNT, placeholder=PLACEHOLDER) as running:
        port = running.port

    with pytest.raises(OSError), socket.create_connection(("127.0.0.1", port), timeout=2):
        pass


def test_open_connection_forwards_nothing_after_the_proxy_stops(upstream: type[_Upstream]) -> None:
    """A keep-alive connection opened during the turn cannot send the login anywhere after the turn."""
    running = CodexAuthProxy(access_token=REAL_ACCESS, account_id=REAL_ACCOUNT, placeholder=PLACEHOLDER)
    with running:
        context = ssl.create_default_context(cadata=running.ca_pem.decode())
        connection = http.client.HTTPSConnection("127.0.0.1", running.port, timeout=5, context=context)
        headers = {"authorization": f"Bearer {PLACEHOLDER}"}
        connection.request("GET", "/backend-api/codex/models", headers=headers)
        first = connection.getresponse()
        assert first.status == 200
        first.read()

    with pytest.raises((OSError, http.client.HTTPException)):
        connection.request("GET", "/backend-api/codex/models", headers=headers)
        connection.getresponse().read()
    connection.close()

    assert [call["path"] for call in upstream.seen] == ["/backend-api/codex/models"]


def test_idle_connection_is_closed(monkeypatch: pytest.MonkeyPatch, upstream: type[_Upstream]) -> None:
    """A connection that sends no request within the idle time is closed and holds no thread."""
    monkeypatch.setattr(codex_auth_proxy, "CLIENT_IDLE_TIMEOUT_SECONDS", 0.5)
    with CodexAuthProxy(access_token=REAL_ACCESS, account_id=REAL_ACCOUNT, placeholder=PLACEHOLDER) as running:
        context = ssl.create_default_context(cadata=running.ca_pem.decode())
        with (
            socket.create_connection(("127.0.0.1", running.port), timeout=5) as raw,
            context.wrap_socket(raw, server_hostname="127.0.0.1") as secured,
        ):
            assert secured.recv(1) == b""


def test_proxy_listens_on_loopback_only(proxy: CodexAuthProxy) -> None:
    """The proxy binds 127.0.0.1 on a random port and serves HTTPS, which codex requires."""
    assert proxy.base_url == f"https://127.0.0.1:{proxy.port}"
    assert proxy.port > 0
    assert proxy.ca_pem.startswith(b"-----BEGIN CERTIFICATE-----")
    assert b"PRIVATE KEY" not in proxy.ca_pem


def test_client_without_the_turn_ca_is_refused(proxy: CodexAuthProxy) -> None:
    """Only a client that trusts this turn's CA completes the handshake; system roots do not."""
    connection = http.client.HTTPSConnection("127.0.0.1", proxy.port, timeout=5, context=ssl.create_default_context())

    with pytest.raises(ssl.SSLCertVerificationError):
        connection.request("GET", "/backend-api/codex/models")


def test_a_stalled_handshake_does_not_block_other_calls(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """A connection that never starts TLS holds only its own thread."""
    with socket.create_connection(("127.0.0.1", proxy.port), timeout=5):
        response = _request(proxy, "GET", "/backend-api/codex/models")

        assert response.status == 200


def test_proxy_logs_hold_no_token(
    proxy: CodexAuthProxy, upstream: type[_Upstream], caplog: pytest.LogCaptureFixture
) -> None:
    """Neither the real token nor the placeholder nor the account goes to a log."""
    upstream.release.set()
    caplog.set_level(logging.DEBUG)

    _request(proxy, "POST", "/backend-api/codex/responses").read()
    _request(proxy, "POST", "/backend-api/codex/responses", token="wrong").read()
    _request(proxy, "GET", "/backend-api/ps/plugins/list").read()

    logged = caplog.text
    assert "/backend-api/codex/responses" in logged
    for value in (REAL_ACCESS, PLACEHOLDER, REAL_ACCOUNT, "upstream-cookie"):
        assert value not in logged


def test_token_expired_mid_turn_fails_without_a_refresh(proxy: CodexAuthProxy, upstream: type[_Upstream]) -> None:
    """A 401 from the provider goes back to codex as is; the proxy makes no refresh call."""
    upstream.expired = True

    response = _request(proxy, "GET", "/backend-api/codex/models")

    assert response.status == 401
    assert REAL_ACCESS.encode() not in response.read()
    assert [call["path"] for call in upstream.seen] == ["/backend-api/codex/models"]


def test_unreachable_provider_gives_a_502(monkeypatch: pytest.MonkeyPatch) -> None:
    """A provider that cannot be reached gives codex a clear 502, not a hang."""

    def refuse() -> http.client.HTTPConnection:
        """Return a connection to a closed port."""
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        return http.client.HTTPConnection("127.0.0.1", port, timeout=2)

    monkeypatch.setattr(codex_auth_proxy, "_upstream_connection", refuse)
    with CodexAuthProxy(access_token=REAL_ACCESS, account_id=REAL_ACCOUNT, placeholder=PLACEHOLDER) as running:
        response = _request(running, "POST", "/backend-api/codex/responses")
        assert response.status == 502
        assert REAL_ACCESS.encode() not in response.read()


def test_upstream_is_the_fixed_host_over_verified_tls() -> None:
    """The proxy only ever connects to chatgpt.com on 443 and checks its certificate."""
    connection = codex_auth_proxy._upstream_connection()

    assert isinstance(connection, http.client.HTTPSConnection)
    assert (connection.host, connection.port) == (UPSTREAM_HOST, 443)
    context = connection._context  # type: ignore[attr-defined]
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_config_args_send_codex_to_the_proxy(proxy: CodexAuthProxy) -> None:
    """Codex gets both base URLs, each on the proxy's HTTPS origin."""
    args = proxy.config_args()

    assert args == [
        "-c",
        f'openai_base_url="{proxy.base_url}/backend-api/codex"',
        "-c",
        f'chatgpt_base_url="{proxy.base_url}/backend-api/"',
    ]


def test_placeholder_login_holds_no_real_value() -> None:
    """The turn's login copy is a ChatGPT login by codex's rule, but every token in it is fake."""
    exp = int(time.time()) + 3600
    real_id = _jwt(
        {
            "email": "person@example.com",
            "https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_account_id": REAL_ACCOUNT},
        }
    )
    real_access = _jwt({"exp": exp, "https://api.openai.com/auth": {"chatgpt_account_id": REAL_ACCOUNT}})
    real = {
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": "sk-old-key-" + "k" * 30,
        "tokens": {
            "id_token": real_id,
            "access_token": real_access,
            "refresh_token": "rt-" + "r" * 40,
            "account_id": REAL_ACCOUNT,
        },
        "last_refresh": "2026-10-01T00:00:00Z",
    }

    copy, placeholder = placeholder_login(real)

    shown = json.dumps(copy)
    for value in (real_id, real_access, "rt-" + "r" * 40, REAL_ACCOUNT, "person@example.com", "sk-old-key"):
        assert value not in shown
    assert codex_subscription_login(copy)
    assert copy["tokens"]["access_token"] == placeholder
    assert copy["tokens"]["refresh_token"] == ""
    assert copy["OPENAI_API_KEY"] is None
    assert jwt_claims(placeholder)["exp"] == exp
    assert jwt_claims(copy["tokens"]["id_token"])["https://api.openai.com/auth"]["chatgpt_plan_type"] == "plus"
    assert placeholder != placeholder_login(real)[1]


def test_placeholder_is_new_each_turn() -> None:
    """The placeholder is random per turn, so a login copy left on disk opens nothing later."""
    real = {"tokens": {"access_token": "A" * 32, "account_id": "account-1"}}

    first, second = placeholder_login(real)[1], placeholder_login(real)[1]

    assert first != second
    assert len(first) > 40
