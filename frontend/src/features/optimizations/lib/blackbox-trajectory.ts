import type { BlackboxRunResult, OptimizationPayloadResponse } from "@/shared/types/api";
import { sideInfoImages, type SideImage } from "@/shared/lib/candidate-render";
import { blackboxCandidateKey, type BlackboxTrajectoryContext } from "@/features/trajectory";

/** What the candidate tree needs to know about a black-box run to draw its drawer. */
export function buildBlackboxTrajectoryContext(
  result: BlackboxRunResult | null,
  payload: OptimizationPayloadResponse | null,
): BlackboxTrajectoryContext {
  const submitted = payload?.payload ?? {};
  const recipe = submitted.recipe;
  const cases = Array.isArray(submitted.cases) ? submitted.cases.length : 0;
  // The submitted payload loads separately from the job, so the split counts a
  // finished run recorded stand in for it while it is still on its way.
  const splitTotal = Object.values(result?.split_counts ?? {}).reduce((sum, n) => sum + n, 0);
  const rendersByText = new Map<string, SideImage[]>();
  for (const version of result?.versions ?? []) {
    const images = sideInfoImages(version.side_info);
    if (images.length > 0) rendersByText.set(blackboxCandidateKey(version.candidate), images);
  }
  return {
    recipe: recipe === "prompt" || recipe === "code" || recipe === "anything" ? recipe : null,
    hasCases: cases > 0 || splitTotal > 0,
    rendersByText,
  };
}
