/**
 * Pure helpers for the local desktop build's "My subscription" model source:
 * the `/local/status` shapes, each CLI's display state, and the
 * `subscription/<cli>/<catalog-slug>` shorthand agent requests carry.
 *
 * Only type imports, so `node --test` loads it directly.
 */
import type { CliProvider } from "@/features/billing";
import type { CatalogModel, ModelConfig } from "@/shared/types/api";
import type { RunUsageRow } from "@/shared/types/run-usage";

export const CLI_PROVIDERS: readonly CliProvider[] = ["codex", "claude"];

export const SUBSCRIPTION_MODEL_PREFIX = "subscription/";

/** One coding-agent CLI as `GET /local/status` reports it. */
export interface CliStatus {
  id: CliProvider;
  path: string | null;
  version: string | null;
  min_version: string;
  version_ok: boolean;
  logged_in: boolean | null;
  login_hint: string | null;
  rate_limited_until: string | null;
  models: string[];
}

/** `GET /local/status`; the route exists only on a local-mode backend. */
export interface LocalStatus {
  local_mode: true;
  version: string;
  docker: { available: boolean; error: string | null };
  sandbox_image: string;
  clis: CliStatus[];
}

/** What the picker shows for one CLI; only `ok` can run models. */
export type CliState =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "old"; version: string | null; minVersion: string }
  | { kind: "logged_out"; hint: string | null }
  | { kind: "capped"; until: Date };

export function isCliProvider(value: unknown): value is CliProvider {
  return typeof value === "string" && (CLI_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolve a CLI's state. A missing binary wins over everything; a usage cap
 * counts only while its reset time is still ahead of `now`. An unknown login
 * (`logged_in: null`) is treated as usable, since some CLIs cannot be probed
 * without spending a call.
 */
export function cliState(cli: CliStatus, now: Date = new Date()): CliState {
  if (!cli.path) return { kind: "missing" };
  if (!cli.version_ok) return { kind: "old", version: cli.version, minVersion: cli.min_version };
  if (cli.logged_in === false) return { kind: "logged_out", hint: cli.login_hint };
  if (cli.rate_limited_until) {
    const until = new Date(cli.rate_limited_until);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return { kind: "capped", until };
    }
  }
  return { kind: "ok" };
}

export function findCli(
  status: LocalStatus | null | undefined,
  cli: CliProvider | null | undefined,
): CliStatus | undefined {
  if (!status || !cli) return undefined;
  return status.clis.find((entry) => entry.id === cli);
}

/** `subscription/<cli>/<catalog-slug>`, the agent-request model shorthand. */
export function subscriptionModelId(cli: CliProvider, slug: string): string {
  return `${SUBSCRIPTION_MODEL_PREFIX}${cli}/${slug}`;
}

export function parseSubscriptionModelId(
  modelId: string | null | undefined,
): { cli: CliProvider; slug: string } | null {
  if (!modelId?.startsWith(SUBSCRIPTION_MODEL_PREFIX)) return null;
  const rest = modelId.slice(SUBSCRIPTION_MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const cli = rest.slice(0, slash);
  const slug = rest.slice(slash + 1);
  if (!isCliProvider(cli) || !slug) return null;
  return { cli, slug };
}

/**
 * Whether a catalog value names a CLI's model slug. The catalog may route a
 * model through a gateway prefix (`openrouter/anthropic/...`), which still
 * names the same model as the CLI's bare `anthropic/...` slug.
 */
export function catalogValueMatchesSlug(value: string, slug: string): boolean {
  return value === slug || value.endsWith(`/${slug}`);
}

/**
 * The picker list for a CLI: its slugs, enriched with catalog metadata where
 * the catalog knows the model. The saved name is always the CLI's own slug.
 */
export function subscriptionCatalogModels(
  cli: CliStatus | undefined,
  catalog: CatalogModel[] | undefined,
): CatalogModel[] {
  if (!cli) return [];
  return cli.models.map((slug) => {
    const hit = catalog?.find((model) => catalogValueMatchesSlug(model.value, slug));
    if (hit) return { ...hit, value: slug, available: true };
    return {
      value: slug,
      label: slug.split("/").pop() || slug,
      provider: slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : cli.id,
      supports_thinking: false,
      supports_vision: false,
      available: true,
    };
  });
}

/**
 * The composer menu's list for an agent role that runs on `cli`: the CLI's
 * models as subscription ids, so the pick is the id the request sends.
 */
export function subscriptionMenuModels(
  cli: CliStatus | undefined,
  catalog: CatalogModel[] | undefined,
): CatalogModel[] {
  if (!cli) return [];
  return subscriptionCatalogModels(cli, catalog).map((model) => ({
    ...model,
    value: subscriptionModelId(cli.id, model.value),
  }));
}

/**
 * The 422 code the local backend returns for a turn with no model pick: it
 * has no managed models, so it refuses instead of falling back to one.
 */
export const LOCAL_MODEL_REFUSED_CODE = "models.managed_unavailable_local";

/** Whether an error code is the local backend's no-model refusal. */
export function isLocalModelRefusal(code: string | null | undefined): boolean {
  return code === LOCAL_MODEL_REFUSED_CODE;
}

/**
 * The hint under "Your own key". The hosted text names a platform fee, which
 * the local build never charges, so local mode gets its own line.
 */
export function byokHintKey(
  localMode: boolean,
): "billing.mode.byok_hint" | "billing.mode.byok_hint_local" {
  return localMode ? "billing.mode.byok_hint_local" : "billing.mode.byok_hint";
}

/**
 * The label of the run detail estimate row, or null to hide the row. The stored
 * estimate forecasts a Skynet fee or charge, which a local run never pays in
 * real money, so local mode hides it.
 */
export function runEstimateLabelKey(
  tokenSource: string | null,
  localMode: boolean,
): "submit.summary.estimate_fee" | "submit.summary.estimate_cost" | null {
  if (localMode) return null;
  return tokenSource === "byok" ? "submit.summary.estimate_fee" : "submit.summary.estimate_cost";
}

/**
 * The usage tab column that sits next to the provider column. The hosted label
 * names a Skynet charge; the local build only draws on its free local balance.
 */
export function usageChargedKey(
  localMode: boolean,
): "usage_tab.charged" | "usage_tab.charged_local" {
  return localMode ? "usage_tab.charged_local" : "usage_tab.charged";
}

type UsageNoteRow = Pick<
  RunUsageRow,
  "billing" | "charged_cents" | "provider_cents" | "api_rate_cents" | "calls" | "unpriced_calls"
>;

/**
 * The note above the local usage table, or null for none. Own-key amounts in
 * the provider column are at API rates and the provider bills the user's key,
 * so that column gets an asterisk and this note. A run whose model calls drew
 * no charge and no provider spend ran on the subscription, so nothing was
 * billed. That claim is final, so it waits until the run stops and its ledger
 * settles, and it applies only to the whole-run view. When the backend priced
 * every call's tokens at API rates, the note also explains the "*" amounts; a
 * run with an unpriced model keeps the plain note, so no partial sum reads as
 * the run's amount. Any other run, and hosted mode, gets no note.
 */
export function usageCostNoteKey(
  localMode: boolean,
  rows: readonly UsageNoteRow[],
  view: { final: boolean; pairIndex: number | null },
):
  | "usage_tab.api_rates_note_local"
  | "usage_tab.subscription_note_local"
  | "usage_tab.subscription_api_rates_note_local"
  | null {
  if (!localMode) return null;
  if (rows.some((r) => r.provider_cents != null)) return "usage_tab.api_rates_note_local";
  if (!view.final || view.pairIndex != null) return null;
  // Local mode refuses managed models (models.managed_unavailable_local), so a
  // local row with no charge and no own-key billing is a subscription call.
  const billed = rows.some(
    (r) =>
      r.charged_cents > 0 || r.unpriced_calls > 0 || r.billing === "byok" || r.billing === "direct",
  );
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  if (calls === 0 || billed) return null;
  return rows.every((r) => r.calls === 0 || r.api_rate_cents != null)
    ? "usage_tab.subscription_api_rates_note_local"
    : "usage_tab.subscription_note_local";
}

/** A model config billed to the user's CLI subscription. */
export function subscriptionModelConfig(name: string, cli: CliProvider): ModelConfig {
  return { name, token_source: "subscription", cli_provider: cli };
}

/**
 * The model id an agent request sends when its role runs on a CLI
 * subscription. A model the CLI serves keeps its slug; anything else (no
 * pick, or a pick the CLI cannot run) falls back to the CLI's first model.
 * Without a usable slug the original choice is returned unchanged.
 */
export function subscriptionAgentModel(
  model: string | null,
  cli: CliProvider | null | undefined,
  status: LocalStatus | null | undefined,
): string | null {
  if (!cli) return model;
  const parsed = parseSubscriptionModelId(model);
  if (parsed?.cli === cli) return model;
  const slug = parsed?.slug ?? model;
  const entry = findCli(status, cli);
  if (!entry) return slug ? subscriptionModelId(cli, slug) : model;
  const served = slug ? entry.models.find((m) => catalogValueMatchesSlug(slug, m)) : undefined;
  const chosen = served ?? entry.models[0];
  return chosen ? subscriptionModelId(cli, chosen) : model;
}

/**
 * The CLI an agent role runs on when the user picked none. The local build
 * has no managed models, so every role needs a CLI: the first ready one, else
 * the first installed one, else Claude Code.
 */
export function defaultAgentCli(
  status: LocalStatus | null | undefined,
  now: Date = new Date(),
): CliProvider {
  // An older backend may still report a CLI the app no longer offers.
  const clis = (status?.clis ?? []).filter((cli) => isCliProvider(cli.id));
  const ready = clis.find((cli) => cliState(cli, now).kind === "ok");
  const installed = clis.find((cli) => cli.path);
  return ready?.id ?? installed?.id ?? "claude";
}

/**
 * The agent model for a role, resolved against a loaded status: the CLI's
 * slugs decide what the request sends, so the request waits for the status.
 * A role with no CLI runs on `defaultAgentCli`. A failed load falls back to
 * the last status any caller loaded.
 */
export async function resolveAgentModel(
  model: string | null,
  cli: CliProvider | null | undefined,
  load: () => Promise<LocalStatus>,
  peek: () => LocalStatus | null,
): Promise<string | null> {
  const status = await load().catch(() => peek());
  return subscriptionAgentModel(model, cli ?? defaultAgentCli(status), status);
}

/**
 * The proposer patch for a host CLI choice. Picking a CLI keeps the current
 * permission, or starts at workspace only; any other value turns both off.
 */
export function hostCliPatch(
  value: string,
  permission: "workspace_only" | "full_access" | undefined,
): {
  host_cli: CliProvider | undefined;
  host_permission: "workspace_only" | "full_access" | undefined;
} {
  return isCliProvider(value)
    ? { host_cli: value, host_permission: permission ?? "workspace_only" }
    : { host_cli: undefined, host_permission: undefined };
}
