/*
 * node --test cannot load .tsx, so this runs through jiti (local-share-notice.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildActiveCatalog } from "@/shared/lib/messages.server";
import { setServerMessages } from "@/shared/lib/runtime-messages";
import { shareLinkUrl } from "@/shared/lib/share-link";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { LocalShareNotice } = await import("./local-share-notice");

void describe("LocalShareNotice", () => {
  void it("asks for a hosted account and shows no link", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    const html = renderToStaticMarkup(<LocalShareNotice />);
    assert.match(html, /Sign in to a hosted account to share/);
    assert.doesNotMatch(html, /127\.0\.0\.1|localhost|\/share\//);
    assert.doesNotMatch(html, /<a\s|<input/);
  });

  void it("has the Hebrew copy", () => {
    setServerMessages(buildActiveCatalog("he"), "he");
    const html = renderToStaticMarkup(<LocalShareNotice />);
    assert.match(html, /התחבר\/י לחשבון בענן כדי לשתף/);
  });
});

type FakeWindow = { location: { origin: string }; __APP_ENV__?: Record<string, unknown> };

function setWindow(origin: string, env: Record<string, unknown>): void {
  (globalThis as { window?: FakeWindow }).window = { location: { origin }, __APP_ENV__: env };
}

const LOOPBACK = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

void describe("shareLinkUrl", () => {
  afterEach(() => {
    delete (globalThis as { window?: FakeWindow }).window;
  });

  void it("builds the hosted link from the page origin", () => {
    setWindow("https://app.example.com", { apiUrl: "https://api.example.com", appVersion: "1" });
    assert.equal(shareLinkUrl("/share/tok"), "https://app.example.com/share/tok");
  });

  void it("never returns a loopback link in the Mac app", () => {
    setWindow("http://127.0.0.1:51234", {
      apiUrl: "http://127.0.0.1:51235",
      appVersion: "1",
      localMode: true,
    });
    for (const p of ["/share/t", "/datasets/share/t", "/folders/share/t", "/tagger/share/t"]) {
      const url = shareLinkUrl(p);
      assert.equal(url, null);
      assert.doesNotMatch(String(url), LOOPBACK);
    }
  });

  void it("returns no link while rendering on the server", () => {
    assert.equal(shareLinkUrl("/share/t"), null);
  });
});
