import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runHint,
  seedWorkspace,
  shapeHint,
  starterMetricCode,
  starterRunCode,
} from "./metric-templates.ts";

const FIELDS = { inputFields: ["question", "context"], expectedField: "answer" };

describe("starterRunCode", () => {
  for (const kind of ["prompt", "code", "text"] as const) {
    it(`defines run(artifact, input) for ${kind}`, () => {
      const code = starterRunCode(kind, FIELDS);
      assert.ok(code.includes("def run(artifact, input):"));
      assert.ok(!code.includes("build_program"));
    });
  }

  it("calls the task model for a prompt", () => {
    assert.ok(starterRunCode("prompt", FIELDS).includes("from skynet import llm"));
  });

  it("defines build_program with the data's fields for a DSPy program", () => {
    const code = starterRunCode("dspy_program", FIELDS);
    assert.ok(code.includes("def build_program():"));
    assert.ok(code.includes('"question, context -> answer"'));
    assert.ok(!code.includes("def run("));
  });

  it("falls back to placeholder fields that are valid identifiers", () => {
    const code = starterRunCode("dspy_program", {
      inputFields: ["user question"],
      expectedField: "the answer",
    });
    assert.ok(code.includes('"question -> answer"'));
  });
});

describe("starterMetricCode", () => {
  it("takes five params and returns score and feedback for dspy_feedback", () => {
    const code = starterMetricCode("dspy_feedback", FIELDS);
    assert.ok(
      code.includes("def metric(gold, pred, trace=None, pred_name=None, pred_trace=None):"),
    );
    assert.ok(code.includes("dspy.Prediction(score="));
    assert.ok(code.includes("feedback="));
  });

  it("takes three params and returns a float for dspy_scalar", () => {
    const code = starterMetricCode("dspy_scalar", FIELDS);
    assert.ok(code.includes("def metric(gold, pred, trace=None):"));
    assert.ok(code.includes("return float("));
    assert.ok(code.includes("gold.answer"));
  });

  it("returns a score and side_info with feedback for blackbox_side_info", () => {
    const code = starterMetricCode("blackbox_side_info", FIELDS);
    assert.ok(code.includes("def score(input, output, expected=None):"));
    assert.ok(code.includes('{"feedback":'));
  });
});

describe("hints", () => {
  it("names each metric signature", () => {
    assert.match(shapeHint("dspy_feedback"), /^metric\(gold, pred, trace=None, pred_name/);
    assert.equal(shapeHint("dspy_scalar"), "metric(gold, pred, trace=None) -> float | bool");
    assert.match(shapeHint("blackbox_side_info"), /^score\(input, output, expected=None\)/);
  });

  it("names the run signature per artifact kind", () => {
    assert.equal(runHint("dspy_program"), "build_program() -> dspy.Module");
    assert.equal(runHint("prompt"), "run(artifact, input) -> output");
  });
});

describe("seedWorkspace", () => {
  it("fills both empty slots", () => {
    const patch = seedWorkspace(
      { runCode: "", metricCode: " \n" },
      "prompt",
      "blackbox_side_info",
      FIELDS,
    );
    assert.ok(patch?.runCode?.includes("def run("));
    assert.ok(patch?.metricCode?.includes("def score("));
  });

  it("never replaces existing code, even when the shape no longer fits", () => {
    const current = {
      runCode: "def run(artifact, input):\n    return 1\n",
      metricCode: "def score(input, output):\n    return 1, {}\n",
    };
    assert.equal(seedWorkspace(current, "dspy_program", "dspy_feedback", FIELDS), null);
  });

  it("fills only the empty slot", () => {
    const patch = seedWorkspace(
      { runCode: "x = 1", metricCode: "" },
      "prompt",
      "dspy_scalar",
      FIELDS,
    );
    assert.deepEqual(patch, { metricCode: starterMetricCode("dspy_scalar", FIELDS) });
  });

  it("waits for the artifact kind and the shape", () => {
    assert.equal(seedWorkspace({ runCode: "", metricCode: "" }, null, null, FIELDS), null);
  });
});
