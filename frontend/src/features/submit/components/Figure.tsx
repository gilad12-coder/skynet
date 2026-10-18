"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/primitives/dialog";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";

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

/** A figure that opens its calculation in a dialog centred on the screen. */
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
  /** The billing rules the calculation rests on, closing the dialog. */
  principles?: string[];
  className?: string;
}) {
  // A single-section calculation (a details row) reads as one list; the full
  // pipeline is numbered so each stage can be referred to.
  const numbered = sections.length > 1;
  // The dialog's title already names a lone section, so its own heading would
  // only repeat it.
  const shown =
    !numbered && sections[0]?.title === label ? [{ ...sections[0], title: undefined }] : sections;
  return (
    <Dialog>
      <DialogTrigger asChild>
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
      </DialogTrigger>
      <DialogContent
        dir={getActiveDir()}
        className={cn(
          "flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0",
          numbered ? "sm:max-w-[min(40rem,92vw)]" : "sm:max-w-[min(30rem,92vw)]",
        )}
      >
        <div className="shrink-0 border-b border-border/60 px-5 pt-4 pb-3 pe-12">
          <DialogTitle
            className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            dir="auto"
          >
            {label}
          </DialogTitle>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground" dir="auto">
            {value}
          </div>
          {intro ? (
            <DialogDescription className="mt-1.5 text-xs leading-snug" dir="auto">
              {intro}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{label}</DialogDescription>
          )}
        </div>
        <Calculation sections={shown} numbered={numbered} principles={principles} />
      </DialogContent>
    </Dialog>
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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="space-y-5 px-5 py-4">
        {sections.map((section, index) => (
          <section key={section.title ?? index} className="space-y-2.5">
            {section.title && (
              <h4 className="flex items-center gap-2" dir="auto">
                {numbered && (
                  <span
                    aria-hidden="true"
                    className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary-fill text-[10px] font-semibold tabular-nums text-primary-foreground"
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
        <div className="border-t border-border/60 bg-accent/40 px-5 py-3">
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
                  className="mt-[5px] size-1 shrink-0 rounded-full bg-primary-fill"
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
            className="inline-flex flex-col items-center text-center text-[11px] leading-none"
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
    <ol className="flex flex-wrap gap-x-3 gap-y-1">
      {points.map((point) => (
        <li
          key={point.label}
          aria-current={point.active ? "true" : undefined}
          className={cn(
            "inline-flex items-baseline gap-1 text-[11px] leading-snug",
            point.active ? "font-semibold text-primary" : "text-muted-foreground",
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
