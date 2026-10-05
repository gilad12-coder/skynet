"use client";

import { Coins } from "@/shared/ui/icons";
import { useLocale } from "@/shared/providers";
import { useSettingsModal } from "@/features/settings";
import { msg } from "@/shared/lib/messages";
import { formatCentsUsd } from "@/features/billing";
import { readBilling } from "../lib/run-billing";

/**
 * Compact per-run cost affordance for the detail header.
 *
 * Reads the worker's billing stamp and shows what the run cost.
 * It's a quiet button — clicking opens the run's Usage and cost tab, or the
 * wallet where that tab isn't available. Renders nothing until the run settles and a billing
 * outcome is stamped (so it stays hidden on active runs and pairs, which carry
 * no billing of their own).
 */
export function RunCostChip({
  details,
  onOpen,
}: {
  details?: Record<string, unknown>;
  onOpen?: () => void;
}) {
  const { locale } = useLocale();
  const { openTo } = useSettingsModal();
  const billing = readBilling(details);
  if (billing == null) return null;

  return (
    <button
      type="button"
      onClick={onOpen ?? (() => openTo("billing"))}
      title={onOpen ? msg("usage_tab.open") : msg("billing.action.view_wallet")}
      aria-label={onOpen ? msg("usage_tab.open") : msg("billing.action.view_wallet")}
      dir="ltr"
      className="flex min-h-[44px] items-center gap-1.5 tabular-nums transition-colors hover:text-foreground sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
    >
      <Coins className="size-3.5" aria-hidden="true" />
      {formatCentsUsd(billing.cents, locale)}
    </button>
  );
}
