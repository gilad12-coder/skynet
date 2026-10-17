import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const billingUrl = new URL("../../billing/lib/pricing.ts", import.meta.url).href;
const centUrl = new URL("../../billing/lib/wallet.ts", import.meta.url).href;
const budgetLimitUrl = new URL("./budget-limit.ts", import.meta.url).href;
const costBracketUrl = new URL("./cost-bracket.ts", import.meta.url).href;
const scorerDependenciesUrl = new URL("./scorer-dependencies.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/features/billing") {
      return { shortCircuit: true, url: billingUrl };
    }
    if (specifier === "./cost-bracket" && context.parentURL === budgetLimitUrl) {
      return { shortCircuit: true, url: costBracketUrl };
    }
    if (specifier === "./scorer-dependencies" && context.parentURL === costBracketUrl) {
      return { shortCircuit: true, url: scorerDependenciesUrl };
    }
    if (specifier === "./wallet" && context.parentURL === billingUrl) {
      return { shortCircuit: true, url: centUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { projectCostBracket, runtimeCostProjection } = await import("./cost-bracket.ts");
const { budgetContinueBlock, budgetShortfall, limitFloor } = await import(budgetLimitUrl);

const cheap = {
  value: "cheap",
  label: "cheap",
  provider: "test",
  supports_thinking: false,
  supports_vision: false,
  available: true,
  input_cost_per_token: 0.000001,
  output_cost_per_token: 0.000002,
};

const bracket = projectCostBracket({
  autoLevel: "",
  maxFullEvals: "",
  maxMetricCalls: "10",
  datasetRows: 0,
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

test("the limit floor is the low end of the estimate, which starts at the opening hold", () => {
  const floor = limitFloor(bracket, "managed");

  assert.ok(floor >= 236);
  assert.equal(floor, bracket.lowCents);
});

test("a capped run falls short under the floor and is clear at it", () => {
  const needed = Math.ceil(limitFloor(bracket, "managed"));
  const capped = (limit: number | null) =>
    budgetShortfall(bracket, "managed", { uncapped: false, limit, balance: null });

  assert.deepEqual(capped(needed - 1), { kind: "limit", needed });
  assert.equal(capped(needed), null);
  assert.equal(capped(null), null);
});

test("the balance has to fund the same floor, capped or not", () => {
  const needed = Math.ceil(limitFloor(bracket, "managed"));
  const short = (uncapped: boolean, balance: number | null) =>
    budgetShortfall(bracket, "managed", { uncapped, limit: needed + 500, balance });

  assert.deepEqual(short(true, needed - 1), { kind: "balance", needed });
  assert.deepEqual(short(false, needed - 1), { kind: "balance", needed });
  assert.equal(short(true, needed), null);
  assert.equal(short(false, null), null);
});

test("a short limit is named before a short balance", () => {
  const needed = Math.ceil(limitFloor(bracket, "managed"));

  assert.deepEqual(
    budgetShortfall(bracket, "managed", { uncapped: false, limit: 100, balance: 0 }),
    { kind: "limit", needed },
  );
});

test("Continue holds on the limit screens and at the gate, and nowhere else", () => {
  const needed = Math.ceil(limitFloor(bracket, "managed"));
  const block = (screen: string, choice: object, gate = false) =>
    budgetContinueBlock(
      screen,
      bracket,
      "managed",
      { uncapped: false, limit: null, balance: null, ...choice },
      gate,
    );

  assert.deepEqual(block("budget", { limit: 100 }), { kind: "limit", needed });
  assert.deepEqual(block("plan", { limit: 100 }), { kind: "limit", needed });
  assert.equal(block("budget", { limit: needed }), null);
  assert.equal(block("models", { limit: 100 }), null);
  assert.deepEqual(block("models", { limit: 100 }, true), { kind: "limit", needed });
  assert.deepEqual(block("cases", { uncapped: true, balance: 5 }, true), {
    kind: "balance",
    needed,
  });
  assert.equal(block("budget", { uncapped: true }), null);
  assert.equal(
    budgetContinueBlock("budget", null, "managed", { uncapped: false, limit: 1, balance: 0 }, true),
    null,
  );
});
