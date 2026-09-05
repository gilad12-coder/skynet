import type {
  BlackboxEngineId,
  BlackboxHarness,
  BlackboxProposerRuntime,
  ExecutionRuntime,
  ModelConfig,
  SplitFractions,
  WorkflowSpec,
} from "@/shared/types/api";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { ReactConfig, ColumnRole } from "../constants";
import type { BlackboxRecipe, SeedMode, SeedPart } from "../hooks/use-blackbox-wizard";
import type { ScoringModelMode } from "./model-roles";
import type { WizardStageId } from "./wizard-steps";
import type { WizardBudgetDraft } from "./execution-budget-session";

/**
 * The durable draft of the new-optimization wizard.
 *
 * One record per signed-in account holds the latest snapshot of both
 * workflows plus which one the user was in, so a refresh, a closed tab or a
 * later visit can pick the setup back up from the toast offer. Nothing here
 * expires on a timer: the record lives until the user submits, chooses
 * "Start new", or blanks every field. Secrets never enter the record — remote
 * scorer secrets and per-model API keys are stripped before a snapshot is
 * published (see `stripModelSecrets`).
 */
export interface WizardDraftData {
  stage: WizardStageId;
  furthestStage: WizardStageId;
  summaryTab: number;
  summaryCodeTab: string;
  jobType: "run" | "grid_search";
  isPrivate: boolean;
  jobName: string;
  jobDescription: string;
  moduleName: string;
  moduleChosen: boolean;
  optimizerName: string;
  executionRuntime?: ExecutionRuntime;
  codeAssistMode?: "auto" | "manual";
  splitMode?: "auto" | "manual";
  reactConfig: ReactConfig;
  workflowSpec?: WorkflowSpec | null;
  signatureCode: string;
  metricCode: string;
  signatureManuallyEdited: boolean;
  metricManuallyEdited: boolean;
  parsedDataset: ParsedDataset | null;
  datasetFileName: string | null;
  columnRoles: Record<string, ColumnRole>;
  columnKinds: Record<string, "text" | "image">;
  modelConfig: ModelConfig;
  secondModelConfig: ModelConfig | null;
  generationModels: ModelConfig[];
  reflectionModels: ModelConfig[];
  split: SplitFractions;
  seed: number | undefined;
  autoLevel: string;
  reflectionMinibatchSize: string;
  maxFullEvals: string;
  maxMetricCalls?: string;
  useMerge: boolean;
  targetScore: string;
  pxnParents?: string;
  pxnProposals?: string;
  shuffle: boolean;
  maxCostCredits: number | null;
}

/** The Anything wizard's snapshot. Evidence, dry-run state and secrets stay out. */
export interface AnythingDraftData {
  stage: WizardStageId;
  furthestStage: WizardStageId;
  jobName: string;
  jobDescription: string;
  isPrivate: boolean;
  recipe: BlackboxRecipe;
  codeAssistMode: "auto" | "manual";
  seedMode: SeedMode;
  seedText: string;
  seedParts: SeedPart[];
  seedManuallyEdited: boolean;
  scorerManuallyEdited: boolean;
  objective: string;
  background: string;
  targetKind: "text" | "agent";
  harness: BlackboxHarness;
  targetModel: ModelConfig;
  targetTimeout: number;
  targetConcurrency: number;
  parsedCases: ParsedDataset | null;
  casesName: string;
  split: SplitFractions;
  shuffle: boolean;
  seed: number | undefined;
  splitMode: "auto" | "manual";
  scorerKind: "python" | "remote";
  metricCode: string;
  scorerUrl: string;
  scorerInstall: string;
  scorerModel: ModelConfig;
  scorerModelMode: ScoringModelMode;
  strategyMode: "auto" | "single" | "plateau";
  engine: BlackboxEngineId | null;
  proposerRuntime?: BlackboxProposerRuntime;
  patience: number;
  maxScorerRuns: number;
  maxIterations: number | "";
  stopAtScore: string;
  reflectionModel: ModelConfig;
  maxCostCredits: number | null;
  setupSpent: number;
}

export type DraftRecipe = "program" | "anything";

export interface DraftWorkflowState<T> {
  data: T;
  meaningful: boolean;
}

export type DraftDataFor<K extends DraftRecipe> = K extends "program"
  ? WizardDraftData
  : AnythingDraftData;

export const DRAFT_RECORD_VERSION = 1;

export interface WizardDraftRecord extends WizardBudgetDraft {
  version: typeof DRAFT_RECORD_VERSION;
  id: string;
  accountId: string;
  activeRecipe: DraftRecipe;
  revision: number;
  updatedAt: number;
  program: DraftWorkflowState<WizardDraftData> | null;
  anything: DraftWorkflowState<AnythingDraftData> | null;
}

const CREDENTIAL_FIELD =
  /^(?:api[_-]?key|authorization|proxy[_-]?authorization|access[_-]?token|refresh[_-]?token|gateway[_-]?token|secret|password)$/i;

function withoutCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CREDENTIAL_FIELD.test(key))
      .map(([key, entry]) => [key, withoutCredentials(entry)]),
  );
}

/** Keep model settings and vault references while removing inline credentials. */
export function stripModelSecrets(config: ModelConfig): ModelConfig {
  if (!config.extra) return config;
  const extra = withoutCredentials(config.extra) as ModelConfig["extra"];
  if (JSON.stringify(extra) === JSON.stringify(config.extra)) return config;
  return { ...config, extra: extra && Object.keys(extra).length > 0 ? extra : undefined };
}

/** Stored code checks are never current runtime evidence, including old records. */
export function sanitizeProgramDraft(raw: WizardDraftData): WizardDraftData {
  const {
    signatureValidation: _signature,
    metricValidation: _metric,
    ...data
  } = raw as WizardDraftData & { signatureValidation?: unknown; metricValidation?: unknown };
  return {
    ...data,
    executionRuntime: "vercel",
    codeAssistMode: data.codeAssistMode ?? "manual",
    splitMode: data.splitMode ?? "manual",
    reactConfig: { ...data.reactConfig, mcpAuthHeader: "" },
    modelConfig: stripModelSecrets(data.modelConfig),
    secondModelConfig: data.secondModelConfig ? stripModelSecrets(data.secondModelConfig) : null,
    generationModels: data.generationModels.map(stripModelSecrets),
    reflectionModels: data.reflectionModels.map(stripModelSecrets),
  };
}

/** Defend both the storage boundary and restoration of previously saved models. */
export function sanitizeAnythingDraft(data: AnythingDraftData): AnythingDraftData {
  return {
    ...data,
    proposerRuntime: "vercel",
    targetModel: stripModelSecrets(data.targetModel),
    scorerModel: stripModelSecrets(data.scorerModel),
    reflectionModel: stripModelSecrets(data.reflectionModel),
  };
}

/** Whether a Program snapshot holds anything worth offering back. */
export function isMeaningfulProgramDraft(d: WizardDraftData): boolean {
  return (
    d.stage !== "goal" ||
    d.moduleChosen ||
    d.parsedDataset !== null ||
    d.datasetFileName !== null ||
    d.jobName.trim() !== ""
  );
}

/** Whether an Anything snapshot holds anything worth offering back. */
export function isMeaningfulAnythingDraft(d: AnythingDraftData): boolean {
  return (
    d.stage !== "goal" ||
    d.objective.trim() !== "" ||
    d.background.trim() !== "" ||
    d.seedText.trim() !== "" ||
    d.seedParts.some((p) => p.key.trim() !== "" || p.value.trim() !== "") ||
    d.parsedCases !== null ||
    d.jobName.trim() !== ""
  );
}

/** A record is worth keeping while at least one workflow snapshot is meaningful. */
export function hasMeaningfulDraft(record: WizardDraftRecord | null): boolean {
  return Boolean(record?.program?.meaningful || record?.anything?.meaningful);
}

/**
 * The workflow a restore opens: the one the user was in when it still has
 * content, otherwise the other one. Null when nothing is worth restoring.
 */
export function recipeToOpen(record: WizardDraftRecord | null): DraftRecipe | null {
  if (!record) return null;
  if (record[record.activeRecipe]?.meaningful) return record.activeRecipe;
  if (record.program?.meaningful) return "program";
  if (record.anything?.meaningful) return "anything";
  return null;
}

/** The stage the restore reopens, for the toast's supporting line. */
export function draftStage(record: WizardDraftRecord | null): WizardStageId | null {
  const recipe = recipeToOpen(record);
  return recipe ? (record?.[recipe]?.data.stage ?? null) : null;
}

/** Compare configurations without treating wizard navigation as an edit. */
export function matchesClonedDraft<K extends DraftRecipe>(
  record: WizardDraftRecord | null,
  recipe: K,
  clone: DraftDataFor<K>,
): boolean {
  if (recipeToOpen(record) !== recipe) return false;
  const saved = record?.[recipe]?.data;
  if (!saved) return false;
  const configuration = (data: WizardDraftData | AnythingDraftData) => {
    const {
      stage: _stage,
      furthestStage: _furthest,
      summaryTab: _tab,
      summaryCodeTab: _codeTab,
      setupSpent: _spent,
      ...config
    } = data as (WizardDraftData | AnythingDraftData) & {
      summaryTab?: number;
      summaryCodeTab?: string;
      setupSpent?: number;
    };
    return JSON.stringify(config, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    );
  };
  return configuration(saved) === configuration(clone);
}

function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a) as Array<keyof typeof a>;
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.is(a[k], (b as Record<string, unknown>)[k as string]));
}

export interface DraftStoreSnapshot {
  record: WizardDraftRecord | null;
  resetGeneration: number;
}

export interface DraftStore {
  read(accountId: string): Promise<DraftStoreSnapshot>;
  /** False means a reset in another tab fenced out this snapshot. */
  write(record: WizardDraftRecord, resetGeneration: number): Promise<boolean>;
  /** Keep a content-free generation marker to reject pre-reset writers. */
  remove(accountId: string): Promise<number>;
}

export interface DraftSaverOptions {
  store: DraftStore;
  debounceMs?: number;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onWriteError?: (error: unknown) => void;
  onWritten?: (record: WizardDraftRecord) => void;
  onRemoved?: () => void;
}

/**
 * Turns the wizards' per-render snapshots into a small number of durable
 * writes, with the two rules D06 asks for: nothing is written while `held`
 * (a restore offer is on screen, or discovery has not finished), and a
 * reset bumps a generation so a debounced or in-flight write from before it
 * can never resurrect the record it just deleted.
 */
export class DraftSaver {
  private record: WizardDraftRecord | null = null;
  private dirty = false;
  private held = true;
  private generation = 0;
  private timer: unknown = null;
  readonly accountId: string;
  private resetGeneration = 0;
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly store: DraftStore;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onWriteError?: (error: unknown) => void;
  private readonly onWritten?: (record: WizardDraftRecord) => void;
  private readonly onRemoved?: () => void;

  constructor(accountId: string, options: DraftSaverOptions) {
    this.accountId = accountId;
    this.store = options.store;
    this.debounceMs = options.debounceMs ?? 600;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? randomDraftId;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onWriteError = options.onWriteError;
    this.onWritten = options.onWritten;
    this.onRemoved = options.onRemoved;
  }

  /** The record as this saver last knew it — adopted or written. */
  get current(): WizardDraftRecord | null {
    return this.record;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Bumps on every reset or detach; a discovery that started before it is stale. */
  get epoch(): number {
    return this.generation;
  }

  get resetFence(): number {
    return this.resetGeneration;
  }

  /**
   * Take a discovered record (or its absence) as the base for later writes.
   * Snapshots published before discovery finished are live state, so an
   * empty discovery keeps them; a found record is offered or restored by the
   * caller, whose remount publishes afresh.
   */
  adopt(record: WizardDraftRecord | null, resetGeneration = 0): void {
    this.resetGeneration = resetGeneration;
    if (record === null && this.record !== null && this.record.revision === 0) return;
    this.record = record;
    this.dirty = false;
  }

  /** Stop or resume writing; a release with pending changes writes on the debounce. */
  hold(held: boolean): void {
    this.held = held;
    if (!held && this.dirty) this.schedule();
  }

  /** Fold one workflow's latest snapshot into the record; identical snapshots are ignored. */
  publish<K extends DraftRecipe>(recipe: K, data: DraftDataFor<K>, meaningful: boolean): void {
    const previous = this.record?.[recipe] as
      | DraftWorkflowState<DraftDataFor<K>>
      | null
      | undefined;
    const sameActive = this.record?.activeRecipe === recipe;
    if (
      previous &&
      sameActive &&
      previous.meaningful === meaningful &&
      shallowEqual(previous.data, data)
    ) {
      return;
    }
    const base: WizardDraftRecord = this.record ?? {
      version: DRAFT_RECORD_VERSION,
      id: this.newId(),
      accountId: this.accountId,
      activeRecipe: recipe,
      revision: 0,
      updatedAt: 0,
      program: null,
      anything: null,
    };
    this.record = {
      ...base,
      activeRecipe: recipe,
      [recipe]: { data, meaningful },
    };
    this.dirty = true;
    this.schedule();
  }

  /** Save shared execution identities before a paid or idempotent request is sent. */
  async saveExecution(execution: WizardBudgetDraft): Promise<void> {
    if (this.held || !this.record) throw new Error("draft_not_ready");
    this.record = { ...this.record, ...execution };
    this.dirty = true;
    await this.flush(true);
  }

  /** Serialize writes so an older completion cannot replace newer edits. */
  flush(strict = false): Promise<void> {
    this.cancelTimer();
    const generation = this.generation;
    const pending = this.pendingWrite.then(async () => {
      if (generation !== this.generation || this.held) {
        if (strict) throw new DOMException("Draft detached", "AbortError");
        return;
      }
      if (!this.dirty) return;
      this.dirty = false;
      if (!hasMeaningfulDraft(this.record)) {
        if (this.record && this.record.revision > 0) {
          this.record = { ...this.record, revision: 0 };
          await this.removeAt(generation);
        }
        return;
      }
      const snapshot = this.record as WizardDraftRecord;
      const record: WizardDraftRecord = {
        ...snapshot,
        revision: snapshot.revision + 1,
        updatedAt: this.now(),
      };
      try {
        const accepted = await this.store.write(record, this.resetGeneration);
        if (generation !== this.generation) {
          if (strict) throw new DOMException("Draft detached", "AbortError");
          return;
        }
        if (!accepted) {
          this.detach();
          this.onWriteError?.(new Error("draft_reset_in_another_tab"));
          if (strict) throw new DOMException("Draft reset in another tab", "AbortError");
          return;
        }
        this.record =
          this.record === snapshot
            ? record
            : {
                ...(this.record as WizardDraftRecord),
                revision: record.revision,
                updatedAt: record.updatedAt,
              };
        this.onWritten?.(record);
      } catch (error) {
        if (generation !== this.generation) {
          if (strict) throw error;
          return;
        }
        this.dirty = true;
        this.onWriteError?.(error);
        if (strict) throw error;
      }
    });
    this.pendingWrite = pending.catch(() => {});
    return pending;
  }

  /** Delete after any active write, retaining a fence against other tabs. */
  async reset(): Promise<void> {
    const wasHeld = this.held;
    this.held = true;
    this.cancelTimer();
    this.generation += 1;
    const generation = this.generation;
    let resetGeneration: number;
    try {
      await this.pendingWrite;
      resetGeneration = await this.store.remove(this.accountId);
    } catch (error) {
      if (generation === this.generation) this.hold(wasHeld);
      throw error;
    }
    if (generation !== this.generation) return;
    this.resetGeneration = resetGeneration;
    this.record = null;
    this.dirty = false;
    this.onRemoved?.();
  }

  /** Forget the record without touching storage — the account signed out or changed. */
  detach(): void {
    this.dropQueued();
    this.held = true;
  }

  /**
   * Another tab reset this account's draft: forget the record and anything
   * queued for it, so the next meaningful snapshot here starts a new one
   * instead of writing the deleted record back.
   */
  dropQueued(): void {
    this.cancelTimer();
    this.generation += 1;
    this.record = null;
    this.dirty = false;
  }

  private schedule(): void {
    if (this.held) return;
    this.cancelTimer();
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      void this.flush();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async removeAt(generation: number): Promise<void> {
    try {
      const resetGeneration = await this.store.remove(this.accountId);
      if (generation === this.generation) {
        this.resetGeneration = resetGeneration;
        this.onRemoved?.();
      }
    } catch (error) {
      if (generation === this.generation) this.onWriteError?.(error);
    }
  }
}

function randomDraftId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
