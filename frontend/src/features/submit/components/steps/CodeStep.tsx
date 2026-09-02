"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Robot, Brain, Sparkle, FlowArrow, Lightning, Cube, CaretLeft } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";

import { Label } from "@/shared/ui/primitives/label";
import { Separator } from "@/shared/ui/primitives/separator";
import { HelpTip } from "@/shared/ui/help-tip";
import { Skeleton } from "@/shared/ui/skeleton";
import { tip, type TooltipKey } from "@/shared/lib/tooltips";
import { getActiveDir, getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import { TERMS } from "@/shared/lib/terms";
import { Carousel } from "@/features/agent-panel";

import type { SubmitWizardContext } from "../../hooks/use-submit-wizard";
import { ArtifactStatusChip, AuthoringShell } from "./AuthoringShell";
import { CodeAgentPanel, VersionStepper } from "./CodeAgentPanel";
import { CodeInterviewPanel } from "./CodeInterviewPanel";
import { ReactConfigSection } from "./ReactConfigSection";
import { BannerFrame, GArrow, GBar, GBox, GWire, PickerSlide } from "./PickerSlide";
import { workflowUsesTools } from "../../workflow/model";
import { WIZARD_STAGE } from "../../lib/wizard-steps";

// The atomic DSPy modules offered on the picker's "single module" tier. Names
// are technical terms kept in English; descriptions reuse the localized tooltip
// copy. Each carries the schematic drawn on its carousel slide's banner.
// Workflow is deliberately not here: it is a composition of these modules, not
// a peer of them, and is offered as its own build type one tier up (see
// WORKFLOW_META and CompositionChoice).
const ATOMIC_MODULES = [
  {
    value: "predict",
    label: "Predict",
    icon: Lightning,
    tipKey: "module.predict",
    taglineKey: "submit.module.tagline.predict",
    Banner: PredictBanner,
  },
  {
    value: "cot",
    label: "Chain of Thought",
    icon: Brain,
    tipKey: "module.cot",
    taglineKey: "submit.module.tagline.cot",
    Banner: CotBanner,
  },
  {
    value: "react",
    label: "ReAct",
    icon: Robot,
    tipKey: "module.react",
    taglineKey: "submit.module.tagline.react",
    Banner: ReactBanner,
  },
  {
    value: "flex",
    label: "Flex",
    icon: Sparkle,
    tipKey: "module.flex",
    taglineKey: "submit.module.tagline.flex",
    Banner: FlexBanner,
  },
] as const;

// The workflow build type — a DAG composed from the atomic modules above, not
// one of them. It owns no carousel slide; the composition tier presents it
// directly with its own schematic.
const WORKFLOW_META = {
  value: "workflow",
  label: "Workflow",
  icon: FlowArrow,
  tipKey: "module.workflow",
  Banner: WorkflowBanner,
} as const;

const MODULE_TIER_TRANSITION = {
  duration: 0.22,
  ease: [0.2, 0.8, 0.2, 1] as const,
};

const MODULE_TIER_VARIANTS: Variants = {
  enter: (offset: number) => ({ opacity: 0, x: offset }),
  center: { opacity: 1, x: 0 },
  exit: (offset: number) => ({ opacity: 0, x: -offset }),
};

// The header chip's label for a committed module. Workflow lives outside
// ATOMIC_MODULES, so it is matched on its own; anything unrecognised falls
// back to the raw name.
function moduleLabel(value: string): string {
  const v = value.toLowerCase();
  if (v === WORKFLOW_META.value) return WORKFLOW_META.label;
  return ATOMIC_MODULES.find((m) => m.value === v)?.label ?? value;
}

const CodeEditor = dynamic(() => import("@/shared/ui/code-editor").then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <Skeleton height={200} borderRadius={8} />,
});

// React Flow ships ~100KB of canvas code; only workflow runs pay for it.
const WorkflowCanvas = dynamic(
  () => import("../../workflow/WorkflowCanvas").then((m) => m.WorkflowCanvas),
  { ssr: false, loading: () => <Skeleton height={480} borderRadius={8} /> },
);

export function CodeStep({ w, part }: { w: SubmitWizardContext; part: "module" | "code" }) {
  const {
    isWorkflow,
    isReact,
    moduleName,
    moduleSelectionRequired,
    chooseModule,
    goTo,
    workflowSpec,
    setWorkflowSpec,
    workflowRevision,
    agentPulseNodeId,
    workflowSampleInputs,
    workflowDryRunDisabledReason,
    workflowDryRunNeedsModel,
    openDryRunModelPicker,
    modelConfig,
    runWorkflowDryRun,
    signatureCode,
    setSignatureCode,
    setSignatureManuallyEdited,
    signatureValidation,
    setSignatureValidation,
    metricCode,
    setMetricCode,
    setMetricManuallyEdited,
    metricValidation,
    setMetricValidation,
    runSignatureValidation,
    runMetricValidation,
    codeAssistMode,
    setCodeAssistMode,
    parsedDataset,
    columnRoles,
    agent,
    interview,
    interviewEligible,
  } = w;
  const hasContext = React.useMemo(() => {
    if (!parsedDataset || parsedDataset.rowCount === 0) return false;
    const hasInput = Object.values(columnRoles).some((r) => r === "input");
    const hasOutput = Object.values(columnRoles).some((r) => r === "output");
    return hasInput && hasOutput;
  }, [parsedDataset, columnRoles]);

  // The interview owns the agent-panel slot until it resolves — but never
  // over an existing conversation (a locale-switch reload restores the
  // agent transcript; re-interviewing over generated code would be noise).
  const interviewActive =
    interviewEligible &&
    !interview.resolved &&
    agent.messages.length === 0 &&
    agent.signatureVersions.length === 0 &&
    agent.metricVersions.length === 0;

  const disabledReason = !hasContext
    ? parsedDataset
      ? msg("auto.features.submit.components.steps.codestep.literal.1")
      : formatMsg("auto.features.submit.components.steps.codestep.template.1", {
          p1: TERMS.dataset,
        })
    : undefined;

  // The picker lives on the Goal stage now, so switching modules is a hop back
  // rather than an in-place swap.
  const moduleChip = {
    label: moduleLabel(moduleName),
    onChangeModule: () => goTo(WIZARD_STAGE.goal),
  };

  const sidePanel = interviewActive ? (
    <CodeInterviewPanel interview={interview} className="absolute inset-0" />
  ) : (
    <CodeAgentPanel
      agent={agent}
      disabled={!hasContext}
      disabledReason={disabledReason}
      className="absolute inset-0"
    />
  );
  const shellProps = {
    value: codeAssistMode,
    onChange: setCodeAssistMode,
    disabledReason,
    sidePanel,
  };

  const metricEditor = (
    <div
      className={cn(
        "space-y-2 transition-opacity duration-300",
        codeAssistMode === "auto" && agent.signatureStatus === "writing" && "opacity-50",
      )}
      data-tutorial="metric-editor"
    >
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <HelpTip text={tip("code.metric")}>
            {msg("auto.features.submit.components.steps.codestep.3")}
          </HelpTip>
        </Label>
        <div className="flex items-center gap-2">
          {codeAssistMode === "auto" && <VersionStepper agent={agent} artifact="metric" />}
          {codeAssistMode === "auto" && <ArtifactStatusChip status={agent.metricStatus} />}
        </div>
      </div>
      <MobileCodeEditorActions>
        <CodeEditor
          value={metricCode}
          onChange={(v) => {
            setMetricCode(v);
            setMetricManuallyEdited(true);
            setMetricValidation(null);
          }}
          height="260px"
          onRun={runMetricValidation}
          validationResult={metricValidation}
          streaming={codeAssistMode === "auto" && agent.metricStatus === "writing"}
          flashLines={codeAssistMode === "auto" ? agent.metricFlashLines : undefined}
        />
      </MobileCodeEditorActions>
    </div>
  );

  // The module part is the Goal stage: the picker stays up so the current
  // choice is visible and switchable. The code part is the Evaluation stage's
  // authoring section — the workflow canvas or the signature editor, plus the
  // metric — and falls back to the picker if no module was ever chosen. The
  // views share one AnimatePresence so switching cross-fades instead of
  // hard-swapping the card.
  const view =
    part === "module" || moduleSelectionRequired ? "picker" : isWorkflow ? "workflow" : "code";

  let content: React.ReactNode;
  if (view === "picker") {
    content = <ModulePicker current={moduleName} onChoose={chooseModule} />;
  } else if (view === "workflow") {
    content = (
      <AuthoringShell
        {...shellProps}
        module={moduleChip}
        title={<HelpTip text={tip("module.workflow")}>{msg("workflow.step.title")}</HelpTip>}
        description={msg("workflow.step.subtitle")}
      >
        {workflowSpec && (
          <WorkflowCanvas
            spec={workflowSpec}
            specRevision={workflowRevision}
            onSpecChange={setWorkflowSpec}
            pulseNodeId={agentPulseNodeId}
            dryRun={{
              disabledReason: workflowDryRunDisabledReason,
              needsModel: workflowDryRunNeedsModel,
              pickModel: openDryRunModelPicker,
              modelName: modelConfig.name || null,
              sampleInputs: workflowSampleInputs,
              run: runWorkflowDryRun,
            }}
            agentPanel={
              codeAssistMode === "auto" ? (
                interviewActive ? (
                  <CodeInterviewPanel interview={interview} />
                ) : (
                  <CodeAgentPanel
                    agent={agent}
                    disabled={!hasContext}
                    disabledReason={disabledReason}
                  />
                )
              ) : undefined
            }
          />
        )}
        {workflowSpec && workflowUsesTools(workflowSpec) && (
          <div className="border-t border-border/30 px-4 py-4 sm:px-6">
            <ReactConfigSection w={w} />
          </div>
        )}
        <div className="space-y-3 border-t border-border/30 px-4 py-4 sm:px-6">
          <p className="text-sm text-muted-foreground">{msg("workflow.step.metric_hint")}</p>
          {metricEditor}
        </div>
      </AuthoringShell>
    );
  } else {
    content = (
      <AuthoringShell
        {...shellProps}
        module={moduleChip}
        title={
          <HelpTip
            text={
              codeAssistMode === "auto"
                ? formatMsg("auto.features.submit.components.steps.codestep.template.2", {
                    p1: TERMS.dataset,
                  })
                : formatMsg("auto.features.submit.components.steps.codestep.template.3", {
                    p1: TERMS.signature,
                    p2: TERMS.metric,
                  })
            }
          >
            {msg("auto.features.submit.constants.literal.3")}
          </HelpTip>
        }
      >
        <div className="space-y-4 px-4 py-4 sm:px-6">
          <div
            className={cn(
              "space-y-2 transition-opacity duration-300",
              codeAssistMode === "auto" && agent.metricStatus === "writing" && "opacity-50",
            )}
            data-tutorial="signature-editor"
          >
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <HelpTip text={tip("code.signature")}>
                  {msg("auto.features.submit.components.steps.codestep.2")}
                </HelpTip>
              </Label>
              <div className="flex items-center gap-2">
                {codeAssistMode === "auto" && <VersionStepper agent={agent} artifact="signature" />}
                {codeAssistMode === "auto" && <ArtifactStatusChip status={agent.signatureStatus} />}
              </div>
            </div>
            <MobileCodeEditorActions>
              <CodeEditor
                value={signatureCode}
                onChange={(v) => {
                  setSignatureCode(v);
                  setSignatureManuallyEdited(true);
                  setSignatureValidation(null);
                }}
                height="260px"
                onRun={runSignatureValidation}
                validationResult={signatureValidation}
                streaming={codeAssistMode === "auto" && agent.signatureStatus === "writing"}
                flashLines={codeAssistMode === "auto" ? agent.signatureFlashLines : undefined}
              />
            </MobileCodeEditorActions>
          </div>
          <Separator />
          {metricEditor}
          {isReact && (
            <>
              <Separator />
              <ReactConfigSection w={w} />
            </>
          )}
        </div>
      </AuthoringShell>
    );
  }

  return (
    <div
      data-tutorial="wizard-step-4"
      className="[&_button]:min-h-[44px] [&_button]:min-w-[44px] lg:[&_button]:min-h-0 lg:[&_button]:min-w-0"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 10, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.99 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function MobileCodeEditorActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 [&>div>div:first-child]:overflow-x-auto [&>div>div:first-child>button]:shrink-0 lg:[&>div>div:first-child]:overflow-visible">
      {children}
    </div>
  );
}

function ModulePicker({
  current,
  onChoose,
}: {
  current: string;
  onChoose: (module: string) => void;
}) {
  // Two tiers: first the composition (a single module vs a workflow), then —
  // for "single" — the atomic-module carousel. The step swaps the picker out
  // once a module is committed, so it remounts on every reopen and the tier
  // always starts on the composition choice; there is no stale drill-down to
  // restore, and reopening a workflow run still surfaces both build types.
  const [tier, setTier] = React.useState<"composition" | "atomic">("composition");
  const [tierDirection, setTierDirection] = React.useState(1);
  const prefersReducedMotion = useReducedMotion();
  const inlineDirection = getActiveDir() === "rtl" ? -1 : 1;
  const tierOffset = prefersReducedMotion ? 0 : tierDirection * inlineDirection * 24;

  const showAtomicModules = () => {
    setTierDirection(1);
    setTier("atomic");
  };

  const showCompositionChoice = () => {
    setTierDirection(-1);
    setTier("composition");
  };

  return (
    // A container, not a breakpoint: the step card is max-w-5xl in auto mode
    // and max-w-2xl in manual, so only its own width can say whether a slide
    // (or the two composition cards) has room to sit side by side.
    <div
      className="@container rounded-2xl border border-border/50 bg-card/80 px-4 py-5 shadow-lg backdrop-blur-xl sm:px-8 sm:py-7"
      data-tutorial="module-selector"
    >
      <AnimatePresence mode="wait" initial={false} custom={tierOffset}>
        <motion.div
          key={tier}
          custom={tierOffset}
          variants={MODULE_TIER_VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
          transition={prefersReducedMotion ? { duration: 0 } : MODULE_TIER_TRANSITION}
        >
          {tier === "composition" ? (
            <CompositionChoice
              onSingle={showAtomicModules}
              onWorkflow={() => onChoose("workflow")}
            />
          ) : (
            <AtomicModulePicker
              current={current}
              onChoose={onChoose}
              onBack={showCompositionChoice}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Tier one: choose how the run is composed — a single atomic module, or a
 * workflow that wires several together. The two are not peers, so they read as
 * two build types side by side rather than as entries in the module carousel.
 */
function CompositionChoice({
  onSingle,
  onWorkflow,
}: {
  onSingle: () => void;
  onWorkflow: () => void;
}) {
  return (
    <div>
      <div className="mb-4 flex items-center">
        <HelpTip text={tip("module.choice")}>
          <span className="text-sm font-semibold tracking-tight">
            {msg("submit.composition.title")}
          </span>
        </HelpTip>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <CompositionCard
          Banner={PredictBanner}
          icon={Cube}
          label={msg("submit.composition.single_label")}
          description={msg("submit.composition.single_desc")}
          onClick={onSingle}
        />
        <CompositionCard
          Banner={WORKFLOW_META.Banner}
          icon={WORKFLOW_META.icon}
          label={WORKFLOW_META.label}
          labelLtr
          description={msg("submit.composition.workflow_desc")}
          onClick={onWorkflow}
        />
      </div>
    </div>
  );
}

/**
 * One build-type card: a schematic banner over an icon, label and one line of
 * copy. The whole card commits the choice — the single card drills into the
 * atomic carousel, the workflow card picks the workflow module outright.
 *
 * `labelLtr` keeps a technical term ("Workflow") left-to-right in RTL; a
 * localized label ("Single module") is left to the ambient direction.
 */
function CompositionCard({
  Banner,
  icon: Icon,
  label,
  labelLtr,
  description,
  onClick,
}: {
  Banner: React.ComponentType;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  labelLtr?: boolean;
  description: string;
  onClick: () => void;
}) {
  return (
    // Its own @container so the banner's own breakpoints measure the card, not
    // the picker — a half-width card stays under @3xl and keeps the banner on
    // top rather than flipping to the beside-copy layout of a full slide.
    <button
      type="button"
      onClick={onClick}
      className="@container group flex flex-col overflow-hidden rounded-xl border border-border/50 bg-background/60 text-start transition-colors hover:border-[#C8A882] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]"
    >
      <Banner />
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-[#F3EDE3] text-[#3D2E22]">
            <Icon className="size-[1.125rem]" />
          </span>
          <h4
            {...(labelLtr ? { dir: "ltr" } : {})}
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            {label}
          </h4>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

/**
 * Tier two: the atomic-module carousel, reached from the "single module" card.
 * A back control returns to the composition choice; picking a slide commits.
 */
function AtomicModulePicker({
  current,
  onChoose,
  onBack,
}: {
  current: string;
  onChoose: (module: string) => void;
  onBack: () => void;
}) {
  // Reopening the picker to switch modules opens on the one already in use.
  const currentIndex = ATOMIC_MODULES.findIndex((m) => m.value === current.toLowerCase());
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground lg:min-h-0"
      >
        <CaretLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {msg("submit.composition.back")}
      </button>
      <Carousel
        items={ATOMIC_MODULES}
        itemKey={(m) => m.value}
        renderItem={(m) => <ModuleSlide module={m} onChoose={onChoose} />}
        // The step heading rides the carousel's own header row, opposite the
        // position counter, rather than sitting above it as a second block.
        title={
          <span className="text-sm font-semibold tracking-tight">
            <HelpTip text={tip("module.choice")}>{msg("submit.module.picker_title")}</HelpTip>
          </span>
        }
        ariaLabel={msg("submit.module.carousel_aria")}
        jumpIndices={currentIndex >= 0 ? [currentIndex] : undefined}
        fluid
      />
    </div>
  );
}

function ModuleSlide({
  module,
  onChoose,
}: {
  module: (typeof ATOMIC_MODULES)[number];
  onChoose: (module: string) => void;
}) {
  const { value, label, icon, tipKey, taglineKey, Banner } = module;
  return (
    <PickerSlide
      Banner={Banner}
      icon={icon}
      label={label}
      labelDir="ltr"
      tagline={msg(taglineKey)}
      description={moduleDescription(label, tipKey)}
      chooseName={formatMsg("submit.module.choose", { p1: label })}
      onChoose={() => onChoose(value)}
    />
  );
}

/**
 * A module's description, without the leading `"<Label> — "`.
 *
 * The tooltip copy is the one definition of each module in every locale, and
 * the slide already carries the label as its heading — so the opener is
 * stripped here rather than maintained as a second description per locale
 * that would drift from the tooltip. Copy without the opener passes through.
 * What follows the dash continues the label mid-sentence, so it is recased to
 * stand alone; scripts without case are unaffected.
 */
function moduleDescription(label: string, tipKey: TooltipKey): string {
  const text = tip(tipKey);
  const opener = `${label} — `;
  if (!text.startsWith(opener)) return text;
  const rest = text.slice(opener.length);
  return rest.charAt(0).toLocaleUpperCase(getActiveIntlLocale()) + rest.slice(1);
}

function PredictBanner() {
  return (
    <BannerFrame>
      <GWire d="M60 44 H98" />
      <GWire d="M142 44 H180" />
      <GBox x={26} y={33} w={34} h={22} />
      <GBar x={34} y={40} w={18} />
      <GBar x={34} y={46} w={12} />
      <GBox x={98} y={29} w={44} h={30} accent />
      <GBar x={110} y={43} w={20} />
      <GBox x={180} y={33} w={34} h={22} />
      <GBar x={188} y={40} w={18} />
      <GBar x={188} y={46} w={12} />
    </BannerFrame>
  );
}

function CotBanner() {
  return (
    <BannerFrame>
      <GWire d="M54 44 H94" />
      <GWire d="M146 44 H186" />
      <GBox x={22} y={33} w={32} h={22} />
      <GBar x={29} y={42} w={18} />
      <GBox x={94} y={16} w={52} h={56} accent />
      {/* The reasoning field, then the answer it leads to. */}
      <GBox x={102} y={23} w={36} h={20} />
      <GBar x={108} y={29} w={24} />
      <GBar x={108} y={35} w={16} />
      <GWire d="M120 43 V51" />
      <GBox x={102} y={51} w={36} h={14} />
      <GBar x={108} y={57} w={24} />
      <GBox x={186} y={33} w={32} h={22} />
      <GBar x={193} y={42} w={18} />
    </BannerFrame>
  );
}

function ReactBanner() {
  return (
    <BannerFrame>
      <GWire d="M50 34 H90" />
      <GWire d="M146 34 H190" />
      {/* The think/act loop: down into a tool, back up with its result. */}
      <GWire d="M104 46 V62" />
      <GWire d="M128 62 V46" />
      <GArrow x={104} y={62} dir="down" />
      <GArrow x={128} y={46} dir="up" />
      <GBox x={18} y={23} w={32} h={22} />
      <GBar x={25} y={32} w={18} />
      <GBox x={90} y={22} w={56} h={24} accent />
      <GBar x={104} y={32} w={28} />
      <GBox x={96} y={62} w={44} h={16} />
      <GBar x={106} y={69} w={24} />
      <GBox x={190} y={23} w={32} h={22} />
      <GBar x={197} y={32} w={18} />
    </BannerFrame>
  );
}

function FlexBanner() {
  return (
    <BannerFrame>
      {/* The program's own code, rewritten by the optimizer. */}
      <GWire d="M108 44 H128" />
      <GArrow x={132} y={44} dir="right" />
      <GBox x={26} y={16} w={78} h={56} />
      <GBar x={38} y={29} w={44} />
      <GBar x={38} y={37} w={54} />
      <GBar x={38} y={45} w={34} />
      <GBar x={38} y={53} w={46} />
      <GBox x={136} y={16} w={78} h={56} accent />
      <GBar x={148} y={29} w={52} />
      <GBar x={148} y={37} w={36} />
      <GBar x={148} y={45} w={48} />
      <GBar x={148} y={53} w={28} />
      <path
        d="M204 18 L206 23 L211 25 L206 27 L204 32 L202 27 L197 25 L202 23 Z"
        fill="#3D2E22"
        fillOpacity={0.35}
      />
    </BannerFrame>
  );
}

function WorkflowBanner() {
  return (
    <BannerFrame>
      <GWire d="M44 44 C68 44 70 19 92 19" />
      <GWire d="M44 44 C68 44 70 69 92 69" />
      <GWire d="M144 19 C166 19 172 44 196 44" />
      <GWire d="M144 69 C166 69 172 44 196 44" />
      <GBox x={14} y={33} w={30} h={22} />
      <GBar x={21} y={42} w={16} />
      <GBox x={92} y={8} w={52} h={22} accent />
      <GBar x={102} y={17} w={32} />
      <GBox x={92} y={58} w={52} h={22} accent />
      <GBar x={102} y={67} w={32} />
      <GBox x={196} y={33} w={30} h={22} />
      <GBar x={203} y={42} w={16} />
    </BannerFrame>
  );
}
