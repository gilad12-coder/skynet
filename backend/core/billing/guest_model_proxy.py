"""Relay sandbox-local model HTTP over supervisor-controlled stdout and files."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

RELAY_URL_ENV = "SKYNET_BUDGET_RELAY_URL"
_PRINT_LOCK = threading.Lock()


def main() -> int:
    """Run a command with a local model proxy and no provider credentials.

    Returns:
        The wrapped command's exit status.
    """
    config = json.loads(Path(sys.argv[1]).read_text())
    response_dir = Path(config["response_dir"])
    response_dir.mkdir(parents=True, exist_ok=True)
    prefix = config["prefix"]
    timeout = float(config["timeout_seconds"])

    class Handler(BaseHTTPRequestHandler):
        """Forward model protocol bytes through the trusted supervisor's mailbox."""

        def log_message(self, format: str, *args: object) -> None:
            """Keep scoped tokens and model input out of the command's ordinary logs."""

        def do_POST(self) -> None:
            """Relay an inference request through the trusted supervisor."""
            self._relay()

        def do_GET(self) -> None:
            """Relay a read-only budget state check through the same supervisor."""
            self._relay()

        def _relay(self) -> None:
            """Wait for the supervisor's response without contacting the internet."""
            length = int(self.headers.get("Content-Length", "0"))
            if (self.command == "POST" and length <= 0) or not 0 <= length <= 32 * 1024 * 1024:
                self.send_error(413)
                return
            identity = uuid4().hex
            request = {
                "id": identity,
                "path": self.path,
                "body": base64.b64encode(self.rfile.read(length) if length else b"{}").decode(),
                "headers": {
                    key: value
                    for key, value in self.headers.items()
                    if key.lower() in {"authorization", "x-api-key", "anthropic-version", "anthropic-beta"}
                },
            }
            with _PRINT_LOCK:
                print(prefix + json.dumps(request, separators=(",", ":")), flush=True)
            response_path = response_dir / f"{identity}.json"
            deadline = time.monotonic() + timeout
            document = None
            while time.monotonic() < deadline:
                try:
                    document = json.loads(response_path.read_text())
                    break
                except (FileNotFoundError, ValueError):
                    time.sleep(0.05)
            if document is None:
                self.send_error(504, "The trusted model response is still pending.")
                return
            response_path.unlink(missing_ok=True)
            content = base64.b64decode(document["body"])
            self.send_response(document["status"])
            self.send_header("Content-Type", document["content_type"])
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    environment = {
        **os.environ,
        RELAY_URL_ENV: f"{endpoint}/v1",
        "ANTHROPIC_BASE_URL": endpoint,
        "OPENAI_BASE_URL": f"{endpoint}/v1",
        "SKYNET_GATEWAY_URL": f"{endpoint}/v1",
    }
    try:
        return subprocess.run(sys.argv[2:], env=environment, check=False).returncode
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
