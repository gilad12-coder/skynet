"use client";

import * as React from "react";
import { ClaudeCode, OpenRouter } from "@lobehub/icons";
import { toast } from "react-toastify";
import {
  agentEngineOptions,
  cliLabel,
  cliLoginCommand,
  cliStateText,
  defaultAgentCli,
  findCli,
  isAgentEngine,
  OPENROUTER_ENGINE,
  useAgentEngine,
  useLocalStatus,
  type AgentEngine,
  type AgentEngineOption,
  type LocalStatus,
} from "@/features/local-runtime";
import { msg } from "@/shared/lib/messages";
import { isLocalMode } from "@/shared/lib/runtime-env";
import { cn } from "@/shared/lib/utils";
import { HarnessLogo } from "@/shared/ui/harness-logo";
import { Lightning, Terminal, Warning } from "@/shared/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { SettingsRow } from "@/shared/ui/settings-row";
import { TOUCH_FIELD_SM } from "@/shared/ui/touch";

function engineLabel(engine: AgentEngine): string {
  return engine === OPENROUTER_ENGINE ? msg("settings.agent_engine.openrouter") : cliLabel(engine);
}

const LOGO_SIZE = 16;
// Select triggers and items resize and tint every bare <svg> below them; an
// inline size plus a `text-*` class opts the brand glyph out of both rules.
const GLYPH = { className: "text-inherit", style: { width: LOGO_SIZE, height: LOGO_SIZE } };

/**
 * The engine's brand mark, decorative next to its name. Droid has no mark in
 * @lobehub/icons, so it gets a neutral terminal tile.
 */
export function EngineLogo({ engine }: { engine: AgentEngine }) {
  let mark: React.ReactNode;
  switch (engine) {
    case OPENROUTER_ENGINE:
      mark = (
        <OpenRouter.Avatar
          size={LOGO_SIZE}
          iconClassName={GLYPH.className}
          iconStyle={GLYPH.style}
        />
      );
      break;
    case "claude":
      mark = (
        <ClaudeCode.Avatar
          size={LOGO_SIZE}
          iconClassName={GLYPH.className}
          iconStyle={GLYPH.style}
        />
      );
      break;
    case "codex":
      mark = <HarnessLogo harness="codex" size={LOGO_SIZE} />;
      break;
    default:
      mark = (
        <span
          className="inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground"
          style={GLYPH.style}
        >
          <Terminal className="size-2.5 text-inherit" />
        </span>
      );
  }
  return (
    <span aria-hidden="true" data-engine-logo={engine} dir="ltr" className="inline-flex shrink-0">
      {mark}
    </span>
  );
}

/** Why a choice is disabled, with the sign-in command for a signed-out CLI. */
function OptionReason({
  option,
  status,
  failed,
}: {
  option: AgentEngineOption;
  status: LocalStatus | null;
  failed: boolean;
}) {
  if (!option.disabled) return null;
  // SKY-123 replaces this line when a saved OpenRouter key can run agents.
  if (option.engine === OPENROUTER_ENGINE) {
    return <>{msg("settings.agent_engine.openrouter_local")}</>;
  }
  if (!option.state) {
    return <>{msg(failed ? "subscription.state.failed" : "subscription.state.loading")}</>;
  }
  const version = findCli(status, option.engine)?.version ?? null;
  return (
    <>
      {cliStateText(option.state, version)}
      {option.state.kind === "logged_out" && (
        <code className="mx-1 font-mono" dir="ltr">
          {cliLoginCommand(option.engine)}
        </code>
      )}
    </>
  );
}

/** One menu choice: the engine's logo, its name, and why it is disabled. */
export function EngineChoice({
  option,
  status,
  failed,
}: {
  option: AgentEngineOption;
  status: LocalStatus | null;
  failed: boolean;
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 inline-flex">
        <EngineLogo engine={option.engine} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{engineLabel(option.engine)}</span>
        {option.disabled && (
          <span className="text-xs text-muted-foreground" dir="auto">
            <OptionReason option={option} status={status} failed={failed} />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The "Agent engine" row. `value` is the engine agent turns run on now; a
 * disabled choice says why, and a current engine that is no longer ready
 * shows that reason under the row.
 */
export function AgentEngineSelect({
  local,
  status,
  failed = false,
  value,
  saving,
  onChange,
}: {
  local: boolean;
  status: LocalStatus | null;
  failed?: boolean;
  value: AgentEngine;
  saving: boolean;
  onChange: (engine: AgentEngine) => void;
}) {
  const options = agentEngineOptions(status, local);
  const current = options.find((option) => option.engine === value);
  return (
    <div>
      <SettingsRow
        icon={Lightning}
        label={msg("settings.agent_engine.label")}
        description={msg(
          local ? "settings.agent_engine.description_local" : "settings.agent_engine.description",
        )}
      >
        <Select
          value={value}
          disabled={saving}
          onValueChange={(next) => {
            if (isAgentEngine(next) && next !== value) onChange(next);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={msg("settings.agent_engine.label")}
            className={cn(TOUCH_FIELD_SM, "w-full min-w-0 sm:w-auto sm:min-w-[160px]")}
          >
            <SelectValue>
              <EngineLogo engine={value} />
              {engineLabel(value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.engine} value={option.engine} disabled={option.disabled}>
                <EngineChoice option={option} status={status} failed={failed} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {current?.disabled && current.engine !== OPENROUTER_ENGINE && status && (
        <div
          role="status"
          className="mb-2 flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs text-[var(--warning)]"
        >
          <Warning className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" dir="auto">
            <OptionReason option={current} status={status} failed={failed} />
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Settings > Agent: which engine runs every agent that has no model or CLI of
 * its own. Hosted builds offer only OpenRouter. The local build offers the
 * subscription CLIs on this computer, and the agent model menus then list
 * only that CLI's models.
 */
export function AgentEngineSetting() {
  const local = isLocalMode();
  const { status, failed } = useLocalStatus(local);
  const { engine, save } = useAgentEngine();
  const [saving, setSaving] = React.useState(false);
  const value: AgentEngine = local ? defaultAgentCli(status, engine) : OPENROUTER_ENGINE;

  const onChange = (next: AgentEngine) => {
    setSaving(true);
    save(next)
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <AgentEngineSelect
      local={local}
      status={status}
      failed={failed}
      value={value}
      saving={saving}
      onChange={onChange}
    />
  );
}
