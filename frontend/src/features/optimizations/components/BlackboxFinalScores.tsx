"use client";

import { formatBlackboxScore } from "@/shared/lib/formatters";
import { msg } from "@/shared/lib/messages";
import { sideInfoFeedback, sideInfoNamedScores } from "@/shared/lib/blackbox-scores";
import type { BlackboxNamedScore } from "@/shared/types/api";

function Feedback({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p
      className="mt-0.5 whitespace-pre-wrap break-words text-[0.6875rem] font-normal text-muted-foreground"
      dir="auto"
    >
      {text}
    </p>
  );
}

/** The scorer's feedback and named scores on one version, as the run recorded them. */
export function VersionFeedback({ sideInfo }: { sideInfo: Record<string, unknown> }) {
  const feedback = sideInfoFeedback(sideInfo);
  const named: Array<[string, BlackboxNamedScore]> = Object.entries(sideInfoNamedScores(sideInfo));
  if (!feedback && named.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
      {feedback && (
        <div>
          <p className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground">
            {msg("optimization.blackbox.versions.feedback")}
          </p>
          <p
            className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/90"
            dir="auto"
          >
            {feedback}
          </p>
        </div>
      )}
      {named.length > 0 && (
        <ul className="space-y-1.5" aria-label={msg("optimization.blackbox.final.named_title")}>
          {named.map(([name, entry]) => (
            <li key={name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-xs" dir="auto">
                  {name}
                </span>
                <span className="font-mono text-xs font-semibold tabular-nums" dir="ltr">
                  {formatBlackboxScore(entry.score)}
                </span>
              </div>
              <Feedback text={entry.feedback} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
