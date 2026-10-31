/** The custom URL scheme the hosted consent page uses to hand the link result back. */
export const APP_SCHEME = "skynet";

/** Same value as APP_CALLBACK_URI in backend/core/local/hosted_link.py. */
export const LINK_CALLBACK = `${APP_SCHEME}://link/callback`;

export type LinkCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "denied" }
  | { kind: "error"; error: string };

/**
 * Read a skynet:// URL from the browser. Only the exact link callback counts;
 * any other skynet:// URL gives null. The code and state stay opaque here:
 * the local API checks the state and the PKCE verifier.
 */
export function parseLinkCallback(raw: string): LinkCallback | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== "link" || url.pathname !== "/callback" || url.username || url.password) return null;
  const error = url.searchParams.get("error");
  if (error === "access_denied") return { kind: "denied" };
  if (error) return { kind: "error", error };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { kind: "error", error: "invalid_request" };
  return { kind: "code", code, state };
}

/** The skynet:// URL in a second instance's argv (how Windows and Linux pass it), if any. */
export function appUrlFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${APP_SCHEME}://`)) ?? null;
}
