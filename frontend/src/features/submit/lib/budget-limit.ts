import { toast } from "react-toastify";

import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { chargeableBracket, runtimeStartHold, type CostBracket } from "./cost-bracket";

/**
 * Whether the spending limit can hold the run's start-up hold and even the low
 * end of the projected usage. When it cannot, the wizard must not move past
 * the budget step: the run would be refused at its first step or almost
 * surely stop early, so the user is told to raise the limit instead. An unset
 * limit is left to stage validation.
 */
export function limitCoversEstimate(
  bracket: CostBracket,
  mode: TokenSourceMode,
  limit: number | null,
): boolean {
  if (limit == null) return true;
  const locale = getActiveIntlLocale();
  const hold = runtimeStartHold(bracket);
  if (limit < hold) {
    toast.error(
      formatMsg("submit.budget.limit_below_hold", { amount: formatCredits(hold, locale) }),
    );
    return false;
  }
  const low = chargeableBracket(bracket, mode).lowCredits;
  if (low <= limit) return true;
  toast.error(
    formatMsg("submit.budget.limit_too_low", {
      low: formatCredits(low, locale),
      limit: formatCredits(limit, locale),
    }),
  );
  return false;
}
