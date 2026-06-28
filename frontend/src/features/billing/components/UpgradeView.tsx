"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Check, KeyRound, Plus, Sparkles } from "lucide-react";
import { toast } from "react-toastify";
import { msg, formatMsg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useLocale } from "@/shared/providers";
import { useSettingsModal } from "@/features/settings";
import { createCheckoutSession } from "@/shared/lib/api";
import { useCredits } from "../providers/credit-provider";
import { CREDIT_PACKS, formatCredits, formatUsd, type CreditPack } from "../lib/credit";

// Rough credit cost of a single run, used only to translate a pack size into a
// "what does this buy me" line. Display heuristics, not billing truth.
const APPROX_FRONTIER_CREDITS = 300;
const APPROX_MINI_CREDITS = 15;

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

function PackOption({ pack, index }: { pack: CreditPack; index: number }) {
  const { locale } = useLocale();
  const reduce = useReducedMotion();
  const frontierRuns = Math.round(pack.credits / APPROX_FRONTIER_CREDITS);
  const miniRuns = Math.round(pack.credits / APPROX_MINI_CREDITS);
  const [buying, setBuying] = React.useState(false);

  const onBuy = async () => {
    setBuying(true);
    try {
      const { url } = await createCheckoutSession(pack.id);
      window.location.assign(url);
    } catch {
      setBuying(false);
      toast.error(msg("billing.checkout.error"));
    }
  };

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.06 * index }}
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-5",
        pack.popular ? "border-[#C8A882]/70 ring-1 ring-[#C8A882]/40" : "border-border/60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {msg("billing.unit.credits")}
        </span>
        {pack.popular && (
          <span className="rounded-full bg-[#C8A882]/15 px-2 py-0.5 text-[0.6875rem] font-semibold text-[#8a6d44]">
            {msg("billing.upgrade.pack_popular")}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        <span dir="ltr" className="text-3xl font-semibold text-foreground tabular-nums">
          {formatCredits(pack.credits, locale)}
        </span>
        <span dir="ltr" className="text-sm text-muted-foreground tabular-nums">
          {formatUsd(pack.usd, locale)}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {formatMsg("billing.upgrade.pack_estimate", {
          p1: formatCredits(frontierRuns, locale),
          p2: formatCredits(miniRuns, locale),
        })}
      </p>

      <button
        type="button"
        onClick={onBuy}
        disabled={buying}
        className={cn(
          "mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 disabled:cursor-wait disabled:opacity-70",
          pack.popular
            ? "bg-[#3D2E22] text-[#FAF8F5] hover:bg-[#2A1F17]"
            : "border border-border/70 text-foreground hover:bg-accent",
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
        {formatMsg("billing.upgrade.buy", { p1: formatUsd(pack.usd, locale) })}
      </button>
    </motion.div>
  );
}

/** A secondary "other way to run" option — mini models or BYOK. */
function AltOption({
  icon: Icon,
  title,
  description,
  action,
  onAction,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action: string;
  onAction?: () => void;
  href?: string;
}) {
  const actionClass =
    "inline-flex items-center gap-1 self-start text-sm font-semibold text-[#3D2E22] underline-offset-4 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 rounded";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-5">
      <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <p className="text-xs text-muted-foreground">{description}</p>
      {href ? (
        <Link href={href} className={actionClass}>
          {action}
        </Link>
      ) : (
        <button type="button" onClick={onAction} className={actionClass}>
          {action}
        </button>
      )}
    </div>
  );
}

/**
 * Upgrade page — the full-screen paywall and the only in-app pricing explainer.
 *
 * Reached when a free account hits a paid action (a frontier model, or Run with
 * too little balance). Leads with the primary path (buy credit packs) and always
 * offers the two other exits — stay on free mini models, or bring your own key —
 * so it reads as "here's how to proceed", never a hard wall. Checkout is stubbed
 * until Stripe is wired; the design and copy are final.
 */
export function UpgradeView() {
  const reduce = useReducedMotion();
  const { openTo } = useSettingsModal();
  const { refresh } = useCredits();

  // Stripe redirects back to /upgrade?status=success|cancel. On success, nudge
  // a wallet refetch (the credit grant lands via the async webhook) and clear
  // the param so a reload doesn't re-toast.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const status = new URLSearchParams(window.location.search).get("status");
    if (!status) return;
    if (status === "success") {
      toast.success(msg("billing.upgrade.success_toast"));
      refresh();
    }
    window.history.replaceState(null, "", window.location.pathname);
  }, [refresh]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <motion.header
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT }}
        className="flex flex-col gap-3"
      >
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8a6d44]">
          {msg("billing.upgrade.eyebrow")}
        </span>
        <h1 className="text-[clamp(1.75rem,4vw,2.5rem)] font-semibold leading-tight text-foreground">
          {msg("billing.upgrade.title")}
        </h1>
        <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
          {msg("billing.upgrade.lead")}
        </p>
      </motion.header>

      <section className="mt-8 flex flex-col gap-3" aria-labelledby="packs-heading">
        <h2
          id="packs-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {msg("billing.upgrade.packs_title")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {CREDIT_PACKS.map((pack, i) => (
            <PackOption key={pack.id} pack={pack} index={i} />
          ))}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
          <Check className="size-3.5 text-[#C8A882]" aria-hidden="true" />
          {msg("billing.upgrade.reassurance")}
        </p>
      </section>

      <section className="mt-10 flex flex-col gap-3" aria-labelledby="alt-heading">
        <h2
          id="alt-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {msg("billing.upgrade.other_title")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <AltOption
            icon={Sparkles}
            title={msg("billing.upgrade.mini_title")}
            description={msg("billing.upgrade.mini_desc")}
            action={msg("billing.upgrade.mini_action")}
            href="/"
          />
          <AltOption
            icon={KeyRound}
            title={msg("billing.upgrade.byok_title")}
            description={msg("billing.upgrade.byok_desc")}
            action={msg("billing.upgrade.byok_action")}
            onAction={() => openTo("api")}
          />
        </div>
      </section>
    </div>
  );
}
