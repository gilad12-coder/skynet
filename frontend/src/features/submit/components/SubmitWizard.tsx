"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { msg } from "@/shared/lib/messages";

import { TotalBudgetCard } from "./TotalBudgetCard";
import { WizardIssueNotice } from "./WizardIssueNotice";
import { WizardSubsteps } from "./WizardSubsteps";
import { aggregateTokenSource } from "../lib/cost-bracket";
import { useSubmitWizard } from "../hooks/use-submit-wizard";
import { emptyModelConfig, slideVariants } from "../constants";
import { focusField } from "../lib/focus-field";
import { WIZARD_STAGE, stageAt, type WizardStageId } from "../lib/wizard-steps";
import { SubmitStepper } from "./SubmitStepper";
import { SubmitNav } from "./SubmitNav";
import { SubmitSplash } from "./SubmitSplash";
import { ModelConfigModal } from "./ModelConfigModal";
import { BasicsStep } from "./steps/BasicsStep";
import { DatasetStep } from "./steps/DatasetStep";
import { ModelStep } from "./steps/ModelStep";
import { CodeStep } from "./steps/CodeStep";
import { ParamsStep } from "./steps/ParamsStep";
import { SummaryStep } from "./steps/SummaryStep";
import { SplitSection } from "./steps/SplitSection";

const EVALUATION_STEPS = ["budget", "dataset", "code", "split"] as const;
const OPTIMIZATION_STEPS = ["parameters", "models"] as const;
const REVIEW_STEPS = ["review"] as const;
const CODE_FIELDS = new Set(["signature-editor", "metric-editor", "react-config"]);

/** The evaluation substep that holds a field, so a problem opens where it is fixed. */
function evaluationPartFor(field?: string): number | null {
  if (!field) return null;
  if (field === "totalBudgetInput") return 0;
  if (CODE_FIELDS.has(field)) return 2;
  if (field === "data-splits") return 3;
  return 1;
}

export function SubmitWizard({ header }: { header?: ReactNode }) {
  const w = useSubmitWizard();
  const [evaluationPart, setEvaluationPart] = useState(0);
  const [optimizationPart, setOptimizationPart] = useState(0);

  const routeSubstep = useCallback((stage: WizardStageId, field?: string) => {
    if (stage === "evaluation") {
      const part = evaluationPartFor(field);
      if (part != null) setEvaluationPart(part);
    }
    if (stage === "optimization") setOptimizationPart(field === "model-catalog" ? 1 : 0);
  }, []);
  const goToField = (stage: WizardStageId, field?: string) => {
    // The total budget lives in Evaluation even when a later stage reports it.
    const target: WizardStageId = field === "totalBudgetInput" ? "evaluation" : stage;
    routeSubstep(target, field);
    w.goTo(WIZARD_STAGE[target]);
    if (field) focusField(field);
  };
  // A reported problem opens the substep that holds its field and lands focus there.
  useEffect(() => {
    if (!w.issue) return;
    routeSubstep(w.issue.stage, w.issue.fieldId);
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
        : w.stageIssue(w.step, true)
      : null;

  const budgetMode = aggregateTokenSource(
    w.jobType === "grid_search"
      ? [...w.generationModels, ...w.reflectionModels]
      : [
          w.modelConfig,
          ...(w.optimizerName === "gepa" && w.secondModelConfig ? [w.secondModelConfig] : []),
        ],
  );
  const evaluationPanels: readonly ReactNode[] = [
    <TotalBudgetCard key="budget" w={w} mode={budgetMode} />,
    <DatasetStep key="dataset" w={w} />,
    <CodeStep key="code" w={w} part="code" />,
    <SplitSection key="split" w={w} />,
  ];
  const optimizationPanels: readonly ReactNode[] = [
    <ParamsStep key="parameters" w={w} />,
    <ModelStep key="models" w={w} />,
  ];

  const handleEvaluationNext = async () => {
    if (evaluationPart < EVALUATION_STEPS.length - 1) {
      setEvaluationPart((current) => current + 1);
      return;
    }
    await w.handleNext();
  };

  const handleOptimizationNext = async () => {
    if (optimizationPart < OPTIMIZATION_STEPS.length - 1) {
      setOptimizationPart((current) => current + 1);
      return;
    }
    await w.handleNext();
  };

  const stageViews: Record<WizardStageId, ReactNode> = {
    goal: <CodeStep w={w} part="module" header={header} />,
    evaluation: (
      <WizardSubsteps
        active={evaluationPart}
        ariaLabel={msg("submit.stage.evaluation")}
        steps={EVALUATION_STEPS}
      >
        {evaluationPanels[evaluationPart]}
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
      <WizardSubsteps active={0} ariaLabel={msg("submit.stage.review")} steps={REVIEW_STEPS}>
        <div className="space-y-4 md:space-y-6">
          <BasicsStep w={w} />
          <SummaryStep
            w={w}
            onEditStage={(target) => {
              if (target === "evaluation") setEvaluationPart(0);
              if (target === "optimization") setOptimizationPart(0);
              w.goTo(WIZARD_STAGE[target]);
            }}
          />
        </div>
      </WizardSubsteps>
    ),
  };

  const onBack = () => {
    if (w.step === WIZARD_STAGE.evaluation && evaluationPart > 0) {
      setEvaluationPart((current) => current - 1);
      return;
    }
    if (w.step === WIZARD_STAGE.optimization && optimizationPart > 0) {
      setOptimizationPart((current) => current - 1);
      return;
    }
    w.goPrev();
  };
  const onNext =
    w.step === WIZARD_STAGE.evaluation
      ? handleEvaluationNext
      : w.step === WIZARD_STAGE.optimization
        ? handleOptimizationNext
        : w.handleNext;
  const showSubmit = w.step === WIZARD_STAGE.review;
  const containerWidthClass =
    w.step === WIZARD_STAGE.evaluation && evaluationPart === 2 && w.codeAssistMode === "auto"
      ? "max-w-6xl"
      : "max-w-2xl";

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-4 pb-6 transition-[max-width] duration-300 md:-mt-4 md:space-y-6 md:pb-8 ${containerWidthClass}`}
    >
      <SubmitStepper w={w} />

      <div className="relative overflow-hidden pt-[10px]" data-tutorial="submit-wizard">
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
                onFix={() => goToField(issue.stage, issue.fieldId)}
              />
            )}
            {stageViews[stage]}
          </motion.div>
        </AnimatePresence>
      </div>

      <SubmitNav
        w={w}
        onBack={onBack}
        onNext={onNext}
        backDisabled={w.step === WIZARD_STAGE.goal}
        showSubmit={showSubmit}
      />

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
        roleLabel={w.editingModel?.label ?? msg("model.generation.label")}
        catalogModels={w.catalog?.models}
        recentConfigs={w.recentConfigs}
        onRemoveRecent={w.removeRecentConfig}
      />

      <SubmitSplash w={w} />
    </div>
  );
}
