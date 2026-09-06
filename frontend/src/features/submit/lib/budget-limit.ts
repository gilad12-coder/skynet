import { toast } from "react-toastify";

import { formatCredits, type TokenSourceMode } from "@/features/billing";
import { formatMsg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import { chargeableBracket, type CostBracket } from "./cost-bracket";

/**
 * Whether the spending limit can hold even the low end of the projected usage.
 * When it cannot, the wizard must not move past the budget step: the run would
 * almost surely stop early, so the user is told to raise the limit instead. An
 * unset limit is left to stage validation.
 */
export function limitCoversEstimate(
  bracket: CostBracket,
  mode: TokenSourceMode,
  limit: number | null,
): boolean {
  if (limit == null) return true;
  const low = chargeableBracket(bracket, mode).lowCredits;
  if (low <= limit) return true;
  const locale = getActiveIntlLocale();
  toast.error(
    formatMsg("submit.budget.limit_too_low", {
      low: formatCredits(low, locale),
      limit: formatCredits(limit, locale),
    }),
  );
  return false;
}
