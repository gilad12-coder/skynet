import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { detectLanguage, looksLikeCode } from "./seed-format.ts";

// Execute the real handlers without loading the wizard's network and browser
// dependencies. This guards state transitions, rather than matching source text.
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, "Expected handler was not found");
  return found;
}

function variable(root: ts.Node, name: string) {
  const declaration = find(root, (node) =>
    ts.isVariableDeclaration(node) && node.name.getText() === name,
  ) as ts.VariableDeclaration;
  assert.ok(declaration.initializer);
  return ts.isCallExpression(declaration.initializer)
    ? declaration.initializer.arguments[0]!
    : declaration.initializer;
}

function handler(root: ts.Node, name: string) {
  const attribute = find(root, (node) =>
    ts.isJsxAttribute(node) && node.name.getText() === name,
  ) as ts.JsxAttribute;
  assert.ok(attribute.initializer && ts.isJsxExpression(attribute.initializer));
  assert.ok(attribute.initializer.expression);
  return attribute.initializer.expression;
}

function evaluate(node: ts.Node, bindings: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(`(${node.getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  return runInNewContext(outputText, bindings);
}

const wizard = source("../hooks/use-blackbox-wizard.ts");
const start = source("../components/blackbox/BlackboxStartStep.tsx");
const splitSection = source("../components/steps/SplitSection.tsx");
const detection = find(wizard, (node) =>
  ts.isCallExpression(node) && node.expression.getText() === "useEffect" &&
  !!node.arguments[0]?.getText().includes("detectLanguage(seedSample)"),
) as ts.CallExpression;

for (const [language, seedSample] of [
  ["JSON", '{"enabled": true}'],
  ["YAML", "services:\n  api:\n    image: skynet/api:latest"],
  ["JavaScript", "const count = 3\nconsole.log(count)"],
  ["Python", 'import math\nprint(math.pi)'],
]) {
  test(`${language} highlighting never changes the recipe or evaluator`, () => {
    for (const recipe of ["anything", "code"]) {
      let guess = { code: false, language: null as string | null };
      const forbidden = () => assert.fail("Syntax inference changed execution settings");
      evaluate(detection.arguments[0]!, {
        seedSample, seedMode: "text", seedGuess: guess, recipe,
        detectLanguage, looksLikeCode,
        setSeedGuess: (update: (previous: typeof guess) => typeof guess) => {
          guess = update(guess);
        },
        setRecipe: forbidden, setRecipeState: forbidden, setMetricCode: forbidden,
      })();
      assert.equal(guess.code, true);
      assert.equal(guess.language, language);
    }
  });
}

test("switching back to parts retains edited names and content", () => {
  let seedMode = "text";
  const seedText = "Original whole text";
  let seedParts = [{ key: "", value: "" }];
  const addPart = () => evaluate(variable(start, "addPart"), {
    seedMode, seedText, seedParts,
    setSeedMode: (mode: string) => { seedMode = mode; },
    setSeedParts: (parts: typeof seedParts) => { seedParts = parts; },
  })();
  addPart();
  assert.equal(seedParts[0]?.value, seedText);
  assert.equal(seedMode, "parts");

  const authored = [
    { key: "prompt", value: "Edited prompt" },
    { key: "rules", value: "New constraints" },
    { key: "unfinished", value: "" },
  ];
  seedParts = authored;
  for (const mode of ["text", "none", "text"]) {
    seedMode = mode;
    addPart();
    assert.equal(seedMode, "parts");
    assert.deepEqual(Array.from(seedParts.slice(0, authored.length)), authored);
    assert.equal(seedParts.at(-1)?.key, "");
    assert.equal(seedParts.at(-1)?.value, "");
  }
});

function splitState(mode = "manual") {
  const state = {
    split: { train: 0.8, val: 0.1, test: 0.1 },
    shuffle: false,
    seed: 123,
    mode,
    adjustOpen: true,
  };
  const bindings = {
    splitModeRef: { current: mode },
    splitPlan: { fractions: { train: 0.6, val: 0.2, test: 0.2 }, shuffle: true, seed: 42 },
    setSplitModeState: (next: string) => { state.mode = next; },
    setSplit: (next: typeof state.split | ((previous: typeof state.split) => typeof state.split)) => {
      state.split = typeof next === "function" ? next(state.split) : next;
    },
    setShuffle: (next: boolean) => { state.shuffle = next; },
    setSeed: (next: number) => { state.seed = next; },
    setAdjustOpen: (next: boolean) => { state.adjustOpen = next; },
  };
  return {
    state,
    bindings: {
      ...bindings,
      setSplitMode: evaluate(variable(wizard, "setSplitMode"), bindings),
      updateSplit: evaluate(variable(wizard, "updateSplit"), bindings),
    },
  };
}

for (const mode of ["manual", "auto"]) {
  test(`opening and closing split settings preserves ${mode} settings`, () => {
    const { state, bindings } = splitState(mode);
    const toggle = evaluate(handler(splitSection, "onOpenChange"), bindings);
    const before = structuredClone(state);
    for (const open of [false, true, false]) {
      toggle(open);
      assert.deepEqual(state, { ...before, adjustOpen: open });
    }
  });
}

test("Use recommendation explicitly resets split, shuffle and seed", () => {
  const { state, bindings } = splitState();
  const reset = find(splitSection, (node) =>
    ts.isJsxElement(node) && node.openingElement.tagName.getText() === "Button" &&
    node.getText().includes('msg("submit.split.mode_auto")'),
  );
  evaluate(handler(reset, "onClick"), bindings)();
  assert.equal(state.mode, "auto");
  assert.deepEqual(state.split, bindings.splitPlan.fractions);
  assert.equal(state.shuffle, true);
  assert.equal(state.seed, 42);
});

for (const field of ["train", "val", "test"] as const) {
  test(`editing ${field} switches to manual before applying the value`, () => {
    const { state, bindings } = splitState("auto");
    const input = find(splitSection, (node) =>
      ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "NumberInput" &&
      node.getText().includes(`id="split-${field}"`),
    );
    evaluate(handler(input, "onChange"), bindings)(0.25);
    assert.equal(state.mode, "manual");
    assert.equal(state.split[field], 0.25);
    assert.equal(state.shuffle, false);
    assert.equal(state.seed, 123);
  });
}
