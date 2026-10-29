import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OptimizationLogEntry } from "../../../shared/types/api.ts";
import { maxLogId, mergeLiveLogs, pruneLiveLogs } from "./run-log-merge.ts";

const row = (id: number | null): OptimizationLogEntry => ({
  id,
  timestamp: "2026-10-05T00:00:00Z",
  level: "INFO",
  logger: "test",
  message: `line ${id}`,
});

describe("maxLogId", () => {
  it("returns the highest id and null when none carries one", () => {
    assert.equal(maxLogId([row(3), row(9), row(null), row(5)]), 9);
    assert.equal(maxLogId([row(null)]), null);
    assert.equal(maxLogId(undefined), null);
  });
});

describe("mergeLiveLogs", () => {
  it("appends streamed rows the fetched log does not hold", () => {
    const fetched = [row(1), row(2)];
    const merged = mergeLiveLogs(fetched, [row(2), row(3)]);
    assert.deepEqual(
      merged.map((l) => l.id),
      [1, 2, 3],
    );
  });

  it("returns the fetched array itself when the stream adds nothing new", () => {
    const fetched = [row(1), row(2)];
    assert.equal(mergeLiveLogs(fetched, []), fetched);
    assert.equal(mergeLiveLogs(fetched, [row(2)]), fetched);
  });
});

describe("pruneLiveLogs", () => {
  it("drops streamed rows a newer fetch already covers", () => {
    assert.deepEqual(
      pruneLiveLogs([row(1), row(4)], [row(3), row(4), row(5)]).map((l) => l.id),
      [5],
    );
  });

  it("keeps everything when the fetched log has no ids", () => {
    const live = [row(3)];
    assert.equal(pruneLiveLogs([row(null)], live), live);
  });
});
