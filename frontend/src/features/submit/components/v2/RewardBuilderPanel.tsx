"use client";

import * as React from "react";
import { msg } from "@/shared/lib/messages";
import { buildToMetricCode, readRewardRules } from "@/shared/lib/reward-rules-code";
import {
  DEFAULT_COST,
  DEFAULT_SPEED,
  bundledRewards,
  buildIssues,
  type RewardBuild,
} from "@/shared/lib/reward-rules";
import { Warning } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import { RewardBuilder } from "@/shared/ui/reward/reward-builder";
import { DiscardDialog } from "@/shared/ui/reward/reward-rule-editor";
import type { RewardSample } from "@/shared/ui/reward/reward-try-it";

/** The build a new reward starts from: the bundled exact answer. */
export function starterBuild(expectedField: string): RewardBuild {
  return {
    rewards: bundledRewards(expectedField).slice(0, 1),
    speed: DEFAULT_SPEED,
    cost: DEFAULT_COST,
  };
}

// The dialog primitive centres itself with an inline transform; a full-screen
// sheet pins to the corners instead.
const FULL_SCREEN = { zIndex: 50, top: 0, left: 0, transform: "none" } as const;

/**
 * The full-screen reward builder (SKY-84), the metric step's way to build a
 * reward without code, laid out like Unsloth Studio's Rewards step: the
 * Rewards card centred on the screen, with Cancel and Save at the bottom.
 *
 * It edits a copy of the rewards that metric.py holds, or the bundled exact
 * answer when metric.py holds none. Save writes metric.py; Cancel, Escape and
 * the close button ask before they drop unsaved edits.
 *
 * Args:
 *   open: Whether the builder shows.
 *   onOpenChange: Show or hide the builder.
 *   metricCode: metric.py as it is now.
 *   onMetricCode: Replace metric.py.
 *   expectedField: The run's expected column.
 *   samples: Cases for "Try it".
 */
export function RewardBuilderDialog({
  open,
  onOpenChange,
  metricCode,
  onMetricCode,
  expectedField,
  samples,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metricCode: string;
  onMetricCode: (code: string) => void;
  expectedField: string;
  samples: readonly RewardSample[];
}) {
  const read = React.useMemo(
    () => readRewardRules(metricCode, expectedField),
    [metricCode, expectedField],
  );
  const initial = React.useMemo(
    () => (read.kind === "build" ? read.build : starterBuild(expectedField)),
    [read, expectedField],
  );
  const [draft, setDraft] = React.useState(initial);
  const [asking, setAsking] = React.useState(false);
  React.useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const close = () => (dirty ? setAsking(true) : onOpenChange(false));
  const issues = buildIssues(draft);
  // Code the builder cannot read is lost on Save, so say so first.
  const note =
    read.kind === "invalid"
      ? msg("reward_builder.start.invalid")
      : read.kind === "none" && metricCode.trim()
        ? msg("reward_builder.start.replace")
        : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          style={FULL_SCREEN}
          className="flex h-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
        >
          <div className="shrink-0 border-b border-border/50 px-4 py-3 pe-14 sm:px-6">
            <DialogTitle className="text-base">{msg("reward_builder.screen.title")}</DialogTitle>
            <DialogDescription className="text-xs">
              {msg("reward_builder.screen.desc")}
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">
              {note && (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs"
                >
                  <Warning className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" aria-hidden />
                  {note}
                </p>
              )}
              <RewardBuilder
                build={draft}
                onChange={setDraft}
                expectedField={expectedField}
                samples={samples}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-4 py-3 sm:px-6">
            <Button type="button" variant="outline" onClick={close}>
              {msg("reward_builder.cancel")}
            </Button>
            <Button
              type="button"
              disabled={issues.length > 0}
              onClick={() => {
                onMetricCode(buildToMetricCode(draft));
                onOpenChange(false);
              }}
            >
              {msg("reward_builder.screen.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <DiscardDialog
        open={asking}
        onKeep={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
