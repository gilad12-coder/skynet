import assert from "node:assert/strict";
import test from "node:test";

import { ANIMALS } from "./evolution-animals.ts";
import { buildEvolution, morphFrame, parsePoints, restFrame } from "./evolution-poses.ts";

const evolution = buildEvolution(ANIMALS);

test("the chain runs from the first fish to us through ten animals", () => {
  assert.equal(ANIMALS.length, 10);
  assert.equal(ANIMALS[0]!.key, "haikouichthys");
  assert.equal(ANIMALS.at(-1)!.key, "homo-sapiens");
  assert.equal(evolution.transitions.length, 9);
});

test("every part parses into finite points inside the 200x160 box, with room for overflow", () => {
  for (const animal of ANIMALS) {
    for (const [, d] of animal.parts) {
      for (const p of parsePoints(d)) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${animal.key}: bad point in ${d}`);
        assert.ok(p.x > -20 && p.x < 220 && p.y > -20 && p.y < 180, `${animal.key}: ${p.x},${p.y} far outside the box`);
      }
    }
  }
});

test("each step pairs most of the outline so the figure flows instead of cross-fading", () => {
  for (const tr of evolution.transitions) {
    const outlines = tr.from.parts.filter((p) => p.cls === "outline").length;
    const paired = tr.pairs.filter((p) => tr.from.parts[p.a]!.cls === "outline").length;
    assert.ok(paired >= Math.min(2, outlines), `${tr.from.key} -> ${tr.to.key} pairs ${paired} of ${outlines} outlines`);
  }
});

test("details stay on the body part they decorate, so a finger never flies off to become a toe", () => {
  for (const tr of evolution.transitions) {
    for (const { a, b } of tr.pairs) {
      const pa = tr.from.parts[a]!;
      const pb = tr.to.parts[b]!;
      if (pa.host && pb.host) assert.equal(pa.host, pb.host, `${tr.from.key} -> ${tr.to.key}: part ${a} -> ${b}`);
    }
  }
});

test("leaving parts clear early and arriving parts show late, so no ghost lingers mid-morph", () => {
  for (const tr of evolution.transitions) {
    assert.equal(morphFrame(tr, 0.5).length, tr.pairs.length, `${tr.from.key} -> ${tr.to.key} mid-frame`);
    assert.ok(morphFrame(tr, 0.5).every((p) => p.opacity === 1));
  }
});

test("a morph ends with every part of the next animal on screen", () => {
  for (const tr of evolution.transitions) {
    const end = morphFrame(tr, 1);
    assert.equal(end.length, tr.to.parts.length);
    assert.ok(end.every((p) => p.opacity === 1));
    assert.ok(end.length <= evolution.maxParts);
  }
  assert.equal(restFrame(evolution.animals.at(-1)!).length, evolution.animals.at(-1)!.parts.length);
});
