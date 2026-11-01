/*
 * node --test cannot load .tsx, so this runs through jiti (account-menu.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";

import { buildActiveCatalog } from "@/shared/lib/messages.server";
import { setServerMessages } from "@/shared/lib/runtime-messages";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { SettingsModalProvider } = await import("@/features/settings");
const { LocaleProvider } = await import("@/shared/providers/locale-provider");
const { AccountMenu } = await import("./account-menu");

const session = {
  user: { name: "local@skynet.local", email: "local@skynet.local" },
  expires: "2099-01-01T00:00:00.000Z",
};

function render(): string {
  setServerMessages(buildActiveCatalog("en"), "en");
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <SessionProvider session={session}>
        <SettingsModalProvider>
          <AccountMenu />
        </SettingsModalProvider>
      </SessionProvider>
    </LocaleProvider>,
  );
}

void describe("AccountMenu", () => {
  afterEach(() => {
    delete process.env.APP_LOCAL_MODE;
  });

  void it("shows the session account on hosted deployments", () => {
    const html = render();
    assert.match(html, /local@skynet\.local/);
  });

  void it("shows this Mac, not the placeholder local user, in local mode", () => {
    process.env.APP_LOCAL_MODE = "1";
    const html = render();
    assert.doesNotMatch(html, /skynet\.local/);
    assert.match(html, /This Mac/);
    assert.match(html, /Not signed in/);
  });
});
