"use client";

import * as React from "react";
import { Check, CircleNotch, Microphone, Square, X } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";

import { useLocale } from "@/shared/providers";
import { useUserPrefs } from "@/features/settings";
import { Button } from "@/shared/ui/primitives/button";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { cn } from "@/shared/lib/utils";
import { MarkdownPreviewField } from "@/shared/ui/markdown-preview-field";

import { autoResizeTextarea } from "./auto-resize";
import { PastedTextCard } from "./pasted-text-card";
import { joinPastes, shouldAttachPaste, splitPastes } from "./pasted-text";
import { PendingMessages } from "./pending-messages";
import { appendToDraft, midTurnKeyAction, type MidTurnQueue } from "./steer-queue";
import { formatRecSeconds, useDictation } from "./use-dictation";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  streaming?: boolean;
  sendAriaLabel?: string;
  stopAriaLabel?: string;
  /** Optional model selector chip rendered at the inline start of the control row. */
  modelMenu?: React.ReactNode;
  /** Optional controls rendered after the model selector, such as attachment
   *  and permission controls. */
  leadingControls?: React.ReactNode;
  /** Keep controls below the draft by default; model-free playgrounds can opt
   *  into a single row. */
  layout?: "stacked" | "inline";
  className?: string;
  /** Opts the chat into mid-turn input: typing and dictating stay open while
   *  a turn streams, Enter steers (or queues) and Tab queues. Without it the
   *  composer locks while streaming. */
  midTurn?: MidTurnQueue;
}

/**
 * The shared chat composer, laid out Codex-style: one bordered box holding a
 * borderless textarea with a control row docked under it — attachment and
 * permission controls follow the model chip at the inline start, while the
 * dictation mic and circular send/stop button sit at the inline end. While
 * dictating, the textarea swaps for a recording strip (pulsing dot, timer,
 * cancel) and the mic becomes the finish control; the transcript is appended
 * to the draft for review, never auto-sent.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  disabled,
  streaming,
  sendAriaLabel = msg("auto.shared.ui.agent.composer.literal.1"),
  stopAriaLabel = msg("auto.shared.ui.agent.composer.literal.2"),
  modelMenu,
  leadingControls,
  layout = "stacked",
  className,
  midTurn,
}: ComposerProps) {
  const inline = layout === "inline";
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const { locale } = useLocale();
  const { prefs } = useUserPrefs();

  const valueRef = React.useRef(value);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const dictation = useDictation({
    language: locale,
    onText: (text) => {
      const prev = valueRef.current;
      onChange(prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text);
      // The textarea remounts from the recording strip on this same commit —
      // focus and grow it once it's back in the tree.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          autoResizeTextarea(el);
        }
      });
    },
  });
  const dictating = dictation.state.kind !== "idle";
  // A recording in flight keeps its controls even if the pref flips off in
  // the settings modal mid-take.
  const showMic = prefs.dictationEnabled || dictating;
  // Without a mid-turn handler a streaming turn locks the input as before.
  const locked = Boolean(streaming && !midTurn);
  const hasDraft = value.trim().length > 0;
  // Long pastes live in `value` as tagged blocks; the textarea only edits
  // what was typed, and each block shows as a card above it.
  const draft = splitPastes(value);
  const setPastes = (pastes: string[], text = draft.text) => onChange(joinPastes({ text, pastes }));

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (!shouldAttachPaste(pasted)) return;
    e.preventDefault();
    setPastes([...draft.pastes, pasted]);
  };

  const resetHeight = () => {
    if (textareaRef.current) textareaRef.current.style.height = inline ? "36px" : "42px";
  };

  const refocus = () =>
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        autoResizeTextarea(el);
      }
    });

  const sendMidTurn = (mode: "steer" | "queue") => {
    if (!midTurn || disabled || dictating || !hasDraft) return;
    if (mode === "steer") midTurn.steer(value);
    else midTurn.queue(value);
    onChange("");
    resetHeight();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (streaming) {
      sendMidTurn(midTurn?.canSteer ? "steer" : "queue");
      return;
    }
    if (disabled || dictating || !hasDraft) return;
    onSubmit();
    resetHeight();
  };

  const editPending = async (id: string) => {
    const text = await midTurn?.edit(id);
    if (text == null) return;
    onChange(appendToDraft(valueRef.current, text));
    refocus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (midTurn && !disabled) {
      const action = midTurnKeyAction(e, {
        streaming: Boolean(streaming),
        draft: value,
        canSteer: midTurn.canSteer,
        queuedCount: midTurn.queued.length,
      });
      if (action === "recall") {
        const text = midTurn.recallLast();
        if (text !== null) {
          e.preventDefault();
          onChange(text);
          refocus();
        }
        return;
      }
      if (action) {
        e.preventDefault();
        sendMidTurn(action);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("border-t border-border/40 px-3 py-3 shrink-0", className)}
    >
      {midTurn && (
        <PendingMessages
          queued={midTurn.queued}
          steering={midTurn.steering}
          canPromote={midTurn.canSteer}
          onPromote={midTurn.promote}
          onEdit={(id) => void editPending(id)}
          onRemove={midTurn.remove}
          onReorderQueued={midTurn.reorderQueued}
          onReorderSteering={midTurn.reorderSteering}
        />
      )}
      <div
        className={cn(
          "rounded-2xl border border-border bg-muted/20 transition-colors",
          "focus-within:border-primary-fill",
          inline && "flex min-h-[44px] items-end gap-1 p-1",
        )}
      >
        {draft.pastes.length > 0 && !inline && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {draft.pastes.map((paste, i) => (
              <PastedTextCard
                key={i}
                text={paste}
                onRemove={() => setPastes(draft.pastes.filter((_, j) => j !== i))}
                onRestore={() => {
                  setPastes(
                    draft.pastes.filter((_, j) => j !== i),
                    draft.text ? `${draft.text.replace(/\s+$/, "")}\n\n${paste}` : paste,
                  );
                  refocus();
                }}
              />
            ))}
          </div>
        )}
        {!dictating ? (
          <MarkdownPreviewField
            value={draft.text}
            className={inline ? "min-w-0 flex-1" : undefined}
            previewClassName={inline ? "px-3 py-2" : "px-4 py-[11px]"}
          >
            <textarea
              ref={textareaRef}
              value={draft.text}
              onChange={(e) => {
                onChange(joinPastes({ text: e.target.value, pastes: draft.pastes }));
                autoResizeTextarea(e.target);
              }}
              onPaste={inline ? undefined : handlePaste}
              onKeyDown={handleKeyDown}
              disabled={disabled || locked}
              rows={1}
              placeholder={placeholder}
              className={cn(
                "bg-transparent text-sm leading-[20px] resize-none overflow-hidden",
                "max-h-[120px] outline-none ring-0 border-0 shadow-none",
                "focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                "placeholder:text-muted-foreground/40",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                inline
                  ? "block h-[44px] w-full px-3 py-2 sm:h-9 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
                  : "block h-[44px] w-full px-4 py-[11px] sm:h-[42px] [@media(hover:none)_and_(pointer:coarse)]:h-[44px]",
              )}
            />
          </MarkdownPreviewField>
        ) : (
          <div
            className={cn(
              "flex items-center gap-2 text-sm",
              inline
                ? "h-[44px] min-w-0 flex-1 px-3 sm:h-9 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
                : "h-[44px] px-4 sm:h-[42px] [@media(hover:none)_and_(pointer:coarse)]:h-[44px]",
            )}
            role="status"
            aria-live="polite"
          >
            {dictation.state.kind === "rec" && (
              <>
                <span className="size-2 shrink-0 rounded-full bg-[var(--danger)] motion-safe:animate-pulse" />
                <span className="tabular-nums text-muted-foreground" dir="ltr">
                  {formatRecSeconds(dictation.seconds)}
                </span>
                <span className="truncate text-muted-foreground">
                  {msg("agent.composer.recording")}
                </span>
                <button
                  type="button"
                  onClick={dictation.cancel}
                  aria-label={msg("agent.composer.record_cancel")}
                  className="close-button ms-auto shrink-0"
                >
                  <X />
                </button>
              </>
            )}
            {dictation.state.kind === "busy" && (
              <>
                <CircleNotch className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="truncate text-muted-foreground">
                  {msg("agent.composer.transcribing")}
                </span>
              </>
            )}
            {dictation.state.kind === "err" && (
              <span
                className="line-clamp-2 text-xs leading-snug text-destructive"
                title={dictation.state.message}
              >
                {dictation.state.message}
              </span>
            )}
          </div>
        )}

        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            inline ? "shrink-0" : "px-2 pb-2 pt-0.5",
          )}
        >
          {modelMenu}
          {leadingControls && (
            <div className="flex min-w-0 items-center gap-1">{leadingControls}</div>
          )}
          <div className="ms-auto flex min-w-0 items-center justify-end gap-1.5">
            {showMic &&
              (dictation.state.kind === "rec" ? (
                <TooltipButton tooltip={msg("agent.composer.record_finish")} side="top">
                  <Button
                    type="button"
                    size="icon"
                    onClick={dictation.finish}
                    className="shrink-0 rounded-full"
                    aria-label={msg("agent.composer.record_finish")}
                  >
                    <Check className="size-4" />
                  </Button>
                </TooltipButton>
              ) : (
                <TooltipButton tooltip={msg("agent.composer.record")} side="top">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => void dictation.start()}
                    disabled={disabled || locked || dictation.state.kind === "busy"}
                    className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label={msg("agent.composer.record")}
                  >
                    <Microphone className="size-4" />
                  </Button>
                </TooltipButton>
              ))}
            {(!streaming || !onStop || (midTurn && hasDraft)) && (
              <Button
                type="submit"
                size="icon"
                autoTooltip={false}
                className="shrink-0 rounded-full"
                disabled={disabled || dictating || !hasDraft}
                aria-label={sendAriaLabel}
              >
                <svg viewBox="0 0 24 24" fill="none" className="size-4">
                  <path
                    d="M12 2L12 22M12 2L5 9M12 2L19 9"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            )}
            {streaming && onStop && (
              <TooltipButton tooltip={stopAriaLabel} side="top">
                <Button
                  type="button"
                  size="icon"
                  onClick={onStop}
                  className="shrink-0 rounded-full"
                  aria-label={stopAriaLabel}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </TooltipButton>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
