import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { WIZARD_STAGE, stageAt } from "./wizard-steps.ts";
import { detectLanguage, looksLikeCode } from "./seed-format.ts";

// Execute the real handlers without loading the wizard's network and browser
// dependencies. This guards state transitions, rather than matching source text.
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, "Expected handler was not found");
  return found;
}

function variable(root: ts.Node, name: string) {
  const declaration = find(
    root,
    (node) => ts.isVariableDeclaration(node) && node.name.getText() === name,
  ) as ts.VariableDeclaration;
  assert.ok(declaration.initializer);
  return ts.isCallExpression(declaration.initializer)
    ? declaration.initializer.arguments[0]!
    : declaration.initializer;
}

function handler(root: ts.Node, name: string) {
  const attribute = find(
    root,
    (node) => ts.isJsxAttribute(node) && node.name.getText() === name,
  ) as ts.JsxAttribute;
  assert.ok(attribute.initializer && ts.isJsxExpression(attribute.initializer));
  assert.ok(attribute.initializer.expression);
  return attribute.initializer.expression;
}

function evaluate(node: ts.Node, bindings: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(`(${node.getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  return runInNewContext(outputText, bindings);
}

const wizard = source("../hooks/use-blackbox-wizard.ts");
const start = source("../components/blackbox/BlackboxStartStep.tsx");
const splitSection = source("../components/steps/SplitSection.tsx");
const detection = find(
  wizard,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText() === "useEffect" &&
    !!node.arguments[0]?.getText().includes("detectLanguage(seedSample)"),
) as ts.CallExpression;

for (const [language, seedSample] of [
  ["JSON", '{"enabled": true}'],
  ["YAML", "services:\n  api:\n    image: skynet/api:latest"],
  ["JavaScript", "const count = 3\nconsole.log(count)"],
  ["Python", "import math\nprint(math.pi)"],
]) {
  test(`${language} highlighting never changes the recipe or evaluator`, () => {
    for (const recipe of ["anything", "code"]) {
      let guess = { code: false, language: null as string | null };
      const forbidden = () => assert.fail("Syntax inference changed execution settings");
      evaluate(detection.arguments[0]!, {
        seedSample,
        seedMode: "text",
        seedGuess: guess,
        recipe,
        detectLanguage,
        looksLikeCode,
        setSeedGuess: (update: (previous: typeof guess) => typeof guess) => {
          guess = update(guess);
        },
        setRecipe: forbidden,
        setRecipeState: forbidden,
        setMetricCode: forbidden,
      })();
      assert.equal(guess.code, true);
      assert.equal(guess.language, language);
    }
  });
}

test("adding parts uses the currently visible text rather than an older parts draft", () => {
  let seedMode = "text";
  const seedText = "Current edited text";
  let seedParts = [{ key: "old", value: "Old parts draft" }];
  evaluate(variable(start, "addPart"), {
    seedMode,
    seedText,
    seedParts,
    setSeedMode: (mode: string) => {
      seedMode = mode;
    },
    setSeedParts: (parts: typeof seedParts) => {
      seedParts = parts;
    },
  })();
  assert.equal(seedMode, "parts");
  assert.equal(seedParts.length, 2);
  assert.equal(seedParts[0]?.value, seedText);
});

test("removing either of two parts retains the surviving content as whole text", () => {
  for (const index of [0, 1]) {
    const seedParts = [
      { key: "first", value: "First edited content" },
      { key: "second", value: "Second edited content" },
    ];
    let text = "Stale whole text";
    let remaining = seedParts;
    evaluate(variable(start, "removePart"), {
      seedParts,
      setSeedManuallyEdited: () => {},
      setSeedParts: (parts: typeof seedParts) => {
        remaining = parts;
      },
    })(index);
    evaluate(variable(start, "finishRemoval"), {
      seedParts: remaining,
      editSeed: (value: string) => {
        text = value;
      },
      setSeedParts: (parts: typeof seedParts) => {
        remaining = parts;
      },
    })();
    assert.equal(text, seedParts[1 - index]?.value);
    assert.equal(remaining.length, 0);
  }
});

function splitState(mode = "manual") {
  const state = {
    split: { train: 0.8, val: 0.1, test: 0.1 },
    shuffle: false,
    seed: 123,
    mode,
  };
  const bindings = {
    splitModeRef: { current: mode },
    splitPlan: { fractions: { train: 0.6, val: 0.2, test: 0.2 }, shuffle: true, seed: 42 },
    setSplitModeState: (next: string) => {
      state.mode = next;
    },
    setSplit: (
      next: typeof state.split | ((previous: typeof state.split) => typeof state.split),
    ) => {
      state.split = typeof next === "function" ? next(state.split) : next;
    },
    setShuffle: (next: boolean) => {
      state.shuffle = next;
    },
    setSeed: (next: number) => {
      state.seed = next;
    },
  };
  return {
    state,
    bindings: {
      ...bindings,
      setSplitMode: evaluate(variable(wizard, "setSplitMode"), bindings),
      updateSplit: evaluate(variable(wizard, "updateSplit"), bindings),
    },
  };
}

const splitCard = source("../components/SplitRecommendationCard.tsx");

// The card's own toggle hands the chosen mode to the wizard: Manual selection
// keeps whatever fractions are set, Use recommendation restores the plan.
function chooseMode(bindings: ReturnType<typeof splitState>["bindings"], mode: "auto" | "manual") {
  const button = find(
    splitCard,
    (node) =>
      ts.isJsxAttribute(node) &&
      node.name.getText() === "onClick" &&
      node.getText().includes("onChange(mode)"),
  ) as ts.JsxAttribute;
  assert.ok(button.initializer && ts.isJsxExpression(button.initializer));
  evaluate(button.initializer.expression!, { onChange: bindings.setSplitMode, mode })();
}

for (const mode of ["manual", "auto"]) {
  test(`Manual selection from ${mode} keeps the current values`, () => {
    const { state, bindings } = splitState(mode);
    const before = structuredClone(state);
    chooseMode(bindings, "manual");
    assert.deepEqual(state, { ...before, mode: "manual" });
  });
}

test("Use recommendation restores the planned fractions, shuffle and seed", () => {
  const { state, bindings } = splitState();
  chooseMode(bindings, "auto");
  assert.equal(state.mode, "auto");
  assert.deepEqual(state.split, bindings.splitPlan.fractions);
  assert.equal(state.shuffle, true);
  assert.equal(state.seed, 42);
});

test("the manual fields only render under Manual selection", () => {
  const gate = find(
    splitSection,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node.left.getText() === 'splitMode === "manual"',
  ) as ts.BinaryExpression;
  for (const field of ["train", "val", "test"]) {
    assert.ok(gate.right.getText().includes(`id="split-${field}"`));
  }
});

for (const field of ["train", "val", "test"] as const) {
  test(`editing ${field} applies the value and stays manual`, () => {
    const { state, bindings } = splitState();
    const input = find(
      splitSection,
      (node) =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText() === "NumberInput" &&
        node.getText().includes(`id="split-${field}"`),
    );
    evaluate(handler(input, "onChange"), bindings)(0.25);
    assert.equal(state.mode, "manual");
    assert.equal(state.split[field], 0.25);
    assert.equal(state.shuffle, false);
    assert.equal(state.seed, 123);
  });
}

for (const path of ["../hooks/use-submit-wizard.ts"]) {
  const hook = source(path);
  test(`${path}: configuration advances without paid preflight until the budget is set`, async () => {
    const visited: number[] = [];
    const scopes: string[] = [];
    const check = async (scope: string) => {
      scopes.push(scope);
      return {};
    };
    const bindings = {
      WIZARD_STAGE,
      advancingRef: { current: false },
      mountedRef: { current: true },
      setAdvancing: () => {},
      setIssue: () => {},
      validateStep: () => true,
      goTo: (stage: number) => {
        visited.push(stage);
      },
      ensureSetupChecked: check,
      ensureEvaluatorChecked: check,
    };
    const advance = evaluate(variable(hook, "advance"), bindings);
    await advance(WIZARD_STAGE.optimization);
    assert.deepEqual(visited, [WIZARD_STAGE.optimization]);
    assert.deepEqual(scopes, []);
    await advance(WIZARD_STAGE.review);
    assert.deepEqual(scopes, ["execution"]);
    assert.equal(visited.at(-1), WIZARD_STAGE.review);
  });

  test(`${path}: missing budget belongs to Optimization and blocks Review`, async () => {
    const stageIssue = evaluate(variable(hook, "stageIssue"), {
      WIZARD_STAGE,
      stageAt,
      maxCostCredits: null,
      budgetUncapped: false,
      msg: (key: string) => key,
    });
    const issue = stageIssue(WIZARD_STAGE.optimization, true);
    assert.equal(issue.stage, "optimization");
    assert.equal(issue.fieldId, "totalBudgetInput");
    const visited: number[] = [];
    const advance = evaluate(variable(hook, "advance"), {
      WIZARD_STAGE,
      advancingRef: { current: false },
      mountedRef: { current: true },
      setAdvancing: () => {},
      setIssue: () => {},
      validateStep: (stage: number) => stage !== WIZARD_STAGE.optimization,
      goTo: (stage: number) => {
        visited.push(stage);
      },
      ensureSetupChecked: () => assert.fail("Preflight ran without a budget"),
      ensureEvaluatorChecked: () => assert.fail("Preflight ran without a budget"),
    });
    await advance(WIZARD_STAGE.review);
    assert.deepEqual(visited, [WIZARD_STAGE.optimization]);
  });

  test(`${path}: a run without a spending limit needs no budget amount`, () => {
    const stageIssue = evaluate(variable(hook, "stageIssue"), {
      WIZARD_STAGE,
      stageAt,
      maxCostCredits: null,
      budgetUncapped: true,
      targetScoreIssue: () => "target",
      msg: (key: string) => key,
    });
    assert.equal(stageIssue(WIZARD_STAGE.optimization, true).fieldId, "target-score");
  });
}

for (const path of ["../components/SubmitWizard.tsx"]) {
  const component = source(path);
  test(`${path}: budget is the last panel before summary, holds until the limit covers the estimate, and Back returns to it`, async () => {
    const steps = evaluate(variable(component, "OPTIMIZATION_STEPS"), {});
    let part = 1;
    let summaryOpened = false;
    let returned = false;
    let covered = true;
    const setOptimizationPart = (update: number | ((previous: number) => number)) => {
      part = typeof update === "function" ? update(part) : update;
    };
    const next = () =>
      evaluate(variable(component, "handleOptimizationNext"), {
        optimizationPart: part,
        OPTIMIZATION_STEPS: steps,
        setOptimizationPart,
        budgetMode: "managed",
        limitCoversEstimate: () => covered,
        w: {
          handleNext: async () => {
            summaryOpened = true;
          },
          costBracket: {},
          maxCostCredits: 120,
          budgetUncapped: false,
        },
      })();
    await next();
    assert.equal(steps[part], "budget");
    assert.equal(summaryOpened, false);
    covered = false;
    await next();
    assert.equal(steps[part], "budget");
    assert.equal(summaryOpened, false);
    covered = true;
    await next();
    assert.equal(summaryOpened, true);
    part = 0;
    evaluate(variable(component, "onBack"), {
      WIZARD_STAGE,
      OPTIMIZATION_STEPS: steps,
      setOptimizationPart,
      w: {
        step: WIZARD_STAGE.review,
        goPrev: () => {
          returned = true;
        },
      },
    })();
    assert.equal(returned, true);
    assert.equal(steps[part], "budget");
  });

  test(`${path}: budget errors open the final panel`, () => {
    const steps = evaluate(variable(component, "OPTIMIZATION_STEPS"), {});
    let part = -1;
    evaluate(variable(component, "routeSubstep"), {
      setOptimizationPart: (value: number) => {
        part = value;
      },
    })("optimization", "totalBudgetInput");
    assert.equal(steps[part], "budget");
  });
}

for (const codeAssistMode of ["manual", "auto"]) {
  test(`${codeAssistMode}: an empty starting point uses the goal without a mode switch`, () => {
    const validate = (objective: string, seedCandidate: string | null) =>
      evaluate(variable(wizard, "stageIssue"), {
        WIZARD_STAGE,
        stageAt,
        seedMode: "text",
        codeAssistMode,
        objective,
        seedCandidate,
        msg: (key: string) => key,
      })(WIZARD_STAGE.goal);
    assert.equal(validate("Improve answer accuracy", null), null);
    assert.equal(validate("", null)?.fieldId, "bb-objective");
    if (codeAssistMode === "manual") assert.equal(validate("", "Existing prompt"), null);
  });
}

test("typing into a restored no-seed draft makes the starting point active", () => {
  let seedMode = "none";
  let seedText = "";
  let edited = false;
  evaluate(variable(start, "editSeed"), {
    setSeedText: (value: string) => {
      seedText = value;
    },
    setSeedMode: (value: string) => {
      seedMode = value;
    },
    setSeedManuallyEdited: (value: boolean) => {
      edited = value;
    },
  })("My starting point");
  assert.equal(seedMode, "text");
  assert.equal(seedText, "My starting point");
  assert.equal(edited, true);
});

for (const success of [true, false]) {
  test(`Anything Evaluation waits for a successful scorer check: ${success}`, async () => {
    const visited: number[] = [];
    const scopes: string[] = [];
    const advance = evaluate(variable(wizard, "advance"), {
      WIZARD_STAGE,
      advancingRef: { current: false },
      mountedRef: { current: true },
      setAdvancing: () => {},
      setIssue: () => {},
      validateStep: () => true,
      goTo: (stage: number) => visited.push(stage),
      ensureEvaluatorChecked: async (scope: string) => {
        scopes.push(scope);
        return success ? {} : null;
      },
    });
    await advance(WIZARD_STAGE.optimization);
    assert.deepEqual(scopes, ["evaluation"]);
    assert.deepEqual(visited, success ? [WIZARD_STAGE.optimization] : []);
  });
}

test("Anything missing budget blocks Evaluation before execution", () => {
  const stageIssue = evaluate(variable(wizard, "stageIssue"), {
    WIZARD_STAGE,
    stageAt,
    maxCostCredits: null,
    budgetUncapped: false,
    msg: (key: string) => key,
  });
  assert.deepEqual(
    { ...stageIssue(WIZARD_STAGE.evaluation) },
    {
      stage: "evaluation",
      fieldId: "totalBudgetInput",
      message: "budget.invalid",
    },
  );
});

test("Anything without a spending limit skips the budget amount check", () => {
  const stageIssue = evaluate(variable(wizard, "stageIssue"), {
    WIZARD_STAGE,
    stageAt,
    maxCostCredits: null,
    budgetUncapped: true,
    targetKind: "text",
    scorerKind: "python",
    metricCode: "def score(c): return llm(c)",
    scorerUsesModel: true,
    resolvedScorerModel: null,
    msg: (key: string) => key,
  });
  assert.equal(stageIssue(WIZARD_STAGE.evaluation).fieldId, "bb-scoring-model");
});

test("Anything missing evaluator model blocks Continue even without an explicit override", () => {
  const stageIssue = evaluate(variable(wizard, "stageIssue"), {
    WIZARD_STAGE,
    stageAt,
    maxCostCredits: 120,
    budgetUncapped: false,
    targetKind: "text",
    scorerKind: "python",
    metricCode: "def score(c): return llm(c)",
    scorerUsesModel: true,
    resolvedScorerModel: null,
    msg: (key: string) => key,
  });
  const issue = stageIssue(WIZARD_STAGE.evaluation);
  assert.equal(issue.fieldId, "bb-scoring-model");
  assert.equal(issue.message, "submit.blackbox.validation.scorer_model_required");
});

test("Test scorer rejects missing models before running paid preflight", async () => {
  let validation: { valid: boolean; errors: string[] } | undefined;
  const run = evaluate(variable(wizard, "performDryRun"), {
    metricCode: "def score(c): return llm(c)",
    scorerKind: "python",
    scorerCallsModel: () => true,
    resolvedScorerModel: null,
    msg: (key: string) => key,
    setScorerValidation: (value: typeof validation) => {
      validation = value;
    },
  });
  await assert.rejects(run(), /scorer_model_required/);
  assert.equal(validation?.valid, false);
});

const modelModal = source("../components/ModelConfigModal.tsx");
const modelConstants = source("../constants.ts");
const freshModel = () => evaluate(variable(modelConstants, "emptyModelConfig"), {})();

test("model-only selection and cloning do not inject sampling overrides", () => {
  assert.equal(freshModel().temperature, undefined);
  assert.equal(freshModel().max_tokens, undefined);
  for (const stored of [
    { name: "model" },
    { name: "model", temperature: 0, max_tokens: 4096 },
    { name: "model", temperature: 0.25, max_tokens: null },
  ]) {
    const call = find(
      wizard,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText() === "setScorerModel" &&
        node.arguments[0]?.getText().includes("...scorer.model"),
    ) as ts.CallExpression;
    const restored = evaluate(call.arguments[0]!, {
      emptyModelConfig: freshModel,
      scorer: { model: stored },
    });
    assert.equal(restored.name, stored.name);
    assert.equal(restored.temperature, stored.temperature);
    assert.equal(restored.max_tokens, stored.max_tokens);
  }
});

for (const parameter of ["temperature", "max_tokens"]) {
  test(`picker preserves explicit ${parameter} and allows clearing it`, () => {
    const change = find(
      modelModal,
      (node) =>
        ts.isJsxAttribute(node) &&
        node.name.getText() === "onChange" &&
        node.getText().includes(`${parameter}:`),
    ) as ts.JsxAttribute;
    assert.ok(change.initializer && ts.isJsxExpression(change.initializer));
    let draft: Record<string, unknown> = { name: "model" };
    const onChange = evaluate(change.initializer.expression!, {
      setDraft: (update: (state: typeof draft) => typeof draft) => {
        draft = update(draft);
      },
    });
    const value = parameter === "temperature" ? "0.25" : "4096";
    onChange({ target: { value } });
    assert.equal(draft[parameter], Number(value));
    onChange({ target: { value: "" } });
    assert.equal(draft[parameter], undefined);
    assert.equal(draft.name, "model");
  });
}

test("inherited evaluator picker opens the effective model instead of stale explicit settings", () => {
  const scorerStep = source("../components/blackbox/BlackboxScorerStep.tsx");
  const editCall = find(
    scorerStep,
    (node) => ts.isCallExpression(node) && node.expression.getText() === "setEditingModel",
  ) as ts.CallExpression;
  const configuration = find(
    editCall.arguments[0]!,
    (node) => ts.isPropertyAssignment(node) && node.name.getText() === "config",
  ) as ts.PropertyAssignment;
  const resolved = { name: "effective-model", temperature: 0, max_tokens: 2048 };
  const actual = evaluate(configuration.initializer, {
    resolvedScorerModel: resolved,
    scorerModelMode: "inherit",
    scorerModel: { name: "stale-model", temperature: 1 },
    reflectionModel: { name: "raw-model", temperature: 0.7 },
    emptyModelConfig: freshModel,
  });
  assert.equal(actual, resolved);
});

const blackboxView = source("../components/blackbox/BlackboxWizard.tsx");

test("Evaluation proceeds from the scorer to split or Optimization without an execution step", () => {
  for (const hasCases of [false, true]) {
    const steps = evaluate(variable(blackboxView, "evaluationSteps"), { hasCases })();
    assert.deepEqual(
      Array.from(steps),
      hasCases ? ["budget", "cases", "scorer", "split"] : ["budget", "cases", "scorer"],
    );
  }
});

test("agent model errors and review edits route back to scorer settings", () => {
  const route = find(
    blackboxView,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "evaluationStepFor",
  );
  const evaluationStepFor = evaluate(route, {});
  for (const hasCases of [false, true]) {
    assert.equal(evaluationStepFor("bb-execution-agent", hasCases), "scorer");
    assert.equal(evaluationStepFor("bb-task-model", hasCases), "scorer");
    assert.equal(evaluationStepFor("bb-scorer-code", hasCases), "scorer");
  }
});
