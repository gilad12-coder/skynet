import { DatasetsSkeleton } from "@/features/datasets";
import { DataHubTabs } from "@/shared/ui/data-hub-tabs";

export default function Loading() {
  return (
    <div className="pb-16">
      <DataHubTabs active="datasets" />
      <DatasetsSkeleton />
    </div>
  );
}
