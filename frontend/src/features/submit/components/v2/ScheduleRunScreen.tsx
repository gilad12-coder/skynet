"use client";

import { useState } from "react";
import { Info, PencilSimple, Repeat } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import { Switch } from "@/shared/ui/primitives/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { msg } from "@/shared/lib/messages";
import { ScheduledRunSetup, describeSchedule } from "@/features/optimizations";
import { useWizardV2 } from "../../hooks/use-unified-wizard";

/**
 * The last setup screen before the overview: the run may repeat on a schedule.
 * The plan is only saved here; it starts with the run and waits for its success.
 */
export function ScheduleRunScreen() {
  const { scheduledRun, setScheduledRun } = useWizardV2();
  const [on, setOn] = useState(scheduledRun !== null);
  const [editing, setEditing] = useState(scheduledRun === null);

  const toggle = (next: boolean) => {
    setOn(next);
    if (!next) {
      setScheduledRun(null);
      setEditing(true);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl py-2">
      <Card className="overflow-hidden py-0">
        <CardContent className="divide-y divide-border/50 p-0">
          <div className="flex items-center justify-between gap-4 p-5 sm:p-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Repeat className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-base! leading-6! font-semibold">
                    {msg("submit.v2.schedule.title")}
                  </h2>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={msg("submit.v2.schedule.hint")}
                      >
                        <Info className="size-4" aria-hidden />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{msg("submit.v2.schedule.hint")}</TooltipContent>
                  </Tooltip>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {on && scheduledRun && !editing
                    ? describeSchedule(scheduledRun.schedule)
                    : msg(on ? "continuous_tab.status.setup" : "submit.v2.schedule.off")}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {on && scheduledRun && !editing && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditing(true)}
                      aria-label={msg("continuous_tab.schedule.edit")}
                    >
                      <PencilSimple className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{msg("continuous_tab.schedule.edit")}</TooltipContent>
                </Tooltip>
              )}
              <Switch
                checked={on}
                onCheckedChange={toggle}
                aria-label={msg("continuous_tab.toggle")}
              />
            </div>
          </div>
          {on && editing && (
            <ScheduledRunSetup
              idPrefix="wizard-schedule"
              finishLabel="continuous_tab.walk.save"
              onFinish={(body) => {
                setScheduledRun(body);
                setEditing(false);
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
