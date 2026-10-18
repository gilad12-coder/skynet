"use client";

import { useEffect, useState } from "react";

import { AddFundsControls, formatCentsUsd, useBalance } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/primitives/button";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CircleNotch,
  Wallet,
  WarningCircle,
} from "@/shared/ui/icons";

import type { BudgetShortfall } from "../lib/budget-limit";

/** The panel's id: Continue moves focus here instead of raising a toast over itself. */
export const RUN_SHORTFALL_ID = "budgetShortfall";

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";

/**
 * What the run needs against what the account can spend, shown on the budget
 * screen while the run can't start, with the one fix that applies: raise the
 * limit, or add funds right here. Checkout opens in a new tab so the setup
 * stays as it is; coming back to this tab re-reads the balance, and once it
 * covers the run the panel goes and Continue goes through.
 */
export function RunShortfall({
  shortfall,
  limitCents,
  balanceCents,
  onRaiseLimit,
}: {
  shortfall: BudgetShortfall;
  /** The spending limit, or null under "No limit". */
  limitCents: number | null;
  balanceCents: number;
  onRaiseLimit: (cents: number) => void;
}) {
  const locale = getActiveIntlLocale();
  const { beginSync, syncing } = useBalance();
  const [adding, setAdding] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const dollars = (cents: number) =>
    `${ISOLATE_START}${formatCentsUsd(cents, locale)}${ISOLATE_END}`;
  const limitShort = shortfall.kind === "limit";
  const gap = Math.max(0, shortfall.needed - balanceCents);

  // Paying happens in the other tab; the webhook lands a little after it.
  useEffect(() => {
    if (!awaiting || syncing) return;
    const onBack = () => {
      if (document.visibilityState === "visible") beginSync();
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [awaiting, syncing, beginSync]);

  return (
    <section
      id={RUN_SHORTFALL_ID}
      tabIndex={-1}
      aria-labelledby={`${RUN_SHORTFALL_ID}Title`}
      className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/25"
    >
      <p
        id={`${RUN_SHORTFALL_ID}Title`}
        aria-live="polite"
        className="flex items-start gap-2 text-sm font-medium text-destructive"
        dir="auto"
      >
        <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {msg(limitShort ? "submit.budget.short.limit_title" : "submit.budget.short.balance_title")}
      </p>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 ps-6 text-xs">
        <Figure label={msg("submit.budget.floor")} value={dollars(shortfall.needed)} />
        {limitCents != null && (
          <Figure
            label={msg("submit.budget.short.limit")}
            value={dollars(limitCents)}
            short={limitShort}
          />
        )}
        <Figure
          label={msg("submit.budget.short.balance")}
          value={dollars(balanceCents)}
          short={!limitShort}
          note={
            !limitShort && gap > 0
              ? formatMsg("submit.budget.short.gap", { amount: dollars(gap) })
              : undefined
          }
        />
      </dl>
      <div className="ps-6">
        {limitShort ? (
          <Button variant="outline" size="sm" onClick={() => onRaiseLimit(shortfall.needed)}>
            {formatMsg("submit.budget.short.raise", { amount: dollars(shortfall.needed) })}
          </Button>
        ) : awaiting ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-xs leading-snug text-muted-foreground" dir="auto">
              {msg("submit.budget.short.waiting")}
            </p>
            <Button variant="outline" size="sm" onClick={() => beginSync()} disabled={syncing}>
              {syncing ? (
                <CircleNotch
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <ArrowClockwise aria-hidden="true" />
              )}
              {msg("submit.budget.short.check")}
            </Button>
          </div>
        ) : adding ? (
          <div className="space-y-2">
            <AddFundsControls
              inPlace={{ gapCents: gap, onCheckoutOpened: () => setAwaiting(true) }}
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" dir="auto">
              <ArrowSquareOut className="size-3.5 shrink-0" aria-hidden="true" />
              {msg("submit.budget.short.new_tab")}
            </p>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Wallet aria-hidden="true" />
            {msg("billing.action.add_funds")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** One figure: muted label, the amount at the end, red with its note when it falls short. */
function Figure({
  label,
  value,
  short = false,
  note,
}: {
  label: string;
  value: string;
  short?: boolean;
  note?: string;
}) {
  return (
    <>
      <dt
        className={cn("min-w-0", short ? "font-medium text-destructive" : "text-muted-foreground")}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "text-end tabular-nums",
          short ? "font-semibold text-destructive" : "font-medium text-foreground",
        )}
      >
        <span dir="auto">{value}</span>
        {note && (
          <span className="ms-2 font-normal" dir="auto">
            {note}
          </span>
        )}
      </dd>
    </>
  );
}
