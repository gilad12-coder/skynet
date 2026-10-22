/** Contract: neutral APP_* deploy variables win, and Railway's names still work as the fallback. */

import assert from "node:assert/strict";
import test from "node:test";

import { deployGitSha, isPreviewEnvironment } from "./deploy-env.ts";

const SHA = "0f5104ee".repeat(5);

test("deployGitSha reads APP_GIT_SHA", () => {
  assert.equal(deployGitSha({ APP_GIT_SHA: SHA }), SHA);
});

test("deployGitSha falls back to RAILWAY_GIT_COMMIT_SHA", () => {
  assert.equal(deployGitSha({ RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
});

test("deployGitSha prefers APP_GIT_SHA over the Railway name", () => {
  assert.equal(deployGitSha({ APP_GIT_SHA: SHA, RAILWAY_GIT_COMMIT_SHA: "stale" }), SHA);
});

test("deployGitSha treats an empty APP_GIT_SHA as unset", () => {
  assert.equal(deployGitSha({ APP_GIT_SHA: "", RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
});

test("deployGitSha is undefined when neither name is set", () => {
  assert.equal(deployGitSha({}), undefined);
});

test("isPreviewEnvironment reads APP_ENVIRONMENT", () => {
  assert.equal(isPreviewEnvironment({ APP_ENVIRONMENT: "skynet-pr-161" }), true);
  assert.equal(isPreviewEnvironment({ APP_ENVIRONMENT: "staging" }), false);
});

test("isPreviewEnvironment falls back to RAILWAY_ENVIRONMENT_NAME", () => {
  assert.equal(isPreviewEnvironment({ RAILWAY_ENVIRONMENT_NAME: "skynet-pr-161" }), true);
});

test("isPreviewEnvironment prefers APP_ENVIRONMENT over the Railway name", () => {
  assert.equal(
    isPreviewEnvironment({ APP_ENVIRONMENT: "production", RAILWAY_ENVIRONMENT_NAME: "skynet-pr-161" }),
    false,
  );
});

test("isPreviewEnvironment is false when neither name is set", () => {
  assert.equal(isPreviewEnvironment({}), false);
});
