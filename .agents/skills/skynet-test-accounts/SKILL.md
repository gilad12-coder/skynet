---
name: skynet-test-accounts
description: Use this skill before any signed-in check on Skynet shared staging or a PR preview (pr-<n>.staging.skynetml.com), for acceptance checks, Before/After evidence or API calls with a user token. It says which target to use, how to confirm the served commit with /api/version and /health, how Devin signs in with SKYNET_DEVIN_<n> or SKYNET_PR_<n> secrets, how agents on Gilad's Mac use the test-account pool, the DNS-over-HTTPS fallback, and the rules for secrets and test data.
---

# Skynet test accounts and targets

Read this before you run any acceptance check on Skynet staging or on a PR
preview. The PR rules that use these checks are in the `skynet-pr-workflow`
skill.

## 1. Pick the right target

| Your check needs | Use |
| --- | --- |
| The PR's own code (new behavior) | The PR preview: `https://pr-<n>.staging.skynetml.com`, API `https://api-pr-<n>.staging.skynetml.com` |
| The current product (baseline checks, unrelated flows) | Shared staging: `https://staging.skynetml.com`, API `https://api-staging.skynetml.com` |

- Before and After videos: record both on the PR preview, the Before first.
  Use staging for the Before only when the preview cannot show the baseline.
  See section 5 of the `skynet-pr-workflow` skill.
- Shared staging runs merged code only. It does not hold your PR's change.
- A preview has its own empty database. Staging accounts do not exist there.
  It needs its own account.
- Never test against production. Railway is deleted; never use it.

## 2. Confirm the served commit

Before you record evidence, check that each affected service serves the
commit you test. Both endpoints return JSON with a `commit` field:

```bash
DOH=(--doh-url https://cloudflare-dns.com/dns-query)
curl -s "${DOH[@]}" "$APP/api/version"   # frontend: {"commit": "<sha>"}
curl -s "${DOH[@]}" "$API/health"        # backend:  {"commit": "<sha>", "status": ...}
```

- Compare `commit` with the full SHA of the PR head (preview) or of
  `origin/staging` (staging).
- If the preview serves an older SHA, the deploy is not done. Wait for the
  `preview` workflow, or report it. Never record evidence on a stale
  deployment.
- An unchanged service may run an older SHA only with proof that it misses
  no relevant change.

## 3. DNS-over-HTTPS fallback

The DNS lookup for `skynetml.com` can time out on some networks. Add
`--doh-url https://cloudflare-dns.com/dns-query` to every `curl` call (the
sign-in script does this). For a browser, turn on secure DNS, or report the
failure.

## 4. Sign in: Devin and other cloud agents

- Slots: `devin-1` to `devin-4`. Secrets: `SKYNET_DEVIN_<n>_EMAIL` and
  `SKYNET_DEVIN_<n>_PASSWORD`. Use one slot per parallel session.
- Sign in through the normal login page or the script below. No email code
  is needed for these accounts.
- **Never sign up on shared staging** for a normal check (see the
  exceptions below).
- Preview databases are empty. Ask Gilad for a preview account. He stores it
  as `SKYNET_PR_<n>_EMAIL` / `SKYNET_PR_<n>_PASSWORD`. **Never sign up on a
  preview yourself** to get a working account.

### Sign-up exceptions

The sign-up ban covers normal checks. It has two exceptions:

1. **Acceptance checks of an authentication change** (sign-up, email
   verification, login). These need fresh accounts and real email codes, so
   a sign-up is part of the test. Do it only when the issue covers an auth
   change. Put the issue label in the account name, and record each account
   you create in the PR.
2. **Sign-ups by the orchestrator's tools**: the pool `preview` command
   (section 5) and the preview merger, which signs up and runs a real
   optimization in each preview (`docs/agents/pr-previews.md`).

Devin does not have these tools. For an ordinary preview check, Devin still
asks Gilad for a preview account.

Use `devin-login.sh` in this folder. It reads the credentials from
environment variables, sets `TOKEN`, and prints only the HTTP status:

```bash
# Staging, slot devin-1:
N=1 APP=https://staging.skynetml.com API=https://api-staging.skynetml.com \
  . .agents/skills/skynet-test-accounts/devin-login.sh
# PR preview 812, with the preview account:
PREFIX=SKYNET_PR_812 APP=https://pr-812.staging.skynetml.com API=https://api-pr-812.staging.skynetml.com \
  . .agents/skills/skynet-test-accounts/devin-login.sh
```

Expect `login check: HTTP 200`. Then call the API with
`-H "authorization: Bearer $TOKEN"`. **Never print `$TOKEN`.** If the check
is not 200, run the script once more. If it still fails, stop and report the
exact status.

## 5. Sign in: agents on Gilad's Mac only

These paths exist only on Gilad's Mac. Other agents skip this section.

- The orchestrator claims an account for you and gives you: the target
  (`staging` or `preview <n>`), the slot (`pool-1` to `pool-4` for staging,
  or `pr-<n>` for a preview), a secret access-file path and a context-file
  path. Read the context file first.
- If you did not get these and your task needs a signed-in check, stop and
  report "no test account was handed over". Do not claim a slot yourself
  unless the orchestrator tells you to.
- The full guideline is
  `~/Library/Application Support/Skynet Test Access/GUIDELINE.md`. The tools
  are in the `tools/` folder next to it. Use Node 22.

```sh
T="$HOME/Library/Application Support/Skynet Test Access/tools"
P="$T/pool.mjs"
# Confirm the served commit.
node "$T/test-target-preflight.mjs" --target staging --commit <FULL_STAGING_SHA> --wait-seconds 60
node "$T/test-target-preflight.mjs" --target preview --pr https://github.com/gilad12-coder/skynet/pull/<n> \
  --commit <PR_HEAD_SHA> --services backend,worker,frontend --wait-seconds 60   # leave out litellm: previews share it
# Check the login (expects "ok": true, HTTP 200).
node "$P" check <slot>
# If the session expired, then run check again.
node "$P" refresh pool-<k>      # staging slot
node "$P" preview <n> <label>   # preview account: signs in again, or signs up if the preview was recreated
```

- `STALE_DEPLOYMENT` means the target does not run your head yet. Wait, or
  report it.
- `PR preview <n> is not running.` means the preview is down or deleted.
  Report it. Do not create previews yourself.
- The tools work around the DNS timeout themselves.
- When you finish, also after a failed check, tell the orchestrator. It
  releases the slot (`release <slot> <claimId>`). A forgotten claim blocks
  other agents for up to 6 hours.

## 6. Secrets

- Read credentials only inside your own script (environment variables or the
  access file). Never print, `cat` or echo them.
- Never put passwords, tokens, cookies or email codes in prompts, logs,
  screenshots, videos, commits, PR text or Linear.
- In evidence, name the account by slot (`devin-2`, `pool-2`, `pr-827`) and
  by email domain only.
- In a browser, sign in through the normal login page. Keep the password out
  of recordings.
- A test-account login is access setup, not proof of email verification.
  Test authentication changes with fresh accounts and real codes (sign-up
  exception 1 in section 4).

## 7. Test data

- Slots keep their data between agents. Put your label (the issue or PR, for
  example `SKY-123`) in every name you create: projects, runs, files, keys.
- Do not depend on an empty account. Change or delete only data that your
  label made. Delete your fixtures when the PR's evidence does not need them.
- Create data through normal app flows when you can. Use realistic synthetic
  values, never real personal data.
- Never add funds, grant credits, change billing or change balances. Use only
  test allowances that already exist.
- Do not start expensive or scheduled runs only to see their UI. Follow the
  costly-workflow rule in the `skynet-pr-workflow` skill.
- Never borrow another agent's slot, Gilad's session or a personal account.
  Never create extra one-off accounts, except for the sign-up exceptions in
  section 4.

## 8. What to write in the PR

In the test-scope section, add:

- The target (staging or the `pr-<n>` preview), its URL, and the commit you
  confirmed.
- The slot you used. Never the email address or any secret.
- Each check you ran and its result.
- Gaps, for example "checked on staging, not on the preview" or "simulated
  state for the expensive run".
