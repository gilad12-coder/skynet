import { test } from "node:test";
import assert from "node:assert/strict";

import type { NotificationItem } from "@/shared/lib/api";

import {
  CHANNELS,
  EVENT_TYPES,
  appendPage,
  cellEditable,
  cellExists,
  itemLine,
  mergeHead,
  type FactFormatters,
} from "./catalog.ts";

const fmt: FactFormatters = {
  score: (n) => n.toFixed(2),
  delta: (n) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2)),
  usd: (d) => `$${d}`,
  duration: (s) => `${s}s`,
};

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n1",
    event_type: "finished",
    optimization_id: "opt-1",
    title: "My run",
    facts: {},
    link: "/optimizations/opt-1",
    focused: true,
    urgent: false,
    created_at: "2026-10-01T10:00:00Z",
    read_at: null,
    ...over,
  };
}

test("product news only ever has an inbox cell, and it is locked on", () => {
  assert.deepEqual(
    CHANNELS.filter((c) => cellExists("product_news", c)),
    ["inbox"],
  );
  assert.equal(cellEditable("product_news", "inbox"), false);
});

test("run events can be edited on the live channels only", () => {
  for (const event of EVENT_TYPES.filter((e) => e !== "product_news")) {
    assert.equal(cellEditable(event, "inbox"), true);
    assert.equal(cellEditable(event, "email"), true);
    assert.equal(cellEditable(event, "chrome"), true);
    assert.equal(cellEditable(event, "slack"), false);
    assert.equal(cellEditable(event, "slack", true), true);
  }
});

test("a finished line carries the score and the delta", () => {
  assert.deepEqual(itemLine(item({ facts: { score: 0.8, delta: 0.12 } }), fmt), {
    key: "notifications.item.finished_delta",
    params: { score: "0.80", delta: "+0.12" },
  });
});

test("a missing number falls back to the plain wording", () => {
  assert.deepEqual(itemLine(item({ event_type: "failed" }), fmt), {
    key: "notifications.item.failed_plain",
    params: {},
  });
  assert.deepEqual(itemLine(item({ event_type: "budget_near", facts: { spent: 4 } }), fmt), {
    key: "notifications.item.budget_near_plain",
    params: {},
  });
});

test("urgent events show spend against the limit", () => {
  assert.deepEqual(
    itemLine(item({ event_type: "needs_input", facts: { spent: 4, limit: 5 } }), fmt),
    { key: "notifications.item.needs_input", params: { spent: "$4", limit: "$5" } },
  );
});

test("a share line names who shared and the kind of share", () => {
  assert.deepEqual(
    itemLine(item({ event_type: "shared", facts: { actor: "dana", kind: "role" } }), fmt),
    { key: "notifications.item.shared_role", params: { actor: "dana" } },
  );
});

test("news uses its headline as written", () => {
  assert.deepEqual(itemLine(item({ event_type: "product_news", title: "Inbox" }), fmt), {
    text: "Inbox",
  });
});

test("an older page never repeats items already shown", () => {
  const a = item({ id: "a" });
  const b = item({ id: "b" });
  assert.deepEqual(
    appendPage([a], [a, b]).map((i) => i.id),
    ["a", "b"],
  );
});

test("a refreshed head keeps older items loaded by scrolling", () => {
  const old = item({ id: "old", created_at: "2026-09-01T00:00:00Z" });
  const head = [
    item({ id: "new", created_at: "2026-10-02T00:00:00Z" }),
    item({ id: "mid", created_at: "2026-10-01T00:00:00Z" }),
  ];
  assert.deepEqual(
    mergeHead([head[1]!, old], head).map((i) => i.id),
    ["new", "mid", "old"],
  );
});
