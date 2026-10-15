import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const srcUrl = new URL("../../../", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: new URL(`${specifier.slice(2)}.ts`, srcUrl).href };
    }
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const { authoringToolRows } = await import("./code-authoring.ts");

const verifyCall = (
  id: string,
  startedAt: number,
  verification?: { ok: boolean; files: Array<{ path: string; ok: boolean; errors: string[] }> },
  status = "done",
) => ({ id, tool: "verify_code", status, startedAt, verification });

test("deletes and checks become rows, leaving out calls from before the tool started", () => {
  const messages = [
    {
      toolCalls: [
        verifyCall("v0", 6, { ok: false, files: [{ path: "run.py", ok: false, errors: ["earlier"] }] }),
        verifyCall("v1", 32, {
          ok: false,
          files: [
            { path: "run.py", ok: true, errors: [] },
            { path: "metric.py", ok: false, errors: ["must return a float"] },
          ],
        }),
        { id: "d1", tool: "delete_file", status: "done", startedAt: 36, path: "old.py" },
        verifyCall("v2", 40, { ok: true, files: [{ path: "metric.py", ok: true, errors: [] }] }),
      ],
    },
  ];
  const { deletes, checks } = authoringToolRows(messages, 10);
  assert.deepEqual(deletes, [{ file: "old.py", ts: 36 }]);
  assert.deepEqual(
    checks.map((c) => [c.id, c.state]),
    [
      ["v1", "failed"],
      ["v2", "passed"],
    ],
  );
  assert.deepEqual(checks[0]?.failures, [{ path: "metric.py", errors: ["must return a float"] }]);
});

test("a check still running shows as running; an errored one with no result has failed", () => {
  const running = authoringToolRows([{ toolCalls: [verifyCall("v9", 50, undefined, "running")] }], 0);
  assert.deepEqual(running.checks, [{ id: "v9", ts: 50, state: "running", failures: [] }]);
  const errored = authoringToolRows([{ toolCalls: [verifyCall("v8", 50, undefined, "error")] }], 0);
  assert.deepEqual(errored.checks, [{ id: "v8", ts: 50, state: "failed", failures: [] }]);
});
