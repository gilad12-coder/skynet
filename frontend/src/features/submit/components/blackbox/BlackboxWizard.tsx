"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { ValidationFrame, ValidationGate, ValidationPlan } from "../ValidationFrame";
import { msg } from "@/shared/lib/messages";
import { useCredits } from "@/features/billing";
import { SubmitSplashOverlay } from "@/shared/ui/submit-splash-overlay";
import { TERMS } from "@/shared/lib/terms";

import { useBlackboxWizard, type BlackboxRecipe } from "../../hooks/use-blackbox-wizard";
import { emptyModelConfig, slideVariants } from "../../constants";
import { budgetShortfall } from "../../lib/budget-limit";
import { toastBudgetShortfall } from "../../lib/budget-toast";
import { focusField } from "../../lib/focus-field";
import { WIZARD_STAGE, stageAt, type WizardStageId } from "../../lib/wizard-steps";
import { SubmitStepper } from "../SubmitStepper";
import { SubmitNav } from "../SubmitNav";
import { ModelConfigModal } from "../ModelConfigModal";
import { TotalBudgetCard } from "../TotalBudgetCard";
import { WizardIssueNotice } from "../WizardIssueNotice";
import { WizardSubsteps } from "../WizardSubsteps";
import { SplitSection } from "../steps/SplitSection";
import { BlackboxBasicsStep } from "./BlackboxBasicsStep";
import { BlackboxStartStep } from "./BlackboxStartStep";
import { BlackboxCasesStep } from "./BlackboxCasesStep";
import { BlackboxScorerStep } from "./BlackboxScorerStep";
import { BlackboxOptimizerStep } from "./BlackboxOptimizerStep";
import { BlackboxSummaryStep } from "./BlackboxSummaryStep";

type EvaluationStep = "cases" | "scorer" | "split" | "budget";
const GOAL_STEPS = ["goal"] as const;
const OPTIMIZATION_STEPS = ["strategy", "model", "check"] as const;
const REVIEW_STEPS = ["basics", "summary"] as const;

/** The evaluation substep that holds a field, so a problem opens where it is fixed. */
function evaluationStepFor(field: string | undefined, hasCases: boolean): EvaluationStep | null {
  if (!field) return null;
  if (field === "totalBudgetInput") return "budget";
  if (field === "bb-cases" || field === "wizard-stage-evaluation") return "cases";
  if (field.startsWith("bb-scor")) return "scorer";
  if (field === "bb-execution-agent" || field === "bb-task-model") return "scorer";
  if (field === "bb-split") return hasCases ? "split" : "cases";
  return null;
}

/** Resolve the owning stage when a different stage reports a field error. */
function stageOwning(stage: WizardStageId, field?: string): WizardStageId {
  if (field === "totalBudgetInput") return "evaluation";
  return field === "bb-cases" ? "evaluation" : stage;
}

export function BlackboxWizard({
  header,
  initialRecipe,
}: {
  header?: ReactNode;
  initialRecipe: BlackboxRecipe;
}) {
  const w = useBlackboxWizard(initialRecipe);
  const wallet = useCredits();
  const [dataPreviewOpen, setDataPreviewOpen] = useState(false);
  const [dataPreviewExpanded, setDataPreviewExpanded] = useState(false);
  const [evaluationPart, setEvaluationPart] = useState(0);
  const [optimizationPart, setOptimizationPart] = useState(0);
  // Review splits into its own two substeps: the basics get a Continue gate of
  // their own before the summary carousel opens.
  const [reviewPart, setReviewPart] = useState(0);
  const activeReviewPart = Math.min(reviewPart, REVIEW_STEPS.length - 1);

  // The split only exists once there are cases to divide.
  const hasCases = Boolean(w.parsedCases?.rowCount);
  const evaluationSteps = useMemo<readonly EvaluationStep[]>(
    () => (hasCases ? ["budget", "cases", "scorer", "split"] : ["budget", "cases", "scorer"]),
    [hasCases],
  );
  const activeEvaluationPart = Math.min(evaluationPart, evaluationSteps.length - 1);
  const activeEvaluationStep: EvaluationStep = evaluationSteps[activeEvaluationPart] ?? "cases";

  const routeSubstep = useCallback(
    (stage: WizardStageId, field?: string) => {
      if (stage === "evaluation") {
        const key = evaluationStepFor(field, hasCases);
        if (key) setEvaluationPart(Math.max(0, evaluationSteps.indexOf(key)));
      }
      if (stage === "optimization")
        setOptimizationPart(field === "bb-optimization-model" || field === "bb-max-runs" ? 1 : 0);
    },
    [evaluationSteps, hasCases],
  );
  const handleEditField = (stage: WizardStageId, field?: string) => {
    const target = stageOwning(stage, field);
    routeSubstep(target, field);
    w.goTo(WIZARD_STAGE[target]);
    if (field) focusField(field);
  };
  // A reported problem opens the substep that holds its field and lands focus there.
  useEffect(() => {
    if (!w.issue) return;
    routeSubstep(stageOwning(w.issue.stage, w.issue.fieldId), w.issue.fieldId);
    if (w.issue.fieldId) focusField(w.issue.fieldId);
  }, [w.issue, routeSubstep]);

  const stage = stageAt(w.step);
  // Validation problems stay live: they follow the stage's current state until
  // it validates. Setup-check problems hold until the checked setup changes.
  const issue =
    w.issue && w.issue.stage === stage
      ? w.issue.identity
        ? w.preflight.identity === w.issue.identity
          ? w.issue
          : null
        : w.stageIssue(w.step)
      : null;

  // Optimization ends on the one setup check: the last pass for this setup,
  // or what Continue will run.
  const executionResult = w.preflight.progress.completed("execution");
  const priorExecution = w.preflight.evidence.execution;
  const checkPage = executionResult ? (
    <ValidationFrame state={executionResult} settled />
  ) : (
    <ValidationPlan
      workflow="anything"
      scope="execution"
      stale={priorExecution !== undefined && priorExecution.identity !== w.preflight.identity}
    />
  );
  const validation = w.preflight.progress.state;
  // A passed setup check is shown on its own page, the last substep of
  // Optimization, which is where the stage reopens afterwards. A scorer test
  // run from the evaluator step lingers and returns there by itself.
  const passedCheck = validation?.status === "succeeded" ? validation.scope : null;
  useEffect(() => {
    if (passedCheck === "execution") setOptimizationPart(OPTIMIZATION_STEPS.length - 1);
  }, [passedCheck]);
  // A check that passed from its own stage is a page of its own: it stays,
  // with the navigation, until the user moves on.
  const held =
    validation?.status === "succeeded" &&
    validation.scope === "execution" &&
    w.step === WIZARD_STAGE.optimization;
  const onCheckPage =
    w.step === WIZARD_STAGE.optimization && OPTIMIZATION_STEPS[optimizationPart] === "check";

  const evaluationPanels: Record<EvaluationStep, ReactNode> = {
    cases: (
      <div id="bb-cases" tabIndex={-1} className="outline-none">
        <BlackboxCasesStep
          w={w}
          previewOpen={dataPreviewOpen}
          onPreviewOpenChange={setDataPreviewOpen}
          previewExpanded={dataPreviewExpanded}
          onPreviewExpandedChange={setDataPreviewExpanded}
        />
      </div>
    ),
    // Cases and the optimization model both move the estimate and come later.
    budget: (
      <TotalBudgetCard
        w={w}
        mode={w.tokenSource}
        preliminary={!hasCases || !w.reflectionModel.name.trim()}
      />
    ),
    scorer: <BlackboxScorerStep w={w} />,
    split: (
      <div id="bb-split" tabIndex={-1} className="outline-none">
        <SplitSection w={w} totalRows={w.parsedCases?.rowCount ?? 0} />
      </div>
    ),
  };
  const optimizationPanels: readonly ReactNode[] = [
    <BlackboxOptimizerStep key="strategy" w={w} part="strategy" />,
    <BlackboxOptimizerStep key="model" w={w} part="model" />,
    checkPage,
  ];

  const shortfall = budgetShortfall(w.costBracket, w.tokenSource, {
    uncapped: w.budgetUncapped,
    limit: w.maxCostCredits,
    balance: wallet.available ? wallet.totalCredits : null,
  });
  const handleEvaluationNext = async () => {
    if (activeEvaluationStep === "budget" && shortfall) {
      toastBudgetShortfall(shortfall);
      return;
    }
    const next = evaluationSteps[activeEvaluationPart + 1];
    if (next) {
      setEvaluationPart(activeEvaluationPart + 1);
      return;
    }
    await w.handleNext();
  };

  const handleOptimizationNext = async () => {
    const next = OPTIMIZATION_STEPS[optimizationPart + 1];
    if (next === "check" && !executionResult) {
      await w.handleNext();
      return;
    }
    if (next) {
      setOptimizationPart((current) => current + 1);
      return;
    }
    setReviewPart(0);
    await w.handleNext();
  };

  // The basics substep gates the summary: Continue opens the summary carousel.
  const handleReviewNext = () => setReviewPart(REVIEW_STEPS.length - 1);

  const stageViews: Record<WizardStageId, ReactNode> = {
    goal: (
      <WizardSubsteps active={0} ariaLabel={msg("submit.stage.goal")} steps={GOAL_STEPS}>
        <BlackboxStartStep w={w} header={header} />
      </WizardSubsteps>
    ),
    evaluation: (
      <WizardSubsteps
        active={activeEvaluationPart}
        ariaLabel={msg("submit.stage.evaluation")}
        steps={evaluationSteps}
      >
        {evaluationPanels[activeEvaluationStep]}
      </WizardSubsteps>
    ),
    optimization: (
      <WizardSubsteps
        active={optimizationPart}
        ariaLabel={msg("submit.stage.optimization")}
        steps={OPTIMIZATION_STEPS}
      >
        {optimizationPanels[optimizationPart]}
      </WizardSubsteps>
    ),
    review: (
      <WizardSubsteps
        active={activeReviewPart}
        ariaLabel={msg("submit.stage.review")}
        steps={REVIEW_STEPS}
      >
        {activeReviewPart === 0 ? (
          <BlackboxBasicsStep w={w} />
        ) : (
          <BlackboxSummaryStep w={w} />
        )}
      </WizardSubsteps>
    ),
  };

  const onBack = () => {
    // Leaving a held result settles it into its page.
    if (held) w.preflight.progress.clear();
    if (w.step === WIZARD_STAGE.evaluation && activeEvaluationPart > 0) {
      setEvaluationPart(activeEvaluationPart - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.optimization && optimizationPart > 0) {
      setOptimizationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.review && activeReviewPart > 0) {
      setReviewPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.review) setOptimizationPart(OPTIMIZATION_STEPS.length - 1);
    w.goPrev();
  };
  const onNext =
    w.step === WIZARD_STAGE.evaluation
      ? handleEvaluationNext
      : w.step === WIZARD_STAGE.optimization
        ? handleOptimizationNext
        : w.step === WIZARD_STAGE.review
          ? handleReviewNext
          : w.handleNext;
  const showSubmit =
    w.step === WIZARD_STAGE.review && activeReviewPart === REVIEW_STEPS.length - 1;
  // Auto mode seats the agent pane beside the form on the Goal stage and the
  // scorer, so those take the wide column; plain forms keep the narrow one.
  const wideAuthoringPanel =
    w.codeAssistMode === "auto" &&
    (w.step === WIZARD_STAGE.goal ||
      (w.step === WIZARD_STAGE.evaluation && activeEvaluationStep === "scorer"));
  const wideDataPreview =
    w.step === WIZARD_STAGE.evaluation &&
    activeEvaluationStep === "cases" &&
    dataPreviewOpen &&
    dataPreviewExpanded &&
    !!w.parsedCases;
  const containerWidthClass =
    validation || onCheckPage
      ? "max-w-3xl"
      : wideAuthoringPanel || wideDataPreview
        ? "max-w-6xl"
        : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} locked={validation !== null && !held} />

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
        <ValidationGate
          validation={validation}
          direction={w.direction}
          hold={held}
          onBack={w.preflight.progress.clear}
        >
          <AnimatePresence mode="wait" custom={w.direction}>
            <motion.div
              key={w.step}
              data-tutorial={`wizard-stage-${stage}`}
              custom={w.direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.1 }}
            >
              {issue && (
                <WizardIssueNotice
                  issue={issue}
                  onFix={() => handleEditField(issue.stage, issue.fieldId)}
                />
              )}
              {stageViews[stage]}
            </motion.div>
          </AnimatePresence>
        </ValidationGate>
      </div>

      {(validation === null || held) && (
        <SubmitNav
          w={w}
          onBack={onBack}
          onNext={onNext}
          backDisabled={w.step === WIZARD_STAGE.goal}
          showSubmit={showSubmit}
        />
      )}

      <ModelConfigModal
        open={!!w.editingModel}
        onOpenChange={(open) => {
          if (!open) w.setEditingModel(null);
        }}
        config={w.editingModel?.config ?? emptyModelConfig()}
        onSave={(config) => {
          w.editingModel?.onSave(config);
          w.saveToRecent(config);
          w.setEditingModel(null);
        }}
        roleLabel={w.editingModel?.label ?? TERMS.reflectionModel}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
        nameOnly={w.editingModel?.nameOnly}
        modelDefaultsOnly={w.editingModel?.modelDefaultsOnly}
      />

      <SubmitSplashOverlay show={w.submitPhase === "splash" || w.submitPhase === "done"} />
    </div>
  );
}
