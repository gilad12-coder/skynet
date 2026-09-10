"use client";

import { usePreflightTabActivity } from "../hooks/use-wizard-preflight";

/**
 * Follows running setup checks in the browser tab's mark from the root, so a
 * check keeps showing while the user is elsewhere in the app. Renders nothing.
 */
export function PreflightTabActivity() {
  usePreflightTabActivity();
  return null;
}
