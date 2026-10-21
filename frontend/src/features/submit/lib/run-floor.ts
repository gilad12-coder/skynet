/**
 * The least a run's spending limit can be.
 *
 * A run has no upfront cost estimate: it spends its limit and stops at the
 * budget with its best version. It still has to start. Before the first
 * model call the run opens its boxes, and each holds its first coverage
 * slice; on top of those holds the limit needs spare room for the run's
 * first calls and the calibration that prices the rest. One call's hold
 * (its prompt bytes plus its output cap at list price) is usually a few
 * cents, so a dollar of spare covers it; a model whose single call holds more
 * raises the spare to that hold.
 */

import type { ModelConfig } from "@/shared/types/api";
import type { TokenSourceMode } from "@/features/billing";

/** Spare room above the boxes' opening holds, in cents. */
export const RUN_SPARE_CENTS = 100;

/** The limit a fresh budget starts at, unless the floor is higher. */
export const DEFAULT_LIMIT_CENTS = 500;

export interface RunFloorInput {
  /** The server's hold for the boxes a check or run opens before its first model call. */
  boxHoldCents: number | null;
  /** The server's one-call hold for each selected model; unpriced models are null. */
  callHoldCents: ReadonlyArray<number | null>;
  /**
   * The job's billing stamp. A subscription run bills its model calls to the
   * user's CLI plan, so those calls hold nothing and need no spare.
   */
  tokenSource?: TokenSourceMode;
}

export interface RunFloor {
  boxHoldCents: number;
  spareCents: number;
  /** The least the limit can be, in whole cents. */
  floorCents: number;
}

/** Add the boxes' opening holds to the spare the first calls need. */
export function runFloor({ boxHoldCents, callHoldCents, tokenSource }: RunFloorInput): RunFloor {
  const boxes = Math.ceil(Math.max(0, boxHoldCents ?? 0));
  if (tokenSource === "subscription")
    return { boxHoldCents: boxes, spareCents: 0, floorCents: boxes };
  const dearestCall = callHoldCents.reduce<number>(
    (max, hold) => (typeof hold === "number" && hold > max ? hold : max),
    0,
  );
  const spare = Math.max(RUN_SPARE_CENTS, Math.ceil(dearestCall));
  return { boxHoldCents: boxes, spareCents: spare, floorCents: boxes + spare };
}

/** The limit a budget starts at: the default, or the floor when that is higher. */
export function startingLimitCents(floorCents: number, minimumCents: number | null = null): number {
  return Math.max(DEFAULT_LIMIT_CENTS, Math.ceil(floorCents), Math.ceil(minimumCents ?? 0));
}

/** The key a model's one-call hold is looked up by: the same model costs less on a BYOK key. */
export function callHoldKey(name: string, tokenSource: TokenSourceMode): string {
  return `${tokenSource}:${name}`;
}

/**
 * Collapse per-model sources to the conservative job-level billing stamp:
 * any managed model makes the job managed; with none, a CLI subscription
 * model makes it a subscription job (local desktop build only).
 */
export function aggregateTokenSource(configs: ModelConfig[]): TokenSourceMode {
  const selected = configs.filter((config) => config.name.trim());
  if (selected.length === 0) return "managed";
  if (selected.every((config) => config.token_source === "byok")) return "byok";
  const anyManaged = selected.some(
    (config) => config.token_source !== "byok" && config.token_source !== "subscription",
  );
  return anyManaged ? "managed" : "subscription";
}

/** Whether a model bills to a CLI subscription, so its calls hold no cents. */
export function isSubscriptionModel(config: ModelConfig): boolean {
  return config.token_source === "subscription";
}
