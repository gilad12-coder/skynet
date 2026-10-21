"use client";

import type { ComponentType } from "react";
import { CLI_PROVIDERS, cliLabel, isCliProvider } from "@/features/local-runtime";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { ChatCenteredDots, Code, Robot, Tag, Terminal } from "@/shared/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { SettingsRow } from "@/shared/ui/settings-row";
import { TOUCH_FIELD_SM } from "@/shared/ui/touch";
import { useUserPrefs } from "../hooks/use-user-prefs";
import { LOCAL_AGENT_ROLES, type LocalAgentRole } from "../lib/prefs";

// Radix Select cannot hold an empty value, so "off" has its own.
const OFF = "off";

const ROLE_ROWS: Record<
  LocalAgentRole,
  { label: MessageKey; icon: ComponentType<{ className?: string }> }
> = {
  generalist: { label: "settings.agent_local.role.generalist", icon: Robot },
  code: { label: "settings.agent_local.role.code", icon: Code },
  interview: { label: "settings.agent_local.role.interview", icon: ChatCenteredDots },
  tagger: { label: "settings.agent_local.role.tagger", icon: Tag },
};

/**
 * Local desktop build only: per agent role, run it on one of the user's CLI
 * subscriptions instead of the composer's model.
 */
export function AgentLocalRunSetting() {
  const { prefs, setPref } = useUserPrefs();
  const current = prefs.agentSubscription ?? {};

  return (
    <div className="pt-3">
      <div className="flex items-start gap-3 pb-1">
        <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {msg("settings.agent_local.title")}
          </span>
          <span className="text-xs text-muted-foreground/80">
            {msg("settings.agent_local.desc")}
          </span>
        </div>
      </div>
      {LOCAL_AGENT_ROLES.map((role) => {
        const row = ROLE_ROWS[role];
        const stored = current[role];
        const value = isCliProvider(stored) ? stored : OFF;
        return (
          <SettingsRow key={role} icon={row.icon} label={msg(row.label)}>
            <Select
              value={value}
              onValueChange={(next) =>
                setPref("agentSubscription", {
                  ...prefs.agentSubscription,
                  [role]: isCliProvider(next) ? next : null,
                })
              }
            >
              <SelectTrigger
                size="sm"
                aria-label={msg(row.label)}
                className={cn(TOUCH_FIELD_SM, "w-full min-w-0 sm:w-auto sm:min-w-[160px]")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={OFF}>{msg("settings.agent_local.off")}</SelectItem>
                {CLI_PROVIDERS.map((cli) => (
                  <SelectItem key={cli} value={cli}>
                    {cliLabel(cli)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        );
      })}
    </div>
  );
}
