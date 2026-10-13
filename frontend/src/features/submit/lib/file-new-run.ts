import { toast } from "react-toastify";

import { moveRunsToFolder } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";

/**
 * File a just-submitted run into the folder its wizard was opened from, then
 * tell every runs list (sidebar, dashboard) that a new run exists.
 * The run is already accepted, so a failure only warns: it stays unfiled and
 * can still be moved from the sidebar.
 */
export async function fileNewRun(optimizationId: string, folderId: string | null): Promise<void> {
  try {
    if (!folderId) return;
    const result = await moveRunsToFolder([optimizationId], folderId);
    if (result.updated.length === 0) toast.warning(msg("folders.new_run.not_filed"));
  } catch {
    toast.warning(msg("folders.new_run.not_filed"));
  } finally {
    // The sidebar otherwise only refetches on its 30s poll (its live stream
    // is off while no run is active), so it kept showing "No runs here yet"
    // after the very first submit.
    window.dispatchEvent(new Event("optimizations-changed"));
  }
}
