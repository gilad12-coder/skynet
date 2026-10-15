---
name: reel-skynet
description: Skynet-specific extension of the reel skill. Helpers that drive a Skynet PR preview in a reel flow (wait for the deploy, confirm its commit, sign up a throwaway account, build a Manual task, open and close the IDE) and the rules for the Skynet review page. Use when verifying or filming a Skynet PR.
---

# reel-skynet

Requires the general **reel** skill (`~/.agents/skills/reel/SKILL.md`): read it
first. This adds Skynet helpers you import into a reel flow.

## Fast path

```bash
cd <this repo checkout>
PR=715 node ~/.agents/skills/reel/bin/reel.mjs run tools/reel-skynet/examples/ide-smoke.mjs --out <scratchpad>/pr715
```

Copy `examples/ide-smoke.mjs` to your scratchpad, change the import path to this
file's absolute path, and replace the part after setup with what the PR must prove.

## Helpers (`tools/reel-skynet/skynet.mjs`)

| Helper | Does |
| --- | --- |
| `previewUrl(pr)` | `https://frontend-skynet-pr-NNN.up.railway.app` |
| `waitForPreview(pr)` | Polls `railway deployment list -e skynet-pr-NNN -s backend\|worker\|frontend` (read-only) until the latest of each is SUCCESS; throws on FAILED/CRASHED. Returns `{ service: commitSha }`. |
| `deployedSha(page)` | Opens `/login` and reads the "Source code" link (`.../tree/<sha>`): the commit the frontend was built from. Compare it to the PR head before filming. |
| `signup(page, { tag: "rec715" })` | Registers `rec715-<random>@example.com`, signs in, sets English, skips the intake. Every new account starts with $10 credit. |
| `newManualTask(page, { prompt, csvPath })` | Wizard: Manual, objective, Prompt artifact, uploads the CSV (default `fixtures/tickets.csv`, 12 tickets). Ends on Inputs. |
| `toMetricAndRun(page)` | Continues to the Metric & run step ("Code and metric"). |
| `openIde(page)` / `closeIde(page)` | Opens the full-screen IDE and waits for the explorer (returns boot ms) / closes it via "Back to the wizard". The editor stays mounted but hidden after close. |
| `ideToolbar(page)` | The IDE header locator (Check, Back to the wizard). |

The page must be on the app before a helper runs: start with
`startReel({ url: previewUrl(pr) + "/login" })`. Against local dev use
`http://localhost:3000/login` (backend :8000).

## Rules

- Always run `waitForPreview` and `deployedSha` first; a clip of the wrong commit is
  worthless. Railway deploys a preview a few minutes after each push.
- Use a fresh `signup` per run. Other agents may test the same preview at the same
  time with their own accounts; never reuse or touch theirs.
- Never buy credit or open checkout. $10 covers a few runs; if a flow needs more,
  stop and report.
- Prefer role, label and placeholder selectors (as the helpers do); the wizard's
  English strings live in `i18n/locales/ui/en.json`.

## Review page

The user reviews clips at https://claude.ai/artifact/CSpCcabpgWedu5AFFQNMF9, built
from a local `review-reel.html`. Get the current version with the Artifact tool
(`action: "read"` on that URL; the result names the saved file), then use reel's
`add` / `remove` on that file and republish it to the same `url` with the printed
`files` map. Replace a PR's old clips (`remove --pr N`) before adding new ones.
