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
const { ContractCheckPanel } = await import("./ContractCheckPanel");

const HEBREW = /[\u0590-\u05FF]/;
// Built from code points: the lint rule keeps Hebrew literals in the message catalog.
const HEBREW_WORD = String.fromCodePoint(0x05d4, 0x05e7, 0x05d5, 0x05d3);

// `message` is the Hebrew base the server always sends; the panel must not show it in English.
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

function state(lastCheck: ContractCheckResponse): ContractCheckState {
  return {
    staticResult: lastCheck,
    lastCheck,
    stale: false,
    checking: false,
    error: null,
    canCheck: true,
    check: async () => lastCheck,
  } as unknown as ContractCheckState;
}

void describe("ContractCheckPanel", () => {
  void it("renders no Hebrew in the English UI", () => {
    setClientLocale("en");
    const result = {
      ok: false,
      optimizer_resolved: "gepa",
      checks: [
        item({ key: "workspace.run" }),
        item({
          key: "metric.shape",
          status: "failed",
          message: `${HEBREW_WORD} 1: boom`,
          message_code: "contract.metric_error",
          message_params: { index: 1, error: "boom" },
          sample_index: 0,
          detail: "Traceback: boom",
        }),
      ],
      samples: [
        {
          index: 0,
          input_preview: "a review",
          output_preview: "a reply",
          score: 0.5,
          feedback_preview: "close",
          duration_ms: 1200,
        },
      ],
    } as unknown as ContractCheckResponse;

    const html = renderToStaticMarkup(
      <ContractCheckPanel cc={state(result)} guided={false} blockedReason={null} />,
    );

    assert.match(html, /The code matches what the optimizer needs\./);
    assert.match(html, /a review/);
    assert.doesNotMatch(html, HEBREW);
  });

  void it("renders every passing row and each sample's run failure in English", () => {
    setClientLocale("en");
    const error = "KeyError: 'product'";
    const statics = ["workspace.run_signature", "metric.signature", "metric.model"].map((key) =>
      item({ key: key as ContractCheckItem["key"] }),
    );
    const samples = [0, 1, 2].flatMap((index) => [
      item({
        key: "workspace.run",
        status: "failed",
        message: `${HEBREW_WORD} ${index + 1}: ${error}`,
        message_code: "contract.run_error",
        message_params: { index: index + 1, error },
        sample_index: index,
        detail: `Traceback (user code):\n${error}`,
      }),
      item({
        key: "metric.shape",
        status: "skipped",
        message: HEBREW_WORD,
        message_code: "contract.shape.blackbox",
        sample_index: index,
      }),
    ]);
    const result = {
      ok: false,
      optimizer_resolved: "best_of_n",
      metric_shape: "blackbox_side_info",
      checks: [...statics, ...samples],
      samples: [0, 1, 2].map((index) => ({ index, input_preview: `{"review": "r${index}"}` })),
    } as unknown as ContractCheckResponse;

    const html = renderToStaticMarkup(
      <ContractCheckPanel cc={state(result)} guided={false} blockedReason={null} />,
    );

    assert.equal(html.match(/The code matches what the optimizer needs\./g)?.length, 3);
    for (const n of [1, 2, 3]) {
      assert.match(html, new RegExp(`The run code failed on sample ${n}: KeyError: &#x27;product&#x27;`));
    }
    assert.doesNotMatch(html, HEBREW);
  });
});
