import assert from "node:assert/strict";
import test from "node:test";
import { inferExecutionKind, resolveExecutionKind } from "./execution-intent.ts";

test("recognizes explicit coding-agent instruction tasks", () => {
  for (const goal of [
    "Improve the instructions for a coding agent",
    "Optimize my coding agent's system prompt",
    "שפר את ההוראות עבור סוכן קוד",
  ])
    assert.equal(inferExecutionKind(goal), "agent", goal);
});

test("recognizes direct artifact tasks without treating code as agent instructions", () => {
  for (const goal of [
    "Optimize this Python function",
    "Improve my SQL query",
    "Rewrite the policy",
  ])
    assert.equal(inferExecutionKind(goal), "text", goal);
});

test("leaves ambiguous, negated, descriptive and unsupported tasks unresolved", () => {
  for (const goal of [
    "",
    "Make it better",
    "Use Meta-Harness",
    "Build a coding agent",
    "Explain instructions for a coding agent",
    "Improve the instructions for a coding agent without running it",
    "Improve the instructions for a coding agent or rewrite the program",
    "def agent(): pass",
    "Améliorer les instructions",
  ])
    assert.equal(inferExecutionKind(goal), null, goal);
});

test("explicit choices win over changing task text", () => {
  assert.equal(resolveExecutionKind("text", "Improve instructions for a coding agent"), "text");
  assert.equal(resolveExecutionKind("agent", "Optimize this Python function"), "agent");
  assert.equal(resolveExecutionKind("auto", "Improve instructions for a coding agent"), "agent");
  assert.equal(resolveExecutionKind("auto", "Make it better"), "text");
});
