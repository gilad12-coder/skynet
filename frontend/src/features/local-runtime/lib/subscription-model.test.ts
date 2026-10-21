import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  byokHintKey,
  runEstimateLabelKey,
  usageChargedKey,
  usageCostNoteKey,
  cliState,
  defaultAgentCli,
  hostCliPatch,
  isLocalModelRefusal,
  LOCAL_MODEL_REFUSED_CODE,
  resolveAgentModel,
  parseSubscriptionModelId,
  subscriptionAgentModel,
  subscriptionCatalogModels,
  subscriptionMenuModels,
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
  login_hint: "Run `claude auth login` in a terminal.",
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
    hint: "Run `claude auth login` in a terminal.",
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

test("an agent menu lists only the CLI's models, as the ids the request sends", () => {
  const codex = cli({ id: "codex", models: ["openai/gpt-5"] });
  const models = subscriptionMenuModels(codex, [
    {
      value: "openrouter/openai/gpt-5",
      label: "GPT-5",
      provider: "openai",
      supports_thinking: true,
      supports_vision: true,
      available: true,
    },
    {
      value: "openrouter/google/gemini-3-pro",
      label: "Gemini 3 Pro",
      provider: "google",
      supports_thinking: true,
      supports_vision: true,
      available: true,
    },
  ] as Parameters<typeof subscriptionMenuModels>[1]);
  assert.deepEqual(
    models.map((m) => [m.value, m.label]),
    [["subscription/codex/openai/gpt-5", "GPT-5"]],
  );
  // The pick passes through the request unchanged.
  assert.equal(
    subscriptionAgentModel(models[0]!.value, "codex", status([codex])),
    "subscription/codex/openai/gpt-5",
  );
  assert.deepEqual(subscriptionMenuModels(undefined, []), []);
});

test("a subscription model config names its CLI", () => {
  assert.deepEqual(subscriptionModelConfig("anthropic/claude-sonnet-4.5", "claude"), {
    name: "anthropic/claude-sonnet-4.5",
    token_source: "subscription",
    cli_provider: "claude",
  });
});

test("an agent request waits for the status before it picks the CLI's slug", async () => {
  // Nothing is cached yet: the id comes from the loaded status, not a guess.
  let loads = 0;
  const loaded = await resolveAgentModel(
    "openrouter/anthropic/claude-opus-4.1",
    "claude",
    async () => {
      loads += 1;
      return status([cli()]);
    },
    () => null,
  );
  assert.equal(loaded, "subscription/claude/anthropic/claude-opus-4.1");
  assert.equal(loads, 1);
  assert.equal(
    await resolveAgentModel(
      null,
      "claude",
      async () => status([cli()]),
      () => null,
    ),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
});

test("a failed status request falls back to the last loaded status", async () => {
  const failing = async () => {
    throw new Error("local status 503");
  };
  assert.equal(
    await resolveAgentModel(null, "claude", failing, () => status([cli()])),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  // With no status at all, the composer's slug goes out under the CLI.
  assert.equal(
    await resolveAgentModel("anthropic/claude-opus-4.1", "claude", failing, () => null),
    "subscription/claude/anthropic/claude-opus-4.1",
  );
});

test("a role with no CLI runs on the first ready CLI, never a managed model", async () => {
  const codex = cli({ id: "codex", models: ["openai/gpt-5"] });
  const loaded = status([cli({ logged_in: false }), codex]);
  assert.equal(
    await resolveAgentModel(
      "openrouter/openai/gpt-5",
      null,
      async () => loaded,
      () => null,
    ),
    "subscription/codex/openai/gpt-5",
  );
  // No status at all still goes to a CLI, so the request cannot reach OpenRouter.
  const failing = async () => {
    throw new Error("local status 503");
  };
  assert.equal(
    await resolveAgentModel("anthropic/claude-opus-4.1", null, failing, () => null),
    "subscription/claude/anthropic/claude-opus-4.1",
  );
});

test("a request with no model pick sends the first model of the signed-in CLI", async () => {
  const loaded = status([cli({ id: "codex", logged_in: false }), cli()]);
  assert.equal(
    await resolveAgentModel(
      null,
      null,
      async () => loaded,
      () => null,
    ),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  // A CLI with no models leaves nothing to send; the backend then refuses
  // with the no-model code, which the UI shows as its own message.
  const empty = status([cli({ models: [] })]);
  assert.equal(
    await resolveAgentModel(
      null,
      null,
      async () => empty,
      () => null,
    ),
    null,
  );
  assert.equal(LOCAL_MODEL_REFUSED_CODE, "models.managed_unavailable_local");
  assert.equal(isLocalModelRefusal("models.managed_unavailable_local"), true);
  assert.equal(isLocalModelRefusal("billing.insufficient_funds"), false);
  assert.equal(isLocalModelRefusal(undefined), false);
});

test("the default agent CLI prefers ready, then installed, then Claude Code", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const codex = cli({ id: "codex" });
  const droid = cli({ id: "droid" });
  assert.equal(defaultAgentCli(status([cli({ path: null }), codex]), now), "codex");
  // A ready CLI wins over an installed one listed before it.
  assert.equal(
    defaultAgentCli(status([cli({ path: null }), { ...droid, logged_in: false }, codex]), now),
    "codex",
  );
  assert.equal(
    defaultAgentCli(status([cli({ path: null }), { ...droid, logged_in: false }]), now),
    "droid",
  );
  assert.equal(defaultAgentCli(status([cli({ path: null })]), now), "claude");
  assert.equal(defaultAgentCli(null, now), "claude");
});

test("the proposer host CLI select starts at workspace only and clears on off", () => {
  assert.deepEqual(hostCliPatch("codex", undefined), {
    host_cli: "codex",
    host_permission: "workspace_only",
  });
  assert.deepEqual(hostCliPatch("claude", "full_access"), {
    host_cli: "claude",
    host_permission: "full_access",
  });
  assert.deepEqual(hostCliPatch("off", "full_access"), {
    host_cli: undefined,
    host_permission: undefined,
  });
});

test("the own-key hint names no platform fee in local mode", () => {
  assert.equal(byokHintKey(false), "billing.mode.byok_hint");
  assert.equal(byokHintKey(true), "billing.mode.byok_hint_local");
});

test("the run detail hides the fee estimate in local mode", () => {
  assert.equal(runEstimateLabelKey("byok", false), "submit.summary.estimate_fee");
  assert.equal(runEstimateLabelKey("managed", false), "submit.summary.estimate_cost");
  assert.equal(runEstimateLabelKey(null, false), "submit.summary.estimate_cost");
  assert.equal(runEstimateLabelKey("byok", true), null);
  assert.equal(runEstimateLabelKey("managed", true), null);
  assert.equal(runEstimateLabelKey(null, true), null);
});

test("the usage tab names no Skynet charge in local mode", () => {
  assert.equal(usageChargedKey(false), "usage_tab.charged");
  assert.equal(usageChargedKey(true), "usage_tab.charged_local");
});

test("the local usage note says nothing was billed only for a subscription run", () => {
  const row = (patch: Partial<Parameters<typeof usageCostNoteKey>[1][number]> = {}) => ({
    billing: "skynet",
    charged_cents: 0,
    provider_cents: null,
    calls: 12,
    unpriced_calls: 0,
    ...patch,
  });
  const done = { final: true, pairIndex: null };
  const subscription = [row(), row({ calls: 3 })];
  const ownKey = [row({ billing: "byok", charged_cents: 1, provider_cents: 14 })];
  const mixed = [row(), ...ownKey];
  const credits = [row(), row({ calls: 0, charged_cents: 5 })];
  assert.equal(usageCostNoteKey(true, subscription, done), "usage_tab.subscription_note_local");
  assert.equal(usageCostNoteKey(true, ownKey, done), "usage_tab.api_rates_note_local");
  assert.equal(usageCostNoteKey(true, mixed, done), "usage_tab.api_rates_note_local");
  assert.equal(usageCostNoteKey(true, credits, done), null);
  assert.equal(usageCostNoteKey(true, [row({ billing: "byok", unpriced_calls: 12 })], done), null);
  assert.equal(usageCostNoteKey(true, [row({ calls: 0 })], done), null);
  assert.equal(usageCostNoteKey(true, [], done), null);
  for (const rows of [subscription, ownKey, mixed, credits]) {
    assert.equal(usageCostNoteKey(false, rows, done), null);
  }
});

test("the local subscription note waits for a final whole-run view", () => {
  const row = {
    billing: "skynet",
    charged_cents: 0,
    provider_cents: null,
    calls: 12,
    unpriced_calls: 0,
  };
  assert.equal(usageCostNoteKey(true, [row], { final: false, pairIndex: null }), null);
  assert.equal(usageCostNoteKey(true, [row], { final: true, pairIndex: 0 }), null);
  const ownKey = { ...row, billing: "byok", provider_cents: 14 };
  assert.equal(
    usageCostNoteKey(true, [ownKey], { final: false, pairIndex: 0 }),
    "usage_tab.api_rates_note_local",
  );
});

test("the local English texts name no fee and no Skynet charge", () => {
  const en = JSON.parse(
    readFileSync(new URL("../../../../../i18n/locales/ui/en.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  for (const key of [
    "billing.mode.byok_hint_local",
    "usage_tab.charged_local",
    "tooltip.usage_tab.charged_local",
    "usage_tab.api_rates_note_local",
    "usage_tab.subscription_note_local",
  ]) {
    assert.ok(en[key], key);
    assert.doesNotMatch(en[key], /platform fee|term\.appName|Skynet/, key);
  }
});
