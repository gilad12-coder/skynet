import type { TokenSourceMode } from "@/features/billing";

import { chargeableBracket, runtimeStartHold, type CostBracket } from "./cost-bracket";

export interface BudgetChoice {
  uncapped: boolean;
  /** The spending limit, or null while it is unset. */
  limit: number | null;
  /** The account's spendable credits, or null while they have not loaded. */
  balance: number | null;
}

export interface BudgetShortfall {
  /** Which figure falls short: the spending limit, or the account's balance. */
  kind: "limit" | "balance";
  /** The least that figure has to be. */
  needed: number;
}

/**
 * The least a spending limit can be: the low end of the projected usage,
 * which starts at the hold the run's box takes the moment it opens.
 */
export function limitFloor(bracket: CostBracket, mode: TokenSourceMode): number {
  return chargeableBracket(bracket, mode).lowCredits;
}

/**
 * Why the budget step cannot be left yet, or null when it can. A limit under
 * the floor would be refused at the run's first step or almost surely stop it
 * early; without a limit the account has to cover the opening hold instead.
 * An unset limit is left to stage validation, and a balance that has not
 * loaded to the server.
 */
export function budgetShortfall(
  bracket: CostBracket,
  mode: TokenSourceMode,
  { uncapped, limit, balance }: BudgetChoice,
): BudgetShortfall | null {
  if (uncapped) {
    const hold = runtimeStartHold(bracket);
    return balance != null && balance < hold ? { kind: "balance", needed: hold } : null;
  }
  const floor = limitFloor(bracket, mode);
  return limit != null && limit < floor ? { kind: "limit", needed: floor } : null;
}
