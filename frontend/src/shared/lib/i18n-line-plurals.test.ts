/** Line-count plurals show the real number when a plural form covers more than one count. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const localesDir = path.join(process.cwd(), "..", "i18n", "locales", "ui");
const keys = ["shared.code_editor.lines_count", "shared.code_editor.lines_hidden"];

function oneBranch(template: string): string | undefined {
  return /\bone \{([^}]*)\}/.exec(template)?.[1];
}

test("a `one` form that also covers counts other than 1 uses #", () => {
  const problems: string[] = [];
  for (const file of fs.readdirSync(localesDir).filter((name) => name.endsWith(".json"))) {
    const locale = path.basename(file, ".json");
    const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, file), "utf8")) as Record<string, unknown>;
    // ru and uk put 21 and 101 in `one`; fr, pt, hi and fa put 0 there.
    const rules = new Intl.PluralRules(locale);
    const sharesOne = Array.from({ length: 202 }, (_, n) => n).some((n) => n !== 1 && rules.select(n) === "one");
    if (!sharesOne) continue;
    for (const key of keys) {
      const template = catalog[key];
      if (typeof template !== "string") continue;
      const branch = oneBranch(template);
      if (branch !== undefined && !branch.includes("#")) problems.push(`${locale} ${key}: ${branch}`);
    }
  }
  assert.deepEqual(problems, []);
});
