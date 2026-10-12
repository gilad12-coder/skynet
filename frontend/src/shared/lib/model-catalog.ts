import type { CatalogModel, ModelCatalogResponse } from "@/shared/types/api";
import { getByokModels } from "@/shared/lib/api";
import { getRuntimeEnv } from "@/shared/lib/runtime-env";

// Resolve lazily — a module-load const races the injected window.__SKYNET_ENV__
// and freezes the build-time localhost fallback. See shared/lib/api.ts.
const apiBase = () => getRuntimeEnv().apiUrl;
const LS_KEY = "skynet:model-catalog";

const EMPTY_CATALOG: ModelCatalogResponse = { providers: [], models: [] };

function isModelCatalogResponse(value: unknown): value is ModelCatalogResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelCatalogResponse>;
  return Array.isArray(candidate.providers) && Array.isArray(candidate.models);
}

// Stale-while-revalidate: serve whatever the last load stored — no TTL. An
// expired cache used to leave the model menu empty for the seconds the
// LiteLLM round-trip takes; a slightly stale list beats a blank one, and the
// module-load fetch below replaces it as soon as fresh data lands.
let _cache: ModelCatalogResponse | null = null;
try {
  const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
  if (raw) {
    const parsed = JSON.parse(raw) as { ts?: unknown; data?: unknown };
    if (isModelCatalogResponse(parsed.data)) {
      _cache = parsed.data;
    }
  }
} catch {
  /* ignore parse errors */
}

const _ready: Promise<ModelCatalogResponse> =
  typeof window === "undefined"
    ? Promise.resolve(_cache ?? EMPTY_CATALOG)
    : (async () => {
        try {
          const res = await fetch(`${apiBase()}/models`);
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data: unknown = await res.json();
          if (!isModelCatalogResponse(data)) throw new Error("Invalid model catalog response");
          _cache = data;
          try {
            localStorage.setItem(LS_KEY, JSON.stringify({ data, ts: Date.now() }));
          } catch {}
          return data;
        } catch {
          if (_cache) return _cache;
          _cache = EMPTY_CATALOG;
          return EMPTY_CATALOG;
        }
      })();

export function getModelCatalog(): Promise<ModelCatalogResponse> {
  return _ready;
}

/** Synchronously inspect the cached catalog (returns null only before first fetch resolves). */
export function cachedCatalog(): ModelCatalogResponse | null {
  return _cache;
}

// BYOK catalog — every offered provider's models, regardless of platform keys
// (a BYOK run pays with the user's own key). Fetched lazily on first need (only
// in BYOK mode), not at module load, and held in memory for the session.
let _byokCache: ModelCatalogResponse | null = null;
let _byokReady: Promise<ModelCatalogResponse> | null = null;

export function getByokModelCatalog(): Promise<ModelCatalogResponse> {
  if (_byokReady) return _byokReady;
  if (typeof window === "undefined") return Promise.resolve(EMPTY_CATALOG);
  _byokReady = (async () => {
    try {
      const data: unknown = await getByokModels();
      if (!isModelCatalogResponse(data)) throw new Error("Invalid BYOK catalog response");
      _byokCache = data;
      return data;
    } catch {
      // Reset so a transient failure can retry on the next BYOK switch.
      _byokReady = null;
      return _byokCache ?? EMPTY_CATALOG;
    }
  })();
  return _byokReady;
}

/** Drop the account-scoped BYOK catalog after a provider connection changes. */
export function invalidateByokModelCatalog(): void {
  _byokCache = null;
  _byokReady = null;
}

/** Synchronously inspect the cached BYOK catalog (null before its first fetch resolves). */
export function cachedByokCatalog(): ModelCatalogResponse | null {
  return _byokCache;
}

export type ModelRanking = "best_value" | "smartest" | "fastest";

/** One section of a picker tab; `kind` picks the section's header. */
export interface RankedGroup {
  kind: "ranked" | "dominated" | "unrated" | "no_speed";
  models: CatalogModel[];
}

// The short reply the interview default is timed on (backend
// interview_model._REPLY_TOKENS), so Fastest agrees with that pick.
const REPLY_TOKENS = 150;

/** Milliseconds to the first token plus a short reply, or null when unmeasured. */
export function replyMs(m: CatalogModel): number | null {
  if (!m.throughput_tps || m.latency_ms == null) return null;
  return m.latency_ms + (REPLY_TOKENS / m.throughput_tps) * 1000;
}

/** Benchmark points per input dollar, or null without both a score and a price. */
export function scorePerDollar(m: CatalogModel): number | null {
  if (m.intelligence_index == null || !m.input_cost_per_token) return null;
  return m.intelligence_index / m.input_cost_per_token;
}

/** Whether `a` scores at least as high for at most the price, and is strictly better on one. */
function dominates(a: CatalogModel, b: CatalogModel): boolean {
  const sa = a.intelligence_index ?? 0;
  const sb = b.intelligence_index ?? 0;
  const pa = a.input_cost_per_token ?? 0;
  const pb = b.input_cost_per_token ?? 0;
  return sa >= sb && pa <= pb && (sa > sb || pa < pb);
}

function byDesc(key: (m: CatalogModel) => number) {
  return (a: CatalogModel, b: CatalogModel) => key(b) - key(a);
}

/**
 * Order models for one picker tab. Best value lists the Pareto frontier of
 * score against input price by score per dollar, then the rated models the
 * frontier beats, then the unrated. Smartest sorts by intelligence index,
 * unrated last. Fastest sorts by time to a short reply, unmeasured last.
 * Empty groups are dropped; ties keep the catalog's order.
 */
export function rankModels(models: CatalogModel[], ranking: ModelRanking): RankedGroup[] {
  let groups: RankedGroup[];
  if (ranking === "fastest") {
    const timed = models.filter((m) => replyMs(m) !== null);
    timed.sort((a, b) => (replyMs(a) ?? 0) - (replyMs(b) ?? 0));
    groups = [
      { kind: "ranked", models: timed },
      { kind: "no_speed", models: models.filter((m) => replyMs(m) === null) },
    ];
  } else if (ranking === "smartest") {
    const rated = models.filter((m) => m.intelligence_index != null);
    rated.sort(byDesc((m) => m.intelligence_index ?? 0));
    groups = [
      { kind: "ranked", models: rated },
      { kind: "unrated", models: models.filter((m) => m.intelligence_index == null) },
    ];
  } else {
    const priced = models.filter((m) => scorePerDollar(m) !== null);
    const frontier = priced.filter((m) => !priced.some((other) => dominates(other, m)));
    const onFrontier = new Set(frontier);
    // A score without a price can't sit on the frontier, but it is still rated.
    const dominated = models.filter((m) => m.intelligence_index != null && !onFrontier.has(m));
    frontier.sort(byDesc((m) => scorePerDollar(m) ?? 0));
    dominated.sort(byDesc((m) => scorePerDollar(m) ?? -1));
    groups = [
      { kind: "ranked", models: frontier },
      { kind: "dominated", models: dominated },
      { kind: "unrated", models: models.filter((m) => m.intelligence_index == null) },
    ];
  }
  return groups.filter((g) => g.models.length > 0);
}
