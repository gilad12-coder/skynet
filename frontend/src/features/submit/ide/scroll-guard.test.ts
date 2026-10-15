import assert from "node:assert/strict";
import { test } from "node:test";

import { clipsButScrolls } from "./scroll-guard.ts";

test("hidden overflow on either axis is a clipping scroll container", () => {
  assert.equal(clipsButScrolls({ overflowX: "hidden", overflowY: "hidden" }), true);
  assert.equal(clipsButScrolls({ overflowX: "visible", overflowY: "hidden" }), true);
  assert.equal(clipsButScrolls({ overflowX: "hidden", overflowY: "auto" }), true);
});

test("clip, visible and user-scrollable boxes are left alone", () => {
  assert.equal(clipsButScrolls({ overflowX: "clip", overflowY: "clip" }), false);
  assert.equal(clipsButScrolls({ overflowX: "visible", overflowY: "visible" }), false);
  assert.equal(clipsButScrolls({ overflowX: "auto", overflowY: "auto" }), false);
});
