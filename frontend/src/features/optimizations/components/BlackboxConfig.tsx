"use client";

import type { ReactNode } from "react";
import { Cube, Database, Gauge, Gear, GitMerge, Shuffle, Target, Wrench } from "@/shared/ui/icons";
import { harnessLabel } from "@/shared/lib/blackbox-harness";
import { FadeIn } from "@/shared/ui/motion";
import type {
  BlackboxBudget,
  BlackboxScorer,
  BlackboxStrategy,
  BlackboxTarget,
  OptimizationStatusResponse,
} from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { InfoCard } from "./ui-primitives";

function modelName(cfg: Record<string, unknown> | null): string {
  if (!cfg) return "—";
  const provider = typeof cfg.provider === "string" ? cfg.provider : "";
  const model = typeof cfg.model === "string" ? cfg.model : "";
  if (!model) return "—";
  return provider ? `${provider}/${model}` : model;
}

/**
 * Config view for a black-box run. Reads the raw payload the wizard sent;
 * the scorer secret is deliberately never surfaced — only the scorer kind
 * and, for remote scorers, the endpoint URL.
 */
export function BlackboxConfigCard({
  job,
  payload,
}: {
  job: OptimizationStatusResponse;
  payload: Record<string, unknown>;
}) {
  const strategy = (payload.strategy ?? {}) as Partial<BlackboxStrategy>;
  const budget = (payload.budget ?? {}) as Partial<BlackboxBudget>;
  const target = (payload.target ?? {}) as Partial<BlackboxTarget>;
  const scorer = (payload.scorer ?? {}) as Partial<BlackboxScorer>;
  const reflection = (payload.reflection_model_config ?? null) as Record<string, unknown> | null;
  const split = (payload.split_fractions ?? job.split_fractions ?? null) as {
    train: number;
    val: number;
    test: number;
  } | null;
  const cases = Array.isArray(payload.cases) ? payload.cases.length : null;
  const objective = typeof payload.objective === "string" ? payload.objective : "";
  const background = typeof payload.background === "string" ? payload.background : "";
  const engine = job.blackbox_result?.engine_used ?? strategy.engine;
  const splitCounts = job.blackbox_result?.split_counts ?? null;
  const timeout =
    typeof scorer.timeout_seconds === "number"
      ? formatMsg("optimization.blackbox.config.scorer_timeout", {
          seconds: scorer.timeout_seconds,
        })
      : null;

  const budgetParts = [
    formatMsg("optimization.blackbox.config.budget_runs", { n: budget.max_scorer_runs ?? "—" }),
    budget.max_iterations != null
      ? formatMsg("optimization.blackbox.config.budget_iterations", { n: budget.max_iterations })
      : null,
    budget.stop_at_score != null
      ? formatMsg("optimization.blackbox.config.budget_stop", { score: budget.stop_at_score })
      : null,
  ].filter((x): x is string => x != null);

  const targetValue =
    target.kind === "agent"
      ? [target.harness ? harnessLabel(target.harness) : null, target.model]
          .filter(Boolean)
          .join(" · ") || msg("optimization.blackbox.config.target_agent")
      : msg("optimization.blackbox.config.target_text");

  const items: Array<{ label: ReactNode; value: string; icon: ReactNode }> = [
    {
      label: msg("optimization.blackbox.config.strategy"),
      value:
        strategy.mode === "single"
          ? msg("submit.blackbox.strategy.single")
          : strategy.mode === "plateau"
            ? msg("submit.blackbox.strategy.plateau")
            : msg("submit.blackbox.strategy.auto"),
      icon: <GitMerge className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.engine"),
      value: engine ?? "—",
      icon: <Cube className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.budget"),
      value: budgetParts.join(" · "),
      icon: <Gauge className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.target"),
      value: targetValue,
      icon: <Target className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.scorer"),
      value: [
        scorer.kind === "remote"
          ? `${msg("submit.blackbox.scorer.kind.remote")} · ${scorer.url ?? "—"}`
          : msg("submit.blackbox.scorer.kind.python"),
        timeout,
      ]
        .filter(Boolean)
        .join(" · "),
      icon: <Wrench className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.reflection_model"),
      value: modelName(reflection),
      icon: <Gear className="size-3.5" />,
    },
    {
      label: msg("optimization.blackbox.config.cases"),
      value:
        cases != null && cases > 0
          ? formatMsg("optimization.blackbox.config.cases_count", { n: cases })
          : msg("submit.blackbox.review.cases_none"),
      icon: <Database className="size-3.5" />,
    },
    ...(split
      ? [
          {
            label: msg("optimization.blackbox.config.split"),
            value:
              split.val === 0 && split.test === 0
                ? msg("optimization.blackbox.config.split_all")
                : `${Math.round(split.train * 100)} / ${Math.round(split.val * 100)} / ${Math.round(split.test * 100)}`,
            icon: <Shuffle className="size-3.5" />,
          },
        ]
      : []),
    ...(splitCounts && (splitCounts.train ?? 0) > 0
      ? [
          {
            label: msg("optimization.blackbox.config.split_counts"),
            value: formatMsg("optimization.blackbox.config.split_counts_value", {
              train: splitCounts.train ?? 0,
              val: splitCounts.val ?? 0,
              test: splitCounts.test ?? 0,
            }),
            icon: <Database className="size-3.5" />,
          },
        ]
      : []),
  ];

  return (
    <>
      <FadeIn>
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          {msg("optimization.blackbox.config.intro")}
        </p>
      </FadeIn>
      <FadeIn delay={0.05}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, i) => (
            <InfoCard key={i} label={item.label} value={item.value} icon={item.icon} />
          ))}
        </div>
      </FadeIn>
      {objective && (
        <FadeIn delay={0.1}>
          <div className="mt-4 rounded-xl border border-border/50 bg-card/80 p-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {msg("submit.blackbox.start.objective_label")}
            </p>
            <p className="whitespace-pre-wrap text-sm">{objective}</p>
          </div>
        </FadeIn>
      )}
      {background && (
        <FadeIn delay={0.15}>
          <div className="mt-4 rounded-xl border border-border/50 bg-card/80 p-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {msg("submit.blackbox.start.background_label")}
            </p>
            <p className="whitespace-pre-wrap text-sm">{background}</p>
          </div>
        </FadeIn>
      )}
    </>
  );
}
