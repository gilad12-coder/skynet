import type { SplitFractions } from "@/shared/types/api";

/** Match backend slicing for valid splits and preview requested counts while editing. */
export function splitExampleCounts(total: number, split: SplitFractions): SplitFractions {
  const train = Math.floor(total * split.train);
  const val = Math.floor(total * split.val);
  const valid = Math.abs(split.train + split.val + split.test - 1) < 0.0001;
  return { train, val, test: valid ? total - train - val : Math.floor(total * split.test) };
}
