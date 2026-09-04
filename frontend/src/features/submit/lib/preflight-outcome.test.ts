import assert from "node:assert/strict";
import { test } from "node:test";

import type { WizardPreflightResponse } from "@/shared/types/wizard-preflight";
import {
  preflightMayAdvance,
  preflightPendingMessageKey,
  reusableSuccessfulPreflight,
} from "./preflight-outcome.ts";

const budget = {
  id: "budget",
  total_credits: 20,
  revision: 1,
  generation: 0,
  state: "open",
  job_id: null,
  setup_spent_credits: "1",
  run_spent_credits: "0",
  reserved_credits: "0",
  available_credits: "19",
  billed_credits: 1,
  wallet_setup_spent_credits: "1",
  wallet_run_spent_credits: "0",
  wallet_reserved_credits: 0,
  account_available_credits: 99,
  external_spent_credits: "0",
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
