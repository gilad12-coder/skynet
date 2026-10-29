"""Start the LiteLLM proxy and make sure the backend's virtual key exists.

A PR environment copies ``staging``'s variables but gets a fresh proxy
database, so the virtual key the backend presents (``LITELLM_PROXY_API_KEY``)
is unknown there and every managed call fails with
``Invalid proxy server token``. When ``LITELLM_SEED_KEY`` is set (it must equal the
backend's ``LITELLM_PROXY_API_KEY``), this registers that exact
key once the proxy is healthy. It is idempotent: an existing key is left alone.
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "http://localhost:4000"
HEALTH_TIMEOUT_SECONDS = 300


def _call(path: str, token: str, body: dict | None = None) -> int:
    """Send one request to the local proxy and return its HTTP status.

    Args:
        path: Path on the proxy, e.g. ``/key/info?key=...``.
        token: Bearer token to present.
        body: JSON body; sends a POST when given, a GET otherwise.

    Returns:
        The HTTP status code, or 0 when the proxy is unreachable.
    """
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError):
        return 0


def _seed_key(proxy: subprocess.Popen) -> None:
    """Register ``LITELLM_SEED_KEY`` in the proxy database if it is missing.

    Args:
        proxy: The running proxy process; seeding stops if it exits.
    """
    seed = os.environ.get("LITELLM_SEED_KEY", "").strip()
    master = os.environ.get("LITELLM_MASTER_KEY", "").strip()
    if not seed or not master:
        return
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while _call("/health/liveliness", master) != 200:
        if proxy.poll() is not None or time.monotonic() > deadline:
            print("seed-key: proxy never became healthy, skipped", flush=True)
            return
        time.sleep(2)
    if _call(f"/key/info?key={seed}", master) == 200:
        print("seed-key: backend key already present", flush=True)
        return
    status = _call("/key/generate", master, {"key": seed, "key_alias": "backend"})
    print(f"seed-key: registered backend key (status {status})", flush=True)


def main() -> int:
    """Run the proxy with this script's arguments and seed the backend key.

    Returns:
        The proxy's exit code.
    """
    proxy = subprocess.Popen(["litellm", *sys.argv[1:]])
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda s, _frame: proxy.send_signal(s))
    _seed_key(proxy)
    return proxy.wait()


if __name__ == "__main__":
    sys.exit(main())
