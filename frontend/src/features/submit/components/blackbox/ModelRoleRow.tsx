"use client";

import type { ReactNode } from "react";
import { HelpTip } from "@/shared/ui/help-tip";

/**
 * One model role as the wizard explains it: "Role · binding" on the first
 * line, one sentence on what the role does beneath it, and the picker or
 * the actions that change it below. The chip inside names the model.
 */
export function ModelRoleRow({
  id,
  role,
  binding,
  description,
  tip,
  actions,
  children,
}: {
  id?: string;
  role: ReactNode;
  binding?: ReactNode;
  description: ReactNode;
  tip?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const roleNode = tip ? <HelpTip text={tip}>{role}</HelpTip> : role;
  return (
    <div
      id={id}
      tabIndex={-1}
      className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{roleNode}</span>
        {binding ? (
          <>
            <span className="text-muted-foreground/60" aria-hidden="true">
              ·
            </span>
            <span className="text-xs text-muted-foreground">{binding}</span>
          </>
        ) : null}
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{description}</p>
      {children}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
