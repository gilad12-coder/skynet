/*
 * node --test cannot load .tsx, so this runs through jiti (local-runtime.render.test.ts
 * spawns it inside `npm run test:unit`). To run it by hand from frontend/:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setClientLocale } from "@/shared/lib/runtime-locale";
import type { CliProvider } from "@/features/billing";
import type { CliStatus, LocalStatus } from "../lib/subscription-model";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { HostCliChoice, SubscriptionSourcePicker, hostCliChoices, hostCliValue } = await import(
  "./SubscriptionSourcePicker"
);
const { MagicWand, Terminal } = await import("@/shared/ui/icons");
const { HostAgentPermissionField } = await import("./HostAgentPermissionField");

// The hints the local backend sends (backend/core/local/cli_probe.py).
const BACKEND_HINTS: Record<CliProvider, string> = {
  codex: "Run `codex login` in a terminal.",
  claude: "Run `claude auth login` in a terminal.",
};

const cli = (id: CliProvider, patch: Partial<CliStatus> = {}): CliStatus => ({
  id,
  path: `/usr/local/bin/${id}`,
  version: "2.1.0",
  min_version: "2.0.0",
  version_ok: true,
  logged_in: true,
  login_hint: BACKEND_HINTS[id],
  rate_limited_until: null,
  models: ["anthropic/claude-sonnet-4.5"],
  ...patch,
});

const status = (clis: CliStatus[]): LocalStatus => ({
  local_mode: true,
  version: "0.1.0",
  docker: { available: true, error: null },
  sandbox_image: "skynet-sandbox:latest",
  clis,
});

function picker(value: CliProvider | null, s: LocalStatus | null, failed = false): string {
  setClientLocale("en");
  return renderToStaticMarkup(
    <SubscriptionSourcePicker
      value={value}
      onChange={() => {}}
      status={s}
      loading={false}
      failed={failed}
      onRefresh={() => {}}
    />,
  );
}

const codeChips = (html: string) =>
  [...html.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);

void describe("SubscriptionSourcePicker", () => {
  void it("shows the login command, not the backend's English sentence", () => {
    for (const id of ["codex", "claude"] as const) {
      const html = picker(id, status([cli(id, { logged_in: false })]));
      const expected = { codex: "codex login", claude: "claude auth login" }[id];
      assert.deepEqual(codeChips(html), [expected]);
      assert.doesNotMatch(html, /in a terminal/);
      // The UI catalog does not load under jiti, so its strings render as their keys.
      assert.match(html, /subscription\.state\.logged_out/);
    }
  });

  void it("shows no command for a signed-in CLI", () => {
    const html = picker("claude", status([cli("claude")]));
    assert.deepEqual(codeChips(html), []);
    assert.match(html, /subscription\.state\.ok_version/);
  });

  void it("disables a CLI that is not installed and warns when the pick is missing", () => {
    const html = picker("codex", status([cli("claude"), cli("codex", { path: null })]));
    assert.match(html, /subscription\.state\.missing/);
    assert.equal(html.match(/disabled=""/g)?.length, 1);
  });

  void it("offers only Codex and Claude Code, even when the backend reports Droid", () => {
    const droid = { ...cli("codex"), id: "droid" } as unknown as CliStatus;
    const html = picker(null, status([cli("codex"), cli("claude"), droid]));
    assert.equal(html.match(/role="radio"/g)?.length, 2);
    assert.match(html, /subscription\.cli\.codex/);
    assert.match(html, /subscription\.cli\.claude/);
    assert.doesNotMatch(html, /droid/i);
  });

  void it("says the status failed to load", () => {
    const html = picker("claude", null, true);
    assert.match(html, /subscription\.state\.failed/);
  });
});

void describe("proposer host CLI picker", () => {
  void it("lists the agent engine default, off, Codex and Claude Code only", () => {
    setClientLocale("en");
    assert.deepEqual(hostCliChoices(), [
      { value: "default", label: "host_agent.cli.default" },
      { value: "off", label: "host_agent.cli.off" },
      { value: "codex", label: "subscription.cli.codex" },
      { value: "claude", label: "subscription.cli.claude" },
    ]);
  });

  void it("shows no pick and a saved Droid choice as the engine default, and null as off", () => {
    assert.equal(hostCliValue("droid"), "default");
    assert.equal(hostCliValue(undefined), "default");
    assert.equal(hostCliValue(null), "off");
    assert.equal(hostCliValue("claude"), "claude");
  });

  void it("shows the default-choice wand on the default, the terminal on each CLI, and none on off", () => {
    const svg = (html: string) => html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
    const wand = svg(renderToStaticMarkup(<MagicWand className="size-4" aria-hidden="true" />));
    const terminal = svg(renderToStaticMarkup(<Terminal className="size-4" aria-hidden="true" />));
    assert.notDeepEqual(wand, terminal);
    const rows = Object.fromEntries(
      hostCliChoices().map(({ value, label }) => [
        value,
        svg(renderToStaticMarkup(<HostCliChoice value={value} label={label} />)),
      ]),
    );
    assert.deepEqual(rows, {
      default: wand,
      off: [],
      codex: terminal,
      claude: terminal,
    });
  });

  void it("labels the default choice as the agent engine in every UI catalog", () => {
    const ui = new URL("../../../../../i18n/locales/ui/", import.meta.url);
    const label = (locale: string) =>
      (JSON.parse(readFileSync(new URL(`${locale}.json`, ui), "utf8")) as Record<string, string>)[
        "host_agent.cli.default"
      ];
    assert.equal(label("en"), "Agent engine (default)");
    // he.json is the base catalog, so the key must be translated there too.
    assert.ok(label("he"));
    assert.notEqual(label("he"), label("en"));
  });
});

void describe("HostAgentPermissionField", () => {
  const field = (value: "workspace_only" | "full_access" | undefined) =>
    renderToStaticMarkup(<HostAgentPermissionField value={value} onChange={() => {}} />);

  void it("defaults to workspace only, with no warning", () => {
    const html = field(undefined);
    assert.match(html, /host_agent\.permission\.workspace_hint/);
    assert.doesNotMatch(html, /role="alert"/);
  });

  void it("always warns on full access", () => {
    const html = field("full_access");
    assert.match(html, /role="alert"[^>]*>.*host_agent\.permission\.full_warning/s);
    assert.doesNotMatch(html, /host_agent\.permission\.workspace_hint/);
  });
});
