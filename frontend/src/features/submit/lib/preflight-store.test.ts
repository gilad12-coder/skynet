import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionBudget } from "../../../shared/types/execution-budget.ts";
import type {
  WizardPreflightPayload,
  WizardPreflightRequest,
  WizardPreflightResponse,
} from "../../../shared/types/wizard-preflight.ts";
import { reusableSuccessfulPreflight } from "./preflight-outcome.ts";
import { PreflightStore, type PreflightBudgetSession } from "./preflight-store.ts";
import { preflightIdentity } from "./validation-evidence.ts";
import { waitForPreflightUsage } from "./wait-for-preflight-usage.ts";

const budget = (id = "budget", pending = 0) =>
  ({ id, revision: 1, pending_operations: pending }) as ExecutionBudget;

const payload = { name: "run", workflow_spec: { kind: "x" } } as unknown as WizardPreflightPayload;

const succeeded = (b = budget()): WizardPreflightResponse =>
  ({
    id: "evidence",
    fingerprint: "f",
    status: "succeeded",
    may_advance: true,
    checks: [],
    budget: b,
  }) as WizardPreflightResponse;

const session = (id = "budget"): PreflightBudgetSession & { adopted: ExecutionBudget[] } => {
  const adopted: ExecutionBudget[] = [];
  return {
    draft: { executionBudgetRef: { id, revision: 1 } },
    adopted,
    ensure: async () => budget(id),
    adopt: async (b) => {
      adopted.push(b);
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const immediate = async () => {};

function build(
  preflight: (
    request: WizardPreflightRequest,
    signal: AbortSignal,
    onPhase: (phase: string) => void,
  ) => Promise<WizardPreflightResponse>,
  getBudget: (id: string) => Promise<ExecutionBudget> = async (id) => budget(id),
) {
  let clock = 1000;
  const store = new PreflightStore({
    preflight,
    getBudget,
    translate: (key) => `t:${key}`,
    identity: preflightIdentity,
    reusable: reusableSuccessfulPreflight,
    settleUsage: waitForPreflightUsage,
    now: () => (clock += 1),
    wait: immediate,
  });
  return store;
}

test("concurrent runs for the same inputs share one request and one evidence", async () => {
  const gate = deferred<WizardPreflightResponse>();
  let calls = 0;
  const store = build(() => {
    calls += 1;
    return gate.promise;
  });
  const s = session();
  store.attach("anything", s);

  const first = store.run("anything", "evaluation", payload, s);
  const second = store.run("anything", "evaluation", payload, s);
  await immediate();
  assert.equal(calls, 1);
  assert.equal(store.getState("anything").progress?.status, "running");
  assert.equal(store.getState("anything").running.evaluation !== undefined, true);

  gate.resolve(succeeded());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(store.getState("anything").progress?.status, "succeeded");
  assert.equal(store.getState("anything").running.evaluation, undefined);
  assert.equal(store.getState("anything").evidence.evaluation?.response, a);
  assert.equal(s.adopted.length, 2);
});

test("evidence outlives the wizard and is reused for the same budget only", async () => {
  let calls = 0;
  const store = build(async () => {
    calls += 1;
    return succeeded();
  });
  const s = session();
  store.attach("dspy", s);
  await store.run("dspy", "execution", payload, s);
  store.detach("dspy", s);

  const identity = store.getState("dspy").evidence.execution!.identity;
  assert.ok(store.reusable("dspy", "execution", identity, "budget"));
  assert.equal(store.reusable("dspy", "execution", identity, "other"), null);
  assert.equal(store.reusable("dspy", "execution", identity, undefined), null);

  const again = session();
  await store.run("dspy", "execution", payload, again);
  assert.equal(calls, 1);
  await store.run("dspy", "execution", payload, session("other"));
  assert.equal(calls, 2);
});

test("the progress timeline moves through phases and finishes once", () => {
  const store = build(async () => succeeded());
  const owner = {};
  store.start("anything", { scope: "evaluation", identity: "a", owner });
  store.phase("anything", "dependencies");
  store.phase("anything", "dependencies");
  store.phase("anything", "budget");
  store.phase("anything", "sandbox");

  const running = store.getState("anything").progress!;
  assert.deepEqual(
    running.phases.map((phase) => phase.key),
    ["budget", "dependencies", "sandbox"],
  );
  assert.equal(running.phases[0]!.finishedAt !== undefined, true);
  assert.equal(running.phases[2]!.finishedAt, undefined);

  store.start("anything", { scope: "evaluation", identity: "a", owner: {} });
  assert.equal(store.getState("anything").progress, running);
  store.start("anything", { scope: "execution", identity: "b", owner });
  assert.equal(store.getState("anything").progress?.identity, "b");

  store.finish("anything", "failed", "boom");
  store.finish("anything", "succeeded");
  const finished = store.getState("anything").progress!;
  assert.equal(finished.status, "failed");
  assert.equal(finished.message, "boom");
  assert.equal(
    finished.phases.every((phase) => phase.finishedAt !== undefined),
    true,
  );

  store.clear("anything");
  assert.equal(store.getState("anything").progress, null);
  store.phase("anything", "usage");
  assert.equal(store.getState("anything").progress, null);
});

test("cancel aborts the run and drops its progress instead of failing it", async () => {
  const store = build(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const s = session();
  store.attach("anything", s);
  const run = store.run("anything", "evaluation", payload, s);
  await immediate();
  store.cancel("anything");
  await assert.rejects(run, (error: Error) => error.name === "AbortError");
  assert.equal(store.getState("anything").progress, null);
  assert.equal(store.getState("anything").error, null);
  assert.equal(store.getState("anything").running.evaluation, undefined);
});

test("a failure is translated, recorded and shown as a failed timeline", async () => {
  const store = build(async () => {
    throw new Error("budget.insufficient");
  });
  const s = session();
  store.attach("dspy", s);
  await assert.rejects(store.run("dspy", "execution", payload, s));
  const state = store.getState("dspy");
  assert.equal(state.error, "t:budget.insufficient");
  assert.equal(state.progress?.status, "failed");
  assert.equal(state.progress?.message, "t:budget.insufficient");
  assert.equal(state.evidence.execution, undefined);
});

test("a run pending on usage polls the budget and resumes once it settles", async () => {
  const responses: WizardPreflightResponse[] = [
    {
      ...succeeded(budget("budget", 1)),
      status: "pending",
      may_advance: false,
      pending_reason: { category: "usage_reconciliation", message: "wait" },
    },
    succeeded(),
  ];
  const polled: string[] = [];
  const store = build(
    async (_request, _signal, onPhase) => {
      onPhase("budget");
      onPhase("evaluator");
      return responses.shift()!;
    },
    async (id) => {
      polled.push(id);
      return budget(id, polled.length > 1 ? 0 : 1);
    },
  );
  const s = session();
  store.attach("anything", s);
  const response = await store.run("anything", "evaluation", payload, s);
  assert.equal(response.status, "succeeded");
  assert.deepEqual(polled, ["budget", "budget"]);
  const progress = store.getState("anything").progress!;
  assert.equal(progress.status, "succeeded");
  assert.deepEqual(
    progress.phases.map((phase) => phase.key),
    ["budget", "evaluator", "usage", "evaluator"],
  );
  assert.equal(store.getState("anything").evidence.evaluation?.response, response);
});

test("listeners hear every change and the snapshot is stable in between", async () => {
  const store = build(async () => succeeded());
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  const before = store.getState("anything");
  assert.equal(store.getState("anything"), before);
  const s = session();
  await store.run("anything", "evaluation", payload, s);
  assert.ok(notified > 0);
  const after = store.getState("anything");
  assert.notEqual(after, before);
  unsubscribe();
  const count = notified;
  store.clear("anything");
  assert.equal(notified, count);
});
