import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const billingUrl = new URL("../../billing/lib/pricing.ts", import.meta.url).href;
const creditUrl = new URL("../../billing/lib/credit.ts", import.meta.url).href;
const budgetLimitUrl = new URL("./budget-limit.ts", import.meta.url).href;
const costBracketUrl = new URL("./cost-bracket.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/features/billing") {
      return { shortCircuit: true, url: billingUrl };
    }
    if (specifier === "./cost-bracket" && context.parentURL === budgetLimitUrl) {
      return { shortCircuit: true, url: costBracketUrl };
    }
    if (specifier === "./credit" && context.parentURL === billingUrl) {
      return { shortCircuit: true, url: creditUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { projectCostBracket, runtimeCostProjection } = await import("./cost-bracket.ts");
const { budgetShortfall, limitFloor } = await import(budgetLimitUrl);

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
      minimum_session_credits: "0.14",
      maximum_session_credits: "235.8",
      maximum_lifetime_seconds: 18000,
      vcpus: 2,
    },
    4,
  ),
});

test("the limit floor is the low end of the estimate, which starts at the opening hold", () => {
  const floor = limitFloor(bracket, "managed");

  assert.ok(floor >= 236);
  assert.equal(floor, bracket.lowCredits);
});

test("a capped run falls short under the floor and is clear at it", () => {
  const floor = limitFloor(bracket, "managed");
  const capped = (limit: number | null) =>
    budgetShortfall(bracket, "managed", { uncapped: false, limit, balance: 5 });

  assert.deepEqual(capped(floor - 1), { kind: "limit", needed: floor });
  assert.equal(capped(floor), null);
  assert.equal(capped(null), null);
});

test("an uncapped run falls short while the balance cannot cover the opening hold", () => {
  const uncapped = (balance: number | null) =>
    budgetShortfall(bracket, "managed", { uncapped: true, limit: 1, balance });

  assert.deepEqual(uncapped(235), { kind: "balance", needed: 236 });
  assert.equal(uncapped(236), null);
  assert.equal(uncapped(null), null);
});
