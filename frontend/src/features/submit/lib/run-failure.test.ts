import assert from "node:assert/strict";
import { test } from "node:test";

import { currentRunFailure, runFailureFromCheck, runFailureFromError } from "./run-failure.ts";

const SPENT =
  "The next operation needs up to 797 cents, but only 498 of the 500-cent limit remain.";

test("a check the limit refused is a limit failure with the server's words", () => {
  const failure = runFailureFromCheck("setup-a", {
    checks: [
      { key: "model.task", status: "succeeded" },
      { key: "budget", status: "failed", message: SPENT },
    ],
  });
  assert.deepEqual(failure, { identity: "setup-a", limit: true, detail: SPENT });
});

test("any other failed check is not a limit failure", () => {
  const failure = runFailureFromCheck("setup-a", {
    checks: [{ key: "model.optimization", status: "failed", message: "HTTP 404" }],
  });
  assert.deepEqual(failure, { identity: "setup-a", limit: false, detail: "HTTP 404" });
});

test("a failure with no message keeps no detail", () => {
  assert.equal(
    runFailureFromCheck("s", { checks: [{ key: "setup", status: "failed" }] }).detail,
    null,
  );
  assert.equal(runFailureFromCheck("s", { checks: [] }).detail, null);
  assert.equal(runFailureFromError("s", "  ").detail, null);
});

test("a request that failed outright is never read as the limit", () => {
  assert.deepEqual(runFailureFromError("setup-a", "Network down"), {
    identity: "setup-a",
    limit: false,
    detail: "Network down",
  });
});

test("a failure shows only while the setup it ran on is unchanged", () => {
  const failure = runFailureFromError("setup-a", "Network down");
  assert.equal(currentRunFailure(failure, "setup-a"), failure);
  // Raising the limit changes the setup's identity, which clears the failure.
  assert.equal(currentRunFailure(failure, "setup-b"), null);
  assert.equal(currentRunFailure(null, "setup-a"), null);
});
