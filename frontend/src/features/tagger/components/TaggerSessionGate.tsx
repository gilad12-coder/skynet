"use client";

import { LoadingState } from "@/shared/ui/loading-state";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { XCircle } from "@/shared/ui/icons";

import {
  getTaggerSession,
  takeTaggerSession,
  setApiAuthToken,
  updateTaggerSession,
  type TaggerSessionDetail,
} from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { clearRecentSession } from "@/shared/lib/recent-session";
import { PageContainer } from "@/shared/layout/page-container";
import { TaggerBackLink } from "./TaggerBackLink";
import { discardUnstartedSession } from "../hooks/use-tagger";
import { TaggerView } from "./TaggerView";
import {
  clearTaggerInterviewLocaleReset,
  hasTaggerInterviewLocaleReset,
} from "../lib/interview-locale-reset";

type GateState =
  | { mode: "loading" }
  | { mode: "unstarted"; session: TaggerSessionDetail }
  | { mode: "ready"; session: TaggerSessionDetail }
  | { mode: "notfound" };

async function resetInterviewAfterLocaleReload(
  detail: TaggerSessionDetail,
): Promise<TaggerSessionDetail> {
  if (!hasTaggerInterviewLocaleReset(detail.id)) return detail;
  if (
    detail.phase !== "interview" ||
    detail.role === "viewer" ||
    !detail.assist ||
    typeof detail.assist !== "object" ||
    Array.isArray(detail.assist)
  ) {
    clearTaggerInterviewLocaleReset(detail.id);
    return detail;
  }

  const assist = { ...(detail.assist as Record<string, unknown>) };
  delete assist.taskOverride;
  assist.interview = { turns: [], done: false };
  assist.rubric = [];
  const next = { ...detail, assist };
  try {
    await updateTaggerSession(detail.id, {
      annotations: detail.annotations,
      assist,
      current_index: detail.current_index,
      phase: "interview",
    });
    clearTaggerInterviewLocaleReset(detail.id);
  } catch {
    // Leave the marker in place so a later reload retries the persisted reset.
  }
  return next;
}

/**
 * Resolves ``/tagger/[id]``: fetches the caller's saved session and hands its
 * full state to {@link TaggerView} to resume annotating, or shows a not-found
 * state when the id is unknown or owned by someone else. A session that never
 * got past its setup interview is not reopened: it is discarded and the user
 * starts fresh, unless this very tab just created it or reloaded it for a
 * language switch. Mirrors
 * ``OptimizationDetailGate`` — the bearer is attached before the probe because
 * effects run child-before-parent and the root token bridge may not have synced.
 */
export function TaggerSessionGate() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [state, setState] = useState<GateState>({ mode: "loading" });
  // StrictMode's dev-only effect re-run consumes the one-shot handoff on the
  // first pass and refetches on the second; the ref remembers this tab was
  // handed the session, so the refetch is not mistaken for a return visit.
  const handedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    let cancelled = false;
    // Resume instantly from the wizard's same-tab handoff when present; a genuine
    // reload or a return from elsewhere finds none and fetches from the server.
    const handed = takeTaggerSession(id);
    if (handed) {
      handedIdRef.current = id;
      void resetInterviewAfterLocaleReload(handed).then((sessionDetail) => {
        if (!cancelled) setState({ mode: "ready", session: sessionDetail });
      });
      return () => {
        cancelled = true;
      };
    }
    setState({ mode: "loading" });
    if (session?.backendAccessToken) setApiAuthToken(session.backendAccessToken);
    getTaggerSession(id)
      .then(async (detail) => {
        if (
          detail.phase === "interview" &&
          handedIdRef.current !== detail.id &&
          !hasTaggerInterviewLocaleReset(detail.id)
        ) {
          return { mode: "unstarted", session: detail } as const;
        }
        return { mode: "ready", session: await resetInterviewAfterLocaleReload(detail) } as const;
      })
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState({ mode: "notfound" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, status, session?.backendAccessToken]);

  useEffect(() => {
    if (state.mode !== "unstarted") return;
    if (state.session.role === "owner") discardUnstartedSession(state.session.id);
    clearRecentSession("tagger");
    router.replace("/tagger");
  }, [state, router]);

  if (state.mode === "loading" || state.mode === "unstarted") {
    return (
      <PageContainer full>
        <LoadingState fullPage />
      </PageContainer>
    );
  }
  if (state.mode === "notfound") {
    return (
      <PageContainer full>
        <div className="mb-3">
          <TaggerBackLink />
        </div>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <XCircle className="size-12 text-destructive" />
          <p className="text-lg text-muted-foreground">{msg("tagger.session.notfound")}</p>
        </div>
      </PageContainer>
    );
  }
  // Remount on id change so the hook re-seeds from the new session's state.
  // TaggerView renders its own back link, so none is added here.
  return <TaggerView key={state.session.id} initialSession={state.session} />;
}
