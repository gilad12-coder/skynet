"use client";

import { CaretDown, DownloadSimple, UploadSimple } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  LIST_TOOLBAR_BUTTON_CLASS,
  ListPageSkeleton,
  type ListRowActionSlot,
} from "@/shared/ui/list-page-skeleton";
import { Ghost } from "@/shared/ui/skeleton";
import { hintedCount, useLayoutHint } from "@/shared/lib/layout-hint";
import { msg } from "@/shared/lib/messages";

/** Remembers how many datasets the library last listed, for the next skeleton. */
export const DATASETS_LAYOUT_KEY = "datasets-count";

// An owned dataset's actions: tag, edit, share, rename | delete.
const ACTION_SLOTS: readonly ListRowActionSlot[] = [
  "icon",
  "icon",
  "icon",
  "icon",
  "divider",
  "icon",
];

/**
 * Loading silhouette for the dataset library below the Data hub tabs: the
 * search + import + upload toolbar (the buttons are the real ones, ghosted,
 * so they take their labels' widths), then DatasetCard rows. A revisit draws
 * as many rows as the library last held, and nothing when it was empty.
 */
export function DatasetsSkeleton() {
  const count = hintedCount(useLayoutHint<number>(DATASETS_LAYOUT_KEY), 5, 12);
  if (count === 0) return null;
  return (
    <ListPageSkeleton
      count={count}
      actions={ACTION_SLOTS}
      toolbar={
        <>
          <Ghost>
            <Button variant="outline" tabIndex={-1} className={LIST_TOOLBAR_BUTTON_CLASS}>
              <DownloadSimple className="size-4" />
              {msg("connector_import.button")}
              <CaretDown className="size-3" />
            </Button>
          </Ghost>
          <Ghost>
            <Button variant="outline" tabIndex={-1} className={LIST_TOOLBAR_BUTTON_CLASS}>
              <UploadSimple className="size-4" />
              {msg("datasets.upload")}
            </Button>
          </Ghost>
        </>
      }
    />
  );
}
