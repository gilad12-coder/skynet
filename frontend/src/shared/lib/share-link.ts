/**
 * Build the public URL of a share link.
 *
 * The hosted app shares from its own origin. The Mac app serves the UI from
 * `http://127.0.0.1:<port>` with a port that changes on each start, and its
 * single-user backend is not reachable by anyone else, so a link from there
 * can never work for another person. In local mode this returns no URL, and
 * the share dialogs show the hosted-account notice instead.
 */

import { isLocalMode } from "@/shared/lib/runtime-env";

/** Absolute share URL for `path` (e.g. `/share/<token>`), or null when no link can work. */
export function shareLinkUrl(path: string): string | null {
  if (typeof window === "undefined" || isLocalMode()) return null;
  return `${window.location.origin}${path}`;
}
