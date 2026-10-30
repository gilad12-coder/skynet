"""Tests for the Firecrawl-backed web tools of the generalist agent."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from pydantic import SecretStr

from core.config import settings
from core.service_gateway.agents import web_tools
from core.service_gateway.agents.generalist import GENERALIST_SYSTEM_PROMPT


def _install_transport(monkeypatch: pytest.MonkeyPatch, handler) -> list[httpx.Request]:
    """Route the module's httpx clients through ``handler`` and record requests.

    Args:
        monkeypatch: Pytest monkeypatch fixture.
        handler: Callable mapping a request to an ``httpx.Response``.

    Returns:
        The list the sent requests are appended to.
    """
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        """Record ``request`` and answer it with ``handler``.

        Args:
            request: The outgoing request.

        Returns:
            The handler's response.
        """
        seen.append(request)
        return handler(request)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        web_tools.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(record), **kwargs),
    )
    return seen


@pytest.fixture
def firecrawl_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a fake Firecrawl key for the test."""
    monkeypatch.setattr(settings, "firecrawl_api_key", SecretStr("fc-test"))


def test_no_key_offers_no_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a key the agent gets no web tools at all."""
    monkeypatch.setattr(settings, "firecrawl_api_key", None)
    assert web_tools.build_web_tools() == []


def test_no_key_call_fails_readably(monkeypatch: pytest.MonkeyPatch) -> None:
    """A direct call without a key names the missing setting instead of sending anything."""
    monkeypatch.setattr(settings, "firecrawl_api_key", None)
    seen = _install_transport(monkeypatch, lambda _req: httpx.Response(200, json={"success": True}))
    with pytest.raises(RuntimeError, match="FIRECRAWL_API_KEY"):
        asyncio.run(web_tools.web_search("anything"))
    assert seen == []


@pytest.mark.usefixtures("firecrawl_key")
def test_build_names_the_web_tools() -> None:
    """With a key the agent gets search, page reading and crawling."""
    assert {tool.name for tool in web_tools.build_web_tools()} == web_tools.WEB_TOOLS


@pytest.mark.usefixtures("firecrawl_key")
def test_search_returns_trimmed_results(monkeypatch: pytest.MonkeyPatch) -> None:
    """Search posts the query with a clamped limit and keeps title, url and snippet."""
    seen = _install_transport(
        monkeypatch,
        lambda _req: httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "web": [
                        {"url": "https://a.example", "title": "A", "description": "first", "extra": 1},
                        {"title": "no url"},
                    ]
                },
            },
        ),
    )
    results = asyncio.run(web_tools.web_search("dspy gepa", limit=50))
    assert results == [{"title": "A", "url": "https://a.example", "description": "first"}]
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v2/search"
    assert body == {"query": "dspy gepa", "limit": 10}
    assert seen[0].headers["authorization"] == "Bearer fc-test"


@pytest.mark.usefixtures("firecrawl_key")
def test_fetch_returns_markdown_and_truncates(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fetch scrapes the main content as markdown and flags a cut page."""
    long_page = "x" * (web_tools._MAX_PAGE_CHARS + 5)
    seen = _install_transport(
        monkeypatch,
        lambda _req: httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "markdown": long_page,
                    "metadata": {"title": ["Brief"], "url": "https://b.example/final"},
                },
            },
        ),
    )
    page = asyncio.run(web_tools.fetch_url(" https://b.example "))
    assert page["title"] == "Brief"
    assert page["url"] == "https://b.example/final"
    assert page["truncated"] is True
    assert len(page["markdown"]) == web_tools._MAX_PAGE_CHARS
    assert json.loads(seen[0].content) == {
        "url": "https://b.example",
        "formats": ["markdown"],
        "onlyMainContent": True,
    }


@pytest.mark.usefixtures("firecrawl_key")
def test_fetch_rejects_non_http_url() -> None:
    """Only http(s) URLs are sent to Firecrawl."""
    with pytest.raises(ValueError, match="http"):
        asyncio.run(web_tools.fetch_url("file:///etc/passwd"))


@pytest.mark.usefixtures("firecrawl_key")
@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/admin",
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://backend.staging.skynet.internal/",
        "http://printer.local/",
        "http:///no-host",
    ],
)
def test_fetch_and_crawl_refuse_internal_hosts(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    """Links to this machine, a private network or cloud metadata never reach Firecrawl."""
    seen = _install_transport(monkeypatch, lambda _req: httpx.Response(200, json={"success": True}))
    with pytest.raises(ValueError, match="public"):
        asyncio.run(web_tools.fetch_url(url))
    with pytest.raises(ValueError, match="public"):
        asyncio.run(web_tools.crawl_site(url))
    assert seen == []


@pytest.mark.usefixtures("firecrawl_key")
def test_firecrawl_failure_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Firecrawl error surfaces as a readable tool error."""
    _install_transport(
        monkeypatch,
        lambda _req: httpx.Response(402, json={"success": False, "error": "Payment required"}),
    )
    with pytest.raises(RuntimeError, match="Payment required"):
        asyncio.run(web_tools.web_search("anything"))


@pytest.mark.usefixtures("firecrawl_key")
def test_client_uses_a_bounded_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every Firecrawl call carries the module's request timeout."""
    timeouts: list[object] = []
    real_client = httpx.AsyncClient

    def client(**kwargs: object) -> httpx.AsyncClient:
        """Record the timeout and answer with an empty search.

        Args:
            **kwargs: The client's keyword arguments.

        Returns:
            A client on a mock transport.
        """
        timeouts.append(kwargs.get("timeout"))
        return real_client(
            transport=httpx.MockTransport(lambda _req: httpx.Response(200, json={"success": True, "data": {}})),
            **kwargs,
        )

    monkeypatch.setattr(web_tools.httpx, "AsyncClient", client)
    asyncio.run(web_tools.web_search("q"))
    assert timeouts == [web_tools._TIMEOUT_SECONDS]


def test_prompt_tells_agent_to_read_links() -> None:
    """The prompt directs the agent to read a given link and to crawl a site when one page is not enough."""
    assert "fetch_url" in GENERALIST_SYSTEM_PROMPT
    assert "web_search" in GENERALIST_SYSTEM_PROMPT
    assert "crawl_site" in GENERALIST_SYSTEM_PROMPT


@pytest.mark.usefixtures("firecrawl_key")
def test_crawl_polls_the_job_and_returns_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    """Crawl starts a job, polls it to completion and returns each page's markdown."""
    monkeypatch.setattr(web_tools, "_CRAWL_POLL_SECONDS", 0)
    polls = iter(
        [
            {"success": True, "status": "scraping", "data": []},
            {
                "success": True,
                "status": "completed",
                "data": [
                    {"markdown": "# Home", "metadata": {"title": "Home", "sourceURL": "https://s.example"}},
                    {"markdown": "y" * 5000, "metadata": {"title": "Docs", "url": "https://s.example/docs"}},
                ],
            },
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        """Start the job on POST and replay the poll script on GET.

        Args:
            request: The outgoing request.

        Returns:
            The scripted response.
        """
        if request.method == "POST":
            return httpx.Response(200, json={"success": True, "id": "job-1"})
        return httpx.Response(200, json=next(polls))

    seen = _install_transport(monkeypatch, handler)
    result = asyncio.run(web_tools.crawl_site("https://s.example", limit=99))
    assert result["status"] == "completed"
    assert [p["title"] for p in result["pages"]] == ["Home", "Docs"]
    assert result["pages"][1]["truncated"] is True
    assert len(result["pages"][1]["markdown"]) == web_tools._MAX_CRAWL_PAGE_CHARS
    assert json.loads(seen[0].content)["limit"] == web_tools._MAX_CRAWL_PAGES
    assert seen[1].url.path == "/v2/crawl/job-1"


@pytest.mark.usefixtures("firecrawl_key")
def test_crawl_returns_partial_pages_at_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    """A crawl still running at the deadline returns what finished, capped by the total budget."""
    monkeypatch.setattr(web_tools, "_CRAWL_WAIT_SECONDS", 0)
    pages = [{"markdown": "z" * 5000, "metadata": {"url": f"https://s.example/{i}"}} for i in range(20)]

    def handler(request: httpx.Request) -> httpx.Response:
        """Start the job on POST and report it still scraping on GET.

        Args:
            request: The outgoing request.

        Returns:
            The scripted response.
        """
        if request.method == "POST":
            return httpx.Response(200, json={"success": True, "id": "job-3"})
        return httpx.Response(200, json={"success": True, "status": "scraping", "data": pages})

    _install_transport(monkeypatch, handler)
    result = asyncio.run(web_tools.crawl_site("https://s.example"))
    assert result["status"] == "partial"
    assert result["truncated"] is True
    assert sum(len(p["markdown"]) for p in result["pages"]) == web_tools._MAX_CRAWL_TOTAL_CHARS


@pytest.mark.usefixtures("firecrawl_key")
def test_crawl_failure_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed crawl job surfaces as a tool error."""

    def handler(request: httpx.Request) -> httpx.Response:
        """Start the job on POST and report it failed on GET.

        Args:
            request: The outgoing request.

        Returns:
            The scripted response.
        """
        if request.method == "POST":
            return httpx.Response(200, json={"success": True, "id": "job-2"})
        return httpx.Response(200, json={"success": True, "status": "failed"})

    _install_transport(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="crawl"):
        asyncio.run(web_tools.crawl_site("https://s.example"))
