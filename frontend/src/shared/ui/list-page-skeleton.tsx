"use client";

import type { ReactNode } from "react";
import { Button } from "@/shared/ui/primitives/button";
import { checkboxBoxClass } from "@/shared/ui/select-checkbox";
import { AppSkeletonTheme, Ghost, Skeleton } from "@/shared/ui/skeleton";
import {
  LIST_ROW_ACTION_DIVIDER_CLASS,
  LIST_ROW_ACTIONS_CLASS,
  LIST_ROW_CLASS,
  LIST_ROW_ICON_CLASS,
  LIST_ROW_META_CLASS,
  LIST_ROW_TITLE_CLASS,
} from "@/shared/ui/list-row";
import { cn } from "@/shared/lib/utils";

/** One slot of a row's action strip: an icon button, or the divider before delete. */
export type ListRowActionSlot = "icon" | "divider";

/** The toolbar's outline buttons (import, upload, start new), at their real height. */
export const LIST_TOOLBAR_BUTTON_CLASS = "!h-[44px] w-full shrink-0 rounded-2xl sm:w-auto";

interface ListPageSkeletonProps {
  /** The toolbar's buttons after the search field, drawn as real (ghosted) buttons. */
  toolbar: ReactNode;
  count: number;
  actions: readonly ListRowActionSlot[];
  /** A column between the text and the actions (a session's progress). */
  trailing?: ReactNode;
}

/**
 * Loading silhouette shared by the Data hub list surfaces (dataset library and
 * labeling-session chooser): the search toolbar and card rows built on the
 * rows' own LIST_ROW classes and real controls, so each bone takes its row's
 * height at every root font size, breakpoint and pointer, and the content
 * swap shifts nothing.
 */
export function ListPageSkeleton({ toolbar, count, actions, trailing }: ListPageSkeletonProps) {
  return (
    <AppSkeletonTheme>
      <div aria-hidden="true">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <Skeleton height={44} borderRadius={16} containerClassName="block flex-1 leading-none" />
          {toolbar}
        </div>

        <div className="mt-5 rounded-xl border border-dashed border-transparent">
          <div className="flex flex-col gap-2.5 p-0.5">
            {Array.from({ length: count }).map((_, i) => (
              <ListRowBone key={i} index={i} actions={actions} trailing={trailing} />
            ))}
          </div>
        </div>
      </div>
    </AppSkeletonTheme>
  );
}

function ListRowBone({
  index,
  actions,
  trailing,
}: {
  index: number;
  actions: readonly ListRowActionSlot[];
  trailing?: ReactNode;
}) {
  return (
    <div className={cn(LIST_ROW_CLASS, "cursor-default hover:bg-background")}>
      <span className="flex shrink-0 items-center">
        <Ghost>
          <span className={checkboxBoxClass(false)} />
        </Ghost>
      </span>
      <Ghost>
        <span className={LIST_ROW_ICON_CLASS} />
      </Ghost>
      <div className="min-w-0 flex-1">
        <p className={LIST_ROW_TITLE_CLASS}>
          <Skeleton width={`${45 + ((index * 17) % 30)}%`} />
        </p>
        <p className={LIST_ROW_META_CLASS}>
          <Skeleton width={180} containerClassName="min-w-0 max-w-[65%] flex-1" />
        </p>
      </div>
      {trailing}
      <div className={cn(LIST_ROW_ACTIONS_CLASS, "lg:[@media(hover:hover)]:opacity-100")}>
        {actions.map((slot, i) =>
          slot === "divider" ? (
            <span key={i} className={LIST_ROW_ACTION_DIVIDER_CLASS} />
          ) : (
            // The real button keeps its box (44px under a coarse pointer);
            // only its icon is drawn, as a bone.
            <Button
              key={i}
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              aria-label=""
              className="pointer-events-none"
            >
              <Skeleton
                width={16}
                height={16}
                borderRadius={4}
                containerClassName="flex leading-none"
              />
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
