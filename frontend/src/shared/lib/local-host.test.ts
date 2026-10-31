import { test } from "node:test";
import assert from "node:assert/strict";
import { isRefusedLocalHost } from "./local-host.ts";

const desktop = { APP_LOCAL_MODE: "1", AUTH_URL: "http://127.0.0.1:48120" };

test("hosted builds refuse no host", () => {
  assert.equal(isRefusedLocalHost("evil.example", {}), false);
  assert.equal(isRefusedLocalHost(null, { AUTH_URL: "https://staging.skynetml.com" }), false);
});

test("local mode serves the AUTH_URL host and the loopback names on its port", () => {
  for (const host of ["127.0.0.1:48120", "localhost:48120", "LOCALHOST:48120"]) {
    assert.equal(isRefusedLocalHost(host, desktop), false, host);
  }
});

test("local mode refuses a rebound or foreign host", () => {
  for (const host of [
    "evil.example:48120",
    "evil.example",
    "127.0.0.1.evil.example:48120",
    "127.0.0.1:48121",
    "127.0.0.1",
    "user@127.0.0.1:48120",
    "127.0.0.1:48120/x",
    "[::1]:48120",
    "",
    null,
  ]) {
    assert.equal(isRefusedLocalHost(host, desktop), true, String(host));
  }
});

test("local dev without AUTH_URL serves the loopback names on any port", () => {
  const dev = { APP_LOCAL_MODE: "1" };
  assert.equal(isRefusedLocalHost("localhost:3000", dev), false);
  assert.equal(isRefusedLocalHost("127.0.0.1:3002", dev), false);
  assert.equal(isRefusedLocalHost("evil.example:3000", dev), true);
});
