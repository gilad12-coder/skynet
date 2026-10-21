/**
 * Pure helpers for the local desktop build's "My subscription" model source:
 * the `/local/status` shapes, each CLI's display state, and the
 * `subscription/<cli>/<catalog-slug>` shorthand agent requests carry.
 *
 * Only type imports, so `node --test` loads it directly.
 */
import type { CliProvider } from "@/features/billing";
import type { CatalogModel, ModelConfig } from "@/shared/types/api";

export const CLI_PROVIDERS: readonly CliProvider[] = ["codex", "claude", "droid"];

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
