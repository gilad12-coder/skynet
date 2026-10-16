"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";

import { useHideAgentPill, useWizardStateOptional } from "@/features/agent-panel";
import { getActiveDir } from "@/shared/lib/runtime-locale";

import { slideVariants } from "../../constants";
import { WizardAutoAdvanceContext, useAutoAdvanceDriver } from "../../hooks/use-auto-advance";
import { ExecutionBudgetProvider } from "../../hooks/use-execution-budget";
import { WizardV2Provider, useWizardV2Shell, v2Text } from "../../hooks/use-unified-wizard";
import { limitContinueBlock } from "../../lib/budget-limit";
import { stepPages } from "../../lib/wizard-pages";
import { WIZARD_V2_STEPS, type WizardStepId } from "../../lib/wizard-v2";
import { WIZARD_STAGE, canMoveForward } from "../../lib/wizard-steps";
import { SubmitNav } from "../SubmitNav";
import { SubmitSplash } from "../SubmitSplash";
import { SubmitStepper } from "../SubmitStepper";
import { belowEstimateMessage } from "../TotalBudgetCard";
import { InputsStep } from "./InputsStep";
import { MetricStep } from "./MetricStep";
import { OptimizerStep } from "./OptimizerStep";
import { TaskStep } from "./TaskStep";

const STEP_VIEWS: Record<WizardStepId, (page: number, back: () => void) => ReactNode> = {
  task: (page) => <TaskStep page={page} />,
  inputs: () => <InputsStep />,
  optimizer: (page) => <OptimizerStep page={page} />,
  metric: (page, back) => <MetricStep page={page} onBack={back} />,
};

const FIRST_PAGES: Record<WizardStepId, number> = { task: 0, inputs: 0, optimizer: 0, metric: 0 };

// Arrow keys page the wizard only when they have no job where focus sits:
// fields, editors, radio groups, tabs, menus and open dialogs keep them.
const ARROW_OWNERS =
  'input, textarea, select, [contenteditable="true"], .cm-editor, [role="radio"], [role="radiogroup"], [role="tab"], [role="slider"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="combobox"], [role="dialog"]';

function arrowsBelongElsewhere(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_OWNERS) !== null;
}

function UnifiedWizardFrame() {
  // Each step's Auto/Manual switch is the wizard's way to its agent, so the
  // app-wide launcher would be a second, redundant button by Continue.
  useHideAgentPill();
  const w = useWizardV2Shell();
  const current = w.state.step;
  const index = WIZARD_STAGE[current];
  const { steps } = w;
  const position = steps.indexOf(current);
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
  // A step the flow skips (Guided's Optimizer) still mounts, hidden, once the
  // user is past it: its budget screen sets the run's starting spending limit.
  const mounted = (step: WizardStepId) =>
    visited.has(step) ||
    (!steps.includes(step) && WIZARD_STAGE[step] < WIZARD_STAGE[w.state.furthestStep]);
  const runDisabledReason = w.runBlockedReason ? v2Text(w.runBlockedReason, w.guided) : null;

  // Each step is a run of screens; the arrows walk them, then cross steps.
  const [pages, setPages] = useState(FIRST_PAGES);
  const pageCount = stepPages(current, w.state).length;
  const page = Math.min(pages[current], pageCount - 1);
  const lastScreen = position === steps.length - 1 && page === pageCount - 1;
  const { goNext, goPrev, advancing, submitting } = w;
  const visibleScreen = stepPages(current, w.state)[page] ?? "";
  // A limit under the estimate's low end would only stop the run at its first
  // model call, so the screen that sets it keeps Continue (the agent's too).
  const limitNeeded = limitContinueBlock(visibleScreen, w.costBracket, w.tokenSource, {
    uncapped: w.budgetUncapped,
    limit: w.maxCostCents,
  });
  const inputsOpen = canMoveForward(current, w.stepIssue("inputs"));
  const forwardOpen = inputsOpen && limitNeeded === null;
  const forward = useCallback(() => {
    if (!forwardOpen) return;
    if (page < pageCount - 1) {
      setPages((p) => ({ ...p, [current]: page + 1 }));
      return;
    }
    const next = steps[position + 1];
    if (next) setPages((p) => ({ ...p, [next]: 0 }));
    goNext();
  }, [forwardOpen, page, pageCount, current, steps, position, goNext]);
  const autoAdvance = useAutoAdvanceDriver(
    visibleScreen,
    forwardOpen && !advancing && !submitting,
    forward,
  );

  const back = useCallback(() => {
    if (page > 0) {
      setPages((p) => ({ ...p, [current]: page - 1 }));
      return;
    }
    const prev = steps[position - 1];
    if (!prev) return;
    setPages((p) => ({ ...p, [prev]: stepPages(prev, w.state).length - 1 }));
    goPrev();
  }, [page, current, steps, position, goPrev, w.state]);

  // Back to one named screen: the agent's go-back lands where the user's
  // own Back presses would, without walking every screen between.
  const { goTo } = w;
  const goToScreen = useCallback(
    (screen: string) => {
      const step = steps.find((s) => (stepPages(s, w.state) as readonly string[]).includes(screen));
      if (!step || steps.indexOf(step) > position) return;
      const target = (stepPages(step, w.state) as readonly string[]).indexOf(screen);
      if (step === current && target >= page) return;
      setPages((p) => ({ ...p, [step]: target }));
      if (step !== current) goTo(step);
    },
    [steps, position, current, page, goTo, w.state],
  );

  // The agent edits only the screen on view, so it is told which one that
  // is; unmounting the wizard clears it and leaves the agent unscoped. Its
  // Continue runs this frame's own ``forward``, the button's handler.
  const wizardCtx = useWizardStateOptional();
  const setWizardScreen = wizardCtx?.setWizardScreen;
  const setScreenIssue = wizardCtx?.setScreenIssue;
  const setScreenNavigator = wizardCtx?.setScreenNavigator;
  const blockedIssue = w.stepIssue("inputs");
  const blockedText =
    !inputsOpen && blockedIssue
      ? v2Text(blockedIssue, w.guided)
      : limitNeeded !== null
        ? belowEstimateMessage(limitNeeded)
        : null;
  useEffect(() => {
    setWizardScreen?.(visibleScreen);
  }, [visibleScreen, setWizardScreen]);
  useEffect(() => {
    setScreenIssue?.(blockedText);
  }, [blockedText, setScreenIssue]);
  useEffect(() => {
    setScreenNavigator?.({ screen: visibleScreen, forward, goToScreen });
  }, [visibleScreen, forward, goToScreen, setScreenNavigator]);
  useEffect(
    () => () => {
      setWizardScreen?.(null);
      setScreenIssue?.(null);
      setScreenNavigator?.(null);
    },
    [setWizardScreen, setScreenIssue, setScreenNavigator],
  );

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

  // The stepper's later steps hold too, so the limit can't be skipped past.
  const stepper =
    limitNeeded === null
      ? w
      : {
          ...w,
          canEnter: (step: WizardStepId) =>
            WIZARD_STAGE[step] <= WIZARD_STAGE[current] && w.canEnter(step),
          goTo: (step: WizardStepId) => {
            if (WIZARD_STAGE[step] <= WIZARD_STAGE[current]) w.goTo(step);
          },
        };

  return (
    <div
      // Every step can hold its agent beside the form, so the frame stays wide.
      // The Metric step holds the IDE, which needs the full width for its editor.
      className={`mx-auto flex h-[calc(100dvh-var(--header-height)-3rem)] w-full min-w-0 flex-col gap-4 md:-mt-4 md:gap-5 ${
        current === "metric" ? "max-w-screen-2xl" : "max-w-6xl"
      }`}
    >
      <div className="shrink-0">
        <SubmitStepper w={stepper} locked={w.advancing} />
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden pt-[10px]"
        data-tutorial="submit-wizard"
      >
        <WizardAutoAdvanceContext.Provider value={autoAdvance}>
          {WIZARD_V2_STEPS.filter(mounted).map((step) => {
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
                {STEP_VIEWS[step](Math.min(pages[step], stepPages(step, w.state).length - 1), back)}
              </motion.div>
            );
          })}
        </WizardAutoAdvanceContext.Provider>
      </div>

      <div className="shrink-0">
        <SubmitNav
          w={{ ...w, runDisabledReason }}
          onBack={back}
          onNext={forward}
          backDisabled={position === 0 && page === 0}
          nextDisabled={!forwardOpen}
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
