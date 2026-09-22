import { useState } from "react";

export type AnalyticsRange = "7d" | "30d" | "90d" | "all";

type AnalyticsFilters = {
  range: AnalyticsRange;
  optimizer: string;
  model: string;
  status: string;
  date: string | null;
  owner: string | null;
  access: string | null;
};

export type UseAnalyticsFiltersReturn = AnalyticsFilters & {
  setRange: (v: AnalyticsRange) => void;
  setOptimizer: (v: string) => void;
  setModel: (v: string) => void;
  setStatus: (v: string) => void;
  setDate: (v: string | null) => void;
  setOwner: (v: string | null) => void;
  setAccess: (v: string | null) => void;
};

export function useAnalyticsFilters(): UseAnalyticsFiltersReturn {
  const [range, setRange] = useState<AnalyticsRange>("all");
  const [optimizer, setOptimizer] = useState<string>("all");
  const [model, setModel] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [date, setDate] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [access, setAccess] = useState<string | null>(null);

  return {
    range,
    optimizer,
    model,
    status,
    date,
    owner,
    access,
    setRange,
    setOptimizer,
    setModel,
    setStatus,
    setDate,
    setOwner,
    setAccess,
  };
}
