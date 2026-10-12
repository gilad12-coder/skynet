import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runHint, shapeHint } from "./code-hints.ts";

describe("code hints", () => {
  it("names each metric signature", () => {
    assert.match(shapeHint("dspy_feedback"), /^metric\(gold, pred, trace=None, pred_name/);
    assert.equal(shapeHint("dspy_scalar"), "metric(gold, pred, trace=None) -> float | bool");
    assert.match(shapeHint("blackbox_side_info"), /^score\(input, output, expected=None\)/);
  });

  it("names the run entrypoint per artifact kind", () => {
    assert.equal(runHint("dspy_program"), "build_program() -> dspy.Module");
    assert.equal(runHint("prompt"), "run(artifact, input) -> output");
  });
});
