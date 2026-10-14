"use client";

import * as React from "react";
import dynamic from "next/dynamic";

import { looksLikeMarkdown } from "@/shared/lib/markdown-hint";
import { cn } from "@/shared/lib/utils";

// Lazy so the parser stays out of first-load chunks; the effect below warms
// it on mount, so the first paste renders without a visible wait.
const MessageMarkdown = dynamic(
  () => import("@/shared/ui/agent/message-markdown").then((m) => m.MessageMarkdown),
  { ssr: false },
);

interface MarkdownPreviewFieldProps {
  /** The textarea's value. Omit for an uncontrolled textarea; the field then
   *  reads the text from the textarea itself. */
  value?: string;
  /** The textarea to preview. Its own props and handlers are left untouched. */
  children: React.ReactNode;
  className?: string;
  /** Padding for the rendered layer, matching the textarea's own padding so
   *  the text does not jump when the two swap. */
  previewClassName?: string;
}

/**
 * Wraps a textarea so markdown in it shows rendered: right after a paste that
 * contains markdown, and whenever the box is not being edited. Clicking the
 * rendered text or pressing any key brings back the raw text for editing.
 * The textarea stays mounted underneath, so focus, submit and screen readers
 * keep working on the real text.
 */
export function MarkdownPreviewField({
  value,
  children,
  className,
  previewClassName = "px-3 py-2",
}: MarkdownPreviewFieldProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [editing, setEditing] = React.useState(false);
  const [domText, setDomText] = React.useState("");
  const text = value ?? domText;
  const showPreview = !editing && looksLikeMarkdown(text);

  React.useEffect(() => {
    void import("@/shared/ui/agent/message-markdown");
  }, []);

  const isTextarea = (target: EventTarget) => target instanceof HTMLTextAreaElement;

  const editRaw = (event: React.MouseEvent) => {
    // Keep the click from blurring the textarea before it is focused.
    event.preventDefault();
    setEditing(true);
    wrapRef.current?.querySelector("textarea")?.focus();
  };

  return (
    <div
      ref={wrapRef}
      data-md-preview={showPreview || undefined}
      className={cn(
        "relative",
        "[&[data-md-preview]_textarea]:text-transparent [&[data-md-preview]_textarea]:caret-transparent",
        className,
      )}
      onFocusCapture={(event) => {
        if (isTextarea(event.target)) setEditing(true);
      }}
      onBlurCapture={(event) => {
        if (!isTextarea(event.target)) return;
        setEditing(false);
        setDomText((event.target as HTMLTextAreaElement).value);
      }}
      onKeyDownCapture={(event) => {
        if (isTextarea(event.target)) setEditing(true);
      }}
      onPasteCapture={(event) => {
        // A paste key press already switched to raw text; a paste carrying
        // markdown switches straight back to the rendered view.
        if (isTextarea(event.target) && looksLikeMarkdown(event.clipboardData.getData("text"))) {
          setEditing(false);
        }
      }}
      onInputCapture={(event) => {
        if (value === undefined && isTextarea(event.target)) {
          setDomText((event.target as HTMLTextAreaElement).value);
        }
      }}
    >
      {children}
      {showPreview && (
        <div
          aria-hidden="true"
          dir="auto"
          onMouseDown={editRaw}
          className={cn(
            "absolute inset-0 cursor-text overflow-y-auto text-sm leading-relaxed text-foreground",
            previewClassName,
          )}
        >
          <React.Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
            <MessageMarkdown content={text} />
          </React.Suspense>
        </div>
      )}
    </div>
  );
}
