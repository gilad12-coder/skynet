"""A reward made in the reward builder runs unchanged through the run's harness (SKY-84).

``fixtures/reward_builder_metric.txt`` is what the frontend's builder writes
for a fixed set of rewards; the frontend test checks that it still does.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from .. import runner
from ..workspace_harness import Workspace, reward_spec
from .mocks import FakeGateway

BUILDER_METRIC = (Path(__file__).parent / "fixtures" / "reward_builder_metric.txt").read_text(encoding="utf-8")
RUN = "from skynet import llm\ndef run(artifact, input):\n    return llm(artifact + input['question'])\n"


@pytest.fixture(autouse=True)
def _restore_helper_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """Undo the harness's ``import skynet`` binding after each test."""
    monkeypatch.setitem(sys.modules, runner.HELPER_MODULE_NAME, None)


def _score(gateway: FakeGateway, answer: Any) -> dict[str, Any]:
    """Run one case through a workspace with the builder metric and return the reply."""
    task = {"url": gateway.url, "model": "task", "api_key": "task-key", "timeout_seconds": 10}
    workspace = Workspace(
        {
            "run_code": RUN,
            "metric_code": BUILDER_METRIC,
            "files": {},
            "artifact_kind": "prompt",
            "input_fields": ["question"],
            "gateways": {"task": task, "metric": None},
        }
    )
    case = {"input": {"question": "2+2?"}, "expected": {"answer": answer}}
    return workspace.handle({"candidate": "Answer: ", "case": case})


def test_builder_metric_declares_a_valid_spec() -> None:
    """The written REWARD_SPEC passes the harness's own check, weighted by rule weight."""
    namespace: dict[str, Any] = {}
    start = BUILDER_METRIC.index("REWARD_SPEC = ")
    end = BUILDER_METRIC.index("\nREWARD_RULES = ")
    exec(BUILDER_METRIC[start:end], namespace)
    spec = reward_spec(namespace["REWARD_SPEC"])
    assert spec["weights"] == pytest.approx({"accuracy": 5.5 / 7, "speed": 1 / 7, "cost": 0.5 / 7})


def test_builder_metric_scores_a_reply_by_its_rules() -> None:
    """A bare "4" passes exact-answer, numeric-close and length, and fails the format rules."""
    with FakeGateway("4", cost=0.001) as gateway:
        reply = _score(gateway, "4")

    reward = reply["side_info"]["reward"]
    assert reward["raw"]["accuracy"] == pytest.approx(3 / 5.5)
    assert reward["raw"]["cost_usd"] == pytest.approx(0.001)
    assert "exact-answer 2 (match)" in reply["side_info"]["feedback"]
    assert "strict-xml-format 0 (no match)" in reply["side_info"]["feedback"]
    assert reply["score"] == pytest.approx(sum(reward["contributions"].values()))


def test_builder_metric_reads_a_non_string_expected_value() -> None:
    """A number in the expected column compares by its text."""
    with FakeGateway("<answer>12</answer>") as gateway:
        reply = _score(gateway, 12)

    feedback = reply["side_info"]["feedback"]
    assert "numeric-close 3 (within 0)" in feedback
    assert "soft-xml-format 0.5 (match)" in feedback
