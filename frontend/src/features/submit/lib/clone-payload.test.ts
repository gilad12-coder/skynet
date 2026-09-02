import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneBasics, cloneColumnRoles, cloneRows, cloneSourceRecipe } from "./clone-payload.ts";

const programPayload = {
  name: "spam-filter",
  description: "flags spam",
  is_private: 1,
  dataset: [
    { category: "spam", email_text: "Win $1000", note: "x" },
    { category: "ok", email_text: "Standup notes", note: "y" },
  ],
  column_order: ["email_text", "category", "stale_column"],
  column_mapping: { inputs: { email_text: "str" }, outputs: { category: "str" } },
  split_fractions: { train: 0.6, val: 0.2, test: 0.2 },
  shuffle: 0,
  seed: "7",
};

const anythingPayload = {
  name: "copy-tuner",
  cases: [
    { brief: "launch email", tone: "warm" },
    { brief: "renewal nudge", tone: "direct" },
  ],
  seed_candidate: "Write a short email.",
  split_fractions: { train: 1, val: 0, test: 0 },
};

test("cloneSourceRecipe maps blackbox jobs to the Anything recipe", () => {
  assert.equal(cloneSourceRecipe("blackbox"), "anything");
  assert.equal(cloneSourceRecipe("run"), "program");
  assert.equal(cloneSourceRecipe("grid_search"), "program");
});

test("cloneRows restores a Program run's column order and appends uncovered columns", () => {
  const rows = cloneRows(programPayload);
  assert.deepEqual(rows?.columns, ["email_text", "category", "note"]);
  assert.equal(rows?.rowCount, 2);
  assert.equal(rows?.rows[1].email_text, "Standup notes");
});

test("cloneRows reads an Anything run's cases in their own key order", () => {
  const rows = cloneRows(anythingPayload);
  assert.deepEqual(rows?.columns, ["brief", "tone"]);
  assert.equal(rows?.rowCount, 2);
});

test("cloneRows is null without usable rows", () => {
  assert.equal(cloneRows({}), null);
  assert.equal(cloneRows({ dataset: [] }), null);
  assert.equal(cloneRows({ cases: ["not a row", 3, null] }), null);
});

test("cloneColumnRoles overlays the persisted mapping on all-ignore defaults", () => {
  assert.deepEqual(cloneColumnRoles(programPayload, ["email_text", "category", "note"]), {
    email_text: "input",
    category: "output",
    note: "ignore",
  });
});

test("cloneColumnRoles leaves an Anything run's cases for the user to map", () => {
  assert.deepEqual(cloneColumnRoles(anythingPayload, ["brief", "tone"]), {
    brief: "ignore",
    tone: "ignore",
  });
});

test("cloneBasics prefers the job's display name and coerces the shared fields", () => {
  assert.deepEqual(cloneBasics(programPayload, "spam-filter (copy)"), {
    name: "spam-filter (copy)",
    description: "flags spam",
    isPrivate: true,
    split: { train: 0.6, val: 0.2, test: 0.2 },
    shuffle: false,
    seed: 7,
  });
});

test("cloneBasics reports absent fields as null", () => {
  assert.deepEqual(cloneBasics({ name: "" }), {
    name: null,
    description: null,
    isPrivate: null,
    split: null,
    shuffle: null,
    seed: null,
  });
});
