/*
 * node --test cannot load .tsx, so this runs through jiti (InputsColumnsCard.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { InputsInferenceState } from "../../hooks/use-inputs-inference";
import { initialWizardV2State } from "../../lib/wizard-v2";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { InputsColumnsCard } = await import("./InputsColumnsCard");

const REFUSAL =
  "The Mac app cannot use managed models. Pick a subscription model or your own provider key.";

function render(inferErrorMessage: string | null): string {
  setClientLocale("en");
  const inference = {
    rows: [],
    loading: false,
    inferring: false,
    inferError: true,
    inferErrorMessage,
    inference: null,
    heldOut: { train: 0, val: 0, test: 0 },
    roles: {},
    setColumnRole: () => {},
    reinfer: () => {},
  } as unknown as InputsInferenceState;
  return renderToStaticMarkup(
    <InputsColumnsCard
      inputs={initialWizardV2State("expert").inputs}
      inference={inference}
      patchInputs={() => {}}
      issue={null}
      guided={false}
    />,
  );
}

void describe("InputsColumnsCard", () => {
  void it("shows the local no-model refusal in place of the generic inference error", () => {
    const html = render(REFUSAL);
    assert.match(html, /role="alert"[^>]*>The Mac app cannot use managed models\./);
    assert.doesNotMatch(html, /submit\.v2\.inputs\.confirm\.infer_error/);
  });

  void it("keeps the generic inference error for any other failure", () => {
    const html = render(null);
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.match(html, /role="alert"[^>]*>submit\.v2\.inputs\.confirm\.infer_error</);
  });
});
