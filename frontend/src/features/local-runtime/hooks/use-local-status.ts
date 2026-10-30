"use client";

import * as React from "react";
import { fetchWithAuthRetry } from "@/shared/lib/api";
import { tI18n } from "@/shared/lib/i18n";
import { cachedCatalog } from "@/shared/lib/model-catalog";
import { getRuntimeEnv, isLocalMode } from "@/shared/lib/runtime-env";
import type { CliProvider } from "@/features/billing";
import type { CatalogModel } from "@/shared/types/api";
import {
  defaultAgentCli,
  findCli,
  isLocalModelRefusal,
  resolveAgentModel,
  subscriptionMenuModels,
  type LocalStatus,
} from "../lib/subscription-model";

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
 * The model id an agent request sends for a role set to run on `cli`. It waits
 * for `/local/status`, since the CLI's models decide the id. A local role with
 * no CLI runs on the default CLI, since the local backend has no managed
 * models. Hosted builds send the composer's choice unchanged.
 */
export async function localAgentModel(
  model: string | null,
  cli: CliProvider | null,
): Promise<string | null> {
  if (!isLocalMode()) return model;
  return resolveAgentModel(model, cli, loadLocalStatus, peekLocalStatus);
}

/**
 * The composer menu's models for an agent role on `cli` in the local build:
 * only that CLI's models, since the local backend has no managed models and
 * agent turns cannot bill a provider key. Hosted builds get undefined and keep
 * the catalog.
 */
export function useLocalAgentMenuModels(cli: CliProvider | null): CatalogModel[] | undefined {
  const local = isLocalMode();
  const { status } = useLocalStatus(local);
  return React.useMemo(
    () =>
      local
        ? subscriptionMenuModels(
            findCli(status, cli ?? defaultAgentCli(status)),
            cachedCatalog()?.models,
          )
        : undefined,
    [local, status, cli],
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
