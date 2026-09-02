import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseScorerNote } from "./scorer-note.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("parseScorerNote", () => {
  it("keeps plain prose as the body", () => {
    const note = parseScorerNote("Looks like a horse.\n\n*   No horn");
    assert.deepEqual(note, {
      body: "Looks like a horse.\n\n*   No horn",
      images: [],
      truncated: 0,
    });
  });

  it("lifts whole quoted renders out of the prose", () => {
    const note = parseScorerNote(`SCORE: 45/100\nrender_1: "${PNG}"\nrender_2: "${PNG}"`);
    assert.equal(note.body, "SCORE: 45/100");
    assert.deepEqual(note.images, [
      { key: "render_1", src: PNG },
      { key: "render_2", src: PNG },
    ]);
    assert.equal(note.truncated, 0);
  });

  it("counts a render the cap cut short instead of drawing it", () => {
    const note = parseScorerNote(`Fine.\nrender_1: "${PNG.slice(0, -3)}`);
    assert.equal(note.body, "Fine.");
    assert.deepEqual(note.images, []);
    assert.equal(note.truncated, 1);
  });

  it("accepts a bare data URL when its base64 is padded", () => {
    const note = parseScorerNote(`render: ${PNG}`);
    assert.deepEqual(note.images, [{ key: "render", src: PNG }]);
    assert.equal(note.body, "");
  });

  it("leaves an empty note empty", () => {
    assert.deepEqual(parseScorerNote(""), { body: "", images: [], truncated: 0 });
  });
});
