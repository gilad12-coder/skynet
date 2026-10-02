import assert from "node:assert/strict";
import { test } from "node:test";

import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import { attachDatasets, planDatasetWrite, readDatasetRefs } from "./draft-datasets.ts";
import type { WizardDraftRecord } from "./draft-record.ts";

function dataset(rows: number): ParsedDataset {
  return {
    columns: ["text"],
    rows: Array.from({ length: rows }, (_, i) => ({ text: `row ${i}` })),
  } as unknown as ParsedDataset;
}

function record(program: ParsedDataset | null, anything: ParsedDataset | null): WizardDraftRecord {
  return {
    version: 1,
    id: "draft",
    accountId: "acct",
    activeRecipe: "program",
    revision: 1,
    updatedAt: 0,
    program: { data: { parsedDataset: program, stage: "data" }, meaningful: true },
    anything: { data: { parsedCases: anything, stage: "data" }, meaningful: true },
  } as unknown as WizardDraftRecord;
}

function ids() {
  const map = new Map<ParsedDataset, string>();
  return (d: ParsedDataset) => {
    if (!map.has(d)) map.set(d, `id-${map.size + 1}`);
    return map.get(d) as string;
  };
}

test("a first save writes each dataset once and strips it from the record", () => {
  const a = dataset(3000);
  const b = dataset(10);
  const plan = planDatasetWrite(record(a, b), {}, ids());
  assert.deepEqual(plan.refs, { program: "id-1", anything: "id-2" });
  assert.deepEqual(
    plan.put.map((p) => [p.id, p.dataset]),
    [
      ["id-1", a],
      ["id-2", b],
    ],
  );
  assert.equal(plan.record.program?.data.parsedDataset, null);
  assert.equal(plan.record.anything?.data.parsedCases, null);
  assert.deepEqual(plan.remove, []);
});

test("a save with an unchanged dataset writes no dataset rows", () => {
  const a = dataset(3000);
  const idFor = ids();
  const first = planDatasetWrite(record(a, null), {}, idFor);
  const second = planDatasetWrite(record(a, null), first.refs, idFor);
  assert.deepEqual(second.put, []);
  assert.deepEqual(second.remove, []);
  assert.deepEqual(second.refs, first.refs);
});

test("replacing or clearing a dataset deletes the old row", () => {
  const idFor = ids();
  const first = planDatasetWrite(record(dataset(5), null), {}, idFor);
  const replaced = planDatasetWrite(record(dataset(6), null), first.refs, idFor);
  assert.deepEqual(replaced.remove, ["id-1"]);
  assert.deepEqual(
    replaced.put.map((p) => p.id),
    ["id-2"],
  );
  const cleared = planDatasetWrite(record(null, null), replaced.refs, idFor);
  assert.deepEqual(cleared.remove, ["id-2"]);
  assert.deepEqual(cleared.refs, {});
});

test("a row another tab replaced is written again", () => {
  const a = dataset(5);
  const idFor = ids();
  const first = planDatasetWrite(record(a, null), {}, idFor);
  const plan = planDatasetWrite(record(a, null), { program: "other-tab" }, idFor);
  assert.deepEqual(
    plan.put.map((p) => p.id),
    [first.refs.program],
  );
  assert.deepEqual(plan.remove, ["other-tab"]);
});

test("attach restores datasets and treats a missing row as empty", () => {
  const a = dataset(5);
  const plan = planDatasetWrite(record(a, dataset(2)), {}, ids());
  const restored = attachDatasets(plan.record, plan.refs, new Map([["id-1", a]]));
  assert.equal(restored.program?.data.parsedDataset, a);
  assert.equal(restored.anything?.data.parsedCases, null);
});

test("malformed refs are ignored", () => {
  assert.deepEqual(readDatasetRefs({ program: 3, anything: "x", other: "y" }), { anything: "x" });
  assert.deepEqual(readDatasetRefs(null), {});
});
