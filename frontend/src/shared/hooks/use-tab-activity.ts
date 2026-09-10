"use client";

import * as React from "react";

import { tabActivity, type TabActivity } from "@/shared/lib/tab-activity";

/**
 * Contribute this surface's activity to the browser tab's mark while it is
 * mounted: "idle" for a chat or check page that is open and waiting, "busy"
 * while its agent thinks or its check executes, null for nothing to show.
 */
export function useTabActivity(activity: TabActivity | null): void {
  const token = React.useRef<object>({});
  React.useEffect(() => {
    tabActivity.set(token.current, activity);
  }, [activity]);
  React.useEffect(() => {
    const surface = token.current;
    return () => tabActivity.clear(surface);
  }, []);
}

const getServerSnapshot = () => null;

export function useResolvedTabActivity(): TabActivity | null {
  return React.useSyncExternalStore(tabActivity.subscribe, tabActivity.get, getServerSnapshot);
}
