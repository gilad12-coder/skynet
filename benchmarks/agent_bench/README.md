# Agent harness benchmark

A small benchmark of realistic Skynet-assistant tasks, used to compare agent
harnesses running the same model over the same tools.

## How it works

* `tools.json` holds the 53 tool schemas the production generalist agent can
  reach, dumped from the real FastMCP mount. Every harness sees exactly these.
* `bench/handlers/` implements those tools over an in-memory "world"
  (`bench/fixtures.py` is the starting state). Nothing touches the real backend,
  so runs are reproducible, free of side effects and need no database.
* A task (`bench/tasks/*.py`) is a user request plus deterministic checks over
  the final world state, the tool-call log and the reply. Each task carries an
  `oracle` that solves it through the same tool API; `bench.validate` proves
  every task is solvable and that doing nothing does not pass.
  The 36 tasks are split over six categories, six tasks each:

  | Category | Module | What it covers |
  |---|---|---|
  | `setup` | `run_setup.py` | wizard edits, staging data, column roles, submitting runs and grids |
  | `insight` | `job_insight.py` | read-only questions about runs, failures, grids and regressions |
  | `lifecycle` | `job_lifecycle.py` | rename, cancel, resume, delete, and asking before destructive actions |
  | `bbserve` | `blackbox_serving.py` | black-box engines, code validation, serving a finished program |
  | `robust` | `account_robustness.py` | wallet, preferences, public search, tool faults, prompt injection |
  | `cross` | `cross_cutting.py` | memory recall and notes, multi-turn follow-ups, black-box launch, code-authoring card, model catalog |

* `bench.server` serves one task's world over MCP (`/mcp`) and a plain JSON API.
  The runner starts one server per attempt, so attempts never share state.
* Every harness gets the same system prompt (`brief.md`), the same user
  message, all tools at once and auto-approved tool calls. Built-in coding
  tools (shell, file edits, web) are disabled so only the Skynet tools count.

## Harnesses

| name | what runs |
|---|---|
| `dspy-reactv2` | the project's `RetryingReActV2` (what the agent uses today) |
| `dspy-react` | stock classic `dspy.ReAct` |
| `claude-code` | `claude -p` pointed at OpenRouter |
| `codex` | `codex exec` with an OpenRouter provider |
| `opencode` | `opencode run` with a tools-only agent |
| `pi` | `pi -p`; Pi has no MCP client, so a small extension bridges the JSON API |

The CLIs must be installed and on `PATH`. The OpenRouter key is read from
`OPENROUTER_API_KEY` or `backend/.env`.

## Commands

Run from this directory with the backend's virtualenv:

```bash
PY=../../backend/.venv/bin/python
$PY -m bench.selftest                 # the simulated world behaves
$PY -m bench.validate                 # every task is solvable and non-trivial
$PY -m bench.run --harness pi codex --trials 2 --out results/main
$PY -m bench.report results/main
```

`bench.run` is resumable: attempts already in `results.jsonl` are skipped, and
attempts that hit an infrastructure error are retried.

`$PY -m bench.language results/main` reports how often each harness answered
in the wrong language. `TASKS.md` lists every task with its prompt and checks.

## Results (2026-09-20)

`deepseek/deepseek-v4.1-flash` through OpenRouter, 36 tasks, 2 trials, 72
attempts per harness. The full report is `results/main/REPORT.md`.

| harness | pass | median time | tool calls | list cost / 1k tasks | English prompts answered in Hebrew |
|---|---|---|---|---|---|
| claude-code | 97% | 36s | 2.6 | $6.38 | 11/60 |
| dspy-react | 97% | 44s | 2.1 | $5.83 | 0/60 |
| opencode | 96% | 27s | 2.3 | $6.01 | 11/60 |
| codex | 94% | 45s | 7.6 | $6.96 | 5/60 |
| dspy-reactv2 | 92% | 26s | 2.1 | $11.07 | 12/60 |
| pi | 90% | 21s | 2.4 | $5.46 | 16/60 |

Reading the table:

- **The top four are tied.** With 72 attempts, a pass rate near 95% carries
  roughly five points of noise either way, so the model matters more than the
  loop on these tasks.
- **Language drift is the largest single failure cause.** 15 of the 24 failed
  attempts are correct answers written in Hebrew to an English prompt, pulled
  there by Hebrew data in tool results. `dspy.ReAct` never drifted. Production
  pins the reply language explicitly, which this benchmark does not.
- **`dspy-reactv2` costs about twice the others** because almost none of its
  input is served from the prompt cache (about 9k cached of 79k input tokens,
  against 30k to 120k for the rest).
- **Substantive failures differ by harness.** Both DSPy loops submitted a run
  they were asked only to dry-run. Codex mishandled a one-field preference
  update in both trials. Pi missed several answer details.
- **Codex is the slowest and most token-hungry** at about 10 model calls per
  task against 3 to 4 elsewhere.

One grader fix was applied after the run: the `insight-failed-count` check
rejected "3 of your 16 runs have failed". Its answer-only regex was corrected
and the three affected attempts were regraded from their stored answers.

The billed column in the report is biased by OpenRouter peak-hour pricing and
by billing-counter lag between batches; the list cost is computed from tokens.

## Limits

Tasks are single-turn (earlier turns are given as a transcript). The backend is
simulated, so latency and failure behaviour of real routes is not measured.
Approval cards, tool phasing and streaming, which the production agent adds
around its loop, are out of scope: this measures the loop and the model.
The DSPy harnesses run with `max_iters=15` where production uses 8. Pi reaches
the tools through a small extension bridge rather than MCP. Harnesses report
cached tokens differently, so compare list cost before cached-token counts.
The suite is near its ceiling for this model, so it separates harnesses on
cost, latency and failure style more than on pass rate.
