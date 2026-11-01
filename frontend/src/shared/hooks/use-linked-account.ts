"use client";

import * as React from "react";
import { toast } from "react-toastify";
import {
  ApiError,
  getLocalHostedLinkStatus,
  getLocalHostedWhoami,
  HOSTED_LINK_CHANGED_EVENT,
  startLocalHostedLink,
  unlinkLocalHostedLink,
} from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { isLocalMode } from "@/shared/lib/runtime-env";

/**
 * The hosted account the Mac app is linked to. `offline` means hosted did not
 * answer, so `name`, `email` and `image` come from the last known identity.
 */
export type LinkedAccount =
  | { linked: false }
  | {
      linked: true;
      name: string | null;
      email: string | null;
      image?: string | null;
      offline: boolean;
    };

interface Identity {
  name: string | null;
  email: string | null;
  image?: string | null;
}

// Hosted stores only https provider pictures; anything else is not rendered.
function safeImage(url: string | null | undefined): string | null {
  return url && url.startsWith("https://") ? url : null;
}

const CACHE_KEY = "skynet.local.hosted-identity";
// Each whoami call goes out to hosted; the menu reads the link on every open.
const WHOAMI_TTL_MS = 5 * 60_000;
let whoamiAt = 0;

function readCache(): Identity | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

function announceLinkChange(): void {
  window.dispatchEvent(new Event(HOSTED_LINK_CHANGED_EVENT));
}

// The cache holds an identity exactly while the Mac is known to be linked, so a
// change in its presence is a link that finished or ended.
function writeCache(identity: Identity | null): void {
  const wasLinked = readCache() !== null;
  try {
    if (identity) window.localStorage.setItem(CACHE_KEY, JSON.stringify(identity));
    else window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be off; the identity is then read from hosted each time.
  }
  whoamiAt = identity ? Date.now() : 0;
  if (wasLinked !== (identity !== null)) announceLinkChange();
}

/**
 * Read the link from the local API, then the account from hosted whoami.
 *
 * Hosted that does not answer keeps the last known identity (or the email
 * saved at link time) and marks it offline. A 401 or 409 means the link is
 * gone, because the local API deletes a link that hosted revoked.
 */
export async function loadLinkedAccount(
  api = { status: getLocalHostedLinkStatus, whoami: getLocalHostedWhoami },
): Promise<LinkedAccount> {
  const status = await api.status();
  if (!status.linked) {
    writeCache(null);
    return { linked: false };
  }
  const savedEmail = status.account_email ?? null;
  let cached = readCache();
  // A link to another account (for example a re-link) makes the cache stale.
  if (cached && savedEmail && cached.email && cached.email !== savedEmail) cached = null;
  if (cached && Date.now() - whoamiAt < WHOAMI_TTL_MS)
    return { linked: true, ...cached, offline: false };
  try {
    const who = await api.whoami();
    const identity = {
      name: who.name || null,
      email: who.email || savedEmail,
      image: safeImage(who.image),
    };
    writeCache(identity);
    return { linked: true, ...identity, offline: false };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 409)) {
      writeCache(null);
      return { linked: false };
    }
    return { linked: true, ...(cached ?? { name: null, email: savedEmail }), offline: true };
  }
}

/**
 * The username line of the Mac app's settings. An unknown link shows "Local
 * mode"; an empty string means not linked, which the caller shows as "Not
 * signed in".
 */
export function linkedUsername(account: LinkedAccount | undefined): string {
  if (!account) return msg("local_identity.title");
  if (!account.linked) return "";
  return account.email ?? account.name ?? msg("account.linked_fallback_name");
}

/** Unlink the Mac app from hosted and forget the cached identity. */
export async function unlinkHostedAccount(unlink = unlinkLocalHostedLink): Promise<void> {
  await unlink();
  const hadIdentity = readCache() !== null;
  writeCache(null);
  // An offline link may have no cached identity, so announce the log out anyway.
  if (!hadIdentity) announceLinkChange();
}

/** Start the hosted sign-in and open its consent page in the browser. */
export function startHostedSignIn(
  start: () => Promise<{ authorize_url: string }> = startLocalHostedLink,
  // The Mac app opens new windows in the default browser.
  open: (url: string) => void = (url) => window.open(url, "_blank", "noopener"),
  fail: () => void = () => toast.error(msg("local_identity.sign_in_failed")),
): Promise<void> {
  return start()
    .then(({ authorize_url }) => open(authorize_url))
    .catch(fail);
}

/**
 * The hosted account of the Mac app: `undefined` while unknown or outside
 * local mode.
 *
 * The Mac app signs in one internal local user that owns all local data. Its
 * email is a placeholder, so the UI shows this account (or "Local mode")
 * instead. A new `refreshKey` reads the link again, for example each time a
 * menu opens after a browser sign-in.
 */
export function useLinkedAccount(refreshKey: unknown = 0): LinkedAccount | undefined {
  const local = isLocalMode();
  const [account, setAccount] = React.useState<LinkedAccount | undefined>(undefined);

  React.useEffect(() => {
    if (!local) return;
    let cancelled = false;
    loadLinkedAccount()
      .then((next) => {
        if (!cancelled) setAccount(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [local, refreshKey]);

  return local ? account : undefined;
}
