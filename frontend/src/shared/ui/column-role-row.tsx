"use client";

import { Image as ImageIcon, TextT as TypeIcon } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

export type ColumnRole = "input" | "output" | "ignore";
export type ColumnKind = "text" | "image";

/** A table's default roles: every column an input, the last one the output. */
export function defaultRoleFor(idx: number, total: number): ColumnRole {
  if (total === 1) return "input";
  return idx === total - 1 ? "output" : "input";
}

interface ColumnRoleRowProps {
  column: string;
  role: ColumnRole;
  disabled?: boolean;
  onChangeRole: (role: ColumnRole) => void;
  /** With both set, an input column shows a text / image switch. */
  kind?: ColumnKind;
  onToggleKind?: () => void;
}

/**
 * One table column with its Input / Output / Ignore switch: the classic
 * column picker of the agent panel's upload card and the submission wizard.
 */
export function ColumnRoleRow({
  column,
  role,
  kind,
  disabled,
  onChangeRole,
  onToggleKind,
}: ColumnRoleRowProps) {
  const options = [
    ["input", msg("auto.features.agent.panel.components.datasetuploadcard.role_input")],
    ["output", msg("auto.features.agent.panel.components.datasetuploadcard.role_output")],
    ["ignore", msg("auto.features.agent.panel.components.datasetuploadcard.role_skip")],
  ] as const;
  const activeIdx = options.findIndex(([v]) => v === role);
  const pillLeft = activeIdx >= 0 ? `calc(${activeIdx} * 100% / 3 + 2px)` : "2px";
  const showKind = role === "input" && kind !== undefined && onToggleKind !== undefined;
  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-[0.75rem] font-mono truncate" dir="ltr" title={column}>
          {column}
        </span>
        {showKind && (
          <button
            type="button"
            onClick={onToggleKind}
            disabled={disabled}
            className={cn(
              "shrink-0 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.625rem] font-medium transition-colors cursor-pointer",
              kind === "image"
                ? "border-primary-fill/40 bg-primary-fill text-primary-foreground hover:bg-primary-hover"
                : "border-border/60 bg-muted/40 text-muted-foreground hover:border-primary-fill/30 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-60",
            )}
            title={
              kind === "image"
                ? msg("submit.dataset.column_kind.image")
                : msg("submit.dataset.column_kind.text_manual_hint")
            }
          >
            {kind === "image" ? <ImageIcon className="size-3" /> : <TypeIcon className="size-3" />}
            <span>
              {kind === "image"
                ? msg("submit.dataset.column_kind.image")
                : msg("submit.dataset.column_kind.text")}
            </span>
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label={column}
        className="relative inline-grid w-full shrink-0 grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5 sm:w-auto"
      >
        <div
          className="absolute top-0.5 bottom-0.5 rounded-md bg-stone-500/15 transition-[inset-inline-start] duration-100 ease-out"
          style={{
            width: "calc((100% - 6px) / 3)",
            insetInlineStart: pillLeft,
          }}
        />
        {options.map(([val, label]) => (
          <button
            key={val}
            type="button"
            aria-pressed={role === val}
            onClick={() => onChangeRole(val)}
            disabled={disabled}
            className={cn(
              "relative z-10 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium text-center transition-colors duration-100 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
              role === val ? "text-stone-600 dark:text-stone-300" : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
