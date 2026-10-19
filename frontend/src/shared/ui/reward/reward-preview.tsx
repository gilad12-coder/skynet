"use client";

import { msg } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartName } from "@/shared/lib/reward-format";
import {
  REWARD_COMPONENTS,
  type RewardComponent,
  type RewardSpec,
  type RewardSpecRead,
} from "@/shared/lib/reward";

const DASH = "—";

/** The value at which a part scores ½, in its unit; a 0–1 accuracy says so instead. */
export function rewardReference(spec: RewardSpec, component: RewardComponent): string {
  const f = rewardFormatters();
  const value = spec[component].reference;
  if (value == null) return msg("submit.v2.reward.score_accuracy");
  if (component === "speed") return f.ms(value);
  if (component === "cost") return f.usd(value);
  return spec.accuracy.unit ? `${f.number(value)} ${spec.accuracy.unit}` : f.number(value);
}

/** The reward's fixed formula. */
export function RewardFormula({ spec }: { spec: RewardSpec }) {
  const f = rewardFormatters();
  return (
    <p className="text-sm font-medium text-foreground">
      {msg("submit.v2.reward.formula", {
        accuracy: f.pct(spec.weights.accuracy),
        speed: f.pct(spec.weights.speed),
        cost: f.pct(spec.weights.cost),
      })}
    </p>
  );
}

/**
 * The setup review of an accuracy, speed and cost reward (SKY-69).
 *
 * It shows the metric's fixed formula and each part's meaning, unit, weight
 * and reference.
 */
export function RewardPreview({ read }: { read: RewardSpecRead }) {
  if (read.kind !== "spec") {
    return (
      <p role="status" className="text-sm text-[var(--warning)]">
        {msg("submit.v2.reward.invalid")}
      </p>
    );
  }
  const { spec } = read;
  const f = rewardFormatters();
  const th = "px-2 py-1.5 text-start text-[0.6875rem] font-medium text-muted-foreground";
  const td = "px-2 py-1.5 align-top";
  return (
    <div className="space-y-4 text-sm">
      <RewardFormula spec={spec} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-xs">
          <caption className="sr-only">{msg("submit.v2.reward.parts_title")}</caption>
          <thead>
            <tr className="border-b border-border/60">
              <th scope="col" className={th}>
                {msg("submit.v2.reward.col.part")}
              </th>
              <th scope="col" className={th}>
                {msg("submit.v2.reward.col.meaning")}
              </th>
              <th scope="col" className={th}>
                {msg("submit.v2.reward.col.weight")}
              </th>
              <th scope="col" className={th}>
                {msg("submit.v2.reward.col.reference")}
              </th>
            </tr>
          </thead>
          <tbody>
            {REWARD_COMPONENTS.map((component) => (
              <tr key={component} className="border-b border-border/30 last:border-b-0">
                <th scope="row" className={`${td} text-start font-medium`}>
                  {rewardPartName(spec, component)}
                </th>
                <td className={td}>
                  <bdi>{spec[component].meaning || DASH}</bdi>
                </td>
                <td className={`${td} tabular-nums`}>
                  <bdi dir="ltr">{f.pct(spec.weights[component])}</bdi>
                </td>
                <td className={`${td} tabular-nums`}>
                  <bdi>{rewardReference(spec, component)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
