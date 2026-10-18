/*
 * node --test cannot load .tsx, so this runs through jiti (reward-ui.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { bundledRewards, customReward, type RewardBuild } from "@/shared/lib/reward-rules";
import { setClientLocale } from "@/shared/lib/runtime-locale";
import { TooltipProvider } from "@/shared/ui/primitives/tooltip";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { RewardBuilder } = await import("./reward-builder");
const { RewardRecap } = await import("./reward-recap");
const { RewardTryIt } = await import("./reward-try-it");

function build(): RewardBuild {
  const [exact] = bundledRewards("answer");
  const regex = { ...customReward("regex", "answer"), name: "has-number" };
  return {
    rewards: [{ ...exact!, weight: 2 }, regex],
    speed: { weight: 1, reference: 1500 },
    cost: { weight: 0, reference: 0.001 },
  };
}

function render(node: React.ReactElement): string {
  setClientLocale("en");
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

void describe("RewardBuilder", () => {
  void it("lists each reward with its badge and weight, plus Speed and Cost", () => {
    const html = render(
      <RewardBuilder build={build()} onChange={() => undefined} expectedField="answer" />,
    );
    assert.match(html, /exact-answer/);
    assert.match(html, /has-number/);
    assert.match(html, /reward_builder\.bundled</);
    assert.match(html, /reward_builder\.yours</);
    assert.match(html, /value="2"/);
    assert.match(html, /value="1500"/);
    // The editable view can add and import rewards.
    assert.match(html, /reward_builder\.add</);
    assert.match(html, /aria-label="reward_builder\.import\.title"/);
  });

  void it("shows the same rows read-only, without add or import", () => {
    const html = render(<RewardBuilder build={build()} expectedField="answer" />);
    assert.match(html, /exact-answer/);
    assert.doesNotMatch(html, /reward_builder\.add</);
    assert.doesNotMatch(html, /reward_builder\.import\.title/);
    assert.doesNotMatch(html, /<input/);
  });
});

void describe("RewardTryIt", () => {
  void it("fills the expected value from the first sample and lists each reward", () => {
    const html = render(
      <RewardTryIt
        build={build()}
        expectedField="answer"
        samples={[{ input: { q: "1+1" }, expected: { answer: "2" } }]}
      />,
    );
    assert.match(html, /reward_builder\.try\.title/);
    assert.match(html, /exact-answer/);
    assert.match(html, /has-number/);
    // The speed field shows because speed has a weight; cost does not.
    assert.match(html, /reward_builder\.try\.time/);
    assert.doesNotMatch(html, /reward_builder\.try\.cost/);
  });
});

void describe("RewardRecap", () => {
  void it("gives each part its share of the total", () => {
    const html = render(<RewardRecap build={build()} />);
    // Weights 2 + 1 + speed 1 = 4: exact-answer 50%, has-number 25%, speed 25%.
    assert.match(html, /exact-answer[\s\S]*50%/);
    assert.match(html, /has-number[\s\S]*25%/);
    assert.match(html, /reward_builder\.recap\.speed/);
    assert.doesNotMatch(html, /reward_builder\.recap\.cost/);
  });
});
