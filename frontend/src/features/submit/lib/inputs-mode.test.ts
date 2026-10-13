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
  authoringCases,
  casesToRows,
  columnRoles,
  defaultInputFields,
  heldOutCounts,
  inferredRoles,
  inputsFromRoles,
  inputsIssue,
  parseTypedInput,
  rowsToCases,
  singleInputCase,
  TYPED_INPUT_FIELD,
  withColumnRole,
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

test("the inputs gate names what is missing", () => {
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

test("the inferred fields preselect the column roles: inputs, the output, the rest ignored", () => {
  assert.deepEqual(columnRoles(["q", "ctx", "note", "a"], ["q", "ctx"], "a"), {
    q: "input",
    ctx: "input",
    note: "ignore",
    a: "output",
  });
});

test("an Output column reads the table as input/output pairs over every row", () => {
  const rows = [
    { q: "2+2", note: "x", a: "4" },
    { q: "3+3", note: "y", a: "6" },
  ];
  const read = inputsFromRoles(["q", "note", "a"], { q: "input", note: "ignore", a: "output" }, rows);
  assert.equal(read.mode, "pairs");
  assert.deepEqual(read.inputFields, ["q"]);
  assert.equal(read.expectedField, "a");
  assert.deepEqual(read.cases, rowsToCases(rows, ["q"], "a"));
});

test("no Output column reads the table as one input from the first row", () => {
  const rows = [
    { q: "2+2", a: "4" },
    { q: "3+3", a: "6" },
  ];
  const read = inputsFromRoles(["q", "a"], { q: "input", a: "ignore" }, rows);
  assert.equal(read.mode, "single");
  assert.deepEqual(read.inputFields, ["q"]);
  assert.equal(read.expectedField, null);
  assert.deepEqual(read.cases, rowsToCases([rows[0]], ["q"], null));
});

test("the roles round-trip through the inputs slice", () => {
  const roles = { q: "input", note: "ignore", a: "output" };
  const read = inputsFromRoles(["q", "note", "a"], roles, [{ q: "1", note: "n", a: "2" }]);
  assert.deepEqual(columnRoles(["q", "note", "a"], read.inputFields, read.expectedField), roles);
});

test("choosing a new Output turns the previous one to Ignore", () => {
  const roles = { q: "input", note: "ignore", a: "output" };
  assert.deepEqual(withColumnRole(roles, "note", "output"), {
    q: "input",
    note: "output",
    a: "ignore",
  });
  assert.deepEqual(withColumnRole(roles, "q", "ignore"), { q: "ignore", note: "ignore", a: "output" });
});

test("one input with no input columns is not done", () => {
  assert.equal(
    inputsIssue({ mode: "single", caseCount: 1, inputFields: [], expectedField: null, split }),
    "submit.v2.inputs.issue.no_input_fields",
  );
});

test("a pairs reading with no expected field keeps pairs, the last column the Output", () => {
  const columns = ["q", "ctx", "a"];
  const roles = inferredRoles(columns, { mode: "pairs", input_fields: ["q"], expected_field: null });
  assert.deepEqual(roles, { q: "input", ctx: "ignore", a: "output" });
  const rows = [
    { q: "1", ctx: "x", a: "2" },
    { q: "3", ctx: "y", a: "4" },
  ];
  assert.equal(inputsFromRoles(columns, roles, rows).mode, "pairs");
  const unknown = inferredRoles(columns, { mode: "pairs", input_fields: [], expected_field: "gone" });
  assert.deepEqual(unknown, { q: "input", ctx: "input", a: "output" });
});

test("the inferred expected field is the Output; a single reading has none", () => {
  assert.deepEqual(
    inferredRoles(["q", "a", "n"], { mode: "pairs", input_fields: ["q"], expected_field: "a" }),
    { q: "input", a: "output", n: "ignore" },
  );
  assert.deepEqual(
    inferredRoles(["q", "a"], { mode: "single", input_fields: ["q"], expected_field: null }),
    { q: "input", a: "ignore" },
  );
});

test("the user setting every column to Input or Ignore still means one input", () => {
  const columns = ["q", "a"];
  const roles = withColumnRole(
    inferredRoles(columns, { mode: "pairs", input_fields: ["q"], expected_field: null }),
    "a",
    "ignore",
  );
  assert.equal(inputsFromRoles(columns, roles, [{ q: "1", a: "2" }, { q: "3", a: "4" }]).mode, "single");
});

test("a four-column CSV gives the agent the same input fields the contract check sends", () => {
  const csv = "review,product,rating,sentiment\nGreat sound,Headphones,5,positive\nBroke in a week,Kettle,1,negative";
  const [header, ...lines] = csv.split("\n");
  const columns = header.split(",");
  const rows = lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [columns[i], v])));
  const roles = { review: "input", product: "ignore", rating: "ignore", sentiment: "output" };
  const run = inputsFromRoles(columns, roles, rows);

  const fromCases = authoringCases({ ...run, sampleRows: rows }, 5);
  const fromStaged = authoringCases({ ...run, cases: [], sampleRows: rows }, 5);

  for (const seen of [fromCases, fromStaged]) {
    assert.deepEqual(
      seen.map((c: { input: Record<string, unknown> }) => Object.keys(c.input)),
      run.cases.map((c: { input: Record<string, unknown> }) => Object.keys(c.input)),
    );
    assert.deepEqual(Object.keys(seen[0].input), ["review"]);
    assert.deepEqual(seen[0].expected, { sentiment: "positive" });
  }
});
