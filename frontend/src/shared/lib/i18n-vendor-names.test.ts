/** User-visible copy never names the vendor behind Skynet's cloud sandbox. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(process.cwd(), "..");
const catalogRoot = path.join(repoRoot, "i18n", "locales");
const forbidden = /vercel/i;

function jsonFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function leakedStrings(value: unknown, at: string): string[] {
  if (typeof value === "string") return forbidden.test(value) ? [at] : [];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leakedStrings(child, `${at}:${key}`));
  }
  return [];
}

test("no UI locale value names the sandbox vendor", () => {
  const files = jsonFiles(path.join(catalogRoot, "ui"));
  assert.ok(files.length >= 24, `expected every UI locale catalog, found ${files.length}`);
  const leaks = files.flatMap((file) =>
    leakedStrings(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file)),
  );
  assert.deepEqual(leaks, []);
});

test("no backend locale message names the sandbox vendor", () => {
  const files = [
    ...jsonFiles(catalogRoot),
    ...jsonFiles(path.join(repoRoot, "backend", "core", "i18n_locales")),
  ];
  const leaks = files.flatMap((file) =>
    leakedStrings(JSON.parse(fs.readFileSync(file, "utf8")), path.relative(repoRoot, file)),
  );
  assert.deepEqual(leaks, []);
});

test("the generated catalogs do not name the sandbox vendor in any value", () => {
  const generated = path.join(process.cwd(), "src", "shared", "lib", "generated");
  for (const name of ["ui-catalog.ts", "i18n-catalog.ts"]) {
    const source = fs.readFileSync(path.join(generated, name), "utf8");
    // Keys such as "submit.runtime.vercel" are runtime ids, not copy, so only
    // the quoted value after each key's colon is checked.
    const leaks = [...source.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)]
      .filter(([, , value]) => forbidden.test(value))
      .map(([, key]) => key);
    assert.deepEqual(leaks, [], `${name} has vendor names in: ${leaks.join(", ")}`);
  }
});
