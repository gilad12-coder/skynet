"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Books,
  Brain,
  Cpu,
  Cube,
  Database,
  DiceFive,
  Gauge,
  Gear,
  GearSix,
  GitMerge,
  Repeat,
  Ruler,
  Shuffle,
  Sparkle,
  Stack,
  Tag,
  Target,
  Wrench,
} from "@/shared/ui/icons";
import { FadeIn } from "@/shared/ui/motion";
import { useUserPrefs } from "@/features/settings";
import { HelpTip } from "@/shared/ui/help-tip";
import type {
  ModelConfig,
  OptimizationPayloadResponse,
  OptimizationStatusResponse,
  PairResult,
} from "@/shared/types/api";
import { tip } from "@/shared/lib/tooltips";
import { formatMsg, msg } from "@/shared/lib/messages";
import { perLocale } from "@/shared/lib/per-locale";
import { moduleLabel } from "@/shared/lib/formatters";
import { TERMS } from "@/shared/lib/terms";
import { cn } from "@/shared/lib/utils";
import { InfoCard } from "./ui-primitives";
import { BlackboxConfigCard } from "./BlackboxConfig";
import {
  ConfigCarousel,
  ModelCard,
  SlideHeroCard,
  SlideMiniCard,
  SplitBar,
} from "./ConfigCarousel";

const CONFIG_SLIDES = perLocale(() => [
  {
    id: "optimization",
    label: `${msg("auto.features.optimizations.components.configtab.5")}${TERMS.optimization}`,
    icon: <Gear className="size-5" />,
    tip: tip("config.section.summary"),
  },
  {
    id: "models",
    label: msg("auto.features.optimizations.components.configtab.6"),
    icon: <Cpu className="size-5" />,
    tip: tip("config.section.models"),
  },
  {
    id: "data",
    label: msg("auto.features.optimizations.components.configtab.8"),
    icon: <Database className="size-5" />,
    tip: tip("config.section.data"),
  },
]);

const OPT_PARAM_LABELS: Record<string, string> = perLocale(() => ({
  auto: msg("auto.features.optimizations.components.configtab.literal.1"),
  max_bootstrapped_demos: msg("auto.features.optimizations.components.configtab.literal.2"),
  max_labeled_demos: msg("auto.features.optimizations.components.configtab.literal.3"),
  minibatch: msg("auto.features.optimizations.components.configtab.literal.4"),
  minibatch_size: msg("auto.features.optimizations.components.configtab.literal.5"),
  reflection_minibatch_size: msg("auto.features.optimizations.components.configtab.literal.6"),
  max_full_evals: msg("auto.features.optimizations.components.configtab.literal.7"),
  max_metric_calls: msg("submit.metric_calls"),
  use_merge: msg("auto.features.optimizations.components.configtab.literal.8"),
  metric: TERMS.metric,
}));
const OPT_PARAM_TIPS: Record<string, string> = perLocale(() => ({
  auto: msg("auto.features.optimizations.components.configtab.literal.9"),
  max_bootstrapped_demos: msg("auto.features.optimizations.components.configtab.literal.10"),
  max_labeled_demos: formatMsg("auto.features.optimizations.components.configtab.template.1", {
    p1: TERMS.dataset,
    p2: TERMS.model,
  }),
  minibatch: formatMsg("auto.features.optimizations.components.configtab.template.2", {
    p1: TERMS.dataset,
  }),
  minibatch_size: msg("auto.features.optimizations.components.configtab.literal.11"),
  reflection_minibatch_size: formatMsg(
    "auto.features.optimizations.components.configtab.template.3",
    { p1: TERMS.model },
  ),
  max_full_evals: msg("auto.features.optimizations.components.configtab.literal.12"),
  max_metric_calls: msg("tooltip.submit.metric_calls"),
  use_merge: msg("auto.features.optimizations.components.configtab.literal.13"),
}));

function labelWithTip(key: string): ReactNode {
  const label = OPT_PARAM_LABELS[key] || key;
  const tipText = OPT_PARAM_TIPS[key];
  return tipText ? <HelpTip text={tipText}>{label}</HelpTip> : label;
}

const PARAM_ICONS: Record<string, ReactNode> = {
  auto: <Gauge className="size-3.5" />,
  max_bootstrapped_demos: <Sparkle className="size-3.5" />,
  max_labeled_demos: <Tag className="size-3.5" />,
  minibatch: <Stack className="size-3.5" />,
  minibatch_size: <Ruler className="size-3.5" />,
  reflection_minibatch_size: <Brain className="size-3.5" />,
  max_full_evals: <Repeat className="size-3.5" />,
  // Shares Gauge with `auto`: both are the run's (mutually exclusive) budget knob.
  max_metric_calls: <Gauge className="size-3.5" />,
  use_merge: <GitMerge className="size-3.5" />,
};

function paramIcon(key: string): ReactNode {
  return PARAM_ICONS[key] ?? <GearSix className="size-3.5" />;
}

// The GEPA budget level arrives as the raw "light" / "medium" / "heavy"
// string; translate it to the same Hebrew the submit summary shows so the
// value reads consistently across surfaces.
const AUTO_LEVEL_LABELS: Record<string, string> = perLocale(() => ({
  light: msg("auto.features.optimizations.components.configtab.literal.18"),
  medium: msg("auto.features.optimizations.components.configtab.literal.19"),
  heavy: msg("auto.features.optimizations.components.configtab.literal.20"),
}));

function formatParamValue(k: string, v: unknown): string {
  if (typeof v === "boolean")
    return v
      ? msg("auto.features.optimizations.components.configtab.literal.14")
      : msg("auto.features.optimizations.components.configtab.literal.15");
  if (k === "auto" && typeof v === "string" && AUTO_LEVEL_LABELS[v]) return AUTO_LEVEL_LABELS[v];
  return String(v);
}

// The pair only carries the model name + reasoning effort; the richer
// ModelConfig (temperature, max_tokens, extra) lives on job.generation_models
// / job.reflection_models. Match by name first, narrowing on reasoning
// effort when multiple configs share the name. Fall back to a synthesized
// config so the ModelCard still renders when the grid lists are missing
// (older payloads, partial responses).
function pickPairModelConfig(
  configs: ModelConfig[] | undefined,
  name: string,
  reasoningEffort: string | null | undefined,
): Record<string, unknown> {
  const candidates = (configs ?? []).filter((c) => c.name === name);
  const matched =
    candidates.find(
      (c) =>
        ((c.extra?.reasoning_effort as string | undefined) ?? null) === (reasoningEffort ?? null),
    ) ?? candidates[0];
  if (matched) return matched as unknown as Record<string, unknown>;
  return reasoningEffort ? { name, extra: { reasoning_effort: reasoningEffort } } : { name };
}

export function ConfigTab({
  job,
  payload,
  activePair,
}: {
  job: OptimizationStatusResponse;
  payload: OptimizationPayloadResponse | null;
  activePair?: PairResult;
}) {
  const { prefs } = useUserPrefs();
  const advanced = prefs.advancedMode;

  if (job.optimization_type === "blackbox") {
    return (
      <BlackboxConfigCard job={job} payload={(payload?.payload ?? {}) as Record<string, unknown>} />
    );
  }

  // Merge job-level data with full payload for richer config display
  const p = (payload?.payload ?? {}) as Record<string, unknown>;
  const splitFractions = (p.split_fractions ??
    job.split_fractions ?? { train: 0.7, val: 0.15, test: 0.15 }) as {
    train: number;
    val: number;
    test: number;
  };
  const shuffleVal =
    p.shuffle != null ? Boolean(p.shuffle) : job.shuffle != null ? job.shuffle : true;
  const seedVal = (p.seed ?? job.seed) as number | undefined;
  const optKw = (p.optimizer_kwargs ?? job.optimizer_kwargs ?? {}) as Record<string, unknown>;
  const compKw = (p.compile_kwargs ?? job.compile_kwargs ?? {}) as Record<string, unknown>;
  const modelCfg = (p.model_config ?? job.model_settings ?? null) as Record<string, unknown> | null;
  const reflCfg = (p.reflection_model_config ?? null) as Record<string, unknown> | null;
  const taskCfg = (p.task_model_config ?? null) as Record<string, unknown> | null;

  // React runs carry a tool-source config the generic rows don't cover.
  // Scoring lives in metric_code (shown in the code view), so there is no
  // reward preset to surface here.
  const toolSource = (p.tool_source ?? null) as Record<string, unknown> | null;
  const reactRows: Array<{ label: ReactNode; value: string; icon: ReactNode }> =
    (job.module_name ?? "").toLowerCase() === "react" && toolSource?.kind
      ? [
          {
            label: (
              <HelpTip text={tip("react.tool_source")}>
                {msg("submit.react.tool_source_label")}
              </HelpTip>
            ),
            value: String(toolSource.mcp_url || toolSource.kind),
            icon: <Wrench className="size-3.5" />,
          },
        ]
      : [];

  const items: Array<{ label: ReactNode; value: string; icon: ReactNode }> = [
    {
      label: (
        <HelpTip text={tip("module.choice")}>
          {msg("auto.features.optimizations.components.configtab.1")}
        </HelpTip>
      ),
      value: moduleLabel(job.module_name),
      icon: <Cube className="size-3.5" />,
    },
    {
      label: <HelpTip text={tip("optimizer.choice")}>{TERMS.optimizer}</HelpTip>,
      value: job.optimizer_name ?? "—",
      icon: <Target className="size-3.5" />,
    },
    ...reactRows,
    ...Object.entries(optKw)
      .filter(([k]) => k !== "metric" && (advanced || k === "auto"))
      .map(([k, v]) => ({
        label: labelWithTip(k),
        value: formatParamValue(k, v),
        icon: paramIcon(k),
      })),
    ...Object.entries(compKw).map(([k, v]) => ({
      label: labelWithTip(k),
      value: formatParamValue(k, v),
      icon: <Stack className="size-3.5" />,
    })),
  ];

  return (
    <>
      <FadeIn>
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          {msg("auto.features.optimizations.components.configtab.2")}
          {TERMS.optimization}
          {msg("auto.features.optimizations.components.configtab.3")}
          {TERMS.model}, {TERMS.optimizer}
          {msg("auto.features.optimizations.components.configtab.4")}
        </p>
      </FadeIn>
      <ConfigCarousel
        slides={CONFIG_SLIDES}
        renderSlide={(activeSlide) => (
          <>
            {activeSlide === 0 && (
              <div className="flex min-h-[24rem] flex-col gap-5">
                <div className="grid items-stretch gap-3 md:grid-cols-2">
                  {items.slice(0, 2).map((item, index) => (
                    <SlideHeroCard
                      key={index}
                      index={index}
                      label={item.label}
                      value={item.value}
                      icon={item.icon}
                    />
                  ))}
                </div>

                {items.length > 2 && (
                  <div
                    className="grid flex-1 gap-3"
                    style={{
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
                    }}
                  >
                    {items.slice(2).map((item, index) => (
                      <SlideMiniCard
                        key={index}
                        label={item.label}
                        value={item.value}
                        icon={item.icon}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeSlide === 1 && (
              <div className="min-h-[24rem]">
                {job.optimization_type !== "grid_search" ? (
                  <div
                    className="grid gap-4"
                    style={{
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(17rem, 100%), 1fr))",
                    }}
                  >
                    {modelCfg && <ModelCard label={msg("model.generation.label")} cfg={modelCfg} />}
                    {reflCfg && <ModelCard label={TERMS.reflectionModel} cfg={reflCfg} />}
                    {taskCfg && <ModelCard label={msg("model.generation.label")} cfg={taskCfg} />}
                    {!modelCfg && !reflCfg && !taskCfg && job.model_name && (
                      <>
                        <ModelCard
                          label={msg("model.generation.label")}
                          cfg={{ name: job.model_name, ...(job.model_settings || {}) }}
                        />
                        {job.reflection_model_name && (
                          <ModelCard
                            label={TERMS.reflectionModel}
                            cfg={{ name: job.reflection_model_name }}
                          />
                        )}
                      </>
                    )}
                  </div>
                ) : activePair ? (
                  <div
                    className="grid gap-4"
                    style={{
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(17rem, 100%), 1fr))",
                    }}
                  >
                    <ModelCard
                      label={msg("model.generation.label")}
                      cfg={pickPairModelConfig(
                        job.generation_models,
                        activePair.generation_model,
                        activePair.generation_reasoning_effort,
                      )}
                    />
                    <ModelCard
                      label={TERMS.reflectionModel}
                      cfg={pickPairModelConfig(
                        job.reflection_models,
                        activePair.reflection_model,
                        activePair.reflection_reasoning_effort,
                      )}
                    />
                  </div>
                ) : job.generation_models && job.reflection_models ? (
                  <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                    <div className="space-y-3">
                      <p className="flex items-center gap-2 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[#8C7A6B]">
                        <span className="grid size-7 place-items-center rounded-lg bg-[#3D2E22] text-[#FAF8F5]">
                          <Cpu className="size-3.5" aria-hidden="true" />
                        </span>
                        <HelpTip text={tip("grid.generation_models")}>
                          {msg("model.generation.label_plural")}
                        </HelpTip>
                      </p>
                      {job.generation_models.map((m, i) => (
                        <ModelCard
                          key={i}
                          label={`${msg("model.generation.label_short")} ${i + 1}`}
                          cfg={m as unknown as Record<string, unknown>}
                        />
                      ))}
                    </div>
                    <div className="space-y-3">
                      <p className="flex items-center gap-2 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[#8C7A6B]">
                        <span className="grid size-7 place-items-center rounded-lg bg-[#C8A882] text-[#3D2E22]">
                          <Brain className="size-3.5" aria-hidden="true" />
                        </span>
                        <HelpTip text={tip("grid.reflection_models")}>
                          {msg("auto.features.optimizations.components.configtab.7")}
                        </HelpTip>
                      </p>
                      {job.reflection_models.map((m, i) => (
                        <ModelCard
                          key={i}
                          label={formatMsg(
                            "auto.features.optimizations.components.configtab.template.4",
                            { p1: i + 1 },
                          )}
                          cfg={m as unknown as Record<string, unknown>}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="py-12 text-center text-sm text-muted-foreground">—</p>
                )}
              </div>
            )}

            {activeSlide === 2 && (
              <div className="flex min-h-[24rem] flex-col gap-6">
                {job.source_dataset_id && (
                  <Link
                    href={`/datasets?open=${job.source_dataset_id}`}
                    className={cn(
                      "group/srclink flex min-h-28 items-center gap-4 rounded-2xl border border-border/60 bg-[#F8F4EE] p-5 transition-[background-color,border-color,transform] hover:border-[#C8A882]/70 hover:bg-[#F4EEE6] active:scale-[0.995] sm:p-6",
                      !advanced && "flex-1",
                    )}
                  >
                    <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-[#3D2E22] text-[#FAF8F5] shadow-sm">
                      <Books className="size-6" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[#8C7A6B]">
                        {msg("optimizations.source_dataset.label")}
                      </span>
                      <span
                        className="mt-1 block truncate font-mono text-base font-semibold text-foreground sm:text-lg"
                        dir="ltr"
                      >
                        {job.source_dataset_id}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs font-semibold text-[#7C6350] sm:block">
                      {msg("optimizations.source_dataset.view")}
                    </span>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover/srclink:text-foreground" />
                  </Link>
                )}
                {advanced && (
                  <div className="flex flex-1 flex-col gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-9 place-items-center rounded-xl bg-[#EDE7DD] text-[#8C7A6B]">
                        <Database className="size-4" aria-hidden="true" />
                      </span>
                      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[#8C7A6B]">
                        <HelpTip text={tip("data.split_explanation")}>
                          {msg("auto.features.optimizations.components.configtab.9")}
                          {TERMS.dataset}
                        </HelpTip>
                      </p>
                    </div>
                    <SplitBar fractions={splitFractions} />
                  </div>
                )}
                {advanced && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <InfoCard
                      label={
                        <HelpTip text={tip("data.shuffle_explanation")}>
                          {msg("auto.features.optimizations.components.configtab.13")}
                        </HelpTip>
                      }
                      value={
                        shuffleVal
                          ? msg("auto.features.optimizations.components.configtab.literal.16")
                          : msg("auto.features.optimizations.components.configtab.literal.17")
                      }
                      icon={<Shuffle className="size-3.5" />}
                    />
                    {seedVal != null && (
                      <InfoCard
                        label={
                          <HelpTip text={tip("data.seed")}>
                            {msg("auto.features.optimizations.components.configtab.14")}
                          </HelpTip>
                        }
                        value={seedVal}
                        icon={<DiceFive className="size-3.5" />}
                      />
                    )}
                  </div>
                )}
                {!job.source_dataset_id && !advanced && (
                  <p className="py-12 text-center text-sm text-muted-foreground">—</p>
                )}
              </div>
            )}
          </>
        )}
      />
    </>
  );
}
