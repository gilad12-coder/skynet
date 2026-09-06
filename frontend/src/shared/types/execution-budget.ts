/** Fractional amounts remain decimal strings; only the server admits or settles spending. */
export interface ExecutionBudget {
  id: string;
  total_credits: number;
  revision: number;
  generation: number;
  state: string;
  job_id: string | null;
  setup_spent_credits: string;
  run_spent_credits: string;
  reserved_credits: string;
  available_credits: string;
  billed_credits: number;
  wallet_setup_spent_credits: string;
  wallet_run_spent_credits: string;
  wallet_reserved_credits: number;
  account_available_credits: number;
  external_spent_credits: string;
  pending_operations: number;
  blocked_reason: string | null;
  uncapped: boolean;
}

export interface ExecutionBudgetRef {
  id: string;
  revision: number;
}

/** Job viewers receive run spending without the owner's account-wide balance. */
export type JobExecutionBudget = Omit<ExecutionBudget, "account_available_credits">;
