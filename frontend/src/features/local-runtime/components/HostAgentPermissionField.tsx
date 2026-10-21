"use client";

import { Desktop, Folder, Warning } from "@/shared/ui/icons";
import { Label } from "@/shared/ui/primitives/label";
import { Segmented } from "@/shared/ui/segmented";
import { msg } from "@/shared/lib/messages";

export type HostPermission = "workspace_only" | "full_access";

/**
 * What a host-run proposer CLI may touch: the run workspace (default) or
 * everything the signed-in user can. Full access always shows its warning.
 */
export function HostAgentPermissionField({
  value,
  onChange,
}: {
  value: HostPermission | undefined;
  onChange: (next: HostPermission) => void;
}) {
  const current = value ?? "workspace_only";
  return (
    <div className="space-y-2 sm:col-span-2">
      <Label>{msg("host_agent.permission.label")}</Label>
      <Segmented<HostPermission>
        label={msg("host_agent.permission.label")}
        value={current}
        onChange={onChange}
        options={[
          {
            value: "workspace_only",
            label: msg("host_agent.permission.workspace_only"),
            icon: <Folder className="size-3.5" aria-hidden="true" />,
          },
          {
            value: "full_access",
            label: msg("host_agent.permission.full_access"),
            icon: <Desktop className="size-3.5" aria-hidden="true" />,
          },
        ]}
      />
      {current === "workspace_only" ? (
        <p className="text-xs text-muted-foreground">
          {msg("host_agent.permission.workspace_hint")}
        </p>
      ) : (
        <p className="flex items-start gap-2 text-xs text-[var(--warning)]" role="alert">
          <Warning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span dir="auto">{msg("host_agent.permission.full_warning")}</span>
        </p>
      )}
    </div>
  );
}
