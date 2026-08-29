import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectRenderKind, formatJson, sideInfoImages, sideInfoNotes } from "./candidate-render.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("detectRenderKind", () => {
  it("recognises svg, html, json, python, other code and prose", () => {
    assert.equal(
      detectRenderKind('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      "svg",
    );
    assert.equal(detectRenderKind("<!DOCTYPE html><html><body>hi</body></html>"), "html");
    assert.equal(detectRenderKind('<div class="card">\n<p>hi</p>\n</div>'), "html");
    assert.equal(detectRenderKind('{"a": [1, 2]}'), "json");
    assert.equal(detectRenderKind("import numpy as np\n\ndef pack(n):\n    return n"), "python");
    assert.equal(detectRenderKind("#include <cuda.h>\n__global__ void k() {}"), "code");
    assert.equal(detectRenderKind("You are a careful solver.\n\nThink step by step."), "markdown");
  });

  it("treats prose with fenced examples as markdown even when it quotes code", () => {
    assert.equal(detectRenderKind("Use this helper:\n\n```python\nimport os\n```\n"), "markdown");
    assert.equal(detectRenderKind("{not json"), "markdown");
    assert.equal(detectRenderKind("   "), "markdown");
  });
});

describe("side info helpers", () => {
  it("splits images from notes and keeps list order", () => {
    const sideInfo = {
      feedback: "tight",
      render: PNG,
      frames: [PNG, "note", PNG],
      score_parts: { a: 1 },
      empty: null,
    };
    assert.deepEqual(
      sideInfoImages(sideInfo).map((i) => i.key),
      ["render", "frames[0]", "frames[2]"],
    );
    assert.deepEqual(sideInfoNotes(sideInfo), [
      ["feedback", "tight"],
      ["frames", "note"],
      ["score_parts", '{\n  "a": 1\n}'],
    ]);
  });

  it("formats json and leaves invalid text alone", () => {
    assert.equal(formatJson('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(formatJson("nope"), "nope");
  });
});
