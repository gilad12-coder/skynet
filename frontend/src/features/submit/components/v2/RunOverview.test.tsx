/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { ContractCheckState } from "../../hooks/use-contract-check";
import { initialWizardV2State, type WizardV2State } from "../../lib/wizard-v2";

// The model picker this screen reuses imports a stylesheet, which Node cannot load.
registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { RunOverview } = await import("./RunOverview");

const cc: ContractCheckState = {
  staticResult: null,
  staticPending: false,
  lastCheck: null,
  stale: false,
  checking: false,
  error: null,
  timing: null,
  canCheck: true,
  check: async () => null,
};

function render(state: WizardV2State): string {
  setClientLocale("en");
  return renderToStaticMarkup(<RunOverview state={state} cc={cc} guided={false} />);
}

void describe("RunOverview", () => {
  void it("sums up the run in four tabs and opens on General", () => {
    const state = initialWizardV2State("expert");
    state.task.objective = "Classify support tickets";
    const html = render(state);
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.equal(html.match(/role="tab"/g)?.length, 4);
    for (const tab of ["general", "data", "models", "budget"]) {
      assert.match(html, new RegExp(`submit\\.v2\\.overview\\.tab\\.${tab}<`));
    }
    assert.match(html, /aria-selected="true"[^>]*>.*?submit\.v2\.overview\.tab\.general</);
    assert.match(html, /Classify support tickets/);
    // The contract check gates Submit, so it shows on every tab.
    assert.match(html, /submit\.v2\.metric\.check\.needed/);
  });

  void it("drops the data tab for a repository run", () => {
    const state = initialWizardV2State("expert");
    state.task.repo = {
      repository: "acme/agent",
      branch: "main",
      commit: "",
      editablePaths: ["."],
      setupCommand: "",
    };
    const html = render(state);
    assert.equal(html.match(/role="tab"/g)?.length, 3);
    assert.doesNotMatch(html, /submit\.v2\.overview\.tab\.data</);
    assert.match(html, /acme\/agent @ main/);
    assert.match(html, /submit\.v2\.repo\.check_on_submit/);
  });
});
