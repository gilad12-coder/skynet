import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const srcUrl = new URL("../../../", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: new URL(`${specifier.slice(2)}.ts`, srcUrl).href };
    }
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const { panelAuthoringContext } = await import("./code-authoring.ts");

const dataset = {
  rows: [{ message: "I was charged twice", label: "billing" }],
  columns: ["message", "label"],
  columnRoles: { message: "input", label: "output" } as const,
};

test("panel sample cases key expected by its field, as the run's harness passes it", () => {
  const context = panelAuthoringContext(
    { artifact_kind: "prompt", data_mode: "pairs", task_objective: "Route tickets" },
    dataset,
  );
  assert.deepEqual(context?.sample_cases, [
    { input: { message: "I was charged twice" }, expected: { label: "billing" } },
  ]);
});

test("panel sample cases carry no expected without an expected field", () => {
  const context = panelAuthoringContext(
    { artifact_kind: "prompt", data_mode: "pairs", task_objective: "Route tickets" },
    { ...dataset, columnRoles: { message: "input", label: "ignore" } },
  );
  assert.deepEqual(context?.sample_cases, [{ input: { message: "I was charged twice" } }]);
});
