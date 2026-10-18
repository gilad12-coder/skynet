"use client";

import * as React from "react";
import { msg } from "@/shared/lib/messages";
import { buildToMetricCode, readRewardRules } from "@/shared/lib/reward-rules-code";
import {
  DEFAULT_COST,
  DEFAULT_SPEED,
  bundledRewards,
  type RewardBuild,
} from "@/shared/lib/reward-rules";
import { Sparkle } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { RewardBuilder } from "@/shared/ui/reward/reward-builder";
import type { RewardSample } from "@/shared/ui/reward/reward-try-it";

/** The build a new reward starts from: the bundled exact answer. */
export function starterBuild(expectedField: string): RewardBuild {
  return {
    rewards: bundledRewards(expectedField).slice(0, 1),
    speed: DEFAULT_SPEED,
    cost: DEFAULT_COST,
  };
}

/**
 * The metric step's UI mode (SKY-84): the reward builder beside the editor.
 *
 * The builder keeps no state of its own. It reads its rewards from metric.py
 * and writes metric.py again on each change, so the editor, the check and the
 * run all see the same code.
 *
 * Args:
 *   metricCode: metric.py as it is now.
 *   onMetricCode: Replace metric.py.
 *   expectedField: The run's expected column.
 *   samples: Cases for "Try it".
 */
export function RewardBuilderPanel({
  metricCode,
  onMetricCode,
  expectedField,
  samples,
}: {
  metricCode: string;
  onMetricCode: (code: string) => void;
  expectedField: string;
  samples: readonly RewardSample[];
}) {
  const read = React.useMemo(
    () => readRewardRules(metricCode, expectedField),
    [metricCode, expectedField],
  );
  const write = React.useCallback(
    (build: RewardBuild) => onMetricCode(buildToMetricCode(build)),
    [onMetricCode],
  );

  if (read.kind === "build") {
    return (
      <RewardBuilder
        build={read.build}
        onChange={write}
        expectedField={expectedField}
        samples={samples}
        className="h-full"
      />
    );
  }
  const hasCode = metricCode.trim().length > 0;
  return (
    <div className="space-y-3 p-4 text-sm">
      <Sparkle className="size-5 text-muted-foreground" aria-hidden />
      <p className="font-medium">{msg("reward_builder.start.title")}</p>
      <p className="text-xs text-muted-foreground">
        {msg(
          read.kind === "invalid"
            ? "reward_builder.start.invalid"
            : hasCode
              ? "reward_builder.start.replace"
              : "reward_builder.start.desc",
        )}
      </p>
      <Button type="button" size="sm" onClick={() => write(starterBuild(expectedField))}>
        {msg(read.kind === "invalid" ? "reward_builder.start.over" : "reward_builder.start.action")}
      </Button>
    </div>
  );
}
