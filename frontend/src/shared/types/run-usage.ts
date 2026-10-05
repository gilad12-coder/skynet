/** Shape of `GET /optimizations/{id}/usage`, the run page's Usage and cost tab. */

export type UsageRole =
  | "task"
  | "reflection"
  | "proposer"
  | "scorer"
  | "sandbox"
  | "setup"
  | "other";

/** How a row was paid: through Skynet, through the owner's key with a fee, or straight to the provider. */
export type UsageBilling = "skynet" | "byok" | "direct";

/** One row of `GET /optimizations/{id}/usage`. */
export interface RunUsageRow {
  role: UsageRole | string;
  model: string | null;
  stage: string | null;
  pair: string | null;
  candidate: string | null;
  billing: UsageBilling | string;
  charged_cents: number;
  provider_cents: number | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms_total: number;
  latency_calls: number;
  unpriced_calls: number;
  pending_calls: number;
}

export interface RunUsage {
  rows: RunUsageRow[];
  settling: boolean;
  proposer: boolean;
}
