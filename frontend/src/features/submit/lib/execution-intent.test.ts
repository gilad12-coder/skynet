import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutionKind, restoreExecutionMode } from "./execution-intent.ts";

test("new and legacy auto setups evaluate candidates directly", () => {
  assert.equal(resolveExecutionKind("auto"), "text");
  assert.equal(resolveExecutionKind("text"), "text");
});

test("only an explicit evaluator opt-in starts an agent", () => {
  assert.equal(resolveExecutionKind("agent"), "agent");
});

test("draft restoration preserves earlier inferred execution without reinterpreting the objective", () => {
  assert.equal(restoreExecutionMode({ executionMode: "auto", targetKind: "agent" }), "agent");
  assert.equal(restoreExecutionMode({ executionMode: "auto", targetKind: "text" }), "text");
  assert.equal(restoreExecutionMode({ targetKind: "agent" }), "agent");
  assert.equal(restoreExecutionMode({ targetKind: "text" }), "text");
});

test("saved explicit evaluator choices take precedence over legacy inferred state", () => {
  assert.equal(restoreExecutionMode({ executionMode: "text", targetKind: "agent" }), "text");
  assert.equal(restoreExecutionMode({ executionMode: "agent", targetKind: "text" }), "agent");
});
