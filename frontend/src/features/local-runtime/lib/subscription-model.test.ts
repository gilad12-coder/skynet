import assert from "node:assert/strict";
import test from "node:test";

const {
  cliState,
  parseSubscriptionModelId,
  subscriptionAgentModel,
  subscriptionCatalogModels,
  subscriptionModelConfig,
  subscriptionModelId,
} = await import("./subscription-model.ts");

type Status = Parameters<typeof subscriptionAgentModel>[2] & object;
type Cli = Status["clis"][number];

const cli = (patch: Partial<Cli> = {}): Cli => ({
  id: "claude",
  path: "/usr/local/bin/claude",
  version: "2.1.0",
  min_version: "2.0.0",
  version_ok: true,
  logged_in: true,
  login_hint: "claude /login",
  rate_limited_until: null,
  models: ["anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4.1"],
  ...patch,
});

const status = (clis: Cli[]): Status => ({
  local_mode: true,
  version: "0.1.0",
  docker: { available: true, error: null },
  sandbox_image: "skynet-sandbox:latest",
  clis,
});

test("each CLI state wins in order: missing, old, signed out, capped, ready", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  assert.deepEqual(cliState(cli({ path: null, version_ok: false }), now), { kind: "missing" });
  assert.deepEqual(cliState(cli({ version: "1.0.0", version_ok: false }), now), {
    kind: "old",
    version: "1.0.0",
    minVersion: "2.0.0",
  });
  assert.deepEqual(cliState(cli({ logged_in: false }), now), {
    kind: "logged_out",
    hint: "claude /login",
  });
  const capped = cliState(cli({ rate_limited_until: "2026-10-21T12:00:00Z" }), now);
  assert.equal(capped.kind, "capped");
  // A cap whose reset time has passed no longer blocks the CLI.
  assert.deepEqual(cliState(cli({ rate_limited_until: "2026-10-21T09:00:00Z" }), now), {
    kind: "ok",
  });
  assert.deepEqual(cliState(cli({ logged_in: null }), now), { kind: "ok" });
});

test("the shorthand round-trips and rejects unknown CLIs", () => {
  const id = subscriptionModelId("codex", "openai/gpt-5");
  assert.equal(id, "subscription/codex/openai/gpt-5");
  assert.deepEqual(parseSubscriptionModelId(id), { cli: "codex", slug: "openai/gpt-5" });
  assert.equal(parseSubscriptionModelId("subscription/other/x"), null);
  assert.equal(parseSubscriptionModelId("openai/gpt-5"), null);
  assert.equal(parseSubscriptionModelId("subscription/codex/"), null);
});

test("an agent role on a CLI sends the CLI's own slug for the composer's model", () => {
  const s = status([cli()]);
  assert.equal(
    subscriptionAgentModel("openrouter/anthropic/claude-opus-4.1", "claude", s),
    "subscription/claude/anthropic/claude-opus-4.1",
  );
  // A model the CLI cannot run, or no pick, falls back to the CLI's first model.
  assert.equal(
    subscriptionAgentModel("openai/gpt-5", "claude", s),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  assert.equal(
    subscriptionAgentModel(null, "claude", s),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  // A role left off keeps the composer's choice unchanged.
  assert.equal(subscriptionAgentModel("openai/gpt-5", null, s), "openai/gpt-5");
  // Before the status loads, the composer's slug is sent on the chosen CLI.
  assert.equal(
    subscriptionAgentModel("openai/gpt-5", "codex", null),
    "subscription/codex/openai/gpt-5",
  );
});

test("the picker lists the CLI's slugs, enriched from the catalog when it knows them", () => {
  const models = subscriptionCatalogModels(cli(), [
    {
      value: "openrouter/anthropic/claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      provider: "anthropic",
      supports_thinking: true,
      supports_vision: true,
      available: false,
    },
  ] as Parameters<typeof subscriptionCatalogModels>[1]);
  assert.deepEqual(
    models.map((m) => [m.value, m.label, m.available]),
    [
      ["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", true],
      ["anthropic/claude-opus-4.1", "claude-opus-4.1", true],
    ],
  );
  assert.deepEqual(subscriptionCatalogModels(undefined, []), []);
});

test("a subscription model config names its CLI", () => {
  assert.deepEqual(subscriptionModelConfig("anthropic/claude-sonnet-4.5", "claude"), {
    name: "anthropic/claude-sonnet-4.5",
    token_source: "subscription",
    cli_provider: "claude",
  });
});
