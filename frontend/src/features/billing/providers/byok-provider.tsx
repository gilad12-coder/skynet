"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import {
  getProviderKeys,
  saveProviderKey,
  verifyProviderKey,
  removeProviderKey,
  type ProviderKeyResponse,
  type SaveProviderKeyOptions,
} from "@/shared/lib/api";
import { type KeyStatus, type ProviderKey } from "../lib/byok";
import { invalidateByokModelCatalog } from "@/shared/lib/model-catalog";
import { track, TelemetryEvent } from "@/shared/lib/telemetry";

interface ByokContextValue {
  /** Saved keys, keyed by provider slug via `keyFor`. */
  keys: ProviderKey[];
  /** True while the saved keys are being fetched on mount. */
  loading: boolean;
  /** True when the last fetch of the saved keys failed, so `keys` may be incomplete. */
  failed: boolean;
  /** Fetch the saved keys again, for example to retry after a failed fetch. */
  reload: () => Promise<void>;
  /** Whether "Continue with OpenRouter" is offered (the backend vault is configured). */
  openrouterOAuthAvailable: boolean;
  /** The saved key for a provider slug, or null. */
  keyFor: (provider: string) => ProviderKey | null;
  /**
   * Save (or rotate) a provider's key. The plaintext is sent once to the vault,
   * encrypted at rest, and verified on entry; only the masked tail + verdict
   * come back. `opts` carries an optional custom endpoint / label. Resolves to
   * the saved key's status.
   */
  saveKey: (provider: string, secret: string, opts?: SaveProviderKeyOptions) => Promise<KeyStatus>;
  /** Re-run the verify probe against a stored key and persist the fresh verdict. */
  verifyKey: (provider: string) => Promise<KeyStatus>;
  /** Forget a provider's key. */
  removeKey: (provider: string) => Promise<void>;
}

const ByokContext = React.createContext<ByokContextValue | null>(null);

type ByokKeysSnapshot = Pick<ByokContextValue, "keys" | "loading" | "failed">;

let snapshot: ByokKeysSnapshot | null = null;

/**
 * The mounted provider's key state, for code outside React (agent requests),
 * so a request decides from the same keys the composer menu shows. Null when
 * no provider is mounted.
 */
export function peekByokKeys(): ByokKeysSnapshot | null {
  return snapshot;
}

/** Map a backend masked-connection response onto the UI's ProviderKey shape. */
function toProviderKey(r: ProviderKeyResponse): ProviderKey {
  return {
    id: r.id,
    provider: r.provider,
    label: r.label ?? null,
    last4: r.last4,
    apiBase: r.api_base ?? null,
    status: r.status,
    addedAt: r.added_at,
  };
}

/** Read the BYOK key store from the nearest ByokKeysProvider. */
export function useByokKeys(): ByokContextValue {
  const ctx = React.useContext(ByokContext);
  if (!ctx) {
    throw new Error("useByokKeys must be used within a ByokKeysProvider");
  }
  return ctx;
}

/**
 * Provide the BYOK provider-key store to the client tree.
 *
 * Backed by the real encrypt-at-rest vault (`/billing/byok/keys`): the saved
 * keys are fetched on mount, and every mutation round-trips to the backend so a
 * secret is never held only in memory — the plaintext is sent once on save,
 * encrypted server-side, and never returned. The context exposes only the
 * masked tail + verification state. Signed-out pages skip the fetch, and if it
 * fails (no backend) the store stays empty so the settings UI still renders its
 * add-a-key rows.
 *
 * Args:
 *   initialKeys: Override the seed keys (tests / story scenarios).
 *   children: App subtree.
 */
export function ByokKeysProvider({
  initialKeys = [],
  children,
}: {
  initialKeys?: ProviderKey[];
  children: React.ReactNode;
}) {
  const [keys, setKeys] = React.useState<ProviderKey[]>(initialKeys);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [openrouterOAuthAvailable, setOpenrouterOAuthAvailable] = React.useState(false);
  const { status: sessionStatus } = useSession();
  // Bumped when a save, verify, or remove sets the keys: a list fetch that
  // started before then may hold the older server list, so it is dropped.
  const keysGen = React.useRef(0);

  React.useEffect(() => {
    snapshot = { keys, loading, failed };
  }, [keys, loading, failed]);
  React.useEffect(
    () => () => {
      snapshot = null;
    },
    [],
  );

  React.useEffect(() => {
    // The vault only answers a signed-in caller; skip it on signed-out pages.
    if (sessionStatus === "loading") return;
    if (sessionStatus === "unauthenticated") {
      setLoading(false);
      return;
    }
    let active = true;
    const gen = keysGen.current;
    getProviderKeys()
      .then((r) => {
        if (!active || gen !== keysGen.current) return;
        setKeys(r.keys.map(toProviderKey));
        setOpenrouterOAuthAvailable(r.openrouter_oauth_available ?? false);
        setFailed(false);
      })
      .catch(() => {
        // Keep the current keys (no backend), but say the list is not known.
        if (active && gen === keysGen.current) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionStatus]);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = React.useCallback(() => {
    const gen = keysGen.current;
    // A dropped result leaves `failed` as it is, so a failed list retries again.
    return getProviderKeys()
      .then((r) => {
        if (!mounted.current || gen !== keysGen.current) return;
        setKeys(r.keys.map(toProviderKey));
        setOpenrouterOAuthAvailable(r.openrouter_oauth_available ?? false);
        setFailed(false);
      })
      .catch(() => {
        if (mounted.current && gen === keysGen.current) setFailed(true);
      });
  }, []);

  const keyFor = React.useCallback(
    (provider: string) => keys.find((k) => k.provider === provider) ?? null,
    [keys],
  );

  const upsert = React.useCallback((next: ProviderKey) => {
    keysGen.current += 1;
    invalidateByokModelCatalog();
    setKeys((prev) => [...prev.filter((k) => k.provider !== next.provider), next]);
  }, []);

  const saveKey = React.useCallback(
    async (provider: string, secret: string, opts?: SaveProviderKeyOptions): Promise<KeyStatus> => {
      const saved = await saveProviderKey(provider, secret, opts);
      upsert(toProviderKey(saved));
      track(TelemetryEvent.ByokKeyAdded, { provider, status: saved.status });
      return saved.status;
    },
    [upsert],
  );

  const verifyKey = React.useCallback(
    async (provider: string): Promise<KeyStatus> => {
      const verified = await verifyProviderKey(provider);
      upsert(toProviderKey(verified));
      return verified.status;
    },
    [upsert],
  );

  const removeKey = React.useCallback(async (provider: string): Promise<void> => {
    const remaining = await removeProviderKey(provider);
    keysGen.current += 1;
    invalidateByokModelCatalog();
    setKeys(remaining.keys.map(toProviderKey));
    setFailed(false);
  }, []);

  const value = React.useMemo<ByokContextValue>(
    () => ({
      keys,
      loading,
      failed,
      reload,
      openrouterOAuthAvailable,
      keyFor,
      saveKey,
      verifyKey,
      removeKey,
    }),
    [
      keys,
      loading,
      failed,
      reload,
      openrouterOAuthAvailable,
      keyFor,
      saveKey,
      verifyKey,
      removeKey,
    ],
  );

  return <ByokContext.Provider value={value}>{children}</ByokContext.Provider>;
}
