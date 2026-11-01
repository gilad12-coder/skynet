A run is one optimization. It has a status, a spending limit and a set of saved versions. This page explains the run states, the actions you can take on a run, and the reasons a run stops.

## Run states

Every run has one of these statuses:

| Status       | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `pending`    | The run is in the queue.                                           |
| `validating` | Skynet checks the setup before the optimization starts.            |
| `running`    | The optimizer proposes and scores new versions.                    |
| `success`    | The run finished. The best version is saved.                       |
| `failed`     | An error stopped the run.                                          |
| `cancelled`  | A person cancelled the run.                                        |
| `paused`     | The run stopped at a checkpoint. You can resume it.                |
| `stopped`    | The run stopped at its budget. It keeps the best version it found. |

`success`, `failed`, `cancelled`, `stopped` and `paused` are terminal states. The optimizer does not work on a run in a terminal state. `paused` is the only terminal state that exists to be resumed.

## Actions

The run page shows the actions that apply to the current status and your role. The API has the same actions.

| Action     | When you can use it                                                                                    | What it does                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Pause**  | The run is running and has a saved checkpoint.                                                         | Stops the run at the checkpoint. The status changes to `paused`.       |
| **Cancel** | The run is `pending`, `validating` or `running`.                                                       | Stops the run. You cannot undo a cancel.                               |
| **Resume** | The run is `failed`, `cancelled`, `paused`, or `stopped` at its budget, and it has a saved checkpoint. | Continues the same run from its last checkpoint. The run keeps its id. |
| **Clone**  | Any time you can see the run.                                                                          | Opens the submit wizard with a copy of the configuration.              |
| **Delete** | The run is in a terminal state. Owner only.                                                            | Permanently deletes the run and all its data.                          |

The API also has two more actions for a run that is `failed` or `cancelled`:

- **Retry** starts a new run with the same configuration. The new run gets a new id.
- **Restart** starts the same run again from the beginning. The run keeps its id.

> [!NOTE]
> Retry, restart and API clone refuse a run that has its own spending limit. Open the configuration in the submit wizard and set a new budget before you start a new run. The **Clone** button on the run page does this for you.

The API clone can make 1 to 5 copies in one request. Each copy counts against your run limits. See [Limits](/docs/limits).

### Who can take an action

Your role on the run controls the actions you see:

- An **owner** can take all actions, manage sharing and delete the run.
- An **editor** can pause, cancel, resume and retry the run, and raise its spending limit.
- A **viewer** can open the run and clone it.

Read [Share and publish](/docs/guides/sharing) for more about roles.

## How a run stops

A run stops for one of four reasons.

### Completion

The optimizer finishes its work. The status changes to `success`. Skynet saves the best version and runs the final test. Read [Read the results](/docs/guides/results).

### Budget

A run has no cost estimate before it starts. Its spending limit is the budget it may use. Skynet measures the real cost of each scorer run as the run goes:

1. Skynet waits for 10 settled scorer runs. Before that, the cost of one call is too noisy to use.
2. Skynet uses the average cost so far to price the next iteration. It multiplies the price by 1.5, because later iterations usually cost more.
3. When the budget that is left cannot pay for the next iteration, Skynet stops admitting new work. The optimizer stops on its next paid call.

The run then has the status `stopped` and the stop reason `budget_reached`. The run page shows a **Budget reached** notice. The notice tells you which version Skynet saved:

- Your best evaluated version.
- Your evaluated starting version, if no better version was found.
- No version, if the budget ran out before any candidate finished evaluation. Your inputs and logs stay saved.

To continue, use **Raise limit and continue** on the notice. Skynet resumes the run from the last checkpoint.

> [!TIP]
> A run with **No limit** draws on your account balance until it finishes. If the balance runs out, the run stops and keeps what it has. The notice then says **Account balance used up**. Add funds, then resume the run.

Some older runs paused with the stop reason `budget_projected`. You can resume them in the same way.

### Failure

An error stops the run. The status changes to `failed`. The **Logs** tab shows what happened. If the run has a saved checkpoint, you can resume it. You can also retry it.

If a worker stops while it runs your job, Skynet recovers the job and tries again. After 3 attempts, Skynet marks the job as failed. A resume after a failure or a cancel also counts as an attempt. A resume after a pause or a budget stop does not count.

### Cancel

You cancel the run. The status changes to `cancelled`. You cannot undo a cancel. Later, you can resume the run from a saved checkpoint, or retry it.

## Related pages

- [Budgets and billing](/docs/concepts/billing)
- [Start a run with the wizard](/docs/guides/submit)
- [Limits](/docs/limits)
