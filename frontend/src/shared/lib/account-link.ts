import { createHmac, timingSafeEqual } from "crypto";

/**
 * The short-lived cookie that turns the next Google or GitHub sign-in into
 * "link this provider account to the account I'm signed in as". Settings sets
 * it for the signed-in user just before starting the provider's consent
 * screen; the sign-in callback reads it, links by the provider's stable
 * account id, and clears it. It is HMAC-signed so a browser can't forge a
 * link into someone else's account.
 */

export const ACCOUNT_LINK_COOKIE = "skynet-account-link";
export const ACCOUNT_LINK_TTL_SECONDS = 600;
export const LINKABLE_PROVIDERS = new Set(["google", "github"]);

const secret = process.env.BACKEND_AUTH_SECRET ?? process.env.AUTH_SECRET;

function sign(payload: string): string {
  return createHmac("sha256", secret ?? "")
    .update(`account-link:${payload}`)
    .digest("base64url");
}

/** Encode a link intent for ``username`` and ``provider`` that expires after the TTL. */
export function encodeAccountLink(username: string, provider: string): string | null {
  if (!secret) return null;
  const expires = Math.floor(Date.now() / 1000) + ACCOUNT_LINK_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ u: username, p: provider, e: expires })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

/** Return the account a valid, unexpired link intent for ``provider`` names, else null. */
export function decodeAccountLink(value: string | undefined, provider: string): string | null {
  if (!secret || !value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const intent = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      u?: unknown;
      p?: unknown;
      e?: unknown;
    };
    if (intent.p !== provider || typeof intent.u !== "string" || typeof intent.e !== "number") {
      return null;
    }
    return intent.e > Date.now() / 1000 ? intent.u : null;
  } catch {
    return null;
  }
}
