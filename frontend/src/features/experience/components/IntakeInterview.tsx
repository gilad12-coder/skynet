"use client";

import * as React from "react";

import { streamIntakeInterviewTurn } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { cachedCatalog, getModelCatalog } from "@/shared/lib/model-catalog";
import {
  catalogFallbackModel,
  modelDisplayName,
  modelProviderSlug,
} from "@/shared/lib/model-provider";
import { getActiveLocale } from "@/shared/lib/runtime-locale";
import {
  AgentThread,
  ChatTranscript,
  Composer,
  QuestionChoices,
  QuestionChoicesSkeleton,
  type AgentMessage,
  type AgentThinking,
} from "@/shared/ui/agent";
import { LoadingState } from "@/shared/ui/loading-state";
import { ProviderLogo } from "@/shared/ui/provider-logo";
import type { ModelCatalogResponse } from "@/shared/types/api";

import {
  requestTurns,
  type IntakeLlmPhase,
  type IntakeTurn,
  type IntakeTurnOutcome,
} from "../lib/intake";
import type { InterviewOption } from "@/shared/lib/api";

interface Props {
  phase: IntakeLlmPhase;
  /** This phase's transcript so far (from the draft). */
  turns: IntakeTurn[];
  /** The last question's answer options (from the draft). */
  options: InterviewOption[];
  /** What the user has answered so far, in the interviewer's vocabulary. */
  profile: Record<string, unknown>;
  /** A turn finished; `sent` is the transcript the request carried. */
  onTurn: (sent: IntakeTurn[], outcome: IntakeTurnOutcome) => void;
  /** The interviewer is unreachable; the setup switches to fixed questions. */
  onFail: () => void;
}

/**
 * One open setup question asked by the interviewer: the shared agent chat
 * (streamed reply, thinking, answer cards, composer), driving
 * `/account/intake-interview`. The transcript lives in the setup's draft so
 * it survives a reload; only the in-flight stream is local.
 */
export function IntakeInterview({ phase, turns, options, profile, onTurn, onFail }: Props) {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [streamText, setStreamText] = React.useState("");
  const [thinking, setThinking] = React.useState<AgentThinking | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sending, setSending] = React.useState<IntakeTurn[] | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // The model the server reported for the last turn; before any turn lands,
  // the catalog's interview default is what will run.
  const [servedModel, setServedModel] = React.useState<string | null>(null);
  const [catalog, setCatalog] = React.useState<ModelCatalogResponse | null>(() => cachedCatalog());
  React.useEffect(() => {
    let cancelled = false;
    getModelCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onTurnRef = React.useRef(onTurn);
  const onFailRef = React.useRef(onFail);
  const profileRef = React.useRef(profile);
  React.useEffect(() => {
    onTurnRef.current = onTurn;
    onFailRef.current = onFail;
    profileRef.current = profile;
  });

  const run = React.useCallback(
    (sent: IntakeTurn[]) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setSending(sent);
      setBusy(true);
      setStreamText("");
      setThinking(null);
      setPending(false);
      const settle = () => {
        setBusy(false);
        setStreamText("");
        setThinking(null);
        setPending(false);
        setSending(null);
      };
      void streamIntakeInterviewTurn(
        {
          phase,
          turns: requestTurns(sent),
          profile: profileRef.current,
          locale: getActiveLocale(),
        },
        {
          signal: controller.signal,
          onReasoningPatch: (chunk) =>
            setThinking((prev) => ({
              reasoning: (prev?.reasoning ?? "") + chunk,
              startedAt: prev?.startedAt ?? Date.now(),
              endedAt: null,
              streaming: true,
            })),
          onMessagePatch: (chunk) => {
            setThinking((prev) =>
              prev && prev.streaming ? { ...prev, streaming: false, endedAt: Date.now() } : prev,
            );
            setStreamText((text) => text + chunk);
          },
          onMessageEnd: () => setPending(true),
          // A finished phase brings no cards, so there is nothing to wait for.
          onTurnHint: (final) => setPending(!final),
          onMessageReset: () => {
            setStreamText("");
            setThinking(null);
            setPending(false);
          },
          onDone: (turn) => {
            settle();
            const ran = turn.served_model ?? turn.model ?? null;
            if (ran) setServedModel(ran);
            onTurnRef.current(sent, turn);
          },
          onError: () => {
            settle();
            onFailRef.current();
          },
        },
      ).finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
    },
    [phase],
  );

  /*
   * Ask when the phase opens, and again after a reload that landed between
   * an answer and its reply. The timer absorbs StrictMode's double effect.
   */
  const lastRole = turns[turns.length - 1]?.role;
  React.useEffect(() => {
    if (turns.length > 0 && lastRole !== "user") return;
    const timer = setTimeout(() => run(turns), 0);
    return () => clearTimeout(timer);
    // Only the phase opening (or a resumed user answer) starts a turn.
  }, [phase]);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStreamText("");
    setThinking(null);
    setPending(false);
    setSending(null);
    // Stopped before the first question: nothing to answer, so ask the fixed one.
    if (turns.length === 0) onFailRef.current();
  };

  const send = (content: string) => {
    const text = content.trim();
    if (!text || busy) return;
    setDraft("");
    run([...turns, { role: "user", content: text }]);
  };

  const availableModels = catalog?.models.filter((m) => m.available) ?? [];
  const runningModel =
    servedModel ?? catalogFallbackModel(availableModels, "is_interview_default")?.value ?? null;

  const shown = sending ?? turns;
  const messages: AgentMessage[] = shown.map((t) => ({ role: t.role, content: t.content }));
  if (busy && (streamText || thinking)) messages.push({ role: "assistant", content: streamText });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentThread
        className="px-5 sm:px-7"
        scrollDeps={[messages.length, streamText, thinking?.reasoning]}
        isEmpty={messages.length === 0}
        emptyState={
          <LoadingState label={msg("experience.intake.chat.reading")} className="h-full py-0" />
        }
      >
        <ChatTranscript
          messages={messages}
          streaming={busy}
          // Earlier answers are edited on the summary, not re-sent here.
          editAndResend={() => {}}
          thinking={thinking ?? undefined}
          animatePairs
        />
      </AgentThread>

      {!busy && options.length > 0 && (
        <QuestionChoices
          className="px-5 sm:px-7"
          options={options}
          onSelect={(label) => send(label)}
          hint={msg("experience.intake.chat.choices_hint")}
          ariaLabel={msg("experience.intake.chat.choices_label")}
        />
      )}
      {busy && pending && <QuestionChoicesSkeleton className="px-5 sm:px-7" />}

      <Composer
        className="px-5 sm:px-7"
        value={draft}
        onChange={setDraft}
        onSubmit={() => send(draft)}
        onStop={stop}
        disabled={busy && messages.length === 0}
        streaming={busy}
        placeholder={msg("experience.intake.chat.placeholder")}
      />
      {runningModel && (
        <p className="flex items-center gap-1.5 px-5 pb-2 text-xs text-muted-foreground sm:px-7">
          <span>{msg("experience.intake.chat.running_on")}</span>
          <ProviderLogo slug={modelProviderSlug(runningModel)} size={14} />
          <span className="min-w-0 truncate" dir="ltr">
            {modelDisplayName(runningModel, catalog?.models)}
          </span>
        </p>
      )}
    </div>
  );
}
