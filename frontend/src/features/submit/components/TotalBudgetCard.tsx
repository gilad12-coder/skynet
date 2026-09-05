"use client";

import { useEffect, useState } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { Coins } from "@phosphor-icons/react/dist/ssr/Coins";
import { Gauge } from "@phosphor-icons/react/dist/ssr/Gauge";
import { Hourglass } from "@phosphor-icons/react/dist/ssr/Hourglass";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";

import { Input } from "@/shared/ui/primitives/input";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { cn } from "@/shared/lib/utils";

import { parseBudgetInput } from "../lib/budget-input";
import { chargeableBracket } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";
import { useExecutionBudget } from "../hooks/use-execution-budget";

/**
 * The one budget surface of both wizards: a spending limit that covers setup
 * checks and the optimization itself. The limit is the decision; the projected
 * usage bracket only supports it, and the arithmetic behind the bracket stays
 * folded away until asked for.
 *
 * Mode-aware: managed model roles show their full credit cost; BYOK roles show
 * their platform fee. The required execution environment is included in the
 * estimate in either mode.
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

/** Add two server decimal strings exactly, without passing them through a float. */
function sumDecimals(a: string, b: string): string {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const scale = Math.max(aFraction.length, bFraction.length);
  const total =
    BigInt(aWhole + aFraction.padEnd(scale, "0")) + BigInt(bWhole + bFraction.padEnd(scale, "0"));
  const digits = total.toString().padStart(scale + 1, "0");
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

const isZero = (amount: string) => !/[1-9]/.test(amount);

export function TotalBudgetCard({
  w,
  mode,
  preliminary = false,
}: {
  w: BudgetContext;
  mode: TokenSourceMode;
  /** The estimate still waits on inputs from later steps (cases, models). */
  preliminary?: boolean;
}) {
  const { costBracket, suggestedCeiling, maxCostCredits, setMaxCostCredits } = w;
  const { budget, budgetBusy, budgetError, minimumTotalCredits } = useExecutionBudget();
  const locale = getActiveIntlLocale();
  const bracket = chargeableBracket(costBracket, mode);
  const feeOnly = mode === "byok" && bracket.runtimeBillingBasis !== "at_cost";
  const runtimeAtCost =
    bracket.runtimeBillingBasis === "at_cost" &&
    bracket.expectedRuntimeSessions > 0 &&
    bracket.runtimeSessionHighCredits > 0;
  const mixedBilling =
    costBracket.managedModelHighCredits > 0 && costBracket.byokModelHighCredits > 0;

  // The field owns its text so the user can clear it or leave a typo visible
  // with its error; an unreadable value stays unset instead of snapping to zero.
  const [text, setText] = useState(maxCostCredits == null ? "" : String(maxCostCredits));
  useEffect(() => {
    setText((prev) => {
      const parsed = parseBudgetInput(prev, locale);
      const current = parsed.kind === "value" ? parsed.value : null;
      if (current === maxCostCredits) return prev;
      return maxCostCredits == null ? "" : String(maxCostCredits);
    });
  }, [maxCostCredits, locale]);

  const credits = (value: number) =>
    `${ISOLATE_START}${formatCredits(value, locale)}${ISOLATE_END}`;
  const unit = msg("submit.cost_ceiling.cap_unit");
  const withUnit = (amount: string) => `${amount} ${unit}`;
  const suggested = formatCredits(suggestedCeiling, locale);

  const parsed = parseBudgetInput(text, locale);
  const minimum = minimumTotalCredits == null ? null : Math.ceil(minimumTotalCredits);
  const minimumMessage =
    minimum == null
      ? null
      : formatMsg("submit.budget.minimum_total", { amount: formatCredits(minimum, locale) });
  const fieldError =
    parsed.kind === "invalid"
      ? formatMsg("submit.budget.error.invalid", { suggested })
      : parsed.kind === "fraction"
        ? msg("submit.budget.error.fraction")
        : parsed.kind === "below_one"
          ? msg("submit.budget.error.below_one")
          : parsed.kind === "value" && minimum != null && parsed.value < minimum
            ? minimumMessage
            : null;
  const fieldHint = fieldError == null && parsed.kind === "empty" ? minimumMessage : null;
  const fieldMessage = fieldError ?? fieldHint;

  const overLimit =
    maxCostCredits != null && bracket.highCredits > maxCostCredits
      ? bracket.lowCredits > maxCostCredits
        ? "likely"
        : "possible"
      : null;
  const estimateNotes = [
    preliminary ? msg("submit.budget.estimate_preliminary_note") : null,
    msg(runtimeAtCost ? "submit.budget.estimate_note_runtime" : "submit.budget.estimate_note"),
  ]
    .filter(Boolean)
    .join(" ");
  const modelLow = Math.max(0, bracket.lowCredits - bracket.runtimeLowCredits);
  const modelHigh = Math.max(modelLow, bracket.highCredits - bracket.runtimeHighCredits);

  const spent = budget ? sumDecimals(budget.setup_spent_credits, budget.run_spent_credits) : null;

  return (
    <div className="@container rounded-xl border border-border bg-card p-4 text-[14px] text-foreground">
      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="totalBudgetInput" className="flex items-center gap-2 font-medium">
            <Coins className="size-4 shrink-0 text-foreground/70" aria-hidden="true" />
            {msg("submit.budget.label")}
          </label>
          <div
            dir="ltr"
            className={cn(
              "flex h-12 items-center overflow-hidden rounded-lg border bg-background transition-[border-color,box-shadow] focus-within:ring-[3px]",
              fieldError
                ? "border-destructive focus-within:border-destructive focus-within:ring-destructive/20"
                : "border-input focus-within:border-ring focus-within:ring-ring/50",
            )}
          >
            <Input
              id="totalBudgetInput"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={cn(
                fieldMessage && "totalBudgetMessage",
                "totalBudgetExplainer totalBudgetUnit",
              )}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const next = parseBudgetInput(e.target.value, locale);
                setMaxCostCredits(next.kind === "value" ? next.value : null);
              }}
              placeholder={formatMsg("submit.budget.placeholder", { suggested })}
              dir="ltr"
              className="h-full rounded-none border-0 bg-transparent px-4 text-lg tabular-nums shadow-none backdrop-blur-none md:text-lg focus-visible:border-transparent focus-visible:ring-0"
            />
            <span id="totalBudgetUnit" className="shrink-0 px-4 text-foreground/70" dir="auto">
              {unit}
            </span>
          </div>
          {fieldMessage && (
            <p
              id="totalBudgetMessage"
              aria-live="polite"
              className={cn(
                "flex items-start gap-1.5 leading-snug",
                fieldError ? "text-destructive" : "text-foreground/70",
              )}
              dir="auto"
            >
              {fieldError ? (
                <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              )}
              {fieldMessage}
            </p>
          )}
          <p id="totalBudgetExplainer" className="text-foreground/70" dir="auto">
            {msg("submit.budget.explainer")}
          </p>
        </div>

        <div className="space-y-1.5 border-t border-border pt-4">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-foreground/70" dir="auto">
            <Gauge className="size-4 shrink-0" aria-hidden="true" />
            <span>
              {msg(
                preliminary
                  ? "submit.budget.estimate_preliminary"
                  : feeOnly
                    ? "submit.summary.estimate_fee"
                    : "submit.summary.estimate_cost",
              )}
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {formatMsg("submit.summary.estimate_range", {
                low: credits(bracket.lowCredits),
                high: credits(bracket.highCredits),
              })}
            </span>
          </p>
          <p className="text-[13px] leading-snug text-foreground/60" dir="auto">
            {estimateNotes}
          </p>
          {overLimit === "likely" && (
            <p
              className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[13px] leading-snug text-amber-700"
              dir="auto"
            >
              <Warning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {formatMsg("submit.budget.over_limit_low", { limit: credits(maxCostCredits ?? 0) })}
            </p>
          )}
          {overLimit === "possible" && (
            <p
              className="flex items-start gap-2 text-[13px] leading-snug text-foreground/70"
              dir="auto"
            >
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {formatMsg("submit.budget.over_limit", { limit: credits(maxCostCredits ?? 0) })}
            </p>
          )}
        </div>

        {budget && spent && (
          <dl className="grid gap-x-8 gap-y-2 border-t border-border pt-4 @md:grid-cols-2">
            <Figure
              label={msg("submit.budget.remaining")}
              value={withUnit(formatBudgetAmount(budget.available_credits, locale))}
            />
            {!isZero(spent) && (
              <Figure
                label={msg("submit.budget.spent")}
                value={withUnit(formatBudgetAmount(spent, locale))}
              />
            )}
            {!isZero(budget.reserved_credits) && (
              <Figure
                label={msg("submit.budget.reserved")}
                tip={msg("submit.budget.reserved_tip")}
                value={withUnit(formatBudgetAmount(budget.reserved_credits, locale))}
              />
            )}
          </dl>
        )}
        {budgetBusy && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-foreground/70">
            <Hourglass className="size-4 shrink-0" aria-hidden="true" />
            {msg("submit.budget.syncing")}
          </p>
        )}
        {budgetError && (
          <p
            role="alert"
            className="flex items-start gap-2 text-[13px] text-destructive"
            dir="auto"
          >
            <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {budgetError}
          </p>
        )}
        {budget && budget.total_credits !== maxCostCredits && (
          <p className="text-[13px] text-foreground/70" dir="auto">
            {msg("submit.budget.pending_total")}
          </p>
        )}

        <details className="group border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-foreground/80 [&::-webkit-details-marker]:hidden">
            <CaretDown
              className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
            {msg("submit.budget.details.summary")}
          </summary>
          <div className="mt-3 space-y-3 text-[13px]">
            <dl className="space-y-2">
              <Figure
                label={msg(
                  mode === "byok" ? "submit.budget.details.fee" : "submit.budget.details.models",
                )}
                value={formatMsg("submit.summary.estimate_range", {
                  low: credits(modelLow),
                  high: credits(modelHigh),
                })}
              />
              {runtimeAtCost && (
                <Figure
                  label={msg("submit.budget.details.runtime")}
                  sub={formatMsg("submit.budget.details.runtime_sessions", {
                    provider: msg("submit.runtime.vercel"),
                    perSession: formatBudgetAmount(
                      bracket.runtimeSessionHighCredits.toFixed(9),
                      locale,
                    ),
                    sessions: bracket.expectedRuntimeSessions,
                  })}
                  value={formatMsg("submit.budget.details.up_to", {
                    amount: credits(bracket.runtimeHighCredits),
                  })}
                />
              )}
              {bracket.runtimeBillingBasis === "included_in_model_markup" && (
                <Figure
                  label={msg("submit.budget.details.runtime")}
                  sub={msg("submit.runtime.vercel")}
                  value={msg("submit.budget.details.runtime_included")}
                />
              )}
              {budget && !isZero(budget.setup_spent_credits) && (
                <Figure
                  label={msg("submit.budget.setup_spent")}
                  value={withUnit(formatBudgetAmount(budget.setup_spent_credits, locale))}
                />
              )}
              {budget && !isZero(budget.run_spent_credits) && (
                <Figure
                  label={msg("submit.budget.run_spent")}
                  value={withUnit(formatBudgetAmount(budget.run_spent_credits, locale))}
                />
              )}
            </dl>
            <p className="leading-relaxed text-foreground/70" dir="auto">
              {msg("submit.budget.details.assumptions")}
            </p>
            <p className="leading-relaxed text-foreground/70" dir="auto">
              {msg("submit.budget.details.reservation")}
            </p>
            {mixedBilling && (
              <p className="leading-relaxed text-foreground/70" dir="auto">
                {msg("submit.budget.details.mixed_billing")}
              </p>
            )}
            {mode === "byok" && (
              <p className="leading-relaxed text-foreground/70" dir="auto">
                {msg("submit.budget.byok_note")}
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  tip,
}: {
  label: string;
  value: string;
  sub?: string;
  tip?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="min-w-0 text-foreground/70">
        {tip ? <HelpTip text={tip}>{label}</HelpTip> : label}
        {sub && (
          <span className="block text-xs text-foreground/50" dir="auto">
            {sub}
          </span>
        )}
      </dt>
      <dd
        className="min-w-0 shrink-0 text-end font-medium wrap-break-word tabular-nums text-foreground"
        dir="auto"
      >
        {value}
      </dd>
    </div>
  );
}
