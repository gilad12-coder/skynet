"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";

import { getActiveDir } from "@/shared/lib/runtime-locale";

import { slideVariants } from "../../constants";
import { ExecutionBudgetProvider } from "../../hooks/use-execution-budget";
import { WizardV2Provider, useWizardV2Shell, v2Text } from "../../hooks/use-unified-wizard";
import { stepPages } from "../../lib/wizard-pages";
import { WIZARD_V2_STEPS, type WizardStepId } from "../../lib/wizard-v2";
import { WIZARD_STAGE } from "../../lib/wizard-steps";
import { SubmitNav } from "../SubmitNav";
import { SubmitSplash } from "../SubmitSplash";
import { SubmitStepper } from "../SubmitStepper";
import { InputsStep } from "./InputsStep";
import { MetricStep } from "./MetricStep";
import { OptimizerStep } from "./OptimizerStep";
import { TaskStep } from "./TaskStep";

const STEP_VIEWS: Record<WizardStepId, (page: number) => ReactNode> = {
  task: (page) => <TaskStep page={page} />,
  inputs: (page) => <InputsStep page={page} />,
  optimizer: (page) => <OptimizerStep page={page} />,
  metric: (page) => <MetricStep page={page} />,
};

const FIRST_PAGES: Record<WizardStepId, number> = { task: 0, inputs: 0, optimizer: 0, metric: 0 };

// Arrow keys page the wizard only when they have no job where focus sits:
// fields, editors, radio groups, tabs, menus and open dialogs keep them.
const ARROW_OWNERS =
  'input, textarea, select, [contenteditable="true"], .cm-editor, [role="radio"], [role="radiogroup"], [role="tab"], [role="slider"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="combobox"], [role="dialog"]';

function arrowsBelongElsewhere(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_OWNERS) !== null;
}

// The task and metric steps hold a chat or a code workspace beside the form.
const WIDE_STEPS = new Set<WizardStepId>(["task", "metric"]);

function UnifiedWizardFrame() {
  const w = useWizardV2Shell();
  const current = w.state.step;
  const index = WIZARD_STAGE[current];
  // The slide direction follows the last move: forward slides one way, back the other.
  const [shownIndex, setShownIndex] = useState(index);
  const [direction, setDirection] = useState(1);
  if (shownIndex !== index) {
    setDirection(index > shownIndex ? 1 : -1);
    setShownIndex(index);
  }
  // Visited steps stay mounted (hidden while inactive) so going back never
  // drops the metric step's agent chat or the code editors' undo history.
  const [visited, setVisited] = useState<ReadonlySet<WizardStepId>>(() => new Set([current]));
  if (!visited.has(current)) setVisited(new Set([...visited, current]));
  const runDisabledReason = w.runBlockedReason ? v2Text(w.runBlockedReason, w.guided) : null;

  // Each step is a run of screens; the arrows walk them, then cross steps.
  const [pages, setPages] = useState(FIRST_PAGES);
  const pageCount = stepPages(current, w.state).length;
  const page = Math.min(pages[current], pageCount - 1);
  const lastScreen = index === WIZARD_V2_STEPS.length - 1 && page === pageCount - 1;
  const { goNext, goPrev, advancing, submitting } = w;

  const forward = useCallback(() => {
    if (page < pageCount - 1) {
      setPages((p) => ({ ...p, [current]: page + 1 }));
      return;
    }
    const next = WIZARD_V2_STEPS[index + 1];
    if (next) setPages((p) => ({ ...p, [next]: 0 }));
    goNext();
  }, [page, pageCount, current, index, goNext]);

  const back = useCallback(() => {
    if (page > 0) {
      setPages((p) => ({ ...p, [current]: page - 1 }));
      return;
    }
    const prev = WIZARD_V2_STEPS[index - 1];
    if (!prev) return;
    setPages((p) => ({ ...p, [prev]: stepPages(prev, w.state).length - 1 }));
    goPrev();
  }, [page, current, index, goPrev, w.state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.defaultPrevented || arrowsBelongElsewhere(event.target)) return;
      if (advancing || submitting) return;
      // Forward is toward the reading end: right in English, left in Hebrew.
      const toEnd = (event.key === "ArrowRight") === (getActiveDir() !== "rtl");
      if (toEnd && lastScreen) return;
      event.preventDefault();
      if (toEnd) forward();
      else back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forward, back, advancing, submitting, lastScreen]);

  return (
    <div
      className={`mx-auto flex h-[calc(100dvh-var(--header-height)-3rem)] w-full min-w-0 flex-col gap-4 transition-[max-width] duration-300 md:-mt-4 md:gap-5 ${
        WIDE_STEPS.has(current) ? "max-w-6xl" : "max-w-3xl"
      }`}
    >
      <div className="shrink-0">
        <SubmitStepper w={w} locked={w.advancing} />
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden pt-[10px]"
        data-tutorial="submit-wizard"
      >
        {WIZARD_V2_STEPS.filter((step) => visited.has(step)).map((step) => {
          const active = step === current;
          return (
            <motion.div
              key={step}
              hidden={!active}
              className="h-full"
              data-tutorial={active ? `wizard-stage-${step}` : undefined}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate={active ? "center" : "enter"}
              transition={{ duration: active ? 0.1 : 0 }}
            >
              {STEP_VIEWS[step](Math.min(pages[step], stepPages(step, w.state).length - 1))}
            </motion.div>
          );
        })}
      </div>

      <div className="shrink-0">
        <SubmitNav
          w={{ ...w, runDisabledReason }}
          onBack={back}
          onNext={forward}
          backDisabled={index === 0 && page === 0}
          showSubmit={lastScreen}
          screen={{ index: page, count: pageCount }}
        />
      </div>

      <SubmitSplash w={w} />
    </div>
  );
}

/** The one submission wizard: Task, Inputs, Optimizer, Metric, then Run. */
export function UnifiedWizard({ folderId = null }: { folderId?: string | null }) {
  return (
    <ExecutionBudgetProvider>
      <WizardV2Provider folderId={folderId}>
        <UnifiedWizardFrame />
      </WizardV2Provider>
    </ExecutionBudgetProvider>
  );
}
