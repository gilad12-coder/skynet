"use client";

import { msg } from "@/shared/lib/messages";
import { EmptyState } from "@/shared/ui/empty-state";
import { SignIn } from "@/shared/ui/icons";

/**
 * Share-dialog body in the Mac app. Its UI and single-user backend live on
 * this computer only, so no link from there can work for another person. The
 * share dialogs show this notice in local mode in place of the link and people
 * controls (see shareDialogPlan); hosted mode never renders it.
 */
export function LocalShareNotice() {
  return (
    <EmptyState
      variant="compact"
      icon={SignIn}
      iconWrap="tile"
      title={msg("share.local.title")}
      description={msg("share.local.body")}
      className="px-6 py-10"
    />
  );
}
