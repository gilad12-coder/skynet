"use client";

import { useEffect, useState } from "react";
import { Input } from "@/shared/ui/primitives/input";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { chargeableBracket } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";
import { useExecutionBudget } from "../hooks/use-execution-budget";

/**
 * The one budget surface of both wizards: a single total that covers setup
 * checks and the optimization itself, shown against the projected usage
 * bracket and what setup has spent so far. Credits are reserved before work
 * starts and settled on actual usage; the run stops when the total is reached.
 *
 * Mode-aware: managed model roles show their full credit cost; BYOK roles show
 * their platform fee. The required Vercel runtime remains an at-cost line in
 * either mode.
 */
type BudgetContext = Pick<
  SubmitWizardContext,
  "costBracket" | "suggestedCeiling" | "maxCostCredits" | "setMaxCostCredits"
> & {
  setupSpent?: number;
  availableCredits?: number | null;
};

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";

function parseBudget(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

export function TotalBudgetCard({ w, mode }: { w: BudgetContext; mode: TokenSourceMode }) {
  const { costBracket, suggestedCeiling, maxCostCredits, setMaxCostCredits } = w;
  const { budget, budgetBusy, budgetError, minimumTotalCredits } = useExecutionBudget();
  const locale = getActiveIntlLocale();
  const displayBracket = chargeableBracket(costBracket, mode);
  const isFeeOnlyEstimate = mode === "byok" && displayBracket.runtimeBillingBasis !== "at_cost";

  // The field owns its text so the user can clear it; an empty total stays
  // unset instead of snapping to zero.
  const [text, setText] = useState(maxCostCredits == null ? "" : String(maxCostCredits));
  useEffect(() => {
    setText((prev) =>
      parseBudget(prev) === maxCostCredits
        ? prev
        : maxCostCredits == null
          ? ""
          : String(maxCostCredits),
    );
  }, [maxCostCredits]);

  const credits = (value: number) =>
    `${ISOLATE_START}${formatCredits(value, locale)}${ISOLATE_END}`;
  const preciseCredits = (value: number) => formatBudgetAmount(value.toFixed(9), locale);
  const unit = msg("submit.cost_ceiling.cap_unit");

  return (
    <div className="@container rounded-xl border border-border bg-card p-4 text-[14px] text-foreground">
      <div className="space-y-4">
        <div className="flex flex-col gap-4 @sm:flex-row @sm:items-end @sm:justify-between @sm:gap-6">
          <div className="min-w-0 space-y-2 @sm:w-52 @sm:shrink-0">
            <HelpTip text={`${tip("submit.budget")} ${msg("submit.budget.supporting")}`}>
              <label htmlFor="totalBudgetInput" className="font-medium">
                {msg("submit.budget.label")}
              </label>
            </HelpTip>
            <div
              dir="ltr"
              className="flex h-[48px] items-center overflow-hidden rounded-lg border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
            >
              <Input
                id="totalBudgetInput"
                inputMode="numeric"
                autoComplete="off"
                aria-describedby={
                  maxCostCredits == null ? "totalBudgetUnit totalBudgetHint" : "totalBudgetUnit"
                }
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setMaxCostCredits(parseBudget(e.target.value));
                }}
                placeholder={formatMsg("submit.budget.placeholder", {
                  suggested: formatCredits(suggestedCeiling, locale),
                })}
                dir="ltr"
                className="h-full rounded-none border-0 bg-transparent text-lg tabular-nums shadow-none backdrop-blur-none md:text-lg focus-visible:border-transparent focus-visible:ring-0"
              />
              <span id="totalBudgetUnit" className="shrink-0 px-3 text-foreground/70" dir="auto">
                {unit}
              </span>
            </div>
          </div>
          <dl className="min-w-0 space-y-2 @sm:text-end">
            <dt className="text-foreground/70">
              <HelpTip
                text={[
                  msg("submit.budget.reservation_copy"),
                  mode === "byok" ? msg("submit.budget.byok_note") : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {msg(
                  isFeeOnlyEstimate
                    ? "submit.summary.estimate_fee"
                    : "submit.summary.estimate_cost",
                )}
              </HelpTip>
            </dt>
            <dd
              className="text-lg font-medium tabular-nums @sm:flex @sm:min-h-[48px] @sm:items-center @sm:justify-end"
              dir="auto"
            >
              {formatMsg("submit.summary.estimate_range", {
                low: credits(displayBracket.lowCredits),
                high: credits(displayBracket.highCredits),
              })}
            </dd>
          </dl>
        </div>
        {maxCostCredits == null && (
          <p id="totalBudgetHint" className="leading-relaxed text-foreground/70" dir="auto">
            {msg("submit.budget.unset")}
          </p>
        )}
        <dl className="space-y-3 border-t border-border pt-4">
          <BudgetFigure
            label={msg("submit.budget.billing_source")}
            tip={`${msg(mode === "byok" ? "billing.mode.byok_hint" : "billing.mode.managed_hint")} ${msg("submit.budget.billing_source_tip")}`}
            value={msg(mode === "byok" ? "billing.mode.byok" : "billing.mode.managed")}
          />
          {displayBracket.runtimeBillingBasis === "at_cost" &&
            displayBracket.expectedRuntimeSessions > 0 &&
            displayBracket.runtimeSessionHighCredits > 0 && (
              <BudgetFigure
                label={msg("submit.runtime.vercel")}
                tip={`${msg("submit.budget.reservation_copy")} ${ISOLATE_START}≤ ${preciseCredits(displayBracket.runtimeSessionHighCredits)} × ${displayBracket.expectedRuntimeSessions} = ≤ ${preciseCredits(displayBracket.runtimeSessionHighCredits * displayBracket.expectedRuntimeSessions)}${ISOLATE_END}`}
                value={`${ISOLATE_START}≤ ${formatCredits(displayBracket.runtimeHighCredits, locale)}${ISOLATE_END} ${unit}`}
              />
            )}
        </dl>
        {budget && (
          <dl className="grid gap-x-8 gap-y-3 border-t border-border pt-4 @md:grid-cols-2">
            <BudgetFigure
              label={msg("submit.budget.available")}
              value={`${formatBudgetAmount(budget.available_credits, locale)} ${unit}`}
            />
            <BudgetFigure
              label={msg("submit.budget.reserved")}
              value={`${formatBudgetAmount(budget.reserved_credits, locale)} ${unit}`}
            />
            <BudgetFigure
              label={msg("submit.budget.setup_spent")}
              value={`${formatBudgetAmount(budget.setup_spent_credits, locale)} ${unit}`}
            />
            <BudgetFigure
              label={msg("submit.budget.run_spent")}
              value={`${formatBudgetAmount(budget.run_spent_credits, locale)} ${unit}`}
            />
          </dl>
        )}
        {budgetBusy && (
          <p role="status" className="text-foreground/70">
            {msg("submit.budget.syncing")}
          </p>
        )}
        {budgetError && (
          <p role="alert" className="text-destructive">
            {budgetError}
          </p>
        )}
        {minimumTotalCredits != null && (
          <p className="text-foreground/70">
            {formatMsg("submit.budget.minimum_total", {
              amount: formatCredits(Math.ceil(minimumTotalCredits), locale),
            })}
          </p>
        )}
        {budget && budget.total_credits !== maxCostCredits && (
          <p className="text-foreground/70">{msg("submit.budget.pending_total")}</p>
        )}
      </div>
    </div>
  );
}

function BudgetFigure({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="min-w-0 text-foreground/70">
        {tip ? <HelpTip text={tip}>{label}</HelpTip> : label}
      </dt>
      <dd
        className="min-w-0 text-end font-medium wrap-break-word tabular-nums text-foreground"
        dir="auto"
      >
        {value}
      </dd>
    </div>
  );
}
