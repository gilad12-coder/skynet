"""Fetch wheel artifacts through a registry-scoped, credential-free parent capability."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import threading
from collections.abc import Callable, Mapping
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpx
from packaging.utils import canonicalize_name, parse_wheel_filename

from .mcp_broker import _pinned_address, _PinnedTransport
from .model_dispatch import ModelHTTPResult

_MAX_INDEX_BYTES = 8 * 1024 * 1024
_MAX_WHEEL_BYTES = 256 * 1024 * 1024
_CHUNK_BYTES = 2 * 1024 * 1024


class _Links(HTMLParser):
    """Collect wheel links without executing registry HTML."""

    def __init__(self) -> None:
        """Initialize the index's link list."""
        super().__init__()
        self.links: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Collect anchors from a simple-index response.

        Args:
            tag: HTML element name.
            attrs: Element attributes supplied by the registry.
        """
        if tag == "a":
            self.links.append({key: value or "" for key, value in attrs})


class PackageBroker:
    """Limit package traffic to one selected index and its advertised wheel artifacts."""

    def __init__(
        self,
        registry: str,
        *,
        check_admission: Callable[[], None],
        allow_private: bool = False,
        artifacts: list[dict[str, Any]] | None = None,
    ) -> None:
        """Bind a registry or an existing exact artifact lock to this execution.

        Args:
            registry: Account-selected HTTPS simple-index URL.
            check_admission: Owning budget generation and cancellation check.
            allow_private: Deployment permission for private registry addresses.
            artifacts: Previously pinned wheels; omit to permit index resolution.
        """
        parsed = urlsplit(registry)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Package registries require an HTTPS simple-index URL without credentials.")
        self.registry = registry.rstrip("/")
        self._check = check_admission
        self._private = allow_private
        self._locked = artifacts is not None
        self._artifacts: dict[str, dict[str, str]] = {}
        self._cache: dict[str, bytes] = {}
        self._guard = threading.Lock()
        self._total = 0
        for artifact in artifacts or []:
            self._register(str(artifact["url"]), str(artifact["sha256"]), str(artifact["filename"]))

    def _register(self, url: str, digest: str, filename: str) -> str:
        """Register a wheel using its content digest as an opaque download handle.

        Args:
            url: Advertised HTTPS wheel location.
            digest: Exact SHA-256 supplied by the index or saved lock.
            filename: Wheel filename parsed by pip.

        Returns:
            Content-addressed artifact handle.
        """
        origin = urlsplit(url)
        if origin.scheme != "https" or origin.username is not None or origin.password is not None or origin.fragment:
            raise ValueError("Wheel URLs must use HTTPS without embedded credentials.")
        if not re.fullmatch(r"[a-fA-F0-9]{64}", digest) or "/" in filename or "\\" in filename:
            raise ValueError("Registry wheels must include a SHA-256 integrity hash.")
        parse_wheel_filename(filename)
        digest = digest.lower()
        self._artifacts[digest] = {"url": url, "sha256": digest, "filename": filename}
        return digest

    async def _fetch(self, url: str, limit: int) -> bytes:
        """Download bounded bytes while pinning DNS and refusing redirects.

        Args:
            url: Registry-selected endpoint.
            limit: Maximum response size in bytes.

        Returns:
            Verified transport bytes, never executable host code.
        """
        self._check()
        address = _pinned_address(url, self._private, label="package registry")
        async with (
            httpx.AsyncClient(
                transport=_PinnedTransport(url, address),
                timeout=60,
                trust_env=False,
                follow_redirects=False,
            ) as client,
            client.stream("GET", url, headers={"Accept": "text/html"}) as response,
        ):
            if response.status_code != 200:
                raise ValueError(f"Package registry returned HTTP {response.status_code}.")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                self._check()
                size += len(chunk)
                if size > limit:
                    raise ValueError("Package download exceeds the supported size.")
                chunks.append(chunk)
            return b"".join(chunks)

    def dispatch(self, body: Mapping[str, Any]) -> ModelHTTPResult:
        """Serve a package index or bounded chunk from an authorized wheel.

        Args:
            body: Index project name or registered artifact digest and chunk offset.

        Returns:
            JSON metadata or base64 wheel chunk through the existing sandbox mailbox.
        """
        self._check()
        with self._guard:
            if body.get("action") == "index" and not self._locked:
                project = body.get("project")
                if not isinstance(project, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", project):
                    raise ValueError("Invalid package name.")
                name = canonicalize_name(project)
                url = f"{self.registry}/{name}/"
                parser = _Links()
                parser.feed(asyncio.run(self._fetch(url, _MAX_INDEX_BYTES)).decode("utf-8"))
                links = []
                for item in parser.links:
                    target = urlsplit(urljoin(url, item.get("href", "")))
                    filename = unquote(target.path.rsplit("/", 1)[-1])
                    if not filename.endswith(".whl") or "data-yanked" in item:
                        continue
                    distribution, _version, _build, _tags = parse_wheel_filename(filename)
                    if canonicalize_name(distribution) != name:
                        continue
                    if not target.fragment.startswith("sha256="):
                        continue
                    digest = self._register(
                        urlunsplit(target._replace(fragment="")),
                        target.fragment[7:],
                        filename,
                    )
                    links.append({**self._artifacts[digest], "requires_python": item.get("data-requires-python", "")})
                result: Any = {"artifacts": links}
            elif body.get("action") == "wheel":
                digest = body.get("sha256")
                offset = body.get("offset", 0)
                if digest not in self._artifacts or type(offset) is not int or offset < 0:
                    raise ValueError("Unknown package artifact or invalid chunk offset.")
                if digest not in self._cache:
                    data = asyncio.run(self._fetch(self._artifacts[digest]["url"], _MAX_WHEEL_BYTES))
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise ValueError("Package artifact failed its SHA-256 integrity check.")
                    if self._total + len(data) > 512 * 1024 * 1024:
                        raise ValueError("The dependency set exceeds the supported download size.")
                    self._total += len(data)
                    self._cache[digest] = data
                data = self._cache[digest]
                result = {"data": base64.b64encode(data[offset : offset + _CHUNK_BYTES]).decode(), "size": len(data)}
            else:
                raise ValueError("Unsupported package operation.")
        return ModelHTTPResult(200, "application/json", json.dumps(result).encode())
