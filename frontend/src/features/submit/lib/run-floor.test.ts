import assert from "node:assert/strict";
import { test } from "node:test";

const {
  DEFAULT_LIMIT_CENTS,
  RUN_SPARE_CENTS,
  aggregateTokenSource,
  callHoldKey,
  isSubscriptionModel,
  runFloor,
  startingLimitCents,
} = await import("./run-floor.ts");

test("the floor is the boxes' opening holds plus a dollar of spare", () => {
  const floor = runFloor({ boxHoldCents: 18.08, callHoldCents: [4.6, 0.3, null] });

  assert.equal(RUN_SPARE_CENTS, 100);
  assert.deepEqual(floor, { boxHoldCents: 19, spareCents: 100, floorCents: 119 });
});

test("a model whose one call holds more than the spare raises the spare to that hold", () => {
  assert.equal(runFloor({ boxHoldCents: 19, callHoldCents: [134.15] }).floorCents, 19 + 135);
});

test("unknown holds still leave the spare as the floor", () => {
  assert.equal(runFloor({ boxHoldCents: null, callHoldCents: [] }).floorCents, RUN_SPARE_CENTS);
});

test("a fresh budget starts at the default limit unless the floor or server minimum is higher", () => {
  assert.equal(startingLimitCents(119), DEFAULT_LIMIT_CENTS);
  assert.equal(startingLimitCents(812.4), 813);
  assert.equal(startingLimitCents(119, 640), 640);
});

test("a call hold is keyed by who pays for the model", () => {
  assert.notEqual(callHoldKey("m", "managed"), callHoldKey("m", "byok"));
});

test("the job is BYOK only when every named model is", () => {
  const model = (name: string, token_source: "managed" | "byok") =>
    ({ name, token_source }) as Parameters<typeof aggregateTokenSource>[0][number];
  assert.equal(aggregateTokenSource([model("a", "byok"), model("b", "byok")]), "byok");
  assert.equal(aggregateTokenSource([model("a", "byok"), model("b", "managed")]), "managed");
  assert.equal(aggregateTokenSource([model("", "managed"), model("a", "byok")]), "byok");
  assert.equal(aggregateTokenSource([]), "managed");
});

test("a subscription run holds nothing for its model calls, so its floor is $0", () => {
  const floor = runFloor({ boxHoldCents: 0, callHoldCents: [134.15], tokenSource: "subscription" });
  assert.deepEqual(floor, { boxHoldCents: 0, spareCents: 0, floorCents: 0 });
  // Only the server's own box hold, if any, remains.
  assert.equal(
    runFloor({ boxHoldCents: 18.08, callHoldCents: [], tokenSource: "subscription" }).floorCents,
    19,
  );
});

test("the job is a subscription job when no named model is managed and one runs on a CLI", () => {
  type Source = "managed" | "byok" | "subscription" | undefined;
  const model = (name: string, token_source: Source) =>
    ({
      name,
      token_source,
      cli_provider: token_source === "subscription" ? "claude" : undefined,
    }) as Parameters<typeof aggregateTokenSource>[0][number];
  assert.equal(aggregateTokenSource([model("a", "subscription")]), "subscription");
  assert.equal(
    aggregateTokenSource([model("a", "subscription"), model("b", "byok")]),
    "subscription",
  );
  assert.equal(
    aggregateTokenSource([model("a", "subscription"), model("b", "managed")]),
    "managed",
  );
  // A config saved before token sources existed counts as managed.
  assert.equal(
    aggregateTokenSource([model("a", "subscription"), model("b", undefined)]),
    "managed",
  );
  assert.equal(isSubscriptionModel(model("a", "subscription")), true);
  assert.equal(isSubscriptionModel(model("a", "byok")), false);
});
