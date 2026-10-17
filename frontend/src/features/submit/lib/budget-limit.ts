import type { TokenSourceMode } from "@/features/billing";

import { chargeableBracket, type CostBracket } from "./cost-bracket";

export interface BudgetChoice {
  uncapped: boolean;
  /** The spending limit, or null while it is unset. */
  limit: number | null;
  /** The account's spendable balance in cents, or null while they have not loaded. */
  balance: number | null;
}

export interface BudgetShortfall {
  /** Which figure falls short: the spending limit, or the account's balance. */
  kind: "limit" | "balance";
  /** The least that figure has to be, in whole cents. */
  needed: number;
}

/**
 * The least a spending limit can be: the low end of the projected usage,
 * which starts at what the run holds the moment it starts (its box and its
 * dearest single model call).
 */
export function limitFloor(bracket: CostBracket, mode: TokenSourceMode): number {
  return chargeableBracket(bracket, mode).lowCents;
}

/**
 * Why the run cannot start as set, or null when it can. A limit under the
 * floor is refused at the first model call; the account has to fund that
 * same opening hold whether or not the run is capped. An unset limit is left
 * to stage validation, and a balance that has not loaded to the server.
 */
export function budgetShortfall(
  bracket: CostBracket,
  mode: TokenSourceMode,
  { uncapped, limit, balance }: BudgetChoice,
): BudgetShortfall | null {
  const needed = Math.ceil(limitFloor(bracket, mode));
  if (!uncapped && limit != null && limit < needed) return { kind: "limit", needed };
  if (balance != null && balance < needed) return { kind: "balance", needed };
  return null;
}

/** The wizard screens that set the spending limit. */
const LIMIT_SCREENS: ReadonlySet<string> = new Set(["budget", "plan"]);

/**
 * What holds Continue on `screen`, or null when nothing does. The screens
 * that set the limit hold it, and so does `gate`, the last screen before the
 * metric step: past it the user would write code and run checks for a run
 * that cannot start. No estimate yet holds nothing.
 */
export function budgetContinueBlock(
  screen: string,
  bracket: CostBracket | null,
  mode: TokenSourceMode,
  choice: BudgetChoice,
  gate = false,
): BudgetShortfall | null {
  if (!bracket || (!gate && !LIMIT_SCREENS.has(screen))) return null;
  return budgetShortfall(bracket, mode, choice);
}
