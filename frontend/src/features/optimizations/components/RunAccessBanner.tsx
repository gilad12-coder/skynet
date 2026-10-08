import { Eye, PencilSimple } from "@/shared/ui/icons";
import { msg } from "@/shared/lib/messages";

export type RunAccessTier = "editor" | "viewer";

/**
 * The strip above a run someone else owns, naming the caller's access tier and
 * the owner. The loading skeleton paints this same strip as a bone.
 */
export function RunAccessBanner({ tier, owner }: { tier: RunAccessTier; owner?: string | null }) {
  // Split "מאת {name}" so the emphasis (semibold/foreground) lands only on the
  // owner name; the "by" prefix stays muted meta text.
  const [prefix, suffix] = msg("optimization.readonly_by").split("{name}");
  return (
    <div
      role="status"
      className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-gradient-to-br from-muted/60 to-muted/25 px-4 py-2.5 shadow-sm"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/5 text-primary/80">
        {tier === "editor" ? (
          <PencilSimple className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 text-sm font-medium text-foreground/90">
        {msg(
          tier === "editor"
            ? "optimization.access_banner.editor"
            : "optimization.access_banner.viewer",
        )}
      </span>
      {owner && (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-xs text-muted-foreground sm:ms-auto sm:flex-none">
          <span dir="auto" className="min-w-0 truncate">
            {prefix}
            <span dir="auto" className="font-semibold text-foreground">
              {owner}
            </span>
            {suffix}
          </span>
          <span
            aria-hidden="true"
            className="grid size-4 shrink-0 place-items-center rounded-full bg-primary/10 text-[0.5625rem] font-semibold uppercase text-primary"
          >
            {owner.trim().charAt(0)}
          </span>
        </span>
      )}
    </div>
  );
}
