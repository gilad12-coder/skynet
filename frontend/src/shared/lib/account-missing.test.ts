import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_MISSING_CODE, isAccountMissingResponse, signOutOnce } from "./account-missing.ts";

const body = (code: string) => JSON.stringify({ status: 401, code, params: {} });

test("a 401 with the missing-account code is detected", () => {
  assert.equal(isAccountMissingResponse(401, body(ACCOUNT_MISSING_CODE)), true);
});

test("an expired-token 401 is not a missing account, so the bearer refresh still runs", () => {
  assert.equal(isAccountMissingResponse(401, body("auth.invalid_token")), false);
});

test("the code on another status, or an unparsable body, is ignored", () => {
  assert.equal(isAccountMissingResponse(403, body(ACCOUNT_MISSING_CODE)), false);
  assert.equal(isAccountMissingResponse(401, "not json"), false);
  assert.equal(isAccountMissingResponse(401, ""), false);
  assert.equal(isAccountMissingResponse(401, "null"), false);
});

test("many missing-account events sign out only once", () => {
  let calls = 0;
  const handler = signOutOnce(() => {
    calls += 1;
  });
  handler();
  handler();
  handler();
  assert.equal(calls, 1);
});
