"""The unified contract: static signature checks and the sampled check in a local box."""

from __future__ import annotations

import csv
import io
import json
from typing import Any

import pytest

from core.models.unified import UnifiedRunRequest
from core.service_gateway.agents.code import _unified_inputs

from ...blackbox.harness import GatewayConfig
from ...blackbox.sandbox import LocalSubprocessRuntime
from ...blackbox.tests.mocks import FakeGateway
from ..contract import (
    contract_fingerprint,
    run_contract_check,
    static_contract_check,
    validate_unified_payload,
    with_message_codes,
)

RUN_CODE = "def run(artifact, input):\n    return artifact + ':' + input['q']\n"
BLACKBOX_METRIC = "def score(input, output, expected=None):\n    return float(output == expected), {'feedback': 'ok'}\n"
# The retired per-optimizer shapes, as saved runs from before the unified contract hold them.
LEGACY_FEEDBACK_METRIC = (
    "def metric(gold, pred, trace=None, pred_name=None, pred_trace=None):\n"
    "    return {'score': 1.0, 'feedback': 'fine'}\n"
)
LEGACY_BUILD_PROGRAM = "import dspy\ndef build_program():\n    return dspy.Predict('q -> a')\n"
# A DSPy program under the one contract: run calls the module-level module. It
# returns the module's instruction so the sampled check needs no model.
DSPY_RUN_CODE = (
    "import dspy\n"
    "program = dspy.Predict('q -> answer')\n"
    "def run(artifact, input):\n"
    "    return dspy.Prediction(answer=program.signature.instructions + ':' + input['q'])\n"
)
DSPY_METRIC = (
    "def score(input, output, expected=None):\n"
    "    return float(output.answer == expected), {'feedback': output.answer}\n"
)


def _payload(
    *,
    kind: str = "prompt",
    optimizer: str = "best_of_n",
    run_code: str = RUN_CODE,
    metric_code: str = BLACKBOX_METRIC,
    metric_model: str | None = None,
) -> UnifiedRunRequest:
    """Build a pairs-mode unified run with six inline cases."""
    return UnifiedRunRequest.model_validate(
        {
            "task": {"objective": "o", "artifact": {"kind": kind, "starting_version": "p"}},
            "data": {
                "mode": "pairs",
                "cases": [{"input": {"q": str(i)}, "expected": f"p:{i}"} for i in range(6)],
                "input_fields": ["q"],
            },
            "optimizer": {"choice": optimizer},
            "models": {
                "reflection_model": {"name": "openrouter/task"},
                "metric_model": {"name": metric_model} if metric_model else None,
            },
            "workspace": {"run_code": run_code, "metric_code": metric_code, "metric_timeout_seconds": 30},
        }
    )


def _statuses(response: Any) -> dict[str, str]:
    """Map each non-sample check key to its status."""
    return {check.key: check.status for check in response.checks if check.sample_index is None}


def _check(payload: UnifiedRunRequest, **kwargs: Any) -> Any:
    """Run the sampled check in a local box against a fake gateway."""
    with FakeGateway(reply="unused") as gw:
        return run_contract_check(
            payload,
            kwargs.pop("sample_count", 2),
            gateway=GatewayConfig(url=gw.url, api_key="k"),
            protected=False,
            runtime=LocalSubprocessRuntime(),
        )


def test_static_check_passes_a_matching_blackbox_workspace() -> None:
    """Run and score both fit, and no model is needed."""
    response = static_contract_check(_payload())

    assert response.ok
    assert response.samples == []
    assert _statuses(response) == {
        "workspace.run_signature": "passed",
        "metric.signature": "passed",
        "metric.model": "passed",
    }


def test_missing_run_fails_the_run_signature() -> None:
    """Run code without ``run`` fails before anything executes."""
    response = static_contract_check(_payload(run_code="def go(artifact, input):\n    return ''\n"))

    assert not response.ok
    assert _statuses(response)["workspace.run_signature"] == "failed"
    with pytest.raises(ValueError):
        validate_unified_payload(_payload(run_code="x = 1\n"))


@pytest.mark.parametrize(
    ("kind", "optimizer", "run_code", "metric_code"),
    [
        ("dspy_program", "auto", DSPY_RUN_CODE, DSPY_METRIC),
        ("dspy_program", "dspy_gepa", DSPY_RUN_CODE, DSPY_METRIC),
        ("dspy_program", "dspy_miprov2", DSPY_RUN_CODE, DSPY_METRIC),
        ("dspy_program", "dspy_bootstrap_fewshot", DSPY_RUN_CODE, DSPY_METRIC),
        ("prompt", "gepa", RUN_CODE, BLACKBOX_METRIC),
        ("prompt", "best_of_n", RUN_CODE, BLACKBOX_METRIC),
    ],
)
def test_every_optimizer_checks_the_same_contract(kind: str, optimizer: str, run_code: str, metric_code: str) -> None:
    """run(artifact, input) plus score(input, output, expected=None) passes for every kind and optimizer.

    Args:
        kind: The artifact kind.
        optimizer: The optimizer the user picked.
        run_code: Run code written to the one contract.
        metric_code: Metric written to the one contract.
    """
    response = static_contract_check(
        _payload(kind=kind, optimizer=optimizer, run_code=run_code, metric_code=metric_code)
    )

    assert response.ok, response.checks
    validate_unified_payload(_payload(kind=kind, optimizer=optimizer, run_code=run_code, metric_code=metric_code))


def test_retired_shapes_ask_to_regenerate_the_code() -> None:
    """Code saved under build_program() / metric(gold, pred, ...) fails with a regenerate hint."""
    payload = _payload(
        kind="dspy_program", optimizer="dspy_gepa", run_code=LEGACY_BUILD_PROGRAM, metric_code=LEGACY_FEEDBACK_METRIC
    )
    response = static_contract_check(payload)

    details = {check.key: check.detail or "" for check in response.checks}
    assert not response.ok
    assert _statuses(response)["workspace.run_signature"] == "failed"
    assert _statuses(response)["metric.signature"] == "failed"
    assert "regenerate the run code" in details["workspace.run_signature"]
    assert "regenerate the metric" in details["metric.signature"]
    with pytest.raises(ValueError, match="regenerate the run code"):
        validate_unified_payload(payload)


def test_a_guest_holding_an_older_contract_never_reads_as_all_passed() -> None:
    """A static item the sandbox failed but the host passed stays visible as a failed run item."""
    payload = _payload(kind="dspy_program", optimizer="dspy_gepa", run_code=DSPY_RUN_CODE, metric_code=DSPY_METRIC)
    static = static_contract_check(payload)
    guest = static.model_copy(
        update={
            "ok": False,
            "checks": [
                static.checks[0].model_copy(
                    update={"status": "failed", "detail": "NameError: build_program is not defined"}
                ),
                *static.checks[1:],
            ],
        }
    )

    response = with_message_codes(guest, static)

    assert static.ok
    assert not response.ok
    failed = [check for check in response.checks if check.status == "failed"]
    assert [check.key for check in failed] == ["workspace.run"]
    assert failed[0].message_code == "submit.unified.contract_failed"
    assert "build_program is not defined" in failed[0].message_params["error"]


def test_sampled_check_runs_a_dspy_program_through_run(tmp_path: Any) -> None:
    """In a local box the DSPy program's run applies the candidate to its module and score reads the output.

    Args:
        tmp_path: Unused; keeps the box's working files out of the repo.
    """
    del tmp_path
    response = _check(
        _payload(kind="dspy_program", optimizer="dspy_gepa", run_code=DSPY_RUN_CODE, metric_code=DSPY_METRIC)
    )

    assert response.ok, [check.detail for check in response.checks if check.status != "passed"]
    assert [sample.score for sample in response.samples] == [1.0, 1.0]


def test_blackbox_score_with_one_argument_fails_the_signature() -> None:
    """``score`` must accept at least input and output."""
    response = static_contract_check(_payload(metric_code="def score(output):\n    return 1.0, {}\n"))

    assert _statuses(response)["metric.signature"] == "failed"


def test_metric_calling_llm_needs_a_metric_model() -> None:
    """A metric that calls ``llm`` without a metric model fails ``metric.model``."""
    metric = "from skynet import llm\ndef score(input, output):\n    return float(llm('j', output)), {}\n"

    without = static_contract_check(_payload(metric_code=metric))
    with_model = static_contract_check(_payload(metric_code=metric, metric_model="openrouter/judge"))

    assert _statuses(without)["metric.model"] == "failed"
    assert _statuses(with_model)["metric.model"] == "passed"
    assert without.uses_llm
    assert with_model.uses_llm
    assert not static_contract_check(_payload()).uses_llm


def test_fingerprint_tracks_the_code_and_the_data() -> None:
    """Editing code, cases, split, task model or timeout changes the fingerprint; the same inputs hash the same."""
    base = contract_fingerprint(_payload())

    assert contract_fingerprint(_payload()) == base
    assert contract_fingerprint(_payload(metric_code=BLACKBOX_METRIC + "\n# edit\n")) != base
    edits: list[dict[str, Any]] = [
        {"data": {"cases": [{"input": {"q": "x"}, "expected": "p:x"}] * 6}},
        {"data": {"cases": None, "staged_dataset_id": "ds-1"}},
        {"data": {"split": {"train": 0.5, "val": 0.25, "test": 0.25}}},
        {"data": {"shuffle": False}},
        {"models": {"task_model": {"name": "openrouter/other"}}},
        {"workspace": {"metric_timeout_seconds": 5}},
    ]
    for edit in edits:
        raw = _payload().model_dump(mode="json")
        for section, fields in edit.items():
            raw[section].update(fields)
        assert contract_fingerprint(UnifiedRunRequest.model_validate(raw)) != base


def test_sampled_check_passes_and_reports_each_sample() -> None:
    """A fitting workspace passes every sample and previews its output."""
    response = _check(_payload())

    assert response.ok
    assert [sample.index for sample in response.samples] == [0, 1]
    assert all(sample.score == 1.0 for sample in response.samples)
    assert {check.key for check in response.checks if check.sample_index == 0} == {"workspace.run", "metric.shape"}


def test_blackbox_score_returning_a_bare_float_fails_the_shape() -> None:
    """A score function returning only a number fails ``metric.shape`` with the blackbox message."""
    response = _check(_payload(metric_code="def score(input, output):\n    return 1.0\n"))

    shape = [check for check in response.checks if check.key == "metric.shape"]
    assert not response.ok
    assert shape
    assert shape[0].status == "failed"


def test_run_crash_reports_the_users_error_and_skips_the_metric() -> None:
    """The exact error reaches the item, without the harness's own frames."""
    run_code = "def run(artifact, input):\n    raise KeyError('missing_field')\n"
    response = _check(_payload(run_code=run_code), sample_count=1)

    run = next(check for check in response.checks if check.key == "workspace.run")
    shape = next(check for check in response.checks if check.key == "metric.shape")
    assert run.status == "failed"
    assert "missing_field" in (run.detail or "")
    assert "workspace_harness" not in (run.detail or "")
    assert shape.status == "skipped"


def test_static_failure_never_opens_a_box() -> None:
    """When the signatures do not fit, nothing runs and no samples come back."""

    class _Refuse(LocalSubprocessRuntime):
        """A runtime that must never be asked for a box."""

        def open(self, spec: Any) -> Any:
            """Fail the test if a box is opened."""
            raise AssertionError("opened a box")

    response = run_contract_check(_payload(run_code="x = 1\n"), 2, gateway=None, protected=False, runtime=_Refuse())

    assert not response.ok
    assert response.samples == []


def test_check_items_carry_their_message_code_for_the_client_locale() -> None:
    """The client renders each item from its code, so an English UI never shows the Hebrew base."""
    response = static_contract_check(_payload(metric_code="x = 1\n"))

    codes = {check.key: (check.message_code, check.message_params) for check in response.checks}
    assert codes["workspace.run_signature"] == ("contract.passed", {})
    assert codes["metric.signature"] == ("contract.metric_missing", {})


def test_a_sample_run_error_carries_its_params() -> None:
    """A failing sample's message code keeps the placeholders the client fills in."""
    response = _check(_payload(run_code="def run(artifact, input):\n    raise ValueError('boom')\n"))

    failed = next(check for check in response.checks if check.key == "workspace.run" and check.status == "failed")
    assert failed.message_code == "contract.run_error"
    assert failed.message_params["index"] == 1
    assert "boom" in str(failed.message_params["error"])


REVIEWS_CSV = (
    "review,product,rating,sentiment\n"
    "Great sound,Headphones,5,positive\n"
    "Broke in a week,Kettle,1,negative\n"
    "Does the job,Lamp,3,neutral\n"
)


def test_a_multi_column_csv_gives_the_agent_and_the_check_the_same_input_fields() -> None:
    """Run code written against the fields the agent is shown passes the sampled check.

    The wizard ignored ``product`` and ``rating``; the seed once still showed
    them, so the agent read ``input["product"]`` and every sample failed with
    ``KeyError``.
    """
    rows = list(csv.DictReader(io.StringIO(REVIEWS_CSV)))
    input_fields = ["review"]
    cases = [{"input": {f: row[f] for f in input_fields}, "expected": row["sentiment"]} for row in rows]
    seen = _unified_inputs(
        {
            "task": {"objective": "o", "artifact": {"kind": "prompt", "starting_version": "p"}},
            "input_fields": input_fields,
            "expected_field": "sentiment",
            "sample_cases": [{"input": dict(row), "expected": row["sentiment"]} for row in rows],
        }
    )
    agent_fields = sorted({key for case in json.loads(seen["sample_cases"]) for key in case["input"]})
    reads = " + ".join(f"input[{field!r}]" for field in agent_fields)
    raw = _payload().model_dump(mode="json")
    raw["data"].update({"cases": cases * 2, "input_fields": input_fields})
    raw["workspace"]["run_code"] = f"def run(artifact, input):\n    return {reads}\n"

    response = _check(UnifiedRunRequest.model_validate(raw), sample_count=3)

    assert seen["case_fields"] == agent_fields == input_fields
    assert [check.status for check in response.checks if check.key == "workspace.run"] == ["passed"] * 3


@pytest.mark.parametrize(
    ("run_code", "metric_code"),
    [
        (RUN_CODE, BLACKBOX_METRIC),
        ("def run(artifact, input):\n    return input['missing']\n", BLACKBOX_METRIC),
        (RUN_CODE, "def score(input, output, expected=None):\n    return 1.0\n"),
        (RUN_CODE, "def score(input, output, expected=None):\n    raise ValueError('bad')\n"),
    ],
)
def test_every_item_and_sample_result_carries_a_message_code(run_code: str, metric_code: str) -> None:
    """Passing, failing and skipped items alike render from their code in the client's locale."""
    response = _check(_payload(run_code=run_code, metric_code=metric_code), sample_count=2)

    assert response.samples
    assert all(check.message_code for check in response.checks)
    assert {check.sample_index for check in response.checks if check.sample_index is not None} == {0, 1}
