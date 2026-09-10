"use client";

import { useEffect, useRef } from "react";
import { notifyUser, requestNotificationPermission } from "@/shared/lib/os-notifications";

/**
 * Sends an OS notification when `busy` drops back to false. The message is
 * read at that moment, so it can say whether the work succeeded or failed.
 * Permission is requested when the work starts, while the gesture that
 * started it still counts as user activation.
 */
export function useCompletionNotification(busy: boolean, message: () => string): void {
  const wasBusy = useRef(false);
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  });
  useEffect(() => {
    if (busy === wasBusy.current) return;
    wasBusy.current = busy;
    if (busy) requestNotificationPermission();
    else notifyUser(messageRef.current());
  }, [busy]);
}
