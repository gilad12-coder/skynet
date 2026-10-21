"use client";

import * as React from "react";
import { fetchWithAuthRetry } from "@/shared/lib/api";
import { tI18n } from "@/shared/lib/i18n";
import { cachedByokCatalog, cachedCatalog, getByokModelCatalog } from "@/shared/lib/model-catalog";
import { getRuntimeEnv, isLocalMode } from "@/shared/lib/runtime-env";
import type { CliProvider } from "@/features/billing";
import { useByokKeys } from "@/features/billing/providers/byok-provider";
import type { CatalogModel } from "@/shared/types/api";
import {
  defaultAgentCli,
  findCli,
  isLocalModelRefusal,
  keyMenuModels,
  LOCAL_KEY_PROVIDER,
  localMenuModels,
  resolveAgentModel,
  runsOnLocalKey,
  subscriptionMenuModels,
  type LocalStatus,
} from "../lib/subscription-model";
import { loadAgentEngine, refreshAgentEngine, useAgentEngine } from "./use-agent-engine";

// CLI logins and usage caps change outside the app, so a cached status goes
// stale quickly; a picker opened after this long fetches again.
const STATUS_MAX_AGE_MS = 15_000;

let cached: { status: LocalStatus; at: number } | null = null;
let inflight: Promise<LocalStatus> | null = null;
const listeners = new Set<() => void>();

async function fetchLocalStatus(): Promise<LocalStatus> {
  const res = await fetchWithAuthRetry(`${getRuntimeEnv().apiUrl}/local/status`, {
    method: "GET",
  });
  if (!res.ok) throw new Error(`local status ${res.status}`);
  return (await res.json()) as LocalStatus;
}

/** Load `/local/status`, sharing one request between every caller. */
export function loadLocalStatus(force = false): Promise<LocalStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_MAX_AGE_MS) {
    return Promise.resolve(cached.status);
  }
  if (inflight) return inflight;
  const promise = fetchLocalStatus()
    .then((status) => {
      cached = { status, at: Date.now() };
      listeners.forEach((notify) => notify());
      refreshAgentEngine();
      return status;
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

/** The last status any caller loaded, for code outside React (agent requests). */
export function peekLocalStatus(): LocalStatus | null {
  return cached?.status ?? null;
}

/**
 * The model id an agent request sends for a role set to run on `cli`. A pick
 * the saved OpenRouter key serves is sent unchanged. Any other pick waits for
 * `/local/status`, since the CLI's models decide the id. A local role with no
 * CLI runs on the agent engine's CLI, else the default CLI, since the local
 * backend has no managed models. Hosted builds send the composer's choice
 * unchanged.
 */
export async function localAgentModel(
  model: string | null,
  cli: CliProvider | null,
): Promise<string | null> {
  if (!isLocalMode()) return model;
  if (model && runsOnLocalKey(model, (await getByokModelCatalog()).models)) return model;
  if (cli) return resolveAgentModel(model, cli, loadLocalStatus, peekLocalStatus);
  // A status refresh can change the engine, so load the engine after the status.
  await loadLocalStatus().catch(() => null);
  const engine = await loadAgentEngine();
  return resolveAgentModel(model, null, loadLocalStatus, peekLocalStatus, engine);
}

/**
 * The saved OpenRouter key's menu rows in the local build: empty with no
 * verified key, `null` while the key list or its models still load.
 */
function useLocalKeyModels(enabled: boolean): CatalogModel[] | null {
  const { keyFor, loading } = useByokKeys();
  const key = keyFor(LOCAL_KEY_PROVIDER);
  // A new or re-verified key changes this stamp, which fetches its models again.
  const stamp = enabled && key?.status === "verified" ? `${key.id}:${key.addedAt}` : null;
  const [loaded, setLoaded] = React.useState<{ stamp: string; models: CatalogModel[] } | null>(
    null,
  );

  React.useEffect(() => {
    if (!stamp) return;
    let active = true;
    void getByokModelCatalog().then((catalog) => {
      if (active) setLoaded({ stamp, models: keyMenuModels(catalog.models) });
    });
    return () => {
      active = false;
    };
  }, [stamp]);

  if (!enabled) return [];
  if (loading) return null;
  if (!stamp) return [];
  if (loaded?.stamp === stamp) return loaded.models;
  const cached = cachedByokCatalog();
  return cached ? keyMenuModels(cached.models) : null;
}

/**
 * The composer menu's models for an agent role on `cli` in the local build:
 * that CLI's models (the agent engine's CLI when the role has none), then the
 * models of a saved, verified OpenRouter key. Hosted builds get undefined and
 * keep the catalog.
 */
export function useLocalAgentMenuModels(cli: CliProvider | null): CatalogModel[] | undefined {
  const local = isLocalMode();
  const { status } = useLocalStatus(local);
  const { engine } = useAgentEngine();
  const keyModels = useLocalKeyModels(local);
  return React.useMemo(
    () =>
      local
        ? localMenuModels(
            subscriptionMenuModels(
              findCli(status, cli ?? defaultAgentCli(status, engine)),
              cachedCatalog()?.models,
            ),
            keyModels,
          )
        : undefined,
    [local, status, cli, engine, keyModels],
  );
}

/**
 * The message for the local backend's no-model refusal, in the active locale,
 * or null for any other error code.
 */
export function localModelRefusalMessage(code: string | null | undefined): string | null {
  return code && isLocalModelRefusal(code) ? tI18n(code) : null;
}

/**
 * The local backend's CLI and Docker status. Hosted builds never call the
 * route (it 404s there) and always see `status: null`.
 */
export function useLocalStatus(enabled = true): {
  status: LocalStatus | null;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
} {
  const active = enabled && isLocalMode();
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  const load = React.useCallback(
    (force: boolean) => {
      if (!active) return;
      setLoading(true);
      setFailed(false);
      loadLocalStatus(force)
        .catch(() => setFailed(true))
        .finally(() => setLoading(false));
    },
    [active],
  );

  React.useEffect(() => {
    load(false);
  }, [load]);

  const refresh = React.useCallback(() => load(true), [load]);
  return { status: active ? peekLocalStatus() : null, loading, failed, refresh };
}
