import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionBudget } from "../../../shared/types/execution-budget.ts";
import type {
  PreflightScope,
  WizardPreflightPayload,
  WizardPreflightRequest,
  WizardPreflightResponse,
} from "../../../shared/types/wizard-preflight.ts";
import {
  reusableSuccessfulPreflight,
  reusableTerminalPreflight,
  type StoredPreflightEvidence,
} from "./preflight-outcome.ts";
import {
  PreflightStore,
  type PreflightBudgetSession,
} from "./preflight-store.ts";
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

const failed = (b = budget()): WizardPreflightResponse =>
  ({
    id: "evidence",
    fingerprint: "f",
    status: "failed",
    may_advance: false,
    checks: [{ key: "setup", status: "failed", message: "bad setup" }],
    budget: b,
  }) as WizardPreflightResponse;

type RecordedEvidence = { scope: PreflightScope; evidence: StoredPreflightEvidence };
const session = (
  id = "budget",
): PreflightBudgetSession & { adopted: ExecutionBudget[]; recorded: RecordedEvidence[] } => {
  const adopted: ExecutionBudget[] = [];
  const recorded: RecordedEvidence[] = [];
  return {
    draft: { executionBudgetRef: { id, revision: 1 } },
    adopted,
    recorded,
    ensure: async () => budget(id),
    adopt: async (b) => {
      adopted.push(b);
    },
    recordEvidence: async (scope, evidence) => {
      recorded.push({ scope, evidence });
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
    reusableTerminal: reusableTerminalPreflight,
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
  store.attach("unified", s);

  const first = store.run("unified", "evaluation", payload, s);
  const second = store.run("unified", "evaluation", payload, s);
  await immediate();
  assert.equal(calls, 1);
  assert.equal(store.getState("unified").progress?.status, "running");
  assert.equal(store.getState("unified").running.evaluation !== undefined, true);

  gate.resolve(succeeded());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(store.getState("unified").progress?.status, "succeeded");
  assert.equal(store.getState("unified").running.evaluation, undefined);
  assert.equal(store.getState("unified").evidence.evaluation?.response, a);
  assert.equal(s.adopted.length, 2);
});

test("evidence outlives the wizard and is reused for the same budget only", async () => {
  let calls = 0;
  const store = build(async () => {
    calls += 1;
    return succeeded();
  });
  const s = session();
  store.attach("unified", s);
  await store.run("unified", "execution", payload, s);
  store.detach("unified", s);

  const identity = store.getState("unified").evidence.execution!.identity;
  assert.ok(store.reusable("unified", "execution", identity, "budget"));
  assert.equal(store.reusable("unified", "execution", identity, "other"), null);
  assert.equal(store.reusable("unified", "execution", identity, undefined), null);

  const again = session();
  await store.run("unified", "execution", payload, again);
  assert.equal(calls, 1);
  await store.run("unified", "execution", payload, session("other"));
  assert.equal(calls, 2);
});

test("a confirmed failure is served from evidence instead of being re-checked", async () => {
  let calls = 0;
  const store = build(async () => {
    calls += 1;
    return failed();
  });
  const s = session();
  store.attach("unified", s);

  const first = await store.run("unified", "evaluation", payload, s);
  assert.equal(first.status, "failed");
  assert.equal(calls, 1);

  const identity = store.getState("unified").evidence.evaluation!.identity;
  // A failure blocks advancing, so it is never offered as a reusable pass...
  assert.equal(store.reusable("unified", "evaluation", identity, "budget"), null);

  // ...but the same config comes straight from evidence, not a second check.
  const again = await store.run("unified", "evaluation", payload, s);
  assert.equal(again, first);
  assert.equal(calls, 1);

  // A new budget cannot claim the old evidence and checks afresh.
  await store.run("unified", "evaluation", payload, session("other"));
  assert.equal(calls, 2);
});

test("a passed check is carried to the draft; a failure is not", async () => {
  let outcome = succeeded();
  const store = build(async () => outcome);

  const pass = session();
  await store.run("unified", "execution", payload, pass);
  assert.equal(pass.recorded.length, 1);
  assert.equal(pass.recorded[0].scope, "execution");
  assert.equal(pass.recorded[0].evidence.response.status, "succeeded");

  outcome = failed();
  const fail = session();
  await store.run("unified", "evaluation", payload, fail);
  assert.equal(fail.recorded.length, 0);
});

test("seeded evidence rehydrates a pass and is reused without a check", async () => {
  let calls = 0;
  const store = build(async () => {
    calls += 1;
    return succeeded();
  });
  const identity = preflightIdentity("unified", payload);
  store.seed("unified", { execution: { identity, response: succeeded() } });
  assert.ok(store.reusable("unified", "execution", identity, "budget"));

  const response = await store.run("unified", "execution", payload, session());
  assert.equal(response.status, "succeeded");
  assert.equal(calls, 0);
});

test("seed keeps a fresher in-session pass and fills only empty scopes", async () => {
  const store = build(async () => succeeded());
  await store.run("unified", "execution", payload, session());
  const live = store.getState("unified").evidence.execution!;

  store.seed("unified", {
    execution: { identity: "stale", response: succeeded() },
    evaluation: { identity: "seeded", response: succeeded() },
  });

  assert.equal(store.getState("unified").evidence.execution, live);
  assert.equal(store.getState("unified").evidence.evaluation!.identity, "seeded");
});

test("the progress timeline moves through phases and finishes once", () => {
  const store = build(async () => succeeded());
  const owner = {};
  store.start("unified", { scope: "evaluation", identity: "a", owner });
  store.phase("unified", "dependencies");
  store.phase("unified", "dependencies");
  store.phase("unified", "budget");
  store.phase("unified", "sandbox");

  const running = store.getState("unified").progress!;
  assert.deepEqual(
    running.phases.map((phase) => phase.key),
    ["budget", "dependencies", "sandbox"],
  );
  assert.equal(running.phases[0]!.finishedAt !== undefined, true);
  assert.equal(running.phases[2]!.finishedAt, undefined);

  store.start("unified", { scope: "evaluation", identity: "a", owner: {} });
  assert.equal(store.getState("unified").progress, running);
  store.start("unified", { scope: "execution", identity: "b", owner });
  assert.equal(store.getState("unified").progress?.identity, "b");

  store.finish("unified", "failed", "boom");
  store.finish("unified", "succeeded");
  const finished = store.getState("unified").progress!;
  assert.equal(finished.status, "failed");
  assert.equal(finished.message, "boom");
  assert.equal(
    finished.phases.every((phase) => phase.finishedAt !== undefined),
    true,
  );

  store.clear("unified");
  assert.equal(store.getState("unified").progress, null);
  store.phase("unified", "usage");
  assert.equal(store.getState("unified").progress, null);
});

test("a passed check that leaves the screen stays with its scope until the next one starts", () => {
  const store = build(async () => succeeded());
  const owner = {};
  store.start("unified", { scope: "evaluation", identity: "a", owner });
  store.finish("unified", "succeeded", undefined, succeeded());
  store.clear("unified");
  let state = store.getState("unified");
  assert.equal(state.progress, null);
  assert.equal(state.completed.evaluation?.identity, "a");
  assert.equal(state.completed.evaluation?.status, "succeeded");

  store.start("unified", { scope: "execution", identity: "a", owner });
  store.finish("unified", "failed", "boom");
  store.clear("unified");
  state = store.getState("unified");
  assert.equal(state.completed.execution, undefined);
  assert.equal(state.completed.evaluation?.identity, "a");

  store.start("unified", { scope: "evaluation", identity: "b", owner });
  assert.equal(store.getState("unified").completed.evaluation, undefined);
});

test("cancel aborts the run and drops its progress instead of failing it", async () => {
  const store = build(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const s = session();
  store.attach("unified", s);
  const run = store.run("unified", "evaluation", payload, s);
  await immediate();
  store.cancel("unified");
  await assert.rejects(run, (error: Error) => error.name === "AbortError");
  assert.equal(store.getState("unified").progress, null);
  assert.equal(store.getState("unified").error, null);
  assert.equal(store.getState("unified").running.evaluation, undefined);
});

test("a failure is translated, recorded and shown as a failed timeline", async () => {
  const store = build(async () => {
    throw new Error("budget.insufficient");
  });
  const s = session();
  store.attach("unified", s);
  await assert.rejects(store.run("unified", "execution", payload, s));
  const state = store.getState("unified");
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
  store.attach("unified", s);
  const response = await store.run("unified", "evaluation", payload, s);
  assert.equal(response.status, "succeeded");
  assert.deepEqual(polled, ["budget", "budget"]);
  const progress = store.getState("unified").progress!;
  assert.equal(progress.status, "succeeded");
  assert.deepEqual(
    progress.phases.map((phase) => phase.key),
    ["budget", "evaluator", "usage", "evaluator"],
  );
  assert.equal(progress.workflow, "unified");
  assert.equal(progress.usage?.attempts, 2);
  assert.equal(progress.usage?.pendingOperations, 0);
  assert.equal(store.getState("unified").evidence.evaluation?.response, response);
});

test("listeners hear every change and the snapshot is stable in between", async () => {
  const store = build(async () => succeeded());
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  const before = store.getState("unified");
  assert.equal(store.getState("unified"), before);
  const s = session();
  await store.run("unified", "evaluation", payload, s);
  assert.ok(notified > 0);
  const after = store.getState("unified");
  assert.notEqual(after, before);
  unsubscribe();
  const count = notified;
  store.clear("unified");
  assert.equal(notified, count);
});

