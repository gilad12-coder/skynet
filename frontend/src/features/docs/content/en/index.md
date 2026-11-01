Skynet improves an artifact that you already have. You give it a starting version, a set of cases and a metric. Skynet proposes new versions, runs each one on your cases, scores the output with your metric, and keeps the best version.

## What Skynet optimizes

Skynet works on four kinds of artifact:

| Artifact type | What changes |
| --- | --- |
| Prompt | The prompt text |
| Code | The source code |
| DSPy program | The instructions of the predictors in a `dspy.Module` |
| Text | Any other text, for example a document or a configuration |

Every run uses the same contract. Your run code defines `run(artifact, input)`. Your metric defines `score(input, output, expected=None)`. The metric returns a score and written feedback. The optimizer reads the feedback to make the next version better.

> [!NOTE]
> Your run code and your metric run in a sandbox, in separate processes. The run code cannot see the metric source or the expected values.

## Two paths

Skynet has two optimization paths:

- **DSPy** optimizes a DSPy program with the DSPy optimizers: DSPy GEPA, DSPy MIPROv2 and DSPy BootstrapFewShot.
- **Optimize Anything** treats the artifact as a black box. It uses the engines GEPA, Best-of-N, Meta-Harness, AutoResearch, AutoSaddler and ShinkaEvolve.

**Auto** picks for you. On a DSPy program, Auto uses DSPy GEPA. On other artifact types, Auto combines five black-box engines. Read [DSPy and Optimize Anything](/docs/concepts/paths) and [Engines](/docs/concepts/engines).

## How a run works

1. You describe the task and set the starting version.
2. You give the cases. Skynet splits them into train, validation and test sets.
3. You select an optimizer, the models and a budget.
4. You write the run code and the metric. A contract check runs them on sample cases.
5. Skynet runs the optimization and shows the results.

Skynet selects versions on the validation cases. It reports the final score on the test cases. The engines never see the test cases.

## Where to start

| If you want to | Read |
| --- | --- |
| Start your first run | [Quickstart](/docs/quickstart) |
| Choose a path | [DSPy and Optimize Anything](/docs/concepts/paths) |
| Choose an engine | [Engines](/docs/concepts/engines) |
| Prepare your data | [Datasets and splits](/docs/concepts/datasets) |
| Write a metric | [Metrics and scorers](/docs/concepts/scorers) |
| Fill in the wizard | [Submit a run](/docs/guides/submit) |
| Read your results | [Results](/docs/guides/results) |
| Understand cost | [Billing](/docs/concepts/billing) |
| Use Skynet from an agent | [MCP](/docs/mcp) |
| Call Skynet from code | [API](/docs/api) |
| Check the limits | [Limits](/docs/limits) |

> [!TIP]
> Start with a small dataset and the default settings. Make the metric feedback specific. Good feedback gives the optimizer more to work with than the score alone.
