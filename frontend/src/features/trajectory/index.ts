export { TrajectoryPanel } from "./components/TrajectoryPanel";
export { MetaHarnessPanel } from "./components/MetaHarnessPanel";
export { isMetaHarnessRun } from "./lib/meta-harness";
export { layoutTrajectory } from "./lib/layout";
export { extractCandidates, scopeToLatestLane } from "./lib/extract-events";
export { blackboxCandidateKey } from "./lib/types";
export type { BlackboxTrajectoryContext, CandidateMetrics } from "./lib/types";
