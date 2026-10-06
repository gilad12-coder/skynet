"""Check the ShinkaEvolve guest runner's pure helpers without the upstream package installed."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from core.models.blackbox import BlackboxShinkaSettings

from .. import shinka_runner


def _payload(**overrides: Any) -> dict[str, Any]:
    """Build the parent payload fields the config builder reads.

    Args:
        **overrides: Payload fields replacing the defaults.

    Returns:
        A payload with default ShinkaEvolve settings and two model routes.
    """
    return {
        "engine_id": "shinka_evolve",
        "max_evals": 20,
        "max_iterations": None,
        "shinka": BlackboxShinkaSettings().model_dump(),
        "shinka_models": [
            {"model": "claude-test", "url": "https://gw.example/v1", "key_env": "SKYNET_SHINKA_KEY_0"},
            {"model": "gpt-test", "url": "https://gw.example/v1", "key_env": "SKYNET_SHINKA_KEY_1"},
        ],
        "shinka_meta_key_env": "SKYNET_SHINKA_META_KEY",
        "task": {"objective": "Be concise.", "background": ""},
        **overrides,
    }


@pytest.mark.parametrize(
    "seed",
    [
        "Answer briefly.\n\nUse <b>bold</b> sparingly.",
        "",
        {"system": "You are terse.", "user": "Q: {question}\n\nA:"},
        {"a -->": "x", 'weird "name"': "line one\n\nline three\n", "empty": ""},
    ],
)
def test_program_packing_round_trips(seed: Any) -> None:
    """Split a packed program back into exactly the starting version.

    Args:
        seed: Text or named parts.
    """
    program = shinka_runner.pack_program(seed)
    names = list(seed) if isinstance(seed, dict) else None

    assert program.count("EVOLVE-BLOCK-START") == (len(seed) if isinstance(seed, dict) else 1)
    assert shinka_runner.unpack_program(program, names) == seed


def test_unpacking_keeps_edits_inside_blocks_and_drops_text_outside() -> None:
    """Take only the evolved text inside the markers, per part."""
    program = shinka_runner.pack_program({"system": "old", "user": "keep"})
    evolved = "A stray preface.\n" + program.replace("\nold\n", "\nnew system\nsecond line\n")

    assert shinka_runner.unpack_program(evolved, ["system", "user"]) == {
        "system": "new system\nsecond line",
        "user": "keep",
    }


@pytest.mark.parametrize(
    "mangle",
    [
        lambda program: program.replace("<!-- EVOLVE-BLOCK-END -->", "", 1),
        lambda program: program.replace('"system"', '"other"'),
        lambda program: program + "\n<!-- EVOLVE-BLOCK-START -->\nextra\n<!-- EVOLVE-BLOCK-END -->\n",
    ],
)
def test_unpacking_rejects_a_program_that_lost_its_layout(mangle: Any) -> None:
    """Refuse a program whose markers were lost, renamed or duplicated.

    Args:
        mangle: Edit that breaks the program's layout.
    """
    program = mangle(shinka_runner.pack_program({"system": "a", "user": "b"}))

    with pytest.raises(ValueError):
        shinka_runner.unpack_program(program, ["system", "user"])


def test_packing_refuses_a_seed_that_already_carries_markers() -> None:
    """Refuse a starting version whose text would be mistaken for a block boundary."""
    with pytest.raises(ValueError, match="already contains"):
        shinka_runner.pack_program("<!-- EVOLVE-BLOCK-END -->")


def test_config_maps_every_setting_onto_upstream_fields(tmp_path: Path) -> None:
    """Translate the request's settings and routes into upstream's three configs.

    Args:
        tmp_path: Results directory.
    """
    settings = BlackboxShinkaSettings(
        num_islands=3, parent_selection="power_law", patch_diff=0.5, patch_full=0.5, patch_cross=0.0
    ).model_dump()
    config = shinka_runner.build_config(_payload(shinka=settings, max_iterations=4), str(tmp_path), 2)
    evolution, database, runner = config["evolution"], config["database"], config["runner"]

    assert evolution["llm_models"] == [
        "local/claude-test@https://gw.example/v1?api_key_env=SKYNET_SHINKA_KEY_0",
        "local/gpt-test@https://gw.example/v1?api_key_env=SKYNET_SHINKA_KEY_1",
    ]
    assert evolution["meta_llm_models"] == [
        "local/claude-test@https://gw.example/v1?api_key_env=SKYNET_SHINKA_META_KEY"
    ]
    assert evolution["patch_types"] == ["diff", "full", "cross"]
    assert evolution["patch_type_probs"] == [0.5, 0.5, 0.0]
    assert evolution["llm_dynamic_selection"] == "ucb"
    assert evolution["llm_dynamic_selection_kwargs"] == {"cost_aware_coef": 0.0}
    assert evolution["embedding_model"] is None
    assert evolution["num_generations"] == 5
    assert evolution["use_text_feedback"] is True
    assert "Be concise." in evolution["task_sys_msg"]
    assert database["num_islands"] == 3
    assert database["parent_selection_strategy"] == "power_law"
    assert database["db_path"] == str(tmp_path / "programs.sqlite")
    assert runner["max_evaluation_jobs"] == 2


def test_config_turns_meta_notes_off(tmp_path: Path) -> None:
    """Leave upstream's meta notes unset when the run turned them off.

    Args:
        tmp_path: Results directory.
    """
    settings = BlackboxShinkaSettings(meta_notes=False).model_dump()
    evolution = shinka_runner.build_config(_payload(shinka=settings), str(tmp_path), 1)["evolution"]

    assert evolution["meta_llm_models"] is None
    assert evolution["meta_rec_interval"] is None


def test_config_needs_a_model(tmp_path: Path) -> None:
    """Refuse a payload without any optimization model route.

    Args:
        tmp_path: Results directory.
    """
    with pytest.raises(ValueError, match="at least one optimization model"):
        shinka_runner.build_config(_payload(shinka_models=[]), str(tmp_path), 1)


@pytest.mark.parametrize(
    ("max_evals", "examples", "max_iterations", "expected"),
    [(20, 2, None, 10), (20, 2, 3, 4), (20, 3, 50, 6), (1, 1, 0, 1)],
)
def test_generation_budget_fits_the_scorer_budget(
    max_evals: int, examples: int, max_iterations: int | None, expected: int
) -> None:
    """Create no more programs than the scorer budget and the version limit allow.

    Args:
        max_evals: Scorer runs admitted.
        examples: Scorer runs per program.
        max_iterations: Optional version limit.
        expected: Upstream ``num_generations``.
    """
    assert shinka_runner.generation_budget(max_evals, examples, max_iterations) == expected


def test_generation_budget_refuses_a_budget_below_one_program() -> None:
    """Refuse a budget that cannot score even the starting version."""
    with pytest.raises(ValueError):
        shinka_runner.generation_budget(1, 2, None)


def test_model_names_route_through_the_gateway() -> None:
    """Name each route in upstream's OpenAI-compatible form, refusing names it cannot parse."""
    assert (
        shinka_runner.local_model_name("m", "https://gw/v1?x=1", "VAR") == "local/m@https://gw/v1?x=1&api_key_env=VAR"
    )
    with pytest.raises(ValueError):
        shinka_runner.local_model_name("user@model", "https://gw/v1", "VAR")


def test_usage_kind_tells_meta_notes_from_mutations() -> None:
    """Tag the meta-notes route's calls apart from every mutation call, even on the same model."""
    meta = "local/m@https://gw/v1?api_key_env=SKYNET_SHINKA_META_KEY"
    mutation = "local/m@https://gw/v1?api_key_env=SKYNET_SHINKA_KEY_0"

    assert shinka_runner.usage_kind(meta, "SKYNET_SHINKA_META_KEY") == "meta_notes"
    assert shinka_runner.usage_kind(mutation, "SKYNET_SHINKA_META_KEY") == "mutation"
    assert json.loads(shinka_runner.usage_header("mutation")["x-skynet-usage-tags"]) == {
        "caller": "proposer",
        "kind": "mutation",
    }


def test_scores_become_upstream_metrics() -> None:
    """Report the mean as the combined score, named scores as public metrics and feedback as text."""
    metrics = shinka_runner.summarize_scores(
        [
            (1.0, {"feedback": "great", "scores": {"tone": {"score": 0.5, "feedback": "flat"}}}),
            (0.0, {"scores": {"tone": 1.0}}),
        ]
    )

    assert metrics["combined_score"] == 0.5
    assert metrics["public"] == {"tone": 0.75}
    assert metrics["private"] == {"case_0": 1.0, "case_1": 0.0}
    assert "great" in metrics["text_feedback"]
    assert "tone: 0.5 (flat)" in metrics["text_feedback"]


def test_generation_is_read_from_the_program_path() -> None:
    """Read upstream's generation from its ``gen_<n>`` directory."""
    assert shinka_runner.generation_of("/run/results/gen_12/main.py") == 12
    assert shinka_runner.generation_of("/run/results/main.py") is None


class _Mailbox:
    """Collect progress lines in place of the parent transport."""

    def __init__(self) -> None:
        """Start with no lines."""
        self.lines: list[dict[str, Any]] = []

    def emit(self, prefix: str, payload: dict[str, Any]) -> None:
        """Keep one progress payload.

        Args:
            prefix: Event family, ignored.
            payload: Progress fields.
        """
        self.lines.append(payload)


def test_lineage_reporter_names_each_versions_parent_and_depth(tmp_path: Path) -> None:
    """Report scored versions with their parent generation and lineage depth from upstream's database.

    Args:
        tmp_path: Directory for a stand-in program database.
    """
    db_path = tmp_path / "programs.sqlite"
    with shinka_runner.contextlib.closing(shinka_runner.sqlite3.connect(db_path)) as db:
        db.execute("CREATE TABLE programs (id TEXT, generation INTEGER, parent_id TEXT)")
        db.executemany(
            "INSERT INTO programs VALUES (?, ?, ?)",
            [("p0", 0, None), ("p1", 1, "p0"), ("p2", 2, "p1"), ("p2-copy", 2, "p0")],
        )
        db.commit()
    scorer = shinka_runner.ProgramScorer.__new__(shinka_runner.ProgramScorer)
    scorer._lock = shinka_runner.threading.Lock()
    scorer.scored = {generation: {"candidate": "x", "score": 0.1, "per_example": []} for generation in (0, 1, 2, 3)}
    mailbox = _Mailbox()
    reporter = shinka_runner.LineageReporter(mailbox, scorer, db_path)

    reporter.poll()
    assert [(line["candidate_id"], line["parent_id"], line["generation"]) for line in mailbox.lines] == [
        (0, None, 0),
        (1, 0, 1),
        (2, 1, 2),
    ]
    reporter.poll(final=True)
    assert mailbox.lines[-1]["candidate_id"] == 3
    assert mailbox.lines[-1]["parent_id"] is None
