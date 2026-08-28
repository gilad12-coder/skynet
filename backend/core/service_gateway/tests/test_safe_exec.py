"""Subprocess-isolation smoke tests for ``safe_exec``.

These tests spawn real subprocesses — no mocks, no fakes. The whole point
is to verify the boundary actually contains user-authored exec, including
its failure modes (syntax errors, timeouts, wrong return shapes).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from core.exceptions import ServiceError
from core.service_gateway import safe_exec
from core.service_gateway.safe_exec import (
    MetricIntrospection,
    MetricProbeResult,
    ScorerProbeResult,
    SignatureIntrospection,
    probe_metric_on_sample,
    probe_scorer,
    validate_metric_code,
    validate_scorer_code,
    validate_signature_code,
)

_VALID_SIG = """\
import dspy
class QA(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()
"""

_IMAGE_SIG = """\
import dspy
class VisionQA(dspy.Signature):
    picture: dspy.Image = dspy.InputField()
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()
"""

_VALID_NUMERIC_METRIC = "def metric(example, prediction, trace=None):\n    return 1.0\n"

_VALID_PREDICTION_METRIC = (
    "import dspy\n"
    "def metric(example, prediction, trace=None,"
    " pred_name=None, pred_trace=None):\n"
    "    return dspy.Prediction(score=0.5, feedback='ok')\n"
)

# Metric that asserts the picture cell really is a dspy.Image at metric time.
# Returns 1.0 only when the runtime type is Image; on a string fallback the
# isinstance check fails and the whole probe surfaces an error — exactly the
# regression we want to catch.
_IMAGE_AWARE_METRIC = (
    "import dspy\n"
    "def metric(example, prediction, trace=None):\n"
    "    assert isinstance(example.picture, dspy.Image), type(example.picture)\n"
    "    return 1.0\n"
)


class TestValidateSignatureCode:
    """Tests for ``validate_signature_code``."""

    def test_returns_fields_for_valid_signature(self) -> None:
        """A valid signature returns a ``SignatureIntrospection`` with input/output names."""
        intro = validate_signature_code(_VALID_SIG)

        assert isinstance(intro, SignatureIntrospection)
        assert intro.class_name == "QA"
        assert intro.input_fields == ["question"]
        assert intro.output_fields == ["answer"]
        assert intro.image_input_fields == []

    def test_image_input_fields_surfaced_for_dspy_image_annotation(self) -> None:
        """``dspy.Image``-annotated inputs appear in ``image_input_fields``."""
        intro = validate_signature_code(_IMAGE_SIG)

        assert intro.image_input_fields == ["picture"]
        assert "picture" in intro.input_fields
        assert "question" in intro.input_fields

    def test_syntax_error_surfaces_as_service_error(self) -> None:
        """A syntactically invalid signature raises ``ServiceError``."""
        with pytest.raises(ServiceError, match="syntax error"):
            validate_signature_code("def !!! invalid python")

    def test_no_signature_class_surfaces_as_service_error(self) -> None:
        """Source without a ``dspy.Signature`` subclass raises ``ServiceError``."""
        with pytest.raises(ServiceError, match=r"dspy\.Signature"):
            validate_signature_code("x = 1")

    def test_infinite_loop_is_terminated(self) -> None:
        """A user infinite loop is terminated by the subprocess timeout."""
        # Regression: subprocess must enforce timeout on user code, otherwise
        # a `while True` in module-level scope hangs the validator forever.
        with pytest.raises(ServiceError, match="timeout"):
            validate_signature_code("while True: pass", timeout_seconds=2.0)


class TestValidateMetricCode:
    """Tests for ``validate_metric_code``."""

    def test_returns_param_names_for_valid_metric(self) -> None:
        """A valid metric returns ``MetricIntrospection`` with the parameter names."""
        info = validate_metric_code(_VALID_PREDICTION_METRIC)

        assert isinstance(info, MetricIntrospection)
        assert info.callable_name == "metric"
        assert info.param_names == [
            "example",
            "prediction",
            "trace",
            "pred_name",
            "pred_trace",
        ]

    def test_missing_callable_surfaces_as_service_error(self) -> None:
        """Source without any callable raises ``ServiceError``."""
        with pytest.raises(ServiceError, match="metric"):
            validate_metric_code("x = 1")

    def test_syntax_error_surfaces_as_service_error(self) -> None:
        """A syntactically invalid metric raises ``ServiceError``."""
        with pytest.raises(ServiceError, match="syntax error"):
            validate_metric_code("def !!!")


class TestProbeMetricOnSample:
    """Tests for ``probe_metric_on_sample``."""

    def test_numeric_return_is_reported(self) -> None:
        """A numeric metric return is reported as ``result_kind='numeric'``."""
        probe = probe_metric_on_sample(
            metric_code=_VALID_NUMERIC_METRIC,
            example_payload={"question": "q", "answer": "a"},
            prediction_payload={"question": "q", "answer": "a"},
            input_field_names=["question"],
        )

        assert isinstance(probe, MetricProbeResult)
        assert probe.result_kind == "numeric"
        assert probe.error is None
        assert probe.result_type_name == "float"

    def test_dspy_prediction_return_is_reported(self) -> None:
        """A ``dspy.Prediction`` return is reported as ``result_kind='prediction'``."""
        probe = probe_metric_on_sample(
            metric_code=_VALID_PREDICTION_METRIC,
            example_payload={"question": "q", "answer": "a"},
            prediction_payload={"question": "q", "answer": "a"},
            input_field_names=["question"],
        )

        assert probe.result_kind == "prediction"
        assert probe.has_score_attr is True
        assert probe.error is None

    def test_metric_exception_is_caught(self) -> None:
        """A user-raised exception inside the metric is caught and surfaced as ``error``."""
        probe = probe_metric_on_sample(
            metric_code=("def metric(example, prediction, trace=None):\n    raise RuntimeError('kaboom')\n"),
            example_payload={"question": "q", "answer": "a"},
            prediction_payload={"question": "q", "answer": "a"},
            input_field_names=["question"],
        )

        assert probe.result_kind == "error"
        assert probe.error is not None
        assert "kaboom" in probe.error

    def test_broken_metric_code_surfaces_as_service_error(self) -> None:
        """A syntactically broken metric raises ``ServiceError`` from the probe entry-point."""
        with pytest.raises(ServiceError, match="syntax error"):
            probe_metric_on_sample(
                metric_code="def !!!",
                example_payload={"question": "q", "answer": "a"},
                prediction_payload={"question": "q", "answer": "a"},
                input_field_names=["question"],
            )

    def test_image_field_value_is_wrapped_into_dspy_image(self) -> None:
        """Image input cells are wrapped into ``dspy.Image`` inside the probe subprocess."""
        probe = probe_metric_on_sample(
            metric_code=_IMAGE_AWARE_METRIC,
            example_payload={
                "picture": "https://example.com/cat.png",
                "question": "what?",
                "answer": "cat",
            },
            prediction_payload={"answer": "cat"},
            input_field_names=["picture", "question"],
            image_input_fields=["picture"],
        )

        # The metric's isinstance(example.picture, dspy.Image) assertion would
        # fail with AssertionError if the wrap didn't happen — surfaced via
        # ``probe.error``. A clean numeric return proves it did.
        assert probe.error is None
        assert probe.result_kind == "numeric"

    def test_image_field_unwrapped_when_no_image_fields_declared(self) -> None:
        """Without ``image_input_fields`` the cell stays a string and the assertion fails."""
        # Without image_input_fields, the cell stays a plain string — the metric's
        # isinstance(..., dspy.Image) assertion is expected to fail and surface via probe.error.
        probe = probe_metric_on_sample(
            metric_code=_IMAGE_AWARE_METRIC,
            example_payload={
                "picture": "https://example.com/cat.png",
                "question": "what?",
                "answer": "cat",
            },
            prediction_payload={"answer": "cat"},
            input_field_names=["picture", "question"],
            # image_input_fields not passed — defaults to None
        )

        assert probe.result_kind == "error"
        assert probe.error is not None

    def test_image_input_fields_none_is_equivalent_to_empty(self) -> None:
        """Passing ``image_input_fields=None`` behaves the same as an empty list."""
        probe = probe_metric_on_sample(
            metric_code=_VALID_NUMERIC_METRIC,
            example_payload={"question": "q", "answer": "a"},
            prediction_payload={"question": "q", "answer": "a"},
            input_field_names=["question"],
            image_input_fields=None,
        )

        assert probe.result_kind == "numeric"
        assert probe.error is None


class TestBoundedCachePut:
    """The validation memo dicts stay bounded in the long-lived API process."""

    def test_evicts_oldest_at_cap(self) -> None:
        """Insertion past the cap drops the oldest key, never the newest."""
        cache: dict[str, int] = {}
        for i in range(safe_exec._VALIDATION_CACHE_MAX_ENTRIES + 10):
            safe_exec._bounded_cache_put(cache, f"code-{i}", i)

        assert len(cache) == safe_exec._VALIDATION_CACHE_MAX_ENTRIES
        assert "code-0" not in cache
        assert f"code-{safe_exec._VALIDATION_CACHE_MAX_ENTRIES + 9}" in cache

    def test_rewriting_existing_key_does_not_evict(self) -> None:
        """Updating a present key at the cap must not shrink the cache."""
        cache: dict[str, int] = {}
        for i in range(safe_exec._VALIDATION_CACHE_MAX_ENTRIES):
            safe_exec._bounded_cache_put(cache, f"code-{i}", i)
        safe_exec._bounded_cache_put(cache, "code-0", 999)

        assert len(cache) == safe_exec._VALIDATION_CACHE_MAX_ENTRIES
        assert cache["code-0"] == 999


_VALID_SCORER = "def score(candidate, case=None):\n    return len(candidate) / 10, {'length': len(candidate)}\n"


class TestValidateScorerCode:
    """Tests for ``validate_scorer_code``."""

    def test_valid_scorer_passes(self) -> None:
        """A ``score(candidate, case)`` function loads cleanly."""
        validate_scorer_code(_VALID_SCORER)

    def test_metric_entrypoint_is_accepted(self) -> None:
        """The DSPy-style ``metric`` name is accepted as the scorer entrypoint."""
        validate_scorer_code("def metric(candidate, case=None):\n    return 1.0\n")

    def test_missing_function_is_rejected(self) -> None:
        """Code without a scorer function raises ``ServiceError``."""
        with pytest.raises(ServiceError, match="must define a function named 'score"):
            validate_scorer_code("x = 1\n")

    def test_syntax_error_is_rejected(self) -> None:
        """Unparseable code raises ``ServiceError`` mentioning the syntax error."""
        with pytest.raises(ServiceError, match="syntax error"):
            validate_scorer_code("def !!!")

    def test_import_failure_is_rejected(self) -> None:
        """Code that blows up at import time raises ``ServiceError`` with the exception."""
        with pytest.raises(ServiceError, match="failed to load: RuntimeError: boom"):
            validate_scorer_code("raise RuntimeError('boom')\n")


class TestProbeScorer:
    """Tests for ``probe_scorer``."""

    def test_returns_score_and_side_info(self) -> None:
        """A well-behaved scorer's score and side info come back from the child."""
        probe = probe_scorer(scorer_code=_VALID_SCORER, candidate="hello", case={"k": 1})

        assert probe == ScorerProbeResult(score=0.5, side_info={"length": 5}, error=None)

    def test_plain_number_return_is_normalized(self) -> None:
        """A scorer returning a bare number gets empty side info."""
        probe = probe_scorer(scorer_code="def score(candidate):\n    return 1\n", candidate="x")

        assert probe.score == 1.0
        assert probe.side_info == {}
        assert probe.error is None

    def test_scorer_exception_is_reported_not_raised(self) -> None:
        """A scorer that raises on the candidate is reported via ``error``."""
        probe = probe_scorer(
            scorer_code="def score(candidate, case=None):\n    raise ValueError('bad candidate')\n",
            candidate="x",
        )

        assert probe.score is None
        assert probe.side_info == {}
        assert probe.error == "ValueError: bad candidate"

    def test_unusable_return_value_is_reported(self) -> None:
        """A scorer returning something that is not a score is reported via ``error``."""
        probe = probe_scorer(scorer_code="def score(candidate, case=None):\n    return 'high'\n", candidate="x")

        assert probe.score is None
        assert probe.error is not None
        assert "scorer must return" in probe.error

    def test_non_json_side_info_is_stringified(self) -> None:
        """Side info that is not JSON-serializable crosses the process boundary as text."""
        probe = probe_scorer(
            scorer_code="def score(candidate, case=None):\n    return 1.0, {'when': object()}\n",
            candidate="x",
        )

        assert probe.score == 1.0
        assert isinstance(probe.side_info["when"], str)

    def test_broken_code_surfaces_as_service_error(self) -> None:
        """A scorer that fails to load raises ``ServiceError`` from the probe entrypoint."""
        with pytest.raises(ServiceError, match="syntax error"):
            probe_scorer(scorer_code="def !!!", candidate="x")


class _FakeScorerLLM:
    """Stand-in for the injected ``llm()``: records calls, answers ``0.5`` and carries usage on ``lm``."""

    def __init__(self) -> None:
        """Create the helper with an empty history."""
        self.calls: list[tuple[str, str | None]] = []
        self.lm = SimpleNamespace(model="fake/judge", history=[])

    def __call__(self, prompt: str, input: str | None = None) -> str:
        """Record the call and answer a constant score."""
        self.calls.append((prompt, input))
        self.lm.history.append({"usage": {"prompt_tokens": 3, "completion_tokens": 1}})
        return "0.5"


class _Queue:
    """List-backed stand-in for the worker's result queue."""

    def __init__(self) -> None:
        """Start empty."""
        self.items: list[dict[str, Any]] = []

    def put(self, item: dict[str, Any]) -> None:
        """Append the worker's result."""
        self.items.append(item)


_LLM_SCORER = "def score(candidate, case=None):\n    return float(llm(candidate, case['input']))\n"


class TestScorerWorkerLLM:
    """Tests for the ``llm()`` helper the scorer child binds."""

    def test_binds_llm_to_the_chosen_model_and_reports_usage(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """With a model, ``llm`` is bound to it and its tokens come back with the score."""
        helper = _FakeScorerLLM()
        chosen: list[str] = []
        monkeypatch.setattr(safe_exec, "build_scorer_llm", lambda config: chosen.append(config.name) or helper)
        queue = _Queue()

        safe_exec._scorer_worker(_LLM_SCORER, "judge this", {"input": "text"}, True, {"name": "fake/judge"}, queue)

        assert chosen == ["fake/judge"]
        assert helper.calls == [("judge this", "text")]
        assert queue.items == [
            {"ok": True, "score": 0.5, "side_info": {}, "error": None, "usage": {"fake/judge": (3, 1)}}
        ]

    def test_without_a_model_llm_explains_the_scorer_step(self) -> None:
        """Without a model, calling ``llm`` is reported as the scorer's error with the fix."""
        queue = _Queue()

        safe_exec._scorer_worker(_LLM_SCORER, "x", {"input": "text"}, True, None, queue)

        [payload] = queue.items
        assert payload["score"] is None
        assert "no model was chosen in the Scorer step" in payload["error"]
        assert payload["usage"] == {}

    def test_probe_scorer_crosses_the_process_boundary_without_usage(self) -> None:
        """A modelless probe reports the ``llm`` hint and empty usage from the child."""
        probe = probe_scorer(scorer_code=_LLM_SCORER, candidate="x", case={"input": "text"})

        assert probe.score is None
        assert probe.error is not None
        assert "no model was chosen in the Scorer step" in probe.error
        assert probe.usage_by_model == {}
