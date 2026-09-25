"use client";

import * as React from "react";
import { getConnectors, type ConnectorProvider, type ConnectorStatus } from "@/shared/lib/api";

/** Loading/error/data shape returned by {@link useConnectors}. */
export interface UseConnectorsResult {
  connectors: ConnectorStatus[];
  /** The Hugging Face entry, or null before the first load. */
  huggingFace: ConnectorStatus | null;
  /** Look up one provider's entry, or null before the first load. */
  byProvider: (provider: ConnectorProvider) => ConnectorStatus | null;
  loading: boolean;
  error: boolean;
  /** Replace the list from a mutation response (save/remove echo the full list). */
  setConnectors: (connectors: ConnectorStatus[]) => void;
  refetch: () => void;
}

/**
 * Fetch the caller's connector links (one entry per supported provider).
 *
 * Args:
 *     enabled: When false the fetch is deferred — the import dialog reads the
 *         link state only once it opens.
 */
export function useConnectors(enabled = true): UseConnectorsResult {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = React.useState(enabled);
  const [error, setError] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const refetch = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    getConnectors()
      .then((res) => {
        if (!cancelled) setConnectors(res.connectors);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, enabled]);

  const huggingFace = React.useMemo(
    () => connectors.find((c) => c.provider === "huggingface") ?? null,
    [connectors],
  );

  const byProvider = React.useCallback(
    (provider: ConnectorProvider) => connectors.find((c) => c.provider === provider) ?? null,
    [connectors],
  );

  return { connectors, huggingFace, byProvider, loading, error, setConnectors, refetch };
}
