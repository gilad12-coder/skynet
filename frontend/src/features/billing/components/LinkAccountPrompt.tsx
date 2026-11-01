"use client";

import { toast } from "react-toastify";
import { Button } from "@/shared/ui/primitives/button";
import { startLocalHostedLink } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

/**
 * The Mac app's balance state when no account is linked: a short note and the
 * same browser sign-in the account menu starts. It shows no number, because
 * the local credit is not money.
 */
export function LinkAccountPrompt({ className }: { className?: string }) {
  const signIn = () => {
    void startLocalHostedLink()
      // The Mac app opens new windows in the default browser.
      .then(({ authorize_url }) => window.open(authorize_url, "_blank", "noopener"))
      .catch(() => toast.error(msg("local_identity.sign_in_failed")));
  };
  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <p className="text-xs text-muted-foreground">{msg("billing.local.link_prompt")}</p>
      <Button type="button" variant="outline" size="sm" onClick={signIn}>
        {msg("local_identity.sign_in")}
      </Button>
    </div>
  );
}
