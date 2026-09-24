/**
 * Shared look of the result lists in the import dialogs: one bordered list
 * with hairline dividers, flat rows that tint on hover and keyboard focus.
 */
export const BROWSE_LIST_CLASS =
  "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card";

export const BROWSE_ROW_CLASS =
  "group flex min-h-[48px] w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-start transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

export const BROWSE_CARET_CLASS =
  "size-3.5 shrink-0 text-muted-foreground/40 transition-colors duration-150 group-hover:text-foreground group-focus-visible:text-foreground rtl:-scale-x-100";
