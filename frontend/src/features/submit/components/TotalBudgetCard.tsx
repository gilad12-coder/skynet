"use client";

import { useEffect, useState, type ComponentType } from "react";

import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { HelpTip } from "@/shared/ui/help-tip";
import {
  ClockCounterClockwise,
  Cpu,
  Gauge,
  Hourglass,
  Info,
  ListChecks,
  Lock,
  Play,
  Terminal,
  Wallet,
  Warning,
  WarningCircle,
} from "@/shared/ui/icons";
import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { cn } from "@/shared/lib/utils";

import { parseBudgetInput } from "../lib/budget-input";
import { chargeableBracket } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";
import { useExecutionBudget } from "../hooks/use-execution-budget";
import { Disclosure } from "./Disclosure";
import { StepCard } from "./blackbox/shared";

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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
  const showLedger = budget != null && spent != null;
  const showStatus =
    budgetBusy || budgetError || (budget && budget.total_credits !== maxCostCredits);

  return (
    <StepCard title={msg("submit.budget.label")} description={msg("submit.budget.explainer")}>
      <div className="space-y-2">
        <Label htmlFor="totalBudgetInput" className="sr-only">
          {msg("submit.budget.label")}
        </Label>
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
            aria-describedby={cn(fieldMessage && "totalBudgetMessage", "totalBudgetUnit")}
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
          <span id="totalBudgetUnit" className="shrink-0 px-4 text-muted-foreground" dir="auto">
            {unit}
          </span>
        </div>
        {fieldMessage && (
          <p
            id="totalBudgetMessage"
            aria-live="polite"
            className={cn(
              "flex items-start gap-1.5 text-xs leading-snug",
              fieldError ? "text-destructive" : "text-muted-foreground",
            )}
            dir="auto"
          >
            {fieldError ? (
              <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            )}
            {fieldMessage}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="rounded-xl border border-[#C8B9A8]/50 bg-background px-3.5 py-3 shadow-[0_1px_2px_rgba(61,46,34,0.04)]">
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-[#3D2E22]">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#C8A882]/15 text-[#A8895E]">
                <Gauge className="h-3 w-3" aria-hidden="true" />
              </span>
              {msg(
                preliminary
                  ? "submit.budget.estimate_preliminary"
                  : feeOnly
                    ? "submit.summary.estimate_fee"
                    : "submit.summary.estimate_cost",
              )}
            </span>
            <span
              className="text-[13px] font-medium tabular-nums text-[#3D2E22] sm:text-end"
              dir="auto"
            >
              {formatMsg("submit.summary.estimate_range", {
                low: credits(bracket.lowCredits),
                high: credits(bracket.highCredits),
              })}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-snug text-muted-foreground" dir="auto">
            {estimateNotes}
          </p>
        </div>
        {overLimit === "likely" && (
          <p
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-snug text-amber-700"
            dir="auto"
          >
            <Warning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {formatMsg("submit.budget.over_limit_low", { limit: credits(maxCostCredits ?? 0) })}
          </p>
        )}
        {overLimit === "possible" && (
          <p
            className="flex items-start gap-2 px-1 text-xs leading-snug text-muted-foreground"
            dir="auto"
          >
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {formatMsg("submit.budget.over_limit", { limit: credits(maxCostCredits ?? 0) })}
          </p>
        )}
      </div>

      {(showLedger || showStatus) && (
        <div className="space-y-2">
          {showLedger && (
            <dl>
              <Row
                icon={Wallet}
                label={msg("submit.budget.remaining")}
                value={withUnit(formatBudgetAmount(budget.available_credits, locale))}
              />
              {!isZero(spent) && (
                <Row
                  icon={ClockCounterClockwise}
                  label={msg("submit.budget.spent")}
                  value={withUnit(formatBudgetAmount(spent, locale))}
                />
              )}
              {!isZero(budget.reserved_credits) && (
                <Row
                  icon={Lock}
                  label={msg("submit.budget.reserved")}
                  tip={msg("submit.budget.reserved_tip")}
                  value={withUnit(formatBudgetAmount(budget.reserved_credits, locale))}
                />
              )}
            </dl>
          )}
          {budgetBusy && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
              {msg("submit.budget.syncing")}
            </p>
          )}
          {budgetError && (
            <p
              role="alert"
              className="flex items-start gap-2 text-xs leading-snug text-destructive"
              dir="auto"
            >
              <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {budgetError}
            </p>
          )}
          {budget && budget.total_credits !== maxCostCredits && (
            <p className="text-xs text-muted-foreground" dir="auto">
              {msg("submit.budget.pending_total")}
            </p>
          )}
        </div>
      )}

      <Disclosure
        id="totalBudgetDetails"
        label={msg("submit.budget.details.summary")}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        <div className="space-y-3">
          <dl>
            <Row
              icon={Cpu}
              label={msg(
                mode === "byok" ? "submit.budget.details.fee" : "submit.budget.details.models",
              )}
              value={formatMsg("submit.summary.estimate_range", {
                low: credits(modelLow),
                high: credits(modelHigh),
              })}
            />
            {runtimeAtCost && (
              <Row
                icon={Terminal}
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
              <Row
                icon={Terminal}
                label={msg("submit.budget.details.runtime")}
                sub={msg("submit.runtime.vercel")}
                value={msg("submit.budget.details.runtime_included")}
              />
            )}
            {budget && !isZero(budget.setup_spent_credits) && (
              <Row
                icon={ListChecks}
                label={msg("submit.budget.setup_spent")}
                value={withUnit(formatBudgetAmount(budget.setup_spent_credits, locale))}
              />
            )}
            {budget && !isZero(budget.run_spent_credits) && (
              <Row
                icon={Play}
                label={msg("submit.budget.run_spent")}
                value={withUnit(formatBudgetAmount(budget.run_spent_credits, locale))}
              />
            )}
          </dl>
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p dir="auto">{msg("submit.budget.details.assumptions")}</p>
            <p dir="auto">{msg("submit.budget.details.reservation")}</p>
            {mixedBilling && <p dir="auto">{msg("submit.budget.details.mixed_billing")}</p>}
            {mode === "byok" && <p dir="auto">{msg("submit.budget.byok_note")}</p>}
          </div>
        </div>
      </Disclosure>
    </StepCard>
  );
}

/** One hairline row in the summary step's style: small icon, muted label, value at the end. */
function Row({
  icon: Icon,
  label,
  value,
  sub,
  tip,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tip?: string;
}) {
  const name = (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      {label}
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5">
      <dt className="min-w-0">
        {tip ? <HelpTip text={tip}>{name}</HelpTip> : name}
        {sub && (
          <span className="mt-0.5 block ps-5.5 text-[11px] text-muted-foreground/80" dir="auto">
            {sub}
          </span>
        )}
      </dt>
      <dd
        className="max-w-[55%] shrink-0 text-end text-sm font-medium wrap-break-word tabular-nums text-foreground"
        dir="auto"
      >
        {value}
      </dd>
    </div>
  );
}
