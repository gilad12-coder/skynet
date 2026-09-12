"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";

import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  User,
  Code,
  Tag,
  Cube,
  Target,
  FileText,
  Columns,
  Shuffle,
  Database,
  Cpu,
  Gauge,
  Lock,
  Globe,
  Coins,
  Key,
  Wrench,
  Warning,
} from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { ModelChip } from "@/shared/ui/model-chip";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits } from "@/features/billing";
import { harnessLabel } from "@/shared/lib/blackbox-harness";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { chargeableBracket } from "../../lib/cost-bracket";
import { OPTIMIZATION_MODEL_DESCRIPTION } from "../../lib/model-roles";
import { Figure, buildEstimateSections } from "../EstimateBreakdown";
import { ModelRoleRow } from "./ModelRoleRow";

/** One key/value line: an icon-and-label on the start, its value on the end. */
function Row({
  icon,
  label,
  tipText,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  tipText?: string;
  children: ReactNode;
}) {
  const head = (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5">
      {tipText ? <HelpTip text={tipText}>{head}</HelpTip> : head}
      <span className="max-w-[55%] break-words text-end text-sm font-medium" dir="auto">
        {children}
      </span>
    </div>
  );
}

const COLLAPSED_NOTE_LINES = 4;
// text-sm line-height (1.25rem) x four lines; the exact value is measured below.
const DEFAULT_COLLAPSED_NOTE_HEIGHT = 80;

// The clamp height must be measured before paint so the note renders already
// collapsed with no full-height flash; useLayoutEffect warns during SSR, so
// fall back to useEffect off the client.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A long-form field: a label above its wrapped text, expandable when it overflows four lines. */
function Note({
  icon,
  label,
  tipText,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  tipText: string;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const reducedMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [interacted, setInteracted] = useState(false);
  // Start collapsed so long text never flashes full before measurement lands.
  const [overflows, setOverflows] = useState(true);
  const [collapsedHeight, setCollapsedHeight] = useState(DEFAULT_COLLAPSED_NOTE_HEIGHT);
  const [fullHeight, setFullHeight] = useState<number>();

  // Measure both heights in pixels (and keep them fresh on reflow) so the
  // toggle animates number-to-number in both directions. framer-motion snaps
  // instead of animating when a height transition starts from the "auto"
  // keyword, so the expanded state must be an explicit pixel height too.
  useIsomorphicLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      const collapsed = Number.isFinite(lineHeight)
        ? lineHeight * COLLAPSED_NOTE_LINES
        : DEFAULT_COLLAPSED_NOTE_HEIGHT;
      setCollapsedHeight(collapsed);
      setFullHeight(el.scrollHeight);
      setOverflows(el.scrollHeight > collapsed + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  const clamped = overflows && !expanded;

  return (
    <div className="space-y-1.5 border-b border-border/40 py-2.5">
      <HelpTip text={tipText}>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </span>
      </HelpTip>
      <motion.div
        initial={false}
        animate={{ height: clamped ? collapsedHeight : (fullHeight ?? "auto") }}
        // The initial collapse (measurement landing) is instant; only real toggles animate.
        transition={{ duration: reducedMotion || !interacted ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden"
      >
        <p ref={bodyRef} className="whitespace-pre-wrap text-sm text-foreground" dir="auto">
          {children}
        </p>
      </motion.div>
      {overflows && (
        <button
          type="button"
          onClick={() => {
            setInteracted(true);
            setExpanded((v) => !v);
          }}
          className="text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          {msg(expanded ? "shared.expandable_textarea.collapse" : "shared.expandable_textarea.expand")}
        </button>
      )}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs" dir="ltr">
      {children}
    </span>
  );
}

/**
 * The blackbox review, carried by the same carousel the DSPy summary uses: a
 * sliding-pill tab bar over an animated body. Each tab reads the values the run
 * is submitted with, and the last tab carries the cost estimate and budget.
 */
export function BlackboxSummaryStep({ w }: { w: BlackboxWizardContext }) {
  const [summaryTab, setSummaryTab] = useState(0);
  const {
    jobName,
    suggestedName,
    isPrivate,
    seedMode,
    seedText,
    seedParts,
    objective,
    background,
    targetKind,
    harness,
    targetModel,
    parsedCases,
    split,
    shuffle,
    scorerKind,
    metricCode,
    scorerUrl,
    scorerUsesModel,
    resolvedScorerModel,
    scorerInstall,
    strategyMode,
    selectedEngine,
    runDisabledReason,
    iterationLimitSupported,
    maxScorerRuns,
    maxIterations,
    stopAtScore,
    reflectionModel,
    optimizationFamily,
    costBracket,
    tokenSource,
  } = w;

  const locale = getActiveIntlLocale();
  const byok = tokenSource === "byok";
  const estimate = chargeableBracket(costBracket, tokenSource);
  const estimateLabel = byok
    ? msg("submit.summary.estimate_fee")
    : msg("submit.summary.estimate_cost");
  const { estimateSections } = buildEstimateSections(estimate, locale);

  const displayName = jobName.trim() || suggestedName;
  const notChosen = msg("submit.blackbox.roles.not_chosen");
  const taskLabel = msg("submit.blackbox.roles.task.label");
  const optLabel = msg("submit.blackbox.roles.optimization.label");
  const scoringLabel = msg("submit.blackbox.roles.scoring.label");

  const startSummary =
    seedMode === "none" || (seedMode === "text" && !seedText.trim())
      ? msg("submit.blackbox.review.start_none")
      : seedMode === "text"
        ? formatMsg("submit.blackbox.review.start_text", { chars: seedText.length })
        : formatMsg("submit.blackbox.review.start_parts", {
            n: seedParts.filter((p) => p.value.trim()).length,
          });

  const hasHoldout = split.val > 0 || split.test > 0;
  const scorerCodeLines = metricCode.split("\n").length;

  const tabs: Array<{ id: string; label: string; icon: ReactNode }> = [
    {
      id: "general",
      label: msg("auto.features.submit.components.steps.summarystep.literal.1"),
      icon: <User className="size-3.5" />,
    },
    {
      id: "cases",
      label: msg("submit.stage.evaluation"),
      icon: <Database className="size-3.5" />,
    },
    {
      id: "models",
      label: msg("submit.blackbox.review.models"),
      icon: <Cpu className="size-3.5" />,
    },
    { id: "optimizer", label: TERMS.optimizer, icon: <Target className="size-3.5" /> },
    {
      id: "scorer",
      label: msg("submit.blackbox.scorer.title"),
      icon: <Code className="size-3.5" />,
    },
    {
      id: "budget",
      label: msg("submit.blackbox.review.budget"),
      icon: <Coins className="size-3.5" />,
    },
  ];

  return (
    <div className="space-y-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
        className="overflow-hidden rounded-2xl border border-border bg-card/80 shadow-lg backdrop-blur-xl"
      >
        <div className="relative flex gap-0.5 border-b border-border bg-secondary/50 p-1">
          <div
            className="pointer-events-none absolute top-1 bottom-1 rounded-lg bg-background shadow-sm transition-[inset-inline-start] duration-200 ease-out"
            style={{
              width: `calc((100% - 12px) / ${tabs.length})`,
              insetInlineStart: `calc(${summaryTab} * ${100 / tabs.length}% + 4px)`,
            }}
          />
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSummaryTab(i)}
              className={cn(
                "relative z-10 flex min-h-[44px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg py-2.5 text-xs font-medium transition-colors duration-150 lg:min-h-0",
                summaryTab === i
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="p-4 sm:p-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={summaryTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
            >
              {summaryTab === 0 && (
                <div className="space-y-0">
                  <Row
                    icon={<Tag className="size-3.5" />}
                    label={
                      <>
                        {msg("auto.features.submit.components.steps.basicsstep.3")}
                        {TERMS.optimization}
                      </>
                    }
                    tipText={tip("submit.name")}
                  >
                    {displayName || "—"}
                    {displayName && !jobName.trim() && (
                      <span className="ms-2 text-xs font-normal text-muted-foreground">
                        {msg("submit.blackbox.review.name_suggested")}
                      </span>
                    )}
                  </Row>
                  <Row
                    icon={<Cube className="size-3.5" />}
                    label={msg("submit.blackbox.review.start")}
                    tipText={tip("submit.blackbox.review_start")}
                  >
                    {startSummary}
                  </Row>
                  <Row
                    icon={isPrivate ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
                    label={msg("submit.basics.privacy.label")}
                    tipText={tip("submit.privacy")}
                  >
                    {msg(isPrivate ? "submit.basics.privacy.private" : "submit.basics.privacy.public")}
                  </Row>
                  <Row
                    icon={byok ? <Key className="size-3.5" /> : <Coins className="size-3.5" />}
                    label={msg("submit.budget.billing_source")}
                    tipText={msg(byok ? "billing.mode.byok_hint" : "billing.mode.managed_hint")}
                  >
                    {msg(byok ? "billing.mode.byok" : "billing.mode.managed")}
                  </Row>
                  {objective.trim() && (
                    <Note
                      icon={<FileText className="size-3.5" />}
                      label={msg("submit.blackbox.start.objective_label")}
                      tipText={tip("submit.blackbox.objective")}
                    >
                      {objective}
                    </Note>
                  )}
                  {background.trim() && (
                    <Note
                      icon={<FileText className="size-3.5" />}
                      label={msg("submit.blackbox.start.background_label")}
                      tipText={tip("submit.blackbox.background")}
                    >
                      {background}
                    </Note>
                  )}
                </div>
              )}

              {summaryTab === 1 && (
                <div className="space-y-4">
                  <Row
                    icon={<FileText className="size-3.5" />}
                    label={msg("submit.stage.evaluation")}
                    tipText={tip("submit.blackbox.review_cases")}
                  >
                    {parsedCases
                      ? formatMsg("submit.blackbox.cases.loaded", {
                          rows: parsedCases.rowCount,
                          cols: parsedCases.columns.length,
                        })
                      : msg("submit.blackbox.review.cases_none")}
                  </Row>
                  {parsedCases && (
                    <div className="space-y-3">
                      <HelpTip text={tip("submit.blackbox.review_cases")}>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Columns className="size-3.5" />
                          {hasHoldout
                            ? formatMsg("submit.blackbox.review.cases_split", {
                                train: Math.round(split.train * 100),
                                val: Math.round(split.val * 100),
                                test: Math.round(split.test * 100),
                              })
                            : msg("submit.blackbox.review.cases_all")}
                        </span>
                      </HelpTip>
                      <div className="flex h-3 overflow-hidden rounded-full">
                        <div className="bg-[#3D2E22]" style={{ width: `${split.train * 100}%` }} />
                        <div className="bg-[#C8A882]" style={{ width: `${split.val * 100}%` }} />
                        <div className="bg-[#8C7A6B]" style={{ width: `${split.test * 100}%` }} />
                      </div>
                    </div>
                  )}
                  <Row icon={<Shuffle className="size-3.5" />} label={msg("submit.blackbox.review.cases_shuffled")}>
                    {shuffle
                      ? msg("auto.features.submit.components.steps.summarystep.literal.9")
                      : msg("auto.features.submit.components.steps.summarystep.literal.10")}
                  </Row>
                </div>
              )}

              {summaryTab === 2 && (
                <div className="space-y-3">
                  <div className="pointer-events-none space-y-3">
                    {targetKind === "agent" && (
                      <ModelRoleRow role={taskLabel}>
                        <ModelChip
                          config={targetModel}
                          roleLabel={taskLabel}
                          onClick={() => {}}
                        />
                      </ModelRoleRow>
                    )}
                    <ModelRoleRow
                      role={optLabel}
                      description={msg(OPTIMIZATION_MODEL_DESCRIPTION[optimizationFamily])}
                    >
                      <ModelChip config={reflectionModel} roleLabel={optLabel} onClick={() => {}} />
                    </ModelRoleRow>
                    {scorerUsesModel ? (
                      <ModelRoleRow role={scoringLabel}>
                        {resolvedScorerModel ? (
                          <ModelChip
                            config={resolvedScorerModel}
                            roleLabel={scoringLabel}
                            onClick={() => {}}
                          />
                        ) : (
                          <span className="text-sm text-muted-foreground">{notChosen}</span>
                        )}
                      </ModelRoleRow>
                    ) : (
                      <div className="space-y-1">
                        <span className="text-sm font-medium">
                          {msg("submit.blackbox.roles.scoring.deterministic_label")}
                        </span>
                        <p className="text-xs text-muted-foreground">
                          {msg("submit.blackbox.roles.scoring.deterministic_desc")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {summaryTab === 3 && (
                <div className="space-y-0">
                  <Row
                    icon={<Target className="size-3.5" />}
                    label={msg("submit.blackbox.review.strategy")}
                    tipText={tip("submit.blackbox.strategy")}
                  >
                    {strategyMode === "auto"
                      ? msg("submit.blackbox.strategy.auto")
                      : (selectedEngine?.label ?? msg("submit.blackbox.strategy.single"))}
                  </Row>
                  {targetKind === "agent" && (
                    <Row
                      icon={<Wrench className="size-3.5" />}
                      label={msg("submit.blackbox.review.execution")}
                    >
                      {harnessLabel(harness)}
                    </Row>
                  )}
                  <Row
                    icon={<Gauge className="size-3.5" />}
                    label={msg("submit.blackbox.review.budget")}
                    tipText={tip("submit.blackbox.budget")}
                  >
                    {[
                      formatMsg("submit.blackbox.review.budget_runs", { runs: maxScorerRuns }),
                      iterationLimitSupported && maxIterations !== ""
                        ? formatMsg("submit.blackbox.review.budget_iterations", {
                            n: maxIterations,
                          })
                        : null,
                      stopAtScore.trim()
                        ? formatMsg("submit.blackbox.review.budget_stop", {
                            score: stopAtScore.trim(),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Row>
                  {runDisabledReason && (
                    <span
                      className="mt-1 flex items-start gap-1.5 text-xs text-amber-700"
                      role="status"
                    >
                      <Warning className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span>{runDisabledReason}</span>
                    </span>
                  )}
                </div>
              )}

              {summaryTab === 4 && (
                <div className="space-y-3">
                  {scorerKind !== "python" && (
                    <Row
                      icon={<Code className="size-3.5" />}
                      label={msg("submit.blackbox.scorer.title")}
                      tipText={tip("submit.blackbox.review_scorer")}
                    >
                      <Mono>{scorerUrl}</Mono>
                    </Row>
                  )}
                  {scorerKind === "python" && metricCode.trim() && (
                    <div dir="ltr">
                      <CodeEditor
                        value={metricCode}
                        onChange={() => {}}
                        height={`${Math.min(scorerCodeLines + 1, 12) * 19.6 + 8}px`}
                        readOnly
                      />
                    </div>
                  )}
                  {scorerKind === "python" && scorerInstall.trim() !== "" && (
                    <Row
                      icon={<Wrench className="size-3.5" />}
                      label={msg("submit.blackbox.scorer.install_label")}
                      tipText={tip("submit.blackbox.scorer_install")}
                    >
                      <Mono>{scorerInstall.trim()}</Mono>
                    </Row>
                  )}
                </div>
              )}

              {summaryTab === 5 && (
                <div className="space-y-3">
                  <Row
                    icon={<Coins className="size-3.5" />}
                    label={estimateLabel}
                    tipText={tip("submit.estimate")}
                  >
                    {/* The value opens the same calculation the main budget card
                        unfolds, built from the bracket's trace. Isolate "low–high"
                        as one LTR run (U+2066…U+2069) so the en-dash between the two
                        number groups doesn't flip them under RTL. */}
                    <Figure
                      label={estimateLabel}
                      value={formatMsg("submit.summary.estimate_range", {
                        low: `⁦${formatCredits(estimate.lowCredits, locale)}`,
                        high: `${formatCredits(estimate.highCredits, locale)}⁩`,
                      })}
                      sections={estimateSections}
                      className="text-sm"
                    />
                  </Row>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
