"""Tests for reading files attached in agent chats.

Covers the parser for each format (text, PDF, DOCX, XLSX, XLS, PPTX), the
notes for images, binary, corrupt and oversized files, truncation, and the
``POST /agent/attachments/extract`` route with the auth dependency overridden.
Fixtures are built in memory; the XLS is a 93-byte BIFF2 workbook.
"""

from __future__ import annotations

import base64
import io
import zipfile

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from ...config import settings
from ...service_gateway.agents import attachments
from ...service_gateway.agents.attachments import MAX_ATTACHMENT_CHARS, extract_attachment_text
from ..auth import AuthenticatedUser, get_authenticated_user
from ..routers import agent_attachments
from ..routers.agent_attachments import create_agent_attachments_router

_W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
_A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
_S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
_R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
_PKG_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'

# Sheet "Sheet 1" holding [["name", "score"], ["ada", 3]], written by SheetJS as BIFF2.
_XLS_B64 = (
    "CQAEAAIAEAAeAAgAB0dlbmVyYWxDAAQAAAAAAAQADAAAAAAAAAAABG5hbWUEAA0AAAABAAAAAAVzY29yZQQACwABAAAAAAAAA2FkYQIACQABAAEA"
    "AAAAAwAKAAAA"
)


def _zip(members: dict[str, str]) -> bytes:
    """Pack text members into an in-memory zip.

    Args:
        members: Path to XML text.

    Returns:
        The zip bytes.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def _pdf(text: str) -> bytes:
    """Build a one-page PDF whose text layer holds ``text``.

    Args:
        text: ASCII text without parentheses or backslashes.

    Returns:
        The PDF bytes, with a correct cross-reference table.
    """
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def _xlsx(rows: str) -> bytes:
    """Build a one-sheet XLSX whose sheet data is ``rows``.

    Args:
        rows: The ``row`` elements of the sheet.

    Returns:
        The XLSX bytes.
    """
    workbook = f'<workbook {_S_NS} {_R_NS}><sheets><sheet name="s" r:id="rId1"/></sheets></workbook>'
    rels = f'<Relationships {_PKG_NS}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    return _zip(
        {
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": rels,
            "xl/worksheets/sheet1.xml": f"<worksheet {_S_NS}><sheetData>{rows}</sheetData></worksheet>",
        }
    )


def _slide(body: str) -> str:
    """Build one PPTX slide holding a single paragraph.

    Args:
        body: The paragraph text.

    Returns:
        The slide XML.
    """
    return f"<p:sld {_A_NS} xmlns:p='urn:p'><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:sld>"


def _blank_pdf(pages: int) -> bytes:
    """Build a PDF of blank pages.

    Args:
        pages: The page count.

    Returns:
        The PDF bytes.
    """
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(100, 100)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_text_files_decode_whatever_the_extension() -> None:
    """Code, markup and extension-less text files come back as their text."""
    assert extract_attachment_text("main.rs", "", b"fn main() {}\n") == "fn main() {}\n"
    assert extract_attachment_text("notes", "", "שלום עולם".encode()) == "שלום עולם"
    assert extract_attachment_text("data.csv", "text/csv", b"\xef\xbb\xbfa,b\n1,2") == "a,b\n1,2"
    assert extract_attachment_text("conf.yaml", "", "k: v".encode("utf-16")) == "k: v"


def test_pdf_text_layer_is_extracted() -> None:
    """A PDF gives each page's text under a page heading."""
    text = extract_attachment_text("report.pdf", "application/pdf", _pdf("Quarterly revenue grew"))
    assert text.startswith("Page 1")
    assert "Quarterly revenue grew" in text


def test_docx_paragraphs_are_extracted() -> None:
    """A DOCX gives one line per paragraph, with tabs kept."""
    document = (
        f"<w:document {_W_NS}><w:body>"
        "<w:p><w:r><w:t>Title</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>left</w:t><w:tab/><w:t>right</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    assert extract_attachment_text("brief.docx", "", _zip({"word/document.xml": document})) == "Title\nleft\tright"


def test_pptx_slides_are_extracted_in_numeric_order() -> None:
    """Slide 10 comes after slide 2, each under its own heading."""

    def slide(body: str) -> str:
        return f"<p:sld {_A_NS} xmlns:p='urn:p'><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:sld>"

    data = _zip({f"ppt/slides/slide{n}.xml": slide(f"text {n}") for n in (10, 1, 2)})
    assert extract_attachment_text("deck.pptx", "", data).split("\n\n") == [
        "Slide 1\ntext 1",
        "Slide 2\ntext 2",
        "Slide 3\ntext 10",
    ]


def test_xlsx_sheets_are_extracted_with_empty_cells_padded() -> None:
    """Shared, inline and number cells land in their own columns."""
    workbook = f'<workbook {_S_NS} {_R_NS}><sheets><sheet name="Scores" r:id="rId1"/></sheets></workbook>'
    rels = f'<Relationships {_PKG_NS}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    shared = f"<sst {_S_NS}><si><t>name</t></si><si><t>score</t></si></sst>"
    sheet = (
        f"<worksheet {_S_NS}><sheetData>"
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>ada</t></is></c><c r="C2"><v>3</v></c></row>'
        "</sheetData></worksheet>"
    )
    data = _zip(
        {
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": rels,
            "xl/sharedStrings.xml": shared,
            "xl/worksheets/sheet1.xml": sheet,
        }
    )
    assert extract_attachment_text("scores.xlsx", "", data) == "Sheet: Scores\nname\t\tscore\nada\t\t3"


def test_xlsx_far_right_cells_do_not_pad_rows() -> None:
    """A cell in the last column must not pad its row with thousands of empty columns."""
    text = extract_attachment_text("wide.xlsx", "", _xlsx('<row><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>'))
    assert text.startswith("Sheet: s\n1")
    assert "\t" * 2000 not in text


def test_xlsx_stops_reading_rows_past_the_character_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rows past the character cap are not parsed at all."""
    calls: list[int] = []
    read_cell = attachments._cell_value

    def counting_cell_value(*args: object) -> str:
        """Count each parsed cell."""
        calls.append(1)
        return read_cell(*args)

    monkeypatch.setattr(attachments, "_cell_value", counting_cell_value)
    row = f'<row><c t="inlineStr"><is><t>{"x" * 1000}</t></is></c></row>'
    text = extract_attachment_text("long.xlsx", "", _xlsx(row * 500))
    assert "[Truncated: showing the first 50,000 characters of long.xlsx" in text
    assert len(calls) < 100


def test_zip_formats_refuse_a_large_total_unpacked_size(monkeypatch: pytest.MonkeyPatch) -> None:
    """Members whose declared sizes add up past the cap are never inflated."""
    monkeypatch.setattr(attachments, "_MAX_INFLATED_BYTES", 1000)
    data = _zip({f"ppt/slides/slide{n}.xml": _slide("x" * 600) for n in (1, 2)})
    assert extract_attachment_text("deck.pptx", "", data).endswith("Its contents could not be read.]")


def test_pptx_stops_opening_slides_past_the_character_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Slides after the character cap are not inflated or parsed."""
    opened: list[str] = []
    open_member = zipfile.ZipFile.open

    def counting_open(self: zipfile.ZipFile, name: str, *args: object, **kwargs: object) -> object:
        """Record each member opened."""
        opened.append(str(name))
        return open_member(self, name, *args, **kwargs)

    data = _zip({f"ppt/slides/slide{n}.xml": _slide("y" * 5000) for n in range(1, 51)})
    monkeypatch.setattr(zipfile.ZipFile, "open", counting_open)
    text = extract_attachment_text("deck.pptx", "", data)
    assert "[Truncated: showing the first 50,000 characters of deck.pptx" in text
    assert len(opened) < 15


def test_pdf_reads_at_most_the_page_cap() -> None:
    """A PDF with more pages than the cap stops at the cap and says so."""
    text = extract_attachment_text("long.pdf", "application/pdf", _blank_pdf(attachments._MAX_PDF_PAGES + 5))
    assert f"Page {attachments._MAX_PDF_PAGES}\n" in text
    assert f"Page {attachments._MAX_PDF_PAGES + 1}\n" not in text
    assert text.endswith(
        f"[Truncated: read the first {attachments._MAX_PDF_PAGES} of {attachments._MAX_PDF_PAGES + 5} pages.]"
    )


def test_parsing_stops_when_the_time_budget_runs_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """Past the time budget, extraction stops and notes the cut."""
    monkeypatch.setattr(attachments, "_MAX_PARSE_SECONDS", 0.0)
    text = extract_attachment_text("slow.pdf", "application/pdf", _blank_pdf(3))
    assert text.startswith("Page 1")
    assert "Page 2" not in text
    assert text.endswith("[Truncated: slow.pdf took too long to read, so only its first part is shown.]")


def test_xls_sheets_are_extracted() -> None:
    """A legacy XLS workbook gives its rows as tab-separated text."""
    text = extract_attachment_text("scores.xls", "application/vnd.ms-excel", base64.b64decode(_XLS_B64))
    assert text == "Sheet: Sheet 1\nname\tscore\nada\t3.0"


def test_images_binaries_and_corrupt_files_become_notes() -> None:
    """Unreadable files give a short note with name, type and size, never an error."""
    image = extract_attachment_text("photo.png", "image/png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    assert (
        image
        == "[Attached file photo.png (image/png, 108 B). It is an image; this chat cannot show images to the agent.]"
    )
    binary = extract_attachment_text("tool.exe", "", b"MZ\x00\x01" * 512)
    assert (
        binary == "[Attached file tool.exe (unknown type, 2.0 KB). It is a binary file; its contents cannot be read.]"
    )
    corrupt = extract_attachment_text("broken.docx", "", b"not a zip")
    assert corrupt.endswith("Its contents could not be read.]")
    empty = extract_attachment_text("blank.docx", "", _zip({"word/document.xml": f"<w:document {_W_NS}/>"}))
    assert empty.endswith("It contains no readable text.]")


def test_oversized_files_are_not_parsed() -> None:
    """A file past the byte limit becomes a note without being read."""
    text = extract_attachment_text("huge.txt", "text/plain", b"x", size=attachments.MAX_ATTACHMENT_BYTES + 1)
    assert (
        text
        == "[Attached file huge.txt (text/plain, 20.0 MB). It is larger than the 20.0 MB limit, so its contents were not read.]"
    )


def test_long_text_is_truncated_with_a_note() -> None:
    """Text past the character cap is cut and says how much was kept."""
    text = extract_attachment_text("big.log", "", b"a" * (MAX_ATTACHMENT_CHARS + 10))
    assert text.startswith("a" * MAX_ATTACHMENT_CHARS + "\n\n[Truncated: showing the first 50,000 of 50,010")


@pytest.fixture
def client() -> TestClient:
    """Mount the attachment router authed as a fixed user.

    Returns:
        A test client for the mounted router.
    """
    app = FastAPI()
    app.include_router(create_agent_attachments_router())
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
        username="alice", role="user", groups=()
    )
    return TestClient(app)


def test_route_returns_the_extracted_text(client: TestClient) -> None:
    """The route parses an uploaded file of any type."""
    resp = client.post("/agent/attachments/extract", files={"file": ("brief.md", b"# Brief", "text/markdown")})
    assert resp.status_code == 200
    assert resp.json() == {"text": "# Brief"}
    resp = client.post(
        "/agent/attachments/extract", files={"file": ("blob.bin", b"\x00\x01", "application/octet-stream")}
    )
    assert resp.json()["text"].startswith("[Attached file blob.bin (application/octet-stream, 2 B).")


def test_route_enforces_the_hourly_attachment_cap(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """A caller over the hourly attachment cap gets a 429 before any parsing."""
    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr(agent_attachments, "shared_redis_client", lambda: redis)
    monkeypatch.setattr(settings, "rate_limit_attachments_per_hour", 2)

    statuses = [
        client.post("/agent/attachments/extract", files={"file": ("a.txt", b"a", "text/plain")}).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


def test_route_requires_sign_in() -> None:
    """Without the auth override, the route rejects an anonymous caller."""
    app = FastAPI()
    app.include_router(create_agent_attachments_router())
    resp = TestClient(app).post("/agent/attachments/extract", files={"file": ("a.txt", b"a", "text/plain")})
    assert resp.status_code == 401
