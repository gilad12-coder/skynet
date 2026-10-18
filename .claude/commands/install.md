---
description: Check the deterministic install, fix known issues and report
---

# /install

You finish the install of this Skynet checkout. A script did the work. You
check the result, fix known problems and report.

Other harnesses (Codex, Factory, Pi): run `just setup` first, then follow
these steps.

## Steps

1. Read `AGENTS.md`, `README.md` and `CLAUDE.md` (if it exists) to learn the
   codebase rules.
2. Read `.claude/logs/init-latest.log`. If it does not exist, run
   `just setup` and read it again.
3. For each `WARN` or `FAIL` line in the summary, find the cause. Use the
   "Common issues" list below first.
4. Fix what you can without a human. Then run `just setup` again. It is safe
   to run again.
5. Run `just test-unit`. Run `cd frontend && npm run typecheck`.
6. Start the backend and stop it again, to prove it boots:
   `cd backend && API_PORT=<free port> uv run python main.py`. Use a port
   that no other process uses. Wait up to 2 minutes for
   `curl http://127.0.0.1:<port>/health` to return 200 (the first boot takes
   about 60 seconds). Stop only the process you started.
7. Write a report to `.claude/logs/install-report-<YYYYMMDD-HHMMSS>.md`.
   Quote the summary lines of the init log. List each fix you made, the test
   result and each step a human must do.
8. Give the user a short report: what works, what you fixed, what they must
   do next.

## Rules

- Never print, log or quote a secret value. Say "set", "missing" or
  "placeholder".
- Never overwrite an existing `.env` or `.env.local`. Edit one key only when
  the user tells you the value.
- Ports 8000 and 3000 can belong to another checkout. Check the process
  folder before you stop anything.
- Do not push and do not open a PR. This command only installs.

## Common issues

Add a new Problem / Solution pair each time you solve a new failure.

- **Problem:** `backend:REMOTE_DB_URL placeholder` and `migrations` is
  `SKIP`.
  **Solution:** A new `backend/.env` has the example URL. Ask the user for
  the real URL, or for local work create a database
  (`createdb skynet`) and set
  `REMOTE_DB_URL=postgresql://<os-user>@localhost:5432/skynet`. Run
  `just setup` again.
- **Problem:** `postgres :5432 not reachable`.
  **Solution:** Start Postgres (`brew services start postgresql@16`, or
  `cd backend && docker compose up -d db`). Run `just setup` again.
- **Problem:** `litellm :4000 not reachable`.
  **Solution:** The app starts without it, but model calls fail. Run
  `cd deploy/litellm && docker compose up -d`. The proxy needs provider keys
  in its own env; ask the user for them.
- **Problem:** `npm ci` takes about 95 seconds in a fresh worktree.
  **Solution:** This is normal. The next `just setup` skips it while
  `node_modules` matches `package-lock.json`.
- **Problem:** `npm ci` FAIL: `frontend/node_modules is a symlink`.
  **Solution:** Turbopack needs a real folder. Remove the link
  (`rm frontend/node_modules`) and run `just setup` again.
- **Problem:** `just test-unit` takes about 20 minutes (5,000+ tests).
  **Solution:** This is normal. Run it in the background and wait for it.
  Do not stop it early.
- **Problem:** `just test-unit` fails in
  `core/service_gateway/tests/test_workflow_edit_session.py` (7 failures),
  but the file passes alone.
  **Solution:** Two test runs at the same time, or low free memory, make
  these slow tests time out. Run one suite at a time. Check free memory
  with `vm_stat` first, then run the suite again.
- **Problem:** Two frontends on one machine log each other out.
  **Solution:** Set a distinct `AUTH_COOKIE_PREFIX` in each
  `frontend/.env.local`.
