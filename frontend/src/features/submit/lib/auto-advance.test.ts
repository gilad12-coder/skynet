import assert from "node:assert/strict";
import { test } from "node:test";

import {
  metricAdvanceFrom,
  taskAdvanceFrom,
  type MetricAdvanceInput,
  type TaskAdvanceInput,
} from "./auto-advance.ts";

const TASK: TaskAdvanceInput = {
  auto: true,
  firstPass: true,
  onStep: true,
  done: true,
  busy: false,
  valid: true,
  page: 0,
};

test("a finished interview continues past each Task screen in turn", () => {
  assert.equal(taskAdvanceFrom(TASK), "brief");
  assert.equal(taskAdvanceFrom({ ...TASK, page: 1 }), "artifact");
});

test("the Task step stays while the interview still asks, writes or the task is invalid", () => {
  assert.equal(taskAdvanceFrom({ ...TASK, done: false }), null);
  assert.equal(taskAdvanceFrom({ ...TASK, busy: true }), null);
  assert.equal(taskAdvanceFrom({ ...TASK, valid: false }), null);
});

test("Manual, a later visit or a hidden step never moves on", () => {
  assert.equal(taskAdvanceFrom({ ...TASK, auto: false }), null);
  assert.equal(taskAdvanceFrom({ ...TASK, firstPass: false }), null);
  assert.equal(taskAdvanceFrom({ ...TASK, onStep: false }), null);
});

const METRIC: MetricAdvanceInput = {
  onStep: true,
  overviewSeen: false,
  busy: false,
  agentLeftFiles: true,
  editorPassed: true,
  checkPassed: false,
  repo: false,
  page: 0,
};

test("passing agent code moves from the editor to Check, and a passing Check to the overview", () => {
  assert.equal(metricAdvanceFrom(METRIC), "metric");
  assert.equal(metricAdvanceFrom({ ...METRIC, page: 1 }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, page: 1, checkPassed: true }), "check");
});

test("the overview holds Run, so it never moves on", () => {
  assert.equal(metricAdvanceFrom({ ...METRIC, page: 2, checkPassed: true }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, repo: true, page: 1, checkPassed: true }), null);
});

test("failing code, a hand edit, a running turn or a seen overview stays put", () => {
  assert.equal(metricAdvanceFrom({ ...METRIC, editorPassed: false }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, agentLeftFiles: false }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, busy: true }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, overviewSeen: true }), null);
  assert.equal(metricAdvanceFrom({ ...METRIC, onStep: false }), null);
});
