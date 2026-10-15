import assert from "node:assert/strict";
import { test } from "node:test";

import { kickoffFor, type KickoffInput } from "./kickoff.ts";

const BLANK: KickoffInput = {
  hasContext: true,
  objective: "Summarize support tickets",
  dataKnown: true,
  runCode: "",
  metricCode: "",
  agentRun: null,
  agentMetric: null,
  lastCheckOk: null,
  busy: false,
};

test("blank entry files with a full context start a write turn", () => {
  assert.equal(kickoffFor(BLANK), "write");
  assert.equal(kickoffFor({ ...BLANK, runCode: "  \n", metricCode: "\t" }), "write");
});

test("a missing objective or dataset asks instead of writing", () => {
  assert.equal(kickoffFor({ ...BLANK, objective: " " }), "ask");
  assert.equal(kickoffFor({ ...BLANK, dataKnown: false }), "ask");
});

test("no context or a running turn never starts one", () => {
  assert.equal(kickoffFor({ ...BLANK, hasContext: false }), null);
  assert.equal(kickoffFor({ ...BLANK, busy: true }), null);
});

test("the agent's own code that failed its last Check starts a fix turn", () => {
  const own = { ...BLANK, runCode: "r", metricCode: "m", agentRun: "r", agentMetric: "m" };
  assert.equal(kickoffFor({ ...own, lastCheckOk: false }), "fix");
});

test("passing or unchecked agent code waits", () => {
  const own = { ...BLANK, runCode: "r", metricCode: "m", agentRun: "r", agentMetric: "m" };
  assert.equal(kickoffFor({ ...own, lastCheckOk: true }), null);
  assert.equal(kickoffFor({ ...own, lastCheckOk: null }), null);
});

test("code the user wrote or changed by hand is left alone, even when it fails", () => {
  const own = { ...BLANK, runCode: "r", metricCode: "m", agentRun: "r", agentMetric: "m" };
  assert.equal(kickoffFor({ ...own, metricCode: "m2", lastCheckOk: false }), null);
  assert.equal(kickoffFor({ ...BLANK, runCode: "r", metricCode: "m", lastCheckOk: false }), null);
  // One file blank, the other hand-written: still the user's work.
  assert.equal(kickoffFor({ ...BLANK, metricCode: "def score(): ..." }), null);
});
