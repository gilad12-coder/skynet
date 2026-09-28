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
  Minus,
  Play,
  Plus,
  Terminal,
  Wallet,
  WarningCircle,
} from "@/shared/ui/icons";
import { formatBudgetUsd, formatCentsUsd, type TokenSourceMode } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";

import { centsToBudgetText, parseBudgetInput } from "@/shared/lib/budget-input";
import { chargeableBracket } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";
import { useExecutionBudget } from "../hooks/use-execution-budget";
import { Disclosure } from "./Disclosure";
import { Figure, buildEstimateSections, type CalcSection } from "./EstimateBreakdown";
import { Segmented } from "@/shared/ui/segmented";
import { StepCard } from "./blackbox/shared";

/**
 * The one budget surface of both wizards: a spending limit that covers setup
 * checks and the optimization itself. The limit is the decision; the projected
 * usage bracket only supports it, so it sits attached under the field as one
 * block, and the arithmetic behind the bracket stays folded away until asked
 * for.
 *
 * Every figure on the card is a trigger: it opens a layer over the card that
 * walks through the calculation behind that number, built from the same trace
 * the bracket was computed from.
 *
 * Mode-aware: managed model roles show their full cost; BYOK roles show
 * their platform fee. The required execution environment is included in the
 * estimate in either mode.
 *
 * The limit can also be switched off: the run then draws on the account
 * balance until it finishes, and stops in place if that balance runs out. Each
 * mode explains itself in the tooltip of its option; under "No limit" the card
 * is its header alone, as the estimate and the ledger describe a limit.
 */
type BudgetContext = Pick<
  SubmitWizardContext,
  | "costBracket"
  | "suggestedCeiling"
  | "maxCostCents"
  | "setMaxCostCents"
  | "budgetUncapped"
  | "setBudgetUncapped"
> & {
  setupSpent?: number;
  availableCents?: number | null;
};

const BUDGET_STEP_CENTS = 100;
const BUDGET_STEP_BUTTON_CLASS =
  "flex h-full w-12 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
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
  const {
    costBracket,
    suggestedCeiling,
    maxCostCents,
    setMaxCostCents,
    budgetUncapped,
    setBudgetUncapped,
  } = w;
  const { budget, budgetBusy, budgetError, minimumTotalCents } = useExecutionBudget();
  const locale = getActiveIntlLocale();
  const bracket = chargeableBracket(costBracket, mode);
  const { charge } = bracket;
  const feeOnly = mode === "byok" && bracket.runtimeBillingBasis !== "at_cost";
  const runtimeAtCost =
    bracket.runtimeBillingBasis === "at_cost" &&
    bracket.expectedRuntimeSessions > 0 &&
    bracket.runtimeSessionHighCents > 0;
  const runtimeIncluded = bracket.runtimeBillingBasis === "included_in_model_markup";
  const mixedBilling = costBracket.managedModelHighCents > 0 && costBracket.byokModelHighCents > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The field is typed in dollars; the wizard state stays in cents. The field
  // owns its text so the user can clear it or leave a typo visible with its
  // error; an unreadable value stays unset instead of snapping to zero.
  const [text, setText] = useState(
    maxCostCents == null ? "" : centsToBudgetText(maxCostCents, locale),
  );
  useEffect(() => {
    setText((prev) => {
      const parsed = parseBudgetInput(prev, locale);
      const current = parsed.kind === "value" ? parsed.value : null;
      if (current === maxCostCents) return prev;
      return maxCostCents == null ? "" : centsToBudgetText(maxCostCents, locale);
    });
  }, [maxCostCents, locale]);

  const isolate = (value: string) => `${ISOLATE_START}${value}${ISOLATE_END}`;
  const dollars = (value: number) => isolate(formatCentsUsd(value, locale));
  const dollarRange = (low: number, high: number) =>
    formatMsg("submit.summary.estimate_range", { low: dollars(low), high: dollars(high) });
  const unit = msg("submit.cost_ceiling.cap_unit");
  const ledgerAmount = (amount: string) => formatBudgetUsd(amount, locale);
  const suggested = centsToBudgetText(suggestedCeiling, locale);

  const parsed = parseBudgetInput(text, locale);
  // The +/- nudge the limit by a dollar and never below one cent; an empty
  // field steps from the suggested limit rather than from zero.
  const nudge = (direction: 1 | -1) => {
    const base = parsed.kind === "value" ? parsed.value : suggestedCeiling;
    const next = Math.max(1, base + direction * BUDGET_STEP_CENTS);
    setMaxCostCents(next);
    setText(centsToBudgetText(next, locale));
  };
  const atFloor = parsed.kind === "value" && parsed.value <= 1;
  const minimum = minimumTotalCents == null ? null : Math.ceil(minimumTotalCents);
  const minimumMessage =
    minimum == null
      ? null
      : formatMsg("submit.budget.minimum_total", { amount: formatCentsUsd(minimum, locale) });
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

  const estimateLabel = msg(
    preliminary
      ? "submit.budget.estimate_preliminary"
      : feeOnly
        ? "submit.summary.estimate_fee"
        : "submit.summary.estimate_cost",
  );
  const estimateNotes = [
    preliminary ? msg("submit.budget.estimate_preliminary_note") : null,
    msg(runtimeAtCost ? "submit.budget.estimate_note_runtime" : "submit.budget.estimate_note"),
  ]
    .filter(Boolean)
    .join(" ");
  const modelLow = Math.max(0, bracket.lowCents - bracket.runtimeLowCents);
  const modelHigh = Math.max(modelLow, bracket.highCents - bracket.runtimeHighCents);

  // The calculation behind the estimate, step by step from the bracket's trace.
  const { estimateSections, modelSections, runtimeSection, estimateIntro, estimatePrinciples } =
    buildEstimateSections(bracket, locale);

  // The ledger figures are the server's; their layers show how they add up.
  const spent = budget ? sumDecimals(budget.setup_spent_cents, budget.run_spent_cents) : null;
  const ledgerNote = msg("submit.budget.calc.ledger_note");
  const ledgerSteps = budget
    ? {
        setup: {
          label: msg("submit.budget.setup_spent"),
          value: ledgerAmount(budget.setup_spent_cents),
        },
        run: {
          label: msg("submit.budget.run_spent"),
          value: ledgerAmount(budget.run_spent_cents),
        },
        reserved: {
          label: msg("submit.budget.reserved"),
          value: ledgerAmount(budget.reserved_cents),
        },
      }
    : null;
  const remainingSections: CalcSection[] =
    budget && ledgerSteps
      ? [
          {
            steps: [
              {
                label: msg("submit.budget.label"),
                value: budget.uncapped
                  ? msg("submit.budget.uncapped_short")
                  : formatCentsUsd(budget.total_cents, locale),
              },
              ledgerSteps.setup,
              ledgerSteps.run,
              ledgerSteps.reserved,
              {
                label: msg("submit.budget.remaining"),
                formula: msg("submit.budget.calc.ledger_formula"),
                value: ledgerAmount(budget.available_cents),
                result: true,
              },
            ],
            note: ledgerNote,
          },
        ]
      : [];
  const spentSections: CalcSection[] =
    spent != null && ledgerSteps
      ? [
          {
            steps: [
              ledgerSteps.setup,
              ledgerSteps.run,
              {
                label: msg("submit.budget.spent"),
                formula: msg("submit.budget.calc.spent_formula"),
                value: ledgerAmount(spent),
                result: true,
              },
            ],
            note: ledgerNote,
          },
        ]
      : [];
  const reservedSections: CalcSection[] = ledgerSteps
    ? [
        {
          steps: [{ ...ledgerSteps.reserved, formula: msg("submit.budget.reserved_tip") }],
          note: ledgerNote,
        },
      ]
    : [];

  const showLedger = !budgetUncapped && budget != null && spent != null;
  const pendingTotal =
    budget != null &&
    (budget.uncapped !== budgetUncapped ||
      (!budgetUncapped && budget.total_cents !== maxCostCents));
  const showStatus = budgetBusy || budgetError || pendingTotal;

  return (
    <StepCard
      title={msg("submit.budget.label")}
      trailing={
        <Segmented<"limit" | "uncapped">
          size="sm"
          label={msg("submit.budget.label")}
          value={budgetUncapped ? "uncapped" : "limit"}
          onChange={(value) => setBudgetUncapped(value === "uncapped")}
          options={[
            {
              value: "limit",
              label: msg("submit.budget.mode.limit"),
              tip: msg("submit.budget.explainer"),
            },
            {
              value: "uncapped",
              label: msg("submit.budget.mode.uncapped"),
              tip: msg("submit.budget.uncapped.warning"),
            },
          ]}
        />
      }
    >
      {!budgetUncapped && (
        <div className="space-y-2">
          <Label htmlFor="totalBudgetInput" className="sr-only">
            {msg("submit.budget.label")}
          </Label>
          <div
            className={cn(
              "overflow-hidden rounded-xl border bg-background/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_12px_26px_-24px_rgba(15,23,42,0.45)] backdrop-blur-sm transition-[border-color,box-shadow] focus-within:ring-[3px]",
              fieldError
                ? "border-destructive focus-within:border-destructive focus-within:ring-destructive/20"
                : "border-input/90 focus-within:border-ring focus-within:ring-ring/50",
            )}
          >
            <div dir="ltr" className="flex h-12 items-center">
              <button
                type="button"
                onClick={() => nudge(-1)}
                disabled={atFloor}
                className={BUDGET_STEP_BUTTON_CLASS}
                aria-label={msg("shared.number_input.decrease")}
              >
                <Minus className="size-3" />
              </button>
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
                  setMaxCostCents(next.kind === "value" ? next.value : null);
                }}
                placeholder={formatMsg("submit.budget.placeholder", { suggested })}
                dir="ltr"
                className="h-full rounded-none border-0 bg-transparent px-2 text-center text-lg tabular-nums shadow-none backdrop-blur-none md:text-lg focus-visible:border-transparent focus-visible:ring-0"
              />
              <span id="totalBudgetUnit" className="shrink-0 pe-1 text-muted-foreground" dir="auto">
                {unit}
              </span>
              <button
                type="button"
                onClick={() => nudge(1)}
                className={BUDGET_STEP_BUTTON_CLASS}
                aria-label={msg("shared.number_input.increase")}
              >
                <Plus className="size-3" />
              </button>
            </div>
            <div className="border-t border-border/40 bg-[#FAF8F5] px-3.5 py-3">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[#3D2E22]">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#C8A882]/15 text-[#A8895E]">
                    <Gauge className="h-3 w-3" aria-hidden="true" />
                  </span>
                  {estimateLabel}
                </span>
                <Figure
                  label={estimateLabel}
                  value={dollarRange(bracket.lowCents, bracket.highCents)}
                  sections={estimateSections}
                  intro={estimateIntro}
                  principles={estimatePrinciples}
                  className="self-start text-[13px] text-[#3D2E22] sm:self-auto sm:text-end"
                />
              </div>
              <p className="mt-1.5 text-xs leading-snug text-muted-foreground" dir="auto">
                {estimateNotes}
              </p>
            </div>
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
      )}

      {(showLedger || showStatus) && (
        <div className="space-y-2">
          {showLedger && (
            <dl>
              <Row
                icon={Wallet}
                label={msg("submit.budget.remaining")}
                value={ledgerAmount(budget.available_cents)}
                sections={remainingSections}
              />
              {!isZero(spent) && (
                <Row
                  icon={ClockCounterClockwise}
                  label={msg("submit.budget.spent")}
                  value={ledgerAmount(spent)}
                  sections={spentSections}
                />
              )}
              {!isZero(budget.reserved_cents) && (
                <Row
                  icon={Lock}
                  label={msg("submit.budget.reserved")}
                  tip={msg("submit.budget.reserved_tip")}
                  value={ledgerAmount(budget.reserved_cents)}
                  sections={reservedSections}
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
              className="flex items-start gap-1.5 text-xs leading-snug text-destructive"
              dir="auto"
            >
              <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {budgetError}
            </p>
          )}
          {pendingTotal && (
            <p className="text-xs text-muted-foreground" dir="auto">
              {msg("submit.budget.pending_total")}
            </p>
          )}
        </div>
      )}

      {!budgetUncapped && (
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
                value={dollarRange(modelLow, modelHigh)}
                sections={modelSections}
              />
              {runtimeAtCost && runtimeSection && (
                <Row
                  icon={Terminal}
                  label={msg("submit.budget.details.runtime")}
                  value={dollarRange(charge.runtimeLow, charge.runtimeHigh)}
                  sections={[runtimeSection]}
                />
              )}
              {runtimeIncluded && (
                <Row
                  icon={Terminal}
                  label={msg("submit.budget.details.runtime")}
                  value={msg("submit.budget.details.runtime_included")}
                />
              )}
              {budget && !isZero(budget.setup_spent_cents) && (
                <Row
                  icon={ListChecks}
                  label={msg("submit.budget.setup_spent")}
                  value={ledgerAmount(budget.setup_spent_cents)}
                  sections={spentSections}
                />
              )}
              {budget && !isZero(budget.run_spent_cents) && (
                <Row
                  icon={Play}
                  label={msg("submit.budget.run_spent")}
                  value={ledgerAmount(budget.run_spent_cents)}
                  sections={spentSections}
                />
              )}
            </dl>
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p dir="auto">
                {msg("submit.budget.details.assumptions")}{" "}
                {msg("submit.budget.details.reservation")}
              </p>
              {mixedBilling && <p dir="auto">{msg("submit.budget.details.mixed_billing")}</p>}
              {mode === "byok" && <p dir="auto">{msg("submit.budget.byok_note")}</p>}
            </div>
          </div>
        </Disclosure>
      )}
    </StepCard>
  );
}

/** One hairline row in the summary step's style: small icon, muted label, value at the end. */
function Row({
  icon: Icon,
  label,
  value,
  tip,
  sections,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tip?: string;
  /** When given, the value opens these steps in a layer over the card. */
  sections?: CalcSection[];
}) {
  const name = (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      {label}
    </span>
  );
  const valueClass =
    "max-w-[55%] shrink-0 text-end text-sm font-medium wrap-break-word tabular-nums text-foreground";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5">
      <dt className="min-w-0">{tip ? <HelpTip text={tip}>{name}</HelpTip> : name}</dt>
      <dd className={cn(valueClass, "flex justify-end")}>
        {sections && sections.length > 0 ? (
          <Figure label={label} value={value} sections={sections} className="text-sm" />
        ) : (
          <span dir="auto">{value}</span>
        )}
      </dd>
    </div>
  );
}
