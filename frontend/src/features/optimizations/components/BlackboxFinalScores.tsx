"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/primitives/table";
import { FadeIn } from "@/shared/ui/motion";
import { HelpTip } from "@/shared/ui/help-tip";
import { formatBlackboxScore } from "@/shared/lib/formatters";
import { formatMsg, msg } from "@/shared/lib/messages";
import { tip } from "@/shared/lib/tooltips";
import {
  namedScoreRows,
  sideInfoFeedback,
  sideInfoNamedScores,
} from "@/shared/lib/blackbox-scores";
import type { BlackboxNamedScore, BlackboxRunResult } from "@/shared/types/api";

const PANEL = "rounded-xl border border-[#E3DCD0] bg-[#FBF9F4] px-4 py-3.5";
const CAPTION =
  "pb-2 text-start text-[0.6875rem] font-medium tracking-wide text-muted-foreground";
const HEAD = "h-auto px-0 pb-1.5 text-[0.6875rem] font-medium text-muted-foreground/70";

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

function ScoreCell({
  entry,
  strong = false,
}: {
  entry: { score: number | null | undefined; feedback?: string | null } | null;
  strong?: boolean;
}) {
  return (
    <TableCell className="px-0 py-2 ps-4 align-top text-start">
      <span
        dir="ltr"
        className={`font-mono text-xs tabular-nums ${strong ? "font-semibold text-primary" : "text-muted-foreground"}`}
      >
        {formatBlackboxScore(entry?.score)}
      </span>
      <Feedback text={entry?.feedback} />
    </TableCell>
  );
}

/**
 * The final run of a black-box optimization: the starting version and the
 * winner scored afresh. Shows the scorer's feedback on each, every named
 * score with its own feedback, and a per-case table when the run had cases.
 * Runs recorded before the final run existed carry none of this and render
 * nothing.
 */
export function BlackboxFinalScores({ result }: { result: BlackboxRunResult }) {
  const named = namedScoreRows(result);
  const cases = result.case_results ?? [];
  const hasFeedback = Boolean(result.baseline_feedback || result.best_feedback);
  if (!hasFeedback && named.length === 0 && cases.length === 0) return null;
  const hasBaseline = result.baseline_score != null || cases.some((c) => c.baseline_score != null);

  return (
    <FadeIn delay={0.1}>
      <div className="space-y-3">
        {hasFeedback && (
          <div className={`${PANEL} grid gap-3 sm:grid-cols-2`}>
            {result.baseline_feedback && (
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground">
                  {msg("optimization.blackbox.final.baseline_feedback")}
                </p>
                <Feedback text={result.baseline_feedback} />
              </div>
            )}
            {result.best_feedback && (
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground">
                  {msg("optimization.blackbox.final.best_feedback")}
                </p>
                <Feedback text={result.best_feedback} />
              </div>
            )}
          </div>
        )}

        {named.length > 0 && (
          <div className={PANEL}>
            <Table className="no-copy-underline caption-top text-xs">
              <caption className={CAPTION}>
                <HelpTip text={tip("blackbox.final.named_scores")}>
                  {msg("optimization.blackbox.final.named_title")}
                </HelpTip>
              </caption>
              <TableHeader className="static bg-transparent backdrop-blur-none">
                <TableRow>
                  <TableHead className={`${HEAD} w-1/4`}>
                    {msg("optimization.blackbox.final.name_col")}
                  </TableHead>
                  {hasBaseline && (
                    <TableHead className={`${HEAD} ps-4`}>
                      {msg("optimization.logged_metrics.baseline_col")}
                    </TableHead>
                  )}
                  <TableHead className={`${HEAD} ps-4`}>
                    {msg("optimization.logged_metrics.optimized_col")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {named.map((row) => (
                  <TableRow key={row.name}>
                    <th
                      scope="row"
                      dir="auto"
                      title={row.name}
                      className="max-w-0 truncate py-2 pe-3 text-start align-top font-mono text-xs font-normal text-foreground"
                    >
                      {row.name}
                    </th>
                    {hasBaseline && <ScoreCell entry={row.baseline} />}
                    <ScoreCell entry={row.best} strong />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {cases.length > 0 && (
          <div className={PANEL}>
            <Table className="no-copy-underline caption-top text-xs">
              <caption className={CAPTION}>
                <HelpTip text={tip("blackbox.final.cases")}>
                  {formatMsg("optimization.blackbox.final.cases_title", { n: cases.length })}
                </HelpTip>
              </caption>
              <TableHeader className="static bg-transparent backdrop-blur-none">
                <TableRow>
                  <TableHead className={`${HEAD} w-16`}>
                    {msg("optimization.blackbox.final.case_col")}
                  </TableHead>
                  {hasBaseline && (
                    <TableHead className={`${HEAD} ps-4`}>
                      {msg("optimization.logged_metrics.baseline_col")}
                    </TableHead>
                  )}
                  <TableHead className={`${HEAD} ps-4`}>
                    {msg("optimization.logged_metrics.optimized_col")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((row) => (
                  <TableRow key={row.index}>
                    <th
                      scope="row"
                      className="py-2 pe-3 text-start align-top font-mono text-xs font-normal text-foreground"
                    >
                      <span dir="ltr">#{row.index + 1}</span>
                    </th>
                    {hasBaseline && (
                      <ScoreCell
                        entry={{ score: row.baseline_score, feedback: row.baseline_feedback }}
                      />
                    )}
                    <ScoreCell entry={{ score: row.best_score, feedback: row.best_feedback }} strong />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </FadeIn>
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
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/90" dir="auto">
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
