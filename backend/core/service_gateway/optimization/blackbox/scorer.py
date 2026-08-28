"""Scorer adapters for black-box runs: python code and remote HTTP endpoints.

Both adapters normalize to the engine contract ``(score, side_info)``. The
python adapter runs wherever it is called — the job subprocess for runs,
``safe_exec`` for validation and dry runs (design brief TODO-2). The remote
adapter POSTs to any URL with an optional shared secret (TODO-1).
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

import httpx
from gepa.image import Image

from ....exceptions import ServiceError
from ....models.blackbox import BlackboxScorer
from .protocol import Candidate, ScorerFn, SideInfo

_ENTRYPOINT_NAMES = ("score", "metric")
_SCORER_FILENAME = "<scorer_code>"
# Names the scorer namespace binds the model helper and the image wrapper to.
LLM_HELPER_NAME = "llm"
IMAGE_HELPER_NAME = "Image"
LLMHelper = Callable[..., str]


def missing_llm(prompt: Any = None, input: Any = None, **kwargs: Any) -> str:
    """Stand in for ``llm`` when the scorer was given no model.

    Args:
        prompt: Ignored.
        input: Ignored.
        **kwargs: Ignored.

    Raises:
        ServiceError: Always, naming the step that fixes it.
    """
    raise ServiceError("This scorer calls llm() but no model was chosen in the Scorer step.")


def side_info_json_default(value: Any) -> str:
    """JSON fallback for side info: images become data URLs, anything else ``str()``.

    Args:
        value: A side-info value ``json.dumps`` cannot encode.

    Returns:
        Its string form.
    """
    to_part = getattr(value, "to_openai_content_part", None)
    if callable(to_part):
        return str(to_part()["image_url"]["url"])
    return str(value)


def normalize_score(raw: Any) -> tuple[float, SideInfo]:
    """Coerce a scorer's return value into ``(score, side_info)``.

    Accepted shapes: a number; ``(number, side_info)``; a mapping with a
    ``score`` key (remaining keys become side info); an object with a
    numeric ``score`` attribute.

    Args:
        raw: Whatever the scorer returned.

    Returns:
        The float score and a side-info mapping (empty when none was given).

    Raises:
        ServiceError: When the value has none of the accepted shapes.
    """
    if isinstance(raw, bool | int | float):
        return float(raw), {}
    if isinstance(raw, tuple | list) and len(raw) == 2 and isinstance(raw[0], bool | int | float):
        side = raw[1]
        return float(raw[0]), dict(side) if isinstance(side, dict) else {"feedback": side}
    if isinstance(raw, dict) and isinstance(raw.get("score"), bool | int | float):
        return float(raw["score"]), {key: value for key, value in raw.items() if key != "score"}
    score_attr = getattr(raw, "score", None)
    if isinstance(score_attr, bool | int | float):
        return float(score_attr), {}
    raise ServiceError(
        "scorer must return a number, a (number, side_info) pair, or a mapping with a 'score' key; "
        f"got {type(raw).__name__}."
    )


def load_scorer_from_code(code: str, *, helpers: dict[str, Any] | None = None) -> Callable[..., Any]:
    """Execute scorer source and return the callable it defines.

    Looks for ``score`` then ``metric``, then falls back to the single
    function the code defines.

    Args:
        code: User-authored python source.
        helpers: Names bound in the scorer's namespace before it runs.

    Returns:
        The scorer callable.

    Raises:
        ServiceError: When the code fails to compile or load, or defines no
            unambiguous scorer function.
    """
    namespace: dict[str, Any] = dict(helpers or {})
    try:
        # exec: user-supplied scorer code. Same security boundary as
        # load_metric_from_code — the job subprocess for runs, safe_exec's
        # spawn child for validation and dry runs.
        exec(compile(code, _SCORER_FILENAME, "exec", dont_inherit=True), namespace)
    except SyntaxError as exc:
        raise ServiceError(f"scorer code has a syntax error: {exc}") from exc
    except Exception as exc:
        raise ServiceError(f"scorer code failed to load: {type(exc).__name__}: {exc}") from exc
    for name in _ENTRYPOINT_NAMES:
        candidate = namespace.get(name)
        if callable(candidate):
            return candidate
    defined = [
        obj for obj in namespace.values() if inspect.isfunction(obj) and obj.__code__.co_filename == _SCORER_FILENAME
    ]
    if len(defined) == 1:
        return defined[0]
    raise ServiceError("scorer code must define a function named 'score(candidate, case=None)'.")


def _accepts_case(fn: Callable[..., Any]) -> bool:
    """Return True when ``fn`` takes a second positional argument for the case.

    Args:
        fn: The scorer callable.

    Returns:
        True for ``fn(candidate, case)`` shapes, False for ``fn(candidate)``.
    """
    try:
        params = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return True
    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
    return len(positional) >= 2 or any(p.kind == p.VAR_POSITIONAL for p in positional)


def build_python_scorer(code: str, *, llm: LLMHelper | None = None) -> ScorerFn:
    """Load scorer source and wrap it in the engine-facing scorer contract.

    Args:
        code: User-authored python source.
        llm: The model helper bound as ``llm``; without one, a scorer that
            calls it fails with a message pointing at the Scorer step. The
            namespace also sees ``Image``, the wrapper that puts rendered
            output into side info for the optimizer to look at.

    Returns:
        A callable scoring ``(candidate, case)`` → ``(score, side_info)``.

    Raises:
        ServiceError: When the code cannot be loaded.
    """
    helpers = {LLM_HELPER_NAME: llm if llm is not None else missing_llm, IMAGE_HELPER_NAME: Image}
    fn = load_scorer_from_code(code, helpers=helpers)
    takes_case = _accepts_case(fn)

    def scorer(candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Score ``candidate`` on ``case`` with the user's function.

        Args:
            candidate: The version to score.
            case: The case to score it on, if the task has cases.

        Returns:
            The normalized score and side information.
        """
        raw = fn(candidate, case) if takes_case else fn(candidate)
        return normalize_score(raw)

    return scorer


class RemoteScorer:
    """Scorer that POSTs ``{"candidate", "case"}`` to a user-owned endpoint."""

    def __init__(self, url: str, *, secret: str | None, timeout_seconds: float) -> None:
        """Create a remote scorer.

        Args:
            url: Endpoint that returns a JSON number or ``{"score": ..., ...}``.
            secret: Shared secret sent as a bearer token, if any.
            timeout_seconds: Per-request timeout.
        """
        self._url = url
        self._secret = secret
        self._timeout_seconds = timeout_seconds

    def __call__(self, candidate: Candidate, case: Any = None) -> tuple[float, SideInfo]:
        """Score ``candidate`` on ``case`` via one HTTP request.

        Args:
            candidate: The version to score.
            case: The case to score it on, if the task has cases.

        Returns:
            The normalized score and side information.

        Raises:
            ServiceError: When the request fails, returns an error status,
                a non-JSON body, or a body without a usable score.
        """
        headers = {"Authorization": f"Bearer {self._secret}"} if self._secret else {}
        try:
            response = httpx.post(
                self._url,
                json={"candidate": candidate, "case": case},
                headers=headers,
                timeout=self._timeout_seconds,
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPError as exc:
            raise ServiceError(f"remote scorer request failed: {exc}") from exc
        except ValueError as exc:
            raise ServiceError("remote scorer returned a non-JSON body.") from exc
        return normalize_score(body)


def build_scorer(spec: BlackboxScorer, *, llm: LLMHelper | None = None) -> ScorerFn:
    """Build the engine-facing scorer for a request's scorer spec.

    Args:
        spec: The submitted scorer definition.
        llm: The model helper a python scorer sees as ``llm``, if any.

    Returns:
        A callable scoring ``(candidate, case)`` → ``(score, side_info)``.

    Raises:
        ServiceError: When python scorer code cannot be loaded.
    """
    if spec.kind == "remote":
        return RemoteScorer(str(spec.url), secret=spec.secret, timeout_seconds=spec.timeout_seconds)
    return build_python_scorer(str(spec.metric_code), llm=llm)
