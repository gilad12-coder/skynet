"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";

import { readBudgetDraft, type WizardBudgetDraft } from "../lib/execution-budget-session";
import { LOCALE_RELOAD_EVENT } from "@/shared/lib/locale";
import { msg } from "@/shared/lib/messages";
import { sessionIdentity } from "@/shared/lib/session-identity";

import { DraftRestoreToast, type DraftRestoreState } from "../components/DraftRestoreToast";
import {
  DraftSaver,
  hasMeaningfulDraft,
  recipeToOpen,
  type DraftDataFor,
  type DraftRecipe,
  type WizardDraftRecord,
} from "../lib/draft-record";
import {
  indexedDbDraftStore,
  markResumeAfterReload,
  openDraftChannel,
  takeResumeAfterReload,
} from "../lib/draft-store";

/** What the wizard hooks see: publish snapshots, read one back, and mark it consumed. */
export interface WizardDraftsApi {
  /** A discovered draft awaits the user's choice; nothing is saved meanwhile. */
  offerPending: boolean;
  takeExecution(): WizardBudgetDraft;
  saveExecution(execution: WizardBudgetDraft): Promise<void>;
  /** The in-memory snapshot for a workflow, or null while an offer is pending. */
  takeSnapshot<K extends DraftRecipe>(recipe: K): DraftDataFor<K> | null;
  publish<K extends DraftRecipe>(recipe: K, data: DraftDataFor<K>, meaningful: boolean): void;
  /** Write any pending change now — stage boundaries and unmounts. */
  flush(): void;
  /** The draft turned into a submission; delete it and stop saving. */
  consumed(): void;
}

const NOOP_API: WizardDraftsApi = {
  offerPending: false,
  takeExecution: () => ({}),
  saveExecution: async () => {
    throw new Error("draft_not_ready");
  },
  takeSnapshot: () => null,
  publish: () => {},
  flush: () => {},
  consumed: () => {},
};

const WizardDraftsContext = createContext<WizardDraftsApi>(NOOP_API);

export function WizardDraftsProvider({
  api,
  children,
}: {
  api: WizardDraftsApi;
  children: ReactNode;
}) {
  return <WizardDraftsContext.Provider value={api}>{children}</WizardDraftsContext.Provider>;
}

/** The draft store the enclosing `/submit` entry provides; a no-op outside it. */
export function useWizardDrafts(): WizardDraftsApi {
  return useContext(WizardDraftsContext);
}

const SAVE_FAILED_TOAST = "wizard-draft-save-failed";

function offerToastId(draftId: string): string {
  return `draft-restore:${draftId}`;
}

/**
 * Owns the durable draft for the signed-in account on `/submit`: discovers it
 * once the account is known, offers it back through one actionable toast,
 * and hands the wizards a small API for publishing snapshots. `onContinue`
 * and `onStartNew` are the entry screen's transitions; they fire only after
 * storage has confirmed the choice.
 */
export function useWizardDraftController({
  onContinue,
  onStartNew,
}: {
  onContinue: (recipe: DraftRecipe) => void;
  onStartNew: () => void;
}) {
  const { data: session, status } = useSession();
  const accountId = status === "loading" ? null : sessionIdentity(session) || null;

  const saverRef = useRef<DraftSaver | null>(null);
  const [readyAccount, setReadyAccount] = useState<string | null>(null);
  const lastAccountRef = useRef<string | null>(null);
  const accountRef = useRef<string | null>(null);
  useEffect(() => {
    accountRef.current = accountId;
  }, [accountId]);
  const transitions = useRef({ onContinue, onStartNew });
  useEffect(() => {
    transitions.current = { onContinue, onStartNew };
  }, [onContinue, onStartNew]);
  const channelRef = useRef<ReturnType<typeof openDraftChannel> | null>(null);

  const [offer, setOffer] = useState<WizardDraftRecord | null>(null);
  const offerRef = useRef(offer);
  useEffect(() => {
    offerRef.current = offer;
  }, [offer]);
  const offerStateRef = useRef<{ state: DraftRestoreState; failure: string | null }>({
    state: "offer",
    failure: null,
  });

  const dismissOffer = useCallback(() => {
    const current = offerRef.current;
    if (current) toast.dismiss(offerToastId(current.id));
    offerRef.current = null;
    setOffer(null);
  }, []);

  const warnSaveFailed = useCallback(() => {
    toast.warn(msg("submit.draft.save_failed"), { toastId: SAVE_FAILED_TOAST });
  }, []);

  const startNew = useCallback(async (): Promise<boolean> => {
    const saver = saverRef.current;
    if (!saver) {
      dismissOffer();
      transitions.current.onStartNew();
      return true;
    }
    try {
      await saver.reset();
    } catch {
      toast.error(msg("submit.draft.reset_failed"));
      return false;
    }
    if (accountRef.current) {
      channelRef.current?.post({
        type: "reset",
        accountId: accountRef.current,
        resetGeneration: saver.resetFence,
      });
    }
    dismissOffer();
    saver.hold(false);
    transitions.current.onStartNew();
    return true;
  }, [dismissOffer]);

  const renderOffer = useCallback(
    (record: WizardDraftRecord, continueDraft: () => void) => (
      <DraftRestoreToast
        title={msg("submit.draft.restore.title")}
        state={offerStateRef.current.state}
        failureText={offerStateRef.current.failure}
        continueLabel={msg("submit.draft.restore.continue")}
        retryLabel={msg("submit.draft.restore.retry")}
        startNewLabel={msg("submit.draft.restore.start_new")}
        onContinue={continueDraft}
        onStartNew={() => void startNew()}
      />
    ),
    [startNew],
  );

  const continueDraftRef = useRef<() => void>(() => {});
  const continueDraft = () => {
    const saver = saverRef.current;
    const current = offerRef.current;
    const account = accountRef.current;
    if (!saver || !current || !account) return;
    const id = offerToastId(current.id);
    const show = (state: DraftRestoreState, failure: string | null) => {
      offerStateRef.current = { state, failure };
      toast.update(id, { render: renderOffer(current, () => continueDraftRef.current()) });
    };
    show("working", null);
    indexedDbDraftStore
      .read(account)
      .then(({ record: fresh, resetGeneration }) => {
        if (offerRef.current !== current || accountRef.current !== account) return;
        const recipe = recipeToOpen(fresh);
        if (!fresh || !recipe) {
          show("failed", msg("submit.draft.restore.gone"));
          return;
        }
        saver.adopt(fresh, resetGeneration);
        saver.hold(false);
        dismissOffer();
        transitions.current.onContinue(recipe);
      })
      .catch(() => {
        if (offerRef.current !== current) return;
        show("failed", msg("submit.draft.restore.failed"));
      });
  };
  useEffect(() => {
    continueDraftRef.current = continueDraft;
  });

  useEffect(() => {
    if (!offer) return;
    offerStateRef.current = { state: "offer", failure: null };
    toast(
      renderOffer(offer, () => continueDraftRef.current()),
      {
        toastId: offerToastId(offer.id),
        autoClose: false,
        closeOnClick: false,
        closeButton: false,
        draggable: false,
        hideProgressBar: true,
        role: "status",
      },
    );
  }, [offer, renderOffer]);

  // Leaving `/submit` keeps the draft and drops the offer; it comes back with
  // the page, and its buttons would otherwise point at an unmounted screen.
  useEffect(() => () => dismissOffer(), [dismissOffer]);

  useEffect(() => {
    const channel = openDraftChannel((message) => {
      if (message.type !== "reset" || message.accountId !== accountRef.current) return;
      const saver = saverRef.current;
      if (!saver || message.resetGeneration <= saver.resetFence) return;
      dismissOffer();
      saver.dropQueued();
      saver.adopt(null, message.resetGeneration);
      saver.hold(false);
      transitions.current.onStartNew();
    });
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [dismissOffer]);

  useEffect(() => {
    dismissOffer();
    saverRef.current = null;
    if (lastAccountRef.current !== null && lastAccountRef.current !== accountId) {
      transitions.current.onStartNew();
    }
    lastAccountRef.current = accountId;
    setReadyAccount(null);
    if (!accountId) return;
    const saver = new DraftSaver(accountId, {
      store: indexedDbDraftStore,
      onWriteError: warnSaveFailed,
      onWritten: (record) =>
        channelRef.current?.post({
          type: "written",
          accountId,
          id: record.id,
          revision: record.revision,
        }),
    });
    saverRef.current = saver;
    const epoch = saver.epoch;
    let cancelled = false;
    indexedDbDraftStore
      .read(accountId)
      .then(({ record, resetGeneration }) => {
        if (cancelled || saver.epoch !== epoch) return;
        setReadyAccount(accountId);
        if (!record || !hasMeaningfulDraft(record)) {
          saver.adopt(null, resetGeneration);
          saver.hold(false);
          return;
        }
        if (takeResumeAfterReload(accountId)) {
          saver.adopt(record, resetGeneration);
          saver.hold(false);
          const recipe = recipeToOpen(record);
          if (recipe) transitions.current.onContinue(recipe);
          return;
        }
        saver.adopt(record, resetGeneration);
        setOffer(record);
      })
      .catch(() => {
        if (cancelled || saver.epoch !== epoch) return;
        setReadyAccount(accountId);
        warnSaveFailed();
      });
    return () => {
      cancelled = true;
      void saver.flush().finally(() => saver.detach());
    };
  }, [accountId, dismissOffer, warnSaveFailed]);

  useEffect(() => {
    const onLocaleReload = () => {
      const saver = saverRef.current;
      const account = accountRef.current;
      if (!saver || !account || saver.isHeld || !hasMeaningfulDraft(saver.current)) return;
      markResumeAfterReload(account);
      void saver.flush();
    };
    window.addEventListener(LOCALE_RELOAD_EVENT, onLocaleReload);
    return () => window.removeEventListener(LOCALE_RELOAD_EVENT, onLocaleReload);
  }, []);

  const offerPending = offer !== null;
  const api = useMemo<WizardDraftsApi>(
    () => ({
      offerPending,
      takeExecution: () => {
        const saver = saverRef.current;
        if (!saver || saver.accountId !== accountId || saver.isHeld) return {};
        const record = saver.current;
        if (!record) return {};
        return {
          budgetTotalCredits: record[record.activeRecipe]?.data.maxCostCredits ?? null,
          ...readBudgetDraft(record),
        };
      },
      saveExecution: async (execution) => {
        const saver = saverRef.current;
        if (!saver || saver.accountId !== accountId)
          throw new DOMException("Draft detached", "AbortError");
        if (saver.isHeld) throw new Error(msg("submit.draft.save_failed"));
        await saver.saveExecution(execution);
      },
      takeSnapshot: <K extends DraftRecipe>(recipe: K) => {
        const saver = saverRef.current;
        if (!saver || saver.accountId !== accountId || saver.isHeld) return null;
        return (saver.current?.[recipe]?.data ?? null) as DraftDataFor<K> | null;
      },
      publish: (recipe, data, meaningful) => {
        const saver = saverRef.current;
        if (saver?.accountId === accountId) saver.publish(recipe, data, meaningful);
      },
      flush: () => {
        const saver = saverRef.current;
        if (saver?.accountId === accountId) void saver.flush();
      },
      consumed: () => {
        const saver = saverRef.current;
        if (!saver || saver.accountId !== accountId) return;
        saver
          .reset()
          .then(() => {
            if (accountRef.current) {
              channelRef.current?.post({
                type: "reset",
                accountId: accountRef.current,
                resetGeneration: saver.resetFence,
              });
            }
          })
          .catch(() => {});
      },
    }),
    [accountId, offerPending],
  );

  return {
    api,
    offerPending,
    startNew,
    accountReady: accountId !== null && readyAccount === accountId,
    accountId,
  };
}
