"use client";

import * as React from "react";
import { getWallet, type BillingWalletResponse } from "@/shared/lib/api";
import {
  STUB_WALLET,
  hasPaidBalance,
  isFrontierUnlocked,
  totalCredits,
  walletStatus,
  type AutoReload,
  type CreditWallet,
  type LedgerKind,
  type TokenSourceMode,
  type WalletStatus,
} from "../lib/credit";

interface CreditContextValue {
  wallet: CreditWallet;
  /** True while the wallet is being fetched — drives the chip's loading shimmer. */
  loading: boolean;
  status: WalletStatus;
  totalCredits: number;
  hasPaidBalance: boolean;
  /** True once the account may run frontier models (purchased credits or active Premium). */
  frontierUnlocked: boolean;
  /** Patch the auto-reload settings (stub: local only until the backend lands). */
  setAutoReload: (patch: Partial<AutoReload>) => void;
  /** Switch the active token source (managed credits vs the user's own key). */
  setMode: (mode: TokenSourceMode) => void;
  /** Re-fetch the wallet from the backend — call after a checkout/portal return. */
  refresh: () => void;
}

/**
 * Overlay a backend wallet response onto the current wallet, preserving the
 * client-only fields the backend doesn't own yet: the active token-source
 * `mode` (a local toggle) and `autoReload` (stub until the backend lands).
 * Backend ledger rows are all managed-mode credits (BYOK runs aren't billed),
 * so each maps to `mode: "managed"`.
 */
function applyWalletResponse(prev: CreditWallet, r: BillingWalletResponse): CreditWallet {
  return {
    ...prev,
    paidBalanceCredits: r.paid_balance_credits,
    freeGrant: {
      creditsRemaining: r.free_grant.credits_remaining,
      creditsTotal: r.free_grant.credits_total,
      resetsAt: r.free_grant.resets_at,
    },
    premiumActive: r.premium_active,
    usage: r.usage.map((u) => ({
      id: u.id,
      at: u.at,
      label: u.label,
      model: u.model,
      credits: u.credits,
      mode: "managed",
      kind: u.kind as LedgerKind,
    })),
  };
}

const CreditContext = React.createContext<CreditContextValue | null>(null);

/** Read the credit wallet and its mutators from the nearest CreditProvider. */
export function useCredits(): CreditContextValue {
  const ctx = React.useContext(CreditContext);
  if (!ctx) {
    throw new Error("useCredits must be used within a CreditProvider");
  }
  return ctx;
}

/**
 * Provide the credit wallet to the client tree.
 *
 * Fetches the real wallet (paid balance, free grant, Premium state, ledger)
 * from the billing backend on mount and after every `refresh()` — e.g. when a
 * Stripe Checkout returns. `STUB_WALLET` is the seed and the fallback: if the
 * fetch fails (no backend, signed-out) the demo wallet stays, so the UI never
 * breaks. The client-only `mode` toggle and `autoReload` survive each refresh.
 *
 * Args:
 *   initialWallet: Override the seed wallet (tests / story scenarios).
 *   children: App subtree.
 */
export function CreditProvider({
  initialWallet = STUB_WALLET,
  children,
}: {
  initialWallet?: CreditWallet;
  children: React.ReactNode;
}) {
  const [wallet, setWallet] = React.useState<CreditWallet>(initialWallet);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(() => {
    setLoading(true);
    getWallet()
      .then((r) => setWallet((prev) => applyWalletResponse(prev, r)))
      .catch(() => {
        /* keep the current wallet (stub fallback) — no backend or signed-out */
      })
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const setAutoReload = React.useCallback((patch: Partial<AutoReload>) => {
    setWallet((w) => ({ ...w, autoReload: { ...w.autoReload, ...patch } }));
  }, []);

  const setMode = React.useCallback((mode: TokenSourceMode) => {
    setWallet((w) => ({ ...w, mode }));
  }, []);

  const value = React.useMemo<CreditContextValue>(
    () => ({
      wallet,
      loading,
      status: walletStatus(wallet),
      totalCredits: totalCredits(wallet),
      hasPaidBalance: hasPaidBalance(wallet),
      frontierUnlocked: isFrontierUnlocked(wallet),
      setAutoReload,
      setMode,
      refresh,
    }),
    [wallet, loading, setAutoReload, setMode, refresh],
  );

  return <CreditContext.Provider value={value}>{children}</CreditContext.Provider>;
}
