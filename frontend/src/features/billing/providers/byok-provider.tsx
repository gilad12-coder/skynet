"use client";

import * as React from "react";
import { STUB_PROVIDER_KEYS, keyLast4, type KeyStatus, type ProviderKey } from "../lib/byok";

interface ByokContextValue {
  /** Saved keys, keyed by provider slug via `keyFor`. */
  keys: ProviderKey[];
  /** The saved key for a provider slug, or null. */
  keyFor: (provider: string) => ProviderKey | null;
  /** Save (or replace) a provider's key. Stored unverified; the secret is dropped immediately. */
  saveKey: (provider: string, secret: string) => void;
  /** Run the verify probe for a provider's key. Stub: resolves to "verified". */
  verifyKey: (provider: string) => Promise<KeyStatus>;
  /** Forget a provider's key. */
  removeKey: (provider: string) => void;
}

const ByokContext = React.createContext<ByokContextValue | null>(null);

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
 * Stub-backed until the encrypted key vault lands: keys live in local state and
 * the secret is never persisted (only its masked tail is kept), so the UI is
 * fully interactive — add, verify, replace, remove — without a backend. `saveKey`
 * deliberately discards the plaintext the instant it has the tail; when the API
 * arrives only the bodies of these callbacks change, not the context shape.
 *
 * Args:
 *   initialKeys: Override the seed keys (tests / story scenarios).
 *   children: App subtree.
 */
export function ByokKeysProvider({
  initialKeys = STUB_PROVIDER_KEYS,
  children,
}: {
  initialKeys?: ProviderKey[];
  children: React.ReactNode;
}) {
  const [keys, setKeys] = React.useState<ProviderKey[]>(initialKeys);

  const keyFor = React.useCallback(
    (provider: string) => keys.find((k) => k.provider === provider) ?? null,
    [keys],
  );

  const saveKey = React.useCallback((provider: string, secret: string) => {
    const last4 = keyLast4(secret);
    setKeys((prev) => {
      const next: ProviderKey = {
        provider,
        last4,
        status: "unverified",
        addedAt: new Date().toISOString(),
      };
      const rest = prev.filter((k) => k.provider !== provider);
      return [...rest, next];
    });
  }, []);

  // Stub verify: a real probe would call the provider; here it always succeeds
  // after a short beat so the "verifying → verified" transition is visible.
  const verifyKey = React.useCallback(async (provider: string): Promise<KeyStatus> => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    setKeys((prev) =>
      prev.map((k) => (k.provider === provider ? { ...k, status: "verified" } : k)),
    );
    return "verified";
  }, []);

  const removeKey = React.useCallback((provider: string) => {
    setKeys((prev) => prev.filter((k) => k.provider !== provider));
  }, []);

  const value = React.useMemo<ByokContextValue>(
    () => ({ keys, keyFor, saveKey, verifyKey, removeKey }),
    [keys, keyFor, saveKey, verifyKey, removeKey],
  );

  return <ByokContext.Provider value={value}>{children}</ByokContext.Provider>;
}
