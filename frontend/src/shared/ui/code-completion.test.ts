import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { inCommentOrString } from "./code-completion.ts";

function at(doc: string, marker: string): boolean {
  const state = EditorState.create({ doc, extensions: [python()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return inCommentOrString(state, doc.indexOf(marker) + marker.length);
}

test("a word typed in a comment or string gets no completions", () => {
  assert.equal(at("# edited in the card\ndef score(input, output):\n    pass\n", "card"), true);
  assert.equal(at('x = "label card"\n', "card"), true);
  assert.equal(at('x = f"{y} card"\n', "card"), true);
});

test("a word typed in code still gets completions", () => {
  assert.equal(at("import dspy\ndspy.Pre\n", "dspy.Pre"), false);
  assert.equal(at("def score(input, output):\n    return card\n", "card"), false);
});
