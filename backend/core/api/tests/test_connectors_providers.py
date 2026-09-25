"""Tests for the generic connectors (Google Sheets, GitHub, S3, GCS, Azure Blob,
Kaggle, Google Drive, OneDrive, SQL sources, LLM observability and Notion).

Every outbound call is mocked at the :mod:`httpx` boundary inside
:mod:`core.connectors.transport`, so the tests cover the request signing
(SigV4 against AWS's published vector, Azure Shared Key), credential
validation and storage, the browse/preview/import round-trips through the
shared routes, and the generic OAuth start/callback pair.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from ...config import settings
from ...connectors import azure_blob, github, oauth, s3, sql_base, tabular
from ...connectors.registry import oauth_config_problems
from ...connectors.vault import ConnectorVault
from ...storage.dataset_library import DatasetLibraryStore, PostgresDatasetBlobStore
from ...storage.models import UserConnectorModel
from .test_connectors_router import _make_client, _response, vault_key  # noqa: F401 - fixture re-export

CSV = b"name,score\nada,1\nbob,2\n"
JSONL = b'{"name": "ada", "score": 1}\n{"name": "bob", "score": 2}\n'


@pytest.fixture
def generic_oauth_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hide the Google, Microsoft, GitHub and Notion OAuth buttons unless a test opts in."""
    for name in ("google_oauth_client_id", "google_oauth_client_secret", "github_oauth_client_id"):
        monkeypatch.setattr(settings, name, None)
    monkeypatch.setattr(settings, "github_oauth_client_secret", None)
    monkeypatch.setattr(settings, "microsoft_oauth_client_id", None)
    monkeypatch.setattr(settings, "microsoft_oauth_client_secret", None)
    monkeypatch.setattr(settings, "notion_oauth_client_id", None)
    monkeypatch.setattr(settings, "notion_oauth_client_secret", None)
    monkeypatch.setattr(settings, "google_oauth_redirect_uri", None)
    monkeypatch.setattr(settings, "microsoft_oauth_redirect_uri", None)
    monkeypatch.setattr(settings, "github_oauth_redirect_uri", None)
    monkeypatch.setattr(settings, "notion_oauth_redirect_uri", None)


class _StreamCtx:
    """Minimal stand-in for ``httpx.stream`` yielding fixed bytes."""

    def __init__(self, payload: bytes, status: int = 200) -> None:
        """Remember the bytes to stream.

        Args:
            payload: Body to yield.
            status: Status code to report.
        """
        self._payload = payload
        self.status_code = status

    def __enter__(self) -> _StreamCtx:
        """Enter the context, returning the fake response."""
        return self

    def __exit__(self, *_exc: object) -> None:
        """Leave the context."""

    def iter_bytes(self):
        """Yield the body in one chunk."""
        yield self._payload


def _parquet_bytes(rows: list[dict[str, Any]]) -> bytes:
    """Serialise rows to a parquet file in memory.

    Args:
        rows: Records to write.

    Returns:
        The parquet bytes.
    """
    sink = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows), sink)
    return sink.getvalue()


def _service_account_json() -> str:
    """Mint a syntactically valid service-account key with a fresh RSA key.

    Returns:
        The JSON text a user would paste.
    """
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "proj-1",
            "client_email": "bot@proj-1.iam.gserviceaccount.com",
            "private_key": pem,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


def test_tabular_parses_each_supported_format() -> None:
    """CSV, TSV, JSON (bare or enveloped), JSONL and Parquet all decode to row dicts."""
    expected = [{"name": "ada", "score": "1"}, {"name": "bob", "score": "2"}]
    assert tabular.parse_table(CSV, "a.csv").rows == expected
    assert tabular.parse_table(b"name\tscore\nada\t1\nbob\t2\n", "a.tsv").rows == expected
    typed = [{"name": "ada", "score": 1}, {"name": "bob", "score": 2}]
    assert tabular.parse_table(json.dumps(typed).encode(), "a.json").rows == typed
    assert tabular.parse_table(json.dumps({"data": typed}).encode(), "a.json").rows == typed
    assert tabular.parse_table(JSONL, "a.jsonl").rows == typed
    parquet = tabular.parse_table(_parquet_bytes(typed), "a.parquet")
    assert parquet.rows == typed
    assert parquet.column_schema["column_order"] == ["name", "score"]
    truncated = tabular.parse_table(b"name,score\nada,1\nbo", "a.csv", limit=20, truncated=True)
    assert truncated.rows == [{"name": "ada", "score": "1"}]
    with pytest.raises(Exception, match="file_unsupported"):
        tabular.parse_table(b'{"no": "list"}', "a.json")


def test_s3_sigv4_matches_aws_published_example() -> None:
    """The signer reproduces the GET-object example from the SigV4 documentation."""
    headers = s3.sign_request(
        "GET",
        "https://examplebucket.s3.amazonaws.com/test.txt",
        access_key="AKIAIOSFODNN7EXAMPLE",
        secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region="us-east-1",
        headers={"Range": "bytes=0-9"},
        now=datetime(2013, 5, 24, tzinfo=UTC),
    )
    assert headers["Authorization"].endswith(
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
    assert "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date" in headers["Authorization"]


def test_azure_connection_parsing_and_shared_key_string() -> None:
    """Connection strings and SAS URLs normalise; the string-to-sign has the documented shape."""
    parsed = azure_blob.parse_connection(
        "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=QUJD;EndpointSuffix=core.windows.net"
    )
    assert parsed == {
        "account": "acct",
        "endpoint": "https://acct.blob.core.windows.net",
        "key": "QUJD",
        "sas": "",
        "container": "",
    }
    sas = azure_blob.parse_connection("https://acct.blob.core.windows.net/data?sv=2021&sig=abc")
    assert sas["sas"] == "sv=2021&sig=abc"
    assert sas["container"] == "data"
    with pytest.raises(Exception, match="invalid_credentials"):
        azure_blob.parse_connection("AccountName=acct")
    text = azure_blob.string_to_sign(
        "GET",
        "acct",
        "/c",
        {"restype": "container", "comp": "list"},
        {"x-ms-version": "V", "x-ms-date": "D", "Range": "bytes=0-9"},
    )
    assert (
        text == "GET\n\n\n\n\n\n\n\n\n\n\nbytes=0-9\nx-ms-date:D\nx-ms-version:V\n/acct/c\ncomp:list\nrestype:container"
    )


def test_status_lists_every_provider(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """A fresh user sees every provider unlinked, OAuth hidden everywhere."""
    body = _make_client()[0].get("/connectors").json()
    assert [c["provider"] for c in body["connectors"]] == [
        "huggingface",
        "kaggle",
        "google_sheets",
        "google_drive",
        "onedrive",
        "github",
        "s3",
        "gcs",
        "azure_blob",
        "postgres",
        "mysql",
        "bigquery",
        "snowflake",
        "langfuse",
        "langsmith",
        "braintrust",
        "notion",
    ]
    assert all(c["connected"] is False and c["oauth_available"] is False for c in body["connectors"])


def test_unknown_provider_and_unlinked_provider(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Unknown slugs 404; browsing before linking 409s with the provider's name."""
    client, _ = _make_client()
    assert client.get("/connectors/dropbox/browse").json()["code"] == "connectors.unknown_provider"
    response = client.get("/connectors/github/browse")
    assert response.status_code == 409
    assert response.json()["params"]["provider"] == "GitHub"


def _github_api(method: str, url: str, **kwargs: Any) -> httpx.Response:
    """Route mocked GitHub API calls by path.

    Args:
        method: HTTP method.
        url: Request URL.
        **kwargs: Ignored request options.

    Returns:
        The canned response.
    """
    path = urlparse(url).path
    if path == "/user":
        return _response(200, {"login": "octo"})
    if path == "/user/repos":
        return _response(200, [{"full_name": "octo/data", "pushed_at": "2026-01-01T00:00:00Z"}])
    if path == "/repos/octo/data/contents/":
        return _response(
            200,
            [
                {"type": "dir", "name": "raw", "path": "raw"},
                {"type": "file", "name": "train.csv", "path": "train.csv", "size": len(CSV)},
                {"type": "file", "name": "README.md", "path": "README.md", "size": 10},
            ],
        )
    if path == "/repos/octo/data/contents/train.csv":
        return _response(200, {"type": "file", "name": "train.csv", "path": "train.csv", "size": len(CSV)})
    raise AssertionError(f"unexpected call {method} {url}")


def test_github_token_browse_preview_and_import(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """A PAT is verified, stored encrypted, and drives browse, preview and import."""
    client, store = _make_client()
    with patch("core.connectors.transport.httpx.request", side_effect=_github_api):
        saved = client.put("/connectors/github/credentials", json={"fields": {"token": "ghp_secret"}})
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "github")
        assert entry == {**entry, "connected": True, "account_label": "octo", "auth_method": "token"}

        root = client.get("/connectors/github/browse").json()["entries"]
        assert root == [
            {
                "ref": "octo/data",
                "name": "octo/data",
                "kind": "folder",
                "size": None,
                "modified": "2026-01-01T00:00:00Z",
            }
        ]
        tree = client.get("/connectors/github/browse", params={"location": "octo/data"}).json()["entries"]
        assert [(e["name"], e["kind"]) for e in tree] == [("raw", "folder"), ("train.csv", "file")]

        with patch("core.connectors.transport.httpx.stream", return_value=_StreamCtx(CSV)) as stream:
            preview = client.get("/connectors/github/preview", params={"ref": "octo/data/train.csv"}).json()
            assert preview["columns"] == [{"name": "name", "type": "string"}, {"name": "score", "type": "string"}]
            assert preview["rows"][0] == {"name": "ada", "score": "1"}
            assert stream.call_args.kwargs["headers"]["Range"].startswith("bytes=0-")
            assert stream.call_args.kwargs["headers"]["Accept"] == "application/vnd.github.raw+json"

            imported = client.post("/connectors/github/import", json={"ref": "octo/data/train.csv"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "data/train.csv"
    assert imported.json()["dataset"]["source"] == "github"
    library = DatasetLibraryStore(store.engine, PostgresDatasetBlobStore(store.engine))
    assert library.get_rows(imported.json()["dataset"]["id"]) == [
        {"name": "ada", "score": "1"},
        {"name": "bob", "score": "2"},
    ]


def test_github_import_refuses_oversized_file_before_download(
    vault_key: str,  # noqa: F811
    generic_oauth_off: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The contents metadata size is checked against the cap before any bytes move."""
    monkeypatch.setattr(settings, "dataset_max_file_bytes", 4)
    client, _ = _make_client()
    with (
        patch("core.connectors.transport.httpx.request", side_effect=_github_api),
        patch("core.connectors.transport.httpx.stream") as stream,
    ):
        client.put("/connectors/github/credentials", json={"fields": {"token": "ghp_secret"}})
        response = client.post("/connectors/github/import", json={"ref": "octo/data/train.csv"})
    assert response.status_code == 413
    assert response.json()["code"] == "connectors.import_too_large"
    stream.assert_not_called()


@pytest.mark.usefixtures("vault_key", "generic_oauth_off")
def test_github_oauth_start_and_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    """The generic OAuth pair mints PKCE state and stores the exchanged token."""
    monkeypatch.setattr(settings, "github_oauth_client_id", "gh-client")
    monkeypatch.setattr(settings, "github_oauth_client_secret", SecretStr("gh-secret"))
    monkeypatch.setattr(settings, "app_public_url", "https://app.example")
    client, store = _make_client()
    statuses = {c["provider"]: c["oauth_available"] for c in client.get("/connectors").json()["connectors"]}
    assert statuses["github"] is True
    assert statuses["google_sheets"] is False

    assert client.post("/connectors/s3/oauth/start").status_code == 404
    start = client.post("/connectors/github/oauth/start")
    assert start.status_code == 200, start.text
    url = urlparse(start.json()["authorize_url"])
    assert url.netloc == "github.com"
    query = parse_qs(url.query)
    assert query["client_id"] == ["gh-client"]
    assert query["redirect_uri"] == ["http://testserver/connectors/github/oauth/callback"]
    state = query["state"][0]

    token_body = {"access_token": "gho_1", "token_type": "bearer", "scope": "repo,read:user"}
    with (
        patch("core.connectors.oauth.httpx.post", return_value=_response(200, token_body)) as post,
        patch("core.connectors.transport.httpx.request", side_effect=_github_api),
    ):
        callback = client.get(
            "/connectors/github/oauth/callback", params={"code": "c-1", "state": state}, follow_redirects=False
        )
    assert callback.status_code == 303
    assert callback.headers["location"] == "https://app.example/?settings=connectors"
    assert post.call_args.kwargs["data"]["client_secret"] == "gh-secret"
    secret = ConnectorVault(store.engine).resolve("alice", "github")
    assert secret.access_token == "gho_1"
    assert secret.auth_method == "oauth"

    forged = client.get(
        "/connectors/google_sheets/oauth/callback", params={"code": "c", "state": state}, follow_redirects=False
    )
    assert forged.headers["location"].endswith("connector_error=connectors.oauth_state_invalid")


S3_LIST = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>lake</Name><Prefix></Prefix><Delimiter>/</Delimiter>
  <Contents><Key>events.jsonl</Key><Size>60</Size><LastModified>2026-02-02T00:00:00.000Z</LastModified></Contents>
  <Contents><Key>notes.txt</Key><Size>5</Size></Contents>
  <CommonPrefixes><Prefix>archive/</Prefix></CommonPrefixes>
</ListBucketResult>"""


def test_s3_credentials_browse_and_import(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Keys pinned to a bucket are verified by listing it; objects browse and import signed."""
    client, store = _make_client()
    calls: list[tuple[str, str, dict[str, str]]] = []

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the bucket listing and the HEAD, recording each signed call."""
        calls.append((method, url, kwargs["headers"]))
        if method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(JSONL))}, request=httpx.Request("HEAD", url))
        return _response(200, content=S3_LIST)

    fields = {"access_key_id": "AKIAEXAMPLE", "secret_access_key": "s3cr3t", "region": "eu-west-1", "bucket": "lake"}
    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put("/connectors/s3/credentials", json={"fields": fields})
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "s3")
        assert entry["account_label"] == "lake"
        assert entry["auth_method"] == "credentials"
        assert calls[0][1] == "https://lake.s3.eu-west-1.amazonaws.com/?delimiter=%2F&list-type=2&max-keys=1000&prefix="
        assert calls[0][2]["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/")

        assert client.get("/connectors/s3/browse").json()["entries"] == [
            {"ref": "lake", "name": "lake", "kind": "folder", "size": None, "modified": None}
        ]
        listing = client.get("/connectors/s3/browse", params={"location": "lake/"}).json()["entries"]
        assert [(e["ref"], e["kind"], e["size"]) for e in listing] == [
            ("lake/archive/", "folder", None),
            ("lake/events.jsonl", "file", 60),
        ]

        with patch("core.connectors.transport.httpx.stream", return_value=_StreamCtx(JSONL)) as stream:
            imported = client.post("/connectors/s3/import", json={"ref": "lake/events.jsonl", "name": "Events"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "Events"
    assert stream.call_args.args[1] == "https://lake.s3.eu-west-1.amazonaws.com/events.jsonl"
    assert "Authorization" in stream.call_args.kwargs["headers"]
    with Session(store.engine) as session:
        row = session.scalars(select(UserConnectorModel).where(UserConnectorModel.provider == "s3")).one()
        assert b"s3cr3t" not in row.secret_ciphertext
    secret = ConnectorVault(store.engine).resolve("alice", "s3")
    assert json.loads(secret.access_token)["secret_access_key"] == "s3cr3t"


AZURE_LIST = b"""<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ServiceEndpoint="https://acct.blob.core.windows.net/" ContainerName="data">
  <Blobs>
    <BlobPrefix><Name>2026/</Name></BlobPrefix>
    <Blob><Name>users.csv</Name><Properties><Last-Modified>Mon, 02 Feb 2026 00:00:00 GMT</Last-Modified><Content-Length>17</Content-Length></Properties></Blob>
  </Blobs>
</EnumerationResults>"""


def test_azure_sas_url_browse_uses_sas_not_signature(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """A container-scoped SAS URL lists blobs with the SAS on the query and no Authorization."""
    client, _ = _make_client()
    seen: list[tuple[str, dict[str, str]]] = []

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the blob listing, recording the URL and headers."""
        seen.append((url, kwargs["headers"]))
        return _response(200, content=AZURE_LIST)

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put(
            "/connectors/azure_blob/credentials",
            json={"fields": {"connection": "https://acct.blob.core.windows.net/data?sv=2021-08-06&sig=abc"}},
        )
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "azure_blob")
        assert entry["account_label"] == "acct/data"
        listing = client.get("/connectors/azure_blob/browse", params={"location": "data/"}).json()["entries"]
    assert [(e["ref"], e["kind"]) for e in listing] == [("data/2026/", "folder"), ("data/users.csv", "file")]
    url, headers = seen[-1]
    assert url.startswith("https://acct.blob.core.windows.net/data?restype=container&comp=list")
    assert url.endswith("&sv=2021-08-06&sig=abc")
    assert "Authorization" not in headers
    assert headers["x-ms-version"] == azure_blob.API_VERSION


def test_azure_shared_key_signs_requests(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """An account-key connection string yields a SharedKey Authorization header."""
    client, _ = _make_client()
    seen: list[dict[str, str]] = []

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve an empty container listing, recording headers."""
        seen.append(kwargs["headers"])
        return _response(200, content=b"<EnumerationResults><Containers/></EnumerationResults>")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put(
            "/connectors/azure_blob/credentials",
            json={"fields": {"connection": "AccountName=acct;AccountKey=QUJDREVG;EndpointSuffix=core.windows.net"}},
        )
    assert saved.status_code == 200, saved.text
    assert seen[0]["Authorization"].startswith("SharedKey acct:")


def test_gcs_service_account_verifies_and_browses(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """A service-account key mints a storage token, lists buckets and stores the e-mail label."""
    client, _ = _make_client()

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the bucket and object listings."""
        assert kwargs["headers"]["Authorization"] == "Bearer sa-token"
        path = urlparse(url).path
        if path == "/storage/v1/b":
            assert kwargs["params"]["project"] == "proj-1"
            return _response(200, {"items": [{"name": "warehouse", "timeCreated": "2026-01-01T00:00:00Z"}]})
        if path == "/storage/v1/b/warehouse/o":
            return _response(
                200, {"prefixes": ["raw/"], "items": [{"name": "t.parquet", "size": "123", "updated": "u"}]}
            )
        raise AssertionError(url)

    with (
        patch("core.connectors.gcs.service_account_token", return_value="sa-token"),
        patch("core.connectors.transport.httpx.request", side_effect=fake_request),
    ):
        saved = client.put(
            "/connectors/gcs/credentials", json={"fields": {"service_account_json": _service_account_json()}}
        )
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "gcs")
        assert entry["account_label"] == "bot@proj-1.iam.gserviceaccount.com"
        assert entry["auth_method"] == "service_account"
        root = client.get("/connectors/gcs/browse").json()["entries"]
        assert root[0]["ref"] == "warehouse"
        objects = client.get("/connectors/gcs/browse", params={"location": "warehouse/"}).json()["entries"]
    assert [(e["ref"], e["kind"], e["size"]) for e in objects] == [
        ("warehouse/raw/", "folder", None),
        ("warehouse/t.parquet", "file", 123),
    ]
    bad = client.put("/connectors/gcs/credentials", json={"fields": {"service_account_json": "{}"}})
    assert bad.status_code == 400
    assert bad.json()["code"] == "connectors.invalid_credentials"


def test_google_sheets_browse_preview_and_import(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Spreadsheets list from Drive, tabs from Sheets, and a tab imports with its header row."""
    client, _ = _make_client()

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve Drive and Sheets responses by path."""
        path = urlparse(url).path
        if path == "/drive/v3/files":
            assert "name contains 'sales'" in kwargs["params"]["q"]
            return _response(200, {"files": [{"id": "sid1", "name": "Sales 2026", "modifiedTime": "m"}]})
        if path == "/v4/spreadsheets/sid1":
            return _response(200, {"sheets": [{"properties": {"title": "Q1", "gridProperties": {"rowCount": 3}}}]})
        if path.startswith("/v4/spreadsheets/sid1/values/"):
            return _response(200, {"values": [["Region", ""], ["North", 10], [], ["South"]]})
        raise AssertionError(url)

    with (
        patch("core.connectors.google_sheets.service_account_token", return_value="sa-token"),
        patch("core.connectors.transport.httpx.request", side_effect=fake_request),
    ):
        saved = client.put(
            "/connectors/google_sheets/credentials", json={"fields": {"service_account_json": _service_account_json()}}
        )
        assert saved.status_code == 200, saved.text
        root = client.get("/connectors/google_sheets/browse", params={"search": "sales"}).json()["entries"]
        assert root == [{"ref": "sid1", "name": "Sales 2026", "kind": "folder", "size": None, "modified": "m"}]
        tabs = client.get("/connectors/google_sheets/browse", params={"location": "sid1"}).json()["entries"]
        assert tabs == [{"ref": "sid1/Q1", "name": "Q1", "kind": "file", "size": 3, "modified": None}]
        preview = client.get("/connectors/google_sheets/preview", params={"ref": "sid1/Q1"}).json()
        assert preview["columns"] == [{"name": "Region", "type": "string"}, {"name": "column_2", "type": "string"}]
        assert preview["rows"] == [{"Region": "North", "column_2": 10}, {"Region": "South", "column_2": None}]
        imported = client.post("/connectors/google_sheets/import", json={"ref": "sid1/Q1"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "Q1"
    assert imported.json()["dataset"]["source"] == "google_sheets"


@pytest.mark.usefixtures("vault_key", "generic_oauth_off")
def test_generic_oauth_token_refresh_marks_expired_grants(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stale OAuth grant is refreshed before use, and a refused refresh surfaces as expired."""
    monkeypatch.setattr(settings, "github_oauth_client_id", "gh-client")
    client, store = _make_client()
    vault = ConnectorVault(store.engine)
    vault.save(
        "alice",
        "github",
        access_token="old",
        auth_method="oauth",
        account_label="octo",
        refresh_token="rt",
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    with patch(
        "core.connectors.oauth.httpx.post", return_value=_response(200, {"access_token": "new", "expires_in": 3600})
    ):
        assert oauth.current_oauth_token(github.oauth_app(), vault, "alice") == "new"
    assert vault.resolve("alice", "github").access_token == "new"
    vault.save(
        "alice",
        "github",
        access_token="old",
        auth_method="oauth",
        account_label="octo",
        refresh_token="rt",
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    with patch("core.connectors.oauth.httpx.post", return_value=_response(400, {"error": "bad_refresh_token"})):
        response = client.get("/connectors/github/browse")
    assert response.status_code == 409
    assert response.json()["code"] == "connectors.expired"
    assert vault.get("alice", "github").status == "invalid"


def _basic(header: str) -> str:
    """Decode a Basic auth header.

    Args:
        header: The ``Authorization`` value.

    Returns:
        ``user:secret``.
    """
    assert header.startswith("Basic ")
    return base64.b64decode(header.removeprefix("Basic ")).decode()


def test_kaggle_browse_and_import_unzips(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """The kaggle.json pair is stored, datasets list mine-then-hottest, and a zipped file unpacks."""
    client, store = _make_client()
    zipped = io.BytesIO()
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("train.csv", CSV)

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Kaggle listings."""
        assert _basic(kwargs["headers"]["Authorization"]) == "ada:key-1"
        path = urlparse(url).path
        if path == "/api/v1/datasets/list":
            if kwargs["params"].get("user") == "ada":
                return _response(200, [{"ref": "ada/mine", "title": "Mine", "totalBytes": 10}])
            return _response(200, [{"ref": "ada/mine", "title": "Mine"}, {"ref": "zoo/cats", "title": "Cats"}])
        if path == "/api/v1/datasets/list/zoo/cats":
            return _response(
                200, {"datasetFiles": [{"name": "train.csv", "totalBytes": 30}, {"name": "notes.txt", "totalBytes": 3}]}
            )
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put("/connectors/kaggle/credentials", json={"fields": {"username": "ada", "key": "key-1"}})
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "kaggle")
        assert (entry["account_label"], entry["auth_method"]) == ("ada", "credentials")
        root = client.get("/connectors/kaggle/browse").json()["entries"]
        assert [(e["ref"], e["name"], e["size"]) for e in root] == [
            ("ada/mine", "Mine", 10),
            ("zoo/cats", "Cats", None),
        ]
        files = client.get("/connectors/kaggle/browse", params={"location": "zoo/cats"}).json()["entries"]
        assert [(e["ref"], e["size"]) for e in files] == [("zoo/cats/train.csv", 30)]
        with patch("core.connectors.transport.httpx.stream", return_value=_StreamCtx(zipped.getvalue())) as stream:
            preview = client.get("/connectors/kaggle/preview", params={"ref": "zoo/cats/train.csv"}).json()
            assert preview["rows"] == [{"name": "ada", "score": "1"}, {"name": "bob", "score": "2"}]
            assert stream.call_args.args[1].endswith("/datasets/download/zoo/cats/train.csv")
            imported = client.post("/connectors/kaggle/import", json={"ref": "zoo/cats/train.csv"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "cats/train.csv"
    library = DatasetLibraryStore(store.engine, PostgresDatasetBlobStore(store.engine))
    assert len(library.get_rows(imported.json()["dataset"]["id"])) == 2


def test_notion_database_flattens_properties(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """A Notion database's pages become rows, title column first, cursor paging honoured."""
    client, store = _make_client()
    page = {
        "properties": {
            "Score": {"type": "number", "number": 3},
            "Tags": {"type": "multi_select", "multi_select": [{"name": "a"}, {"name": "b"}]},
            "Name": {"type": "title", "title": [{"plain_text": "First "}, {"plain_text": "row"}]},
        }
    }

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Notion API."""
        assert kwargs["headers"]["Authorization"] == "Bearer ntn_1"
        assert kwargs["headers"]["Notion-Version"]
        path = urlparse(url).path
        if path == "/v1/users/me":
            return _response(200, {"bot": {"workspace_name": "Acme"}})
        if path == "/v1/search":
            assert kwargs["json"]["filter"] == {"property": "object", "value": "database"}
            return _response(200, {"results": [{"id": "db1", "title": [{"plain_text": "Evals"}]}]})
        if path == "/v1/databases/db1":
            return _response(200, {"title": [{"plain_text": "Evals"}], "properties": page["properties"]})
        if path == "/v1/databases/db1/query":
            if kwargs["json"].get("start_cursor") == "c2":
                return _response(200, {"results": [page], "has_more": False, "next_cursor": None})
            return _response(200, {"results": [page], "has_more": True, "next_cursor": "c2"})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put("/connectors/notion/credentials", json={"fields": {"token": "ntn_1"}})
        assert saved.status_code == 200, saved.text
        assert next(c for c in saved.json()["connectors"] if c["provider"] == "notion")["account_label"] == "Acme"
        root = client.get("/connectors/notion/browse").json()["entries"]
        assert [(e["ref"], e["name"], e["kind"]) for e in root] == [("db1", "Evals", "file")]
        preview = client.get("/connectors/notion/preview", params={"ref": "db1"}).json()
        assert [c["name"] for c in preview["columns"]] == ["Name", "Score", "Tags"]
        assert preview["rows"][0] == {"Name": "First row", "Score": 3, "Tags": "a, b"}
        imported = client.post("/connectors/notion/import", json={"ref": "db1"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "Evals"
    library = DatasetLibraryStore(store.engine, PostgresDatasetBlobStore(store.engine))
    assert len(library.get_rows(imported.json()["dataset"]["id"])) == 2


def test_langfuse_traces_flatten_input_and_output(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Traces page through ``meta.totalPages`` and nested input/output spread into columns."""
    client, store = _make_client()
    trace = {"id": "t1", "name": "chat", "input": {"q": "hi"}, "output": "hello", "tags": ["a"], "latency": 1.5}

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Langfuse public API."""
        assert _basic(kwargs["headers"]["Authorization"]) == "pk:sk"
        parsed = urlparse(url)
        assert parsed.netloc == "langfuse.example.com"
        if parsed.path == "/api/public/projects":
            return _response(200, {"data": [{"name": "demo"}]})
        if parsed.path == "/api/public/v2/datasets":
            return _response(200, {"data": [{"name": "golden", "updatedAt": "2026-01-01"}]})
        if parsed.path == "/api/public/traces":
            page = kwargs["params"]["page"]
            return _response(200, {"data": [trace], "meta": {"page": page, "totalPages": 2}})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put(
            "/connectors/langfuse/credentials",
            json={"fields": {"public_key": "pk", "secret_key": "sk", "host": "langfuse.example.com/"}},
        )
        assert saved.status_code == 200, saved.text
        assert next(c for c in saved.json()["connectors"] if c["provider"] == "langfuse")["account_label"] == "demo"
        root = client.get("/connectors/langfuse/browse").json()["entries"]
        assert [e["ref"] for e in root] == ["traces", "generations", "dataset/golden"]
        preview = client.get("/connectors/langfuse/preview", params={"ref": "traces"}).json()
        assert preview["rows"][0] == {
            "id": "t1",
            "name": "chat",
            "input.q": "hi",
            "output": "hello",
            "tags": '["a"]',
            "latency": 1.5,
        }
        imported = client.post("/connectors/langfuse/import", json={"ref": "traces"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "langfuse-traces"
    library = DatasetLibraryStore(store.engine, PostgresDatasetBlobStore(store.engine))
    assert len(library.get_rows(imported.json()["dataset"]["id"])) == 2


def test_langsmith_runs_query_and_datasets(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Projects open into root/LLM run views; runs are queried by POST with a cursor."""
    client, _ = _make_client()
    run = {"id": "r1", "name": "agent", "run_type": "chain", "inputs": {"q": "hi"}, "outputs": {"a": "yo"}}

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the LangSmith API."""
        assert kwargs["headers"]["x-api-key"] == "lsv2_key"
        path = urlparse(url).path
        if path == "/api/v1/sessions":
            return _response(200, [{"id": "p1", "name": "prod"}])
        if path == "/api/v1/tenants/current":
            return _response(200, {"display_name": "Team"})
        if path == "/api/v1/datasets":
            return _response(200, [{"id": "d1", "name": "golden", "example_count": 5}])
        if path == "/api/v1/runs/query":
            assert method == "POST"
            assert kwargs["json"]["session"] == ["p1"]
            assert kwargs["json"]["run_type"] == "llm"
            if kwargs["json"].get("cursor") == "n1":
                return _response(200, {"runs": [run], "cursors": {"next": None}})
            return _response(200, {"runs": [run], "cursors": {"next": "n1"}})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put("/connectors/langsmith/credentials", json={"fields": {"api_key": "lsv2_key"}})
        assert saved.status_code == 200, saved.text
        assert next(c for c in saved.json()["connectors"] if c["provider"] == "langsmith")["account_label"] == "Team"
        root = client.get("/connectors/langsmith/browse").json()["entries"]
        assert [(e["ref"], e["kind"], e["size"]) for e in root] == [
            ("project/p1", "folder", None),
            ("dataset/d1", "file", 5),
        ]
        views = client.get("/connectors/langsmith/browse", params={"location": "project/p1"}).json()["entries"]
        assert [e["ref"] for e in views] == ["project/p1/runs", "project/p1/llm"]
        preview = client.get("/connectors/langsmith/preview", params={"ref": "project/p1/llm"}).json()
    assert preview["rows"][0] == {"id": "r1", "name": "agent", "run_type": "chain", "inputs.q": "hi", "outputs.a": "yo"}
    assert len(preview["rows"]) == 2


def test_braintrust_experiment_fetch_follows_cursor(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Projects list logs, experiments and datasets; fetch pages until the cursor runs out."""
    client, _ = _make_client()
    event = {"id": "e1", "input": "q", "output": "a", "expected": "a", "scores": {"exact": 1}}

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Braintrust API."""
        assert kwargs["headers"]["Authorization"] == "Bearer bt_key"
        path = urlparse(url).path
        if path == "/v1/project":
            return _response(200, {"objects": [{"id": "p1", "name": "assistant"}]})
        if path == "/v1/organization":
            return _response(200, {"objects": [{"name": "Acme"}]})
        if path == "/v1/experiment":
            return _response(200, {"objects": [{"id": "x1", "name": "run-3"}]})
        if path == "/v1/dataset":
            return _response(200, {"objects": []})
        if path == "/v1/experiment/x1/fetch":
            if kwargs["params"].get("cursor") == "c1":
                return _response(200, {"events": [event], "cursor": None})
            return _response(200, {"events": [event], "cursor": "c1"})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put("/connectors/braintrust/credentials", json={"fields": {"api_key": "bt_key"}})
        assert saved.status_code == 200, saved.text
        assert next(c for c in saved.json()["connectors"] if c["provider"] == "braintrust")["account_label"] == "Acme"
        root = client.get("/connectors/braintrust/browse").json()["entries"]
        assert [(e["ref"], e["kind"]) for e in root] == [("project/p1", "folder")]
        inside = client.get("/connectors/braintrust/browse", params={"location": "project/p1"}).json()["entries"]
        assert [(e["ref"], e["name"]) for e in inside] == [("project/p1/logs", "Logs"), ("experiment/x1", "run-3")]
        preview = client.get("/connectors/braintrust/preview", params={"ref": "experiment/x1"}).json()
    assert preview["rows"] == [
        {"id": "e1", "input": "q", "output": "a", "expected": "a", "scores.exact": 1},
        {"id": "e1", "input": "q", "output": "a", "expected": "a", "scores.exact": 1},
    ]


def test_postgres_url_normalises_and_reads_tables(
    vault_key: str,  # noqa: F811
    generic_oauth_off: None,
    tmp_path: Path,
) -> None:
    """A ``postgres://`` URL is pinned to our driver; browse, preview and import go through SQLAlchemy."""
    client, store = _make_client()
    # The connector disposes of the engine after every call, so the table has to outlive a pool.
    engine = create_engine(f"sqlite:///{tmp_path / 'source.db'}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE scores (name TEXT, score INTEGER, note BLOB)"))
        connection.execute(text("INSERT INTO scores VALUES ('ada', 1, X'00'), ('bob', 2, NULL)"))

    assert (
        sql_base.normalise_url(
            "postgres://u:p@db.example.com:5432/app", {"postgres": "postgresql+psycopg2"}, "postgres"
        )
        == "postgresql+psycopg2://u:p@db.example.com:5432/app"
    )
    with pytest.raises(Exception, match="invalid_credentials"):
        sql_base.normalise_url("mysql://u:p@h/db", {"postgres": "postgresql+psycopg2"}, "postgres")

    with patch("core.connectors.sql_base.make_engine", return_value=engine):
        saved = client.put(
            "/connectors/postgres/credentials", json={"fields": {"url": "postgres://u:p@db.example.com/app"}}
        )
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "postgres")
        assert entry["account_label"] == "u@db.example.com/app"
        assert (
            ConnectorVault(store.engine)
            .resolve("alice", "postgres")
            .access_token.startswith("postgresql+psycopg2://u:p@")
        )
        schemas = client.get("/connectors/postgres/browse").json()["entries"]
        assert [(e["ref"], e["kind"]) for e in schemas] == [("main", "folder")]
        tables = client.get("/connectors/postgres/browse", params={"location": "main"}).json()["entries"]
        assert [(e["ref"], e["kind"]) for e in tables] == [("main.scores", "file")]
        preview = client.get("/connectors/postgres/preview", params={"ref": "main.scores"}).json()
        assert [c["name"] for c in preview["columns"]] == ["name", "score", "note"]
        assert preview["rows"] == [
            {"name": "ada", "score": 1, "note": "AA=="},
            {"name": "bob", "score": 2, "note": None},
        ]
        missing = client.get("/connectors/postgres/preview", params={"ref": "main.nope"})
        assert missing.status_code == 404
        imported = client.post("/connectors/postgres/import", json={"ref": "main.scores"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "scores"
    assert imported.json()["dataset"]["source"] == "postgres"


def test_bigquery_decodes_nested_rows(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Datasets and tables list; ``tabledata.list`` rows decode typed, nested and repeated fields."""
    client, _ = _make_client()
    schema = {
        "fields": [
            {"name": "n", "type": "INTEGER"},
            {"name": "ok", "type": "BOOLEAN"},
            {"name": "tags", "type": "STRING", "mode": "REPEATED"},
            {"name": "meta", "type": "RECORD", "fields": [{"name": "k", "type": "STRING"}]},
        ]
    }
    row = {"f": [{"v": "7"}, {"v": "true"}, {"v": [{"v": "a"}, {"v": "b"}]}, {"v": {"f": [{"v": "x"}]}}]}

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the BigQuery REST API."""
        assert kwargs["headers"]["Authorization"] == "Bearer bq-token"
        path = urlparse(url).path
        if path == "/bigquery/v2/projects/proj-1/datasets":
            return _response(200, {"datasets": [{"datasetReference": {"datasetId": "analytics"}}]})
        if path == "/bigquery/v2/projects/proj-1/datasets/analytics/tables":
            return _response(200, {"tables": [{"tableReference": {"tableId": "events"}, "creationTime": "1"}]})
        if path == "/bigquery/v2/projects/proj-1/datasets/analytics/tables/events":
            return _response(200, {"schema": schema, "type": "TABLE"})
        if path == "/bigquery/v2/projects/proj-1/datasets/analytics/tables/events/data":
            return _response(200, {"rows": [row]})
        raise AssertionError(f"unexpected call {method} {url}")

    with (
        patch("core.connectors.bigquery.service_account_token", return_value="bq-token"),
        patch("core.connectors.transport.httpx.request", side_effect=fake_request),
    ):
        saved = client.put(
            "/connectors/bigquery/credentials", json={"fields": {"service_account_json": _service_account_json()}}
        )
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "bigquery")
        assert entry["account_label"] == "bot@proj-1.iam.gserviceaccount.com (proj-1)"
        assert [e["ref"] for e in client.get("/connectors/bigquery/browse").json()["entries"]] == ["analytics"]
        tables = client.get("/connectors/bigquery/browse", params={"location": "analytics"}).json()["entries"]
        assert [(e["ref"], e["kind"]) for e in tables] == [("analytics.events", "file")]
        preview = client.get("/connectors/bigquery/preview", params={"ref": "analytics.events"}).json()
        bad = client.get("/connectors/bigquery/preview", params={"ref": "analytics.`x`"})
    assert preview["rows"] == [{"n": 7, "ok": True, "tags": '["a", "b"]', "meta": '{"k": "x"}'}]
    assert bad.status_code == 400


def test_snowflake_statements_and_partitions(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Linking runs ``CURRENT_USER()``, browsing uses SHOW, and reads drain every partition."""
    client, _ = _make_client()

    def result(columns: list[tuple[str, str]], rows: list[list[Any]], partitions: int = 1) -> dict[str, Any]:
        """Shape a SQL API result set."""
        return {
            "statementHandle": "h1",
            "resultSetMetaData": {
                "rowType": [{"name": n, "type": t, "scale": 0} for n, t in columns],
                "partitionInfo": [{"rowCount": 1}] * partitions,
            },
            "data": rows,
        }

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Snowflake SQL API."""
        assert kwargs["headers"]["Authorization"] == "Bearer pat-1"
        assert kwargs["headers"]["X-Snowflake-Authorization-Token-Type"] == "PROGRAMMATIC_ACCESS_TOKEN"
        parsed = urlparse(url)
        assert parsed.netloc == "xy123.eu-central-1.snowflakecomputing.com"
        if method == "POST":
            statement = kwargs["json"]["statement"]
            assert kwargs["json"]["warehouse"] == "WH"
            if statement.startswith("SELECT CURRENT_USER()"):
                return _response(200, result([("USER", "text")], [["ADA"]]))
            if statement == "SHOW TERSE DATABASES":
                return _response(200, result([("name", "text")], [["SALES"]]))
            if statement == 'SHOW TERSE SCHEMAS IN DATABASE "SALES"':
                return _response(200, result([("name", "text")], [["PUBLIC"], ["INFORMATION_SCHEMA"]]))
            if statement == 'SHOW TABLES IN SCHEMA "SALES"."PUBLIC"':
                return _response(200, result([("name", "text"), ("rows", "fixed")], [["ORDERS", "2"]]))
            if statement == 'SHOW VIEWS IN SCHEMA "SALES"."PUBLIC"':
                return _response(200, result([("name", "text")], []))
            if statement == 'SELECT * FROM "SALES"."PUBLIC"."ORDERS" LIMIT 20':
                return _response(200, result([("ID", "fixed"), ("PAID", "boolean")], [["1", "true"]], partitions=2))
            raise AssertionError(statement)
        if parsed.path == "/api/v2/statements/h1" and kwargs["params"] == {"partition": 1}:
            return _response(200, {"data": [["2", "false"]]})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        saved = client.put(
            "/connectors/snowflake/credentials",
            json={"fields": {"account": "XY123.eu-central-1", "token": "pat-1", "warehouse": "WH"}},
        )
        assert saved.status_code == 200, saved.text
        entry = next(c for c in saved.json()["connectors"] if c["provider"] == "snowflake")
        assert entry["account_label"] == "ADA@xy123.eu-central-1"
        assert [e["ref"] for e in client.get("/connectors/snowflake/browse").json()["entries"]] == ["SALES"]
        schemas = client.get("/connectors/snowflake/browse", params={"location": "SALES"}).json()["entries"]
        assert [e["ref"] for e in schemas] == ["SALES.PUBLIC"]
        tables = client.get("/connectors/snowflake/browse", params={"location": "SALES.PUBLIC"}).json()["entries"]
        assert [(e["ref"], e["size"]) for e in tables] == [("SALES.PUBLIC.ORDERS", 2)]
        preview = client.get("/connectors/snowflake/preview", params={"ref": "SALES.PUBLIC.ORDERS"}).json()
    assert preview["rows"] == [{"ID": 1, "PAID": True}, {"ID": 2, "PAID": False}]


def test_google_drive_browses_and_exports_sheets(vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """The top level merges My Drive and shared files; a Google Sheet previews through CSV export."""
    client, _ = _make_client()

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the Drive API."""
        assert kwargs["headers"]["Authorization"] == "Bearer sa-token"
        path = urlparse(url).path
        if path == "/drive/v3/files":
            query = kwargs["params"]["q"]
            if "sharedWithMe" in query:
                return _response(
                    200,
                    {
                        "files": [
                            {"id": "f1", "name": "raw.csv", "mimeType": "text/csv", "size": "30"},
                            {"id": "d1", "name": "data", "mimeType": "application/vnd.google-apps.folder"},
                            {"id": "s1", "name": "Sheet", "mimeType": "application/vnd.google-apps.spreadsheet"},
                            {"id": "x1", "name": "photo.png", "mimeType": "image/png"},
                        ]
                    },
                )
            assert query.startswith("('d1' in parents)")
            return _response(200, {"files": []})
        if path == "/drive/v3/files/s1":
            return _response(200, {"id": "s1", "name": "Sheet", "mimeType": "application/vnd.google-apps.spreadsheet"})
        raise AssertionError(f"unexpected call {method} {url}")

    with (
        patch("core.connectors.google_drive.service_account_token", return_value="sa-token"),
        patch("core.connectors.transport.httpx.request", side_effect=fake_request),
    ):
        saved = client.put(
            "/connectors/google_drive/credentials", json={"fields": {"service_account_json": _service_account_json()}}
        )
        assert saved.status_code == 200, saved.text
        root = client.get("/connectors/google_drive/browse").json()["entries"]
        assert [(e["ref"], e["kind"], e["size"]) for e in root] == [
            ("d1", "folder", None),
            ("f1", "file", 30),
            ("s1", "file", None),
        ]
        assert client.get("/connectors/google_drive/browse", params={"location": "d1"}).json()["entries"] == []
        with patch("core.connectors.transport.httpx.stream", return_value=_StreamCtx(CSV)) as stream:
            preview = client.get("/connectors/google_drive/preview", params={"ref": "s1"}).json()
    assert preview["rows"][0] == {"name": "ada", "score": "1"}
    assert stream.call_args.args[1].endswith("/files/s1/export")
    assert stream.call_args.kwargs["params"] == {"mimeType": "text/csv"}


def test_onedrive_is_oauth_only_and_browses_graph(
    vault_key: str,  # noqa: F811
    generic_oauth_off: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pasted credentials are refused; a stored OAuth grant browses and downloads through Graph."""
    monkeypatch.setattr(settings, "microsoft_oauth_client_id", "ms-client")
    client, store = _make_client()
    refused = client.put("/connectors/onedrive/credentials", json={"fields": {"token": "x"}})
    assert refused.status_code == 400
    status = next(c for c in client.get("/connectors").json()["connectors"] if c["provider"] == "onedrive")
    assert status["oauth_available"] is True
    ConnectorVault(store.engine).save(
        "alice", "onedrive", access_token="ms-token", auth_method="oauth", account_label="ada@example.com"
    )

    def fake_request(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve Microsoft Graph."""
        assert kwargs["headers"]["Authorization"] == "Bearer ms-token"
        path = urlparse(url).path
        if path == "/v1.0/me/drive/root/children":
            return _response(
                200,
                {
                    "value": [
                        {"id": "i1", "name": "train.jsonl", "size": 40, "file": {}},
                        {"id": "i2", "name": "Docs", "folder": {"childCount": 1}},
                        {"id": "i3", "name": "slides.pptx", "size": 9, "file": {}},
                    ]
                },
            )
        if path == "/v1.0/me/drive/items/i1":
            return _response(200, {"id": "i1", "name": "train.jsonl", "size": 40})
        raise AssertionError(f"unexpected call {method} {url}")

    with patch("core.connectors.transport.httpx.request", side_effect=fake_request):
        root = client.get("/connectors/onedrive/browse").json()["entries"]
        assert [(e["ref"], e["kind"]) for e in root] == [("i2", "folder"), ("i1", "file")]
        with patch("core.connectors.transport.httpx.stream", return_value=_StreamCtx(JSONL)) as stream:
            imported = client.post("/connectors/onedrive/import", json={"ref": "i1"})
    assert imported.status_code == 200, imported.text
    assert imported.json()["dataset"]["name"] == "train.jsonl"
    assert stream.call_args.args[1].endswith("/me/drive/items/i1/content")


def _start_oauth(client: Any, provider: str, fields: dict[str, str] | None = None) -> dict[str, list[str]]:
    """Start a provider's OAuth flow and return the authorize URL's query.

    Args:
        client: The test client.
        provider: Provider slug.
        fields: Optional pre-sign-in fields.

    Returns:
        The parsed query string, plus ``_host`` and ``_path`` of the URL.
    """
    start = client.post(f"/connectors/{provider}/oauth/start", json={"fields": fields} if fields else None)
    assert start.status_code == 200, start.text
    url = urlparse(start.json()["authorize_url"])
    return {**parse_qs(url.query), "_host": [url.netloc], "_path": [url.path]}


def _finish_oauth(client: Any, provider: str, state: str, token_body: dict[str, Any], api: Any) -> Any:
    """Run the callback with a mocked token endpoint and provider API.

    Args:
        client: The test client.
        provider: Provider slug.
        state: The state minted at start.
        token_body: What the token endpoint returns.
        api: Side effect serving ``transport.httpx.request``.

    Returns:
        The mock of ``oauth.httpx.post`` for asserting the exchange.
    """
    with (
        patch("core.connectors.oauth.httpx.post", return_value=_response(200, token_body)) as post,
        patch("core.connectors.transport.httpx.request", side_effect=api),
    ):
        callback = client.get(
            f"/connectors/{provider}/oauth/callback", params={"code": "c-1", "state": state}, follow_redirects=False
        )
    assert callback.status_code == 303
    assert "connector_error" not in callback.headers["location"], callback.headers["location"]
    return post


@pytest.fixture
def google_oauth_on(monkeypatch: pytest.MonkeyPatch, vault_key: str, generic_oauth_off: None) -> None:  # noqa: F811
    """Register a Google OAuth client with a Sheets callback to derive the others from."""
    monkeypatch.setattr(settings, "google_oauth_client_id", "g-client")
    monkeypatch.setattr(settings, "google_oauth_client_secret", SecretStr("g-secret"))
    monkeypatch.setattr(
        settings, "google_oauth_redirect_uri", "https://api.example/connectors/google_sheets/oauth/callback"
    )


def test_gcs_oauth_lists_projects_then_buckets(google_oauth_on: None) -> None:
    """Continue with Google on GCS asks for storage read, then browses projects and buckets with the user token."""
    client, store = _make_client()
    statuses = {c["provider"]: c["oauth_available"] for c in client.get("/connectors").json()["connectors"]}
    assert statuses["gcs"] is True
    assert statuses["bigquery"] is True
    assert statuses["s3"] is False
    query = _start_oauth(client, "gcs")
    assert query["_host"] == ["accounts.google.com"]
    assert query["client_id"] == ["g-client"]
    assert query["redirect_uri"] == ["https://api.example/connectors/gcs/oauth/callback"]
    scopes = query["scope"][0].split()
    assert "https://www.googleapis.com/auth/devstorage.read_only" in scopes
    assert {"openid", "email"} <= set(scopes)

    def api(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve userinfo, Resource Manager and the bucket listing."""
        assert kwargs["headers"]["Authorization"] == "Bearer ya29.gcs"
        parts = urlparse(url)
        if parts.path == "/oauth2/v3/userinfo":
            return _response(200, {"email": "ada@example.com"})
        if parts.netloc == "cloudresourcemanager.googleapis.com":
            return _response(200, {"projects": [{"projectId": "proj-1", "name": "Proj One"}]})
        if parts.path == "/storage/v1/b":
            assert kwargs["params"]["project"] == "proj-1"
            return _response(200, {"items": [{"name": "warehouse"}]})
        raise AssertionError(url)

    token = {"access_token": "ya29.gcs", "refresh_token": "r", "expires_in": 3600, "token_type": "Bearer"}
    post = _finish_oauth(client, "gcs", query["state"][0], token, api)
    assert post.call_args.kwargs["data"]["client_secret"] == "g-secret"
    assert post.call_args.kwargs["data"]["code_verifier"]
    secret = ConnectorVault(store.engine).resolve("alice", "gcs")
    assert (secret.access_token, secret.auth_method) == ("ya29.gcs", "oauth")
    with patch("core.connectors.transport.httpx.request", side_effect=api):
        root = client.get("/connectors/gcs/browse").json()["entries"]
        assert [(e["ref"], e["name"]) for e in root] == [("project:proj-1", "Proj One")]
        buckets = client.get("/connectors/gcs/browse", params={"location": "project:proj-1"}).json()["entries"]
    assert [e["ref"] for e in buckets] == ["warehouse"]
    entry = next(c for c in client.get("/connectors").json()["connectors"] if c["provider"] == "gcs")
    assert entry["account_label"] == "ada@example.com"


def test_bigquery_oauth_browses_projects_and_reads_with_user_token(google_oauth_on: None) -> None:
    """A user-token BigQuery link picks a project first; refs carry it through preview."""
    client, _ = _make_client()
    query = _start_oauth(client, "bigquery")
    assert query["redirect_uri"] == ["https://api.example/connectors/bigquery/oauth/callback"]
    assert "https://www.googleapis.com/auth/bigquery.readonly" in query["scope"][0].split()
    schema = {"fields": [{"name": "n", "type": "INTEGER"}]}

    def api(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve userinfo and the BigQuery REST API for a domain-scoped project."""
        assert kwargs["headers"]["Authorization"] == "Bearer ya29.bq"
        path = urlparse(url).path
        base = "/bigquery/v2/projects"
        if path == "/oauth2/v3/userinfo":
            return _response(200, {"email": "ada@example.com"})
        if path == base:
            return _response(200, {"projects": [{"projectReference": {"projectId": "acme.com:lab"}}]})
        if path == f"{base}/acme.com%3Alab/datasets" or path == f"{base}/acme.com:lab/datasets":
            return _response(200, {"datasets": [{"datasetReference": {"datasetId": "analytics"}}]})
        if path.endswith("/datasets/analytics/tables"):
            return _response(200, {"tables": [{"tableReference": {"tableId": "events"}}]})
        if path.endswith("/datasets/analytics/tables/events"):
            assert "acme.com" in path
            return _response(200, {"schema": schema, "type": "TABLE"})
        if path.endswith("/datasets/analytics/tables/events/data"):
            return _response(200, {"rows": [{"f": [{"v": "7"}]}]})
        raise AssertionError(f"unexpected call {method} {url}")

    token = {"access_token": "ya29.bq", "refresh_token": "r", "expires_in": 3600, "token_type": "Bearer"}
    _finish_oauth(client, "bigquery", query["state"][0], token, api)
    with patch("core.connectors.transport.httpx.request", side_effect=api):
        projects = client.get("/connectors/bigquery/browse").json()["entries"]
        assert [(e["ref"], e["kind"]) for e in projects] == [("acme.com:lab", "folder")]
        datasets = client.get("/connectors/bigquery/browse", params={"location": "acme.com:lab"}).json()["entries"]
        assert [e["ref"] for e in datasets] == ["acme.com:lab/analytics"]
        tables = client.get("/connectors/bigquery/browse", params={"location": "acme.com:lab/analytics"}).json()[
            "entries"
        ]
        assert [e["ref"] for e in tables] == ["acme.com:lab/analytics.events"]
        preview = client.get("/connectors/bigquery/preview", params={"ref": "acme.com:lab/analytics.events"}).json()
        bad = client.get("/connectors/bigquery/browse", params={"location": "a b/analytics"})
    assert preview["rows"] == [{"n": 7}]
    assert bad.status_code == 400


def test_azure_blob_oauth_names_account_and_uses_bearer(
    monkeypatch: pytest.MonkeyPatch,
    vault_key: str,  # noqa: F811
    generic_oauth_off: None,
) -> None:
    """The storage account named before sign-in rides the state; blob calls carry the user's bearer."""
    monkeypatch.setattr(settings, "microsoft_oauth_client_id", "ms-client")
    monkeypatch.setattr(settings, "microsoft_oauth_client_secret", SecretStr("ms-secret"))
    monkeypatch.setattr(
        settings, "microsoft_oauth_redirect_uri", "https://api.example/connectors/onedrive/oauth/callback"
    )
    client, store = _make_client()
    bad = client.post("/connectors/azure_blob/oauth/start", json={"fields": {"account": "Not_Valid!"}})
    assert bad.status_code == 400
    assert bad.json()["code"] == "connectors.invalid_credentials"
    assert client.post("/connectors/azure_blob/oauth/start").status_code == 400
    query = _start_oauth(client, "azure_blob", {"account": "acct", "container": "data"})
    assert query["_host"] == ["login.microsoftonline.com"]
    assert query["redirect_uri"] == ["https://api.example/connectors/azure_blob/oauth/callback"]
    assert query["scope"] == ["https://storage.azure.com/user_impersonation offline_access openid email"]
    seen: list[tuple[str, dict[str, str]]] = []

    def api(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve the blob listing, recording each call."""
        seen.append((url, kwargs["headers"]))
        return _response(200, content=AZURE_LIST)

    token = {"access_token": "eyJ.azure", "refresh_token": "r", "expires_in": 3600, "token_type": "Bearer"}
    post = _finish_oauth(client, "azure_blob", query["state"][0], token, api)
    assert post.call_args.kwargs["data"]["client_secret"] == "ms-secret"
    assert seen == []
    entry = next(c for c in client.get("/connectors").json()["connectors"] if c["provider"] == "azure_blob")
    assert (entry["account_label"], entry["auth_method"]) == ("acct/data", "oauth")
    with patch("core.connectors.transport.httpx.request", side_effect=api):
        root = client.get("/connectors/azure_blob/browse").json()["entries"]
        assert [e["ref"] for e in root] == ["data"]
        listing = client.get("/connectors/azure_blob/browse", params={"location": "data/"}).json()["entries"]
    assert [(e["ref"], e["kind"]) for e in listing] == [("data/2026/", "folder"), ("data/users.csv", "file")]
    url, headers = seen[-1]
    assert url.startswith("https://acct.blob.core.windows.net/data?restype=container&comp=list")
    assert headers["Authorization"] == "Bearer eyJ.azure"
    assert headers["x-ms-version"] >= "2020-04-08"
    assert "sig=" not in url
    assert ConnectorVault(store.engine).resolve("alice", "azure_blob").account_label == "acct/data"


def test_notion_oauth_exchanges_with_basic_auth_json(
    monkeypatch: pytest.MonkeyPatch,
    vault_key: str,  # noqa: F811
    generic_oauth_off: None,
) -> None:
    """Notion's token call is JSON with the client in HTTP Basic auth and no PKCE verifier."""
    monkeypatch.setattr(settings, "notion_oauth_client_id", "n-client")
    monkeypatch.setattr(settings, "notion_oauth_client_secret", SecretStr("n-secret"))
    client, store = _make_client()
    statuses = {c["provider"]: c["oauth_available"] for c in client.get("/connectors").json()["connectors"]}
    assert statuses["notion"] is True
    query = _start_oauth(client, "notion")
    assert (query["_host"], query["_path"]) == (["api.notion.com"], ["/v1/oauth/authorize"])
    assert query["owner"] == ["user"]
    assert query["client_id"] == ["n-client"]
    assert query["redirect_uri"] == ["http://testserver/connectors/notion/oauth/callback"]
    assert "scope" not in query

    def api(method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Serve ``/users/me`` for the workspace label."""
        assert kwargs["headers"]["Authorization"] == "Bearer ntn_oauth"
        assert urlparse(url).path == "/v1/users/me"
        return _response(200, {"bot": {"workspace_name": "Acme"}})

    token = {"access_token": "ntn_oauth", "token_type": "bearer", "workspace_name": "Acme", "bot_id": "b"}
    post = _finish_oauth(client, "notion", query["state"][0], token, api)
    assert post.call_args.args[0] == "https://api.notion.com/v1/oauth/token"
    assert post.call_args.kwargs["auth"] == ("n-client", "n-secret")
    body = post.call_args.kwargs["json"]
    assert body["grant_type"] == "authorization_code"
    assert body["code"] == "c-1"
    assert body["redirect_uri"] == "http://testserver/connectors/notion/oauth/callback"
    assert "code_verifier" not in body
    assert "client_secret" not in body
    assert "data" not in post.call_args.kwargs
    secret = ConnectorVault(store.engine).resolve("alice", "notion")
    assert (secret.access_token, secret.auth_method, secret.expires_at) == ("ntn_oauth", "oauth", None)
    entry = next(c for c in client.get("/connectors").json()["connectors"] if c["provider"] == "notion")
    assert entry["account_label"] == "Acme"


def test_oauth_config_problems_names_half_configured_providers(
    generic_oauth_off: None,
    vault_key: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client id without its secret, or the reverse, is reported per provider."""
    assert oauth_config_problems() == []
    monkeypatch.setattr(settings, "notion_oauth_client_id", "notion-client")
    monkeypatch.setattr(settings, "microsoft_oauth_client_secret", SecretStr("ms-secret"))
    problems = oauth_config_problems()
    assert "notion: client id is set but the client secret is missing" in problems
    assert "onedrive: client secret is set but the client id is missing" in problems
    assert "azure_blob: client secret is set but the client id is missing" in problems
    monkeypatch.setattr(settings, "notion_oauth_client_secret", SecretStr("notion-secret"))
    assert not any(p.startswith("notion:") for p in oauth_config_problems())


def test_connector_scopes_column_is_unbounded() -> None:
    """Google's accumulated scope list outgrows 255 characters, so the column has no width cap."""
    column_type = UserConnectorModel.__table__.c.scopes.type
    assert getattr(column_type, "length", None) is None
