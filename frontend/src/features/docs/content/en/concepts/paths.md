Skynet has two optimization paths: **DSPy** and **Optimize Anything**. Both paths use the same run contract and the same metric contract. The difference is what the optimizer can change and how it changes it.

## The shared contract

Every run has two files. `run.py` runs the artifact on one case. `metric.py` scores the output.

```python tab="run.py"
from skynet import llm


def run(artifact, input):
    return llm(artifact, input=input)
```

```python tab="metric.py"
def score(input, output, expected=None):
    ok = output == expected
    return (1.0 if ok else 0.0), {"feedback": "Match." if ok else "No match."}
```

- `artifact` is the current version that the optimizer proposes.
- `input` is a dict that holds the input fields of one case.
- `expected` is the expected value of the case, or `None` when the case has none.
- `score` returns a pair: a number, and a dict with a `"feedback"` string.

The `skynet` helper module gives `llm`, `Image` and `log`. A call to `llm` from the run code goes to the task model. A call to `llm` from the metric goes to the metric model.

> [!NOTE]
> The run code runs in its own process in the sandbox. It cannot see the metric source, the expected value or the metric key.

Read [Metrics and scorers](/docs/concepts/scorers) for the full metric contract.

## Artifact types and paths

| Artifact type | Path | Optimizers |
| --- | --- | --- |
| DSPy program | DSPy | Auto, DSPy GEPA, DSPy MIPROv2, DSPy BootstrapFewShot |
| Prompt | Optimize Anything | Auto, GEPA, Best-of-N, AutoResearch, Meta-Harness, AutoSaddler, ShinkaEvolve |
| Code | Optimize Anything | Same as Prompt |
| Text | Optimize Anything | Same as Prompt |

DSPy MIPROv2 and DSPy BootstrapFewShot need pairs (cases with expected outputs). With a single input, a DSPy program can use only Auto and DSPy GEPA.

## The DSPy path

Use the DSPy path when your artifact is a DSPy program.

Your `run.py` builds a `dspy.Module` at module level and calls it inside `run`. If the file has more than one module, name the one to optimize `program`.

What happens in a DSPy run:

1. Skynet finds your module and wraps your `run` function around it. Every case goes through your own `run`.
2. The DSPy optimizer compiles the program on the train cases.
3. It selects on the validation cases.
4. The winner is the instruction text of each predictor, plus the full compiled state of the module. The state includes the few-shot demos.

The final scores measure the same program that Skynet saves.

| Optimizer | Reads feedback text |
| --- | --- |
| DSPy GEPA | Yes |
| DSPy MIPROv2 | No, score only |
| DSPy BootstrapFewShot | No, score only |

DSPy BootstrapFewShot does not use a reflection model.

> [!TIP]
> The DSPy reflection model sees only the feedback text that your metric returns. It never sees the metric source.

## The Optimize Anything path

Use Optimize Anything for prompts, code and any other text. The optimizer treats the artifact as a black box. It proposes a new version, runs `run(artifact, input)` on the cases, and reads the score and feedback.

The six engines use different search methods:

- **GEPA** evolves versions by reflection and keeps a Pareto front.
- **Best-of-N** asks the reflection model for independent proposals and keeps the best one.
- **AutoResearch**, **Meta-Harness**, **AutoSaddler** and **ShinkaEvolve** use a coding agent to propose versions.

Read [Engines](/docs/concepts/engines) for each engine and its settings.

## Auto

**Auto** is the default choice in the wizard.

- On a DSPy program, Auto runs DSPy GEPA.
- On a Prompt, Code or Text artifact, Auto runs the black-box Auto strategy. It explores with five engines, then continues with GEPA from the best version.

Both forms of Auto read the feedback text from your metric.

## When to use each path

| Your situation | Use |
| --- | --- |
| You have a DSPy program | DSPy path. Start with Auto. |
| You want few-shot demos picked from your data | DSPy path with DSPy BootstrapFewShot or DSPy MIPROv2 |
| You have a prompt that a model runs | Optimize Anything. Start with Auto. |
| You have code to make faster, cheaper or more correct | Optimize Anything with a Code artifact |
| You have a document or a configuration | Optimize Anything with a Text artifact |

> [!WARNING]
> GEPA, DSPy GEPA and Auto learn from the feedback text. If your feedback is always the same string, these optimizers have less information to work with.

## Related pages

- [Engines](/docs/concepts/engines)
- [Datasets and splits](/docs/concepts/datasets)
- [Metrics and scorers](/docs/concepts/scorers)
- [Submit a run](/docs/guides/submit)
