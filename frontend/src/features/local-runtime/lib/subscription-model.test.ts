import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  CLI_PROVIDERS,
  agentEngineOptions,
  byokHintKey,
  runEstimateLabelKey,
  usageChargedKey,
  usageCostNoteKey,
  cliState,
  defaultAgentCli,
  findCli,
  hostCliPatch,
  isAgentEngine,
  isCliProvider,
  isLocalModelRefusal,
  keyMenuModels,
  KEY_RETRY_MAX_MS,
  keyRetryDelayMs,
  localKeyRows,
  localKeyStamp,
  localMenuModels,
  LOCAL_MODEL_REFUSED_CODE,
  menuKeyVerified,
  requestKeyRows,
  isOpenRouterModelId,
  resolveAgentModel,
  resolveLocalAgentModel,
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
  assert.equal(defaultAgentCli(status([cli({ path: null }), codex]), null, now), "codex");
  // A ready CLI wins over an installed one listed before it.
  assert.equal(
    defaultAgentCli(status([{ ...codex, logged_in: false }, cli()]), null, now),
    "claude",
  );
  assert.equal(
    defaultAgentCli(status([cli({ path: null }), { ...codex, logged_in: false }]), null, now),
    "codex",
  );
  assert.equal(defaultAgentCli(status([cli({ path: null })]), null, now), "claude");
  assert.equal(defaultAgentCli(null, null, now), "claude");
});

test("a CLI agent engine is the default CLI for every role, even when not ready", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const ready = status([cli(), cli({ id: "codex", logged_in: false })]);
  assert.equal(defaultAgentCli(ready, "codex", now), "codex");
  assert.equal(defaultAgentCli(null, "codex", now), "codex");
  // A saved Droid engine is no longer a choice, so the CLI default stays.
  assert.equal(defaultAgentCli(ready, "droid" as never, now), "claude");
  assert.equal(isAgentEngine("droid"), false);
  // OpenRouter cannot run local agents, so the CLI default stays.
  assert.equal(defaultAgentCli(ready, "openrouter", now), "claude");
  assert.equal(isAgentEngine("codex"), true);
  assert.equal(isAgentEngine("openrouter"), true);
  assert.equal(isAgentEngine("gemini"), false);
  assert.equal(isAgentEngine(null), false);
});

test("the engine filters the agent menu to that CLI's models", () => {
  const codex = cli({ id: "codex", models: ["openai/gpt-5"] });
  const loaded = status([cli(), codex]);
  const menu = subscriptionMenuModels(findCli(loaded, defaultAgentCli(loaded, "codex")), []);
  assert.deepEqual(
    menu.map((m) => m.value),
    ["subscription/codex/openai/gpt-5"],
  );
});

test("a role with no CLI runs on the engine; a role's own CLI overrides it", async () => {
  const loaded = status([cli(), cli({ id: "codex", models: ["openai/gpt-5"] })]);
  const load = async () => loaded;
  assert.equal(
    await resolveAgentModel(null, null, load, () => null, "codex"),
    "subscription/codex/openai/gpt-5",
  );
  assert.equal(
    await resolveAgentModel(null, "claude", load, () => null, "codex"),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  // No engine keeps the first ready CLI.
  assert.equal(
    await resolveAgentModel(null, null, load, () => null, null),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
});

test("hosted builds offer only OpenRouter; local builds offer ready CLIs", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  assert.deepEqual(agentEngineOptions(null, false, now), [
    { engine: "openrouter", disabled: false },
  ]);
  const loaded = status([cli({ id: "codex" }), cli({ logged_in: false })]);
  const local = agentEngineOptions(loaded, true, now);
  assert.deepEqual(
    local.map((o) => [o.engine, o.disabled]),
    [
      ["codex", false],
      ["claude", true],
      ["openrouter", true],
    ],
  );
  const state = (engine: string) => {
    const option = local.find((o) => o.engine === engine);
    return option && "state" in option ? option.state : undefined;
  };
  assert.deepEqual(state("claude"), {
    kind: "logged_out",
    hint: "Run `claude auth login` in a terminal.",
  });
  // While the status loads, every CLI waits and none can be picked.
  for (const option of agentEngineOptions(null, true, now)) {
    assert.equal(option.disabled, true);
    if ("state" in option) assert.equal(option.state, null);
  }
});

test("Droid is not a CLI choice, even when an older backend still reports it", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  assert.deepEqual(CLI_PROVIDERS, ["codex", "claude"]);
  assert.equal(isCliProvider("droid"), false);
  const droid = { ...cli(), id: "droid" } as unknown as Cli;
  assert.equal(defaultAgentCli(status([droid]), null, now), "claude");
  assert.equal(
    defaultAgentCli(status([droid, cli({ id: "codex", logged_in: false })]), null, now),
    "codex",
  );
  assert.equal(parseSubscriptionModelId("subscription/droid/anthropic/claude-sonnet-4.5"), null);
  assert.deepEqual(hostCliPatch("droid", "full_access"), {
    host_cli: undefined,
    host_permission: undefined,
  });
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

test("a final subscription run with an API-rate amount gets the API-rates subscription note", () => {
  const row = {
    billing: "subscription",
    charged_cents: 0,
    provider_cents: null,
    api_rate_cents: 3.2,
    calls: 12,
    unpriced_calls: 0,
  };
  const done = { final: true, pairIndex: null };
  assert.equal(usageCostNoteKey(true, [row], done), "usage_tab.subscription_api_rates_note_local");
  // A row without calls needs no price.
  assert.equal(
    usageCostNoteKey(true, [row, { ...row, api_rate_cents: null, calls: 0 }], done),
    "usage_tab.subscription_api_rates_note_local",
  );
  assert.equal(
    usageCostNoteKey(true, [{ ...row, api_rate_cents: null }], done),
    "usage_tab.subscription_note_local",
  );
  assert.equal(usageCostNoteKey(true, [row], { final: false, pairIndex: null }), null);
  assert.equal(usageCostNoteKey(true, [row], { final: true, pairIndex: 1 }), null);
  assert.equal(usageCostNoteKey(false, [row], done), null);
});

test("a subscription run with an unpriced model shows no partial API-rate amount", () => {
  const priced = {
    billing: "subscription",
    charged_cents: 0,
    provider_cents: null,
    api_rate_cents: 3.2,
    calls: 12,
    unpriced_calls: 0,
  };
  const unpriced = { ...priced, api_rate_cents: null, calls: 4 };
  const done = { final: true, pairIndex: null };
  assert.equal(
    usageCostNoteKey(true, [priced, unpriced], done),
    "usage_tab.subscription_note_local",
  );
  assert.equal(
    usageCostNoteKey(true, [unpriced, priced], done),
    "usage_tab.subscription_note_local",
  );
});

test("the API-rate texts say list rates without cache discounts", () => {
  const ui = (locale: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../../../../i18n/locales/ui/${locale}.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
  const en = ui("en");
  assert.match(
    en["usage_tab.subscription_api_rates_note_local"]!,
    /list API rates, without cache discounts/,
  );
  assert.match(en["tooltip.usage_tab.api_rate"]!, /list API rates, without cache discounts/);
  const he = ui("he");
  assert.match(he["usage_tab.subscription_api_rates_note_local"]!, /ללא הנחות מטמון/);
  assert.match(he["tooltip.usage_tab.api_rate"]!, /ללא הנחות מטמון/);
  assert.equal("subscription.cli.droid" in en, false);
  assert.equal("subscription.cli.droid" in he, false);
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
    "usage_tab.subscription_api_rates_note_local",
    "usage_tab.api_rate",
    "tooltip.usage_tab.api_rate",
    "settings.keys.description_local",
  ]) {
    assert.ok(en[key], key);
    assert.doesNotMatch(en[key], /platform fee|term\.appName|Skynet/, key);
  }
});

type Catalog = NonNullable<Parameters<typeof keyMenuModels>[0]>;
type CatalogRow = Catalog[number];

const keyRow = (value: string, patch: Partial<CatalogRow> = {}): CatalogRow => ({
  value,
  label: value.split("/").slice(1).join("/"),
  provider: "openrouter",
  byok_provider: "openrouter",
  supports_thinking: false,
  supports_vision: false,
  available: true,
  ...patch,
});

test("the key's menu rows are its OpenRouter models, featured first, else capped", () => {
  const catalog: Catalog = [
    keyRow("openrouter/anthropic/claude-sonnet-4.5"),
    keyRow("openrouter/openai/gpt-5-mini"),
    keyRow("openai/gpt-5", { byok_provider: "openai", provider: "openai" }),
    keyRow("openrouter/x/withdrawn", { available: false }),
  ];
  assert.deepEqual(
    keyMenuModels(catalog).map((m) => m.value),
    ["openrouter/anthropic/claude-sonnet-4.5", "openrouter/openai/gpt-5-mini"],
  );
  const featured = [...catalog, keyRow("openrouter/google/gemini-3-pro", { featured: true })];
  assert.deepEqual(
    keyMenuModels(featured).map((m) => m.value),
    ["openrouter/google/gemini-3-pro"],
  );
  const many = Array.from({ length: 80 }, (_, i) => keyRow(`openrouter/lab/model-${i}`));
  assert.equal(keyMenuModels(many).length, 50);
  assert.deepEqual(keyMenuModels(undefined), []);
});

test("the local menu lists the CLI's models, then the key's, and waits only when it must", () => {
  const codex = cli({ id: "codex", models: ["openai/gpt-5"] });
  const cliRows = subscriptionMenuModels(codex, [
    keyRow("openrouter/openai/gpt-5", { byok_provider: "openrouter" }),
  ]);
  // A catalog hit must not mark the CLI row as an own-key row.
  assert.equal(cliRows[0]!.byok_provider, null);
  const keyRows = [keyRow("openrouter/anthropic/claude-sonnet-4.5")];
  const cliPick = "subscription/codex/openai/gpt-5";
  const keyPick = "openrouter/anthropic/claude-sonnet-4.5";
  assert.deepEqual(
    localMenuModels(cliRows, keyRows, null).map((m) => m.value),
    [cliPick, keyPick],
  );
  // No key: exactly the SKY-115 menu.
  assert.deepEqual(localMenuModels(cliRows, [], cliPick), cliRows);
  // Status not loaded (or failed): no rows, so key rows alone never make a
  // saved CLI pick look stale.
  assert.deepEqual(localMenuModels(null, keyRows, cliPick), []);
  assert.deepEqual(localMenuModels(null, keyRows, null), []);
  // Key models still loading: a saved key pick waits; a CLI pick or no pick
  // shows the CLI rows at once.
  assert.deepEqual(localMenuModels(cliRows, null, keyPick), []);
  assert.deepEqual(localMenuModels(cliRows, null, cliPick), cliRows);
  assert.deepEqual(localMenuModels(cliRows, null, null), cliRows);
});

test("a saved key pick the key lists stays in the menu when the shortlist leaves it out", () => {
  const pick = "openrouter/anthropic/claude-opus-4.7";
  const catalog: Catalog = [
    keyRow("openrouter/anthropic/claude-opus-4.8", { featured: true }),
    keyRow(pick),
  ];
  assert.deepEqual(
    keyMenuModels(catalog, pick).map((m) => m.value),
    ["openrouter/anthropic/claude-opus-4.8", pick],
  );
  // Past the 50-row cap of a listing with no featured rows.
  const many = Array.from({ length: 80 }, (_, i) => keyRow(`openrouter/lab/model-${i}`));
  const late = "openrouter/lab/model-70";
  const rows = keyMenuModels(many, late);
  assert.equal(rows.length, 51);
  assert.equal(rows.at(-1)!.value, late);
  // A pick already in the shortlist is not listed twice.
  assert.equal(keyMenuModels(many, "openrouter/lab/model-3").length, 50);
  // A pick the key no longer lists gets no row, so the menu can judge it stale.
  assert.deepEqual(
    keyMenuModels(catalog, "openrouter/x/gone").map((m) => m.value),
    ["openrouter/anthropic/claude-opus-4.8"],
  );
});

test("a failed key list or key model list keeps the key rows unknown, so a saved pick survives", () => {
  const cliRows = [
    keyRow("subscription/claude/anthropic/claude-sonnet-4.6", { byok_provider: null }),
  ];
  const pick = "openrouter/anthropic/claude-opus-4.7";
  const rows = [keyRow(pick), keyRow("openrouter/x/other", { byok_provider: "openai" })];
  const base = {
    keysLoading: false,
    keysFailed: false,
    stamp: "k1:t1",
    loaded: null,
    cached: null,
  };
  // The composer clears a pick when a non-empty list omits it.
  const stale = (listed: CatalogRow[]) =>
    listed.length > 0 && !listed.some((m) => m.value === pick);
  const menu = (state: Parameters<typeof localKeyRows>[0]) => {
    const keyRows = localKeyRows(state);
    return localMenuModels(cliRows, keyRows && keyMenuModels(keyRows, pick), pick);
  };

  // GET /billing/byok/keys failed: the provider has no keys, but that is not "no key".
  const keysFailed = { ...base, keysFailed: true, stamp: null };
  assert.equal(localKeyRows(keysFailed), null);
  assert.equal(stale(menu(keysFailed)), false);
  // GET /billing/byok/models failed for a verified key, with no earlier catalog.
  const modelsFailed = { ...base, loaded: { stamp: "k1:t1", models: null } };
  assert.equal(localKeyRows(modelsFailed), null);
  assert.equal(stale(menu(modelsFailed)), false);
  // Still loading: unknown too.
  assert.equal(localKeyRows({ ...base, keysLoading: true }), null);
  assert.equal(localKeyRows(base), null);

  // A later successful load lists the key's models and keeps the pick.
  const loaded = { ...base, loaded: { stamp: "k1:t1", models: rows } };
  assert.deepEqual(localKeyRows(loaded), [rows[0]]);
  assert.equal(stale(menu(loaded)), false);
  // A load for an older key does not count; the cached catalog stands in.
  assert.deepEqual(
    localKeyRows({ ...base, loaded: { stamp: "k0:t0", models: [] }, cached: rows }),
    [rows[0]],
  );
  // Both lists loaded and the key no longer lists the pick: stale, so it clears.
  const gone = { ...base, loaded: { stamp: "k1:t1", models: [keyRow("openrouter/x/other")] } };
  assert.equal(stale(menu(gone)), true);
  // No verified key, with a key list that loaded: no key rows.
  assert.deepEqual(localKeyRows({ ...base, stamp: null }), []);
});

test("failed key loads retry with a growing, capped delay", () => {
  assert.equal(keyRetryDelayMs(0), 2_000);
  assert.equal(keyRetryDelayMs(1), 4_000);
  assert.ok(keyRetryDelayMs(2) > keyRetryDelayMs(1));
  assert.equal(keyRetryDelayMs(50), KEY_RETRY_MAX_MS);
});

test("only openrouter/<vendor>/<model> ids count as key picks", () => {
  assert.equal(isOpenRouterModelId("openrouter/google/gemini-3-pro"), true);
  assert.equal(isOpenRouterModelId("openrouter/google/"), false);
  assert.equal(isOpenRouterModelId("openrouter/auto"), false);
  assert.equal(isOpenRouterModelId("anthropic/claude-sonnet-4.5"), false);
  assert.equal(isOpenRouterModelId("subscription/claude/anthropic/claude-sonnet-4.5"), false);
  assert.equal(isOpenRouterModelId(null), false);
});

const localDeps = (
  overrides: Partial<Parameters<typeof resolveLocalAgentModel>[2]> = {},
): Parameters<typeof resolveLocalAgentModel>[2] & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    loadStatus: async () => {
      calls.push("status");
      return status([cli()]);
    },
    peekStatus: () => null,
    keyVerified: async () => {
      calls.push("keys");
      return true;
    },
    keyRows: () => {
      calls.push("catalog");
      return [];
    },
    ...overrides,
  };
};

test("a key pick goes unchanged, even when the key's model list is empty", async () => {
  const pick = "openrouter/google/gemini-3-pro";
  const deps = localDeps();
  assert.equal(await resolveLocalAgentModel(pick, "claude", deps), pick);
  assert.deepEqual(deps.calls, ["keys"]);
  // Key state unknown: still unchanged, so the backend decides visibly.
  assert.equal(
    await resolveLocalAgentModel(pick, "claude", localDeps({ keyVerified: async () => null })),
    pick,
  );
  // Known to have no verified key: the SKY-115 CLI route.
  assert.equal(
    await resolveLocalAgentModel(
      "openrouter/anthropic/claude-opus-4.1",
      "claude",
      localDeps({ keyVerified: async () => false }),
    ),
    "subscription/claude/anthropic/claude-opus-4.1",
  );
});

test("a subscription pick waits for no key or model list", async () => {
  const deps = localDeps({
    keyVerified: () => new Promise<boolean | null>(() => {}),
    keyRows: () => {
      throw new Error("a subscription pick reads no key rows");
    },
  });
  const pick = "subscription/claude/anthropic/claude-opus-4.1";
  assert.equal(await resolveLocalAgentModel(pick, "claude", deps), pick);
  assert.deepEqual(deps.calls, ["status"]);
});

test("no pick sends the model the chip shows", async () => {
  // A CLI with models: its first model, and no key lookups.
  const deps = localDeps();
  assert.equal(
    await resolveLocalAgentModel(null, "claude", deps),
    "subscription/claude/anthropic/claude-sonnet-4.5",
  );
  assert.deepEqual(deps.calls, ["status"]);
  // No CLI model: the chip shows the key's first menu row.
  const noCli = {
    loadStatus: async () => status([cli({ path: null, models: [] })]),
    keyRows: () => [
      keyRow("openrouter/google/gemini-3-pro"),
      keyRow("openrouter/openai/gpt-5-mini"),
    ],
  };
  assert.equal(
    await resolveLocalAgentModel(null, "claude", localDeps(noCli)),
    "openrouter/google/gemini-3-pro",
  );
  // No CLI model and no verified key: the chip shows "Default"; nothing is sent.
  assert.equal(
    await resolveLocalAgentModel(
      null,
      "claude",
      localDeps({ ...noCli, keyVerified: async () => false }),
    ),
    null,
  );
  // Status failed with nothing cached: the menu is empty; nothing is sent.
  assert.equal(
    await resolveLocalAgentModel(
      null,
      "claude",
      localDeps({ loadStatus: () => Promise.reject(new Error("down")) }),
    ),
    null,
  );
});

test("no pick sends nothing while the menu's key list loads or failed, as the chip shows", async () => {
  const verifiedKey = { provider: "openrouter", status: "verified" };
  const noCli = {
    loadStatus: async () => status([cli({ path: null, models: [] })]),
    keyRows: () => [keyRow("openrouter/google/gemini-3-pro")],
  };
  const unknown = [
    { loading: true, failed: false, keys: [] },
    { loading: false, failed: true, keys: [] },
    // A save keeps the list failed: the menu still has no key rows.
    { loading: false, failed: true, keys: [verifiedKey] },
    // No provider state yet.
    null,
  ];
  for (const keys of unknown) {
    // The menu has no key rows and no CLI rows: the chip shows "Default".
    const keyRows = localKeyRows({
      keysLoading: keys?.loading ?? true,
      keysFailed: keys?.failed ?? false,
      stamp: "k1:t1",
      loaded: null,
      cached: null,
    });
    assert.deepEqual(localMenuModels([], keyRows, null), []);
    assert.equal(menuKeyVerified(keys), null);
    assert.equal(
      await resolveLocalAgentModel(
        null,
        "claude",
        localDeps({ ...noCli, keyVerified: async () => menuKeyVerified(keys) }),
      ),
      null,
    );
  }
  // A loaded list decides from the same keys the menu shows.
  assert.equal(menuKeyVerified({ loading: false, failed: false, keys: [verifiedKey] }), true);
  assert.equal(
    menuKeyVerified({
      loading: false,
      failed: false,
      keys: [
        { provider: "openrouter", status: "invalid" },
        { provider: "openai", status: "verified" },
      ],
    }),
    false,
  );
  assert.equal(
    await resolveLocalAgentModel(
      null,
      "claude",
      localDeps({
        ...noCli,
        keyVerified: async () =>
          menuKeyVerified({ loading: false, failed: false, keys: [verifiedKey] }),
      }),
    ),
    "openrouter/google/gemini-3-pro",
  );
});

test("no pick sends nothing while the key's model list loads or failed, as the chip shows", async () => {
  const key = { id: "k1", provider: "openrouter", status: "verified", addedAt: "t1" };
  const keys = { loading: false, failed: false, keys: [key] };
  const stamp = localKeyStamp(key);
  assert.equal(stamp, "k1:t1");
  assert.equal(localKeyStamp({ ...key, status: "invalid" }), null);
  assert.equal(localKeyStamp(null), null);
  const gemini = keyRow("openrouter/google/gemini-3-pro");
  const noCli = { loadStatus: async () => status([cli({ path: null, models: [] })]) };
  const cases = [
    // The model list still loads: no load and no cache.
    { loaded: null, cached: null, sent: null },
    // The model list failed and the cache is unset.
    { loaded: { stamp: "k1:t1", models: null }, cached: null, sent: null },
    // A load for an older key does not count for this key.
    { loaded: { stamp: "k0:t0", models: [gemini] }, cached: null, sent: null },
    // The model list loaded.
    { loaded: { stamp: "k1:t1", models: [gemini] }, cached: null, sent: gemini.value },
    // A failed reload keeps the cached list the menu shows.
    { loaded: { stamp: "k1:t1", models: null }, cached: [gemini], sent: gemini.value },
  ];
  for (const { loaded, cached, sent } of cases) {
    // The chip reads the menu's first row, or shows "Default" with no rows.
    const menuRows = localKeyRows({ keysLoading: false, keysFailed: false, stamp, loaded, cached });
    const menu = localMenuModels([], menuRows && keyMenuModels(menuRows, null), null);
    assert.equal(menu[0]?.value ?? null, sent);
    assert.deepEqual(requestKeyRows(keys, loaded, cached), menuRows);
    assert.equal(
      await resolveLocalAgentModel(
        null,
        "claude",
        localDeps({ ...noCli, keyRows: () => requestKeyRows(keys, loaded, cached) }),
      ),
      sent,
    );
  }
  // No provider state: no key rows.
  assert.equal(requestKeyRows(null, { stamp: "k1:t1", models: [gemini] }, [gemini]), null);
});
