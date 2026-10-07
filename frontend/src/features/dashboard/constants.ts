import { STATUS_DOT_COLOR } from "@/shared/constants/job-status";

export const FETCH_PAGE_SIZE = 50;

export const STATUS_COLORS = STATUS_DOT_COLOR;

export type StatAccent = "default" | "success" | "warning" | "danger";

export const ACCENT_DOT: Record<StatAccent, string> = {
  default: "bg-foreground/25",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
};

export const ACCENT_TEXT: Record<StatAccent, string> = {
  default: "text-foreground",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

// Shared by AnalyticsTab and its skeleton. Three columns wait for lg: at md
// (834 iPad portrait beside the 240px rail) each column would be ~150px, so the
// third panel spans the row under the first two instead.
export const BREAKDOWN_GRID_CLASS = "grid gap-6 md:grid-cols-2 lg:grid-cols-3";
export const BREAKDOWN_WIDE_CELL_CLASS = "md:col-span-2 lg:col-span-1";
