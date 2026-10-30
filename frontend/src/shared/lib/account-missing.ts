/**
 * The backend answers 401 `auth.account_not_found` when a signed-in browser's
 * account row is gone (deleted, or never provisioned). Refreshing the bearer
 * cannot fix that, so the app signs the browser out instead of retrying.
 */
export const ACCOUNT_MISSING_CODE = "auth.account_not_found";

/** Browser event the API layer fires when the backend reports a missing account. */
export const ACCOUNT_MISSING_EVENT = "account-missing";

/** Return whether a response status and body carry the missing-account code. */
export function isAccountMissingResponse(status: number, body: string): boolean {
  if (status !== 401 || !body) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { code?: unknown }).code === ACCOUNT_MISSING_CODE
    );
  } catch {
    return false;
  }
}

/** Fire {@link ACCOUNT_MISSING_EVENT} in the browser. */
export function announceAccountMissing(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_MISSING_EVENT));
}

/**
 * Wrap `signOut` so a burst of missing-account 401s (every open request fails
 * at once) signs out only once.
 */
export function signOutOnce(signOut: () => unknown): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    void signOut();
  };
}
