/*
 * node --test cannot load .tsx, so this runs through jiti (account-menu.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\",\"react-loading-skeleton/dist/skeleton.css\":\"$PWD/src/features/optimizations/components/__fixtures__/style-stub.ts\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";

import { ApiError } from "@/shared/lib/api";
import { buildActiveCatalog } from "@/shared/lib/messages.server";
import { setServerMessages } from "@/shared/lib/runtime-messages";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { SettingsModalProvider } = await import("@/features/settings");
const { LocaleProvider } = await import("@/shared/providers/locale-provider");
const { AccountMenu, localIdentity, startHostedSignIn } = await import("./account-menu");
const { linkedUsername, loadLinkedAccount } = await import("@/shared/hooks/use-linked-account");
const { TooltipProvider } = await import("@/shared/ui/primitives/tooltip");
const { PrivacyTab } = await import("@/features/settings/components/PrivacyTab");

const session = {
  user: { name: "local@skynet.local", email: "local@skynet.local" },
  expires: "2099-01-01T00:00:00.000Z",
};

function render(node: React.ReactNode = <AccountMenu />): string {
  setServerMessages(buildActiveCatalog("en"), "en");
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <SessionProvider session={session}>
        <SettingsModalProvider>{node}</SettingsModalProvider>
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

  void it("shows a neutral local mode while the link is unknown", () => {
    process.env.APP_LOCAL_MODE = "1";
    // A static render never runs the effect that reads the link, so it stays unknown.
    const html = render();
    assert.doesNotMatch(html, /skynet\.local/);
    assert.match(html, /Local mode/);
    assert.doesNotMatch(html, /Not signed in/);
  });
});

void describe("localIdentity", () => {
  void it("shows the linked account's name and email", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    assert.deepEqual(
      localIdentity({ linked: true, name: "Ada", email: "ada@example.com", offline: false }),
      { name: "Ada", detail: "ada@example.com" },
    );
  });

  void it("falls back to the account label with no name or email", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    const identity = localIdentity({ linked: true, name: null, email: null, offline: false });
    assert.equal(identity.name, "Skynet account");
  });

  void it("marks a linked account offline when hosted does not answer", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    assert.deepEqual(
      localIdentity({ linked: true, name: "Ada", email: "ada@example.com", offline: true }),
      { name: "Ada", detail: "Linked (offline)" },
    );
  });

  void it("says not signed in only when the Mac is not linked", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    assert.deepEqual(localIdentity({ linked: false }), {
      name: "Local mode",
      detail: "Not signed in",
    });
    assert.deepEqual(localIdentity(undefined), { name: "Local mode", detail: null });
  });
});

void describe("startHostedSignIn", () => {
  void it("starts the link, then opens the consent page", async () => {
    const calls: string[] = [];
    await startHostedSignIn(
      async () => {
        calls.push("start");
        return { authorize_url: "https://example.com/consent" };
      },
      (url) => calls.push(`open ${url}`),
      () => calls.push("fail"),
    );
    assert.deepEqual(calls, ["start", "open https://example.com/consent"]);
  });

  void it("reports a failed start and opens nothing", async () => {
    const calls: string[] = [];
    await startHostedSignIn(
      async () => {
        throw new ApiError("down", { status: 503 });
      },
      (url) => calls.push(`open ${url}`),
      () => calls.push("fail"),
    );
    assert.deepEqual(calls, ["fail"]);
  });
});

void describe("settings in local mode", () => {
  afterEach(() => {
    delete process.env.APP_LOCAL_MODE;
  });

  void it("shows the linked account as the username", () => {
    setServerMessages(buildActiveCatalog("en"), "en");
    assert.equal(
      linkedUsername({ linked: true, name: "Ada", email: "ada@example.com", offline: false }),
      "ada@example.com",
    );
    assert.equal(
      linkedUsername({ linked: true, name: null, email: null, offline: true }),
      "Skynet account",
    );
    assert.equal(linkedUsername({ linked: false }), "");
    assert.equal(linkedUsername(undefined), "Local mode");
  });

  void it("hides the placeholder username and email from the privacy tab", () => {
    assert.match(
      render(
        <TooltipProvider>
          <PrivacyTab />
        </TooltipProvider>,
      ),
      /local@skynet\.local/,
    );
    process.env.APP_LOCAL_MODE = "1";
    assert.doesNotMatch(
      render(
        <TooltipProvider>
          <PrivacyTab />
        </TooltipProvider>,
      ),
      /skynet\.local/,
    );
  });
});

void describe("loadLinkedAccount", () => {
  const store = new Map<string, string>();
  // The menu tests above need `window` unset: runtime-env reads the server env then.
  before(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    };
  });
  after(() => {
    delete (globalThis as { window?: unknown }).window;
  });
  const linked = async () => ({ linked: true, account_email: "ada@example.com" });
  const unreachable = async (): Promise<never> => {
    throw new ApiError("down", { status: 503 });
  };

  void it("reads the name and email from hosted whoami", async () => {
    store.clear();
    const account = await loadLinkedAccount({
      status: linked,
      whoami: async () => ({ name: "Ada", email: "ada@example.com" }),
    });
    assert.deepEqual(account, {
      linked: true,
      name: "Ada",
      email: "ada@example.com",
      offline: false,
    });
  });

  void it("keeps the last known identity, marked offline, when hosted is down", async () => {
    store.clear();
    await loadLinkedAccount({
      status: linked,
      whoami: async () => ({ name: "Ada", email: "ada@example.com" }),
    });
    // Run past the whoami cache, so hosted is asked again.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      const account = await loadLinkedAccount({ status: linked, whoami: unreachable });
      assert.deepEqual(account, {
        linked: true,
        name: "Ada",
        email: "ada@example.com",
        offline: true,
      });
    } finally {
      Date.now = realNow;
    }
  });

  void it("falls back to the email saved at link time with no cache", async () => {
    store.clear();
    const account = await loadLinkedAccount({ status: linked, whoami: unreachable });
    assert.deepEqual(account, {
      linked: true,
      name: null,
      email: "ada@example.com",
      offline: true,
    });
  });

  void it("treats a revoked link as not linked", async () => {
    store.clear();
    const account = await loadLinkedAccount({
      status: linked,
      whoami: async () => {
        throw new ApiError("revoked", { status: 401 });
      },
    });
    assert.deepEqual(account, { linked: false });
    assert.equal(store.size, 0);
  });

  void it("reports not linked without asking hosted", async () => {
    const account = await loadLinkedAccount({
      status: async () => ({ linked: false }),
      whoami: unreachable,
    });
    assert.deepEqual(account, { linked: false });
  });
});
