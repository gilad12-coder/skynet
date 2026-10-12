"use client";

import { ArrowRight, PaperPlaneTilt } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { CopyGlyph, useCopyToClipboard } from "@/shared/ui/copy-button";
import { FadeIn } from "@/shared/ui/motion";
import { notifyCopied } from "@/shared/lib/notify";
import { msg } from "@/shared/lib/messages";
import {
  formatBlackboxDelta,
  formatBlackboxScore,
  formatImprovement,
  formatPercent,
} from "@/shared/lib";
import { blackboxBaselineScore, blackboxBestScore } from "@/shared/lib/blackbox-scores";
import type {
  NodeArtifact,
  OptimizationStatusResponse,
  OptimizedPredictor,
  ReactOverlay,
} from "@/shared/types/api";
import { buildVersions, defaultVersionIndex } from "../lib/blackbox-versions";

/** Baseline → optimized scores of a finished run, as the Overview score cards read them. */
export interface RunResultScores {
  baseline: number | null;
  optimized: number | null;
  improvement: number | null;
  isBlackbox: boolean;
}

/**
 * Read a standalone run's baseline and optimized scores from the same sources
 * the Overview score cards use: `job.result`, then `blackbox_result`, then the
 * evaluation progress events.
 *
 * Args:
 *   job: The run's status payload.
 *
 * Returns:
 *   The scores; a score the run never measured (e.g. no test split) is null.
 */
export function runResultScores(job: OptimizationStatusResponse): RunResultScores {
  const isBlackbox = job.optimization_type === "blackbox";
  const bbResult = isBlackbox ? job.blackbox_result : null;
  const events = job.progress_events ?? [];
  const baselineFromEvents = events.find((e) => e.event === "baseline_evaluated")?.metrics
    ?.baseline_test_metric as number | undefined;
  const optimizedFromEvents = events.find((e) => e.event === "optimized_evaluated")?.metrics
    ?.optimized_test_metric as number | undefined;
  const baseline =
    job.result?.baseline_test_metric ?? blackboxBaselineScore(bbResult) ?? baselineFromEvents;
  const optimized =
    job.result?.optimized_test_metric ?? blackboxBestScore(bbResult) ?? optimizedFromEvents;
  const improvement =
    baseline != null && optimized != null
      ? (job.result?.metric_improvement ?? bbResult?.metric_improvement ?? optimized - baseline)
      : null;
  return { baseline: baseline ?? null, optimized: optimized ?? null, improvement, isBlackbox };
}

/** The optimized artifact projections the Artifact tab already receives. */
export interface ResultArtifactSources {
  job: OptimizationStatusResponse;
  optimizedPrompt?: OptimizedPredictor | null;
  reactOverlay?: ReactOverlay | null;
  optimizedModuleSrc?: string | null;
  optimizedNodes?: Record<string, NodeArtifact> | null;
}

/**
 * Render a tuned react overlay as one line per tool description.
 *
 * Args:
 *   overlay: The react run's tuned tool overlay.
 *
 * Returns:
 *   The tool descriptions as text, under their proposed display names.
 */
function overlayText(overlay: ReactOverlay): string {
  return Object.entries(overlay.tool_descriptions)
    .map(([tool, description]) => `${overlay.tool_names?.[tool] ?? tool}: ${description}`)
    .join("\n");
}

/**
 * Render one workflow node's optimized surface as text.
 *
 * Args:
 *   node: The node's optimized artifact.
 *
 * Returns:
 *   Its rewritten code, prompt or tool descriptions; empty when it has none.
 */
function nodeText(node: NodeArtifact): string {
  if (node.optimized_src) return node.optimized_src;
  if (node.optimized_prompt) return predictorText(node.optimized_prompt);
  if (node.react_overlay) return overlayText(node.react_overlay);
  return "";
}

/**
 * Render an optimized predictor as the prompt the model is sent.
 *
 * Args:
 *   predictor: The optimized predictor.
 *
 * Returns:
 *   The formatted prompt, or the bare instructions when none was formatted.
 */
function predictorText(predictor: OptimizedPredictor): string {
  return predictor.formatted_prompt || predictor.instructions;
}

/**
 * Pick the improved artifact of a run as copyable text, whatever kind the run
 * optimized: a workflow's nodes, rewritten program code, a react agent's tool
 * descriptions, a prompt, or a black-box run's winning version.
 *
 * Args:
 *   sources: The run and the artifact projections the Artifact tab shows.
 *
 * Returns:
 *   The artifact text; empty when the run produced none.
 */
export function resultArtifactText(sources: ResultArtifactSources): string {
  const { job, optimizedPrompt, reactOverlay, optimizedModuleSrc, optimizedNodes } = sources;
  const nodes = Object.entries(optimizedNodes ?? {})
    .map(([key, node]) => [key, nodeText(node)] as const)
    .filter(([, text]) => text);
  if (nodes.length > 0) return nodes.map(([key, text]) => `## ${key}\n${text}`).join("\n\n");
  if (optimizedModuleSrc) return optimizedModuleSrc;
  if (reactOverlay) return overlayText(reactOverlay);
  if (optimizedPrompt) return predictorText(optimizedPrompt);
  if (job.blackbox_result) {
    const versions = buildVersions(job.blackbox_result);
    return versions[defaultVersionIndex(versions)]?.text ?? "";
  }
  return "";
}

/**
 * The headline of a finished run: baseline → optimized score, the improved
 * artifact, and the actions a newcomer needs next.
 *
 * Args:
 *   scores: The run's scores; the score line hides when either is missing.
 *   artifactText: The improved artifact, as copyable text.
 *   onTryIt: Opens the playground; the button hides when there is none.
 *   onSeeDetails: Shows the full tabbed page; the link hides when absent.
 *
 * Returns:
 *   The result card.
 */
export function RunResultCard({
  scores,
  artifactText,
  onTryIt,
  onSeeDetails,
}: {
  scores: RunResultScores;
  artifactText: string;
  onTryIt?: () => void;
  onSeeDetails?: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const { baseline, optimized, improvement, isBlackbox } = scores;
  const fmtScore = isBlackbox ? formatBlackboxScore : formatPercent;
  const fmtDelta = isBlackbox ? formatBlackboxDelta : formatImprovement;
  const hasScores = baseline != null && optimized != null;
  const regressed = (improvement ?? 0) < 0;

  return (
    <FadeIn>
      <section
        data-run-result-card=""
        className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      >
        <h2 className="text-base font-bold tracking-tight">{msg("optimization.result.title")}</h2>
        {hasScores && (
          <div data-result-scores="" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {msg("optimization.result.score")}
            </span>
            <span dir="ltr" className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-lg text-muted-foreground">{fmtScore(baseline)}</span>
              <ArrowRight className="size-4 self-center text-muted-foreground" aria-hidden="true" />
              <span className="text-2xl font-bold text-primary">{fmtScore(optimized)}</span>
              <span
                className={`text-sm font-semibold ${regressed ? "text-[var(--danger)]" : "text-[var(--success)]"}`}
              >
                {fmtDelta(improvement)}
              </span>
            </span>
          </div>
        )}
        <pre
          dir="auto"
          data-result-artifact=""
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        >
          {artifactText}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-result-copy=""
            onClick={async () => {
              if (await copy(artifactText)) notifyCopied();
            }}
          >
            <CopyGlyph copied={copied} />
            {msg("optimization.result.copy")}
          </Button>
          {onTryIt && (
            <Button type="button" size="sm" data-result-try="" onClick={onTryIt}>
              <PaperPlaneTilt className="size-3.5" />
              {msg("optimization.result.try_it")}
            </Button>
          )}
          {onSeeDetails && (
            <Button
              type="button"
              variant="link"
              size="sm"
              data-result-details=""
              className="ms-auto"
              onClick={onSeeDetails}
            >
              {msg("optimization.result.see_details")}
            </Button>
          )}
        </div>
      </section>
    </FadeIn>
  );
}
