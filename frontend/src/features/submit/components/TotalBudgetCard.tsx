"use client";

import { useEffect, useState } from "react";
import { Gauge } from "@/shared/ui/icons";
import { Input } from "@/shared/ui/primitives/input";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { chargeableBracket } from "../lib/cost-bracket";
import type { SubmitWizardContext } from "../hooks/use-submit-wizard";

/**
 * The one budget surface of both wizards: a single total that covers setup
 * checks and the optimization itself, shown against the projected usage
 * bracket and what setup has spent so far. Credits are reserved before work
 * starts and settled on actual usage; the run stops when the total is reached.
 *
 * Mode-aware: a managed run shows the full per-model credit cost; a BYOK run
 * shows only the platform fee (the provider tokens are paid on the user's own
 * key), so the figures stay honest in both modes.
 */
type BudgetContext = Pick<
  SubmitWizardContext,
  "costBracket" | "suggestedCeiling" | "maxCostCredits" | "setMaxCostCredits"
> & {
  setupSpent?: number;
  availableCredits?: number | null;
};

const ISOLATE_START = "⁦";
const ISOLATE_END = "⁩";

function parseBudget(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

export function TotalBudgetCard({ w, mode }: { w: BudgetContext; mode: TokenSourceMode }) {
  const { costBracket, suggestedCeiling, maxCostCredits, setMaxCostCredits } = w;
  const setupSpent = w.setupSpent ?? 0;
  const availableCredits = w.availableCredits ?? null;
  const locale = getActiveIntlLocale();
  const displayBracket = chargeableBracket(costBracket, mode);

  // The field owns its text so the user can clear it; an empty total stays
  // unset instead of snapping to zero.
  const [text, setText] = useState(maxCostCredits == null ? "" : String(maxCostCredits));
  useEffect(() => {
    setText((prev) =>
      parseBudget(prev) === maxCostCredits
        ? prev
        : maxCostCredits == null
          ? ""
          : String(maxCostCredits),
    );
  }, [maxCostCredits]);

  const credits = (value: number) =>
    `${ISOLATE_START}${formatCredits(value, locale)}${ISOLATE_END}`;

  return (
    <div className="overflow-hidden rounded-xl border border-[#C8B9A8]/50 bg-[#FAF8F5] shadow-[0_1px_2px_rgba(61,46,34,0.04)]">
      <div className="space-y-3 px-3.5 pt-3 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[#3D2E22]">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#C8A882]/15 text-[#A8895E]">
              <Gauge className="h-3 w-3" />
            </span>
            <HelpTip text={tip("submit.budget")}>
              <label
                htmlFor="totalBudgetInput"
                className="text-[13px] font-semibold tracking-tight"
              >
                {msg("submit.budget.label")}
              </label>
            </HelpTip>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[#3D2E22]/80" dir="auto">
            {msg("submit.budget.supporting")}
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id="totalBudgetInput"
              inputMode="numeric"
              autoComplete="off"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setMaxCostCredits(parseBudget(e.target.value));
              }}
              placeholder={formatMsg("submit.budget.placeholder", {
                suggested: formatCredits(suggestedCeiling, locale),
              })}
              dir="ltr"
              className="h-[44px] w-full text-base tabular-nums sm:w-36 lg:h-9 lg:text-sm"
            />
            <span className="text-[11px] text-[#8C7A6B]">
              {msg("submit.cost_ceiling.cap_unit")}
            </span>
          </div>
          {maxCostCredits == null && (
            <p className="text-[11px] leading-relaxed text-[#8C7A6B]" dir="auto">
              {msg("submit.budget.unset")}
            </p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-[#DDD6CC]/60 pt-3 text-[12px] sm:grid-cols-4">
          <BudgetFigure
            label={msg("submit.budget.estimated_low")}
            value={credits(displayBracket.lowCredits)}
          />
          <BudgetFigure
            label={msg("submit.budget.estimated_high")}
            value={credits(displayBracket.highCredits)}
          />
          <BudgetFigure label={msg("submit.budget.setup_spent")} value={credits(setupSpent)} />
          <BudgetFigure
            label={msg("submit.budget.available")}
            value={availableCredits == null ? "—" : credits(availableCredits)}
          />
        </dl>
        {mode === "byok" && (
          <p className="text-[11px] leading-relaxed text-[#8C7A6B]" dir="auto">
            {msg("submit.budget.byok_note")}
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-[#8C7A6B]" dir="auto">
          {msg("submit.budget.reservation_copy")}
        </p>
      </div>
    </div>
  );
}

function BudgetFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-[#8C7A6B]">{label}</dt>
      <dd className="font-mono text-xs font-semibold tabular-nums text-[#3D2E22]" dir="auto">
        {value}
      </dd>
    </div>
  );
}
