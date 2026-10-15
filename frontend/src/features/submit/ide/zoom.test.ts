import assert from "node:assert/strict";
import { test } from "node:test";

import { zoomFrames } from "./zoom.ts";

test("starts clipped to the slot and ends on the whole viewport", () => {
  const frames = zoomFrames({ top: 120, right: 1300, bottom: 800, left: 140 }, 1440, 900);
  assert.deepEqual(frames, [
    { clipPath: "inset(120px 140px 100px 140px round 12px)" },
    { clipPath: "inset(0px 0px 0px 0px round 0px)" },
  ]);
});

test("a slot partly off screen never gives a negative inset", () => {
  const [from] = zoomFrames({ top: -10.4, right: 1500, bottom: 950, left: -3 }, 1440, 900, 0);
  assert.equal(from?.clipPath, "inset(0px 0px 0px 0px round 0px)");
});
