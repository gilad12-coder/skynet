/**
 * What each share dialog shows in the hosted app and in the Mac app.
 *
 * In the Mac app (local mode) no share link can work for another person, so
 * the link and people controls give way to the hosted-account notice. The
 * optimization dialog keeps its Explore visibility control there: it changes
 * what the local Explore page lists and has no other place in the UI.
 */

export type ShareDialogKind = "optimization" | "dataset" | "folder" | "tagger";

export interface ShareDialogPlan {
  /** Fetch the item's sharing state when the dialog opens. */
  loadSharing: boolean;
  /** Show the hosted-account notice. */
  showLocalNotice: boolean;
  /** Show invite, members, general access and the copy-link row. */
  showLinkAndPeople: boolean;
  /** Show the Explore Public/Private control (optimizations only). */
  showExploreVisibility: boolean;
}

/** The sections of the `kind` share dialog, for hosted (`false`) or local (`true`) mode. */
export function shareDialogPlan(kind: ShareDialogKind, localMode: boolean): ShareDialogPlan {
  const showExploreVisibility = kind === "optimization";
  return {
    loadSharing: !localMode || showExploreVisibility,
    showLocalNotice: localMode,
    showLinkAndPeople: !localMode,
    showExploreVisibility,
  };
}
