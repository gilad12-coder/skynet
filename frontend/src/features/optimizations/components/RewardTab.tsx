"use client";

import { readRewardSpec } from "@/shared/lib/reward";
import { readRewardRules } from "@/shared/lib/reward-rules-code";
import { RewardBuilder } from "@/shared/ui/reward/reward-builder";
import { RewardPreview } from "@/shared/ui/reward/reward-preview";
import { RewardTryIt, type RewardSample } from "@/shared/ui/reward/reward-try-it";
import type { BlackboxRunResult } from "@/shared/types/api";
import { RewardComparison, savedMetricCode } from "./RewardComparison";

const SAMPLE_LIMIT = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The metric code a run saved, from its workspace, scorer or top-level field. */
export function runMetricCode(payload: unknown): string | null {
  const saved = savedMetricCode(payload);
  if (saved) return saved;
  const top = isRecord(payload) ? payload.metric_code : null;
  return typeof top === "string" ? top : null;
}

/** The run's expected column and its first cases, to fill "Try it". */
export function runSamples(payload: unknown): { expectedField: string; samples: RewardSample[] } {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const expectedField = typeof data.expected_field === "string" ? data.expected_field : "expected";
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const samples = cases.slice(0, SAMPLE_LIMIT).flatMap((c): RewardSample[] =>
    isRecord(c)
      ? [
          {
            input: isRecord(c.input) ? c.input : {},
            expected: isRecord(c.expected) ? c.expected : null,
          },
        ]
      : [],
  );
  return { expectedField, samples };
}

/** Whether a run's metric is an accuracy, speed and cost reward, so it gets a Reward tab. */
export function hasRewardTab(payload: unknown): boolean {
  return readRewardSpec(runMetricCode(payload)).kind === "spec";
}

/**
 * The run page's Reward tab (SKY-84).
 *
 * A reward made in the builder shows its rewards and "Try it", as in the
 * builder. A hand-written REWARD_SPEC shows its parts. Under both, a finished
 * run compares the baseline and the selected version part by part.
 *
 * Args:
 *   payload: The run's saved submit payload.
 *   result: The black-box result, once the run finished.
 */
export function RewardTab({
  payload,
  result,
}: {
  payload: unknown;
  result: BlackboxRunResult | null;
}) {
  const code = runMetricCode(payload);
  const { expectedField, samples } = runSamples(payload);
  const rules = readRewardRules(code, expectedField);
  return (
    <div className="space-y-6">
      {rules.kind === "build" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <RewardBuilder
            build={rules.build}
            expectedField={expectedField}
            samples={samples}
            tryIt={false}
          />
          <RewardTryIt build={rules.build} expectedField={expectedField} samples={samples} />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card px-4 py-3.5">
          <RewardPreview read={readRewardSpec(code)} />
        </div>
      )}
      {result && <RewardComparison result={result} metricCode={code} />}
    </div>
  );
}
