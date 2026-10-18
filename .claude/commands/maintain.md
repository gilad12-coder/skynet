---
description: Explain the maintenance report and propose fixes as a PR
---

# /maintain

You keep this Skynet codebase healthy. A script collected the facts. You
explain them, pick the fixes that matter and propose them as a PR.

Other harnesses (Codex, Factory, Pi): run `just maintain` first, then follow
these steps.

## Steps

1. Read `AGENTS.md` (merge policy, validation commands) and
   `CLAUDE.md` if it exists.
2. Read `.claude/logs/maintain-latest.log`. If it does not exist, run
   `just maintain` and read it again.
3. Explain each `WARN` and `FAIL` line in plain words: what it is, the risk,
   and the fix. Put security items first (pip-audit, npm audit, Dependabot),
   then Alembic, then outdated packages, then worktrees and files.
4. Propose a small set of fixes. Prefer patch and minor updates that close
   an advisory. Leave major upgrades as a list for the user.
5. Ask the user which fixes to make. For each one they pick:
   - Work on a new branch from `origin/staging` (`chore/maintain-<date>`).
   - Change the dependency in the source of truth: `backend/pyproject.toml`
     plus `uv lock`, and keep `backend/requirements*.txt` aligned (see
     `AGENTS.md`). For the frontend, use `npm install <pkg>@<version>` so
     `package-lock.json` changes.
   - Run the validation commands from `AGENTS.md`.
6. Commit, push and open a PR against `staging`. Never push to `main`.
   Follow the merge policy in `AGENTS.md`.
7. Write a report to `.claude/logs/maintain-report-<YYYYMMDD-HHMMSS>.md`.
   Quote the summary lines of the log, the fixes and the PR link.

## Rules

- Never print, log or quote a secret value.
- Never delete a worktree or prune Docker data without the user's yes. A
  worktree can hold work that is not pushed. Check `git -C <path> status`
  first.
- Do not touch another checkout of this repo, and do not stop its servers.

## Common issues

Add a new Problem / Solution pair each time you solve a new failure.

- **Problem:** `pip-audit` lists the same advisory twice.
  **Solution:** The package appears in more than one extra. Fix it once in
  `pyproject.toml`.
- **Problem:** Dependabot lists the same package for `uv.lock` and
  `requirements.txt`.
  **Solution:** It is one fix. Update `uv.lock`, then regenerate the
  requirements files so both alerts close.
- **Problem:** `npm audit` shows many `low` items from
  `@codingame/monaco-vscode-*`.
  **Solution:** They come from one upstream package family. Update the
  family together to one version, or leave them if the fix is a major
  upgrade.
- **Problem:** `merged worktrees` lists a worktree.
  **Solution:** Its branch is in `staging`. Ask the user, check
  `git -C <path> status` is clean, then run `git worktree remove <path>`.
- **Problem:** `uv outdated` lists many packages.
  **Solution:** This is a report, not a fault. Update only what closes an
  advisory or what the user asks for.
- **Problem:** `dependabot` says "could not read alerts".
  **Solution:** Run `gh auth status`. The token needs access to security
  alerts on the repo.
