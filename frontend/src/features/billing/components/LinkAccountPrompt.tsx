"use client";

import { Button } from "@/shared/ui/primitives/button";
import { startHostedSignIn } from "@/shared/hooks/use-linked-account";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

/**
 * The Mac app's balance state when no account is linked: a short note and the
 * same browser sign-in the account menu starts. It shows no number, because
 * the local credit is not money.
 */
export function LinkAccountPrompt({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <p className="text-xs text-muted-foreground">{msg("billing.local.link_prompt")}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void startHostedSignIn()}>
        {msg("local_identity.sign_in")}
      </Button>
    </div>
  );
}
