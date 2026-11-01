"use client";

import type * as React from "react";
import { Claude, OpenAI } from "@lobehub/icons";
import { FileMd } from "@/shared/ui/icons";
import { CopyGlyph, useCopyToClipboard } from "@/shared/ui/copy-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";

const ACTION_CLASS =
  "inline-flex size-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45";

/** One icon button with its label as tooltip and accessible name. */
function Action({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

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
  labels: {
    copyPage: string;
    copied: string;
    viewMarkdown: string;
    openInChatGpt: string;
    openInClaude: string;
  };
}) {
  const { copied, copy } = useCopyToClipboard();
  const q = encodeURIComponent(prompt);
  const copyLabel = copied ? labels.copied : labels.copyPage;
  return (
    <div className="inline-flex h-8 items-center gap-0.5 rounded-md border border-border p-0.5">
      <Action label={copyLabel}>
        <button
          type="button"
          aria-label={copyLabel}
          className={ACTION_CLASS}
          onClick={() => void copy(markdown)}
        >
          <CopyGlyph copied={copied} className="size-3.5" />
        </button>
      </Action>
      <Action label={labels.viewMarkdown}>
        <a aria-label={labels.viewMarkdown} className={ACTION_CLASS} href={markdownHref}>
          <FileMd className="size-3.5" aria-hidden="true" />
        </a>
      </Action>
      <Action label={labels.openInChatGpt}>
        <a
          aria-label={labels.openInChatGpt}
          className={ACTION_CLASS}
          href={`https://chatgpt.com/?q=${q}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <OpenAI size={14} aria-hidden="true" />
        </a>
      </Action>
      <Action label={labels.openInClaude}>
        <a
          aria-label={labels.openInClaude}
          className={ACTION_CLASS}
          href={`https://claude.ai/new?q=${q}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Claude size={14} aria-hidden="true" />
        </a>
      </Action>
      <span className="sr-only" aria-live="polite">
        {copied ? labels.copied : ""}
      </span>
    </div>
  );
}
