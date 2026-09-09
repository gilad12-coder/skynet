import type { TokenSourceMode } from "@/features/billing";

import { chargeableBracket, runtimeStartHold, type CostBracket } from "./cost-bracket";

export interface BudgetChoice {
  uncapped: boolean;
  /** The spending limit, or null while it is unset. */
  limit: number | null;
  /** The account's spendable credits, or null while they have not loaded. */
  balance: number | null;
}

/**
 * The least a spending limit can be: the low end of the projected usage,
 * which starts at the hold the run's box takes the moment it opens.
 */
export function limitFloor(bracket: CostBracket, mode: TokenSourceMode): number {
  return chargeableBracket(bracket, mode).lowCredits;
}

/**
 * Whether the budget step keeps the wizard where it is. A limit under the
 * floor would be refused at the run's first step or almost surely stop it
 * early; without a limit the account has to cover the opening hold instead.
 * An unset limit is left to stage validation, and a balance that has not
 * loaded to the server.
 */
export function budgetBlocksNext(
  bracket: CostBracket,
  mode: TokenSourceMode,
  { uncapped, limit, balance }: BudgetChoice,
): boolean {
  if (uncapped) return balance != null && balance < runtimeStartHold(bracket);
  return limit != null && limit < limitFloor(bracket, mode);
}
