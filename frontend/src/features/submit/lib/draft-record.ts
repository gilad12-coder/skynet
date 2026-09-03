import type {
  BlackboxEngineId,
  BlackboxHarness,
  BlackboxProposerRuntime,
  ModelConfig,
  SplitFractions,
  ValidateCodeResponse,
  WorkflowSpec,
} from "@/shared/types/api";
import type { ParsedDataset } from "@/shared/lib/parse-dataset";
import type { ReactConfig, ColumnRole } from "../constants";
import type { BlackboxRecipe, SeedMode, SeedPart } from "../hooks/use-blackbox-wizard";
import type { ScoringModelMode } from "./model-roles";
import type { WizardStageId } from "./wizard-steps";

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
  reactConfig: ReactConfig;
  workflowSpec?: WorkflowSpec | null;
  signatureCode: string;
  metricCode: string;
  signatureManuallyEdited: boolean;
  metricManuallyEdited: boolean;
  signatureValidation?: ValidateCodeResponse | null;
  metricValidation?: ValidateCodeResponse | null;
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
  scorerModelDeclared: boolean;
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

export interface WizardDraftRecord {
  version: typeof DRAFT_RECORD_VERSION;
  id: string;
  accountId: string;
  activeRecipe: DraftRecipe;
  revision: number;
  updatedAt: number;
  program: DraftWorkflowState<WizardDraftData> | null;
  anything: DraftWorkflowState<AnythingDraftData> | null;
}

/** A model config without its inline API key; the rest of the choice survives. */
export function stripModelSecrets(config: ModelConfig): ModelConfig {
  if (!config.extra || !("api_key" in config.extra)) return config;
  const { api_key: _dropped, ...extra } = config.extra;
  void _dropped;
  return Object.keys(extra).length > 0 ? { ...config, extra } : { ...config, extra: undefined };
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

function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a) as Array<keyof typeof a>;
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.is(a[k], (b as Record<string, unknown>)[k as string]));
}

export interface DraftStore {
  read(accountId: string): Promise<WizardDraftRecord | null>;
  write(record: WizardDraftRecord): Promise<void>;
  remove(accountId: string): Promise<void>;
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
  private readonly accountId: string;
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

  /**
   * Take a discovered record (or its absence) as the base for later writes.
   * Snapshots published before discovery finished are live state, so an
   * empty discovery keeps them; a found record is offered or restored by the
   * caller, whose remount publishes afresh.
   */
  adopt(record: WizardDraftRecord | null): void {
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

  /** Write any pending change now. Resolves once the store has answered. */
  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.held || !this.dirty) return;
    const generation = this.generation;
    this.dirty = false;
    if (!hasMeaningfulDraft(this.record)) {
      // A blanked-out draft leaves storage but stays in memory at revision 0,
      // so the next identical snapshot is recognised instead of re-queued.
      if (this.record && this.record.revision > 0) {
        this.record = { ...this.record, revision: 0 };
        await this.removeAt(generation);
      }
      return;
    }
    const record: WizardDraftRecord = {
      ...(this.record as WizardDraftRecord),
      revision: (this.record as WizardDraftRecord).revision + 1,
      updatedAt: this.now(),
    };
    try {
      await this.store.write(record);
      if (generation !== this.generation) return;
      this.record = record;
      this.onWritten?.(record);
    } catch (error) {
      if (generation !== this.generation) return;
      this.dirty = true;
      this.onWriteError?.(error);
    }
  }

  /**
   * Delete the record and forget everything queued before this call. Rejects
   * when the store cannot commit the delete, in which case nothing was
   * dropped from memory and the caller must report the failure.
   */
  async reset(): Promise<void> {
    this.cancelTimer();
    this.generation += 1;
    const generation = this.generation;
    await this.store.remove(this.accountId);
    if (generation !== this.generation) return;
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
      await this.store.remove(this.accountId);
      if (generation === this.generation) this.onRemoved?.();
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
