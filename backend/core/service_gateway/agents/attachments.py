"""Turn a file attached in an agent chat into text the agent can read.

Every agent chat sends plain-string messages, so an attachment reaches the
model as text: text-like files decode as they are, PDF, DOCX, XLSX, XLS and
PPTX give their extracted text, and anything else (images included) becomes a
short note with the file's name, type and size. Parsing never raises: a file
that cannot be read turns into the same note.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

import xlrd
from pypdf import PdfReader

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENT_CHARS = 50_000
# A DOCX/XLSX/PPTX is a zip; capping each inflated member keeps a zip bomb
# from exhausting memory before the character cap applies.
_MAX_XML_MEMBER_BYTES = 50 * 1024 * 1024

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"}


def _human_size(size: int) -> str:
    """Format a byte count for the agent.

    Args:
        size: The byte count.

    Returns:
        The size in B, KB or MB with one decimal.
    """
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _note(name: str, content_type: str, size: int, reason: str) -> str:
    """Build the short note that stands in for an unreadable file.

    Args:
        name: The file name.
        content_type: The MIME type the browser reported.
        size: The file size in bytes.
        reason: Why the contents are missing.

    Returns:
        A one-line, bracketed note.
    """
    kind = content_type or "unknown type"
    return f"[Attached file {name} ({kind}, {_human_size(size)}). {reason}]"


def _decode_text(data: bytes) -> str | None:
    """Decode bytes that look like text.

    Args:
        data: The raw file bytes.

    Returns:
        The decoded text, or ``None`` when the bytes are binary.
    """
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError:
            return None
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    """Read one zip member, capped at the inflated-size limit.

    Args:
        archive: The open archive.
        name: The member path.

    Returns:
        The member bytes, at most ``_MAX_XML_MEMBER_BYTES`` long.
    """
    with archive.open(name) as member:
        return member.read(_MAX_XML_MEMBER_BYTES)


def _paragraphs(root: ET.Element, ns: str) -> list[str]:
    """Collect the text of each paragraph in an Office XML part.

    Args:
        root: The parsed part.
        ns: The namespace of the ``p``/``t``/``tab``/``br`` tags.

    Returns:
        One string per non-empty paragraph.
    """
    lines = []
    for para in root.iter(f"{ns}p"):
        parts = []
        for node in para.iter():
            if node.tag == f"{ns}t":
                parts.append(node.text or "")
            elif node.tag == f"{ns}tab":
                parts.append("\t")
            elif node.tag == f"{ns}br":
                parts.append("\n")
        line = "".join(parts).strip()
        if line:
            lines.append(line)
    return lines


def _docx_text(data: bytes) -> str:
    """Extract the paragraph text of a DOCX.

    Args:
        data: The file bytes.

    Returns:
        The body text, one paragraph per line.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ET.fromstring(_read_member(archive, "word/document.xml"))
    return "\n".join(_paragraphs(root, _W))


def _pptx_text(data: bytes) -> str:
    """Extract the text of every PPTX slide, in slide order.

    Args:
        data: The file bytes.

    Returns:
        Each slide's text under a ``Slide N`` heading.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        slides = [n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
        slides.sort(key=lambda n: int(re.findall(r"\d+", n)[-1]))
        sections = []
        for number, name in enumerate(slides, start=1):
            lines = _paragraphs(ET.fromstring(_read_member(archive, name)), _A)
            sections.append("\n".join([f"Slide {number}", *lines]))
    return "\n\n".join(sections)


def _column_index(ref: str) -> int | None:
    """Return the zero-based column of an A1-style cell reference.

    Args:
        ref: The reference, such as ``C7``; may be empty.

    Returns:
        The column index, or ``None`` when the reference has no letters.
    """
    letters = re.match(r"[A-Z]+", ref)
    if letters is None:
        return None
    index = 0
    for letter in letters.group():
        index = index * 26 + ord(letter) - ord("A") + 1
    return index - 1


def _cell_value(cell: ET.Element, shared: list[str]) -> str:
    """Return the displayed text of one XLSX cell.

    Args:
        cell: The ``c`` element.
        shared: The workbook's shared strings.

    Returns:
        The cell's text; a formula cell gives its cached value.
    """
    if cell.get("t") == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(f"{_S}t"))
    value = cell.find(f"{_S}v")
    if value is None or value.text is None:
        return ""
    if cell.get("t") == "s":
        index = int(value.text)
        return shared[index] if index < len(shared) else ""
    return value.text


def _xlsx_text(data: bytes) -> str:
    """Extract every XLSX sheet as tab-separated rows.

    Args:
        data: The file bytes.

    Returns:
        Each sheet's rows under a ``Sheet: name`` heading.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(_read_member(archive, "xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(f"{_S}t")) for si in root.iter(f"{_S}si")]
        rels = ET.fromstring(_read_member(archive, "xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target", "") for rel in rels.iter(f"{_PKG_REL}Relationship")}
        workbook = ET.fromstring(_read_member(archive, "xl/workbook.xml"))
        sections = []
        for sheet in workbook.iter(f"{_S}sheet"):
            target = targets.get(sheet.get(f"{_R}id"), "").lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            if path not in names:
                continue
            rows = []
            for row in ET.fromstring(_read_member(archive, path)).iter(f"{_S}row"):
                cells: list[str] = []
                for cell in row.iter(f"{_S}c"):
                    # Empty cells are absent from the XML; pad to the cell's
                    # column so values stay under the right header.
                    column = _column_index(cell.get("r", ""))
                    if column is not None and column > len(cells):
                        cells.extend([""] * (column - len(cells)))
                    cells.append(_cell_value(cell, shared))
                rows.append("\t".join(cells))
            sections.append("\n".join([f"Sheet: {sheet.get('name', '')}", *rows]))
    return "\n\n".join(sections)


def _xls_text(data: bytes) -> str:
    """Extract every legacy XLS sheet as tab-separated rows.

    Args:
        data: The file bytes.

    Returns:
        Each sheet's rows under a ``Sheet: name`` heading.
    """
    # xlrd prints format warnings to stdout unless given its own log.
    book = xlrd.open_workbook(file_contents=data, on_demand=True, logfile=io.StringIO())
    sections = []
    for sheet in book.sheets():
        rows = ["\t".join(str(v) for v in sheet.row_values(r)) for r in range(sheet.nrows)]
        sections.append("\n".join([f"Sheet: {sheet.name}", *rows]))
    return "\n\n".join(sections)


def _pdf_text(data: bytes) -> str:
    """Extract the text layer of a PDF, page by page.

    Args:
        data: The file bytes.

    Returns:
        Each page's text under a ``Page N`` heading; stops once the text is
        past the character cap so a long PDF is not parsed in full.
    """
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        reader.decrypt("")
    pages = []
    total = 0
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        pages.append(f"Page {number}\n{text}")
        total += len(text)
        if total > MAX_ATTACHMENT_CHARS:
            break
    return "\n\n".join(pages)


_EXTRACTORS = {
    ".pdf": _pdf_text,
    ".docx": _docx_text,
    ".pptx": _pptx_text,
    ".xlsx": _xlsx_text,
    ".xlsm": _xlsx_text,
    ".xls": _xls_text,
}


def extract_attachment_text(name: str, content_type: str, data: bytes, size: int | None = None) -> str:
    """Return the text an agent reads for one attached file.

    Args:
        name: The file name; its suffix picks the parser.
        content_type: The MIME type the browser reported (may be empty).
        data: The file bytes (at most ``MAX_ATTACHMENT_BYTES`` are parsed).
        size: The full file size when ``data`` is a capped prefix; defaults
            to ``len(data)``.

    Returns:
        The file's text, cut to ``MAX_ATTACHMENT_CHARS`` with a note when
        longer, or a short note when the contents cannot be read.
    """
    size = len(data) if size is None else size
    if size > MAX_ATTACHMENT_BYTES:
        limit = _human_size(MAX_ATTACHMENT_BYTES)
        return _note(name, content_type, size, f"It is larger than the {limit} limit, so its contents were not read.")
    suffix = PurePosixPath(name.lower()).suffix
    extractor = _EXTRACTORS.get(suffix)
    if extractor is not None:
        try:
            text = extractor(data)
        # A corrupt or unexpected file must become a note, never a failed request.
        except Exception:
            return _note(name, content_type, size, "Its contents could not be read.")
        if not text.strip():
            return _note(name, content_type, size, "It contains no readable text.")
    elif content_type.startswith("image/") or suffix in _IMAGE_SUFFIXES:
        return _note(name, content_type, size, "It is an image; this chat cannot show images to the agent.")
    else:
        decoded = _decode_text(data)
        if decoded is None:
            return _note(name, content_type, size, "It is a binary file; its contents cannot be read.")
        text = decoded
    if len(text) > MAX_ATTACHMENT_CHARS:
        return (
            f"{text[:MAX_ATTACHMENT_CHARS]}\n\n"
            f"[Truncated: showing the first {MAX_ATTACHMENT_CHARS:,} of {len(text):,} characters of {name}.]"
        )
    return text
