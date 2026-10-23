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

// The Mac app build does not set NEXT_PUBLIC_SITE_URL, and that fallback is not
// the hosted app, so the sign-in link uses its own origin.
const FALLBACK_HOSTED_APP_URL = "https://skynetml.com";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Absolute share URL for `path` (e.g. `/share/<token>`), or null when no link can work. */
export function shareLinkUrl(path: string): string | null {
  if (typeof window === "undefined" || isLocalMode()) return null;
  return `${window.location.origin}${path}`;
}

/**
 * Sign-in page of the hosted app, for the Mac app share notice. Null when the
 * configured hosted app URL is a loopback origin, so the notice never links to
 * this computer.
 */
export function hostedSignInUrl(): string | null {
  const url = new URL("/login", process.env.NEXT_PUBLIC_HOSTED_APP_URL || FALLBACK_HOSTED_APP_URL);
  return LOOPBACK_HOSTS.has(url.hostname) ? null : url.toString();
}
