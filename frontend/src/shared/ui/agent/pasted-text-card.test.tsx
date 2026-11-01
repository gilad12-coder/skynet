/*
 * node --test cannot load .tsx, so this runs through jiti (pasted-text-card.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildActiveCatalog } from "@/shared/lib/messages.server";
import { setClientLocale } from "@/shared/lib/runtime-locale";
import { setServerMessages } from "@/shared/lib/runtime-messages";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { PastedTextCard } = await import("./pasted-text-card");

function activateLocale(locale: "en" | "ru"): void {
  setServerMessages(buildActiveCatalog(locale), locale);
  setClientLocale(locale);
}

activateLocale("en");

void describe("PastedTextCard", () => {
  void it("says 1 line for a one-line file", () => {
    const html = renderToStaticMarkup(<PastedTextCard text="hello" name="a.txt" />);
    assert.match(html, />1 line</);
  });

  void it("says the plural for more lines", () => {
    const html = renderToStaticMarkup(<PastedTextCard text={"a\nb\nc"} name="b.txt" />);
    assert.match(html, />3 lines</);
  });

  void it("shows the real count when a plural form is not only 1", () => {
    activateLocale("ru");
    try {
      const html = renderToStaticMarkup(<PastedTextCard text={`${"x\n".repeat(20)}x`} name="c.txt" />);
      assert.match(html, />21 строка</);
    } finally {
      activateLocale("en");
    }
  });
});
