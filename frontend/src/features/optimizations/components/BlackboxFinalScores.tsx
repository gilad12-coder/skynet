"use client";

import { useState } from "react";
import { CaretDown } from "@/shared/ui/icons";
import { ProgressBar } from "@/shared/ui/progress-bar";
import { formatBlackboxScore } from "@/shared/lib/formatters";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { sideInfoFeedback, sideInfoNamedScores } from "@/shared/lib/blackbox-scores";
import type { BlackboxNamedScore } from "@/shared/types/api";

/** `hebrew_parity` reads as "Hebrew parity"; names that are not plain identifiers stay as written. */
function displayName(name: string): string {
  if (!/^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/.test(name)) return name;
  const words = name.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Scorers join their checks with semicolons; one check per line is easier to scan. */
function feedbackClauses(text: string): string[] {
  return text
    .split(/;\s+/)
    .map((part) => part.trim().replace(/\.$/, ""))
    .filter((part) => part.length > 0);
}

function Clauses({ text }: { text: string }) {
  const clauses = feedbackClauses(text);
  if (clauses.length < 2) {
    return (
      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground" dir="auto">
        {text}
      </p>
    );
  }
  return (
    <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground marker:text-border">
      {clauses.map((clause, i) => (
        <li key={i} className="break-words" dir="auto">
          {clause}
        </li>
      ))}
    </ul>
  );
}

/** The scorer's feedback and named scores on one version, as the run recorded them. */
export function VersionFeedback({ sideInfo }: { sideInfo: Record<string, unknown> }) {
  const [showFull, setShowFull] = useState(false);
  const feedback = sideInfoFeedback(sideInfo);
  // Weakest first: that is where the next version has room to improve.
  const named: Array<[string, BlackboxNamedScore]> = Object.entries(
    sideInfoNamedScores(sideInfo),
  ).sort(([, a], [, b]) => a.score - b.score);
  if (!feedback && named.length === 0) return null;
  const unitScale = named.every(
    ([, e]) => Number.isFinite(e.score) && e.score >= 0 && e.score <= 1,
  );
  // Many scorers build the overall text by joining the named feedback, so it
  // only repeats the list below; keep it one click away instead of up front.
  const redundant =
    !!feedback &&
    named.length > 0 &&
    named.every(([, e]) => !e.feedback || feedback.includes(e.feedback.trim().replace(/\.$/, "")));
  const fullId = "version-feedback-full";

  return (
    <section
      aria-label={msg("optimization.blackbox.versions.feedback")}
      className="@container rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground">
          {msg("optimization.blackbox.versions.feedback")}
        </h3>
        {redundant && (
          <button
            type="button"
            aria-expanded={showFull}
            aria-controls={fullId}
            onClick={() => setShowFull((v) => !v)}
            className="inline-flex items-center gap-1 rounded text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {msg(
              showFull
                ? "optimization.blackbox.versions.feedback_full_hide"
                : "optimization.blackbox.versions.feedback_full_show",
            )}
            <CaretDown
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform motion-reduce:transition-none",
                showFull && "rotate-180",
              )}
            />
          </button>
        )}
      </div>

      {feedback && (!redundant || showFull) && (
        <p
          id={fullId}
          className="mt-1.5 whitespace-pre-wrap break-words text-xs text-foreground/90"
          dir="auto"
        >
          {feedback}
        </p>
      )}

      {named.length > 0 && (
        <ul
          className="mt-2 grid gap-x-6 gap-y-3 @xl:grid-cols-2"
          aria-label={msg("optimization.blackbox.final.named_title")}
        >
          {named.map(([name, entry]) => (
            <li key={name} className="min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="truncate text-xs font-medium text-foreground"
                  dir="auto"
                  title={name}
                >
                  {displayName(name)}
                </span>
                <span
                  className="font-mono text-xs font-semibold tabular-nums"
                  dir="ltr"
                  title={formatBlackboxScore(entry.score)}
                >
                  {unitScale ? entry.score.toFixed(2) : formatBlackboxScore(entry.score)}
                </span>
              </div>
              {unitScale && <ProgressBar value={entry.score * 100} size="sm" aria-hidden="true" />}
              {entry.feedback && (
                <div className="pt-0.5">
                  <Clauses text={entry.feedback} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
