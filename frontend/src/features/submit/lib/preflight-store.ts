/**
 * Preflight runs and their progress, kept outside the wizard tree.
 *
 * A validation is started from the wizard but does not belong to it: the
 * user may leave the page while it runs and come back through the draft
 * offer, and the run has to be exactly where it was, with its evidence
 * ready when it finishes. So the runs, the per-scope evidence and the
 * progress timeline live here, per workflow, for the life of the page.
 *
 * The runtime pieces (the preflight request, the budget fetch, translation)
 * and the sibling lib helpers are injected: node tests run this module as
 * a leaf, and relative runtime imports would need extensions tsc rejects.
 */
import type { ExecutionBudget } from "@/shared/types/execution-budget";
import type {
  PreflightScope,
  WizardPreflightPayload,
  WizardPreflightRequest,
  WizardPreflightResponse,
} from "@/shared/types/wizard-preflight";
import type { reusableSuccessfulPreflight, StoredPreflightEvidence } from "./preflight-outcome";
import type { preflightIdentity } from "./validation-evidence";
import type { waitForPreflightUsage } from "./wait-for-preflight-usage";

export type PreflightWorkflow = "anything" | "dspy";

export type ValidationPhase =
  | "budget"
  | "dependencies"
  | "sandbox"
  | "evaluator"
  | "models"
  | "usage";

export type ValidationStatus = "running" | "succeeded" | "failed" | "pending";

export interface ValidationPhaseProgress {
  key: ValidationPhase;
  startedAt: number;
  finishedAt?: number;
}

/** What the usage wait has seen so far: budget reads, and what the last one said. */
export interface ValidationUsageWait {
  attempts: number;
  pendingOperations: number;
  checkedAt: number;
}

export interface ValidationProgress {
  workflow: PreflightWorkflow;
  scope: PreflightScope;
  /** Identity of the payload under check; a restored draft joins by matching it. */
  identity: string;
  /** The wizard instance that started it, so the same instance shows it whatever the identity. */
  owner: unknown;
  status: ValidationStatus;
  startedAt: number;
  finishedAt?: number;
  phases: ValidationPhaseProgress[];
  usage?: ValidationUsageWait;
  response?: WizardPreflightResponse;
  message?: string;
}

export interface PreflightWorkflowState {
  evidence: Partial<Record<PreflightScope, StoredPreflightEvidence>>;
  running: Partial<Record<PreflightScope, string>>;
  progress: ValidationProgress | null;
  error: string | null;
}

/** The part of the wizard's budget session a run needs. */
export interface PreflightBudgetSession {
  readonly draft: { executionBudgetRef?: { id: string; revision: number } };
  ensure(): Promise<ExecutionBudget>;
  adopt(budget: ExecutionBudget): Promise<void>;
}

export interface PreflightStoreDependencies {
  preflight(
    request: WizardPreflightRequest,
    signal: AbortSignal,
    onPhase: (phase: string) => void,
  ): Promise<WizardPreflightResponse>;
  getBudget(id: string, signal: AbortSignal): Promise<ExecutionBudget>;
  translate(key: string): string;
  identity: typeof preflightIdentity;
  reusable: typeof reusableSuccessfulPreflight;
  settleUsage: typeof waitForPreflightUsage;
  now?: () => number;
  wait?: (signal?: AbortSignal) => Promise<void>;
}

const SERVER_PHASES: ReadonlySet<string> = new Set([
  "budget",
  "sandbox",
  "evaluator",
  "models",
  "usage",
]);

const EMPTY: PreflightWorkflowState = { evidence: {}, running: {}, progress: null, error: null };

interface Run {
  promise: Promise<WizardPreflightResponse>;
  controller: AbortController;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class PreflightStore {
  private readonly states = new Map<PreflightWorkflow, PreflightWorkflowState>();
  private readonly listeners = new Set<() => void>();
  private readonly runs = new Map<string, Run>();
  private readonly attached = new Map<PreflightWorkflow, PreflightBudgetSession>();
  private readonly deps: PreflightStoreDependencies;

  constructor(deps: PreflightStoreDependencies) {
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState(workflow: PreflightWorkflow): PreflightWorkflowState {
    return this.states.get(workflow) ?? EMPTY;
  }

  /** The mounted wizard's budget session, the one a finished run hands its budget to. */
  attach(workflow: PreflightWorkflow, session: PreflightBudgetSession): void {
    this.attached.set(workflow, session);
  }

  detach(workflow: PreflightWorkflow, session: PreflightBudgetSession): void {
    if (this.attached.get(workflow) === session) this.attached.delete(workflow);
  }

  reusable(
    workflow: PreflightWorkflow,
    scope: PreflightScope,
    identity: string,
    budgetId: string | undefined,
  ): WizardPreflightResponse | null {
    const response = this.deps.reusable(this.getState(workflow).evidence, scope, identity);
    // Evidence is claimed against one budget; a new budget needs its own.
    return response && budgetId && response.budget.id === budgetId ? response : null;
  }

  run(
    workflow: PreflightWorkflow,
    scope: PreflightScope,
    payload: WizardPreflightPayload,
    session: PreflightBudgetSession,
  ): Promise<WizardPreflightResponse> {
    const identity = this.deps.identity(workflow, payload);
    const completed = this.reusable(
      workflow,
      scope,
      identity,
      session.draft.executionBudgetRef?.id,
    );
    if (completed) return Promise.resolve(completed);

    const key = `${workflow}:${scope}:${identity}`;
    const inFlight = this.runs.get(key);
    if (inFlight) return inFlight.promise;

    const controller = new AbortController();
    const { signal } = controller;
    this.start(workflow, { scope, identity, owner: session });
    this.update(workflow, (state) => ({
      ...state,
      running: { ...state.running, [scope]: identity },
      error: null,
      evidence:
        state.evidence[scope]?.identity === identity
          ? { ...state.evidence, [scope]: undefined }
          : state.evidence,
    }));

    const onPhase = (phase: string) => {
      if (!signal.aborted && SERVER_PHASES.has(phase))
        this.phase(workflow, phase as ValidationPhase);
    };
    const request = (budget: ExecutionBudget): WizardPreflightRequest => ({
      scope,
      workflow,
      payload,
      execution_budget_id: budget.id,
      execution_budget_revision: budget.revision,
    });

    const promise = (async () => {
      const budget = await session.ensure();
      signal.throwIfAborted();
      let response = await this.deps.preflight(request(budget), signal, onPhase);
      signal.throwIfAborted();
      await this.adopt(workflow, response.budget);
      this.result(workflow, response);
      if (response.pending_reason?.category === "usage_reconciliation")
        this.phase(workflow, "usage");
      response = await this.deps.settleUsage(
        response,
        () => this.deps.getBudget(budget.id, signal),
        (settled) => this.deps.preflight(request(settled), signal, onPhase),
        signal,
        this.deps.wait,
        (attempt, read) => this.poll(workflow, attempt, read.pending_operations),
      );
      await this.adopt(workflow, response.budget);
      this.update(workflow, (state) => ({
        ...state,
        evidence: { ...state.evidence, [scope]: { identity, response } },
      }));
      this.finish(workflow, response.status, undefined, response);
      return response;
    })();

    const settled = promise
      .catch((failure: unknown) => {
        if (isAbortError(failure)) {
          this.abandon(workflow, scope, identity);
        } else {
          const raw = failure instanceof Error ? failure.message : String(failure);
          const message = raw.startsWith("budget.") ? this.deps.translate(raw) : raw;
          this.update(workflow, (state) => ({ ...state, error: message }));
          this.finish(workflow, "failed", message);
        }
        throw failure;
      })
      .finally(() => {
        this.runs.delete(key);
        this.update(workflow, (state) =>
          state.running[scope] === identity
            ? { ...state, running: { ...state.running, [scope]: undefined } }
            : state,
        );
      });
    this.runs.set(key, { promise: settled, controller });
    return settled;
  }

  /** Abort the workflow's in-flight runs; their progress is dropped, not failed. */
  cancel(workflow: PreflightWorkflow): void {
    for (const [key, run] of this.runs) {
      if (key.startsWith(`${workflow}:`)) run.controller.abort();
    }
  }

  start(
    workflow: PreflightWorkflow,
    details: { scope: PreflightScope; identity: string; owner: unknown },
  ): void {
    const progress = this.getState(workflow).progress;
    if (progress?.status === "running") {
      // A run started before this one is the timeline; it only learns the
      // identity of the payload actually sent, so a restored draft can join it.
      if (progress.owner === details.owner && progress.identity !== details.identity) {
        this.update(workflow, (state) => ({
          ...state,
          progress: { ...progress, identity: details.identity, scope: details.scope },
        }));
      }
      return;
    }
    const now = this.now();
    this.update(workflow, (state) => ({
      ...state,
      progress: {
        ...details,
        workflow,
        status: "running",
        startedAt: now,
        phases: [{ key: "budget", startedAt: now }],
      },
    }));
  }

  phase(workflow: PreflightWorkflow, key: ValidationPhase): void {
    const progress = this.getState(workflow).progress;
    if (progress?.status !== "running") return;
    const last = progress.phases[progress.phases.length - 1];
    if (last?.key === key || (key === "budget" && progress.phases.length > 0)) return;
    const now = this.now();
    this.update(workflow, (state) => ({
      ...state,
      progress: {
        ...progress,
        phases: [
          ...progress.phases.map((phase) =>
            phase.finishedAt === undefined ? { ...phase, finishedAt: now } : phase,
          ),
          { key, startedAt: now },
        ],
      },
    }));
  }

  /** One more read of the budget while usage settles; the frame shows the count and countdown. */
  poll(workflow: PreflightWorkflow, attempts: number, pendingOperations: number): void {
    const progress = this.getState(workflow).progress;
    if (progress?.status !== "running") return;
    this.update(workflow, (state) => ({
      ...state,
      progress: { ...progress, usage: { attempts, pendingOperations, checkedAt: this.now() } },
    }));
  }

  finish(
    workflow: PreflightWorkflow,
    status: Exclude<ValidationStatus, "running">,
    message?: string,
    response?: WizardPreflightResponse,
  ): void {
    const progress = this.getState(workflow).progress;
    if (progress?.status !== "running") return;
    const now = this.now();
    this.update(workflow, (state) => ({
      ...state,
      progress: {
        ...progress,
        status,
        message,
        response: response ?? progress.response,
        finishedAt: now,
        phases: progress.phases.map((phase) =>
          phase.finishedAt === undefined ? { ...phase, finishedAt: now } : phase,
        ),
      },
    }));
  }

  result(workflow: PreflightWorkflow, response: WizardPreflightResponse): void {
    const progress = this.getState(workflow).progress;
    if (!progress) return;
    this.update(workflow, (state) => ({ ...state, progress: { ...progress, response } }));
  }

  clear(workflow: PreflightWorkflow): void {
    if (!this.getState(workflow).progress) return;
    this.update(workflow, (state) => ({ ...state, progress: null }));
  }

  private abandon(workflow: PreflightWorkflow, scope: PreflightScope, identity: string): void {
    const progress = this.getState(workflow).progress;
    if (
      progress?.status === "running" &&
      progress.scope === scope &&
      progress.identity === identity
    ) {
      this.clear(workflow);
    }
  }

  private async adopt(workflow: PreflightWorkflow, budget: ExecutionBudget): Promise<void> {
    const session = this.attached.get(workflow);
    if (!session) return;
    const ref = session.draft.executionBudgetRef;
    if (ref && ref.id !== budget.id) return;
    try {
      await session.adopt(budget);
    } catch (failure) {
      // The wizard left while the run was on its way; the budget is on the
      // server, and the next wizard instance reads it from there.
      if (!isAbortError(failure)) throw failure;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private update(
    workflow: PreflightWorkflow,
    change: (state: PreflightWorkflowState) => PreflightWorkflowState,
  ): void {
    const previous = this.getState(workflow);
    const next = change(previous);
    if (next === previous) return;
    this.states.set(workflow, next);
    for (const listener of this.listeners) listener();
  }
}
