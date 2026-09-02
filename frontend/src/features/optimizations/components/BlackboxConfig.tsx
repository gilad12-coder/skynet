"use client";

import {
  Cpu,
  Cube,
  Database,
  Gauge,
  Gear,
  GitMerge,
  Repeat,
  Shuffle,
  Target,
  Wrench,
} from "@/shared/ui/icons";
import { harnessLabel } from "@/shared/lib/blackbox-harness";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import type {
  BlackboxBudget,
  BlackboxScorer,
  BlackboxStrategy,
  BlackboxTarget,
  OptimizationStatusResponse,
} from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { perLocale } from "@/shared/lib/per-locale";
import { TERMS } from "@/shared/lib/terms";
import {
  ConfigCarousel,
  ModelCard,
  SlideHeroCard,
  SlideMiniCard,
  SplitBar,
} from "./ConfigCarousel";

const BLACKBOX_SLIDES = perLocale(() => [
  {
    id: "optimization",
    label: `${msg("auto.features.optimizations.components.configtab.5")}${TERMS.optimization}`,
    icon: <Gear className="size-5" />,
    tip: tip("blackbox.config.section.optimization"),
  },
  {
    id: "models",
    label: msg("auto.features.optimizations.components.configtab.6"),
    icon: <Cpu className="size-5" />,
    tip: tip("blackbox.config.section.models"),
  },
  {
    id: "target",
    label: msg("optimization.blackbox.config.slide_target"),
    icon: <Target className="size-5" />,
    tip: tip("blackbox.config.section.target"),
  },
  {
    id: "data",
    label: msg("auto.features.optimizations.components.configtab.8"),
    icon: <Database className="size-5" />,
    tip: tip("blackbox.config.section.data"),
  },
]);

function modelName(cfg: Record<string, unknown> | null): string {
  if (!cfg) return "—";
  const provider = typeof cfg.provider === "string" ? cfg.provider : "";
  const model = typeof cfg.model === "string" ? cfg.model : "";
  if (!model) return "—";
  return provider ? `${provider}/${model}` : model;
}

/** Free-text block for the objective / background the wizard captured. */
function NoteBox({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-border/45 bg-background/65 p-4">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}

/**
 * Config view for a black-box run: the same carousel shell as the regular
 * path, with the payload grouped into optimization / target & scorer / data
 * slides. Reads the raw payload the wizard sent; the scorer secret is
 * deliberately never surfaced — only the scorer kind and, for remote
 * scorers, the endpoint URL.
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
  // Older payloads carry {provider, model} instead of the ModelConfig `name`;
  // bridge both shapes into the card's expected `name` field.
  const reflectionCard = reflection
    ? {
        ...reflection,
        name:
          typeof reflection.name === "string" && reflection.name
            ? reflection.name
            : modelName(reflection),
      }
    : null;
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

  const strategyValue =
    strategy.mode === "single"
      ? msg("submit.blackbox.strategy.single")
      : strategy.mode === "plateau"
        ? msg("submit.blackbox.strategy.plateau")
        : msg("submit.blackbox.strategy.auto");

  const targetValue =
    target.kind === "agent"
      ? [target.harness ? harnessLabel(target.harness) : null, target.model]
          .filter(Boolean)
          .join(" · ") || msg("optimization.blackbox.config.target_agent")
      : msg("optimization.blackbox.config.target_text");

  const install =
    typeof scorer.install_command === "string" && scorer.install_command.trim() !== ""
      ? scorer.install_command
      : null;
  const scorerValue =
    scorer.kind === "remote"
      ? `${msg("submit.blackbox.scorer.kind.remote")} · ${scorer.url ?? "—"}`
      : msg("submit.blackbox.scorer.kind.python");

  const holdout = split != null && (split.val > 0 || split.test > 0);

  return (
    <>
      <FadeIn>
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          {msg("optimization.blackbox.config.intro")}
        </p>
      </FadeIn>
      <ConfigCarousel
        slides={BLACKBOX_SLIDES}
        renderSlide={(activeSlide) => (
          <>
            {activeSlide === 0 && (
              <div className="flex min-h-[24rem] flex-col gap-5">
                <div className="grid items-stretch gap-3 md:grid-cols-2">
                  <SlideHeroCard
                    index={0}
                    label={
                      <HelpTip text={tip("blackbox.config.strategy")}>
                        {msg("optimization.blackbox.config.strategy")}
                      </HelpTip>
                    }
                    value={strategyValue}
                    icon={<GitMerge />}
                  />
                  <SlideHeroCard
                    index={1}
                    label={
                      <HelpTip text={tip("blackbox.config.engine")}>
                        {msg("optimization.blackbox.config.engine")}
                      </HelpTip>
                    }
                    value={engine ?? "—"}
                    icon={<Cube />}
                  />
                </div>
                <div
                  className="grid gap-3"
                  style={{
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
                  }}
                >
                  <SlideMiniCard
                    label={
                      <HelpTip text={tip("blackbox.config.budget_runs")}>
                        {msg("optimization.blackbox.config.budget_runs_label")}
                      </HelpTip>
                    }
                    value={String(budget.max_scorer_runs ?? "—")}
                    icon={<Gauge />}
                  />
                  {budget.max_iterations != null && (
                    <SlideMiniCard
                      label={
                        <HelpTip text={tip("blackbox.config.budget_iterations")}>
                          {msg("optimization.blackbox.config.budget_iterations_label")}
                        </HelpTip>
                      }
                      value={String(budget.max_iterations)}
                      icon={<Repeat />}
                    />
                  )}
                  {budget.stop_at_score != null && (
                    <SlideMiniCard
                      label={
                        <HelpTip text={tip("blackbox.config.budget_stop")}>
                          {msg("optimization.blackbox.config.budget_stop_label")}
                        </HelpTip>
                      }
                      value={String(budget.stop_at_score)}
                      icon={<Target />}
                    />
                  )}
                </div>
                {objective && (
                  <NoteBox label={msg("submit.blackbox.start.objective_label")} text={objective} />
                )}
                {background && (
                  <NoteBox
                    label={msg("submit.blackbox.start.background_label")}
                    text={background}
                  />
                )}
              </div>
            )}

            {activeSlide === 1 && (
              <div className="min-h-[24rem]">
                <div
                  className="grid gap-4"
                  style={{
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(17rem, 100%), 1fr))",
                  }}
                >
                  {reflectionCard && (
                    <ModelCard
                      label={msg("optimization.blackbox.config.reflection_model")}
                      labelTip={tip("blackbox.config.reflection_model")}
                      cfg={reflectionCard}
                    />
                  )}
                  {target.kind === "agent" && target.model && (
                    <ModelCard
                      label={msg("submit.blackbox.start.agent_model_label")}
                      labelTip={tip("blackbox.config.agent_model")}
                      cfg={{ name: target.model }}
                      params={false}
                    />
                  )}
                </div>
              </div>
            )}

            {activeSlide === 2 && (
              <div className="flex min-h-[24rem] flex-col gap-5">
                <div className="grid items-stretch gap-3 md:grid-cols-2">
                  <SlideHeroCard
                    index={0}
                    label={
                      <HelpTip text={tip("blackbox.config.target")}>
                        {msg("optimization.blackbox.config.target")}
                      </HelpTip>
                    }
                    value={targetValue}
                    icon={<Target />}
                  />
                  <SlideHeroCard
                    index={1}
                    label={
                      <HelpTip text={tip("blackbox.config.scorer")}>
                        {msg("optimization.blackbox.config.scorer")}
                      </HelpTip>
                    }
                    value={scorerValue}
                    icon={<Wrench />}
                  />
                </div>
                {(timeout || install) && (
                  <div
                    className="grid gap-3"
                    style={{
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
                    }}
                  >
                    {timeout && (
                      <SlideMiniCard
                        label={
                          <HelpTip text={tip("blackbox.config.scorer_timeout")}>
                            {msg("optimization.blackbox.config.scorer_timeout_label")}
                          </HelpTip>
                        }
                        value={timeout}
                        icon={<Wrench />}
                      />
                    )}
                    {install && (
                      <SlideMiniCard
                        label={
                          <HelpTip text={tip("blackbox.config.scorer_install")}>
                            {msg("optimization.blackbox.config.scorer_install_label")}
                          </HelpTip>
                        }
                        value={install}
                        icon={<Wrench />}
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {activeSlide === 3 && (
              <div className="flex min-h-[24rem] flex-col gap-5">
                <div className="grid items-stretch gap-3 md:grid-cols-2">
                  <SlideHeroCard
                    index={0}
                    label={
                      <HelpTip text={tip("blackbox.config.cases")}>
                        {msg("optimization.blackbox.config.cases")}
                      </HelpTip>
                    }
                    value={
                      cases != null && cases > 0
                        ? formatMsg("optimization.blackbox.config.cases_count", { n: cases })
                        : msg("submit.blackbox.review.cases_none")
                    }
                    icon={<Database />}
                  />
                  {splitCounts && (splitCounts.train ?? 0) > 0 && (
                    <SlideHeroCard
                      index={1}
                      label={
                        <HelpTip text={tip("blackbox.config.split_counts")}>
                          {msg("optimization.blackbox.config.split_counts")}
                        </HelpTip>
                      }
                      value={formatMsg("optimization.blackbox.config.split_counts_value", {
                        train: splitCounts.train ?? 0,
                        val: splitCounts.val ?? 0,
                        test: splitCounts.test ?? 0,
                      })}
                      icon={<Shuffle />}
                    />
                  )}
                </div>
                {split &&
                  (holdout ? (
                    <div className="flex flex-1 flex-col gap-3">
                      <div className="flex items-center gap-2.5">
                        <span className="grid size-9 place-items-center rounded-xl bg-[#EDE7DD] text-[#8C7A6B]">
                          <Shuffle className="size-4" aria-hidden="true" />
                        </span>
                        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[#8C7A6B]">
                          <HelpTip text={tip("blackbox.config.split")}>
                            {msg("optimization.blackbox.config.split")}
                          </HelpTip>
                        </p>
                      </div>
                      <SplitBar fractions={split} />
                    </div>
                  ) : (
                    <div
                      className="grid gap-3"
                      style={{
                        gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
                      }}
                    >
                      <SlideMiniCard
                        label={
                          <HelpTip text={tip("blackbox.config.split_all")}>
                            {msg("optimization.blackbox.config.split")}
                          </HelpTip>
                        }
                        value={msg("optimization.blackbox.config.split_all")}
                        icon={<Shuffle />}
                      />
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      />
    </>
  );
}
