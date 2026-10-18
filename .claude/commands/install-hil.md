---
description: Install with the human in the loop — ask before each choice
---

# /install-hil

You finish the install of this Skynet checkout together with the user. Do
the same work as `/install` (read `.claude/commands/install.md`), but ask the
user before each choice below. Ask one question at a time. Use the answer.
Do not guess.

Other harnesses (Codex, Factory, Pi): run `just setup` first, then follow
these steps.

## Questions

1. **Install size.** "Full install (backend, frontend, Postgres, LiteLLM) or
   minimal (backend and tests only)?" For minimal, skip the frontend checks
   and the LiteLLM step.
2. **Database.** "Use an existing database, or create a fresh local one?"
   For a fresh one, run `createdb <name>` and offer to set `REMOTE_DB_URL`.
   For an existing one, ask the user to put the URL in `backend/.env`
   themselves. Never ask them to paste a password into the chat.
3. **Env vars.** Read `.claude/logs/init-latest.log`. For each key that is
   `missing` or `placeholder`, say which file and key need a value. Ask the
   user to edit the file. Then run `just setup` again and check the key is
   `set`.
4. **Optional services.** "Do you want any of these: LiteLLM gateway
   (model calls), Redis (rate limits), Stripe (billing), Google/GitHub OAuth?"
   For each yes, point to the env keys in `backend/.env.example` or
   `frontend/.env.example`. Leave each no turned off.
5. **Checks.** "Run the unit tests and a backend boot check now?" On yes, do
   steps 5 and 6 of `/install`.

## Finish

Write the report as `/install` step 7 says, and add each answer the user
gave. Give the user a short report.

## Rules

The rules of `/install` apply. Never print, log or quote a secret value.

## Common issues

Use the list in `.claude/commands/install.md`. Add new pairs there, not
here, so both commands share one list.
