An engine is the search method that proposes new versions of your artifact. Skynet has six black-box engines for the Optimize Anything path, three DSPy optimizers for the DSPy path, and **Auto**. This page says what each one does, when to pick it, and which settings it has.

Read [DSPy and Optimize Anything](/docs/concepts/paths) first if you do not know which path your artifact uses.

## Quick comparison

| Engine | Path | Coding agent settings | Max iterations setting |
| --- | --- | --- | --- |
| Auto | Both | Yes, on Optimize Anything | No |
| GEPA | Optimize Anything | No | No |
| Best-of-N | Optimize Anything | No | No |
| AutoResearch | Optimize Anything | Yes | No |
| Meta-Harness | Optimize Anything | Yes | Yes |
| AutoSaddler | Optimize Anything | Yes | Yes |
| ShinkaEvolve | Optimize Anything | No. It has its own editor setting. | Yes |
| DSPy GEPA | DSPy | No | No |
| DSPy MIPROv2 | DSPy | No | No |
| DSPy BootstrapFewShot | DSPy | No | No |

The wizard marks GEPA, DSPy GEPA and Auto as optimizers that use the feedback text from your metric.

## Auto

Auto is the default. What it runs depends on the artifact type:

- **DSPy program**: Auto runs DSPy GEPA.
- **Prompt, Code or Text**: Auto explores with five engines at the same time: GEPA, AutoResearch, Meta-Harness, AutoSaddler and ShinkaEvolve. Each engine gets an equal share of the scorer runs: the budget divided by 6. Then GEPA continues from the best version with the rest of the budget.

Auto does not use Best-of-N.

> [!WARNING]
> Black-box Auto needs at least 6 scorer runs: 5 exploration lanes and one continuation. All five engines must be available. If one is not available, select a single engine.

**Pick it when** you do not know which engine fits. This is the best place to start.

## GEPA

"Reflective evolution with a Pareto front of versions." The reflection model reads the score and the feedback of each case and writes a better version. GEPA keeps a front of versions that are each best on some cases.

**Pick it when** your metric gives specific feedback, and you want a strong single engine.

## Best-of-N

"Independent proposals from the reflection model; keep the best." Each proposal is independent of the others. Skynet re-scores the top proposals on the validation cases.

**Pick it when** you want a simple baseline to compare with other engines.

## AutoResearch

A coding agent runs research rounds. It edits, scores and keeps what helps until the budget runs out.

**Pick it when** a good change needs several steps of investigation, for example on a Code artifact.

## Meta-Harness

A coding agent proposes a batch of candidates each iteration. It uses the full history of candidates and scores.

**Pick it when** you want an agent that learns from the history of all earlier attempts. Use **Candidates per iteration** to set the batch size.

## AutoSaddler

A coding agent reads the feedback from your metric and patches the version. Skynet keeps only patches that a new scorer run confirms.

**Pick it when** your metric feedback points to clear, local defects.

## ShinkaEvolve

"Evolves many versions in parallel islands and learns which models improve them most." It is an evolutionary search over a population of candidates, with mutations and crossovers that a model writes.

**Pick it when** you want broad exploration and you have a larger budget.

## DSPy optimizers

| Optimizer | What it does |
| --- | --- |
| DSPy GEPA | Reads the metric feedback and evolves the instructions of each predictor. |
| DSPy MIPROv2 | Proposes instructions and few-shot demos together, and searches their combinations with Bayesian optimization. |
| DSPy BootstrapFewShot | Collects worked examples that the program gets right and adds them as few-shot demos. It does not use a reflection model. |

DSPy MIPROv2 and DSPy BootstrapFewShot need pairs (cases with expected outputs).

## Settings

### Budget

| Setting | Default | Range |
| --- | --- | --- |
| Max scorer runs | 200 | 1 to 100000 (Auto: at least 6) |
| Stop at score | Off | 0 or more |
| Max iterations | Off | 1 to 1000. Only Meta-Harness, AutoSaddler and ShinkaEvolve. |

One scorer run is one call of your metric on one case. The final re-score of the starting version and the winner does not count against **Max scorer runs**.

### Coding agent settings

These settings apply to Auto, AutoResearch, Meta-Harness and AutoSaddler.

| Setting | Default | Range |
| --- | --- | --- |
| Coding agent | Codex | Pi, Codex, OpenCode, Prime Agent, Custom command |
| Candidates per iteration | 3 | 1 to 8. Shown for Auto and Meta-Harness. |
| Max tool calls per candidate | 100 | 1 to 1000 |

### ShinkaEvolve settings

| Setting | Default |
| --- | --- |
| How new versions are written | Single model call. The other option is "Coding agent (Pi)". |
| Islands | 2 (1 to 8) |
| Migration interval | 10 |
| Parent selection | Weighted. Other options: Power law, Beam search. |
| Diff edits / Full rewrites / Crossovers | 60% / 30% / 10%. They must add up to 100%. |
| Archive size | 40 |
| Parallel evaluations | 2 |
| Parallel proposals | 2 |

When Auto runs ShinkaEvolve, the wizard shows these settings as "ShinkaEvolve settings (when Auto runs it)".

## Related pages

- [DSPy and Optimize Anything](/docs/concepts/paths)
- [Metrics and scorers](/docs/concepts/scorers)
- [Runs](/docs/concepts/runs)
- [Billing](/docs/concepts/billing)
