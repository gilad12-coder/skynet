import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUEST_FAILED_CODE,
  UNKNOWN_FAILURE_CODE,
  contractFailure,
  createStepViewTracker,
  preflightFailure,
} from "./wizard-telemetry.ts";

test("a step view is reported once per change, never on a re-render", () => {
  const viewed = createStepViewTracker();
  const renders = ["task", "task", "inputs", "inputs", "inputs", "metric", "task", "task"] as const;
  const events = renders.map((step) => viewed(step, "guided")).filter(Boolean);
  assert.deepEqual(events, [
    { step: "task", index: 0, mode: "guided" },
    { step: "inputs", index: 1, mode: "guided" },
    { step: "metric", index: 3, mode: "guided" },
    { step: "task", index: 0, mode: "guided" },
  ]);
});

test("a step's index is its fixed position, whatever the mode", () => {
  const viewed = createStepViewTracker();
  assert.deepEqual(viewed("optimizer", "expert"), { step: "optimizer", index: 2, mode: "expert" });
  assert.equal(viewed("optimizer", "guided"), null);
});

test("a preflight reports only the running-to-failed transition", () => {
  const failed = {
    status: "failed",
    response: { checks: [{ key: "scorer.import", status: "failed" }] },
  };
  assert.deepEqual(preflightFailure("running", failed), {
    check: "preflight",
    code: "scorer.import",
  });
  assert.equal(preflightFailure("failed", failed), null);
  assert.equal(preflightFailure(undefined, failed), null);
  assert.equal(preflightFailure("running", { status: "succeeded" }), null);
  assert.equal(preflightFailure("running", { status: "pending" }), null);
  assert.equal(preflightFailure("running", null), null);
});

test("a preflight that failed without a response reports the request code", () => {
  assert.deepEqual(preflightFailure("running", { status: "failed" }), {
    check: "preflight",
    code: REQUEST_FAILED_CODE,
  });
});

test("a passing contract check fires nothing; a failing one names its first failed check", () => {
  assert.equal(
    contractFailure({ ok: true, checks: [{ key: "metric.shape", status: "passed" }] }),
    null,
  );
  const result = {
    ok: false,
    checks: [
      { key: "workspace.run_signature", status: "passed" },
      { key: "metric.shape", status: "failed" },
      { key: "metric.model", status: "failed" },
    ],
  };
  assert.deepEqual(contractFailure(result), { check: "contract", code: "metric.shape" });
  assert.deepEqual(contractFailure(null), { check: "contract", code: REQUEST_FAILED_CODE });
});

test("no error text or user content reaches the properties", () => {
  const secret = "Traceback: KeyError 'my_api_key=sk-123' in /home/me/metric.py";
  const result = {
    ok: false,
    checks: [{ key: "metric.shape", status: "failed", message: secret, detail: secret }],
  };
  const props = contractFailure(result);
  assert.deepEqual(props, { check: "contract", code: "metric.shape" });
  assert.ok(!JSON.stringify(props).includes("sk-123"));

  const textKey = { ok: false, checks: [{ key: secret, status: "failed" }] };
  assert.deepEqual(contractFailure(textKey), { check: "contract", code: UNKNOWN_FAILURE_CODE });

  const preflight = preflightFailure("running", {
    status: "failed",
    response: { checks: [{ key: "Bad Key With Spaces", status: "failed", message: secret }] },
  });
  assert.deepEqual(preflight, { check: "preflight", code: UNKNOWN_FAILURE_CODE });
  assert.ok(!JSON.stringify(preflight).includes(secret));
});

test("a failed result that names no failed check reports the unknown code", () => {
  assert.deepEqual(contractFailure({ ok: false, checks: [] }), {
    check: "contract",
    code: UNKNOWN_FAILURE_CODE,
  });
});
