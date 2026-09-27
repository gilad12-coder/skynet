import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// API routes that must stay behind login. Every other ``src/app/api`` route is
// hit by logged-out visitors and must be excluded from the proxy matcher, or
// its POSTs bounce to /login and the flow silently never completes.
const GATED_API = new Set<string>([]);

test("every API route is either excluded from the auth matcher or explicitly gated", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "proxy.ts"), "utf8");
  const excluded = new Set(
    [...source.matchAll(/api\/([\w-]+)(?=[|)])/g)].map((m) => m[1]),
  );
  const routes = fs
    .readdirSync(path.join(process.cwd(), "src", "app", "api"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const unaccounted = routes.filter((name) => !excluded.has(name) && !GATED_API.has(name));
  assert.deepEqual(unaccounted, []);
});
