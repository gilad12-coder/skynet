"use client";

import { usePreflightNotifications } from "../hooks/use-wizard-preflight";

/**
 * Follows running setup checks from the root, so a check that finishes while
 * the user is elsewhere in the app still sends its notification. Renders nothing.
 */
export function PreflightNotifications() {
  usePreflightNotifications();
  return null;
}
