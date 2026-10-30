/** Tests for the markdown detector behind the live text-box preview. */

import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeMarkdown } from "./markdown-hint.ts";

test("recognises headings, lists, bold, code, links and tables", () => {
  for (const text of [
    "# Goal\nClassify tickets",
    "Steps:\n- read\n- answer",
    "1. first\n2. second",
    "Keep it **short**",
    "Call `classify()` once",
    "See [the docs](https://example.com)",
    "| a | b |\n|---|---|",
  ]) {
    assert.equal(looksLikeMarkdown(text), true, text);
  }
});

test("leaves plain prose, JSON and empty text alone", () => {
  for (const text of [
    "",
    "   ",
    "Classify support tickets by urgency.",
    "Line one\nLine two",
    '{"question": "- not a list"}',
    "[1, 2, 3]",
  ]) {
    assert.equal(looksLikeMarkdown(text), false, text);
  }
});
