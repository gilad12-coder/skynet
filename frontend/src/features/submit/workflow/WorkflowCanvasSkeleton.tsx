"use client";

import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/utils";

// Shared with the canvas so its loading placeholder keeps the same toolbar band
// and graph height; this module stays free of React Flow so the placeholder
// ships without the lazy chunk.
export const WORKFLOW_TOOLBAR_CLASS =
  "flex flex-wrap items-center gap-1.5 border-b border-border/40 bg-[#FAF8F5] px-3 py-2";
export const WORKFLOW_CANVAS_HEIGHT_CLASS = "h-[480px]";

// Toolbar buttons are h-7, but touch pointers (globals.css) and the wizard's
// below-lg rule (CodeStep) lift every button to 44px; the bones follow both.
const TOOL_BONE_CLASS = "block h-7 leading-none max-lg:h-[44px] any-pointer-coarse:h-[44px]";

/** The canvas toolbar and graph area, held while the React Flow chunk loads. */
export function WorkflowCanvasSkeleton() {
  return (
    <div className="relative flex flex-col" aria-busy="true">
      <div className={WORKFLOW_TOOLBAR_CLASS}>
        <Skeleton height="100%" containerClassName={cn(TOOL_BONE_CLASS, "w-[104px]")} />
        <Skeleton height="100%" containerClassName={cn(TOOL_BONE_CLASS, "w-16")} />
        <span className="ms-auto" />
        <Skeleton height="100%" containerClassName={cn(TOOL_BONE_CLASS, "w-[84px]")} />
        <Skeleton
          height="100%"
          containerClassName={cn(TOOL_BONE_CLASS, "w-7 max-lg:w-[44px] any-pointer-coarse:w-[44px]")}
        />
      </div>
      <div className={cn(WORKFLOW_CANVAS_HEIGHT_CLASS, "bg-[#FDFCFA]")} />
    </div>
  );
}
