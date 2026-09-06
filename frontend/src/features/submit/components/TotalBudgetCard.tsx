"use client";

import { useEffect, useState, type ComponentType } from "react";

import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/primitives/popover";
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
  WarningCircle,
} from "@/shared/ui/icons";
import {
  CREDIT_USD_VALUE,
  MARKUP,
  PLATFORM_FEE_FRACTION,
  formatCredits,
  formatUsd,
  type TokenSourceMode,
} from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir, getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { cn } from "@/shared/lib/utils";

import { parseBudgetInput } from "../lib/budget-input";
import { chargeableBracket, type RoleCostTrace } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";
import { useExecutionBudget } from "../hooks/use-execution-budget";
import { Disclosure } from "./Disclosure";
import { Segmented, StepCard } from "./blackbox/shared";

/**
 * The one budget surface of both wizards: a spending limit that covers setup
 * checks and the optimization itself. The limit is the decision; the projected
 * usage bracket only supports it, and the arithmetic behind the bracket stays
 * folded away until asked for.
 *
 * Every figure on the card is a trigger: it opens a layer over the card that
 * walks through the calculation behind that number, built from the same trace
 * the bracket was computed from.
 *
 * Mode-aware: managed model roles show their full credit cost; BYOK roles show
 * their platform fee. The required execution environment is included in the
 * estimate in either mode.
 *
 * The limit can also be switched off: the run then draws on the account
 * balance until it finishes, and stops in place if that balance runs out.
 */
type BudgetContext = Pick<
  SubmitWizardContext,
  | "costBracket"
  | "suggestedCeiling"
  | "maxCostCredits"
  | "setMaxCostCredits"
  | "budgetUncapped"
  | "setBudgetUncapped"
> & {
  setupSpent?: number;
  availableCredits?: number | null;
};

interface CalcStep {
  label: string;
  value: string;
  formula?: string;
  note?: string;
  /** The line the section resolves to; drawn apart from the inputs above it. */
  result?: boolean;
}

interface CalcSection {
  title?: string;
  steps: CalcStep[];
  note?: string;
}

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";
const TOKENS_PER_MILLION = 1_000_000;

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

function tierLabel(level: string): string {
  switch (level) {
    case "light":
      return msg("submit.budget.calc.tier.light");
    case "medium":
      return msg("submit.budget.calc.tier.medium");
    case "heavy":
      return msg("submit.budget.calc.tier.heavy");
    default:
      return level;
  }
}

function roleLabel(role: RoleCostTrace["role"]): string {
  switch (role) {
    case "task":
      return msg("submit.budget.calc.role.task");
    case "optimization":
      return msg("submit.budget.calc.role.optimization");
    default:
      return msg("submit.budget.calc.role.judge");
  }
}

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
    maxCostCredits,
    setMaxCostCredits,
    budgetUncapped,
    setBudgetUncapped,
  } = w;
  const { budget, budgetBusy, budgetError, minimumTotalCredits } = useExecutionBudget();
  const locale = getActiveIntlLocale();
  const bracket = chargeableBracket(costBracket, mode);
  const { trace, charge } = bracket;
  const feeOnly = mode === "byok" && bracket.runtimeBillingBasis !== "at_cost";
  const runtimeAtCost =
    bracket.runtimeBillingBasis === "at_cost" &&
    bracket.expectedRuntimeSessions > 0 &&
    bracket.runtimeSessionHighCredits > 0;
  const runtimeIncluded = bracket.runtimeBillingBasis === "included_in_model_markup";
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

  const isolate = (value: string) => `${ISOLATE_START}${value}${ISOLATE_END}`;
  const credits = (value: number) => isolate(formatCredits(value, locale));
  const count = (value: number) =>
    isolate(new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value));
  const factor = (value: number) =>
    isolate(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value));
  const percent = (value: number) =>
    isolate(
      new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value),
    );
  const usd = (value: number) => isolate(formatUsd(value, locale));
  const usdRange = (low: number, high: number) => `${usd(low)}–${usd(high)}`;
  const creditSpan = (low: number, high: number) => `${credits(low)}–${credits(high)}`;
  const creditRange = (low: number, high: number) =>
    formatMsg("submit.summary.estimate_range", { low: credits(low), high: credits(high) });
  const unit = msg("submit.cost_ceiling.cap_unit");
  const withUnit = (amount: string) => `${amount} ${unit}`;
  const ledgerAmount = (amount: string) => withUnit(formatBudgetAmount(amount, locale));
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
  const modelLow = Math.max(0, bracket.lowCredits - bracket.runtimeLowCredits);
  const modelHigh = Math.max(modelLow, bracket.highCredits - bracket.runtimeHighCredits);

  // The calculation behind the estimate, step by step from the bracket's trace.
  const callsFormula = {
    auto_tier: formatMsg("submit.budget.calc.calls_auto", { tier: tierLabel(trace.autoLevel) }),
    metric_calls: msg("submit.budget.calc.calls_explicit"),
    full_evals: formatMsg("submit.budget.calc.calls_evals", {
      evals: count(trace.fullEvals),
      perEval: count(trace.metricCallsPerFullEval),
    }),
    default: msg("submit.budget.calc.calls_default"),
  }[trace.metricCallSource];
  const tokenInputs = {
    calls: count(trace.metricCalls),
    low: count(trace.tokensPerCallLow),
    high: count(trace.tokensPerCallHigh),
    factor: factor(trace.rowFactor),
  };
  const volumeSection: CalcSection = {
    title: msg("submit.budget.calc.volume"),
    steps: [
      {
        label: msg("submit.budget.calc.calls"),
        formula: callsFormula,
        value: count(trace.metricCalls),
      },
      {
        label: msg("submit.budget.calc.dataset_factor"),
        formula: formatMsg("submit.budget.calc.dataset_factor_formula", {
          rows: count(trace.datasetRows),
          cap: count(trace.datasetRowCap),
        }),
        value: `×${factor(trace.rowFactor)}`,
      },
      {
        label: msg("submit.budget.calc.tokens"),
        formula:
          trace.reflectionHighMultiplier > 1
            ? formatMsg("submit.budget.calc.tokens_formula_reflection", {
                ...tokenInputs,
                multiplier: factor(trace.reflectionHighMultiplier),
              })
            : formatMsg("submit.budget.calc.tokens_formula", tokenInputs),
        value: formatMsg("submit.budget.calc.tokens_value", {
          low: count(trace.lowTokens),
          high: count(trace.highTokens),
        }),
        result: true,
      },
    ],
  };
  const roleUsd = (source: TokenSourceMode, end: "lowUsd" | "highUsd") =>
    trace.roles
      .filter((role) => role.tokenSource === source)
      .reduce((sum, role) => sum + role[end], 0);
  const conversion = (low: number, high: number) =>
    formatMsg("submit.budget.calc.credits_conversion", {
      cost: usdRange(low, high),
      markup: factor(MARKUP),
      credit: usd(CREDIT_USD_VALUE),
    });
  const pricingSection: CalcSection = {
    title: msg("submit.budget.calc.pricing"),
    steps: [
      ...trace.roles.map<CalcStep>((role) => ({
        label: role.modelLabel
          ? `${roleLabel(role.role)} · ${role.modelLabel}`
          : roleLabel(role.role),
        formula: formatMsg("submit.budget.calc.role_formula", {
          share: percent(role.tokenShare),
          inputShare: percent(trace.inputTokenShare),
          inputRate: usd(role.inputCostPerToken * TOKENS_PER_MILLION),
          outputShare: percent(1 - trace.inputTokenShare),
          outputRate: usd(role.outputCostPerToken * TOKENS_PER_MILLION),
        }),
        note: role.priced ? undefined : msg("submit.budget.calc.role_unpriced"),
        value: usdRange(role.lowUsd, role.highUsd),
      })),
      ...(charge.managedHigh > 0
        ? [
            {
              label: msg("submit.budget.calc.managed_total"),
              formula: conversion(roleUsd("managed", "lowUsd"), roleUsd("managed", "highUsd")),
              value: creditRange(charge.managedLow, charge.managedHigh),
              result: true,
            },
          ]
        : []),
      ...(charge.byokFullHigh > 0
        ? [
            {
              label: msg("submit.budget.calc.byok_full"),
              formula: conversion(roleUsd("byok", "lowUsd"), roleUsd("byok", "highUsd")),
              value: creditRange(charge.byokFullLow, charge.byokFullHigh),
            },
            {
              label: msg("submit.budget.calc.byok_fee"),
              formula: formatMsg("submit.budget.calc.byok_fee_formula", {
                fraction: percent(PLATFORM_FEE_FRACTION),
                full: creditSpan(charge.byokFullLow, charge.byokFullHigh),
              }),
              value: creditRange(charge.byokFeeLow, charge.byokFeeHigh),
              result: true,
            },
          ]
        : []),
    ],
  };
  const runtimeSection: CalcSection | null = runtimeAtCost
    ? {
        title: msg("submit.budget.details.runtime"),
        steps: [
          {
            label: msg("submit.runtime.vercel"),
            formula: formatMsg("submit.budget.calc.runtime_formula", {
              low: isolate(formatBudgetAmount(bracket.runtimeSessionLowCredits.toFixed(9), locale)),
              high: isolate(
                formatBudgetAmount(bracket.runtimeSessionHighCredits.toFixed(9), locale),
              ),
              sessions: count(bracket.expectedRuntimeSessions),
            }),
            value: creditRange(charge.runtimeLow, charge.runtimeHigh),
            result: true,
          },
        ],
      }
    : runtimeIncluded
      ? {
          title: msg("submit.budget.details.runtime"),
          steps: [
            {
              label: msg("submit.runtime.vercel"),
              value: msg("submit.budget.details.runtime_included"),
            },
          ],
        }
      : null;
  const totalSection: CalcSection = {
    steps: [
      {
        label: msg("submit.budget.calc.total"),
        formula: msg("submit.budget.calc.total_formula"),
        value: creditRange(bracket.lowCredits, bracket.highCredits),
        result: true,
      },
    ],
  };
  const estimateSections = [
    volumeSection,
    pricingSection,
    ...(runtimeSection ? [runtimeSection] : []),
    totalSection,
  ];
  const modelSections = [volumeSection, pricingSection];

  // The ledger figures are the server's; their layers show how they add up.
  const spent = budget ? sumDecimals(budget.setup_spent_credits, budget.run_spent_credits) : null;
  const ledgerNote = msg("submit.budget.calc.ledger_note");
  const ledgerSteps = budget
    ? {
        setup: {
          label: msg("submit.budget.setup_spent"),
          value: ledgerAmount(budget.setup_spent_credits),
        },
        run: {
          label: msg("submit.budget.run_spent"),
          value: ledgerAmount(budget.run_spent_credits),
        },
        reserved: {
          label: msg("submit.budget.reserved"),
          value: ledgerAmount(budget.reserved_credits),
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
                  : withUnit(formatCredits(budget.total_credits, locale)),
              },
              ledgerSteps.setup,
              ledgerSteps.run,
              ledgerSteps.reserved,
              {
                label: msg("submit.budget.remaining"),
                formula: msg("submit.budget.calc.ledger_formula"),
                value: ledgerAmount(budget.available_credits),
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

  const showLedger = budget != null && spent != null;
  const pendingTotal =
    budget != null &&
    (budget.uncapped !== budgetUncapped ||
      (!budgetUncapped && budget.total_credits !== maxCostCredits));
  const showStatus = budgetBusy || budgetError || pendingTotal;

  return (
    <StepCard
      title={msg("submit.budget.label")}
      trailing={
        <Segmented<"limit" | "uncapped">
          compact
          label={msg("submit.budget.label")}
          value={budgetUncapped ? "uncapped" : "limit"}
          onChange={(value) => setBudgetUncapped(value === "uncapped")}
          options={[
            { value: "limit", label: msg("submit.budget.mode.limit") },
            { value: "uncapped", label: msg("submit.budget.mode.uncapped") },
          ]}
        />
      }
    >
      {budgetUncapped ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-[#C8A882]/45 bg-[#C8A882]/10 px-3.5 py-3 text-xs leading-relaxed text-[#3D2E22]"
          dir="auto"
        >
          <WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {msg("submit.budget.uncapped.warning")}
        </p>
      ) : (
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
      )}

      <div className="rounded-xl border border-[#C8B9A8]/50 bg-background px-3.5 py-3 shadow-[0_1px_2px_rgba(61,46,34,0.04)]">
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-[#3D2E22]">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#C8A882]/15 text-[#A8895E]">
              <Gauge className="h-3 w-3" aria-hidden="true" />
            </span>
            {estimateLabel}
          </span>
          <Figure
            label={estimateLabel}
            value={creditRange(bracket.lowCredits, bracket.highCredits)}
            sections={estimateSections}
            className="self-start text-[13px] text-[#3D2E22] sm:self-auto sm:text-end"
          />
        </div>
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground" dir="auto">
          {estimateNotes}
        </p>
      </div>

      {(showLedger || showStatus) && (
        <div className="space-y-2">
          {showLedger && (
            <dl>
              <Row
                icon={Wallet}
                label={msg("submit.budget.remaining")}
                value={ledgerAmount(budget.available_credits)}
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
              {!isZero(budget.reserved_credits) && (
                <Row
                  icon={Lock}
                  label={msg("submit.budget.reserved")}
                  tip={msg("submit.budget.reserved_tip")}
                  value={ledgerAmount(budget.reserved_credits)}
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
              className="flex items-start gap-2 text-xs leading-snug text-destructive"
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
              value={creditRange(modelLow, modelHigh)}
              sections={modelSections}
            />
            {runtimeAtCost && runtimeSection && (
              <Row
                icon={Terminal}
                label={msg("submit.budget.details.runtime")}
                value={formatMsg("submit.budget.details.up_to", {
                  amount: credits(bracket.runtimeHighCredits),
                })}
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
            {budget && !isZero(budget.setup_spent_credits) && (
              <Row
                icon={ListChecks}
                label={msg("submit.budget.setup_spent")}
                value={ledgerAmount(budget.setup_spent_credits)}
                sections={spentSections}
              />
            )}
            {budget && !isZero(budget.run_spent_credits) && (
              <Row
                icon={Play}
                label={msg("submit.budget.run_spent")}
                value={ledgerAmount(budget.run_spent_credits)}
                sections={spentSections}
              />
            )}
          </dl>
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p dir="auto">
              {msg("submit.budget.details.assumptions")} {msg("submit.budget.details.reservation")}
            </p>
            {mixedBilling && <p dir="auto">{msg("submit.budget.details.mixed_billing")}</p>}
            {mode === "byok" && <p dir="auto">{msg("submit.budget.byok_note")}</p>}
          </div>
        </div>
      </Disclosure>
    </StepCard>
  );
}

/** A figure that opens its calculation in a layer over the card. */
function Figure({
  label,
  value,
  sections,
  className,
}: {
  label: string;
  value: string;
  sections: CalcSection[];
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={msg("submit.budget.calc.show")}
          dir="auto"
          className={cn(
            "cursor-pointer rounded-sm font-medium tabular-nums underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors",
            "hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "data-[state=open]:decoration-solid data-[state=open]:decoration-foreground",
            className,
          )}
        >
          {value}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        dir={getActiveDir()}
        className="w-[min(28rem,calc(100vw-1.5rem))] p-0"
      >
        <div className="border-b border-border/60 px-4 py-3">
          <div
            className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            dir="auto"
          >
            {label}
          </div>
          <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground" dir="auto">
            {value}
          </div>
        </div>
        <Calculation sections={sections} />
      </PopoverContent>
    </Popover>
  );
}

/** The steps behind a figure: label and formula at the start, the value at the end. */
function Calculation({ sections }: { sections: CalcSection[] }) {
  return (
    <div className="max-h-[min(70vh,30rem)] space-y-4 overflow-y-auto px-4 py-3">
      {sections.map((section, index) => (
        <section key={section.title ?? index} className="space-y-2">
          {section.title && (
            <h4
              className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase"
              dir="auto"
            >
              {section.title}
            </h4>
          )}
          {section.steps.map((step, position) => (
            <div
              key={`${position}-${step.label}`}
              className={cn(
                "flex items-baseline justify-between gap-4",
                step.result && position > 0 && "border-t border-border/50 pt-2",
              )}
            >
              <div className="min-w-0" dir="auto">
                <div className={cn("text-xs text-foreground", step.result && "font-medium")}>
                  {step.label}
                </div>
                {step.formula && (
                  <div className="text-[11px] leading-snug text-muted-foreground">
                    {step.formula}
                  </div>
                )}
                {step.note && (
                  <div className="text-[11px] leading-snug text-muted-foreground/80">
                    {step.note}
                  </div>
                )}
              </div>
              <div
                className="shrink-0 text-end text-xs font-medium tabular-nums text-foreground"
                dir="auto"
              >
                {step.value}
              </div>
            </div>
          ))}
          {section.note && (
            <p className="text-[11px] leading-snug text-muted-foreground" dir="auto">
              {section.note}
            </p>
          )}
        </section>
      ))}
    </div>
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
