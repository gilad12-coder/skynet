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
const { AgentEngineSelect } = await import("./AgentEngineSetting");
const { loadAgentEngine, loadLocalStatus, peekAgentEngine, saveAgentEngine } = await import(
  "@/features/local-runtime"
);

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

function render(local: boolean, value: AgentEngine, s: LocalStatus | null): string {
  setClientLocale("en");
  return renderToStaticMarkup(
    <AgentEngineSelect local={local} status={s} value={value} saving={false} onChange={() => {}} />,
  );
}

void describe("AgentEngineSelect", () => {
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

  void it("a signed-out local engine says why, with its sign-in command", () => {
    const html = render(true, "codex", status([cli("codex", { logged_in: false })]));
    assert.match(html, /role="status"/);
    assert.match(html, /subscription\.state\.logged_out/);
    assert.match(html, /<code[^>]*>codex login<\/code>/);
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
          return new Response(JSON.stringify({ engine: "droid" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).endsWith("/account/agent-engine")) {
          return new Promise<Response>((resolve) => (answer = resolve));
        }
        return new Response(JSON.stringify(status([cli("claude"), cli("droid")])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      await loadLocalStatus(true);
      const refreshing = loadAgentEngine();
      assert.equal(await saveAgentEngine("droid"), "droid");
      answer(
        new Response(JSON.stringify({ engine: "claude" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      assert.equal(await refreshing, "droid");
      assert.equal(peekAgentEngine(), "droid");
    } finally {
      globalThis.fetch = realFetch;
      if (realLocal === undefined) delete process.env.APP_LOCAL_MODE;
      else process.env.APP_LOCAL_MODE = realLocal;
    }
  });
});
