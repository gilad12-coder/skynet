"use client";

import { Skeleton } from "@/shared/ui/skeleton";
import { useLayoutHint } from "@/shared/lib/layout-hint";
import {
  CorpusToggleSkeleton,
  exploreLayoutKey,
  ResultsPaneSkeleton,
  type ExploreResultsLayout,
} from "./ResultsSkeleton";

export function ExploreSkeleton() {
  const layout = useLayoutHint<ExploreResultsLayout>(exploreLayoutKey("last"));
  return (
    <div className="pb-16" aria-hidden="true">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-col gap-3">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
            <div className="flex items-center justify-center">
              <CorpusToggleSkeleton />
            </div>
            <Skeleton height={44} borderRadius={16} containerClassName="block leading-none" />
          </div>
        </div>
        <ResultsPaneSkeleton layout={layout} />
      </div>
    </div>
  );
}
