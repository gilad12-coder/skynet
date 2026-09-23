"use client";

import type { ReactNode } from "react";
import {
  Brain,
  Coins,
  Cpu,
  Cube,
  Database,
  DiceFive,
  Gauge,
  Gear,
  GitMerge,
  Globe,
  Hourglass,
  Key,
  Lock,
  Package,
  Repeat,
  Robot,
  RocketLaunch,
  Shuffle,
  Sparkle,
  Stack,
  Tag,
  Target,
  Terminal,
  Timer,
  Wallet,
  Wrench,
} from "@/shared/ui/icons";
import { harnessLabel } from "@/shared/lib/blackbox-harness";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import type {
  BlackboxBudget,
  BlackboxProposer,
  BlackboxScorer,
  BlackboxStrategy,
  BlackboxTarget,
  OptimizationStatusResponse,
} from "@/shared/types/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { perLocale } from "@/shared/lib/per-locale";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";
import { formatCreditsUsd } from "@/features/billing";
import { TERMS } from "@/shared/lib/terms";
import {
  ConfigCarousel,
  ModelCard,
  SlideHeroCard,
  SlideMiniCard,
  SlideNote,
  SplitBar,
} from "./ConfigCarousel";

const BLACKBOX_SLIDES = perLocale(() => [
  {
    id: "general",
    label: msg("optimization.config.slide_general"),
    icon: <Tag className="size-5" />,
    tip: tip("config.section.general"),
  },
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

const RECIPE_LABELS: Record<string, string> = perLocale(() => ({
  prompt: msg("optimization.config.recipe.prompt"),
  code: msg("optimization.config.recipe.code"),
  anything: msg("optimization.config.recipe.anything"),
}));

const EFFORT_LABELS: Record<string, string> = perLocale(() => ({
  low: msg("submit.blackbox.proposer.effort.low"),
  medium: msg("submit.blackbox.proposer.effort.medium"),
  high: msg("submit.blackbox.proposer.effort.high"),
  max: msg("submit.blackbox.proposer.effort.max"),
}));

function modelName(cfg: Record<string, unknown> | null): string {
  if (!cfg) return "—";
  const provider = typeof cfg.provider === "string" ? cfg.provider : "";
  const model = typeof cfg.model === "string" ? cfg.model : "";
  if (!model) return "—";
  return provider ? `${provider}/${model}` : model;
}

// Older payloads carry {provider, model} instead of the ModelConfig `name`;
// bridge both shapes into the card's expected `name` field.
function toModelCard(cfg: unknown): Record<string, unknown> | null {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const record = cfg as Record<string, unknown>;
  return {
    ...record,
    name: typeof record.name === "string" && record.name ? record.name : modelName(record),
  };
}

function command(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function yesNo(v: boolean): string {
  return v
    ? msg("auto.features.optimizations.components.configtab.literal.14")
    : msg("auto.features.optimizations.components.configtab.literal.15");
}

type ConfigRow = { label: ReactNode; value: string; icon: ReactNode };

function MiniGrid({ rows }: { rows: ConfigRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))" }}
    >
      {rows.map((row, index) => (
        <SlideMiniCard key={index} label={row.label} value={row.value} icon={row.icon} />
      ))}
    </div>
  );
}

/**
 * Config view for a black-box run: the same carousel shell as the regular
 * path, with the payload grouped into general / optimization / models /
 * target & scorer / data slides. Reads the raw payload the wizard sent; the
 * scorer secret is deliberately never surfaced — only the scorer kind and,
 * for remote scorers, the endpoint URL.
 */
export function BlackboxConfigCard({
  job,
  payload,
}: {
  job: OptimizationStatusResponse;
  payload: Record<string, unknown>;
}) {
  const locale = getActiveIntlLocale();
  const strategy = (payload.strategy ?? {}) as Partial<BlackboxStrategy>;
  const budget = (payload.budget ?? {}) as Partial<BlackboxBudget>;
  const target = (payload.target ?? {}) as Partial<BlackboxTarget>;
  const scorer = (payload.scorer ?? {}) as Partial<BlackboxScorer>;
  const proposer = (payload.proposer ?? null) as Partial<BlackboxProposer> | null;
  const reflectionCard = toModelCard(payload.reflection_model_config);
  const taskCard = toModelCard(payload.task_model_config);
  const scorerModelCard = toModelCard(scorer.model);
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
      : msg("submit.blackbox.strategy.auto");

  const targetValue =
    target.kind === "agent"
      ? [target.harness ? harnessLabel(target.harness) : null, target.model]
          .filter(Boolean)
          .join(" · ") || msg("optimization.blackbox.config.target_agent")
      : msg("optimization.blackbox.config.target_text");

  const install = command(scorer.install_command);
  const scorerValue =
    scorer.kind === "remote"
      ? `${msg("submit.blackbox.scorer.kind.remote")} · ${scorer.url ?? "—"}`
      : msg("submit.blackbox.scorer.kind.python");

  const holdout = split != null && (split.val > 0 || split.test > 0);

  const name = command(payload.name) ?? command(job.name) ?? "—";
  const description = command(payload.description) ?? command(job.description);
  const isPrivate = typeof payload.is_private === "boolean" ? payload.is_private : null;
  const tokenSource =
    payload.token_source === "byok" || payload.token_source === "managed"
      ? payload.token_source
      : null;
  const runtime = command(payload.proposer_runtime);
  const hasCostCap = "max_cost_credits" in payload || "estimated_credits_low" in payload;
  const costCap = typeof payload.max_cost_credits === "number" ? payload.max_cost_credits : null;
  const estimateLow =
    typeof payload.estimated_credits_low === "number" ? payload.estimated_credits_low : null;
  const estimateHigh =
    typeof payload.estimated_credits_high === "number" ? payload.estimated_credits_high : null;

  const generalRows: ConfigRow[] = [];
  if (isPrivate != null) {
    generalRows.push({
      label: <HelpTip text={tip("submit.privacy")}>{msg("submit.basics.privacy.label")}</HelpTip>,
      value: isPrivate ? msg("submit.basics.privacy.private") : msg("submit.basics.privacy.public"),
      icon: isPrivate ? <Lock /> : <Globe />,
    });
  }
  if (tokenSource) {
    generalRows.push({
      label: (
        <HelpTip text={tip("config.billing_source")}>{msg("submit.budget.billing_source")}</HelpTip>
      ),
      value: tokenSource === "byok" ? msg("billing.mode.byok") : msg("billing.mode.managed"),
      icon: tokenSource === "byok" ? <Key /> : <Wallet />,
    });
  }
  if (runtime) {
    generalRows.push({
      label: <HelpTip text={tip("config.runtime")}>{msg("optimization.config.runtime")}</HelpTip>,
      value: runtime === "vercel" ? msg("submit.runtime.vercel") : runtime,
      icon: <RocketLaunch />,
    });
  }
  if (hasCostCap) {
    generalRows.push({
      label: <HelpTip text={tip("submit.budget")}>{msg("submit.budget.label")}</HelpTip>,
      value:
        costCap != null ? formatCreditsUsd(costCap, locale) : msg("submit.budget.uncapped_short"),
      icon: <Coins />,
    });
  }
  if (estimateLow != null && estimateHigh != null) {
    generalRows.push({
      label: (
        <HelpTip text={tip("submit.estimate")}>
          {tokenSource === "byok"
            ? msg("submit.summary.estimate_fee")
            : msg("submit.summary.estimate_cost")}
        </HelpTip>
      ),
      // Isolate "low–high" as one LTR run (U+2066…U+2069) so the dash between
      // the two number groups doesn't flip them under RTL.
      value: formatMsg("submit.summary.estimate_range", {
        low: `⁦${formatCreditsUsd(estimateLow, locale)}`,
        high: `${formatCreditsUsd(estimateHigh, locale)}⁩`,
      }),
      icon: <Gauge />,
    });
  }

  const recipe = typeof payload.recipe === "string" ? payload.recipe : null;
  const seed = payload.seed_candidate;
  const seedValue =
    typeof seed === "string" && seed.trim() !== ""
      ? formatMsg("submit.blackbox.review.start_text", { chars: seed.length })
      : seed && typeof seed === "object" && Object.keys(seed).length > 0
        ? formatMsg("submit.blackbox.review.start_parts", { n: Object.keys(seed).length })
        : msg("submit.blackbox.review.start_none");

  const optimizationRows: ConfigRow[] = [
    {
      label: (
        <HelpTip text={tip("blackbox.config.budget_runs")}>
          {msg("optimization.blackbox.config.budget_runs_label")}
        </HelpTip>
      ),
      value: String(budget.max_scorer_runs ?? "—"),
      icon: <Gauge />,
    },
  ];
  if (budget.max_iterations != null) {
    optimizationRows.push({
      label: (
        <HelpTip text={tip("blackbox.config.budget_iterations")}>
          {msg("optimization.blackbox.config.budget_iterations_label")}
        </HelpTip>
      ),
      value: String(budget.max_iterations),
      icon: <Repeat />,
    });
  }
  if (budget.stop_at_score != null) {
    optimizationRows.push({
      label: (
        <HelpTip text={tip("blackbox.config.budget_stop")}>
          {msg("optimization.blackbox.config.budget_stop_label")}
        </HelpTip>
      ),
      value: String(budget.stop_at_score),
      icon: <Target />,
    });
  }
  if (recipe) {
    optimizationRows.push({
      label: <HelpTip text={tip("config.recipe")}>{msg("optimization.config.recipe")}</HelpTip>,
      value: RECIPE_LABELS[recipe] ?? recipe,
      icon: <Sparkle />,
    });
  }
  optimizationRows.push({
    label: (
      <HelpTip text={tip("submit.blackbox.seed")}>
        {msg("submit.blackbox.start.seed_label")}
      </HelpTip>
    ),
    value: seedValue,
    icon: <Stack />,
  });
  if (proposer?.harness) {
    const effort = proposer.effort ? EFFORT_LABELS[proposer.effort] : null;
    optimizationRows.push({
      label: (
        <HelpTip text={tip("submit.blackbox.proposer")}>
          {msg("submit.blackbox.review.proposer")}
        </HelpTip>
      ),
      value: effort
        ? `${harnessLabel(proposer.harness)} · ${effort}`
        : harnessLabel(proposer.harness),
      icon: <Robot />,
    });
    if (proposer.max_candidates_per_iter != null) {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("submit.blackbox.proposer_candidates")}>
            {msg("submit.blackbox.proposer.max_candidates")}
          </HelpTip>
        ),
        value: String(proposer.max_candidates_per_iter),
        icon: <Sparkle />,
      });
    }
    if (typeof proposer.ralph === "boolean") {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("submit.blackbox.proposer_ralph")}>
            {msg("submit.blackbox.proposer.ralph")}
          </HelpTip>
        ),
        value: yesNo(proposer.ralph),
        icon: <Repeat />,
      });
    }
    if (proposer.max_thinking_tokens != null) {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("config.proposer_thinking")}>
            {msg("optimization.config.proposer_thinking")}
          </HelpTip>
        ),
        value: String(proposer.max_thinking_tokens),
        icon: <Brain />,
      });
    }
    if (proposer.max_no_eval_seconds != null) {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("config.proposer_idle")}>
            {msg("optimization.config.proposer_idle")}
          </HelpTip>
        ),
        value: formatMsg("optimization.config.seconds", { seconds: proposer.max_no_eval_seconds }),
        icon: <Hourglass />,
      });
    }
    const proposerInstall = command(proposer.install_command);
    if (proposerInstall) {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("config.proposer_commands")}>
            {msg("optimization.config.proposer_install")}
          </HelpTip>
        ),
        value: proposerInstall,
        icon: <Terminal />,
      });
    }
    const proposerRun = command(proposer.run_command);
    if (proposerRun) {
      optimizationRows.push({
        label: (
          <HelpTip text={tip("config.proposer_commands")}>
            {msg("optimization.config.proposer_run")}
          </HelpTip>
        ),
        value: proposerRun,
        icon: <Terminal />,
      });
    }
  }

  const targetRows: ConfigRow[] = [];
  if (typeof target.timeout_seconds === "number") {
    targetRows.push({
      label: (
        <HelpTip text={tip("config.target_timeout")}>
          {msg("optimization.config.target_timeout")}
        </HelpTip>
      ),
      value: formatMsg("optimization.config.seconds", { seconds: target.timeout_seconds }),
      icon: <Timer />,
    });
  }
  if (typeof target.concurrency === "number") {
    targetRows.push({
      label: (
        <HelpTip text={tip("config.target_concurrency")}>
          {msg("optimization.config.target_concurrency")}
        </HelpTip>
      ),
      value: String(target.concurrency),
      icon: <Stack />,
    });
  }
  for (const [key, labelKey] of [
    ["setup_command", "optimization.config.target_setup"],
    ["install_command", "optimization.config.target_install"],
    ["run_command", "optimization.config.target_run"],
  ] as const) {
    const value = command(target[key]);
    if (value) {
      targetRows.push({
        label: <HelpTip text={tip("config.target_commands")}>{msg(labelKey)}</HelpTip>,
        value,
        icon: <Terminal />,
      });
    }
  }
  if (timeout) {
    targetRows.push({
      label: (
        <HelpTip text={tip("blackbox.config.scorer_timeout")}>
          {msg("optimization.blackbox.config.scorer_timeout_label")}
        </HelpTip>
      ),
      value: timeout,
      icon: <Wrench />,
    });
  }
  if (install) {
    targetRows.push({
      label: (
        <HelpTip text={tip("blackbox.config.scorer_install")}>
          {msg("optimization.blackbox.config.scorer_install_label")}
        </HelpTip>
      ),
      value: install,
      icon: <Wrench />,
    });
  }
  const pinned = Array.isArray(scorer.dependency_lock?.requirements)
    ? scorer.dependency_lock.requirements.filter((r): r is string => typeof r === "string")
    : [];
  if (pinned.length > 0) {
    targetRows.push({
      label: (
        <HelpTip text={tip("config.scorer_packages")}>
          {msg("optimization.config.scorer_packages")}
        </HelpTip>
      ),
      value: pinned.join(", "),
      icon: <Package />,
    });
  }

  const shuffleVal =
    payload.shuffle != null ? Boolean(payload.shuffle) : job.shuffle != null ? job.shuffle : null;
  const seedVal = (payload.seed ?? job.seed) as number | null | undefined;
  const dataRows: ConfigRow[] = [];
  if (shuffleVal != null) {
    dataRows.push({
      label: (
        <HelpTip text={tip("data.shuffle_explanation")}>
          {msg("auto.features.optimizations.components.configtab.13")}
        </HelpTip>
      ),
      value: shuffleVal
        ? msg("auto.features.optimizations.components.configtab.literal.16")
        : msg("auto.features.optimizations.components.configtab.literal.17"),
      icon: <Shuffle />,
    });
  }
  if (seedVal != null) {
    dataRows.push({
      label: (
        <HelpTip text={tip("data.seed")}>
          {msg("auto.features.optimizations.components.configtab.14")}
        </HelpTip>
      ),
      value: String(seedVal),
      icon: <DiceFive />,
    });
  }

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
                      <HelpTip text={tip("submit.name")}>
                        {msg("auto.features.submit.components.steps.summarystep.3")}
                        {TERMS.optimization}
                      </HelpTip>
                    }
                    value={name}
                    icon={<Tag />}
                  />
                  <SlideHeroCard
                    index={1}
                    label={
                      <HelpTip text={tip("submit.optimization_type")}>
                        {msg("auto.features.submit.components.steps.summarystep.4")}
                        {TERMS.optimization}
                      </HelpTip>
                    }
                    value={msg("submit.recipe.anything.title")}
                    icon={<Stack />}
                  />
                </div>
                <MiniGrid rows={generalRows} />
                {description && (
                  <SlideNote
                    label={
                      <HelpTip text={tip("config.description")}>
                        {msg("optimization.config.description")}
                      </HelpTip>
                    }
                    text={description}
                  />
                )}
              </div>
            )}

            {activeSlide === 1 && (
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
                <MiniGrid rows={optimizationRows} />
                {objective && (
                  <SlideNote
                    label={
                      <HelpTip text={tip("submit.blackbox.objective")}>
                        {msg("submit.blackbox.start.objective_label")}
                      </HelpTip>
                    }
                    text={objective}
                  />
                )}
                {background && (
                  <SlideNote
                    label={
                      <HelpTip text={tip("submit.blackbox.background")}>
                        {msg("submit.blackbox.start.background_label")}
                      </HelpTip>
                    }
                    text={background}
                  />
                )}
              </div>
            )}

            {activeSlide === 2 && (
              <div className="min-h-[24rem]">
                {reflectionCard || taskCard || scorerModelCard || target.model ? (
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
                    {scorerModelCard && (
                      <ModelCard
                        label={msg("submit.blackbox.roles.scoring.label")}
                        labelTip={tip("submit.blackbox.scorer_model")}
                        cfg={scorerModelCard}
                      />
                    )}
                    {taskCard && (
                      <ModelCard
                        label={msg("submit.blackbox.roles.task.label")}
                        labelTip={tip("config.task_model")}
                        cfg={taskCard}
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
                ) : (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    {msg("submit.blackbox.roles.scoring.deterministic_desc")}
                  </p>
                )}
              </div>
            )}

            {activeSlide === 3 && (
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
                <MiniGrid rows={targetRows} />
              </div>
            )}

            {activeSlide === 4 && (
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
                    <MiniGrid
                      rows={[
                        {
                          label: (
                            <HelpTip text={tip("blackbox.config.split_all")}>
                              {msg("optimization.blackbox.config.split")}
                            </HelpTip>
                          ),
                          value: msg("optimization.blackbox.config.split_all"),
                          icon: <Shuffle />,
                        },
                      ]}
                    />
                  ))}
                <MiniGrid rows={dataRows} />
              </div>
            )}
          </>
        )}
      />
    </>
  );
}
