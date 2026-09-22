import { useCallback, useEffect, useState } from "react";
import { getDashboardAnalytics, type DashboardAnalytics } from "@/shared/lib/api";
import type { AnalyticsRange } from "./use-analytics-filters";

type UseDashboardAnalyticsArgs = {
  sessionUser: string;
  isAdmin: boolean;
  activeTab: string;
  range: AnalyticsRange;
  optimizer: string;
  model: string;
  status: string;
  date: string | null;
  owner: string | null;
  access: string | null;
};

export type UseDashboardAnalyticsReturn = {
  analyticsData: DashboardAnalytics | null;
  setAnalyticsData: React.Dispatch<React.SetStateAction<DashboardAnalytics | null>>;
  analyticsLoading: boolean;
  fetchDashboardAnalytics: () => Promise<void>;
};

const RANGE_DAYS: Record<AnalyticsRange, number | undefined> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: undefined,
};

export function useDashboardAnalytics({
  sessionUser,
  isAdmin,
  activeTab,
  range,
  optimizer,
  model,
  status,
  date,
  owner,
  access,
}: UseDashboardAnalyticsArgs): UseDashboardAnalyticsReturn {
  const [analyticsData, setAnalyticsData] = useState<DashboardAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const fetchDashboardAnalytics = useCallback(async () => {
    const username = isAdmin ? undefined : sessionUser || undefined;
    // Non-admins aggregate over their own + shared runs; admins see all.
    const includeShared = !isAdmin;
    setAnalyticsLoading(true);
    try {
      const result = await getDashboardAnalytics({
        username,
        days: RANGE_DAYS[range],
        optimizer: optimizer !== "all" ? optimizer : undefined,
        model: model !== "all" ? model : undefined,
        status: status !== "all" ? status : undefined,
        date: date ?? undefined,
        include_shared: includeShared,
        owner: owner ?? undefined,
        access: access ?? undefined,
      });
      setAnalyticsData(result);
    } catch {
      // Leave analyticsData untouched; jobs-list error surfaces network issues.
    } finally {
      setAnalyticsLoading(false);
    }
  }, [isAdmin, sessionUser, range, optimizer, model, status, date, owner, access]);

  useEffect(() => {
    if (activeTab !== "analytics") return;
    void fetchDashboardAnalytics();
  }, [activeTab, fetchDashboardAnalytics]);

  return {
    analyticsData,
    setAnalyticsData,
    analyticsLoading,
    fetchDashboardAnalytics,
  };
}
