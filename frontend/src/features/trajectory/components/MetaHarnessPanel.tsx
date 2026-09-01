"use client";

import { motion } from "framer-motion";
import { TrendUp } from "@/shared/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OptimizationStatusResponse } from "@/shared/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/primitives/card";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatBlackboxScore } from "@/shared/lib";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { useLiteMode } from "@/features/settings";
import {
  extractCandidates,
  extractMinibatch,
  extractValset,
  extractValsetOutputs,
} from "../lib/extract-events";
import { layoutTrajectory } from "../lib/layout";
import { buildClimb, extractCaseScores, scopeToVersionLane } from "../lib/meta-harness";
import { displayCandidateId, type BlackboxTrajectoryContext } from "../lib/types";
import { MetaHarnessCaseGrid } from "./MetaHarnessCaseGrid";
import { MetaHarnessClimb } from "./MetaHarnessClimb";
import { MetaHarnessOutline } from "./MetaHarnessOutline";
import { TrajectoryDrawer, type DrawerSelection } from "./TrajectoryDrawer";

const NEWEST_HIGHLIGHT_MS = 2200;

const BLACKBOX_FALLBACK: BlackboxTrajectoryContext = {
  recipe: null,
  hasCases: false,
  rendersByText: new Map(),
};

// Why the engine stopped, as the result's details name it.
const STOP_REASONS: Record<string, MessageKey> = {
  target_reached: "meta_harness.stopped.target_reached",
  max_iterations: "meta_harness.stopped.max_iterations",
  budget_exhausted: "meta_harness.stopped.budget_exhausted",
  no_new_proposal: "meta_harness.stopped.no_new_proposal",
};

function isLive(job: OptimizationStatusResponse): boolean {
  return job.status === "running" || job.status === "validating" || job.status === "pending";
}

export interface MetaHarnessPanelProps {
  job: OptimizationStatusResponse;
  // Run configuration of the black-box run, forwarded to the drawer so it
  // names versions by kind and shows per-case scores only when cases exist.
  blackbox?: BlackboxTrajectoryContext | null;
}

/**
 * Run view of a meta-harness lane. The engine hill-climbs — it rewrites the
 * best version so far and scores every candidate on all cases — so the run is
 * a climb rather than a tree: the chart lays versions out in scoring order
 * with the best so far as a staircase, and the heatmap under it shows how each
 * version did case by case, filling in live while a version is being scored.
 */
export function MetaHarnessPanel({ job, blackbox }: MetaHarnessPanelProps) {
  const live = isLive(job);
  const lite = useLiteMode();
  const blackboxCtx = blackbox ?? BLACKBOX_FALLBACK;
  const { candidates, model, valsetRows, minibatch, valsetOutputs } = useMemo(() => {
    const events = job.progress_events ?? [];
    const scoped = scopeToVersionLane(events);
    const found = extractCandidates(scoped);
    return {
      candidates: found,
      model: buildClimb(found, extractCaseScores(scoped)),
      valsetRows: extractValset(events),
      minibatch: extractMinibatch(scoped),
      valsetOutputs: extractValsetOutputs(scoped),
    };
  }, [job.progress_events]);
  const treeLayout = useMemo(() => layoutTrajectory(candidates), [candidates]);
  const details = job.blackbox_result?.details ?? {};
  const proposals = typeof details.proposals === "number" ? details.proposals : null;
  const stopKey =
    typeof details.stopped === "string" ? (STOP_REASONS[details.stopped] ?? null) : null;
  const best = useMemo(
    () => model.versions.find((v) => v.candidate.candidate_id === model.bestId) ?? null,
    [model],
  );
  const pending = live ? model.pending : null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newestId, setNewestId] = useState<string | null>(null);
  const newestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCountRef = useRef(0);
  const liveRegionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId !== null && candidates.some((c) => c.candidate_id === selectedId)) return;
    setSelectedId(model.bestId ?? candidates[0]?.candidate_id ?? null);
  }, [candidates, model.bestId, selectedId]);

  useEffect(() => {
    if (candidates.length <= prevCountRef.current) {
      prevCountRef.current = candidates.length;
      return;
    }
    const newest = candidates[candidates.length - 1];
    prevCountRef.current = candidates.length;
    if (newest === undefined) return;
    setNewestId(newest.candidate_id);
    if (liveRegionRef.current !== null) {
      liveRegionRef.current.textContent = msg("meta_harness.live.new_version");
    }
    if (newestTimerRef.current !== null) clearTimeout(newestTimerRef.current);
    newestTimerRef.current = setTimeout(() => setNewestId(null), NEWEST_HIGHLIGHT_MS);
    return () => {
      if (newestTimerRef.current !== null) clearTimeout(newestTimerRef.current);
    };
    // Tracking the length only keeps this from re-running each time the
    // upstream useMemo reallocates ``candidates`` on an unrelated render.
  }, [candidates.length]);

  const drawerSelection: DrawerSelection = useMemo(() => {
    if (selectedId === null) return null;
    const node = treeLayout.nodes.find((n) => n.candidate_id === selectedId);
    if (node === undefined) return null;
    const parent =
      node.parent_id === null
        ? null
        : (treeLayout.nodes.find((n) => n.candidate_id === node.parent_id) ?? null);
    return { kind: "candidate", node, parent };
  }, [treeLayout.nodes, selectedId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setDrawerOpen(true);
  }, []);

  if (model.versions.length === 0 && pending === null) return null;

  const versionCount = formatMsg("meta_harness.header.versions", { n: model.versions.length });

  return (
    <FadeIn delay={0.12}>
      <Card
        className="relative overflow-hidden shadow-[0_1px_3px_rgba(28,22,18,0.04),inset_0_1px_0_rgba(255,255,255,0.5)]"
        data-tutorial="trajectory-panel"
      >
        <div
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-l from-transparent via-[#C8A882]/40 to-transparent"
          aria-hidden="true"
        />
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base flex min-w-0 items-center gap-2">
              <TrendUp className="size-4 text-[#7C6350]" aria-hidden="true" />
              <HelpTip text={msg("meta_harness.explainer")}>
                <span className="font-bold tracking-tight">{msg("meta_harness.panel.title")}</span>
              </HelpTip>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {best !== null ? (
                <span>
                  {msg("trajectory.outline.best")}{" "}
                  <span className="font-mono font-semibold text-foreground tabular-nums" dir="ltr">
                    {formatBlackboxScore(best.score)}
                  </span>
                </span>
              ) : null}
              {proposals !== null ? (
                <span className="tabular-nums">
                  {formatMsg("meta_harness.stats.proposals", { n: proposals })}
                </span>
              ) : null}
              {stopKey !== null && !live ? <span>{msg(stopKey)}</span> : null}
              {pending !== null ? (
                <span className="inline-flex items-center gap-1.5 tabular-nums" aria-live="polite">
                  <span
                    className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--warning)]"
                    aria-hidden="true"
                  />
                  {formatMsg("meta_harness.live.scoring", {
                    id: displayCandidateId(String(pending.index)),
                    done: pending.scores.size,
                    total: pending.total,
                  })}
                </span>
              ) : null}
            </div>
          </div>
          {live ? (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/40 bg-background/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              <span className="relative inline-flex size-2" aria-hidden="true">
                <motion.span
                  className="absolute inset-0 rounded-full bg-[var(--warning)]/40"
                  animate={{ scale: [1, 2, 1], opacity: [0.6, 0, 0.6] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
                />
                <span className="relative inline-block size-2 rounded-full bg-[var(--warning)]" />
              </span>
              <span className="tabular-nums">{versionCount}</span>
            </motion.div>
          ) : (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground tabular-nums">
              {versionCount}
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {lite ? (
            <MetaHarnessOutline
              model={model}
              live={live}
              selectedId={selectedId}
              newestId={newestId}
              onSelect={handleSelect}
            />
          ) : (
            <MetaHarnessClimb
              model={model}
              live={live}
              selectedId={selectedId}
              newestId={newestId}
              onSelect={handleSelect}
            />
          )}
          <MetaHarnessCaseGrid
            model={model}
            live={live}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
          <TrajectoryDrawer
            selection={drawerSelection}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            valsetRows={valsetRows}
            minibatch={minibatch}
            blackbox={blackboxCtx}
            valsetOutputs={valsetOutputs}
          />
          <div ref={liveRegionRef} role="status" aria-live="polite" className="sr-only" />
        </CardContent>
      </Card>
    </FadeIn>
  );
}
