import { toast } from "react-toastify";

import { formatCredits } from "@/features/billing";
import { formatMsg } from "@/shared/lib/messages";
import { getActiveIntlLocale } from "@/shared/lib/runtime-locale";

import type { BudgetShortfall } from "./budget-limit";

// One id keeps repeated presses of Next from stacking the same toast.
const TOAST_ID = "budget-too-low";

/** Tells the user the budget is too low to leave the step, and how much it needs. */
export function toastBudgetShortfall({ kind, needed }: BudgetShortfall): void {
  toast.error(
    formatMsg(kind === "limit" ? "submit.budget.limit_too_low" : "submit.budget.balance_too_low", {
      amount: formatCredits(needed, getActiveIntlLocale()),
    }),
    { toastId: TOAST_ID },
  );
}
