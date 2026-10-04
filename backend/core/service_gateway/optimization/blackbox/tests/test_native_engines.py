"""Exercise the Meta-Harness and AutoResearch loops against the real evaluation server."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from gepa.oa.budget import BudgetTracker
from gepa.oa.config import OptimizeAnythingConfig
from gepa.oa.eval_server import EvalServer
from gepa.oa.task import Task

from core.service_gateway.optimization.blackbox import native_engines, repo_tree

FAKE_HEADER = (
    f"#!{sys.executable}\n"
    "import json, os, pathlib, subprocess, sys\n"
    "args = sys.argv[1:]\n"
    "with (pathlib.Path.home() / 'invocations.jsonl').open('a') as history: history.write(json.dumps(args) + '\\n')\n"
    "count = sum(1 for _ in (pathlib.Path.home() / 'invocations.jsonl').open())\n"
)
FAKE_FOOTER = (
    "print(json.dumps({'type': 'result', 'result': 'done', 'session_id': "
    "args[args.index('--session-id') + 1] if '--session-id' in args else args[args.index('--resume') + 1], "
    "'total_cost_usd': 0.01}))\n"
)


def _config(engine: str, **engine_config: Any) -> OptimizeAnythingConfig:
    """Build the run config the sandbox runner would build.

    Args:
        engine: Engine id.
        **engine_config: Engine knobs beyond the model.

    Returns:
        A config with a temporary run directory left for the caller to set.
    """
    return OptimizeAnythingConfig(engine=engine, max_evals=10, engine_config={"model": "claude-test", **engine_config})


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Put a writable home and a ``bin`` directory for the fake ``claude`` first on PATH."""
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", f"{home / 'bin'}{os.pathsep}/usr/bin:/bin")
    return home


def _install_fake(home: Path, body: str) -> None:
    """Write the fake ``claude`` executable.

    Args:
        home: Fake home whose ``bin`` is on PATH.
        body: Script lines between the shared header and footer.
    """
    script = home / "bin" / "claude"
    script.write_text(FAKE_HEADER + body + FAKE_FOOTER)
    script.chmod(0o755)


def _invocations(home: Path) -> list[list[str]]:
    """Read every argument vector the fake ``claude`` received."""
    return [json.loads(line) for line in (home / "invocations.jsonl").read_text().splitlines()]


@pytest.fixture
def server() -> Iterator[EvalServer]:
    """Serve a two-example task whose score rewards the word ``better``."""
    task = Task(name="t", seed_candidate="seed", objective="be better", train_set=[{"id": "a"}, {"id": "b"}])

    def evaluate(candidate: str, example: dict[str, Any] | None = None) -> tuple[float, dict[str, Any]]:
        """Score ``better`` candidates highly, more on example ``a``, with binary-exact averages."""
        base = 0.75 if "better" in candidate else 0.25
        return base + (0.25 if example and example.get("id") == "a" else 0.0), {"feedback": "ok"}

    instance = EvalServer(task, evaluate, BudgetTracker(max_evals=10), max_concurrency=1)
    instance.start()
    try:
        yield instance
    finally:
        instance.stop()


def test_pinned_prompts_match_upstream_checksums() -> None:
    """Refuse to run on prompt files that differ from the pinned upstream revisions."""
    assert native_engines.check_assets() == {
        "meta_harness": native_engines.META_HARNESS_REVISION,
    }
    for relative, digest in native_engines.ASSET_CHECKSUMS.items():
        text = (native_engines.PROMPTS_DIR / relative).read_text(encoding="utf-8")
        assert hashlib.sha256(text.encode("utf-8")).hexdigest() == digest


def test_adapt_fails_loudly_on_drifted_or_ambiguous_snippets() -> None:
    """Every substitution must match exactly once so a pin bump cannot silently change meaning."""
    assert native_engines.adapt("one two three", [("two", "2"), ("one", "three", "all")]) == "all"
    with pytest.raises(RuntimeError, match="matched 0 times"):
        native_engines.adapt("one two", [("three", "3")])
    with pytest.raises(RuntimeError, match="matched 2 times"):
        native_engines.adapt("two two", [("two", "2")])
    with pytest.raises(RuntimeError, match="inverted"):
        native_engines.adapt("one two", [("two", "one", "x")])


def test_adapted_prompts_replace_the_upstream_domains() -> None:
    """The nanochat and memory-system wording gives way to the evaluator and candidate files."""
    skill = native_engines.MetaHarnessEngine(_config("meta_harness", max_candidates_per_iter=2)).skill()
    assert "2 new candidates" in skill
    assert "CANDIDATES: <name1>, <name2>" in skill
    assert "agents/<name>.txt" in skill
    assert "MemorySystem" not in skill
    assert "dataset" not in skill.lower()
    brief = native_engines.AutoResearchEngine(_config("autoresearch"))
    brief.example_ids = ["a"]
    text = brief._brief()
    assert "./eval.sh <file> <example_id>" in text
    assert "BUDGET_EXHAUSTED" in text


def test_meta_harness_benchmarks_seed_then_proposed_candidates(
    tmp_path: Path, fake_home: Path, server: EvalServer
) -> None:
    """Phase 0 scores the seed, each iteration scores the proposer's files, and the frontier tracks the best."""
    _install_fake(
        fake_home,
        "assert '--tools' in args and '--append-system-prompt' in args and '--session-id' in args\n"
        "assert 'Run iteration' in args[-1] and pathlib.Path('.claude/skills/meta-harness/SKILL.md').exists()\n"
        "pathlib.Path('agents/better.txt').write_text('a better candidate')\n"
        "pathlib.Path('agents/empty.txt').write_text('')\n"
        "pathlib.Path('logs/run/pending_eval.json').write_text(json.dumps({'candidates': ["
        "{'name': 'better', 'file': 'agents/better.txt', 'axis': 'exploitation', 'hypothesis': 'h'},"
        "{'name': 'empty', 'file': 'agents/empty.txt'},"
        "{'name': '../escape', 'file': '../../etc/passwd'}]}))\n",
    )
    config = _config("meta_harness", max_iterations=1, max_candidates_per_iter=3)
    config.run_dir = str(tmp_path / "run")
    engine = native_engines.MetaHarnessEngine(config)
    result = engine.run(server.task, server)
    assert (result.best_candidate, result.best_score) == ("a better candidate", 0.875)
    assert result.total_evals == 4
    assert (result.metadata["iterations"], result.metadata["stop_reason"]) == (1, "max_iterations")
    assert engine.incumbent(server) == ("a better candidate", 0.875)
    assert native_engines.best_aggregate_candidate(server) == ("a better candidate", 0.875)
    logs = engine.logs_dir
    rows = [json.loads(line) for line in (logs / "evolution_summary.jsonl").read_text().splitlines()]
    assert [row["system"] for row in rows] == ["better", "empty", "../escape"]
    assert (rows[0]["outcome"], rows[0]["delta"]) == ("0.8750 (+0.5000)", 0.5)
    assert "timing_s" in rows[0]
    assert rows[1]["outcome"] == "failed: candidate file is empty"
    assert rows[2]["outcome"] == "failed: invalid candidate name"
    frontier = json.loads((logs / "frontier_val.json").read_text())
    assert [entry["system"] for entry in frontier["_pareto"]] == ["better", "seed"]
    assert frontier["a"] == {"system": "better", "val_accuracy": 1.0}
    assert json.loads((logs / "results" / "better" / "val.json").read_text())["scores"] == {"a": 1.0, "b": 0.75}
    assert len(_invocations(fake_home)) == 1
    assert (logs / "claude_sessions" / "iter1_stdout.json").read_text().startswith('{"type": "result"')


def test_autoresearch_runs_directed_rounds_on_engine_recorded_evidence(
    tmp_path: Path, fake_home: Path, server: EvalServer
) -> None:
    """Each round is a fresh session steered by STATE.md, which the engine fills from the evaluator's answers."""
    _install_fake(
        fake_home,
        "state = pathlib.Path('STATE.md').read_text()\n"
        "notebook = pathlib.Path('notebook.md')\n"
        "def run(*argv):\n"
        "    done = subprocess.run(['./eval.sh', *argv], capture_output=True, text=True)\n"
        "    assert done.returncode == 0, done.stdout + done.stderr\n"
        "    return json.loads(done.stdout)\n"
        "if count == 1:\n"
        "    assert '**Survey.**' in state and 'Nothing has been fully evaluated yet.' in state\n"
        "    assert run('work/seed.txt')['average_score'] == 0.375\n"
        "    pathlib.Path('work/better.txt').write_text('better 1')\n"
        "    assert run('work/better.txt', 'b')['scores'] == {'b': 0.75}\n"
        "    assert run('work/better.txt')['average_score'] == 0.875\n"
        "    notebook.write_text(notebook.read_text() + '## Round 1\\nconfirmed: better helps\\n')\n"
        "elif count == 2:\n"
        "    assert '**Exploit.**' in state and '| c002 | 0.8750 | yes |' in state and '`b` | 0.750' in state\n"
        "    assert 'Round 1' in notebook.read_text() and pathlib.Path('frontier/c002.txt').read_text() == 'better 1'\n"
        "    pathlib.Path('work/better2.txt').write_text('better 2')\n"
        "    run('work/better2.txt')\n"
        "else:\n"
        "    assert '**Explore.**' in state and \"did not beat `c002`\" in state\n",
    )
    config = _config("autoresearch")
    config.run_dir = str(tmp_path / "run")
    engine = native_engines.AutoResearchEngine(config)
    result = engine.run(server.task, server)
    assert result.best_score == 0.875
    assert result.best_candidate.startswith("better")
    assert result.total_evals == 7
    assert result.metadata["directives"] == ["survey", "exploit", "explore"]
    assert (result.metadata["rounds"], result.metadata["candidates_evaluated"]) == (3, 3)
    assert [entry["id"] for entry in result.metadata["frontier"]] == ["c002", "c003"]
    invocations = _invocations(fake_home)
    assert len(invocations) == 3
    assert all("--session-id" in call and "--resume" not in call for call in invocations)
    assert len(set(result.metadata["session_ids"])) == 3
    index = (engine.work_dir / "archive" / "index.tsv").read_text().splitlines()
    assert [row.split("\t")[0] for row in index] == ["id", "c001", "c002", "c003"]
    assert [o.full for o in engine.observations] == [True, False, True, True]
    assert "evaluate_examples" not in vars(server)
    assert (engine.run_dir / "sessions" / "round3_stdout.json").exists()
    output = tmp_path / "out"
    engine.process_result(result, output)
    assert "Round 1" in (output / "autoresearch" / "notebook.md").read_text()


def test_autoresearch_directives_follow_the_evidence(tmp_path: Path) -> None:
    """Complementary frontier members trigger a combine round; stalls trigger a pivot."""
    engine = native_engines.AutoResearchEngine(_config("autoresearch"))
    engine.work_dir = tmp_path
    (tmp_path / "archive").mkdir()
    engine.round = 1
    assert engine._directive(0, False) == "survey"
    specialist = native_engines.Observation("x", {"a": 1.0, "b": 0.0}, {}, True, 1)
    generalist = native_engines.Observation("y", {"a": 0.5, "b": 0.75}, {}, True, 1)
    for observation in (specialist, generalist):
        engine._observe(observation)
    assert native_engines.pareto_front(engine._table()) == ["y", "x"]
    assert engine._partner() == ("x", ["a"])
    engine.round, engine.directives = 2, ["survey"]
    assert engine._directive(0, True) == "combine"
    engine.directives.append("combine")
    assert engine._directive(0, True) == "exploit"
    assert engine._directive(1, False) == "explore"
    assert engine._directive(2, False) == "pivot"
    table = engine._table()
    assert "`c001` beats the leader `c002` on `a`" in engine._directive_text("combine", table, ["y", "x"])


def test_autoresearch_eval_sh_reports_budget_exhaustion_and_ends_the_run(
    tmp_path: Path, fake_home: Path, server: EvalServer
) -> None:
    """HTTP 429 from the evaluator surfaces the marker, and no further round starts."""
    _install_fake(
        fake_home,
        "pathlib.Path('work/c.txt').write_text('better')\n"
        "first = subprocess.run(['./eval.sh', 'work/c.txt'], capture_output=True, text=True)\n"
        "second = subprocess.run(['./eval.sh', 'work/c.txt'], capture_output=True, text=True)\n"
        "assert first.returncode == 0 and second.returncode == 1, second.stdout + second.stderr\n"
        "assert 'BUDGET_EXHAUSTED' in second.stderr\n"
        "print(second.stderr, file=sys.stderr)\n",
    )
    server.budget = BudgetTracker(max_evals=2)
    config = _config("autoresearch")
    config.run_dir = str(tmp_path / "run")
    result = native_engines.AutoResearchEngine(config).run(server.task, server)
    assert (result.best_candidate, result.best_score, result.total_evals) == ("better", 0.875, 2)
    assert (result.metadata["rounds"], len(_invocations(fake_home))) == (1, 1)


def test_autoresearch_single_round_when_multi_round_is_off(tmp_path: Path, fake_home: Path, server: EvalServer) -> None:
    """With ``ralph`` off the engine runs exactly one research round."""
    _install_fake(fake_home, "subprocess.run(['./eval.sh', 'work/seed.txt'], check=True, capture_output=True)\n")
    config = _config("autoresearch", ralph=False)
    config.run_dir = str(tmp_path / "run")
    result = native_engines.AutoResearchEngine(config).run(server.task, server)
    assert (result.best_candidate, result.metadata["rounds"], result.total_evals) == ("seed", 1, 2)


def test_autoresearch_without_any_evaluation_fails_instead_of_guessing(
    tmp_path: Path, fake_home: Path, server: EvalServer
) -> None:
    """A session that never called the evaluator leaves nothing verified to return."""
    _install_fake(fake_home, "pathlib.Path('work/c.txt').write_text('unscored')\n")
    config = _config("autoresearch")
    config.run_dir = str(tmp_path / "run")
    with pytest.raises(RuntimeError, match="without scoring any candidate"):
        native_engines.AutoResearchEngine(config).run(server.task, server)
    assert "evaluate_examples" not in vars(server)


def _repo_checkout(tmp_path: Path, files: dict[str, str]) -> Path:
    """Pack ``files`` and unpack them the way the native runner builds its checkout.

    Args:
        tmp_path: Scratch folder.
        files: Relative path to text.

    Returns:
        The checkout.
    """
    source = tmp_path / "source"
    for name, text in files.items():
        (source / name).parent.mkdir(parents=True, exist_ok=True)
        (source / name).write_text(text)
    archive = tmp_path / "tree.tgz"
    subprocess.run(["tar", "-czf", str(archive), "-C", str(source), "."], check=True)
    chunks = []
    for index, chunk in enumerate(repo_tree.archive_chunks(archive)):
        chunks.append(tmp_path / f"tree.{index}.b64")
        chunks[-1].write_text(chunk)
    return repo_tree.unpack_tree(chunks, tmp_path / "repo-checkout")


def test_autoresearch_edits_a_repository_checkout_and_scores_its_patch(tmp_path: Path, fake_home: Path) -> None:
    """The agent edits ``repo/`` in place; eval.sh sends the diff, and refuses edits outside the editable paths."""
    task = Task(name="repo", seed_candidate="", objective="make it better")
    seen: list[str] = []

    def evaluate(candidate: str, example: dict[str, Any] | None = None) -> tuple[float, dict[str, Any]]:
        """Score a patch that adds the word ``better`` highly."""
        seen.append(candidate)
        return (1.0 if "+better" in candidate else 0.5), {"feedback": "ok"}

    single = EvalServer(task, evaluate, BudgetTracker(max_evals=5))
    single.start()
    try:
        _install_fake(
            fake_home,
            "def run(*argv):\n"
            "    return subprocess.run(list(argv), capture_output=True, text=True)\n"
            "if count == 1:\n"
            "    assert 'Survey' in pathlib.Path('STATE.md').read_text()\n"
            "    assert '`src`' in pathlib.Path('TASK.md').read_text()\n"
            "    assert run('./eval.sh').returncode == 0\n"
            "    pathlib.Path('repo/src/app.py').write_text('better\\n')\n"
            "    subprocess.run(['git', '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qam', 'x'],\n"
            "                   cwd='repo', check=True)\n"
            "    done = run('./eval.sh')\n"
            "    assert done.returncode == 0 and json.loads(done.stdout)['score'] == 1.0, done.stderr\n"
            "    pathlib.Path('repo/README.md').write_text('changed\\n')\n"
            "    refused = run('./eval.sh')\n"
            "    assert refused.returncode != 0 and 'README.md' in refused.stderr, refused.stderr\n"
            "    assert run('./checkout.sh', 'base').returncode == 0\n"
            "    assert pathlib.Path('repo/README.md').read_text() == 'hi\\n'\n"
            "    assert pathlib.Path('repo/src/app.py').read_text() == 'x = 1\\n'\n"
            "    assert run('./checkout.sh', 'c002').returncode == 0\n"
            "    assert pathlib.Path('repo/src/app.py').read_text() == 'better\\n'\n"
            "    assert run('./checkout.sh', '../x').returncode == 2\n",
        )
        checkout = _repo_checkout(tmp_path, {"src/app.py": "x = 1\n", "README.md": "hi\n"})
        config = _config(
            "autoresearch",
            ralph=False,
            repo={
                "checkout": str(checkout),
                "base": repo_tree.BASE_REF,
                "editable_paths": ["src"],
                "readonly_paths": [],
                "tools": str(Path(repo_tree.__file__).parent),
            },
        )
        config.run_dir = str(tmp_path / "run")
        engine = native_engines.AutoResearchEngine(config)
        result = engine.run(task, single)
    finally:
        single.stop()
    assert len(seen) == 2
    assert seen[0] == ""
    assert result.best_score == 1.0
    assert repo_tree.patch_paths(result.best_candidate) == ["src/app.py"]
    assert (engine.work_dir / "archive" / "c002.patch").read_text() == result.best_candidate
    assert "checkout.sh" in (engine.work_dir / "BRIEF.md").read_text()
    output = tmp_path / "out"
    engine.process_result(result, output)
    assert (output / "autoresearch" / "best_candidate.patch").read_text() == result.best_candidate


def _repo_config(tmp_path: Path, checkout: Path, **knobs: Any) -> OptimizeAnythingConfig:
    """Build a ``gepa_repo`` config over ``checkout`` whose editable path is ``src``.

    Args:
        tmp_path: Scratch folder holding the run directory.
        checkout: Checkout made by ``_repo_checkout``.
        **knobs: Extra engine knobs.

    Returns:
        The config.
    """
    config = _config(
        "gepa_repo",
        repo={
            "checkout": str(checkout),
            "base": repo_tree.BASE_REF,
            "editable_paths": ["src"],
            "readonly_paths": ["vendor/lib"],
            "tools": str(Path(repo_tree.__file__).parent),
        },
        **knobs,
    )
    config.run_dir = str(tmp_path / "run")
    config.max_token_cost = 1.0
    return config


def test_gepa_drives_an_agent_proposer_over_repository_versions(tmp_path: Path, fake_home: Path) -> None:
    """GEPA picks the parent and cases; the agent edits a checkout of it and the diff becomes the next version."""
    task = Task(
        name="repo",
        seed_candidate="",
        objective="make it better",
        train_set=[{"id": "a"}, {"id": "b"}],
    )
    seen: list[str] = []

    def evaluate(candidate: str, example: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        """Score a patch that writes ``better`` into ``src/app.py`` highly."""
        seen.append(candidate)
        if "+better" in candidate:
            return 1.0, {"feedback": f"case {example['id']} passes"}
        return 0.25, {"feedback": f"case {example['id']} needs better code"}

    dataset = EvalServer(task, evaluate, BudgetTracker(max_evals=12))
    dataset.start()
    try:
        _install_fake(
            fake_home,
            "prompt = args[-1]\n"
            "assert 'needs better code' in prompt, prompt\n"
            "assert '`src`' in prompt and 'vendor/lib' in prompt and 'make it better' in prompt, prompt\n"
            "assert pathlib.Path('src/app.py').read_text() == 'x = 1\\n'\n"
            "pathlib.Path('src/app.py').write_text('better\\n')\n",
        )
        checkout = _repo_checkout(tmp_path, {"src/app.py": "x = 1\n", "README.md": "hi\n"})
        engine = native_engines.GepaRepoEngine(_repo_config(tmp_path, checkout, effort="low"))
        result = engine.run(task, dataset)
    finally:
        dataset.stop()
    assert seen[0] == ""
    assert result.best_score == 1.0
    assert repo_tree.patch_paths(result.best_candidate) == ["src/app.py"]
    assert result.metadata["proposals"] >= 1
    assert result.metadata["proposer_cost_usd"] == pytest.approx(0.01 * result.metadata["proposals"])
    assert all("--effort" in argv and "low" in argv for argv in _invocations(fake_home))
    assert (checkout / "src" / "app.py").read_text() == "x = 1\n"
    output = tmp_path / "out"
    engine.process_result(result, output)
    assert (output / "gepa_repo" / "best_candidate.patch").read_text() == result.best_candidate


def test_agent_proposer_keeps_the_parent_when_its_diff_is_too_large(
    tmp_path: Path, fake_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A diff too large to ship as one sandbox file never becomes a version."""
    _install_fake(fake_home, "pathlib.Path('src/app.py').write_text('y' * 4096)\n")
    checkout = _repo_checkout(tmp_path, {"src/app.py": "x = 1\n"})
    engine = native_engines.GepaRepoEngine(_repo_config(tmp_path, checkout))
    monkeypatch.setattr(repo_tree, "MAX_PATCH_BYTES", 1024)
    proposed = engine.proposer({"current_candidate": ""}, {"current_candidate": []}, ["current_candidate"])
    assert proposed == {"current_candidate": ""}
    assert engine.proposer.total_cost == pytest.approx(0.01)
    assert "No per-case feedback was recorded." in _invocations(fake_home)[0][-1]
    assert (checkout / "src" / "app.py").read_text() == "x = 1\n"


def test_gepa_repo_engine_needs_a_checkout() -> None:
    """The agent-proposer GEPA engine has nothing to edit without a repository."""
    with pytest.raises(ValueError, match="repository checkout"):
        native_engines.GepaRepoEngine(_config("gepa_repo"))


def test_single_candidate_tasks_use_the_whole_candidate_route(tmp_path: Path, fake_home: Path) -> None:
    """Without a dataset the evaluator scores the candidate as a whole and the server's best is the answer."""
    task = Task(name="single", seed_candidate="seed")
    single = EvalServer(
        task,
        lambda candidate, example=None: (len(candidate) / 10, {"feedback": "too short"}),
        BudgetTracker(max_evals=5),
    )
    single.start()
    try:
        _install_fake(
            fake_home,
            "state = pathlib.Path('STATE.md').read_text()\n"
            "assert count == 1 or 'too short' in state, state\n"
            "pathlib.Path('work/c.txt').write_text('longer text' + 'x' * count)\n"
            "run = subprocess.run(['./eval.sh', 'work/c.txt'], capture_output=True, text=True)\n"
            "assert run.returncode == 0, run.stderr\n",
        )
        config = _config("autoresearch")
        config.run_dir = str(tmp_path / "run")
        engine = native_engines.AutoResearchEngine(config)
        result = engine.run(task, single)
        assert result.best_candidate == "longer text" + "x" * result.metadata["rounds"]
        assert '/evaluate"' in (engine.work_dir / "eval.sh").read_text()
        assert "evaluate_examples" not in (engine.work_dir / "eval.sh").read_text()
        assert "probe" not in (engine.work_dir / "BRIEF.md").read_text()
        assert "evaluate" not in vars(single)
    finally:
        single.stop()


@pytest.mark.parametrize(("direct", "expected"), [(True, "sk-ant-skynet-edge-injected"), (False, None)])
def test_only_a_direct_claude_code_run_keeps_its_anthropic_key(
    fake_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, direct: bool, expected: str | None
) -> None:
    """Keep the edge placeholder for a direct run, and drop any raw key otherwise."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-skynet-edge-injected")
    if direct:
        monkeypatch.setenv("SKYNET_CLAUDE_DIRECT", "1")
    else:
        monkeypatch.delenv("SKYNET_CLAUDE_DIRECT", raising=False)
    _install_fake(
        fake_home,
        "(pathlib.Path.home() / 'key.json').write_text(json.dumps(os.environ.get('ANTHROPIC_API_KEY')))\n",
    )
    native_engines.run_proposer(
        "go", work_dir=tmp_path, log_dir=tmp_path / "logs", name="iter0", model="claude-test", session_id="s1"
    )
    assert json.loads((fake_home / "key.json").read_text()) == expected
