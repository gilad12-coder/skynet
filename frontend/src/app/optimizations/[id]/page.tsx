import { Suspense } from "react";
import { OptimizationDetailGate, OptimizationDetailSkeleton } from "@/features/optimizations";

export default function JobDetailPage() {
  return (
    <Suspense fallback={<OptimizationDetailSkeleton />}>
      <OptimizationDetailGate />
    </Suspense>
  );
}
