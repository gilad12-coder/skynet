"use client";

import type { KeyboardEvent, MouseEvent } from "react";

import { ArrowUpRight, FileText, GithubLogo } from "@/shared/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";

import type { OptimizerSource } from "../../lib/optimizer-sources";

// The links sit inside the optimizer radiogroup: a click must not reach a
// card's select handler, and arrow keys on a focused link must not reach the
// group's roving-selection handler.
function keepSelection(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

/**
 * The paper and code links of one optimizer card. They render beside the
 * card's radio button, never inside it, so each link stays a real link.
 */
export function OptimizerSourceLinks({
  optimizerName,
  sources,
  className = "",
}: {
  optimizerName: string;
  sources: readonly OptimizerSource[];
  className?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <ul
      aria-label={msg("submit.v2.optimizer.source.list_aria", { p1: optimizerName })}
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
    >
      {sources.map((source) => {
        const Icon = source.kind === "paper" ? FileText : GithubLogo;
        return (
          <li key={source.url}>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={msg(
                    source.kind === "paper"
                      ? "submit.v2.optimizer.source.paper_aria"
                      : "submit.v2.optimizer.source.code_aria",
                    { p1: source.title },
                  )}
                  onClick={keepSelection}
                  onKeyDown={keepSelection}
                  className="group/src inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-background/80 px-2 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="size-3 shrink-0" aria-hidden="true" />
                  <span>
                    {msg(
                      source.kind === "paper"
                        ? "submit.v2.optimizer.source.paper"
                        : "submit.v2.optimizer.source.code",
                    )}
                  </span>
                  <ArrowUpRight
                    className="size-2.5 shrink-0 opacity-60 transition-opacity group-hover/src:opacity-100 rtl:-scale-x-100"
                    aria-hidden="true"
                  />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72 leading-relaxed" dir={getActiveDir()}>
                <span dir="ltr">{source.title}</span>
              </TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
