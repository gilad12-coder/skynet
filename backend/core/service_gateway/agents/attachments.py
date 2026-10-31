"""Turn a file attached in an agent chat into text the agent can read.

Every agent chat sends plain-string messages, so an attachment reaches the
model as text: text-like files decode as they are, PDF, DOCX, XLSX, XLS and
PPTX give their extracted text, and anything else (images included) becomes a
short note with the file's name, type and size. Parsing never raises: a file
that cannot be read turns into the same note.

Each parser yields its text piece by piece, so reading stops at the character
cap or the time budget instead of parsing a hostile file in full.
"""

from __future__ import annotations

import io
import re
import time
import zipfile
from collections.abc import Iterator
from contextlib import AbstractContextManager, closing
from pathlib import PurePosixPath
from typing import IO
from xml.etree import ElementTree as ET
from xml.parsers import expat

import xlrd
from pypdf import PdfReader, apply_configuration
from pypdf.errors import LimitReachedError

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENT_CHARS = 50_000
# A DOCX/XLSX/PPTX is a zip. zipfile never inflates a member past its declared
# size, so capping the declared total bounds the work a zip bomb can cause.
_MAX_INFLATED_BYTES = 256 * 1024 * 1024
# Each part is parsed as a stream, but a part can still be mostly markup with
# little text, so reading one part stops at this many unpacked bytes.
_MAX_PART_BYTES = 32 * 1024 * 1024
_READ_CHUNK_BYTES = 64 * 1024
# Workbook index parts (relationships, sheet list) are small; they are parsed
# whole, so they get a tight cap of their own.
_MAX_INDEX_PART_BYTES = 1024 * 1024
# A cell reference can name column XFD (16,384); padding to it would turn one
# cell into thousands of empty columns, so cells past this column are dropped.
_MAX_XLSX_COLUMNS = 1000
# Text-free PDF pages cost parse time but never reach the character cap.
_MAX_PDF_PAGES = 500
# pypdf inflates a whole content stream and parses it into operations before
# it extracts text, so one small compressed stream can take hundreds of MB.
_MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024
# Parsing runs on the request thread; a file that is slow to parse stops here.
_MAX_PARSE_SECONDS = 10.0

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"}


class _PartTooLargeError(Exception):
    """Raised when one zip part unpacks past ``_MAX_PART_BYTES``."""


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


def _open_zip(data: bytes) -> zipfile.ZipFile:
    """Open an Office zip after checking its declared unpacked size.

    Args:
        data: The file bytes.

    Returns:
        The open archive.

    Raises:
        ValueError: When the members' declared sizes add up past
            ``_MAX_INFLATED_BYTES``.
    """
    archive = zipfile.ZipFile(io.BytesIO(data))
    if sum(info.file_size for info in archive.infolist()) > _MAX_INFLATED_BYTES:
        archive.close()
        raise ValueError("zip unpacks past the size cap")
    return archive


def _read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    """Read one small index part of a zip, capped at the index-part limit.

    Args:
        archive: The open archive.
        name: The member path.

    Returns:
        The member bytes, at most ``_MAX_INDEX_PART_BYTES`` long.
    """
    with archive.open(name) as member:
        return member.read(_MAX_INDEX_PART_BYTES)


def _qualified(name: str) -> str:
    """Turn an expat ``uri}local`` name into ElementTree's ``{uri}local`` form.

    Args:
        name: The name expat reported.

    Returns:
        The name in ElementTree notation.
    """
    return f"{{{name}" if "}" in name else name


def _closed_elements(source: IO[bytes]) -> Iterator[ET.Element]:
    """Yield each XML element as it closes, without children.

    The part is fed to expat in chunks and only the open root-to-leaf path is
    kept, so a huge part never builds a full tree. An element keeps its own
    text only up to ``MAX_ATTACHMENT_CHARS + 1`` characters: ElementTree would
    first build one huge text node in full, before any cap could apply.

    Args:
        source: The XML byte stream.

    Yields:
        Each element with its tag, attributes and capped text, in closing
        order.

    Raises:
        _PartTooLargeError: When the stream runs past ``_MAX_PART_BYTES``.
    """
    open_elements: list[tuple[ET.Element, list[str]]] = []
    sizes: list[int] = []
    closed: list[ET.Element] = []

    def start(name: str, attributes: dict[str, str]) -> None:
        """Open an element.

        Args:
            name: The expat element name.
            attributes: The expat attributes.
        """
        elem = ET.Element(_qualified(name), {_qualified(k): v for k, v in attributes.items()})
        open_elements.append((elem, []))
        sizes.append(0)

    def data(text: str) -> None:
        """Add text to the innermost open element, up to the cap.

        Args:
            text: A piece of character data.
        """
        room = MAX_ATTACHMENT_CHARS + 1 - sizes[-1] if sizes else 0
        if room > 0:
            open_elements[-1][1].append(text[:room])
            sizes[-1] += min(len(text), room)

    def end(name: str) -> None:
        """Close the innermost element and queue it for the caller.

        Args:
            name: The expat element name.
        """
        elem, parts = open_elements.pop()
        sizes.pop()
        elem.text = "".join(parts)
        closed.append(elem)

    parser = expat.ParserCreate(namespace_separator="}")
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = data
    read = 0
    while True:
        chunk = source.read(min(_READ_CHUNK_BYTES, _MAX_PART_BYTES - read))
        if not chunk and read >= _MAX_PART_BYTES and source.read(1):
            raise _PartTooLargeError
        read += len(chunk)
        parser.Parse(chunk, not chunk)
        yield from closed
        closed.clear()
        if not chunk:
            return


def _paragraphs(source: IO[bytes], ns: str) -> Iterator[str]:
    """Yield the text of each paragraph in an Office XML part.

    Args:
        source: The part's XML byte stream.
        ns: The namespace of the ``p``/``t``/``tab``/``br`` tags.

    Yields:
        Each paragraph's stripped text, and an empty string for every other
        element, so the caller can stop between elements.
    """
    parts: list[str] = []
    size = 0
    for elem in _closed_elements(source):
        if elem.tag == f"{ns}p":
            yield "".join(parts).strip()
            parts, size = [], 0
            continue
        # One paragraph can hold any number of runs; past the cap they are dropped.
        piece = {f"{ns}t": elem.text or "", f"{ns}tab": "\t", f"{ns}br": "\n"}.get(elem.tag)
        if piece is not None and size <= MAX_ATTACHMENT_CHARS:
            parts.append(piece)
            size += len(piece)
        yield ""


def _lines(paragraphs: Iterator[str], first: bool = True) -> Iterator[str]:
    """Join paragraphs with newlines, skipping empty ones, as a stream.

    Args:
        paragraphs: Paragraph texts; empty strings pass through unchanged.
        first: Whether no line was written yet, so the next one needs no
            leading newline.

    Yields:
        Each non-empty paragraph with its separator, and empty strings.
    """
    for line in paragraphs:
        if line:
            yield line if first else f"\n{line}"
            first = False
        else:
            yield ""


def _docx_text(data: bytes) -> Iterator[str]:
    """Extract the paragraph text of a DOCX.

    Args:
        data: The file bytes.

    Yields:
        The body text, one paragraph per line.
    """
    with _open_zip(data) as archive, archive.open("word/document.xml") as member:
        yield from _lines(_paragraphs(member, _W))


def _pptx_text(data: bytes) -> Iterator[str]:
    """Extract the text of every PPTX slide, in slide order.

    Args:
        data: The file bytes.

    Yields:
        Each slide's text under a ``Slide N`` heading.
    """
    with _open_zip(data) as archive:
        slides = [n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
        slides.sort(key=lambda n: int(re.findall(r"\d+", n)[-1]))
        for number, name in enumerate(slides, start=1):
            yield f"Slide {number}" if number == 1 else f"\n\nSlide {number}"
            with archive.open(name) as member:
                yield from _lines(_paragraphs(member, _A), first=False)


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


def _cell_value(kind: str | None, value: str | None, texts: list[str], shared: list[str]) -> str:
    """Return the displayed text of one XLSX cell.

    Args:
        kind: The cell's ``t`` attribute.
        value: The text of its ``v`` element, if any.
        texts: The texts of its ``t`` elements (inline strings).
        shared: The workbook's shared strings.

    Returns:
        The cell's text; a formula cell gives its cached value.
    """
    if kind == "inlineStr":
        return "".join(texts)
    if value is None:
        return ""
    if kind == "s":
        index = int(value)
        return shared[index] if index < len(shared) else ""
    return value


def _sheet_rows(source: IO[bytes], shared: list[str]) -> Iterator[str | None]:
    """Yield the rows of one XLSX sheet as tab-separated text.

    Args:
        source: The sheet's XML byte stream.
        shared: The workbook's shared strings.

    Yields:
        Each row's text, and ``None`` for every other element, so the caller
        can stop between elements.
    """
    cells: list[str] = []
    texts: list[str] = []
    value: str | None = None
    # One row can hold many long cells; past the cap, its text is dropped.
    size = texts_size = 0
    for elem in _closed_elements(source):
        if elem.tag == f"{_S}t":
            if size + texts_size <= MAX_ATTACHMENT_CHARS:
                texts.append(elem.text or "")
                texts_size += len(texts[-1])
        elif elem.tag == f"{_S}v":
            value = elem.text
        elif elem.tag == f"{_S}c":
            # Empty cells are absent from the XML; pad to the cell's column so
            # values stay under the right header.
            column = _column_index(elem.get("r", ""))
            if size <= MAX_ATTACHMENT_CHARS and (column is None or column < _MAX_XLSX_COLUMNS):
                if column is not None and column > len(cells):
                    cells.extend([""] * (column - len(cells)))
                cells.append(_cell_value(elem.get("t"), value, texts, shared))
                size += len(cells[-1])
            texts, value, texts_size = [], None, 0
        elif elem.tag == f"{_S}row":
            yield "\t".join(cells)
            cells, size = [], 0
            continue
        yield None


def _shared_strings(source: IO[bytes]) -> Iterator[str | None]:
    """Yield the workbook's shared strings as they are parsed.

    Args:
        source: The ``sharedStrings.xml`` byte stream.

    Yields:
        Each shared string, and ``None`` for every other element, so the
        caller can stop between elements.
    """
    parts: list[str] = []
    size = 0
    for elem in _closed_elements(source):
        if elem.tag == f"{_S}t":
            # One string can hold any number of runs; past the cap they are dropped.
            if size <= MAX_ATTACHMENT_CHARS:
                parts.append(elem.text or "")
                size += len(parts[-1])
            yield None
        elif elem.tag == f"{_S}si":
            yield "".join(parts)
            parts, size = [], 0
        else:
            yield None


def _xlsx_text(data: bytes) -> Iterator[str]:
    """Extract every XLSX sheet as tab-separated rows.

    Args:
        data: The file bytes.

    Yields:
        Each sheet's rows under a ``Sheet: name`` heading.
    """
    with _open_zip(data) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            # Shared strings never reach _collect, so they count against the
            # character cap here; strings past it read as empty cells.
            size = 0
            with archive.open("xl/sharedStrings.xml") as member, closing(_shared_strings(member)) as values:
                for value in values:
                    if value is not None:
                        shared.append(value)
                        size += len(value) + 1
                        if size > MAX_ATTACHMENT_CHARS:
                            break
                    yield ""
        rels = ET.fromstring(_read_member(archive, "xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target", "") for rel in rels.iter(f"{_PKG_REL}Relationship")}
        workbook = ET.fromstring(_read_member(archive, "xl/workbook.xml"))
        first = True
        for sheet in workbook.iter(f"{_S}sheet"):
            target = targets.get(sheet.get(f"{_R}id"), "").lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            if path not in names:
                continue
            heading = f"Sheet: {sheet.get('name', '')}"
            yield heading if first else f"\n\n{heading}"
            first = False
            with archive.open(path) as member:
                for row in _sheet_rows(member, shared):
                    yield "" if row is None else f"\n{row}"


def _xls_text(data: bytes) -> Iterator[str]:
    """Extract every legacy XLS sheet as tab-separated rows.

    Args:
        data: The file bytes.

    Yields:
        Each sheet's rows under a ``Sheet: name`` heading.
    """
    # xlrd prints format warnings to stdout unless given its own log.
    book = xlrd.open_workbook(file_contents=data, on_demand=True, logfile=io.StringIO())
    for index, sheet in enumerate(book.sheets()):
        yield f"Sheet: {sheet.name}" if index == 0 else f"\n\nSheet: {sheet.name}"
        for r in range(sheet.nrows):
            yield "\n" + "\t".join(str(v) for v in sheet.row_values(r))


def _pdf_limits() -> AbstractContextManager[object]:
    """Cap how many bytes pypdf may inflate from one PDF stream.

    Returns:
        A context manager that applies the caps while it is open.
    """
    cap = _MAX_PDF_STREAM_BYTES
    return apply_configuration(
        zlib_maximum_output_length=cap,
        lzw_maximum_output_length=cap,
        run_length_maximum_output_length=cap,
        brotli_maximum_output_length=cap,
        jbig2_maximum_output_length=cap,
        array_based_stream_maximum_output_length=cap,
        stream_decoding_work_maximum_length=4 * cap,
    )


def _pdf_text(data: bytes) -> Iterator[str]:
    """Extract the text layer of a PDF, page by page.

    Args:
        data: The file bytes.

    Yields:
        Each page's text under a ``Page N`` heading, for at most
        ``_MAX_PDF_PAGES`` pages, then a note when pages were left out.
    """
    with _pdf_limits():
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        count = len(reader.pages)
    for number in range(1, min(count, _MAX_PDF_PAGES) + 1):
        with _pdf_limits():
            try:
                text = (reader.pages[number - 1].extract_text() or "").strip()
            except LimitReachedError:
                text = "[This page is too large to read.]"
        yield f"Page {number}\n{text}" if number == 1 else f"\n\nPage {number}\n{text}"
    if count > _MAX_PDF_PAGES:
        yield f"\n\n[Truncated: read the first {_MAX_PDF_PAGES} of {count} pages.]"


def _collect(pieces: Iterator[str]) -> tuple[str, str | None]:
    """Join a parser's pieces until the character cap or the time budget.

    Args:
        pieces: The parser's text pieces; empty pieces only give a chance to
            stop.

    Returns:
        The text read, and ``"chars"``, ``"time"`` or ``"size"`` when reading
        stopped early (``None`` when the parser finished).
    """
    deadline = time.monotonic() + _MAX_PARSE_SECONDS
    parts: list[str] = []
    total = 0
    with closing(pieces):
        try:
            for piece in pieces:
                parts.append(piece)
                total += len(piece)
                if total > MAX_ATTACHMENT_CHARS:
                    return "".join(parts), "chars"
                if time.monotonic() > deadline:
                    return "".join(parts), "time"
        except _PartTooLargeError:
            return "".join(parts), "size"
    return "".join(parts), None


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
            text, stopped = _collect(extractor(data))
        # A corrupt or unexpected file must become a note, never a failed request.
        except Exception:
            return _note(name, content_type, size, "Its contents could not be read.")
        if not text.strip():
            reason = "It is too large to read." if stopped == "size" else "It contains no readable text."
            return _note(name, content_type, size, reason)
        if stopped == "chars":
            return (
                f"{text[:MAX_ATTACHMENT_CHARS]}\n\n"
                f"[Truncated: showing the first {MAX_ATTACHMENT_CHARS:,} characters of {name}; the rest was not read.]"
            )
        if stopped == "time":
            return f"{text}\n\n[Truncated: {name} took too long to read, so only its first part is shown.]"
        if stopped == "size":
            return f"{text}\n\n[Truncated: {name} is too large to read in full, so only its first part is shown.]"
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
