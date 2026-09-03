import {
  DRAFT_RECORD_VERSION,
  type DraftStore,
  type WizardDraftData,
  type WizardDraftRecord,
} from "./draft-record";
import {
  isWizardStageId,
  migrateLegacyProgramFurthest,
  migrateLegacyProgramStep,
} from "./wizard-steps";

const DB_NAME = "skynet-wizard-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
const CHANNEL_NAME = "skynet-wizard-drafts";
const RESUME_KEY = "skynet.wizard-draft.resume";

type StoredProgramDraft = Omit<WizardDraftData, "stage" | "furthestStage"> &
  Partial<Pick<WizardDraftData, "stage" | "furthestStage">> & {
    step?: number;
    furthestReachedStep?: number;
  };

/** Adopt a stored Program draft from either layout, mapping legacy step indices onto stages. */
export function normalizeProgramDraft(raw: StoredProgramDraft): WizardDraftData | null {
  const { step, furthestReachedStep, stage, furthestStage, ...rest } = raw;
  if (isWizardStageId(stage) && isWizardStageId(furthestStage)) {
    return { ...rest, stage, furthestStage };
  }
  if (typeof step === "number") {
    return {
      ...rest,
      stage: migrateLegacyProgramStep(step),
      furthestStage: migrateLegacyProgramFurthest(furthestReachedStep ?? step),
    };
  }
  return null;
}

/**
 * Accept a record read back from storage only when it still has the shape
 * this build writes. Anything else — an older layout, a foreign object, a
 * partially written row — reads as "no draft" rather than a crash.
 */
export function normalizeDraftRecord(raw: unknown): WizardDraftRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WizardDraftRecord>;
  if (r.version !== DRAFT_RECORD_VERSION) return null;
  if (typeof r.id !== "string" || typeof r.accountId !== "string") return null;
  if (r.activeRecipe !== "program" && r.activeRecipe !== "anything") return null;
  const program =
    r.program && r.program.data
      ? normalizeProgramDraft(r.program.data as StoredProgramDraft)
      : null;
  const anything =
    r.anything && r.anything.data && isWizardStageId(r.anything.data.stage)
      ? r.anything.data
      : null;
  return {
    version: DRAFT_RECORD_VERSION,
    id: r.id,
    accountId: r.accountId,
    activeRecipe: r.activeRecipe,
    revision: typeof r.revision === "number" ? r.revision : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    program: program ? { data: program, meaningful: r.program?.meaningful === true } : null,
    anything: anything ? { data: anything, meaningful: r.anything?.meaningful === true } : null,
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = typeof indexedDB === "undefined" ? null : indexedDB;
    if (!idb) {
      reject(new Error("indexeddb_unavailable"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "accountId" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version bump from another tab closes this connection so the
      // upgrade there can proceed; the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onblocked = () => reject(new Error("indexeddb_blocked"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function runRequest<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>;
        try {
          const tx = db.transaction(STORE_NAME, mode);
          request = op(tx.objectStore(STORE_NAME));
          tx.onabort = () => reject(tx.error ?? new Error("indexeddb_aborted"));
          tx.onerror = () => reject(tx.error ?? new Error("indexeddb_failed"));
        } catch (error) {
          reject(error);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexeddb_failed"));
      }),
  );
}

/** The durable draft store: one IndexedDB row per account in this browser profile. */
export const indexedDbDraftStore: DraftStore = {
  read: (accountId) =>
    runRequest<unknown>("readonly", (s) => s.get(accountId)).then(normalizeDraftRecord),
  write: (record: WizardDraftRecord) =>
    runRequest("readwrite", (s) => s.put(record)).then(() => undefined),
  remove: (accountId) => runRequest("readwrite", (s) => s.delete(accountId)).then(() => undefined),
};

export type DraftChannelMessage =
  | { type: "reset"; accountId: string }
  | { type: "written"; accountId: string; id: string; revision: number };

/**
 * Cross-tab coordination. A reset in one tab tells the others to drop
 * whatever they had queued for that account so a stale autosave cannot bring
 * the deleted record back; a write lets a tab with a pending offer know the
 * record moved on.
 */
export function openDraftChannel(onMessage: (message: DraftChannelMessage) => void): {
  post: (message: DraftChannelMessage) => void;
  close: () => void;
} {
  if (typeof BroadcastChannel === "undefined") {
    return { post: () => {}, close: () => {} };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<DraftChannelMessage>) => {
    if (event.data && typeof event.data === "object" && "type" in event.data) {
      onMessage(event.data);
    }
  };
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // A closed channel or a serialization refusal only costs coordination.
      }
    },
    close: () => channel.close(),
  };
}

/**
 * The locale switch reloads the page from inside the wizard. That hop is not
 * a return visit, so the record is picked back up without the offer; the flag
 * lives in sessionStorage so it dies with the tab.
 */
export function markResumeAfterReload(accountId: string): void {
  try {
    window.sessionStorage.setItem(RESUME_KEY, accountId);
  } catch {
    // Without the flag the draft is offered back through the toast instead.
  }
}

/** Consume the resume flag; true when this load follows a locale reload for `accountId`. */
export function takeResumeAfterReload(accountId: string): boolean {
  try {
    const value = window.sessionStorage.getItem(RESUME_KEY);
    if (value === null) return false;
    window.sessionStorage.removeItem(RESUME_KEY);
    return value === accountId;
  } catch {
    return false;
  }
}
