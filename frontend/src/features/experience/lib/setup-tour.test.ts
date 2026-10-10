import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { INTAKE_LLM_PHASES } from "./intake.ts";
import { MAX_SETUP_STOPS, SETUP_STOPS } from "./setup-tour.ts";

const SRC = join(import.meta.dirname, "../../..");
const CATALOG_DIR = join(SRC, "../../i18n/locales/ui");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return /\.tsx$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

test("the setup stays short and every stop is unique", () => {
  assert.ok(SETUP_STOPS.length <= MAX_SETUP_STOPS);
  assert.equal(new Set(SETUP_STOPS.map((s) => s.id)).size, SETUP_STOPS.length);
});

test("the level comes first and every settings question is asked once", () => {
  assert.equal(SETUP_STOPS[0]!.question, "level");
  const asked = SETUP_STOPS.flatMap((s) => (s.question ? [s.question] : []));
  assert.deepEqual([...asked].sort(), ["level", ...INTAKE_LLM_PHASES].sort());
});

test("the last stop is the new-optimization entry finishing opens", () => {
  assert.equal(SETUP_STOPS[SETUP_STOPS.length - 1]!.anchor, "new-optimization");
});

test("every stop's anchor is on a real part of the app", () => {
  const code = sources(SRC).join("\n");
  for (const stop of SETUP_STOPS) {
    // The sidebar tags its nav entries through a `setupAnchor` prop.
    const tagged =
      code.includes(`data-setup="${stop.anchor}"`) ||
      new RegExp(`setupAnchor=\\{[^}]*"${stop.anchor}"`).test(code);
    assert.ok(tagged, `no data-setup="${stop.anchor}" in the app`);
  }
});

test("the privacy and email questions frame their real controls in Settings", () => {
  const tabs = readFileSync(join(SRC, "features/settings/lib/tabs.ts"), "utf8");
  const privacyTab = readFileSync(join(SRC, "features/settings/components/PrivacyTab.tsx"), "utf8");
  for (const question of ["privacy", "emails"] as const) {
    const stop = SETUP_STOPS.find((s) => s.question === question)!;
    assert.equal(stop.settings, "privacy", `${question}: opens the wrong Settings tab`);
    assert.ok(tabs.includes(`"${stop.settings}",`), `no Settings tab "${stop.settings}"`);
    assert.ok(
      privacyTab.includes(`data-setup="${stop.anchor}"`),
      `${question}: anchor "${stop.anchor}" is not on the Settings control`,
    );
  }
});

test("only stops about a Settings control open Settings", () => {
  for (const stop of SETUP_STOPS) {
    if (stop.settings) assert.ok(stop.question, `${stop.id}: opens Settings without a question`);
  }
});

test("every stop's copy exists in the base and English catalogs", () => {
  for (const locale of ["he", "en"]) {
    const catalog = JSON.parse(readFileSync(join(CATALOG_DIR, `${locale}.json`), "utf8"));
    for (const stop of SETUP_STOPS) {
      assert.ok(catalog[stop.title], `${locale}: missing ${stop.title}`);
      assert.ok(catalog[stop.body], `${locale}: missing ${stop.body}`);
    }
  }
});
