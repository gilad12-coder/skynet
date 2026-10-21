"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  claimNativeNotifications,
  getLocalNotificationChannels,
  type LocalNotificationChannels,
} from "@/shared/lib/api";

import { maybeLocalHost } from "../lib/catalog";
import { nativePermission, showNative } from "../lib/native";

export const NATIVE_POLL_MS = 10_000;

/**
 * The Mac app's channel states, or null on a hosted server. Only loopback
 * pages ask, so hosted pages send no extra request.
 */
export function useLocalNotificationChannels(enabled: boolean) {
  const [local, setLocal] = React.useState<LocalNotificationChannels | null>(null);
  React.useEffect(() => {
    if (!enabled || !maybeLocalHost(window.location.hostname)) return;
    let live = true;
    getLocalNotificationChannels()
      .then((value) => live && setLocal(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled]);
  return [local, setLocal] as const;
}

/**
 * In the Mac app, show queued macOS notifications while the app runs. It
 * keeps polling while the window is hidden: that is when a notification
 * matters most. The server hands each one out once, so two windows never
 * show it twice. Nothing is claimed until notifications are allowed, so
 * none are lost.
 */
export function useNativeNotifications(enabled: boolean) {
  const router = useRouter();
  const [local] = useLocalNotificationChannels(enabled);
  const onTick = React.useEffectEvent(() => {
    if (nativePermission() !== "granted") return;
    claimNativeNotifications()
      .then(({ items }) => items.forEach((item) => showNative(item, (url) => router.push(url))))
      .catch(() => undefined);
  });
  const active = enabled && local !== null;
  React.useEffect(() => {
    if (!active) return;
    onTick();
    const timer = setInterval(() => onTick(), NATIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
}
