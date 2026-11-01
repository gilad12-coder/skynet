---
name: manage-runs
description: List, inspect and stop Skynet optimization runs. Use when the user asks about their Skynet runs, the status, spend or result of a run, or asks to stop or cancel a run.
---

# Manage Skynet runs

Use the Skynet MCP server of this plugin. The tools only see the runs of
the signed-in account.

| Tool | What it does |
| --- | --- |
| `list_runs` | Lists runs, newest first. Arguments: `limit`, `offset`, `status`. |
| `get_run` | Returns one run's status, its budget and spend, and its result when it is finished. |
| `stop_run` | Stops a run. Spend stops, and the unused budget goes back to the balance. |

## List runs

- Call `list_runs`. To filter, set `status` to one of `pending`,
  `validating`, `running`, `success`, `failed`, `cancelled`, `paused` or
  `stopped`.
- `total` is the number of matching runs. Page with `offset` when the user
  asks for more.
- Show each run's `name`, `status`, `created_at` and `optimization_id`.

## Inspect a run

- Call `get_run` with the `optimization_id`. If the user names a run
  without its id, find it with `list_runs` first.
- Report `run.status` and the spend in `execution_budget`.
- When `terminal` is true and `result` is present, show `baseline_score`,
  `best_score` and `best_candidate`. For a `failed`, `stopped` or
  `cancelled` run, show
  `run.message` and `run.stop_reason`.
- `run.message` can be in Hebrew. Give it to the user in the user's
  language.
- The run page is `https://skynetml.com/optimizations/<optimization_id>`.

## Stop a run

`stop_run` works only on `pending`, `validating` or `running` runs. For a
`paused` run, send the user to the run page to resume or delete it.

For those three statuses, the run gets the status `cancelled`. The MCP
tools cannot resume a stopped run. Some GEPA runs show Resume on the run
page.

1. Find the run and show its name, status and spend.
2. Ask the user to confirm that run. If more than one run matches, ask
   which one. Never stop runs the user did not name.
3. Call `stop_run` with the `optimization_id`.
4. Call `get_run` and report the final status and spend.

## Limits

These tools cannot add funds, change balances, delete runs or change
account settings. Send the user to https://skynetml.com for those tasks.
