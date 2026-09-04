"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { cn } from "@/shared/lib/utils";
import { getActiveDir } from "@/shared/lib/runtime-locale";

export interface WizardSubstep {
  id: string;
  label: string;
}

interface WizardSubstepsProps {
  active: number;
  ariaLabel: string;
  children: ReactNode;
  idPrefix: string;
  onSelect: (index: number) => void;
  steps: readonly WizardSubstep[];
}

/** Present one compact decision at a time inside a top-level wizard stage. */
export function WizardSubsteps({
  active,
  ariaLabel,
  children,
  idPrefix,
  onSelect,
  steps,
}: WizardSubstepsProps) {
  const reducedMotion = useReducedMotion();
  const current = steps[active] ?? steps[0] ?? { id: "current", label: "" };
  const panelId = `${idPrefix}-panel-${current.id}`;

  return (
    <section className="space-y-4" aria-label={ariaLabel}>
      <div className="rounded-2xl border border-border/55 bg-card/75 p-2 shadow-sm backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3 px-2 pb-2 pt-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {ariaLabel}
          </p>
          <p className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {active + 1} / {steps.length}
          </p>
        </div>
        <div
          role="tablist"
          aria-label={ariaLabel}
          className="flex gap-1 overflow-x-auto rounded-xl bg-muted/45 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:[&>button]:flex-1"
        >
          {steps.map((step, index) => {
            const selected = index === active;
            return (
              <button
                key={step.id}
                id={`${idPrefix}-tab-${step.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel-${step.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(index)}
                onKeyDown={(event) => {
                  const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
                  if (!horizontal && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const rtl = getActiveDir() === "rtl";
                  const last = steps.length - 1;
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : event.key === (rtl ? "ArrowLeft" : "ArrowRight")
                          ? (index + 1) % steps.length
                          : (index - 1 + steps.length) % steps.length;
                  const tabs =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    );
                  onSelect(next);
                  tabs?.[next]?.focus();
                }}
                className={cn(
                  "flex min-h-[44px] min-w-max items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                  selected
                    ? "border-primary/15 bg-background text-foreground shadow-sm"
                    : "border-transparent text-muted-foreground hover:bg-background/55 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] tabular-nums",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-border/70 text-foreground/70",
                  )}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span>{step.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.id}
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-tab-${current.id}`}
          className="scroll-mt-24 outline-none"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
          transition={{ duration: reducedMotion ? 0 : 0.14 }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
