"""Tests for the DNS-over-HTTPS fallback of hosted API calls."""

from __future__ import annotations

import time

import httpx
import pytest

from .. import hosted_dns

URL = "https://api-staging.skynetml.com/desktop/link/token"


@pytest.fixture(autouse=True)
def _clean_cache():
    """Start and end each test with an empty resolver cache."""
    hosted_dns.clear_cache()
    yield
    hosted_dns.clear_cache()


class _Recorder(httpx.BaseTransport):
    """Inner transport that records each request and answers 200."""

    def __init__(self) -> None:
        """Start with no requests."""
        self.requests: list[httpx.Request] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Record ``request`` and answer 200.

        Args:
            request: The outgoing request.

        Returns:
            An empty 200 response.
        """
        self.requests.append(request)
        return httpx.Response(200)


def socket_error() -> OSError:
    """Return the error ``getaddrinfo`` raises for an unknown host."""
    return OSError(8, "nodename nor servname provided, or not known")


def _system_fails(host: str, port: int) -> None:
    """Act as a system resolver with no answer."""
    raise socket_error()


def _system_ok(host: str, port: int) -> None:
    """Act as a system resolver that answers."""


def _doh_never(host: str) -> tuple[str, float]:
    """Fail the test if the transport asks DNS over HTTPS."""
    raise AssertionError("DoH must not run")


def test_system_dns_answer_keeps_the_request_unchanged():
    """A working system resolver sends the request as it is."""
    inner = _Recorder()
    transport = hosted_dns.FallbackDnsTransport(inner, system=_system_ok, doh=_doh_never)
    with httpx.Client(transport=transport) as client:
        client.get(URL)
    sent = inner.requests[0]
    assert sent.url.host == "api-staging.skynetml.com"
    assert "sni_hostname" not in sent.extensions


def test_system_dns_failure_sends_to_the_doh_address_with_host_and_sni():
    """A failed system lookup connects to the DoH address and keeps the real name."""
    inner = _Recorder()
    transport = hosted_dns.FallbackDnsTransport(inner, system=_system_fails, doh=lambda host: ("3.18.86.253", 300.0))
    with httpx.Client(transport=transport) as client:
        client.post(URL, json={"a": 1})
    sent = inner.requests[0]
    assert sent.url.host == "3.18.86.253"
    assert sent.url.path == "/desktop/link/token"
    assert sent.headers["host"] == "api-staging.skynetml.com"
    assert sent.extensions["sni_hostname"] == "api-staging.skynetml.com"


def test_slow_system_dns_falls_back_after_the_wait(monkeypatch):
    """A system lookup slower than the wait falls back to DoH."""
    monkeypatch.setattr(hosted_dns, "SYSTEM_WAIT_SECONDS", 0.05)
    inner = _Recorder()
    transport = hosted_dns.FallbackDnsTransport(
        inner, system=lambda host, port: time.sleep(0.5), doh=lambda host: ("3.18.86.253", 300.0)
    )
    with httpx.Client(transport=transport) as client:
        client.get(URL)
    assert inner.requests[0].url.host == "3.18.86.253"


def test_cached_answer_skips_both_resolvers():
    """A second request reuses the DoH answer without any lookup."""
    calls: list[str] = []

    def doh(host: str) -> tuple[str, float]:
        """Answer once and count the call."""
        calls.append(host)
        return "3.18.86.253", 300.0

    inner = _Recorder()
    with httpx.Client(transport=hosted_dns.FallbackDnsTransport(inner, system=_system_fails, doh=doh)) as client:
        client.get(URL)
    second = hosted_dns.FallbackDnsTransport(inner, system=_system_fails, doh=_doh_never)
    with httpx.Client(transport=second) as client:
        client.get(URL)
    assert calls == ["api-staging.skynetml.com"]
    assert inner.requests[1].url.host == "3.18.86.253"


def test_expired_answer_skips_the_failed_system_resolver(monkeypatch):
    """After the answer expires, DoH runs again without a second system wait."""
    now = [1000.0]
    monkeypatch.setattr(hosted_dns, "_clock", lambda: now[0])
    system_calls: list[str] = []

    def system(host: str, port: int) -> None:
        """Fail and count the call."""
        system_calls.append(host)
        raise socket_error()

    inner = _Recorder()
    transport = hosted_dns.FallbackDnsTransport(inner, system=system, doh=lambda host: ("3.18.86.253", 60.0))
    with httpx.Client(transport=transport) as client:
        client.get(URL)
        now[0] += 61.0
        client.get(URL)
    assert system_calls == ["api-staging.skynetml.com"]


def test_doh_failure_keeps_the_original_request():
    """When DoH fails too, the request keeps its host and reports the system error."""
    inner = _Recorder()

    def doh(host: str) -> tuple[str, float]:
        """Fail like an unreachable DoH server."""
        raise httpx.ConnectError("unreachable")

    with httpx.Client(transport=hosted_dns.FallbackDnsTransport(inner, system=_system_fails, doh=doh)) as client:
        client.get(URL)
    assert inner.requests[0].url.host == "api-staging.skynetml.com"


@pytest.mark.parametrize("url", ["http://127.0.0.1:48100/health", "http://localhost:8000/x", "https://[::1]/x"])
def test_literal_hosts_skip_lookup(url):
    """IP addresses and localhost need no lookup."""
    inner = _Recorder()
    transport = hosted_dns.FallbackDnsTransport(inner, system=_system_fails, doh=_doh_never)
    with httpx.Client(transport=transport) as client:
        client.get(url)
    assert "sni_hostname" not in inner.requests[0].extensions


def test_doh_lookup_reads_only_a_records(monkeypatch):
    """The DoH answer parser skips CNAME records and returns the first A record."""
    body = {
        "Answer": [
            {"name": "api-staging.skynetml.com", "type": 5, "TTL": 300, "data": "elb.example.com."},
            {"name": "elb.example.com", "type": 1, "TTL": 60, "data": "3.18.86.253"},
        ]
    }

    def fake_get(url, **kwargs):
        """Answer the DoH query with ``body``."""
        assert kwargs["params"] == {"name": "api-staging.skynetml.com", "type": "A"}
        return httpx.Response(200, json=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(hosted_dns.httpx, "get", fake_get)
    assert hosted_dns.doh_lookup("api-staging.skynetml.com") == ("3.18.86.253", 60.0)


def test_doh_lookup_without_a_record_raises(monkeypatch):
    """An answer with no A record raises LookupError."""
    monkeypatch.setattr(
        hosted_dns.httpx,
        "get",
        lambda url, **kwargs: httpx.Response(200, json={"Status": 3}, request=httpx.Request("GET", url)),
    )
    with pytest.raises(LookupError):
        hosted_dns.doh_lookup("missing.example.com")
