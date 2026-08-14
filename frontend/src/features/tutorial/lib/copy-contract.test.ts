import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const TITLE_KEYS = [
  "auto.features.tutorial.lib.steps.template.24",
  "auto.features.tutorial.lib.steps.template.27",
] as const;

test("tutorial titles are complete localized phrases", () => {
  const localeDir = path.join(process.cwd(), "..", "i18n", "locales", "ui");
  const catalogs = fs
    .readdirSync(localeDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      messages: JSON.parse(fs.readFileSync(path.join(localeDir, name), "utf8")) as Record<
        string,
        string
      >,
    }));

  for (const { name, messages } of catalogs) {
    for (const key of TITLE_KEYS) {
      const value = messages[key];
      if (value === undefined) continue;
      assert.doesNotMatch(value, /\{p\d+\}/, `${name}:${key} must be a complete phrase`);
    }
  }

  const english = catalogs.find(({ name }) => name === "en.json")?.messages;
  assert.equal(english?.[TITLE_KEYS[0]], "Choosing models");
  assert.equal(english?.[TITLE_KEYS[1]], "Submitting an optimization");
});

test("tutorial title call sites do not compose grammar from term placeholders", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "features", "tutorial", "lib", "steps.ts"),
    "utf8",
  );

  for (const key of TITLE_KEYS) {
    assert.match(source, new RegExp(`title: msg\\("${key.replaceAll(".", "\\.")}"\\)`));
    assert.doesNotMatch(source, new RegExp(`title: formatMsg\\("${key.replaceAll(".", "\\.")}"`));
  }
});
