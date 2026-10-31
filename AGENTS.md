# AGENTS.md — Skynet working rules

> Full-stack optimization platform for prompts, programs, agents, workflows,
> datasets, and other user-supplied artifacts.

Every coding agent (Devin, Claude Code, Codex and others) reads this file
first. The rules in this file always apply. Situational rules are in skills
and reference files. Read the matching one when the task needs it:

| When you | Read |
| --- | --- |
| Open, update, describe, review, record videos for, or merge a PR | `.agents/skills/skynet-pr-workflow/SKILL.md` |
| Sign in to staging or a PR preview, or run acceptance checks there | `.agents/skills/skynet-test-accounts/SKILL.md` |
| Work on or debug a PR preview environment | `docs/agents/pr-previews.md` |
| Need the stack, layout, local URLs, persistence, auth or i18n facts | `docs/agents/architecture.md` |
| Install a worktree or run maintenance | `docs/agents/install-and-maintain.md` |
| Move code between files or add a router or feature slice | `docs/agents/refactoring.md` |

Claude Code: the tracked `CLAUDE.md` imports this file. Claude Code does not
list `.agents/skills/` itself, so open the skill file from the table above.

## Core working rules (MANDATORY)

- **Think first.** State your assumptions. If a request has more than one
  meaning, name the meanings; do not pick one silently. If something is
  unclear, stop and ask. If a simpler approach exists, say so.
- **Simplicity.** Write the minimum code that solves the problem. No
  features, abstractions, configuration or error handling that nobody asked
  for. If 200 lines can be 50, rewrite them.
- **Surgical changes.** Touch only what the task needs. Match the existing
  style. Do not refactor or reformat code that is not broken. Remove only the
  imports, variables and functions that your change made unused. Mention
  unrelated dead code; do not delete it.
- **Goal-driven.** Turn the task into checks you can verify ("write a test
  that reproduces the bug, then make it pass"). For multi-step work, state a
  short plan with a check for each step. Loop until the checks pass.
- **Start fast.** Do not ask questions when the intent is clear. Do not read
  unrelated files first.
- **Generated code.** When code generates other code, edit the source, never
  the output. Check that generated HTML/JS is valid.
- **Hebrew and RTL.** Find-and-replace can corrupt Hebrew text. Check the
  direction, alignment and position of RTL UI.

## Writing rule (MANDATORY)

Write every message, report, PR description, Linear comment and commit message
in ASD-STE100 Simplified Technical English. The reader works with many agents
and must understand the state quickly:

- Short sentences: 20 words or fewer for instructions, 25 for descriptions.
  One idea in each sentence.
- Simple, common words. One word for one meaning, every time.
- Active voice and simple tenses. No "has been" or "had done".
- Instructions are direct commands ("Run the tests.").
- Start each update with where the work is now, then what comes next.

These rules do not change code, identifiers or quoted text.

## Feature gate: challenge every feature (MANDATORY)

Before building any new feature, screen, setting, option or integration,
challenge it. Do not start coding until it passes. Skynet has **no customer
requests** yet, so a feature must clearly serve one of these two buckets:

- **Business**: it makes Skynet more money or improves the business model
  (activation, conversion, retention, paid usage, lower cost to serve).
  Name the number it should move.
- **Surprise and delight**: it surprises users enough that they would show
  it to someone. Name the surprise.

If the user asks for something that fits neither, push back directly, e.g.
"Why are we building this? Which number does it move, or what's the
surprise?" Then:

1. Ask what happens if we never build it. "Nothing much" means don't.
2. Ask whether it is the current bottleneck, or a distraction from it.
3. Ask whether it improves the core product or only covers for a weak spot
   (tours, nags, settings that patch bad defaults).
4. If it passes, build the smallest version that solves the problem: delete
   requirements that have no clear owner and reason before simplifying,
   and don't abstract, configure or automate before the manual version works.

Push hard once, then respect the user's decision and build it. Small fixes,
bug fixes and refactors the user asked for skip the gate. For a full pass,
run `/scope`.

## Git, authorship and public-repo safety (MANDATORY)

- **No AI attribution.** No `Co-Authored-By: <AI>` lines. Never name Claude,
  Codex, Devin, OpenAI, Anthropic or any AI assistant as an author or
  contributor in commits, tags, PR titles, PR bodies, issue comments,
  release notes or changelogs. The author is the human who runs the session.
- **Never push to `main` or `staging` directly.** Create one branch and one
  worktree per issue from current `origin/staging`. Use a conventional
  commit message. Push the branch and open a **draft** PR against `staging`.
- The PR may touch only the files in its Linear issue's `## Files` list
  (`.github/workflows/pr-files-scope.yml` checks this).
- Never bypass branch protection or hooks. Never force-push over other work.
- The repository is **public**. Never commit secrets, passwords, tokens,
  emails, account data or videos. Secret names are fine. Keep
  machine-specific rules in `CLAUDE.local.md` (gitignored).

## Merge policy (MANDATORY)

Feature PRs target `staging`, never `main`. Each PR from this repository gets
a PR environment (preview), a full copy of staging with an empty database, at
`https://pr-<n>.staging.skynetml.com` (API `https://api-pr-<n>.staging.skynetml.com`).
Run the acceptance checks and record the videos there, before the merge.
Details: `docs/agents/pr-previews.md`.

Only the orchestrator merges, in the daily merge window. Implementation and
review agents never merge, and never post `Approved for merge` or
`Changes requested:` comments. The full gate, review and Linear flow is in
the `skynet-pr-workflow` skill.

**Backend PRs** (no file under `frontend/`) merge into `staging`
only when **all** of these gates pass:

1. Agent code review is clean.
2. Tests and the Linear issue's acceptance checks pass in the PR environment.
3. The diff touches only the files in the issue's `## Files` list.
4. Up to date: the branch is rebased on the latest `staging`, then tests pass again.
5. After the merge, the staging smoke test passes. If it fails, revert that
   PR's single squash commit right away and reopen its issue with the failure.

**UI PRs** (anything touching `frontend/`, including mixed PRs) wait for the
user. Attach a proof card: one line naming the decision and the Linear issue,
a 15–30s video of a browser agent walking the acceptance criteria in the PR
environment, the review verdict, and the diff size. Merge only after the user
approves that specific PR in chat or on GitHub (or with `Approved for merge`
on the Linear issue). A frontend PR with no meaningful visible change can use
the backend path; see the skill.

**`staging` → `main`** needs the user's approval every time. Each morning,
send one card: the backend changes that landed, staging smoke status, and a
60s video tour of the core flow on staging. Promote only on "promote".

### Fix bugs locally, deploy once (MANDATORY)

Each push rebuilds the PR preview (the sandbox image too) and starts a new
automated review. A bug found after the push costs a full rebuild. Find the
bugs before you push. Follow this order for every PR:

1. Build the change. Run the tests, lint and typecheck locally.
2. Review the full diff locally. Use two reviewers with fresh context (for
   example, two subagents). Verify each finding with a failing test, then
   fix it. Repeat until a review finds nothing new.
3. Push once. Let CI, the preview build and the automated review gate run.
4. Run the acceptance checks on the PR preview.
5. Record the before-and-after videos last, on the final commit.

If the review gate or the acceptance checks find a bug, fix all findings
locally, check them again, and then push them together in one push.

## Commenting, docstring & import style (MANDATORY — apply to all backend Python, every session)

These rules are durable. They apply to every backend Python file (under `backend/`, excluding `.venv/`, `__pycache__/`, and `alembic/versions/`) and to every future change. New code follows them; existing code is brought into compliance whenever it is touched.

- **Google-style docstrings on every function and method (public and private).** Format: a one-line imperative summary, then `Args:`, `Returns:`, and (only when the failure mode is non-obvious) `Raises:`. Skip the `Args:` / `Returns:` blocks only when **both** are trivially typed and the summary already covers them (e.g. tests that take no args and assert; private one-liners). Module docstrings are required at the top of every file.
- **Imports only at the top of the file. No exceptions.** No `import` inside a function, method, conditional block, or `try/except` body anywhere except module top. Optional deps go in a module-level `try/except ImportError` that aliases the symbol to ``None``; tests that need fresh re-imports use ``importlib.import_module`` (a function call, not an ``import`` statement); circular imports are resolved structurally (slim `__init__.py`, leaf-module splits, `TYPE_CHECKING` blocks) — never with inline imports.
- **No WHAT-comments.** Don't restate what code does, label sections, or echo identifiers ("# loop over users", "# call API"). If a competent reader can understand the line by reading the line, the comment is dead weight — delete it.
- **WHY-comments only.** Comments are reserved for non-obvious intent: a hidden constraint, a workaround for a specific bug, surprising behavior, a subtle invariant, a non-trivial design decision, or a tracking ticket. If deleting the comment wouldn't confuse a future reader, the comment shouldn't exist.
- **Pydantic class docstrings are part of the OpenAPI contract.** Pydantic
  emits a `BaseModel` class docstring into `openapi.json` as
  `components.schemas.<Name>.description`. Never add or remove one,
  including when you move a class into another router. No test guards
  this, so compare the schema before and after by hand. To document a
  class for readers, put a comment above it. Details:
  `docs/agents/refactoring.md`.

## Verification (MANDATORY before every push)

```bash
# Backend: tests for the touched areas, and lint.
cd backend && .venv/bin/python -m pytest <touched areas> -q   # or: uv run --extra dev pytest <paths> -q
ruff check <touched files>                                     # full gate: just lint-backend
cd backend && uv run --extra dev pytest core/ tests/unit/ -v   # credential-free core/unit suite

# Frontend CI gates, and ESLint on touched files.
cd frontend && npm run typecheck && npm run lint && npm run test:unit
cd frontend && npm run build                                   # production build

# i18n: catalog drift.
just check-i18n
```

- New UI strings go into the source catalogs: `i18n/locales/ui/he.json` (base)
  **and** `en.json`. Then run `python3 scripts/generate_i18n.py`.
- `backend/tests/test_llm_integration.py` needs a running server and paid
  model credentials. It is not part of the credential-free PR gate.
- Billing changes must also pass `core/billing/tests/test_budgets_postgres.py`
  against a real PostgreSQL URL in `SKYNET_BUDGET_TEST_DB_URL`.
- Backend dependency or runtime changes must keep `uv.lock` and the pip
  requirements files aligned, and pass the stable and preview Docker builds.
- Lint, typecheck and build are not behavior tests. Say which is which.
- Local frontend work: do not drive a browser unless the task asks for it.
  Tell the user what to check at `localhost:3000`. PR acceptance checks and
  videos still follow the `skynet-pr-workflow` skill.

Local dev servers: backend `:8000` (`cd backend && .venv/bin/python main.py`
or `just backend`), frontend `:3000` (`cd frontend && npm run dev` or
`just frontend`), or both with `just dev`. The backend needs Postgres on
`:5432` and, for LLM features, a LiteLLM proxy on `:4000` (see
`deploy/litellm/` and `backend/.env.example`). More: `docs/agents/architecture.md`.

## Test accounts and environments (MANDATORY)

- Run acceptance checks on AWS staging (`https://staging.skynetml.com`, API
  `https://api-staging.skynetml.com`) or the PR's preview. Never test against
  production. Railway is deleted; never use it.
- Use only the test account that you were given. Never sign up on shared
  staging, and never sign up on a preview yourself. Never borrow a personal
  session. Never print or commit passwords, tokens, cookies or email codes.
- Never add funds, grant credits, change balances or change live billing
  configuration. Never deploy production.
- How to sign in and check the served commit: the `skynet-test-accounts` skill.

## Product and runtime model

- **DSPy** is the structured program/prompt optimization path.
- **Optimize Anything** is the black-box path. Its native engines come from the
  pinned upstream GEPA implementation and include GEPA, Best-of-N and
  Meta-Harness, plus Skynet's own AutoResearch and the pinned AutoSaddler and
  ShinkaEvolve packages. `Auto` composes eligible engines without
  redefining their algorithms.
- **Vercel Sandbox** is the production execution boundary for user workloads,
  including optimization setup, runs, recovery, and completed-run
  interactions. Workers are the control plane: they orchestrate jobs, reserve
  and settle budgets, broker scoped credentials, persist checkpoints, and
  dispatch sandbox work.
- **Protected execution** reserves wallet and run-budget headroom before paid
  work. Managed model usage, Skynet fees, and sandbox usage are metered. For
  BYOK model routes, the Skynet budget covers the platform fee and sandbox
  usage; the model provider charges the user's key directly.
