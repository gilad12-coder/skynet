/** Contract: static files that cannot import the brand still spell the current name. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { APP_NAME } from "./generated/i18n-catalog.ts";

const brand = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "..", "i18n", "brand.json"), "utf8"),
) as { appName: string };

// The service worker is served as-is, so it holds a literal.
const STATIC_FILES = ["public/sw.js"];

test("the generated APP_NAME matches i18n/brand.json", () => {
  assert.equal(APP_NAME, brand.appName);
});

for (const file of STATIC_FILES) {
  test(`${file} names the app`, () => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(source.includes(APP_NAME), `${file} must contain "${APP_NAME}"; update it after a rename`);
  });
}
