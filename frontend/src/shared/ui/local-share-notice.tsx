"use client";

import { msg } from "@/shared/lib/messages";
import { hostedSignInUrl } from "@/shared/lib/share-link";
import { EmptyState } from "@/shared/ui/empty-state";
import { CircleNotch, SignIn } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";

/**
 * Share-dialog body in the Mac app. Its UI and single-user backend live on
 * this computer only, so no link from there can work for another person. The
 * share dialogs show this notice in local mode in place of the link and people
 * controls (see shareDialogPlan); hosted mode never renders it. Its sign-in
 * link opens the hosted sign-in page in the browser; linking that account to
 * the Mac app is SKY-140.
 */
export function LocalShareNotice() {
  const signInUrl = hostedSignInUrl();
  return (
    <EmptyState
      variant="compact"
      icon={SignIn}
      iconWrap="tile"
      title={msg("share.local.title")}
      description={msg("share.local.body")}
      className="px-6 py-10"
    >
      {signInUrl && (
        <Button variant="outline" size="sm" asChild>
          <a href={signInUrl} target="_blank" rel="noopener noreferrer">
            {msg("share.local.sign_in")}
          </a>
        </Button>
      )}
    </EmptyState>
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
      <CircleNotch className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {msg("share.loading")}
    </div>
  );
}
