"use client";

import * as React from "react";
import { fetchWithAuthRetry } from "@/shared/lib/api";
import { getRuntimeEnv, isLocalMode } from "@/shared/lib/runtime-env";
import type { CliProvider } from "@/features/billing";
import { subscriptionAgentModel, type LocalStatus } from "../lib/subscription-model";

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
 * The model id an agent request sends for a role set to run on `cli`. Hosted
 * builds, and roles left off, send the composer's choice unchanged.
 */
export function localAgentModel(model: string | null, cli: CliProvider | null): string | null {
  if (!cli || !isLocalMode()) return model;
  return subscriptionAgentModel(model, cli, peekLocalStatus());
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
