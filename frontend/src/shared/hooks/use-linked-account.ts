"use client";

import * as React from "react";
import { getLocalHostedLinkStatus } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { isLocalMode } from "@/shared/lib/runtime-env";

/**
 * The hosted account the Mac app is linked to: `undefined` while unknown or
 * outside local mode, `null` when not linked.
 *
 * The Mac app signs in one internal local user that owns all local data. Its
 * email is a placeholder, so the UI shows this account (or "This Mac")
 * instead. A new `refreshKey` reads the status again, for example each time
 * a menu opens after a browser sign-in.
 */
export function useLinkedAccount(refreshKey: unknown = 0): string | null | undefined {
  const local = isLocalMode();
  const [account, setAccount] = React.useState<string | null | undefined>(undefined);

  React.useEffect(() => {
    if (!local) return;
    let cancelled = false;
    getLocalHostedLinkStatus()
      .then((status) => {
        if (cancelled) return;
        setAccount(
          status.linked ? status.account_email || msg("desktop_link.account_label") : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [local, refreshKey]);

  return local ? account : undefined;
}
