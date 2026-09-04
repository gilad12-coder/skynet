import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluatorIdentity,
  evidenceStatus,
  stableStringify,
  type ValidationEvidence,
} from "./validation-evidence.ts";

const baseInput = {
  candidate: "hello",
  example: { b: 2, a: 1 },
  scorer: {
    kind: "python" as const,
    code: "def score(c, case=None): return 1",
    url: "",
    install: "",
  },
  scoringModel: null,
};

test("stableStringify sorts keys at every depth", () => {
  assert.equal(
    stableStringify({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] }),
    '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
  );
});

test("evaluatorIdentity is stable under key order and ignores remote fields for python scorers", () => {
  const a = evaluatorIdentity({ ...baseInput, scorer: { ...baseInput.scorer, secretRevision: 0 } });
  const b = evaluatorIdentity({
    ...baseInput,
    example: { a: 1, b: 2 },
    scorer: { ...baseInput.scorer, url: "https://ignored", secretRevision: 7 },
  });
  assert.equal(a, b);
});

test("evaluatorIdentity changes with the code, the example, the model and the secret revision", () => {
  const base = evaluatorIdentity({
    ...baseInput,
    scorer: { ...baseInput.scorer, secretRevision: 0 },
  });
  assert.notEqual(
    base,
    evaluatorIdentity({
      ...baseInput,
      scorer: { ...baseInput.scorer, code: "x", secretRevision: 0 },
    }),
  );
  assert.notEqual(
    base,
    evaluatorIdentity({
      ...baseInput,
      example: null,
      scorer: { ...baseInput.scorer, secretRevision: 0 },
    }),
  );
  assert.notEqual(
    base,
    evaluatorIdentity({
      ...baseInput,
      scoringModel: "m",
      scorer: { ...baseInput.scorer, secretRevision: 0 },
    }),
  );
  const remote = { kind: "remote" as const, code: "", url: "https://s", install: "" };
  assert.notEqual(
    evaluatorIdentity({ ...baseInput, scorer: { ...remote, secretRevision: 0 } }),
    evaluatorIdentity({ ...baseInput, scorer: { ...remote, secretRevision: 1 } }),
  );
});

test("evidenceStatus reports running, passed, failed, stale and idle", () => {
  const passed: ValidationEvidence = {
    identity: "a",
    ok: true,
    error: null,
    checkedAt: 1,
    modelName: null,
    creditsCharged: 0,
  };
  assert.equal(evidenceStatus(null, null, "a"), "idle");
  assert.equal(evidenceStatus(null, "a", "a"), "running");
  assert.equal(evidenceStatus(passed, null, "a"), "passed");
  assert.equal(evidenceStatus(passed, null, "b"), "stale");
  assert.equal(evidenceStatus({ ...passed, ok: false, error: "boom" }, null, "a"), "failed");
  assert.equal(evidenceStatus(passed, "b", "b"), "running");
});
