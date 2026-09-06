"use client";

import { Sparkle, Info } from "@/shared/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/shared/ui/primitives/tooltip";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { useLocale } from "@/shared/providers";
import { dirForLocale } from "@/shared/lib/locale";
import type { SplitPlan } from "@/shared/types/api";

import type { SubmitWizardContext } from "../hooks/use-submit-wizard";

// Both wizards share split controls without requiring the full standard context.
export type SplitPlanControls = Pick<
  SubmitWizardContext,
  "splitPlan" | "splitMode" | "setSplitMode" | "profileLoading"
>;

// Tier thresholds mirror backend planner.py (recommend_split / _recommend_fractions):
// the split fractions are chosen there from the total row count plus the engine hint,
// so we recover the matching rationale from the plan's counts and engine and localize
// it through the UI catalog. The backend only ships Hebrew copy for these, so rendering
// them client-side is what gives every locale its own translation (and correct direction).
const TIER_TINY = 30;
const TIER_SMALL = 80;
const TIER_MEDIUM = 300;

function rationaleKey({ counts, engine }: SplitPlan): MessageKey {
  const total = counts.train + counts.val + counts.test;
  if (engine === "best_of_n") {
    if (total < TIER_TINY) return "submit.split.rationale.best_of_n.pooled";
    if (counts.train > 0) return "submit.split.rationale.best_of_n.capped";
    return "submit.split.rationale.best_of_n.holdout";
  }
  if (engine === "meta_harness") {
    return total < TIER_TINY
      ? "submit.split.rationale.meta_harness.pooled"
      : "submit.split.rationale.meta_harness.holdout";
  }
  if (total < TIER_TINY) return "submit.split.rationale.tiny";
  if (total < TIER_SMALL) return "submit.split.rationale.small";
  if (total < TIER_MEDIUM) return "submit.split.rationale.medium";
  return "submit.split.rationale.large";
}

export function SplitRecommendationHelp({ w }: { w: SplitPlanControls }) {
  const { splitPlan } = w;
  const { locale } = useLocale();
  const dir = dirForLocale(locale);
  if (!splitPlan) return null;
  const { counts } = splitPlan;
  const total = counts.train + counts.val + counts.test;
  if (total === 0) return null;
  const rationaleText = msg(rationaleKey(splitPlan), {
    total,
    train_count: counts.train,
    val_count: counts.val,
    test_count: counts.test,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={msg("submit.split.rationale_aria")}
          className="-my-3 inline-flex size-[44px] items-center justify-center rounded-full text-[#8C7A6B] transition-colors hover:bg-[#EFE7DC] hover:text-[#3D2E22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/60 lg:my-0 lg:size-5"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
        dir={dir}
        className="max-w-[min(320px,92vw)] rounded-xl border border-[#C8B9A8]/60 bg-[#FAF8F5] px-4 py-3 text-start text-[#3D2E22] shadow-[0_8px_24px_-8px_rgba(61,46,34,0.2)] [&>span]:hidden"
      >
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8C7A6B]">
          <Sparkle className="h-3 w-3 text-[#C8A882]" />
          {msg("submit.split.rationale_title")}
        </div>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-[#3D2E22]">
          <li className="flex gap-2">
            <span className="mt-[7px] inline-block h-1 w-1 shrink-0 rounded-full bg-[#C8A882]" />
            <span>{rationaleText}</span>
          </li>
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
