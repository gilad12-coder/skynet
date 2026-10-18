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
import { Label } from "@/shared/ui/primitives/label";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { Input } from "@/shared/ui/primitives/input";
import { plain, reasonText, signed } from "./reward-text";

export interface RewardSample {
  input: Record<string, unknown>;
  expected: Record<string, unknown> | null;
}

/** A number field's value, or `null` when it is empty or not a number. */
function numberOrNull(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * "Try it" for a built reward (SKY-84): enter a sample reply and the expected
 * value, and see each reward's score times its weight, the accuracy and the
 * total reward, with a reason for each score.
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
  const [reply, setReply] = React.useState("");
  const [expected, setExpected] = React.useState(
    first === undefined || first === null ? "" : expectedText(first),
  );
  const [timeMs, setTimeMs] = React.useState("");
  const [costUsd, setCostUsd] = React.useState("");
  const f = rewardFormatters();

  const result = scoreBuild(build, reply, { [expectedField]: expected });
  const time = numberOrNull(timeMs);
  const cost = numberOrNull(costUsd);
  const blended = blendBuild(build, result.accuracy, time, cost);
  const total = buildWeight(build);
  const usesSpeed = build.speed.weight > 0;
  const usesCost = build.cost.weight > 0;

  return (
    <section aria-labelledby={`${id}-title`} className={cn("space-y-3 text-sm", className)}>
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {msg("reward_builder.try.title")}
      </h3>
      {samples.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{msg("reward_builder.try.samples")}</span>
          {samples.map((sample, index) => {
            const value = sample.expected?.[expectedField];
            return (
              <button
                key={index}
                type="button"
                className="rounded-full border border-border/70 px-2 py-0.5 text-xs hover:bg-accent"
                onClick={() =>
                  setExpected(value === undefined || value === null ? "" : expectedText(value))
                }
              >
                {msg("reward_builder.try.sample", { n: String(index + 1) })}
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${id}-reply`}>{msg("reward_builder.try.reply")}</Label>
        <Textarea
          id={`${id}-reply`}
          dir="auto"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={msg("reward_builder.try.reply_hint")}
          className="min-h-20 font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-expected`}>
          {msg("reward_builder.try.expected", { field: expectedField })}
        </Label>
        <Textarea
          id={`${id}-expected`}
          dir="auto"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          className="min-h-10 font-mono text-xs"
        />
      </div>
      {(usesSpeed || usesCost) && (
        <div className="grid grid-cols-2 gap-2">
          {usesSpeed && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-ms`}>{msg("reward_builder.try.time")}</Label>
              <Input
                id={`${id}-ms`}
                inputMode="decimal"
                dir="ltr"
                value={timeMs}
                onChange={(e) => setTimeMs(e.target.value)}
              />
            </div>
          )}
          {usesCost && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-usd`}>{msg("reward_builder.try.cost")}</Label>
              <Input
                id={`${id}-usd`}
                inputMode="decimal"
                dir="ltr"
                value={costUsd}
                onChange={(e) => setCostUsd(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      <div aria-live="polite" className="rounded-lg border border-border/60 bg-muted/30">
        <ul className="divide-y divide-border/40">
          {result.rules.map(({ entry, result: r }) => (
            <li key={entry.name} data-reward={entry.name} className="space-y-0.5 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <bdi dir="ltr" className="truncate font-mono text-xs">
                  {entry.name}
                </bdi>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  <bdi dir="ltr">
                    {signed(r.score)} × {plain(entry.weight)}
                  </bdi>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{reasonText(r.reason)}</p>
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
          <div className="flex justify-between gap-2 pt-1 text-sm font-semibold">
            <dt>{msg("reward_builder.try.total")}</dt>
            <dd data-total className="font-mono tabular-nums">
              <bdi dir="ltr">{total > 0 ? f.score(blended.total) : "—"}</bdi>
            </dd>
          </div>
        </dl>
      </div>
      <p className="text-xs text-muted-foreground">{msg("reward_builder.try.how")}</p>
    </section>
  );
}
