"use client";

import { msg } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import { buildWeight, type RewardBuild } from "@/shared/lib/reward-rules";
import { percent, ruleSummary } from "./reward-text";

/**
 * The run review's recap of a built reward (SKY-84), after Unsloth Studio's
 * review step: each reward and the Speed and Cost parts, what each checks,
 * and its share of the total reward.
 */
export function RewardRecap({ build }: { build: RewardBuild }) {
  const f = rewardFormatters();
  const total = buildWeight(build);
  const share = (weight: number) => (total > 0 ? percent(Math.max(weight, 0) / total) : "—");
  const rows = [
    ...build.rewards.map((entry) => ({
      key: entry.name,
      name: (
        <bdi dir="ltr" className="font-mono">
          {entry.name}
        </bdi>
      ),
      what: entry.description || ruleSummary(entry.rule),
      weight: entry.weight,
    })),
    ...(["speed", "cost"] as const)
      .filter((part) => build[part].weight > 0)
      .map((part) => ({
        key: part,
        name: rewardPartLabel(part),
        what: msg(part === "speed" ? "reward_builder.recap.speed" : "reward_builder.recap.cost", {
          reference: part === "speed" ? f.ms(build.speed.reference) : f.usd(build.cost.reference),
        }),
        weight: build[part].weight,
      })),
  ];
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">
        {msg("reward_builder.recap.title", { count: String(build.rewards.length) })}
      </p>
      <ul className="divide-y divide-border/40 rounded-lg border border-border/60">
        {rows.map((row) => (
          <li key={row.key} data-recap={row.key} className="flex items-start gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{row.name}</p>
              <p className="text-[0.6875rem] text-muted-foreground">{row.what}</p>
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums">
              <bdi dir="ltr">{share(row.weight)}</bdi>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{msg("reward_builder.recap.how")}</p>
    </div>
  );
}
