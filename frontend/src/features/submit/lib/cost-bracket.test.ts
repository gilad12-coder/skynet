import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { OptimizerChoice } from "@/shared/types/unified-run";

const billingUrl = new URL("../../billing/lib/pricing.ts", import.meta.url).href;
const centUrl = new URL("../../billing/lib/wallet.ts", import.meta.url).href;
const unifiedRunUrl = new URL("../../../shared/types/unified-run.ts", import.meta.url).href;
const scorerDependenciesUrl = new URL("./scorer-dependencies.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/features/billing") {
      return { shortCircuit: true, url: billingUrl };
    }
    if (specifier === "@/shared/types/unified-run") {
      return { shortCircuit: true, url: unifiedRunUrl };
    }
    if (specifier === "./scorer-dependencies") {
      return { shortCircuit: true, url: scorerDependenciesUrl };
    }
    if (specifier === "./wallet" && context.parentURL === billingUrl) {
      return { shortCircuit: true, url: centUrl };
    }
    return nextResolve(specifier, context);
  },
});

const {
  chargeableBracket,
  defaultCeilingForBracket,
  defaultCeilingTrace,
  projectCostBracket,
  projectUnifiedCostBracket,
  runtimeCostProjection,
  runtimeStartHold,
  unifiedResolvedOptimizer,
} = await import("./cost-bracket.ts");
const { initialWizardV2State } = await import("./wizard-v2.ts");
const { optimizersFor, resolveOptimizer } = await import(unifiedRunUrl);
const { platformFeeCents, DEFAULT_PRICING_TERMS } = await import(billingUrl);
const MARKUP = DEFAULT_PRICING_TERMS.usageMarkup;
const FEE = DEFAULT_PRICING_TERMS.byokFeeFraction;

function model(value: string, input: number, output: number) {
  return {
    value,
    label: value,
    provider: "test",
    supports_thinking: false,
    supports_vision: false,
    available: true,
    input_cost_per_token: input,
    output_cost_per_token: output,
  };
}

const cheap = model("cheap", 0.000001, 0.000002);
const expensive = model("expensive", 0.00001, 0.00002);
const base = {
  autoLevel: "",
  maxFullEvals: "",
  maxMetricCalls: "10",
  datasetRows: 0,
};

test("prices repeated model selections as separate physical roles", () => {
  const once = projectCostBracket({
    ...base,
    modelRoles: [{ role: "task", model: expensive, tokenSource: "managed", tokenShare: 1 }],
  });
  const threeRoles = projectCostBracket({
    ...base,
    modelRoles: [
      { role: "task", model: expensive, tokenSource: "managed", tokenShare: 1 },
      { role: "optimization", model: expensive, tokenSource: "managed", tokenShare: 1 },
      { role: "judge", model: expensive, tokenSource: "managed", tokenShare: 1 },
    ],
  });

  assert.ok(threeRoles.managedModelLowCents > once.managedModelLowCents);
  assert.ok(threeRoles.managedModelHighCents > once.managedModelHighCents);
});

test("economy mode halves only the managed model share", () => {
  const roles = [
    { role: "task" as const, model: expensive, tokenSource: "managed" as const, tokenShare: 1 },
    { role: "optimization" as const, model: expensive, tokenSource: "byok" as const, tokenShare: 1 },
  ];
  const standard = projectCostBracket({ ...base, maxMetricCalls: "1000", modelRoles: roles });
  const economy = projectCostBracket({
    ...base,
    maxMetricCalls: "1000",
    modelRoles: roles,
    economyMode: true,
  });

  assert.ok(Math.abs(economy.managedModelHighCents - standard.managedModelHighCents / 2) <= 1);
  assert.equal(economy.byokModelHighCents, standard.byokModelHighCents);
});

test("uses each selected model's catalog price", () => {
  const allCheap = projectCostBracket({
    ...base,
    modelRoles: [
      { role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 },
      { role: "optimization", model: cheap, tokenSource: "managed", tokenShare: 1 },
    ],
  });
  const selectedPrices = projectCostBracket({
    ...base,
    modelRoles: [
      { role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 },
      { role: "optimization", model: expensive, tokenSource: "managed", tokenShare: 1 },
    ],
  });

  assert.ok(selectedPrices.lowCents > allCheap.lowCents);
  assert.ok(selectedPrices.highCents > allCheap.highCents);
});

test("adds Vercel at cost after applying the BYOK model fee", () => {
  const runtime = runtimeCostProjection(
    {
      billing_basis: "at_cost",
      minimum_session_cents: "1",
      maximum_session_cents: "12",
      maximum_lifetime_seconds: 3600,
      vcpus: 2,
    },
    3,
  );
  const full = projectCostBracket({
    ...base,
    modelRoles: [{ role: "task", model: expensive, tokenSource: "byok", tokenShare: 1 }],
    runtime,
  });
  const charged = chargeableBracket(full, "byok");

  assert.equal(charged.runtimeLowCents, 12);
  assert.equal(charged.runtimeHighCents, 36);
  assert.equal(charged.runtimeSessionLowCents, 1);
  assert.equal(charged.runtimeSessionHighCents, 12);
  assert.equal(charged.lowCents, platformFeeCents(full.byokModelLowCents, FEE) + 12);
  assert.equal(charged.highCents, platformFeeCents(full.byokModelHighCents, FEE) + 36);
});

test("the runtime low end starts at one session's full hold", () => {
  const bracket = projectCostBracket({
    ...base,
    modelRoles: [{ role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 }],
    runtime: runtimeCostProjection(
      {
        billing_basis: "at_cost",
        minimum_session_cents: "0.14",
        maximum_session_cents: "235.8",
        maximum_lifetime_seconds: 18000,
        vcpus: 2,
      },
      4,
    ),
  });

  assert.equal(bracket.runtimeLowCents, 236);
  assert.equal(bracket.runtimeHighCents, 944);
  assert.equal(bracket.lowCents, bracket.managedModelLowCents + 236);
});

test("zero managed sandbox sessions add no runtime charge", () => {
  const runtime = runtimeCostProjection(
    {
      billing_basis: "at_cost",
      minimum_session_cents: "1",
      maximum_session_cents: "12",
      maximum_lifetime_seconds: 3600,
      vcpus: 2,
    },
    0,
  );
  const bracket = projectCostBracket({
    ...base,
    modelRoles: [{ role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 }],
    runtime,
  });

  assert.equal(bracket.runtimeLowCents, 0);
  assert.equal(bracket.runtimeHighCents, 0);
});

test("traces the inputs and intermediate values behind the bracket", () => {
  const bracket = projectCostBracket({
    ...base,
    autoLevel: "medium",
    datasetRows: 1000,
    modelRoles: [
      { role: "task", model: cheap, tokenSource: "managed", tokenShare: 0.65 },
      { role: "optimization", model: expensive, tokenSource: "byok", tokenShare: 0.35 },
    ],
  });
  const { trace } = bracket;

  assert.equal(trace.metricCalls, 2000);
  assert.equal(trace.metricCallSource, "auto_tier");
  assert.equal(trace.rowFactor, 1.5);
  assert.equal(trace.lowTokens, 2000 * 700 * 1.5);
  assert.equal(trace.highTokens, 2000 * 4500 * 1.5 * 1.5);
  assert.deepEqual(
    trace.roles.map((role) => [role.role, role.modelLabel, role.tokenSource, role.priced]),
    [
      ["task", "cheap", "managed", true],
      ["optimization", "expensive", "byok", true],
    ],
  );
  // The traced provider costs rebuild the cent totals the bracket reports.
  const usd = (source: string, end: "lowUsd" | "highUsd") =>
    trace.roles
      .filter((role) => role.tokenSource === source)
      .reduce((sum, role) => sum + role[end], 0);
  assert.equal(Math.ceil((usd("managed", "lowUsd") * MARKUP) / 0.01), bracket.managedModelLowCents);
  // BYOK cents stay at cost: they are the base the platform fee is taken from.
  assert.equal(Math.ceil(usd("byok", "highUsd") / 0.01), bracket.byokModelHighCents);
});

test("explains a full-evals budget and an unpriced model", () => {
  const bracket = projectCostBracket({
    autoLevel: "",
    maxFullEvals: "4",
    maxMetricCalls: "",
    datasetRows: 0,
    modelRoles: [
      { role: "task", model: model("free", 0, 0), tokenSource: "managed", tokenShare: 1 },
    ],
  });

  assert.equal(bracket.trace.metricCallSource, "full_evals");
  assert.equal(bracket.trace.fullEvals, 4);
  assert.equal(bracket.trace.metricCalls, 1000);
  assert.equal(bracket.trace.reflectionHighMultiplier, 1);
  assert.equal(bracket.trace.roles[0]?.priced, false);
});

test("charge trace adds up to the charged bracket", () => {
  const runtime = runtimeCostProjection(
    {
      billing_basis: "at_cost",
      minimum_session_cents: "1",
      maximum_session_cents: "12",
      maximum_lifetime_seconds: 3600,
      vcpus: 2,
    },
    2,
  );
  const charged = chargeableBracket(
    projectCostBracket({
      ...base,
      modelRoles: [
        { role: "task", model: expensive, tokenSource: "managed", tokenShare: 1 },
        { role: "judge", model: cheap, tokenSource: "byok", tokenShare: 1 },
      ],
      runtime,
    }),
    "managed",
  );
  const { charge } = charged;

  assert.equal(charge.byokFeeLow, platformFeeCents(charge.byokFullLow, FEE));
  assert.equal(charge.managedLow + charge.byokFeeLow + charge.runtimeLow, charged.lowCents);
  assert.equal(charge.managedHigh + charge.byokFeeHigh + charge.runtimeHigh, charged.highCents);
});

test("the runtime start hold is one full-lifetime session, and only when billed at cost", () => {
  const profile = {
    minimum_session_cents: "0.14",
    maximum_session_cents: "235.8",
    maximum_lifetime_seconds: 18000,
    vcpus: 2,
  };
  const withRuntime = (billingBasis: "at_cost" | "included_in_model_markup") =>
    projectCostBracket({
      ...base,
      modelRoles: [{ role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 }],
      runtime: runtimeCostProjection({ ...profile, billing_basis: billingBasis }, 4),
    });

  assert.equal(runtimeStartHold(withRuntime("at_cost")), 236);
  assert.equal(runtimeStartHold(withRuntime("included_in_model_markup")), 0);
  assert.equal(
    runtimeStartHold(
      projectCostBracket({
        ...base,
        modelRoles: [{ role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 }],
      }),
    ),
    0,
  );
});

test("the ceiling trace shows the working behind the default cap", () => {
  const small = projectCostBracket({
    ...base,
    modelRoles: [{ role: "task", model: cheap, tokenSource: "managed", tokenShare: 1 }],
  });
  const large = projectCostBracket({
    ...base,
    maxMetricCalls: "8000",
    datasetRows: 2000,
    modelRoles: [{ role: "task", model: expensive, tokenSource: "managed", tokenShare: 1 }],
  });

  for (const bracket of [small, large]) {
    const trace = defaultCeilingTrace(bracket);
    assert.equal(trace.highCents, bracket.highCents);
    assert.equal(trace.withHeadroomCents, Math.ceil(bracket.highCents * trace.headroomFactor));
    assert.equal(trace.ceilingCents % trace.stepCents, 0);
    assert.ok(trace.ceilingCents >= trace.withHeadroomCents);
    assert.ok(trace.ceilingCents - trace.withHeadroomCents < trace.stepCents);
    assert.equal(trace.ceilingCents, defaultCeilingForBracket(bracket));
  }
  assert.equal(defaultCeilingTrace(small).stepCents, 10);
  assert.equal(defaultCeilingTrace(large).stepCents, 50);
});

test("applies the backend's markup to managed roles and its fee fraction to BYOK", () => {
  const roles = [
    { role: "task", model: expensive, tokenSource: "managed", tokenShare: 1 },
    { role: "judge", model: expensive, tokenSource: "byok", tokenShare: 1 },
  ];
  const atCost = projectCostBracket({
    ...base,
    modelRoles: roles,
    pricing: { usageMarkup: 1, byokFeeFraction: 0.05 },
  });
  const markedUp = projectCostBracket({
    ...base,
    modelRoles: roles,
    pricing: { usageMarkup: 2, byokFeeFraction: 0.1 },
  });

  assert.equal(markedUp.usageMarkup, 2);
  assert.ok(markedUp.managedModelHighCents >= 2 * atCost.managedModelHighCents - 1);
  assert.equal(markedUp.byokModelHighCents, atCost.byokModelHighCents);
  const charged = chargeableBracket(markedUp, "managed");
  assert.equal(charged.charge.byokFeeHigh, platformFeeCents(markedUp.byokModelHighCents, 0.1));
});

function unifiedState(patch: {
  kind?: "prompt" | "code" | "dspy_program" | "text" | null;
  choice?: OptimizerChoice;
  cases?: number;
  metricCode?: string;
  economy?: boolean;
}) {
  const state = initialWizardV2State();
  state.task.artifactKind = patch.kind === undefined ? "prompt" : patch.kind;
  state.inputs.mode = "pairs";
  state.inputs.cases = Array.from({ length: patch.cases ?? 20 }, (_, i) => ({
    input: { q: String(i) },
    expected: "a",
  }));
  state.optimizer.choice = patch.choice ?? "auto";
  state.optimizer.taskModel = { name: "cheap" } as never;
  state.optimizer.reflectionModel = { name: "pricey" } as never;
  state.optimizer.budget = { max_scorer_runs: 100, max_iterations: null, stop_at_score: null };
  state.workspace.metricCode = patch.metricCode ?? "def score(input, output):\n    return 1.0, {}";
  state.meta.economyMode = patch.economy ?? false;
  return state;
}

const unifiedModels = [model("cheap", 1e-7, 4e-7), model("pricey", 3e-6, 1.5e-5)];

test("the unified projection's resolver matches the shared one for every allowed choice", () => {
  for (const kind of ["prompt", "code", "dspy_program", "text"] as const)
    for (const mode of ["single", "pairs"] as const)
      for (const choice of optimizersFor(kind, mode))
        assert.equal(unifiedResolvedOptimizer(choice, kind), resolveOptimizer(choice, kind));
});

test("no unified estimate before the task names an artifact", () => {
  assert.equal(projectUnifiedCostBracket(unifiedState({ kind: null }), null), null);
});

test("a black-box run counts the search budget plus the held-out re-score", () => {
  const bracket = projectUnifiedCostBracket(unifiedState({ choice: "gepa", cases: 20 }), null, {
    models: unifiedModels,
  });
  assert.ok(bracket);
  // 100 search runs plus the start and the winner on 20 * 0.3 = 6 held-out cases.
  assert.equal(bracket.trace.metricCalls, 112);
  const biggerState = unifiedState({ choice: "gepa", cases: 20 });
  biggerState.optimizer.budget = { max_scorer_runs: 400 };
  const bigger = projectUnifiedCostBracket(biggerState, null, { models: unifiedModels });
  assert.ok(bigger && bigger.managedModelHighCents > bracket.managedModelHighCents);
});

test("a DSPy program prices through the DSPy projection", () => {
  const dspy = projectUnifiedCostBracket(
    unifiedState({ kind: "dspy_program", choice: "dspy_miprov2" }),
    null,
    { models: unifiedModels },
  );
  assert.ok(dspy);
  assert.ok(dspy.managedModelHighCents > 0);
});

test("the metric model counts only when the metric uses the llm helper", () => {
  const plain = projectUnifiedCostBracket(unifiedState({ choice: "gepa" }), null, {
    models: unifiedModels,
  });
  const judged = projectUnifiedCostBracket(
    unifiedState({
      choice: "gepa",
      metricCode: "from skynet import llm\ndef score(input, output):\n    return 1.0, {}",
    }),
    null,
    { models: unifiedModels },
  );
  assert.ok(plain && judged);
  assert.ok(judged.managedModelHighCents > plain.managedModelHighCents);
});

test("economy pricing skips coding-agent proposers", () => {
  const agentFull = projectUnifiedCostBracket(unifiedState({ choice: "meta_harness" }), null, {
    models: unifiedModels,
  });
  const agentEconomy = projectUnifiedCostBracket(
    unifiedState({ choice: "meta_harness", economy: true }),
    null,
    { models: unifiedModels },
  );
  assert.equal(agentEconomy?.managedModelHighCents, agentFull?.managedModelHighCents);
  const directFull = projectUnifiedCostBracket(unifiedState({ choice: "gepa" }), null, {
    models: unifiedModels,
  });
  const directEconomy = projectUnifiedCostBracket(
    unifiedState({ choice: "gepa", economy: true }),
    null,
    { models: unifiedModels },
  );
  assert.ok(directEconomy && directFull);
  assert.ok(directEconomy.managedModelHighCents <= directFull.managedModelHighCents);
});
