/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import type { ContractCheckState } from "../../hooks/use-contract-check";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { ContractCheckScreen } = await import("./ContractCheckScreen");

const HEBREW = /[\u0590-\u05FF]/;
// Built from code points: the lint rule keeps Hebrew literals in the message catalog.
const HEBREW_WORD = String.fromCodePoint(0x05d4, 0x05e7, 0x05d5, 0x05d3);

// `message` is the Hebrew base the server always sends; the screen must not show it in English.
function item(overrides: Partial<ContractCheckItem>): ContractCheckItem {
  return {
    key: "workspace.run",
    status: "passed",
    message: `${HEBREW_WORD} ok`,
    message_code: "contract.passed",
    message_params: {},
    sample_index: null,
    detail: null,
    ...overrides,
  } as ContractCheckItem;
}

function state(overrides: Partial<ContractCheckState>): ContractCheckState {
  return {
    staticResult: null,
    staticPending: false,
    lastCheck: null,
    stale: false,
    checking: false,
    error: null,
    timing: null,
    canCheck: true,
    check: async () => null,
    ...overrides,
  };
}

const failedRun = {
  ok: false,
  optimizer_resolved: "gepa",
  fingerprint: "fp",
  checks: [
    item({ key: "workspace.run_signature" }),
    item({
      key: "workspace.run",
      status: "failed",
      message: `${HEBREW_WORD} 1: boom`,
      message_code: "contract.run_error",
      message_params: { index: 1, error: "KeyError: 'product'" },
      sample_index: 0,
      detail: "Traceback: boom",
    }),
  ],
  samples: [{ index: 0, input_preview: "a review", score: 0.5 }],
} as unknown as ContractCheckResponse;

void describe("ContractCheckScreen", () => {
  void it("shows the setup-check plan before the check runs", () => {
    setClientLocale("en");
    const html = renderToStaticMarkup(
      <ContractCheckScreen cc={state({})} guided={false} active={false} onBack={() => {}} />,
    );
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.match(html, /submit\.preflight\.execution/);
    assert.match(html, /submit\.validation\.progress\.budget</);
    assert.match(html, /submit\.validation\.progress\.evaluator</);
    assert.doesNotMatch(html, HEBREW);
  });

  void it("shows a failed check on the setup-check layout, in English", () => {
    setClientLocale("en");
    const html = renderToStaticMarkup(
      <ContractCheckScreen
        cc={state({
          lastCheck: failedRun,
          timing: { startedAt: 0, requestAt: 1000, finishedAt: 6000 },
        })}
        guided={false}
        active={false}
        onBack={() => {}}
      />,
    );
    assert.match(html, /submit\.validation\.progress\.failed/);
    assert.match(html, /submit\.v2\.metric\.check\.key\.workspace\.run</);
    assert.match(html, /The run code failed on sample 1: KeyError/);
    assert.match(html, /submit\.validation\.progress\.back/);
    assert.doesNotMatch(html, HEBREW);
  });

  void it("shows a passed check as ready", () => {
    setClientLocale("en");
    const html = renderToStaticMarkup(
      <ContractCheckScreen
        cc={state({ lastCheck: { ...failedRun, ok: true, checks: [item({})] } })}
        guided={false}
        active={false}
        onBack={() => {}}
      />,
    );
    assert.match(html, /submit\.validation\.progress\.success/);
    assert.doesNotMatch(html, /submit\.validation\.progress\.back/);
    assert.doesNotMatch(html, HEBREW);
  });
});
