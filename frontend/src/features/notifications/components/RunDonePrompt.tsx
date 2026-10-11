"use client";

import * as React from "react";
import { toast } from "react-toastify";

import { updateNotificationPreferences } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { BellRinging, BellSlash, CircleNotch } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { TooltipButton } from "@/shared/ui/tooltip-button";

import {
  pushDeclined,
  pushPermission,
  setPushDeclined,
  subscribePush,
  syncPushSubscription,
} from "../lib/push";
import { shouldOfferRunPrompt } from "../lib/push-state";

const PROMPT_TOAST_ID = "run-done-push";

/** Report a subscribe outcome the user should see; a dismissed browser prompt says nothing. */
export function toastPushResult(result: Awaited<ReturnType<typeof subscribePush>>): void {
  if (result === "subscribed") toast.success(msg("notifications.push.enabled"));
  else if (result === "denied") toast.info(msg("notifications.push.blocked"), { autoClose: 8000 });
  else if (result === "unsupported") toast.info(msg("notifications.push.unsupported"));
  else if (result === "unavailable") toast.info(msg("notifications.push.unavailable"));
  else if (result === "error") toast.error(msg("notifications.push.error"));
}

function RunDonePromptToast({ closeToast }: { closeToast?: () => void }) {
  const [busy, setBusy] = React.useState(false);

  const accept = async () => {
    setBusy(true);
    const result = await subscribePush();
    if (result === "subscribed") {
      // "When it's done" means the finished and failed rows, which push off by default.
      await updateNotificationPreferences({
        grid: { finished: { chrome: true }, failed: { chrome: true } },
      }).catch(() => undefined);
    }
    closeToast?.();
    toastPushResult(result);
  };

  const decline = () => {
    setPushDeclined(true);
    closeToast?.();
  };

  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 text-sm text-foreground">{msg("notifications.push.prompt")}</span>
      <TooltipButton tooltip={msg("notifications.push.yes")} side="top">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={msg("notifications.push.yes")}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void accept()}
        >
          {busy ? (
            <CircleNotch className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <BellRinging className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </TooltipButton>
      <TooltipButton tooltip={msg("notifications.push.no")} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={msg("notifications.push.no")}
          disabled={busy}
          onClick={decline}
        >
          <BellSlash className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipButton>
    </div>
  );
}

/**
 * Call right after a run starts. A browser that was never asked (and a user
 * who never said no) gets "tell me when it's done?"; one that already allows
 * notifications just re-saves its subscription for the signed-in account.
 * Never call it from setup: the ask belongs to the moment it is useful.
 */
export function offerRunDoneNotifications(): void {
  const permission = pushPermission();
  if (permission === "granted") {
    void syncPushSubscription();
    return;
  }
  if (!shouldOfferRunPrompt(permission, pushDeclined())) return;
  toast(({ closeToast }) => <RunDonePromptToast closeToast={closeToast} />, {
    toastId: PROMPT_TOAST_ID,
    autoClose: false,
    closeOnClick: false,
    draggable: false,
  });
}
