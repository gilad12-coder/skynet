"use client";

import { useId } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/primitives/popover";
import {
  PLATFORM_FEE_FRACTION,
  creditsToUsd,
  formatBudgetUsd,
  formatUsd,
  type TokenSourceMode,
} from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";

import {
  AUTO_METRIC_CALLS,
  defaultCeilingTrace,
  runtimeStartHold,
  type ChargedBracket,
  type RoleCostTrace,
} from "../lib/cost-bracket";

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";
const TOKENS_PER_MILLION = 1_000_000;

/** One term of an equation: a value with an optional caption naming it, or an operator between terms. */
type Operand = { value: string; caption?: string } | { op: string };

/** One position on a scale of choices, marking the one in effect. */
interface ScalePoint {
  label: string;
  value: string;
  active: boolean;
}

interface CalcStep {
  label: string;
  value: string;
  /** A prose reading of the arithmetic, when an equation would say less. */
  formula?: string;
  /** The arithmetic as terms and operators, rendered left-to-right. */
  equation?: Operand[];
  /** The other choices this step's input could have taken. */
  scale?: ScalePoint[];
  /** The reason behind this step's constants or method. */
  why?: string;
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
 * from. `estimateSections` walks volume → cost → runtime → total → suggested
 * limit; `modelSections` is the model-only slice (volume → cost), and
 * `runtimeSection` is the runtime slice on its own, for the details rows that
 * name just the models' or the runtime's share. `estimateIntro` frames what
 * the range is, and `estimatePrinciples` state the billing rules it rests on.
 */
export function buildEstimateSections(
  bracket: ChargedBracket,
  locale: string,
): {
  estimateSections: CalcSection[];
  modelSections: CalcSection[];
  runtimeSection: CalcSection | null;
  estimateIntro: string;
  estimatePrinciples: string[];
} {
  const { trace, charge } = bracket;
  const runtimeAtCost =
    bracket.runtimeBillingBasis === "at_cost" &&
    bracket.expectedRuntimeSessions > 0 &&
    bracket.runtimeSessionHighCredits > 0;
  const runtimeIncluded = bracket.runtimeBillingBasis === "included_in_model_markup";
  const hasByok = charge.byokFullHigh > 0;
  const hasManaged = charge.managedHigh > 0;

  const isolate = (value: string) => `${ISOLATE_START}${value}${ISOLATE_END}`;
  // Charges live in credits internally; every figure is shown in dollars (a
  // credit is one cent at par), so a credit count renders as its USD value.
  const credits = (value: number) => isolate(formatUsd(creditsToUsd(value), locale));
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
  const times = { op: "×" };
  const plus = { op: "+" };
  const equals = { op: "=" };

  const callsFormula = {
    auto_tier: formatMsg("submit.budget.calc.calls_auto", { tier: tierLabel(trace.autoLevel) }),
    metric_calls: msg("submit.budget.calc.calls_explicit"),
    full_evals: formatMsg("submit.budget.calc.calls_evals", {
      evals: count(trace.fullEvals),
      perEval: count(trace.metricCallsPerFullEval),
    }),
    default: msg("submit.budget.calc.calls_default"),
  }[trace.metricCallSource];
  // The tier scale is shown whenever the budget is tier-shaped (auto or default)
  // so the user sees where their choice sits; an explicit budget stands alone.
  const tierScale =
    trace.metricCallSource === "auto_tier" || trace.metricCallSource === "default"
      ? Object.entries(AUTO_METRIC_CALLS).map(([level, calls]) => ({
          label: tierLabel(level),
          value: count(calls),
          active: calls === trace.metricCalls,
        }))
      : undefined;
  const cappedRows = Math.min(trace.datasetRows, trace.datasetRowCap);
  const tokensPerCall = `${count(trace.tokensPerCallLow)}–${count(trace.tokensPerCallHigh)}`;
  const volumeSection: CalcSection = {
    title: msg("submit.budget.calc.volume"),
    steps: [
      {
        label: msg("submit.budget.calc.calls"),
        formula: callsFormula,
        scale: tierScale,
        why: msg("submit.budget.calc.calls_why"),
        value: count(trace.metricCalls),
      },
      {
        label: msg("submit.budget.calc.dataset_factor"),
        // Ordered so a plain left-to-right reading and operator precedence
        // agree: rows ÷ cap first, then + 1.
        equation: [
          { value: count(cappedRows), caption: msg("submit.budget.calc.term.rows_capped") },
          { op: "÷" },
          { value: count(trace.datasetRowCap), caption: msg("submit.budget.calc.term.row_cap") },
          plus,
          { value: "1" },
        ],
        formula: formatMsg("submit.budget.calc.dataset_factor_rows", {
          rows: count(trace.datasetRows),
        }),
        why: msg("submit.budget.calc.dataset_factor_why"),
        value: `×${factor(trace.rowFactor)}`,
      },
      {
        label: msg("submit.budget.calc.tokens"),
        equation: [
          { value: count(trace.metricCalls), caption: msg("submit.budget.calc.term.calls") },
          times,
          { value: tokensPerCall, caption: msg("submit.budget.calc.term.tokens_per_call") },
          times,
          {
            value: factor(trace.rowFactor),
            caption: msg("submit.budget.calc.term.dataset_factor"),
          },
          ...(trace.reflectionHighMultiplier > 1
            ? [
                times,
                {
                  value: `1–${factor(trace.reflectionHighMultiplier)}`,
                  caption: msg("submit.budget.calc.term.reflection"),
                },
              ]
            : []),
        ],
        why: msg(
          trace.reflectionHighMultiplier > 1
            ? "submit.budget.calc.tokens_why_reflection"
            : "submit.budget.calc.tokens_why",
        ),
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
    });
  const sumOf = (terms: Operand[]) =>
    terms.flatMap((term, index) => (index === 0 ? [term] : [plus, term]));
  // A subtotal over a single role is that role's line restated, so only a
  // sum of two or more roles is worth spelling out as addends.
  const roleAddends = (source: TokenSourceMode): Operand[] | undefined => {
    const roles = trace.roles.filter((role) => role.tokenSource === source);
    return roles.length > 1
      ? sumOf(
          roles.map((role) => ({
            value: usdRange(role.lowUsd, role.highUsd),
            caption: roleLabel(role.role),
          })),
        )
      : undefined;
  };
  // Rates are quoted per million tokens, so the volume is stated in millions
  // too and the three terms multiply out literally to the dollar figure.
  const millions = (tokens: number) =>
    isolate(
      new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }).format(
        tokens / TOKENS_PER_MILLION,
      ),
    );
  const projectedMillions = `${millions(trace.lowTokens)}–${millions(trace.highTokens)}`;
  const roleSteps = trace.roles.map<CalcStep>((role) => {
    // A role's share is a raw multiple of the projected volume (roles may each
    // run all of it), so it is shown as-is rather than normalized to the whole.
    // Folding the input/output split into one blended rate keeps the equation
    // three terms long and checkable: tokens × share × rate = cost.
    const blendedPerMillion =
      (trace.inputTokenShare * role.inputCostPerToken +
        (1 - trace.inputTokenShare) * role.outputCostPerToken) *
      TOKENS_PER_MILLION;
    return {
      label: role.modelLabel
        ? `${roleLabel(role.role)} · ${role.modelLabel}`
        : roleLabel(role.role),
      equation: [
        { value: projectedMillions, caption: msg("submit.budget.calc.term.million_tokens") },
        times,
        { value: percent(role.tokenShare), caption: msg("submit.budget.calc.term.role_share") },
        times,
        { value: usd(blendedPerMillion), caption: msg("submit.budget.calc.term.blended_rate") },
      ],
      formula: formatMsg("submit.budget.calc.role_rate_split", {
        inputShare: percent(trace.inputTokenShare),
        inputRate: usd(role.inputCostPerToken * TOKENS_PER_MILLION),
        outputShare: percent(1 - trace.inputTokenShare),
        outputRate: usd(role.outputCostPerToken * TOKENS_PER_MILLION),
        source: msg(
          role.tokenSource === "byok"
            ? "submit.budget.calc.role_source_byok"
            : "submit.budget.calc.role_source_managed",
        ),
      }),
      note: role.priced ? undefined : msg("submit.budget.calc.role_unpriced"),
      value: usdRange(role.lowUsd, role.highUsd),
    };
  });
  const pricingSection: CalcSection = {
    title: msg("submit.budget.calc.pricing"),
    steps: [
      ...roleSteps.map((step, index) =>
        // The input/output split is one rule for every role; explain it once,
        // under the last role so it reads as a footnote to all of them.
        index === roleSteps.length - 1
          ? { ...step, why: msg("submit.budget.calc.role_why") }
          : step,
      ),
      ...(hasManaged
        ? [
            {
              label: msg("submit.budget.calc.managed_total"),
              equation: roleAddends("managed"),
              formula: conversion(roleUsd("managed", "lowUsd"), roleUsd("managed", "highUsd")),
              why: msg("submit.budget.calc.managed_why"),
              value: creditRange(charge.managedLow, charge.managedHigh),
              result: true,
            },
          ]
        : []),
      ...(hasByok
        ? [
            {
              label: msg("submit.budget.calc.byok_full"),
              equation: roleAddends("byok"),
              formula: conversion(roleUsd("byok", "lowUsd"), roleUsd("byok", "highUsd")),
              value: creditRange(charge.byokFullLow, charge.byokFullHigh),
            },
            {
              label: msg("submit.budget.calc.byok_fee"),
              equation: [
                {
                  value: percent(PLATFORM_FEE_FRACTION),
                  caption: msg("submit.budget.calc.term.fee_rate"),
                },
                times,
                {
                  value: creditSpan(charge.byokFullLow, charge.byokFullHigh),
                  caption: msg("submit.budget.calc.term.byok_cost"),
                },
              ],
              formula: msg("submit.budget.calc.rounded_up_cent"),
              why: msg("submit.budget.calc.byok_fee_why"),
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
            equation: [
              {
                value: isolate(
                  formatBudgetUsd(bracket.runtimeSessionHighCredits.toFixed(9), locale),
                ),
                caption: msg("submit.budget.calc.term.per_session_max"),
              },
              times,
              {
                value: count(bracket.expectedRuntimeSessions),
                caption: msg("submit.budget.calc.term.sessions"),
              },
            ],
            formula: formatMsg("submit.budget.calc.runtime_hold", {
              hold: credits(runtimeStartHold(bracket)),
            }),
            why: msg("submit.budget.calc.runtime_why"),
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
              why: msg("submit.budget.calc.runtime_included_why"),
              value: msg("submit.budget.details.runtime_included"),
            },
          ],
        }
      : null;
  // The total is shown as the addends that make it, so it can be checked
  // against the lines above rather than taken on faith.
  const addends: Operand[] = sumOf([
    ...(hasManaged
      ? [
          {
            value: creditSpan(charge.managedLow, charge.managedHigh),
            caption: msg("submit.budget.calc.term.models"),
          },
        ]
      : []),
    ...(hasByok
      ? [
          {
            value: creditSpan(charge.byokFeeLow, charge.byokFeeHigh),
            caption: msg("submit.budget.calc.term.fee_rate"),
          },
        ]
      : []),
    ...(runtimeAtCost
      ? [
          {
            value: creditSpan(charge.runtimeLow, charge.runtimeHigh),
            caption: msg("submit.budget.calc.term.runtime"),
          },
        ]
      : []),
  ]);
  const ceiling = defaultCeilingTrace(bracket);
  // With a single addend the total is that line over again; the stage only
  // earns its place when it sums several lines or the one-cent floor binds.
  const totalSection: CalcSection | null =
    addends.length > 1 || bracket.lowCredits <= 1
      ? {
          title: msg("submit.budget.calc.total"),
          steps: [
            {
              label: msg("submit.budget.calc.total_range"),
              equation: addends.length > 1 ? addends : undefined,
              // The one-cent floor only matters when it is what set the low end.
              formula: bracket.lowCredits <= 1 ? msg("submit.budget.calc.total_floor") : undefined,
              value: creditRange(bracket.lowCredits, bracket.highCredits),
              result: true,
            },
          ],
        }
      : null;
  const limitSection: CalcSection = {
    title: msg("submit.budget.calc.suggested_limit"),
    steps: [
      {
        label: msg("submit.budget.calc.suggested_limit_default"),
        equation: [
          { value: credits(ceiling.highCredits), caption: msg("submit.budget.calc.term.high_end") },
          times,
          {
            value: factor(ceiling.headroomFactor),
            caption: msg("submit.budget.calc.term.headroom"),
          },
          equals,
          { value: credits(ceiling.withHeadroomCredits) },
        ],
        formula: formatMsg("submit.budget.calc.suggested_limit_rounding", {
          step: credits(ceiling.stepCredits),
        }),
        why: msg("submit.budget.calc.suggested_limit_why"),
        value: credits(ceiling.ceilingCredits),
      },
    ],
  };
  const estimateSections = [
    volumeSection,
    pricingSection,
    ...(runtimeSection ? [runtimeSection] : []),
    ...(totalSection ? [totalSection] : []),
    limitSection,
  ];
  const modelSections = [volumeSection, pricingSection];
  const estimatePrinciples = [
    msg("submit.budget.calc.principle.at_cost"),
    msg("submit.budget.calc.principle.rounding"),
    msg("submit.budget.details.reservation"),
    msg("submit.budget.calc.principle.never_above"),
    ...(hasByok && hasManaged ? [msg("submit.budget.details.mixed_billing")] : []),
  ];
  return {
    estimateSections,
    modelSections,
    runtimeSection,
    estimateIntro: msg("submit.budget.calc.intro"),
    estimatePrinciples,
  };
}

/** A figure that opens its calculation in a layer over the card. */
export function Figure({
  label,
  value,
  sections,
  intro,
  principles,
  className,
}: {
  label: string;
  value: string;
  sections: CalcSection[];
  /** What the figure is and is not, shown under it before the steps. */
  intro?: string;
  /** The billing rules the calculation rests on, closing the layer. */
  principles?: string[];
  className?: string;
}) {
  const headingId = useId();
  // A single-section layer (a details row) reads as one list; the full
  // pipeline is numbered so each stage can be referred to.
  const numbered = sections.length > 1;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          dir="auto"
          className={cn(
            "cursor-pointer rounded-sm font-medium tabular-nums underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors",
            "hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "data-[state=open]:decoration-solid data-[state=open]:decoration-foreground",
            className,
          )}
        >
          {value}
          <span className="sr-only">, {msg("submit.budget.calc.show")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        dir={getActiveDir()}
        aria-labelledby={headingId}
        className={cn(
          "p-0",
          numbered ? "w-[min(36rem,calc(100vw-1.5rem))]" : "w-[min(28rem,calc(100vw-1.5rem))]",
        )}
      >
        <div className="border-b border-border/60 px-4 py-3">
          <div
            id={headingId}
            className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            dir="auto"
          >
            {label}
          </div>
          <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground" dir="auto">
            {value}
          </div>
          {intro && (
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground" dir="auto">
              {intro}
            </p>
          )}
        </div>
        <Calculation sections={sections} numbered={numbered} principles={principles} />
      </PopoverContent>
    </Popover>
  );
}

/** The steps behind a figure: label and working at the start, the value at the end. */
function Calculation({
  sections,
  numbered,
  principles,
}: {
  sections: CalcSection[];
  numbered: boolean;
  principles?: string[];
}) {
  return (
    <div className="max-h-[min(70vh,34rem)] overflow-y-auto overscroll-contain">
      <div className="space-y-5 px-4 py-3">
        {sections.map((section, index) => (
          <section key={section.title ?? index} className="space-y-2.5">
            {section.title && (
              <h4 className="flex items-center gap-2" dir="auto">
                {numbered && (
                  <span
                    aria-hidden="true"
                    className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[#C8A882]/15 text-[10px] font-semibold tabular-nums text-[#A8895E]"
                  >
                    {index + 1}
                  </span>
                )}
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
                  {section.title}
                </span>
              </h4>
            )}
            <div className={cn("space-y-2.5", numbered && "ps-6.5")}>
              {section.steps.map((step, position) => (
                <Step key={`${position}-${step.label}`} step={step} divided={position > 0} />
              ))}
              {section.note && (
                <p className="text-[11px] leading-snug text-muted-foreground" dir="auto">
                  {section.note}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
      {principles && principles.length > 0 && (
        <div className="border-t border-border/60 bg-accent/40 px-4 py-3">
          <h4
            className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase"
            dir="auto"
          >
            {msg("submit.budget.calc.principles")}
          </h4>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-snug text-muted-foreground">
            {principles.map((principle) => (
              <li key={principle} className="flex gap-2" dir="auto">
                <span
                  aria-hidden="true"
                  className="mt-[5px] size-1 shrink-0 rounded-full bg-[#C8A882]"
                />
                <span>{principle}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Step({ step, divided }: { step: CalcStep; divided: boolean }) {
  return (
    <div
      className={cn("space-y-1.5", step.result && divided && "border-t border-border/50 pt-2.5")}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0" dir="auto">
          <div className={cn("text-xs text-foreground", step.result && "font-medium")}>
            {step.label}
          </div>
          {step.formula && (
            <div className="text-[11px] leading-snug text-muted-foreground">{step.formula}</div>
          )}
        </div>
        <div
          className={cn(
            "max-w-[55%] shrink-0 text-end text-xs font-medium wrap-break-word tabular-nums text-foreground",
            step.result && "text-[13px] font-semibold",
          )}
          dir="auto"
        >
          {step.value}
        </div>
      </div>
      {step.scale && <Scale points={step.scale} />}
      {step.equation && <Equation terms={step.equation} />}
      {step.why && (
        <p className="text-[11px] leading-snug text-muted-foreground/80" dir="auto">
          {step.why}
        </p>
      )}
      {step.note && (
        <p className="text-[11px] leading-snug text-muted-foreground/80" dir="auto">
          {step.note}
        </p>
      )}
    </div>
  );
}

/**
 * An equation as a row of term chips; always left-to-right, the way arithmetic
 * reads, but flush with the reading edge of the surrounding text so it sits
 * with the step in either direction.
 */
function Equation({ terms }: { terms: Operand[] }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-1.5 gap-y-1.5",
        getActiveDir() === "rtl" && "justify-end",
      )}
      dir="ltr"
    >
      {terms.map((term, index) =>
        "op" in term ? (
          <span key={index} className="self-center text-[11px] text-muted-foreground/70">
            {term.op}
          </span>
        ) : (
          <span
            key={index}
            className="inline-flex flex-col items-center rounded-md border border-border/50 bg-background px-1.5 py-1 text-center text-[11px] leading-none"
          >
            <span className="font-medium tabular-nums text-foreground">{term.value}</span>
            {term.caption && (
              <span className="mt-1 text-[10px] text-muted-foreground" dir="auto">
                {term.caption}
              </span>
            )}
          </span>
        ),
      )}
    </div>
  );
}

/** The choices an input could have taken, with the one in effect filled in. */
function Scale({ points }: { points: ScalePoint[] }) {
  return (
    <ol className="flex flex-wrap gap-1">
      {points.map((point) => (
        <li
          key={point.label}
          aria-current={point.active ? "true" : undefined}
          className={cn(
            "inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-snug",
            point.active
              ? "border-[#C8A882]/40 bg-[#C8A882]/15 text-[#3D2E22]"
              : "border-border/50 text-muted-foreground",
          )}
          dir="auto"
        >
          <span>{point.label}</span>
          <span className="tabular-nums">{point.value}</span>
        </li>
      ))}
    </ol>
  );
}
