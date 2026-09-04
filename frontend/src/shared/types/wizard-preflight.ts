import type {
  BlackboxRunRequest,
  ExecutionRuntime,
  GridSearchRequest,
  RunRequest,
  ScorerDryRunResponse,
  WorkflowDryRunResponse,
  RuntimeCostProfile,
} from "./api";
import type { ExecutionBudget } from "./execution-budget";

export type PreflightScope = "evaluation" | "execution";
export type PreflightStatus = "succeeded" | "failed" | "pending";
export type PreflightPendingCategory =
  | "later_stage_dependency"
  | "usage_reconciliation"
  | "setup_incomplete";
export type WizardPreflightPayload = BlackboxRunRequest | RunRequest | GridSearchRequest;
export interface WizardPreflightRequest {
  scope: PreflightScope;
  workflow: "anything" | "dspy";
  payload: WizardPreflightPayload;
  execution_budget_id: string;
  execution_budget_revision: number;
}
export interface WizardPreflightResponse {
  id: string;
  fingerprint: string;
  status: PreflightStatus;
  may_advance: boolean;
  pending_reason?: {
    category: PreflightPendingCategory;
    message: string;
    field?: string;
  };
  checks: Array<{
    key: string;
    status: PreflightStatus | "skipped";
    message?: string;
    field?: string;
  }>;
  budget: ExecutionBudget;
  scorer_result?: ScorerDryRunResponse;
  workflow_result?: WorkflowDryRunResponse;
}
export interface ExecutionRuntimeCatalog {
  runtimes: Array<{
    id: ExecutionRuntime;
    available: boolean;
    unavailable_reason: string | null;
    cost: RuntimeCostProfile;
    checkpoint_restore_supported: boolean;
    checkpoint_restore_reason: string | null;
  }>;
  default_runtime: ExecutionRuntime;
  run_recovery_eligibility: string;
}
