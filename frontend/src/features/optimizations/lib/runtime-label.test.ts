import assert from "node:assert/strict";
import test from "node:test";

import { runtimeLabelKey } from "./runtime-label.ts";

test("the cloud runtime shows the Skynet infrastructure label", () => {
  assert.equal(runtimeLabelKey("vercel"), "submit.runtime.vercel");
});

test("the local Docker runtime shows a translated label, not its raw id", () => {
  assert.equal(runtimeLabelKey("docker"), "submit.runtime.docker");
});

test("an unknown runtime has no label key", () => {
  assert.equal(runtimeLabelKey("something-new"), null);
});
