/**
 * The balance the Mac app shows.
 *
 * The local backend seeds its single user with a large credit, so budget
 * checks never block a run that costs nothing on this Mac. That credit is not
 * money, so the app shows the linked Skynet account's balance instead, or asks
 * the user to link an account. Local budget checks still read the local wallet.
 */

import type { WalletStatus } from "./wallet";

/** What the Mac app shows in place of the local wallet balance. */
export type HostedBalance =
  | { kind: "loading" }
  | { kind: "link" }
  | { kind: "unavailable" }
  | { kind: "hosted"; cents: number; status: WalletStatus };

interface HostedBalanceApi {
  linked: () => Promise<boolean>;
  balance: () => Promise<{ available_cents: number; low_balance: boolean }>;
}

/**
 * Read the linked account's balance through the local API.
 *
 * A 401 or 409 means the link is gone (the local API deletes a link that
 * hosted revoked), so the user must link again. Any other failure is
 * unavailable: the app never falls back to the local credit.
 */
export async function loadHostedBalance(api: HostedBalanceApi): Promise<HostedBalance> {
  try {
    if (!(await api.linked())) return { kind: "link" };
    const { available_cents: cents, low_balance: low } = await api.balance();
    return { kind: "hosted", cents, status: cents <= 0 ? "empty" : low ? "low" : "healthy" };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    return status === 401 || status === 409 ? { kind: "link" } : { kind: "unavailable" };
  }
}

/** The balance a surface shows, which in the Mac app is not the local wallet. */
export interface ShownBalance {
  loading: boolean;
  available: boolean;
  totalCents: number;
  status: WalletStatus;
  /** True in the Mac app when no account is linked: show a link prompt, no number. */
  linkNeeded: boolean;
  /** True when the number is the linked account's total, with no paid/grant split. */
  hosted: boolean;
}

/**
 * Pick what balance surfaces show.
 *
 * `hosted` is null on the web, which shows the wallet. In the Mac app the
 * local wallet total is never shown.
 */
export function shownBalance(
  hosted: HostedBalance | null,
  wallet: Pick<ShownBalance, "loading" | "available" | "totalCents" | "status">,
): ShownBalance {
  if (!hosted) return { ...wallet, linkNeeded: false, hosted: false };
  if (hosted.kind === "hosted")
    return {
      loading: false,
      available: true,
      totalCents: hosted.cents,
      status: hosted.status,
      linkNeeded: false,
      hosted: true,
    };
  return {
    loading: hosted.kind === "loading",
    available: false,
    totalCents: 0,
    status: "empty",
    linkNeeded: hosted.kind === "link",
    hosted: true,
  };
}
