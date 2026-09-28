import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreflightScope, WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import {
  preflightMayAdvance,
  preflightPendingMessageKey,
  reusableSuccessfulPreflight,
  reusableTerminalPreflight,
} from "./preflight-outcome.ts";

const budget = {
  id: "budget",
  total_cents: 20,
  revision: 1,
  generation: 0,
  state: "open",
  job_id: null,
  setup_spent_cents: "1",
  run_spent_cents: "0",
  reserved_cents: "0",
  available_cents: "19",
  billed_cents: 1,
  wallet_setup_spent_cents: "1",
  wallet_run_spent_cents: "0",
  wallet_reserved_cents: 0,
  account_available_cents: 99,
  external_spent_cents: "0",
  pending_operations: 0,
  blocked_reason: null,
};

function response(
  status: WizardPreflightResponse["status"],
  mayAdvance: boolean,
  category?: NonNullable<WizardPreflightResponse["pending_reason"]>["category"],
): WizardPreflightResponse {
  return {
    id: "preflight",
    fingerprint: "fingerprint",
    status,
    may_advance: mayAdvance,
    checks: [{ key: "setup", status }],
    budget,
    ...(category ? { pending_reason: { category, message: "Pending setup" } } : {}),
  };
}

test("only matching completed success is reused before another request", () => {
  const succeeded = response("succeeded", true);
  const evidence = { execution: { identity: "current", response: succeeded } };
  assert.equal(reusableSuccessfulPreflight(evidence, "execution", "current"), succeeded);
  assert.equal(reusableSuccessfulPreflight(evidence, "execution", "changed"), null);
  assert.equal(reusableSuccessfulPreflight(evidence, "evaluation", "current"), null);
  assert.equal(
    reusableSuccessfulPreflight(
      {
        execution: {
          identity: "current",
          response: response("pending", true, "later_stage_dependency"),
        },
      },
      "execution",
      "current",
    ),
    null,
  );
});

test("a settled outcome is reusable for the same config; a pending one is not", () => {
  const succeeded = response("succeeded", true);
  const failed = response("failed", false);
  const pending = response("pending", false, "usage_reconciliation");
  const terminal = (stored: WizardPreflightResponse, scope: PreflightScope, identity: string) =>
    reusableTerminalPreflight(
      { execution: { identity: "current", response: stored } },
      scope,
      identity,
    );

  assert.equal(terminal(succeeded, "execution", "current"), succeeded);
  assert.equal(terminal(failed, "execution", "current"), failed);
  assert.equal(terminal(pending, "execution", "current"), null);
  assert.equal(terminal(failed, "execution", "changed"), null);
  assert.equal(terminal(failed, "evaluation", "current"), null);
});

test("only an explicit evaluation dependency can advance while pending", () => {
  const deferred = response("pending", true, "later_stage_dependency");
  const usage = response("pending", false, "usage_reconciliation");
  assert.equal(preflightMayAdvance(response("succeeded", true), "execution"), true);
  assert.equal(preflightMayAdvance(response("succeeded", false), "evaluation"), false);
  assert.equal(preflightMayAdvance(deferred, "evaluation"), true);
  assert.equal(preflightMayAdvance(deferred, "execution"), false);
  assert.equal(preflightMayAdvance(usage, "evaluation"), false);
  assert.equal(preflightPendingMessageKey(deferred), "submit.preflight.deferred");
  assert.equal(preflightPendingMessageKey(usage), "submit.preflight.usage_pending");
  assert.equal(
    preflightPendingMessageKey(response("pending", false, "setup_incomplete")),
    "submit.preflight.incomplete",
  );
});
