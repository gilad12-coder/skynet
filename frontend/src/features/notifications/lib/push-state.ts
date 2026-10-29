/*
 * The pure half of Chrome web push: decoding the server's VAPID key and the
 * rules for when to subscribe. Kept free of browser globals so it can be unit
 * tested under the node runner; `push.ts` does the browser work.
 */

/** Notification.permission, plus "unsupported" for browsers without web push. */
export type PushPermission = NotificationPermission | "unsupported";

/** How a subscribe attempt ended. */
export type PushSubscribeResult =
  | "subscribed"
  | "denied"
  | "dismissed"
  | "unsupported"
  | "unavailable"
  | "error";

/** Decode a urlsafe-base64 VAPID key into the bytes `pushManager.subscribe` takes. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Whether a run start may re-save this browser's push subscription. Only a
 * browser that already granted qualifies; asking for permission belongs to
 * the Settings screen, never to a run start.
 */
export function shouldSyncPush(permission: PushPermission): boolean {
  return permission === "granted";
}

/**
 * What flipping a Chrome cell on needs first: nothing when this browser is
 * already subscribed, a hint when the browser blocks notifications, and the
 * permission + subscribe flow otherwise.
 */
export function chromeCellAction(
  permission: PushPermission,
  subscribed: boolean,
): "save" | "subscribe" | "blocked" | "unsupported" {
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "blocked";
  return subscribed ? "save" : "subscribe";
}
