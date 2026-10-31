/*
 * node --test cannot load .tsx, so this runs through jiti (UsageTab.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS='{"@/":"<abs>/src/","react-loading-skeleton/dist/skeleton.css":"<abs>/src/features/optimizations/components/__fixtures__/style-stub.ts"}' npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { UsageTabSkeleton } = await import("./UsageTab");

const shape = (apiRate: boolean) => ({
  groupings: ["role" as const],
  grouping: "role" as const,
  rows: 2,
  splitCost: false,
  notModelAt: -1,
  apiRate,
});

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

void describe("UsageTabSkeleton", () => {
  void it("draws the API-rate column and summary tile a settled subscription run showed", () => {
    const plain = renderToStaticMarkup(<UsageTabSkeleton budgeted={false} shape={shape(false)} />);
    const apiRate = renderToStaticMarkup(<UsageTabSkeleton budgeted={false} shape={shape(true)} />);
    assert.equal(count(apiRate, /<th\b/g), count(plain, /<th\b/g) + 1);
    assert.equal(count(apiRate, /<td\b/g), count(plain, /<td\b/g) + 3);
    assert.equal(count(apiRate, /min-w-0 space-y-1/g), 4);
    assert.equal(count(plain, /min-w-0 space-y-1/g), 3);
  });
});
