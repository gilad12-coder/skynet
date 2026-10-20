"use client";

import { toast } from "react-toastify";

import { msg } from "@/shared/lib/messages";

import type { subscribePush } from "../lib/push";

/** Report a subscribe outcome the user should see; a dismissed browser prompt says nothing. */
export function toastPushResult(result: Awaited<ReturnType<typeof subscribePush>>): void {
  if (result === "subscribed") toast.success(msg("notifications.push.enabled"));
  else if (result === "denied") toast.info(msg("notifications.push.blocked"), { autoClose: 8000 });
  else if (result === "unsupported") toast.info(msg("notifications.push.unsupported"));
  else if (result === "unavailable") toast.info(msg("notifications.push.unavailable"));
  else if (result === "error") toast.error(msg("notifications.push.error"));
}
