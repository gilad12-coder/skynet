"""Per-turn local auth proxy that keeps the real codex login outside a host turn.

A host codex turn runs tool commands that can read the turn's own
``auth.json`` and open TCP connections. If that copy held the real access
token, a prompt-injected turn could send it anywhere. So the copy holds only
placeholders (:func:`placeholder_login`), and codex sends its model calls to
:class:`CodexAuthProxy` on ``127.0.0.1`` (:meth:`CodexAuthProxy.config_args`).
Codex 0.163.0 refuses a ChatGPT backend that is not HTTPS, so the proxy serves
TLS with a certificate from a CA made for this turn; codex trusts that CA
through ``CODEX_CA_CERTIFICATE`` and the CA key is dropped once the
certificate is signed.
The proxy runs in the Skynet backend, outside the turn's Seatbelt profile. It
accepts only requests that carry this turn's random placeholder, forwards only
the model paths codex needs to ``chatgpt.com`` over verified TLS, puts in the
real token and account there, and streams the answer back. When the turn
ends, the proxy closes its port and every open connection, so the placeholder
opens nothing after it. A connection that sends no request for
:data:`CLIENT_IDLE_TIMEOUT_SECONDS` is closed too.

The real refresh token never enters the turn or the proxy: when the access
token expires, the turn fails with the "refresh your login" hint.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import datetime
import http.client
import http.server
import ipaddress
import json
import logging
import secrets
import shutil
import socket
import ssl
import tempfile
import threading
from pathlib import Path
from types import TracebackType
from typing import Any

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

logger = logging.getLogger(__name__)

UPSTREAM_HOST = "chatgpt.com"
AUTH_CLAIM = "https://api.openai.com/auth"
PLACEHOLDER_ACCOUNT = "00000000-0000-4000-8000-000000000000"
ACCOUNT_CHECK_PATH = "/backend-api/wham/accounts/check"
# The calls a codex 0.163.0 ``exec`` turn makes with a ChatGPT login, seen on a
# real turn. Plugin lists, analytics and cloud tasks are left out: codex runs
# without them, and they are no part of a proposer turn.
ALLOWED_CALLS = frozenset(
    {
        ("POST", "/backend-api/codex/responses"),
        ("POST", "/backend-api/codex/responses/compact"),
        ("GET", "/backend-api/codex/models"),
        ("GET", ACCOUNT_CHECK_PATH),
    }
)
MAX_BODY_BYTES = 64 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 300.0
HANDSHAKE_TIMEOUT_SECONDS = 30.0
# Applies to each read of codex's request and write of the answer, not to the
# provider's stream, so a long SSE answer is not cut.
CLIENT_IDLE_TIMEOUT_SECONDS = 300.0
REFUSE_DRAIN_SECONDS = 2.0
LOOPBACK = "127.0.0.1"
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
    }
)
# Codex's own credentials and cookies never pass in either direction: the
# proxy sets the real ones, and a provider cookie must not reach the turn.
_DROPPED_REQUEST = _HOP_BY_HOP | {"host", "authorization", "chatgpt-account-id", "cookie"}
_DROPPED_RESPONSE = _HOP_BY_HOP | {"set-cookie"}


def _b64url(value: dict[str, Any]) -> str:
    """Encode one JWT part.

    Args:
        value: The JSON object.

    Returns:
        Unpadded base64url text.
    """
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()


def jwt_claims(token: object) -> dict[str, Any]:
    """Read the payload of a JWT without checking its signature.

    Args:
        token: The token.

    Returns:
        The claims, or an empty dict when the value is not a JWT.
    """
    if not isinstance(token, str) or token.count(".") != 2:
        return {}
    payload = token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, binascii.Error):
        return {}
    return claims if isinstance(claims, dict) else {}


def placeholder_login(real: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Build the turn's login copy, with no real token, account or e-mail in it.

    Codex needs a ChatGPT login file of the right shape: JWT tokens whose
    claims give the plan and the expiry. The copy keeps the plan, the expiry
    and ``last_refresh``; every token is a fresh placeholder. The access
    token's signature part is this turn's random secret, which the proxy checks.

    Args:
        real: The user's parsed ``auth.json`` (a ChatGPT login).

    Returns:
        ``(copy, placeholder_access_token)``.
    """
    tokens = real.get("tokens") if isinstance(real.get("tokens"), dict) else {}
    access_claims = jwt_claims(tokens.get("access_token"))
    id_claims = jwt_claims(tokens.get("id_token"))
    plan = None
    for claims in (id_claims, access_claims):
        auth = claims.get(AUTH_CLAIM)
        if isinstance(auth, dict) and isinstance(auth.get("chatgpt_plan_type"), str):
            plan = auth["chatgpt_plan_type"]
            break
    auth_claim: dict[str, Any] = {"chatgpt_account_id": PLACEHOLDER_ACCOUNT}
    if plan is not None:
        auth_claim["chatgpt_plan_type"] = plan
    header = _b64url({"alg": "none", "typ": "JWT"})
    access = {AUTH_CLAIM: auth_claim}
    if isinstance(access_claims.get("exp"), int):
        access["exp"] = access_claims["exp"]
    identity = {"email": "turn@skynet.invalid", AUTH_CLAIM: auth_claim}
    if isinstance(id_claims.get("exp"), int):
        identity["exp"] = id_claims["exp"]
    placeholder = f"{header}.{_b64url(access)}.{secrets.token_urlsafe(32)}"
    copy: dict[str, Any] = {key: real[key] for key in ("auth_mode", "last_refresh") if key in real}
    copy["OPENAI_API_KEY"] = None
    copy["tokens"] = {
        "id_token": f"{header}.{_b64url(identity)}.{secrets.token_urlsafe(16)}",
        "access_token": placeholder,
        # Codex rejects a login file without the field, so it stays, but empty.
        "refresh_token": "",
        "account_id": PLACEHOLDER_ACCOUNT,
    }
    return copy, placeholder


def real_account(real: dict[str, Any]) -> str | None:
    """Find the ChatGPT account id of a login.

    Args:
        real: The user's parsed ``auth.json``.

    Returns:
        ``tokens.account_id``, else the access token's account claim, else None.
    """
    tokens = real.get("tokens") if isinstance(real.get("tokens"), dict) else {}
    account = tokens.get("account_id")
    if isinstance(account, str) and account:
        return account
    auth = jwt_claims(tokens.get("access_token")).get(AUTH_CLAIM)
    claimed = auth.get("chatgpt_account_id") if isinstance(auth, dict) else None
    return claimed if isinstance(claimed, str) and claimed else None


def _turn_certificate() -> tuple[bytes, ssl.SSLContext]:
    """Make a CA and a ``127.0.0.1`` server certificate for one turn.

    The CA key exists only inside this function. Python's ``ssl`` loads a key
    only from a file, so the server key passes through a private temp folder
    that the turn's Seatbelt profile hides and that is removed at once.

    Returns:
        ``(ca_pem, server_context)``.
    """
    now = datetime.datetime.now(datetime.UTC)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    server_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Skynet codex turn CA")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(False, False, False, False, False, True, True, False, False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, LOOPBACK)]))
        .issuer_name(ca_name)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(LOOPBACK))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    folder = Path(tempfile.mkdtemp(prefix="skynet-codex-proxy-"))
    try:
        chain = folder / "server.pem"
        chain.write_bytes(
            leaf.public_bytes(serialization.Encoding.PEM)
            + server_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            )
        )
        context.load_cert_chain(chain)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return ca.public_bytes(serialization.Encoding.PEM), context


def _upstream_connection() -> http.client.HTTPConnection:
    """Open the one upstream the proxy forwards to, with a verified certificate.

    Returns:
        An HTTPS connection to ``chatgpt.com:443``.
    """
    context = ssl.create_default_context(cafile=certifi.where())
    return http.client.HTTPSConnection(UPSTREAM_HOST, 443, context=context, timeout=UPSTREAM_TIMEOUT_SECONDS)


class _Server(http.server.ThreadingHTTPServer):
    """The proxy's HTTP server, carrying the real login for its handlers."""

    daemon_threads = True
    block_on_close = False

    def __init__(self, access_token: str, account_id: str | None, placeholder: str, context: ssl.SSLContext) -> None:
        """Bind a random loopback port.

        Args:
            access_token: The real access token.
            account_id: The real account id, or None.
            placeholder: This turn's placeholder access token.
            context: The turn's TLS server context.
        """
        super().__init__((LOOPBACK, 0), _Handler)
        self.access_token = access_token
        self.account_id = account_id
        self.expected = f"Bearer {placeholder}".encode()
        self.context = context
        self.stopping = False
        self._live: set[ssl.SSLSocket] = set()
        self._live_lock = threading.Lock()

    def close_connections(self) -> None:
        """Refuse new requests and close every accepted connection.

        The accept loop and the port stop separately; without this, a
        keep-alive connection would go on forwarding with the real token.
        """
        with self._live_lock:
            self.stopping = True
            live = list(self._live)
            self._live.clear()
        for connection in live:
            with contextlib.suppress(OSError):
                connection.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                connection.close()

    def finish_request(self, request: Any, client_address: Any) -> None:
        """Run the TLS handshake on the connection's own thread, then handle it.

        A client that connects and never completes the handshake then holds
        only its own thread, not the accept loop.

        Args:
            request: The accepted socket.
            client_address: The peer address.
        """
        assert isinstance(request, socket.socket)
        request.settimeout(HANDSHAKE_TIMEOUT_SECONDS)
        try:
            secured = self.context.wrap_socket(request, server_side=True)
        except (OSError, ssl.SSLError):
            return
        secured.settimeout(CLIENT_IDLE_TIMEOUT_SECONDS)
        with self._live_lock:
            if self.stopping:
                with contextlib.suppress(OSError):
                    secured.close()
                return
            self._live.add(secured)
        try:
            super().finish_request(secured, client_address)
        finally:
            with self._live_lock:
                self._live.discard(secured)
            with contextlib.suppress(OSError):
                secured.close()


class _Handler(http.server.BaseHTTPRequestHandler):
    """Check one codex request, forward it with the real login, stream the answer."""

    protocol_version = "HTTP/1.1"
    server: _Server

    def do_GET(self) -> None:
        """Forward an allowed GET."""
        self._forward()

    def do_POST(self) -> None:
        """Forward an allowed POST."""
        self._forward()

    def _refuse(self, status: int) -> None:
        """Answer with an empty error and close the connection.

        Args:
            status: The HTTP status.
        """
        self.close_connection = True
        self.send_response(status)
        self.send_header("content-length", "0")
        self.send_header("connection", "close")
        self.end_headers()
        # Linux answers a close with unread request bytes by a TCP reset, which can
        # destroy this reply before the client reads it. End the write side, then
        # drain what the client still sends until it closes or the timeout ends.
        with contextlib.suppress(OSError):
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(REFUSE_DRAIN_SECONDS)
            drained = 0
            while drained < MAX_BODY_BYTES and (chunk := self.connection.recv(65536)):
                drained += len(chunk)

    def _body(self) -> bytes | None:
        """Read the request body, plain or chunked.

        Returns:
            The body, or None when it is larger than :data:`MAX_BODY_BYTES`.
        """
        if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
            parts: list[bytes] = []
            total = 0
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    return b"".join(parts)
                total += size
                if total > MAX_BODY_BYTES:
                    return None
                parts.append(self.rfile.read(size))
                self.rfile.readline()
        length = int(self.headers.get("content-length") or 0)
        return None if length > MAX_BODY_BYTES else self.rfile.read(length)

    def _forward(self) -> None:
        """Run the checks, then forward the request and stream the response."""
        path = self.path.split("?", 1)[0]
        authorization = (self.headers.get("authorization") or "").encode()
        if not secrets.compare_digest(authorization, self.server.expected):
            logger.warning("Codex auth proxy: refused %s %s without the turn secret", self.command, path[:200])
            self._refuse(403)
            return
        if not self.path.startswith("/") or ".." in self.path or (self.command, path) not in ALLOWED_CALLS:
            logger.warning("Codex auth proxy: refused %s %s outside the allow-list", self.command, path[:200])
            self._refuse(404)
            return
        try:
            body = self._body()
        except ValueError:
            self._refuse(400)
            return
        if body is None:
            self._refuse(413)
            return
        headers = {name: value for name, value in self.headers.items() if name.lower() not in _DROPPED_REQUEST}
        headers["Host"] = UPSTREAM_HOST
        headers["Authorization"] = f"Bearer {self.server.access_token}"
        if self.server.stopping:
            self._refuse(503)
            return
        if self.server.account_id:
            headers["ChatGPT-Account-ID"] = self.server.account_id
        if self.command == "POST":
            headers["Content-Length"] = str(len(body))
        account_check = path == ACCOUNT_CHECK_PATH and bool(self.server.account_id)
        if account_check:
            # A plain body, so the account id in it can be swapped below.
            headers["Accept-Encoding"] = "identity"
        upstream = _upstream_connection()
        try:
            try:
                upstream.request(
                    self.command, self.path, body=body if self.command == "POST" else None, headers=headers
                )
                response = upstream.getresponse()
            except (OSError, http.client.HTTPException) as error:
                logger.warning("Codex auth proxy: %s %s failed upstream: %s", self.command, path, type(error).__name__)
                self._refuse(502)
                return
            logger.info("Codex auth proxy: %s %s -> %s", self.command, path, response.status)
            self.send_response(response.status, response.reason)
            for name, value in response.getheaders():
                if name.lower() not in _DROPPED_RESPONSE:
                    self.send_header(name, value)
            if account_check:
                # Codex picks the workspace whose id matches its login's account, and
                # the login copy names only the placeholder account.
                assert self.server.account_id is not None
                answer = response.read().replace(self.server.account_id.encode(), PLACEHOLDER_ACCOUNT.encode())
                self.send_header("content-length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)
                self.wfile.flush()
                return
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            # read1 returns what has arrived, so each SSE event reaches codex as it comes.
            while chunk := response.read1(65536):
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (OSError, http.client.HTTPException) as error:
            # The headers are out, so the stream just ends; codex reports the cut stream itself.
            logger.warning("Codex auth proxy: stream of %s ended early: %s", path, type(error).__name__)
            self.close_connection = True
        finally:
            upstream.close()

    def log_message(self, format: str, *args: Any) -> None:
        """Drop the default access log; :meth:`_forward` logs without headers or tokens.

        Args:
            format: Unused.
            *args: Unused.
        """


class CodexAuthProxy:
    """A loopback proxy for one codex turn; use it as a context manager."""

    def __init__(self, *, access_token: str, account_id: str | None, placeholder: str) -> None:
        """Keep the login for :meth:`__enter__`.

        Args:
            access_token: The real access token.
            account_id: The real ChatGPT account id, or None.
            placeholder: The placeholder access token in the turn's login copy.
        """
        self._login = (access_token, account_id, placeholder)
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None
        self.ca_pem = b""

    @property
    def port(self) -> int:
        """The bound port."""
        assert self._server is not None
        return int(self._server.server_address[1])

    @property
    def base_url(self) -> str:
        """The proxy's origin."""
        return f"https://{LOOPBACK}:{self.port}"

    def config_args(self) -> list[str]:
        """Return the codex ``-c`` overrides that send its calls to this proxy.

        ``openai_base_url`` carries the Responses and models calls and
        ``chatgpt_base_url`` the account calls. Codex first tries a WebSocket
        on ``GET .../responses``; the proxy refuses it, and codex then uses
        HTTP with SSE.

        Returns:
            Flags for ``codex exec``.
        """
        return [
            "-c",
            f'openai_base_url="{self.base_url}/backend-api/codex"',
            "-c",
            f'chatgpt_base_url="{self.base_url}/backend-api/"',
        ]

    def __enter__(self) -> CodexAuthProxy:
        """Start serving on a background thread.

        Returns:
            This proxy.
        """
        self.ca_pem, context = _turn_certificate()
        self._server = _Server(*self._login, context)
        self._thread = threading.Thread(target=self._server.serve_forever, name="codex-auth-proxy", daemon=True)
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Stop serving, close the port and close every open connection.

        Args:
            exc_type: Unused.
            exc: Unused.
            traceback: Unused.
        """
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server.close_connections()
        if self._thread is not None:
            self._thread.join(timeout=5)
