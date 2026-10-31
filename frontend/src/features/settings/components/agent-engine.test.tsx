/*
 * node --test cannot load .tsx, so this runs through jiti (agent-engine.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { AgentEngine, CliStatus, LocalStatus } from "@/features/local-runtime";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { AgentEngineSelect, EngineChoice, engineToSave } = await import("./AgentEngineSetting");
const {
  agentEngineOptions,
  loadAgentEngine,
  loadLocalStatus,
  localAgentModel,
  peekAgentEngine,
  peekAgentEngineStored,
  saveAgentEngine,
} = await import("@/features/local-runtime");

const cli = (id: CliStatus["id"], patch: Partial<CliStatus> = {}): CliStatus => ({
  id,
  path: `/usr/local/bin/${id}`,
  version: "2.1.0",
  min_version: "2.0.0",
  version_ok: true,
  logged_in: true,
  login_hint: "Run it in a terminal.",
  rate_limited_until: null,
  models: ["openai/gpt-5"],
  ...patch,
});

const status = (clis: CliStatus[]): LocalStatus => ({
  local_mode: true,
  version: "0.1.0",
  docker: { available: true, error: null },
  sandbox_image: "skynet-sandbox:latest",
  clis,
});

function render(
  local: boolean,
  value: AgentEngine,
  s: LocalStatus | null,
  automatic = false,
): string {
  setClientLocale("en");
  return renderToStaticMarkup(
    <AgentEngineSelect
      local={local}
      status={s}
      value={value}
      automatic={automatic}
      saving={false}
      onChange={() => {}}
    />,
  );
}

void describe("AgentEngineSelect", () => {
  // First in the file: no test has loaded or saved an engine yet.
  void it("an engine not loaded yet is not shown as automatic", () => {
    const realLocal = process.env.APP_LOCAL_MODE;
    process.env.APP_LOCAL_MODE = "1";
    try {
      assert.equal(peekAgentEngineStored(), null);
    } finally {
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });

  void it("hosted builds show OpenRouter with the hosted description and no warning", () => {
    const html = render(false, "openrouter", null);
    // The UI catalog does not load under jiti, so its strings render as their keys.
    assert.match(html, /settings\.agent_engine\.openrouter</);
    assert.match(html, /settings\.agent_engine\.description</);
    assert.doesNotMatch(html, /role="status"/);
  });

  void it("a ready local engine shows the CLI and no warning", () => {
    const html = render(true, "codex", status([cli("codex")]));
    assert.match(html, /subscription\.cli\.codex/);
    assert.match(html, /settings\.agent_engine\.description_local/);
    assert.doesNotMatch(html, /role="status"/);
  });

  void it("an engine the user never saved shows as Automatic, with the engine it runs on", () => {
    const html = render(true, "claude", status([cli("claude"), cli("codex")]), true);
    assert.match(html, /settings\.agent_engine\.automatic/);
    assert.match(html, /data-engine-logo="claude"/);
    assert.doesNotMatch(render(true, "claude", status([cli("claude")])), /agent_engine\.automatic/);
  });

  void it("choosing the shown engine saves it only while it is automatic", () => {
    // Radix Select reports no change for the current value, so automatic uses its own value.
    assert.equal(engineToSave("claude", "claude", true), "claude");
    assert.equal(engineToSave("claude", "claude", false), null);
    assert.equal(engineToSave("codex", "claude", false), "codex");
    assert.equal(engineToSave("automatic", "claude", true), null);
  });

  void it("a signed-out local engine says why, with its sign-in command", () => {
    const html = render(true, "codex", status([cli("codex", { logged_in: false })]));
    assert.match(html, /role="status"/);
    assert.match(html, /subscription\.state\.logged_out/);
    assert.match(html, /<code[^>]*>codex login<\/code>/);
  });
});

// Each engine's mark, by its accessible name.
const BRAND: Record<AgentEngine, RegExp[]> = {
  codex: [/aria-label="Codex"/],
  claude: [/aria-label="Claude Code"/],
  openrouter: [/aria-label="OpenRouter"/],
};

function assertLogo(html: string, engine: AgentEngine) {
  // The logo is decorative: hidden from assistive tech, so the name stays the label.
  assert.match(html, new RegExp(`<span aria-hidden="true" data-engine-logo="${engine}"`));
  for (const brand of BRAND[engine]) assert.match(html, brand);
}

void describe("engine logos", () => {
  void it("the selected value shows the engine's logo next to its name", () => {
    for (const engine of ["codex", "claude"] as const) {
      const html = render(true, engine, status([cli("codex"), cli("claude")]));
      assertLogo(html, engine);
      assert.match(html, new RegExp(`subscription\\.cli\\.${engine}`));
    }
    assertLogo(render(false, "openrouter", null), "openrouter");
  });

  void it("every menu choice shows its logo, also when it is disabled", () => {
    setClientLocale("en");
    const s = status([cli("codex"), cli("claude", { logged_in: false })]);
    const options = agentEngineOptions(s, true);
    assert.deepEqual(
      options.map((o) => o.engine),
      ["codex", "claude", "openrouter"],
    );
    for (const option of options) {
      const html = renderToStaticMarkup(<EngineChoice option={option} status={s} failed={false} />);
      assertLogo(html, option.engine);
      if (option.engine === "claude") {
        assert.equal(option.disabled, true);
        assert.match(html, /subscription\.state\.logged_out/);
        assert.match(html, /<code[^>]*>claude auth login<\/code>/);
      }
    }
  });

  void it("offers no Droid choice, even when an older backend reports it", () => {
    setClientLocale("en");
    const droid = { ...cli("codex"), id: "droid" } as unknown as CliStatus;
    const s = status([cli("codex"), cli("claude"), droid]);
    assert.deepEqual(
      agentEngineOptions(s, true).map((o) => o.engine),
      ["codex", "claude", "openrouter"],
    );
    assert.doesNotMatch(render(true, "codex", s), /droid/i);
  });
});

void describe("saveAgentEngine", () => {
  void it("sends PUT /account/agent-engine and returns the stored engine", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ engine: "codex" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      assert.equal(await saveAgentEngine("codex"), "codex");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/account\/agent-engine$/);
    assert.equal(calls[0]!.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { engine: "codex" });
  });

  void it("throws the backend's refusal so the caller can show it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "models.subscription_local_only" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      await assert.rejects(saveAgentEngine("codex"), (err: unknown) => {
        assert.equal((err as { code?: string }).code, "models.subscription_local_only");
        assert.equal((err as { status?: number }).status, 422);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

void describe("loadAgentEngine", () => {
  void it("an unchosen engine follows the backend when the CLI status refreshes", async () => {
    // The backend's engine with nothing stored is the first ready CLI.
    let backendEngine = "codex";
    const realFetch = globalThis.fetch;
    const realLocal = process.env.APP_LOCAL_MODE;
    process.env.APP_LOCAL_MODE = "1";
    globalThis.fetch = (async (url: string) => {
      const body = String(url).endsWith("/account/agent-engine")
        ? { engine: backendEngine }
        : status([cli("codex"), cli("claude")]);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await loadLocalStatus(true);
      assert.equal(await loadAgentEngine(), "codex");
      // Codex signs out or hits its cap, so the backend now picks Claude.
      backendEngine = "claude";
      await loadLocalStatus(true);
      assert.equal(await loadAgentEngine(), "claude");
      assert.equal(peekAgentEngine(), "claude");
      // A save during a refresh wins over the refresh's older answer.
      let answer: (res: Response) => void = () => {};
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return new Response(JSON.stringify({ engine: "codex" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).endsWith("/account/agent-engine")) {
          return new Promise<Response>((resolve) => (answer = resolve));
        }
        return new Response(JSON.stringify(status([cli("claude"), cli("codex")])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      await loadLocalStatus(true);
      const refreshing = loadAgentEngine();
      assert.equal(await saveAgentEngine("codex"), "codex");
      answer(
        new Response(JSON.stringify({ engine: "claude" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      assert.equal(await refreshing, "codex");
      assert.equal(peekAgentEngine(), "codex");
    } finally {
      globalThis.fetch = realFetch;
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });

  void it("only an engine the backend says is stored counts as saved", async () => {
    let body: Record<string, unknown> = { engine: "claude" };
    const realFetch = globalThis.fetch;
    const realLocal = process.env.APP_LOCAL_MODE;
    process.env.APP_LOCAL_MODE = "1";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const res = !String(url).endsWith("/account/agent-engine")
        ? status([cli("claude"), cli("codex")])
        : init?.method === "PUT"
          ? { engine: "claude" }
          : body;
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      // An older backend sends no `stored` field: the engine is the automatic pick.
      await loadLocalStatus(true);
      assert.equal(await loadAgentEngine(), "claude");
      assert.equal(peekAgentEngineStored(), false);
      body = { engine: "claude", stored: false };
      await loadLocalStatus(true);
      await loadAgentEngine();
      assert.equal(peekAgentEngineStored(), false);
      assert.equal(await saveAgentEngine("claude"), "claude");
      assert.equal(peekAgentEngineStored(), true);
      body = { engine: "claude", stored: true };
      await loadLocalStatus(true);
      await loadAgentEngine();
      assert.equal(peekAgentEngineStored(), true);
    } finally {
      globalThis.fetch = realFetch;
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });

  void it("a saved Droid engine falls back to the default CLI", async () => {
    const realFetch = globalThis.fetch;
    const realLocal = process.env.APP_LOCAL_MODE;
    process.env.APP_LOCAL_MODE = "1";
    globalThis.fetch = (async (url: string) => {
      const body = String(url).endsWith("/account/agent-engine")
        ? { engine: "droid" }
        : status([cli("claude", { logged_in: false }), cli("codex")]);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await loadLocalStatus(true);
      assert.equal(await loadAgentEngine(), null);
      assert.equal(peekAgentEngine(), null);
      // With no engine, every role runs on the first ready CLI.
      assert.match((await localAgentModel(null, null)) ?? "", /^subscription\/codex\//);
    } finally {
      globalThis.fetch = realFetch;
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });

  void it("a failed reload keeps the stored engine, so agent requests keep its CLI", async () => {
    let engineFails = false;
    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    const realLocal = process.env.APP_LOCAL_MODE;
    process.env.APP_LOCAL_MODE = "1";
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/account/agent-engine")) {
        return new Response(
          JSON.stringify(engineFails ? { detail: "boom" } : { engine: "codex" }),
          {
            status: engineFails ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const s = status([
        cli("claude", { models: ["claude-sonnet"] }),
        cli("codex", { models: ["openai/gpt-5"] }),
      ]);
      return new Response(JSON.stringify(s), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await loadLocalStatus(true);
      assert.equal(await loadAgentEngine(), "codex");
      assert.match((await localAgentModel(null, null)) ?? "", /^subscription\/codex\//);
      // The status cache expires, so the next request refreshes it and reloads the engine.
      engineFails = true;
      Date.now = () => realNow() + 60_000;
      assert.match((await localAgentModel(null, null)) ?? "", /^subscription\/codex\//);
      assert.equal(peekAgentEngine(), "codex");
    } finally {
      globalThis.fetch = realFetch;
      Date.now = realNow;
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });
});
