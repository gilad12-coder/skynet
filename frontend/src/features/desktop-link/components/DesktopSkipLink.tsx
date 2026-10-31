"use client";

import * as React from "react";

import { msg } from "@/shared/lib/messages";
import { DESKTOP_SKIP_PATH, isDesktopAppUserAgent, returnsToDesktopLink } from "../lib/consent";

/**
 * "Use without signing in", shown only inside the Mac app's window. On /login
 * it shows only when the sign-in returns to the consent page. The user agent
 * is read after mount, so the server HTML and the first client render match.
 */
export function DesktopSkipLink({ onLogin = false }: { onLogin?: boolean }) {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    const inApp = isDesktopAppUserAgent(navigator.userAgent);
    const forLink =
      !onLogin || returnsToDesktopLink(window.location.search, window.location.origin);
    setShow(inApp && forLink);
  }, [onLogin]);

  if (!show) return null;
  return (
    <a
      href={DESKTOP_SKIP_PATH}
      className="inline-flex min-h-[44px] items-center justify-center self-center text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline lg:min-h-0"
    >
      {msg("desktop_link.use_without_account")}
    </a>
  );
}
