import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const billingUrl = new URL("../../billing/lib/pricing.ts", import.meta.url).href;
const creditUrl = new URL("../../billing/lib/credit.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/features/billing") {
      return { shortCircuit: true, url: billingUrl };
    }
    if (specifier === "./credit" && context.parentURL === billingUrl) {
      return { shortCircuit: true, url: creditUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { chargeableBracket, projectCostBracket, runtimeCostProjection } = await import(
  "./cost-bracket.ts"
);
const { platformFeeCredits } = await import(billingUrl);

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

  assert.ok(threeRoles.managedModelLowCredits > once.managedModelLowCredits);
  assert.ok(threeRoles.managedModelHighCredits > once.managedModelHighCredits);
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

  assert.ok(selectedPrices.lowCredits > allCheap.lowCredits);
  assert.ok(selectedPrices.highCredits > allCheap.highCredits);
});

test("adds Vercel at cost after applying the BYOK model fee", () => {
  const runtime = runtimeCostProjection(
    {
      billing_basis: "at_cost",
      minimum_session_credits: "1",
      maximum_session_credits: "12",
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

  assert.equal(charged.runtimeLowCredits, 3);
  assert.equal(charged.runtimeHighCredits, 36);
  assert.equal(charged.runtimeSessionLowCredits, 1);
  assert.equal(charged.runtimeSessionHighCredits, 12);
  assert.equal(charged.lowCredits, platformFeeCredits(full.byokModelLowCredits) + 3);
  assert.equal(charged.highCredits, platformFeeCredits(full.byokModelHighCredits) + 36);
});

test("zero managed sandbox sessions add no runtime charge", () => {
  const runtime = runtimeCostProjection(
    {
      billing_basis: "at_cost",
      minimum_session_credits: "1",
      maximum_session_credits: "12",
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

  assert.equal(bracket.runtimeLowCredits, 0);
  assert.equal(bracket.runtimeHighCredits, 0);
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
  // The traced provider costs rebuild the credit totals the bracket reports.
  const usd = (source: string, end: "lowUsd" | "highUsd") =>
    trace.roles
      .filter((role) => role.tokenSource === source)
      .reduce((sum, role) => sum + role[end], 0);
  assert.equal(Math.ceil((usd("managed", "lowUsd") * 1.5) / 0.01), bracket.managedModelLowCredits);
  assert.equal(Math.ceil((usd("byok", "highUsd") * 1.5) / 0.01), bracket.byokModelHighCredits);
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
      minimum_session_credits: "1",
      maximum_session_credits: "12",
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

  assert.equal(charge.byokFeeLow, platformFeeCredits(charge.byokFullLow));
  assert.equal(charge.managedLow + charge.byokFeeLow + charge.runtimeLow, charged.lowCredits);
  assert.equal(charge.managedHigh + charge.byokFeeHigh + charge.runtimeHigh, charged.highCredits);
});
