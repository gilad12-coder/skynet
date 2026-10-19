/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { readRewardSpec } from "@/shared/lib/reward";
import { setClientLocale } from "@/shared/lib/runtime-locale";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;

const { RewardPreview } = await import("./reward-preview");

export const GEOCODING_METRIC = `from skynet import reward

REWARD_SPEC = {
    "weights": {"accuracy": 0.35, "speed": 0.35, "cost": 0.30},
    "accuracy": {"meaning": "Distance to the labeled point", "unit": "km", "reference": 1.0},
    "speed": {"meaning": "Time to answer one message", "unit": "ms", "reference": 2000},
    "cost": {"meaning": "Service cost of one message", "unit": "USD", "reference": 0.002},
}

def score(example, output):
    return reward(REWARD_SPEC, None)
`;

function render(code: string, locale: "en" | "he" = "en"): string {
  setClientLocale(locale);
  return renderToStaticMarkup(<RewardPreview read={readRewardSpec(code)} />);
}

void describe("RewardPreview", () => {
  void it("shows the formula and each part's meaning, unit, weight and reference", () => {
    const html = render(GEOCODING_METRIC);
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.match(html, /submit\.v2\.reward\.formula/);
    for (const text of [
      "Distance to the labeled point",
      "Time to answer one message",
      "Service cost of one message",
      "35%",
      "30%",
      "1 km",
      "$0.002",
    ]) {
      assert.ok(html.includes(text), text);
    }
  });

  void it("shows no preview cases and no notes below the parts", () => {
    const html = render(GEOCODING_METRIC);
    assert.doesNotMatch(html, /data-case=/);
    assert.doesNotMatch(html, /submit\.v2\.reward\.(tradeoff_note|failures)/);
  });

  void it("says so when the spec is not usable plain data", () => {
    const html = render("REWARD_SPEC = build()\n");
    assert.match(html, /role="status"/);
    assert.match(html, /submit\.v2\.reward\.invalid/);
  });

  void it("keeps the weights left to right in Hebrew", () => {
    const html = render(GEOCODING_METRIC, "he");
    assert.match(html, /<bdi dir="ltr">35%<\/bdi>/);
  });
});
