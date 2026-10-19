"use client";

import * as React from "react";
import { msg } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import {
  blendBuild,
  buildWeight,
  expectedText,
  scoreBuild,
  type RewardBuild,
} from "@/shared/lib/reward-rules";
import { cn } from "@/shared/lib/utils";
import { Info, Play, Target } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { plain, reasonText, signed } from "./reward-text";

export interface RewardSample {
  input: Record<string, unknown>;
  expected: Record<string, unknown> | null;
}

/** "Try it" scores every reward together, or one reward on its own. */
const ALL = "__all__";

/** A number field's value, or `null` when it is empty or not a number. */
function numberOrNull(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** A score in a small pill, as the result rows show it. */
function ScorePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-10 justify-center rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-foreground">
      <bdi dir="ltr">{children}</bdi>
    </span>
  );
}

/**
 * "Try it" for a built reward (SKY-84), laid out like Unsloth Studio's: pick
 * all rewards or one, enter a sample reply and the expected value, then Run.
 * All rewards list each one's score times its weight, highest first, then the
 * accuracy, speed, cost and total reward; one reward shows its own score. An
 * edit clears the last result, so a result never describes other inputs.
 *
 * Args:
 *   build: The rewards to score with.
 *   expectedField: The run's expected column.
 *   samples: Cases to fill the expected value from.
 */
export function RewardTryIt({
  build,
  expectedField,
  samples = [],
  className,
}: {
  build: RewardBuild;
  expectedField: string;
  samples?: readonly RewardSample[];
  className?: string;
}) {
  const id = React.useId();
  const first = samples[0]?.expected?.[expectedField];
  const [target, setTarget] = React.useState(ALL);
  const [reply, setReply] = React.useState("");
  const [expected, setExpected] = React.useState(
    first === undefined || first === null ? "" : expectedText(first),
  );
  const [timeMs, setTimeMs] = React.useState("");
  const [costUsd, setCostUsd] = React.useState("");
  const [ran, setRan] = React.useState(false);
  const f = rewardFormatters();

  // A changed build or input makes the shown result stale.
  const buildKey = JSON.stringify(build);
  React.useEffect(() => setRan(false), [buildKey]);
  const names = build.rewards.map((r) => r.name);
  const chosen = target === ALL || names.includes(target) ? target : ALL;
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setRan(false);
    };

  const result = scoreBuild(build, reply, { [expectedField]: expected });
  const time = numberOrNull(timeMs);
  const cost = numberOrNull(costUsd);
  const blended = blendBuild(build, result.accuracy, time, cost);
  const total = buildWeight(build);
  const usesSpeed = build.speed.weight > 0;
  const usesCost = build.cost.weight > 0;
  const ranked = [...result.rules].sort(
    (a, b) => b.result.score * b.entry.weight - a.result.score * a.entry.weight,
  );
  const one = result.rules.find((r) => r.entry.name === chosen);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn("rounded-xl border border-border/60 bg-background/60", className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <Target className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h4 id={`${id}-title`} className="me-auto text-sm font-semibold">
          {msg("reward_builder.try.title")}
        </h4>
        <Select value={chosen} onValueChange={edit(setTarget)}>
          <SelectTrigger
            size="sm"
            aria-label={msg("reward_builder.try.which")}
            className="w-auto min-w-40 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{msg("reward_builder.try.all")}</SelectItem>
            {names.map((name) => (
              <SelectItem key={name} value={name}>
                <bdi dir="ltr" className="font-mono text-xs">
                  {name}
                </bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TooltipButton tooltip={msg("reward_builder.try.run")}>
          <Button
            type="button"
            size="icon-sm"
            className="rounded-full"
            aria-label={msg("reward_builder.try.run")}
            disabled={names.length === 0}
            onClick={() => setRan(true)}
          >
            <Play />
          </Button>
        </TooltipButton>
      </header>

      <div className="space-y-3 p-4 text-sm">
        {samples.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {msg("reward_builder.try.samples")}
            </span>
            {samples.map((sample, index) => {
              const value = sample.expected?.[expectedField];
              return (
                <button
                  key={index}
                  type="button"
                  className="rounded-full border border-border/70 px-2 py-0.5 text-xs hover:bg-accent"
                  onClick={() =>
                    edit(setExpected)(
                      value === undefined || value === null ? "" : expectedText(value),
                    )
                  }
                >
                  {msg("reward_builder.try.sample", { n: String(index + 1) })}
                </button>
              );
            })}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="space-y-1">
            <Label htmlFor={`${id}-reply`} className="text-xs">
              {msg("reward_builder.try.reply")}
            </Label>
            <Textarea
              id={`${id}-reply`}
              dir="auto"
              rows={6}
              value={reply}
              onChange={(e) => edit(setReply)(e.target.value)}
              placeholder={msg("reward_builder.try.reply_hint")}
              className="min-h-32 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-expected`} className="text-xs">
              {msg("reward_builder.try.expected", { field: expectedField })}
            </Label>
            <Textarea
              id={`${id}-expected`}
              dir="auto"
              value={expected}
              onChange={(e) => edit(setExpected)(e.target.value)}
              className="min-h-20 font-mono text-xs"
            />
            <p className="text-[0.6875rem] text-muted-foreground">
              {msg("reward_builder.try.expected_hint")}
            </p>
          </div>
        </div>
        {(usesSpeed || usesCost) && (
          <div className="grid grid-cols-2 gap-3 md:max-w-sm">
            {usesSpeed && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-ms`} className="text-xs">
                  {msg("reward_builder.try.time")}
                </Label>
                <Input
                  id={`${id}-ms`}
                  inputMode="decimal"
                  dir="ltr"
                  value={timeMs}
                  onChange={(e) => edit(setTimeMs)(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}
            {usesCost && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-usd`} className="text-xs">
                  {msg("reward_builder.try.cost")}
                </Label>
                <Input
                  id={`${id}-usd`}
                  inputMode="decimal"
                  dir="ltr"
                  value={costUsd}
                  onChange={(e) => edit(setCostUsd)(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}
          </div>
        )}

        <div aria-live="polite">
          {ran && chosen === ALL && (
            <div className="rounded-lg border border-border/60 bg-muted/30">
              <ul className="divide-y divide-border/40">
                {ranked.map(({ entry, result: r }) => (
                  <li
                    key={entry.name}
                    data-reward={entry.name}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <bdi dir="ltr" className="min-w-0 truncate font-mono text-xs">
                      {entry.name}
                    </bdi>
                    <TooltipButton tooltip={reasonText(r.reason)}>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={reasonText(r.reason)}
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipButton>
                    <span className="ms-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      <bdi dir="ltr">
                        {signed(r.score)} × {plain(entry.weight)} =
                      </bdi>
                    </span>
                    <ScorePill>{signed(r.score * entry.weight)}</ScorePill>
                  </li>
                ))}
              </ul>
              <dl className="space-y-1 border-t border-border/60 px-3 py-2 text-xs">
                <div className="flex justify-between gap-2">
                  <dt>{rewardPartLabel("accuracy")}</dt>
                  <dd className="font-mono tabular-nums">
                    <bdi dir="ltr">{f.score(blended.parts.accuracy)}</bdi>
                  </dd>
                </div>
                {usesSpeed && (
                  <div className="flex justify-between gap-2">
                    <dt>{rewardPartLabel("speed")}</dt>
                    <dd className="font-mono tabular-nums">
                      <bdi dir="ltr">{time == null ? "—" : f.score(blended.parts.speed)}</bdi>
                    </dd>
                  </div>
                )}
                {usesCost && (
                  <div className="flex justify-between gap-2">
                    <dt>{rewardPartLabel("cost")}</dt>
                    <dd className="font-mono tabular-nums">
                      <bdi dir="ltr">{cost == null ? "—" : f.score(blended.parts.cost)}</bdi>
                    </dd>
                  </div>
                )}
              </dl>
              <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-sm font-semibold">
                <span>{msg("reward_builder.try.total")}</span>
                <span data-total>
                  <ScorePill>{total > 0 ? f.score(blended.total) : "—"}</ScorePill>
                </span>
              </div>
            </div>
          )}
          {ran && one && (
            <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-sm font-semibold">
                <span>{msg("reward_builder.try.one")}</span>
                <ScorePill>{signed(one.result.score)}</ScorePill>
              </div>
              <p className="text-xs text-muted-foreground">{reasonText(one.result.reason)}</p>
            </div>
          )}
          {!ran && <p className="text-xs text-muted-foreground">{msg("reward_builder.try.how")}</p>}
        </div>
      </div>
    </section>
  );
}
