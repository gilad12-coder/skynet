"use client";

import { Coins } from "@/shared/ui/icons";
import type { OptimizationStatusResponse } from "@/shared/types/api";
import { msg } from "@/shared/lib/messages";
import { formatBudgetUsd } from "@/features/billing";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

/**
 * The run's spending recap as a dedicated tab. Promoted out of the inline
 * lifecycle notice so an idle run surfaces its limit and spend here instead of
 * in an always-on card above the tabs; budget stops and pauses still notice
 * inline with their own recap.
 */
export function BudgetTab({ job }: { job: OptimizationStatusResponse }) {
  const budget = job.execution_budget ?? job.terminal_evidence?.execution_budget;
  if (!budget) return null;
  const locale = getActiveIntlLocale();
  const amount = (value: string | number) => formatBudgetUsd(String(value), locale);
  const settling = (budget.pending_operations ?? 0) > 0 || Boolean(budget.blocked_reason);
  return (
    <section className="space-y-3 rounded-xl border border-border/50 bg-card/40 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Coins className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{msg("submit.budget.label")}</h2>
      </div>
      <dl className="grid grid-cols-2 gap-3 border-t border-border/40 pt-3 text-sm sm:grid-cols-5">
        {(
          [
            [
              "submit.budget.label",
              budget.uncapped ? msg("submit.budget.uncapped_short") : amount(budget.total_credits),
            ],
            ["submit.budget.setup_spent", amount(budget.setup_spent_credits)],
            ["submit.budget.run_spent", amount(budget.run_spent_credits)],
            ["submit.budget.reserved", amount(budget.reserved_credits)],
            ["submit.budget.available", amount(budget.available_credits)],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="min-w-0 space-y-1">
            <dt className="text-xs text-muted-foreground">{msg(key)}</dt>
            <dd className="break-all font-medium tabular-nums" dir="auto">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {settling && <p className="text-xs text-muted-foreground">{msg("budget.pending")}</p>}
    </section>
  );
}
