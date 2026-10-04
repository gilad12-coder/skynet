"use client";

import * as React from "react";
import { Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { cn } from "@/shared/lib/utils";

/**
 * Focus a just-appended field without the native focus jump: ``focus()``
 * yanks the nearest scroll container to the element instantly, which reads
 * as the list "jumping" at the add button. Focus is taken without scrolling,
 * then the reveal happens as its own smooth glide (instant under
 * reduced-motion).
 */
export function focusAppendedField(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({
    block: "nearest",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

/** The numbered marker, shared with loading skeletons that prefigure the list. */
export const RULE_MARKER_CLASS =
  "flex size-5 shrink-0 select-none items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground";

interface RuleListProps {
  rules: string[];
  onChange: (rules: string[]) => void;
  /** Accessible name of the n-th (1-based) rule's field. */
  itemLabel: (number: number) => string;
  removeLabel: string;
  addLabel: string;
  placeholder?: string;
  /** Shown in place of the list when there are no rules. */
  emptyLabel?: string;
  className?: string;
}

/**
 * An editable, numbered list of short text rules: hairline dividers between
 * rows, each rule edited in place on a surface that only shows itself on
 * hover and focus, so the list reads as a document rather than a stack of
 * input boxes. Enter starts a new rule after the current one (Shift+Enter
 * breaks the line), Backspace on an empty rule removes it.
 */
export function RuleList({
  rules,
  onChange,
  itemLabel,
  removeLabel,
  addLabel,
  placeholder,
  emptyLabel,
  className,
}: RuleListProps) {
  const fields = React.useRef<Array<HTMLTextAreaElement | null>>([]);
  // The row to focus once the next render has mounted it.
  const pendingFocus = React.useRef<number | null>(null);

  React.useEffect(() => {
    const idx = pendingFocus.current;
    if (idx === null) return;
    pendingFocus.current = null;
    const el = fields.current[idx];
    if (!el) return;
    focusAppendedField(el);
    el.setSelectionRange(el.value.length, el.value.length);
  });

  const update = (idx: number, value: string) =>
    onChange(rules.map((r, i) => (i === idx ? value : r)));
  const remove = (idx: number, focusAfter?: number) => {
    pendingFocus.current = focusAfter ?? null;
    onChange(rules.filter((_, i) => i !== idx));
  };
  const insertAt = (idx: number) => {
    pendingFocus.current = idx;
    onChange([...rules.slice(0, idx), "", ...rules.slice(idx)]);
  };

  const onKeyDown = (idx: number) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insertAt(idx + 1);
    } else if (e.key === "Backspace" && rules[idx] === "" && rules.length > 1) {
      e.preventDefault();
      remove(idx, Math.max(0, idx - 1));
    }
  };

  return (
    <div className={cn("flex flex-col", className)}>
      {rules.length === 0 && emptyLabel ? (
        <p className="py-2 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border/50">
          {rules.map((rule, idx) => (
            <li
              key={idx}
              className="group/rule flex items-start gap-2.5 py-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
            >
              <span
                aria-hidden
                className={cn(
                  RULE_MARKER_CLASS,
                  "mt-[7px] transition-colors duration-150",
                  "group-focus-within/rule:bg-primary/12 group-focus-within/rule:text-primary",
                )}
              >
                {idx + 1}
              </span>
              <AutoGrowTextarea
                ref={(el) => {
                  fields.current[idx] = el;
                }}
                value={rule}
                onChange={(e) => update(idx, e.target.value)}
                onKeyDown={onKeyDown(idx)}
                placeholder={placeholder}
                aria-label={itemLabel(idx + 1)}
                dir="auto"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => remove(idx, idx < rules.length - 1 ? idx : idx - 1)}
                aria-label={removeLabel}
                className={cn(
                  "mt-0.5 text-muted-foreground hover:text-destructive",
                  // Hover-capable pointers reveal the action with the row;
                  // touch keeps it visible since there is no hover.
                  "transition-opacity duration-150 [@media(hover:hover)]:opacity-0",
                  "[@media(hover:hover)]:group-hover/rule:opacity-100 group-focus-within/rule:opacity-100",
                )}
              >
                <Trash className="size-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        onClick={() => insertAt(rules.length)}
        className={cn(
          "group/add flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-2 text-start text-sm text-muted-foreground transition-colors duration-150",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          rules.length > 0 && "border-t border-border/50",
        )}
      >
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors duration-150 group-hover/add:border-primary/50 group-hover/add:text-primary"
        >
          <Plus className="size-3" />
        </span>
        {addLabel}
      </button>
    </div>
  );
}

/**
 * A borderless textarea that grows with its content, so a rule always shows
 * in full. Height tracks both the value and the width it wraps at.
 */
const AutoGrowTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(function AutoGrowTextarea({ className, value, ...props }, forwardedRef) {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);

  const fit = React.useCallback(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  React.useLayoutEffect(fit, [fit, value]);

  React.useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    // Only width changes re-wrap the text; reacting to height would loop.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      value={value}
      rows={1}
      className={cn(
        "min-w-0 flex-1 resize-none overflow-hidden rounded-lg bg-transparent px-2 py-1 text-base leading-relaxed text-foreground outline-none md:text-sm",
        "placeholder:text-muted-foreground/70 transition-[background-color,box-shadow] duration-150",
        "hover:bg-muted/50 focus-visible:bg-background focus-visible:shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    />
  );
});
