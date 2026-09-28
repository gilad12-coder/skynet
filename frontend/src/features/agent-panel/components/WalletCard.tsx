"use client";

import * as React from "react";
import { formatCentsUsd } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";

import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import type { AgentToolCall } from "@/shared/ui/agent/types";

import { ToolCallRow } from "./ToolCallRow";
import { StatTile } from "./result-card-atoms";

interface WalletCardProps {
  call: AgentToolCall;
}

interface FreeGrant {
  cents_remaining?: number;
  cents_total?: number;
}

interface UsageEntry {
  id?: string;
  label?: string;
  model?: string | null;
  cents?: number;
  kind?: string;
}

interface WalletResult {
  paid_balance_cents?: number;
  free_grant?: FreeGrant;
  usage?: UsageEntry[];
}

function extractWallet(call: AgentToolCall): WalletResult | null {
  const payload = (call.payload ?? {}) as Record<string, unknown>;
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as WalletResult;
  if (typeof r.paid_balance_cents !== "number" || typeof r.free_grant !== "object") return null;
  return r;
}

function totalCents(w: WalletResult): number {
  return (w.free_grant?.cents_remaining ?? 0) + (w.paid_balance_cents ?? 0);
}

/** A cent amount as its dollar value. */
function fmtUsd(cents: number): string {
  return formatCentsUsd(cents, getActiveIntlLocale());
}

function buildSummary(w: WalletResult | null, isRunning: boolean): string | null {
  if (isRunning || !w) return null;
  return formatMsg("auto.features.agent.panel.components.walletcard.summary", {
    p1: fmtUsd(totalCents(w)),
  });
}

/**
 * Result card for ``get_wallet_for_agent`` — the caller's spendable balance in
 * dollars (free grant + paid balance) as a headline, a free-grant / paid-balance
 * split, and the most recent ledger entries.
 */
export function WalletCard({ call }: WalletCardProps) {
  const wallet = extractWallet(call);
  const summary = buildSummary(wallet, call.status === "running");

  if (!wallet) {
    return <ToolCallRow call={call} summary={summary} />;
  }

  const total = totalCents(wallet);
  const grant = wallet.free_grant ?? {};
  const usage = wallet.usage ?? [];

  const customBody = (
    <div className="space-y-3">
      <div dir="ltr" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[1.25rem] font-semibold tabular-nums text-foreground">
          {fmtUsd(total)}
        </span>
        <span className="text-[0.6875rem] text-muted-foreground/70">
          {msg("auto.features.agent.panel.components.walletcard.title")}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {/* Only legacy accounts still hold a grant — hide the tile when the
            account never had one. */}
        {(grant.cents_total ?? 0) > 0 && (
          <StatTile
            label={msg("auto.features.agent.panel.components.walletcard.free_grant")}
            value={
              grant.cents_remaining == null
                ? null
                : `${fmtUsd(grant.cents_remaining)} / ${fmtUsd(grant.cents_total ?? 0)}`
            }
            valueDir="ltr"
          />
        )}
        <StatTile
          label={msg("auto.features.agent.panel.components.walletcard.paid_balance")}
          value={fmtUsd(wallet.paid_balance_cents ?? 0)}
          valueDir="ltr"
        />
      </dl>

      {usage.length > 0 && (
        <div className="space-y-1">
          <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground/60">
            {msg("auto.features.agent.panel.components.walletcard.recent")}
          </div>
          <ul className="divide-y divide-border/40">
            {usage.slice(0, 5).map((row, idx) => (
              <li key={row.id ?? idx} className="flex items-center gap-2 py-1 text-[0.6875rem]">
                <span dir="auto" className="min-w-0 flex-1 truncate text-foreground/75">
                  {row.label ?? "—"}
                </span>
                <AmountDelta cents={row.cents ?? 0} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  return <ToolCallRow call={call} summary={summary} customBody={customBody} />;
}

function AmountDelta({ cents }: { cents: number }) {
  const positive = cents > 0;
  const text = positive ? `+${fmtUsd(cents)}` : fmtUsd(cents);
  return (
    <span
      dir="ltr"
      className="shrink-0 font-mono tabular-nums"
      style={{ color: positive ? "var(--success)" : undefined }}
    >
      {text}
    </span>
  );
}
