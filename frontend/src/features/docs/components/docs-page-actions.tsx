"use client";

import { ArrowSquareOut, FileMd } from "@/shared/ui/icons";
import { CopyGlyph, useCopyToClipboard } from "@/shared/ui/copy-button";

const ACTION_CLASS =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/**
 * Page tools for readers who work with AI assistants: copy the page as
 * Markdown, open its Markdown twin, or start a chat that reads the page.
 */
export function DocsPageActions({
  markdown,
  markdownHref,
  prompt,
  labels,
}: {
  markdown: string;
  markdownHref: string;
  prompt: string;
  labels: { copyPage: string; copied: string; viewMarkdown: string; openInChatGpt: string; openInClaude: string };
}) {
  const { copied, copy } = useCopyToClipboard();
  const q = encodeURIComponent(prompt);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={ACTION_CLASS} onClick={() => void copy(markdown)}>
        <CopyGlyph copied={copied} className="size-3.5" />
        <span aria-live="polite">{copied ? labels.copied : labels.copyPage}</span>
      </button>
      <a className={ACTION_CLASS} href={markdownHref}>
        <FileMd className="size-3.5" aria-hidden="true" />
        {labels.viewMarkdown}
      </a>
      <a className={ACTION_CLASS} href={`https://chatgpt.com/?q=${q}`} target="_blank" rel="noopener noreferrer">
        <ArrowSquareOut className="size-3.5" aria-hidden="true" />
        {labels.openInChatGpt}
      </a>
      <a className={ACTION_CLASS} href={`https://claude.ai/new?q=${q}`} target="_blank" rel="noopener noreferrer">
        <ArrowSquareOut className="size-3.5" aria-hidden="true" />
        {labels.openInClaude}
      </a>
    </div>
  );
}
