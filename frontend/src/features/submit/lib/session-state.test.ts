import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { decodeWizardSession, encodeWizardSession } from "./session-state.ts";

const unifiedRunUrl = new URL("../../../shared/types/unified-run.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/shared/types/unified-run") {
      return { shortCircuit: true, url: unifiedRunUrl };
    }
    return nextResolve(specifier, context);
  },
});

const { WIZARD_V2_STEPS, initialWizardV2State } = await import("./wizard-v2.ts");

const STEPS = WIZARD_V2_STEPS as readonly string[];

test("a setup comes back on the step it was left on, for the same account only", () => {
  const state = {
    ...initialWizardV2State("guided"),
    step: "optimizer" as const,
    furthestStep: "optimizer" as const,
  };
  state.task = { ...state.task, objective: "Answer refund questions" };
  const raw = encodeWizardSession("a@x.io", state);

  assert.deepEqual(decodeWizardSession(raw, "a@x.io", STEPS), state);
  assert.equal(decodeWizardSession(raw, "b@x.io", STEPS), null);
});

test("missing, broken or older setups are ignored", () => {
  const good = initialWizardV2State("guided");
  assert.equal(decodeWizardSession(null, "a", STEPS), null);
  assert.equal(decodeWizardSession("{not json", "a", STEPS), null);
  assert.equal(
    decodeWizardSession(
      JSON.stringify({ account: "a", state: { ...good, step: "gone" } }),
      "a",
      STEPS,
    ),
    null,
  );
  const { inputs: _inputs, ...withoutInputs } = good;
  assert.equal(
    decodeWizardSession(JSON.stringify({ account: "a", state: withoutInputs }), "a", STEPS),
    null,
  );
});
