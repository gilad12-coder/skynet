/**
 * Translated text for the reward builder (SKY-84): rule-type names, one-line
 * rule summaries, score reasons and import errors.
 */
import { msg, type MessageKey } from "@/shared/lib/messages";
import type { RewardImportError } from "@/shared/lib/reward-md";
import {
  ruleRange,
  type RewardRule,
  type RuleReason,
  type RuleType,
} from "@/shared/lib/reward-rules";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

/** A signed score: `+2`, `−1`, `0`. */
export function signed(value: number): string {
  const text = new Intl.NumberFormat(getActiveIntlLocale(), {
    maximumFractionDigits: 3,
    signDisplay: "exceptZero",
  }).format(value);
  return text;
}

/** A plain number in the active locale. */
export function plain(value: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale(), { maximumFractionDigits: 3 }).format(value);
}

/** A 0-1 share as a percent. */
export function percent(value: number): string {
  return new Intl.NumberFormat(getActiveIntlLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

/** The name of a rule type. */
export function ruleTypeLabel(type: RuleType): string {
  return msg(`reward_builder.type.${type}` as MessageKey);
}

/** A rule's one-line summary: what it checks and the best score it can give. */
export function ruleSummary(rule: RewardRule): string {
  const best = signed(ruleRange(rule).max);
  if (rule.type === "regex") {
    return msg(
      rule.mode === "fullmatch"
        ? "reward_builder.summary.regex_full"
        : "reward_builder.summary.regex",
      {
        best,
      },
    );
  }
  if (rule.type === "exact_match") {
    return msg("reward_builder.summary.exact", { field: rule.compare_to, best });
  }
  if (rule.type === "numeric") {
    return msg("reward_builder.summary.numeric", {
      field: rule.compare_to,
      bands: String(rule.bands.length),
      best,
    });
  }
  if (rule.type === "json_schema") {
    return msg("reward_builder.summary.json", { type: rule.schema.type, best });
  }
  return msg("reward_builder.summary.length", { max: plain(rule.max_chars), best });
}

/** Why a rule gave its score. */
export function reasonText(reason: RuleReason): string {
  switch (reason.code) {
    case "band":
      return msg("reward_builder.reason.band", { within: percent(reason.within) });
    case "missing_key":
      return msg("reward_builder.reason.missing_key", { key: reason.key });
    case "wrong_type":
      return msg("reward_builder.reason.wrong_type", { type: reason.type ?? "" });
    case "under":
    case "over":
      return msg(`reward_builder.reason.${reason.code}`, {
        chars: plain(reason.chars),
        max: plain(reason.max),
      });
    default:
      return msg(`reward_builder.reason.${reason.code}` as MessageKey);
  }
}

/** Why a REWARD.md did not import. */
export function importErrorText(error: RewardImportError, detail?: string): string {
  const text = msg(`reward_builder.import.error.${error}` as MessageKey);
  return detail ? `${text} (${detail})` : text;
}
