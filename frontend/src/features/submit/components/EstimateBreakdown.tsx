"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/primitives/popover";
import { PLATFORM_FEE_FRACTION, formatCredits } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { formatBudgetAmount } from "@/shared/lib/format-budget-amount";
import { cn } from "@/shared/lib/utils";

import { runtimeStartHold, type ChargedBracket, type RoleCostTrace } from "../lib/cost-bracket";

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";

export interface CalcStep {
  label: string;
  value: string;
  formula?: string;
  note?: string;
  /** The line the section resolves to; drawn apart from the inputs above it. */
  result?: boolean;
}

export interface CalcSection {
  title?: string;
  steps: CalcStep[];
  note?: string;
}

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

/**
 * The steps behind the projected estimate, built straight from the bracket's
 * trace so any surface can unfold the same arithmetic the number was computed
 * from. `estimateSections` walks volume → pricing → runtime → total;
 * `modelSections` is the model-only slice (volume → pricing), and
 * `runtimeSection` is the runtime slice on its own, for the details rows that
 * name just the models' or the runtime's share.
 */
export function buildEstimateSections(
  bracket: ChargedBracket,
  locale: string,
): {
  estimateSections: CalcSection[];
  modelSections: CalcSection[];
  runtimeSection: CalcSection | null;
} {
  const { trace, charge } = bracket;
  const runtimeAtCost =
    bracket.runtimeBillingBasis === "at_cost" &&
    bracket.expectedRuntimeSessions > 0 &&
    bracket.runtimeSessionHighCredits > 0;
  const runtimeIncluded = bracket.runtimeBillingBasis === "included_in_model_markup";

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
  const creditSpan = (low: number, high: number) => `${credits(low)}–${credits(high)}`;
  const creditRange = (low: number, high: number) =>
    formatMsg("submit.summary.estimate_range", { low: credits(low), high: credits(high) });

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
  // Show each model's share of the projected tokens and the charge in credits,
  // never the raw provider cost or the markup multiplier that would expose the
  // margin. Shares are normalised so they read as a fraction of the whole run
  // regardless of any grid-sweep multiple carried on tokenShare.
  const totalTokenShare = trace.roles.reduce((sum, role) => sum + role.tokenShare, 0);
  const pricingSection: CalcSection = {
    title: msg("submit.budget.calc.pricing"),
    steps: [
      ...trace.roles.map<CalcStep>((role) => ({
        label: role.modelLabel
          ? `${roleLabel(role.role)} · ${role.modelLabel}`
          : roleLabel(role.role),
        note: role.priced ? undefined : msg("submit.budget.calc.role_unpriced"),
        value: formatMsg("submit.budget.calc.role_share", {
          share: percent(totalTokenShare > 0 ? role.tokenShare / totalTokenShare : 0),
        }),
      })),
      ...(charge.managedHigh > 0
        ? [
            {
              label: msg("submit.budget.calc.managed_total"),
              value: creditRange(charge.managedLow, charge.managedHigh),
              result: true,
            },
          ]
        : []),
      ...(charge.byokFullHigh > 0
        ? [
            {
              label: msg("submit.budget.calc.byok_full"),
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
              hold: credits(runtimeStartHold(bracket)),
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
  return { estimateSections, modelSections, runtimeSection };
}

/** A figure that opens its calculation in a layer over the card. */
export function Figure({
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
