"use client";

import { msg, type MessageKey } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import {
  REWARD_COMPONENTS,
  rewardPreviewCases,
  scoreReward,
  type RewardComponent,
  type RewardInputs,
  type RewardSpec,
  type RewardSpecRead,
} from "@/shared/lib/reward";

const DASH = "—";

/** The values of one preview response, each in its own unit. */
function rawValue(
  spec: RewardSpec,
  component: RewardComponent,
  inputs: RewardInputs,
  f: ReturnType<typeof rewardFormatters>,
): string {
  if (component === "speed") return f.ms(inputs.timeMs);
  if (component === "cost") return f.usd(inputs.costUsd);
  if (inputs.accuracy == null) return DASH;
  return spec.accuracy.reference != null && spec.accuracy.unit
    ? `${f.number(inputs.accuracy)} ${spec.accuracy.unit}`
    : f.number(inputs.accuracy);
}

/**
 * The setup review of an accuracy, speed and cost reward (SKY-69).
 *
 * It shows the metric's fixed formula, each part's meaning, unit, weight and
 * reference, and controlled preview cases scored by the same formula the run
 * uses: one-change improvements on both sides of each reference, a tradeoff,
 * failures and an unpriced call.
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
  const cases = rewardPreviewCases(spec);
  const reference = (component: RewardComponent) => {
    const value = spec[component].reference;
    if (value == null) return msg("submit.v2.reward.score_accuracy");
    if (component === "speed") return f.ms(value);
    if (component === "cost") return f.usd(value);
    return spec.accuracy.unit ? `${f.number(value)} ${spec.accuracy.unit}` : f.number(value);
  };
  const th = "px-2 py-1.5 text-start text-[0.6875rem] font-medium text-muted-foreground";
  const td = "px-2 py-1.5 align-top";
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {msg("submit.v2.reward.formula", {
            accuracy: f.pct(spec.weights.accuracy),
            speed: f.pct(spec.weights.speed),
            cost: f.pct(spec.weights.cost),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{msg("submit.v2.reward.utility")}</p>
      </div>

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
                  {rewardPartLabel(component)}
                </th>
                <td className={td}>
                  <bdi>{spec[component].meaning || DASH}</bdi>
                </td>
                <td className={`${td} tabular-nums`}>
                  <bdi dir="ltr">{f.pct(spec.weights[component])}</bdi>
                </td>
                <td className={`${td} tabular-nums`}>
                  <bdi>{reference(component)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">
          {msg("submit.v2.reward.preview_title")}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-xs">
            <caption className="sr-only">{msg("submit.v2.reward.preview_title")}</caption>
            <thead>
              <tr className="border-b border-border/60">
                <th scope="col" className={th}>
                  {msg("submit.v2.reward.col.case")}
                </th>
                {REWARD_COMPONENTS.map((component) => (
                  <th key={component} scope="col" className={th}>
                    {rewardPartLabel(component)}
                  </th>
                ))}
                <th scope="col" className={th}>
                  {msg("submit.v2.reward.col.total")}
                </th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c, i) => {
                const after = scoreReward(spec, c.inputs);
                const before = c.before ? scoreReward(spec, c.before) : null;
                return (
                  <tr
                    key={`${c.kind}-${i}`}
                    data-case={c.kind}
                    className="border-b border-border/30 last:border-b-0"
                  >
                    <th scope="row" className={`${td} text-start font-normal`}>
                      {msg(`submit.v2.reward.case.${c.kind}` as MessageKey)}
                    </th>
                    {REWARD_COMPONENTS.map((component) => (
                      <td key={component} className={`${td} tabular-nums`}>
                        <bdi dir="ltr">
                          {/* Hebrew currency output carries RLM marks; isolate each value
                              so a "before → after" pair keeps its order and a single
                              price reads the same as the prices in a pair. */}
                          {c.before && c.change?.component === component ? (
                            <>
                              <bdi>{rawValue(spec, component, c.before, f)}</bdi>
                              {" → "}
                              <bdi>{rawValue(spec, component, c.inputs, f)}</bdi>
                            </>
                          ) : (
                            <bdi>{rawValue(spec, component, c.inputs, f)}</bdi>
                          )}
                        </bdi>
                      </td>
                    ))}
                    <td className={`${td} font-mono tabular-nums`}>
                      <bdi dir="ltr" data-total={after.total.toFixed(6)}>
                        {before
                          ? `${f.score(before.total)} → ${f.score(after.total)}`
                          : f.score(after.total)}
                      </bdi>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
        <li>{msg("submit.v2.reward.tradeoff_note")}</li>
        <li>{msg("submit.v2.reward.failures")}</li>
      </ul>
    </div>
  );
}
