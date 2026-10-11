import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const inputsModeUrl = new URL("./inputs-mode.ts", import.meta.url).href;
const splitCountsUrl = new URL("./split-example-counts.ts", import.meta.url).href;
const unifiedRunUrl = new URL("../../../shared/types/unified-run.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === inputsModeUrl) {
      if (specifier === "./split-example-counts") {
        return { shortCircuit: true, url: splitCountsUrl };
      }
      if (specifier === "@/shared/types/unified-run") {
        return { shortCircuit: true, url: unifiedRunUrl };
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  casesToRows,
  defaultInputFields,
  heldOutCounts,
  inputsIssue,
  parseTypedInput,
  rowsToCases,
  singleInputCase,
  TYPED_INPUT_FIELD,
} = await import(inputsModeUrl);

const split = { train: 0.7, val: 0.15, test: 0.15 };

test("rows become pairs keyed by the expected column, dropping unpicked columns", () => {
  const rows = [
    { q: "2+2", ctx: "math", note: "x", a: "4" },
    { q: "3+3", ctx: "math", note: "y", a: "6" },
  ];
  assert.deepEqual(rowsToCases(rows, ["q", "ctx"], "a"), [
    { input: { q: "2+2", ctx: "math" }, expected: { a: "4" } },
    { input: { q: "3+3", ctx: "math" }, expected: { a: "6" } },
  ]);
});

test("the expected column never leaks into the input, and no expected field means no expected", () => {
  const rows = [{ q: "hi", a: "hello" }];
  assert.deepEqual(rowsToCases(rows, ["q", "a"], "a"), [
    { input: { q: "hi" }, expected: { a: "hello" } },
  ]);
  assert.deepEqual(rowsToCases(rows, ["q"], null), [{ input: { q: "hi" } }]);
});

test("cases round-trip back to the rows they carry", () => {
  const cases = rowsToCases([{ q: "a", a: "b" }], ["q"], "a");
  assert.deepEqual(casesToRows(cases), [{ q: "a", a: "b" }]);
  assert.deepEqual(casesToRows([{ input: { q: "a" }, expected: "plain" }]), [{ q: "a" }]);
});

test("a typed JSON object keeps its fields; anything else is one text field", () => {
  assert.deepEqual(parseTypedInput('{"topic": "cats", "tone": "warm"}'), {
    topic: "cats",
    tone: "warm",
  });
  assert.deepEqual(parseTypedInput("write about cats"), { [TYPED_INPUT_FIELD]: "write about cats" });
  assert.deepEqual(parseTypedInput("{not json"), { [TYPED_INPUT_FIELD]: "{not json" });
  assert.deepEqual(parseTypedInput("[1, 2]"), { [TYPED_INPUT_FIELD]: "[1, 2]" });
});

test("a single input becomes one case with a copied input", () => {
  const input = { input: "hi" };
  const c = singleInputCase(input);
  assert.deepEqual(c, { input: { input: "hi" } });
  assert.notEqual(c.input, input);
});

test("input fields default to every column but the expected one", () => {
  assert.deepEqual(defaultInputFields(["q", "ctx", "a"], "a"), ["q", "ctx"]);
  assert.deepEqual(defaultInputFields(["q"], null), ["q"]);
});

test("pairs hold out a test portion once there are enough of them", () => {
  assert.deepEqual(heldOutCounts(20, split, "pairs"), { train: 14, val: 3, test: 3, heldOut: true });
  assert.deepEqual(heldOutCounts(10, split, "pairs"), { train: 7, val: 2, test: 1, heldOut: true });
});

test("below the held-out minimum no case is held out", () => {
  const counts = heldOutCounts(4, split, "pairs");
  assert.equal(counts.test, 0);
  assert.equal(counts.heldOut, false);
  assert.equal(counts.train + counts.val, 4);
});

test("single mode and empty data hold nothing out", () => {
  assert.deepEqual(heldOutCounts(1, split, "single"), { train: 1, val: 0, test: 0, heldOut: false });
  assert.deepEqual(heldOutCounts(0, split, "pairs"), { train: 0, val: 0, test: 0, heldOut: false });
  assert.deepEqual(heldOutCounts(12, split, null).heldOut, false);
});

test("a zero test fraction holds nothing out", () => {
  const counts = heldOutCounts(20, { train: 0.8, val: 0.2, test: 0 }, "pairs");
  assert.equal(counts.test, 0);
  assert.equal(counts.heldOut, false);
});

test("the confirm gate names what is missing", () => {
  const base = { mode: "pairs", caseCount: 10, inputFields: ["q"], expectedField: "a", split };
  assert.equal(inputsIssue(base), null);
  assert.equal(inputsIssue({ ...base, caseCount: 0 }), "submit.v2.inputs.issue.no_data");
  assert.equal(inputsIssue({ ...base, mode: null }), "submit.v2.inputs.issue.no_mode");
  assert.equal(inputsIssue({ ...base, caseCount: 1 }), "submit.v2.inputs.issue.pairs_need_two");
  assert.equal(
    inputsIssue({ ...base, inputFields: ["a"] }),
    "submit.v2.inputs.issue.no_input_fields",
  );
  assert.equal(
    inputsIssue({ ...base, split: { train: 0.5, val: 0.1, test: 0.1 } }),
    "submit.v2.inputs.issue.split_sum",
  );
  assert.equal(inputsIssue({ ...base, mode: "single", caseCount: 1 }), null);
  assert.equal(
    inputsIssue({ ...base, mode: "single", caseCount: 3 }),
    "submit.v2.inputs.issue.single_needs_one",
  );
});
