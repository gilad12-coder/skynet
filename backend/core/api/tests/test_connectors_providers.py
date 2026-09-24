"""Tests for the generic connectors (Google Sheets, GitHub, S3, GCS, Azure Blob).

Every outbound call is mocked at the :mod:`httpx` boundary inside
:mod:`core.connectors.transport`, so the tests cover the request signing
(SigV4 against AWS's published vector, Azure Shared Key), credential
validation and storage, the browse/preview/import round-trips through the
shared routes, and the generic OAuth start/callback pair.
"""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime, timedelta
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
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...connectors import azure_blob, github, oauth, s3, tabular
from ...connectors.vault import ConnectorVault
from ...storage.dataset_library import DatasetLibraryStore, PostgresDatasetBlobStore
from ...storage.models import UserConnectorModel
from .test_connectors_router import _make_client, _response, vault_key  # noqa: F401 - fixture re-export

CSV = b"name,score\nada,1\nbob,2\n"
JSONL = b'{"name": "ada", "score": 1}\n{"name": "bob", "score": 2}\n'


@pytest.fixture
def generic_oauth_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hide the Google and GitHub OAuth buttons unless a test opts in."""
    for name in ("google_oauth_client_id", "google_oauth_client_secret", "github_oauth_client_id"):
        monkeypatch.setattr(settings, name, None)
    monkeypatch.setattr(settings, "github_oauth_client_secret", None)
    monkeypatch.setattr(settings, "google_oauth_redirect_uri", None)
    monkeypatch.setattr(settings, "github_oauth_redirect_uri", None)


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
    """A fresh user sees all six providers unlinked, OAuth hidden everywhere."""
    body = _make_client()[0].get("/connectors").json()
    assert [c["provider"] for c in body["connectors"]] == [
        "huggingface",
        "google_sheets",
        "github",
        "s3",
        "gcs",
        "azure_blob",
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
