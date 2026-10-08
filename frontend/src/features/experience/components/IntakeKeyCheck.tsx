"use client";

import * as React from "react";

import { BYOK_PROVIDERS, useByokKeys } from "@/features/billing";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { Check } from "@/shared/ui/icons";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { TOUCH_FIELD } from "@/shared/ui/touch";

import { TOUCH_TAP } from "./touch";

type CheckState = "idle" | "checking" | "ok" | "invalid" | "error";

/**
 * "Use my own key", checked inline with the same vault save-and-verify the
 * Settings key list uses. A key that fails offers platform credits instead.
 */
export function IntakeKeyCheck({
  provider,
  onProvider,
  onVerified,
  onUsePlatform,
}: {
  provider: string;
  onProvider: (provider: string) => void;
  onVerified: () => void;
  onUsePlatform: () => void;
}) {
  const { keyFor, saveKey } = useByokKeys();
  const saved = keyFor(provider);
  const [secret, setSecret] = React.useState("");
  const [check, setCheck] = React.useState<CheckState>(
    saved?.status === "verified" ? "ok" : "idle",
  );

  React.useEffect(() => {
    setSecret("");
    setCheck(keyFor(provider)?.status === "verified" ? "ok" : "idle");
    // A different provider starts from its own saved state.
  }, [provider]);

  React.useEffect(() => {
    if (check === "ok") onVerified();
  }, [check]);

  const placeholder =
    BYOK_PROVIDERS.find((p) => p.slug === provider)?.placeholder ?? msg("experience.key.placeholder");

  const run = async () => {
    const value = secret.trim();
    if (!value || check === "checking") return;
    setCheck("checking");
    try {
      const status = await saveKey(provider, value);
      setCheck(status === "invalid" ? "invalid" : "ok");
      if (status !== "invalid") setSecret("");
    } catch {
      setCheck("error");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={provider} onValueChange={onProvider}>
          <SelectTrigger
            className={cn(TOUCH_FIELD, "w-full sm:w-48")}
            aria-label={msg("experience.key.provider")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BYOK_PROVIDERS.map((p) => (
              <SelectItem key={p.slug} value={p.slug}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="password"
          autoComplete="off"
          aria-label={msg("experience.key.placeholder")}
          placeholder={saved ? `…${saved.last4}` : placeholder}
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            if (check !== "checking") setCheck("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          className={cn(TOUCH_FIELD, "min-w-0 flex-1 text-sm")}
        />
        <Button
          variant="outline"
          className={cn(TOUCH_TAP, "shrink-0")}
          onClick={() => void run()}
          disabled={!secret.trim() || check === "checking"}
        >
          {check === "checking" ? msg("experience.key.checking") : msg("experience.key.check")}
        </Button>
      </div>

      {check === "ok" && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Check className="size-3.5 shrink-0" aria-hidden="true" />
          {msg("experience.key.ok")}
        </p>
      )}
      {(check === "invalid" || check === "error") && (
        <InlineErrorRow
          message={check === "invalid" ? msg("experience.key.invalid") : msg("experience.key.error")}
          action={
            <Button variant="outline" size="sm" className={TOUCH_TAP} onClick={onUsePlatform}>
              {msg("experience.key.use_platform")}
            </Button>
          }
        />
      )}
    </div>
  );
}
