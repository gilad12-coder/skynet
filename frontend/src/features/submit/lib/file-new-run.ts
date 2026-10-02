import { toast } from "react-toastify";

import { moveRunsToFolder } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";

/**
 * File a just-submitted run into the folder its wizard was opened from.
 * The run is already accepted, so a failure only warns: it stays unfiled and
 * can still be moved from the sidebar.
 */
export async function fileNewRun(optimizationId: string, folderId: string | null): Promise<void> {
  if (!folderId) return;
  try {
    const result = await moveRunsToFolder([optimizationId], folderId);
    if (result.updated.length === 0) toast.warning(msg("folders.new_run.not_filed"));
  } catch {
    toast.warning(msg("folders.new_run.not_filed"));
  }
}
