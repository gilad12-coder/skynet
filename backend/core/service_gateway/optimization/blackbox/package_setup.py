"""Resolve and install scorer wheels inside the offline execution sandbox."""

from __future__ import annotations

import ast
import base64
import hashlib
import html
import importlib.util
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

_ALIASES = {
    "PIL": "Pillow",
    "sklearn": "scikit-learn",
    "cv2": "opencv-python-headless",
    "bs4": "beautifulsoup4",
    "yaml": "PyYAML",
    "dateutil": "python-dateutil",
    "dotenv": "python-dotenv",
    "fitz": "PyMuPDF",
    "skimage": "scikit-image",
}


class PackageSetupStoppedError(RuntimeError):
    """Preserve a parent admission signal across the dependency subprocess."""

    def __init__(self, code: str, message: str) -> None:
        """Retain the original stop code and message.

        Args:
            code: Parent control code.
            message: Human-readable reason for stopping.
        """
        super().__init__(message)
        self.code = code


def _request(route: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    """Request registry bytes through the parent mailbox without direct network access.

    Args:
        route: Opaque package-only capability.
        body: Validated package index or wheel chunk request.

    Returns:
        Parent-produced registry metadata or chunk.
    """
    endpoint = os.environ.get("SKYNET_BUDGET_RELAY_URL", route["url"]).rstrip("/")
    request = urllib.request.Request(
        endpoint + "/_packages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + route["token"]},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = json.loads(error.read()).get("error", {})
        if error.code in {402, 424}:
            raise PackageSetupStoppedError(
                body.get("code", "usage_pending"), body.get("message", "Package setup stopped.")
            ) from error
        raise ValueError(body.get("message", "The package registry request failed.")) from error


def _wheel(route: dict[str, str], artifact: dict[str, Any], destination: Path) -> None:
    """Download a pinned wheel in bounded chunks and verify its digest.

    Args:
        route: Parent package capability.
        artifact: Wheel filename and expected SHA-256.
        destination: Private guest wheel directory.
    """
    filename = artifact["filename"]
    if Path(filename).name != filename or not filename.endswith(".whl"):
        raise ValueError("Invalid wheel filename.")
    target = destination / filename
    offset = 0
    digest = hashlib.sha256()
    with target.open("wb") as output:
        while True:
            chunk = _request(route, {"action": "wheel", "sha256": artifact["sha256"], "offset": offset})
            data = base64.b64decode(chunk["data"], validate=True)
            output.write(data)
            digest.update(data)
            offset += len(data)
            if offset == chunk["size"]:
                break
            if not data or offset > chunk["size"]:
                raise ValueError("Incomplete package artifact.")
    if digest.hexdigest() != artifact["sha256"]:
        target.unlink()
        raise ValueError("Package artifact failed its SHA-256 integrity check.")


def _pip(arguments: list[str]) -> None:
    """Run wheel-only pip inside the sandbox with no inherited package configuration.

    Args:
        arguments: Fixed pip options and validated requirements.
    """
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PIP_")}
    environment["PIP_CONFIG_FILE"] = os.devnull
    completed = subprocess.run(
        [sys.executable, "-m", "pip", "--disable-pip-version-check", "--retries", "0", *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    if completed.returncode:
        raise ValueError((completed.stderr or completed.stdout)[-6000:])


def infer_requirements(code: str, overrides: list[str]) -> tuple[list[str], list[str]]:
    """Inspect imports without executing scorer code and honor explicit package overrides.

    Args:
        code: Current Python scorer source.
        overrides: Complete optional package requirement list supplied by the user.

    Returns:
        Missing-package requirements and imported root modules.
    """
    roots: set[str] = set()
    for node in ast.walk(ast.parse(code)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    requirements = overrides or [
        _ALIASES.get(root, root)
        for root in sorted(roots)
        if root not in sys.stdlib_module_names and root != "skynet" and importlib.util.find_spec(root) is None
    ]
    for item in requirements:
        parsed = Requirement(item)
        if parsed.url or item.startswith("-"):
            raise ValueError(
                "Use package names and version constraints; direct URLs and pip options are not supported."
            )
    return requirements, sorted(roots)


def resolve(code: str, overrides: list[str], route: dict[str, str], directory: Path) -> dict[str, Any]:
    """Resolve missing imports to exact wheel versions using the configured registry.

    Args:
        code: Current scorer source.
        overrides: Optional complete package requirement list.
        route: Parent registry capability.
        directory: Private sandbox workspace.

    Returns:
        Reusable exact artifact lock for this source and runtime.
    """
    requirements, roots = infer_requirements(code, overrides)
    artifacts: dict[str, dict[str, Any]] = {}
    stopped: list[PackageSetupStoppedError] = []

    class Handler(BaseHTTPRequestHandler):
        """Expose only the scoped parent's wheel index to local pip."""

        def log_message(self, format: str, *args: object) -> None:
            """Keep temporary capability paths out of application logs."""

        def do_GET(self) -> None:
            """Serve sanitized wheel links or locally staged pinned wheel bytes."""
            try:
                path = urlsplit(self.path).path
                if path.startswith("/simple/"):
                    project = unquote(path.removeprefix("/simple/").strip("/"))
                    response = _request(route, {"action": "index", "project": project})
                    links = []
                    for artifact in response["artifacts"]:
                        digest = artifact["sha256"]
                        artifacts[digest] = artifact
                        href = f"/wheels/{digest}/{artifact['filename']}#sha256={digest}"
                        links.append(
                            f'<a href="{html.escape(href, quote=True)}" data-requires-python="'
                            f'{html.escape(artifact["requires_python"], quote=True)}">{html.escape(artifact["filename"])}</a>'
                        )
                    content = ("<!doctype html><html><body>" + "\n".join(links) + "</body></html>").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif path.startswith("/wheels/"):
                    digest = path.split("/")[2]
                    artifact = artifacts[digest]
                    _wheel(route, artifact, directory)
                    data = (directory / artifact["filename"]).read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self.send_error(404)
            except Exception as error:
                if isinstance(error, PackageSetupStoppedError):
                    stopped.append(error)
                self.send_error(502, str(error)[:500])

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        report = directory / "report.json"
        if requirements:
            _pip(
                [
                    "install",
                    "--dry-run",
                    "--report",
                    str(report),
                    "--only-binary=:all:",
                    "--no-cache-dir",
                    "--index-url",
                    f"http://127.0.0.1:{server.server_port}/simple/",
                    *requirements,
                ]
            )
            selected = json.loads(report.read_text())["install"]
        else:
            selected = []
        locked = []
        for item in selected:
            digest = item["download_info"]["archive_info"]["hashes"]["sha256"]
            artifact = artifacts[digest]
            locked.append(
                {
                    "name": canonicalize_name(item["metadata"]["name"]),
                    "version": item["metadata"]["version"],
                    "filename": artifact["filename"],
                    "url": artifact["url"],
                    "sha256": digest,
                }
            )
        return {
            "code_sha256": hashlib.sha256(code.encode()).hexdigest(),
            "requirements": overrides,
            "inferred": requirements,
            "imports": roots,
            "artifacts": locked,
            "python": sys.version.split()[0],
        }
    except Exception:
        if stopped:
            raise stopped[0] from None
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def install(lock: dict[str, Any], route: dict[str, str], directory: Path) -> None:
    """Install the saved wheel set without contacting a registry or selecting new versions.

    Args:
        lock: Exact artifact lock returned by resolution.
        route: Parent capability restricted to those artifacts.
        directory: Private scorer dependency directory.
    """
    if lock["python"] != sys.version.split()[0]:
        raise ValueError("The Python runtime changed; resolve dependencies again.")
    wheels = directory / "wheels"
    wheels.mkdir(parents=True, exist_ok=True)
    lines = []
    for artifact in lock["artifacts"]:
        _wheel(route, artifact, wheels)
        lines.append(f"{artifact['name']}=={artifact['version']} --hash=sha256:{artifact['sha256']}")
    if lines:
        requirements = directory / "locked.txt"
        requirements.write_text("\n".join(lines) + "\n")
        _pip(
            [
                "install",
                "--no-index",
                "--no-deps",
                "--only-binary=:all:",
                "--require-hashes",
                "--find-links",
                str(wheels),
                "--target",
                str(directory / "site"),
                "-r",
                str(requirements),
            ]
        )


def main() -> None:
    """Run a protected dependency operation and serialize its result."""
    source = Path(sys.argv[1])
    document = json.loads(source.read_text())
    directory = source.parent.resolve()
    try:
        if document["action"] == "resolve":
            result = resolve(document["code"], document["requirements"], document["route"], directory)
        else:
            install(document["lock"], document["route"], directory)
            result = {"installed": True}
        output = {"ok": True, "result": result}
    except PackageSetupStoppedError as error:
        output = {"ok": False, "error": str(error), "control": {"code": error.code, "message": str(error)}}
    except Exception as error:
        output = {"ok": False, "error": str(error)}
    (directory / "result.json").write_text(json.dumps(output))


if __name__ == "__main__":
    main()
