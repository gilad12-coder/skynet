"use client";

import { msg } from "@/shared/lib/messages";
import { EmptyState } from "@/shared/ui/empty-state";
import { CircleNotch, SignIn } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";

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

/**
 * Placeholder for the Mac app run dialog's public-visibility row while the
 * sharing state loads, or after the load fails. The row needs that state, so
 * without this the dialog shows only the notice and the row appears late or
 * never.
 */
export function LocalVisibilityStatus({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span role="alert">{msg("share.visibility.load_failed")}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {msg("share.visibility.retry")}
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleNotch className="size-4 animate-spin" />
      {msg("share.loading")}
    </div>
  );
}
